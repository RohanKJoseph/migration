const fs = require('fs');
const FormData = require('form-data');
const axios = require('axios');
const readline = require('readline');
const { Woo, Shopify } = require('./config/api-clients');
const { tracker, customerTracker } = require('./services/tracker');
const { mapWooProductToShopify } = require('./mappers/product-mapper');
const { mapWooCustomerToShopify } = require('./mappers/customer-mapper');
const { mapWooOrderToShopify } = require('./mappers/order-mapper');
const limiter = require('./services/rate-limiter');
const { migrateCustomers, migrateOrders, migrateCustomersAndOrders } = require('./services/migration-service');

const DEFAULT_CUSTOMER_BULK_MUTATION = "mutation customerCreate($input: CustomerInput!) { customerCreate(input: $input) { customer { id } } }";
const DEFAULT_PRODUCT_BULK_MUTATION = "mutation productCreate($input: ProductInput!) { productCreate(input: $input) { product { id } } }";

function logResult(type, id, status, message = '') {
  const entry = `${new Date().toISOString()} | ${type} | ID: ${id} | ${status} | ${message}\n`;
  fs.appendFileSync('migration_audit.log', entry);
}

async function createStagedUploadTarget(filename = 'customers_migration.jsonl') {
  const stagedUploadsCreateMutation = `
mutation {
  stagedUploadsCreate(input: [
    {
      resource: BULK_MUTATION_VARIABLES,
      filename: "${filename}",
      mimeType: "text/jsonl",
      httpMethod: POST
    }
  ]) {
    stagedTargets {
      url
      resourceUrl
      parameters {
        name
        value
      }
    }
    userErrors {
      field
      message
    }
  }
}
`;

  try {
    const { data } = await Shopify.post('/graphql.json', {
      query: stagedUploadsCreateMutation
    });

    if (data.errors?.length) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    const result = data.data?.stagedUploadsCreate;
    if (result?.userErrors?.length) {
      throw new Error(`User errors: ${JSON.stringify(result.userErrors)}`);
    }

    const target = result?.stagedTargets?.[0];
    if (!target) {
      throw new Error('No staged upload target returned by Shopify');
    }

    console.log(`✅ Staged upload target created for ${filename}`);
    logResult('SYSTEM', 'N/A', 'SUCCESS', `Staged upload target created for ${filename}`);
    return target;
  } catch (error) {
    console.error('❌ Failed to create staged upload target:', error.response?.data || error.message);
    logResult('SYSTEM', 'N/A', 'FAILED', `Staged upload creation failed: ${error.message}`);
    throw error;
  }
}

async function uploadFile(stagedTarget, filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Upload source file not found: ${filePath}`);
  }

  const form = new FormData();

  // You must append all parameters returned by Shopify first
  stagedTarget.parameters.forEach(({ name, value }) => {
    form.append(name, value);
  });

  // Then append the file
  form.append('file', fs.createReadStream(filePath));

  await axios.post(stagedTarget.url, form, {
    headers: form.getHeaders()
  });

  console.log('✅ File uploaded to Shopify staging.');
  logResult('SYSTEM', 'N/A', 'SUCCESS', `Uploaded staged file: ${filePath}`);
}

function getStagedUploadPath(stagedTarget) {
  const keyParam = stagedTarget?.parameters?.find((p) => p.name === 'key');
  return keyParam?.value || null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shopifyCustomerIdByEmailCache = new Map();
let didLoadShopifyCustomerEmailCache = false;

function isTransientShopifyError(error) {
  const status = error?.response?.status;
  const code = error?.code;
  return status === 429 || (status >= 500 && status < 600) || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED';
}

async function callShopifyWithRetry(fn, label, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const transient = isTransientShopifyError(error);
      if (!transient || attempt === maxRetries) {
        throw error;
      }

      const waitMs = Math.min(30000, (1000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 300));
      console.warn(`⚠️ ${label} transient failure (attempt ${attempt}/${maxRetries}). Retrying in ${waitMs}ms...`);
      await delay(waitMs);
    }
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function findShopifyCustomerIdByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return null;
  }

  if (!didLoadShopifyCustomerEmailCache) {
    await loadAllShopifyCustomersIntoCache();
  }

  if (shopifyCustomerIdByEmailCache.has(normalizedEmail)) {
    return shopifyCustomerIdByEmailCache.get(normalizedEmail);
  }

  try {
    const search = await Shopify.get('/customers/search.json', {
      params: { query: `email:${normalizedEmail}` }
    });
    const customers = search?.data?.customers || [];
    const exact = customers.find((c) => normalizeEmail(c?.email) === normalizedEmail) || customers[0] || null;
    const id = exact?.id ? String(exact.id).replace(/\.0$/, '') : null;
    shopifyCustomerIdByEmailCache.set(normalizedEmail, id);
    return id;
  } catch (error) {
    return null;
  }
}

function getNextLinkFromHeader(linkHeader) {
  if (!linkHeader) {
    return null;
  }

  const nextMatch = String(linkHeader).match(/<([^>]+)>;\s*rel="next"/i);
  return nextMatch ? nextMatch[1] : null;
}

async function loadAllShopifyCustomersIntoCache() {
  didLoadShopifyCustomerEmailCache = true;

  let nextUrl = `${process.env.SHOPIFY_URL}/admin/api/2024-01/customers.json?limit=250&fields=id,email`;
  while (nextUrl) {
    const response = await axios.get(nextUrl, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    const customers = response?.data?.customers || [];
    for (const customer of customers) {
      const normalizedEmail = normalizeEmail(customer?.email);
      const normalizedId = customer?.id ? String(customer.id).replace(/\.0$/, '') : null;
      if (normalizedEmail && normalizedId) {
        shopifyCustomerIdByEmailCache.set(normalizedEmail, normalizedId);
      }
    }

    nextUrl = getNextLinkFromHeader(response?.headers?.link || response?.headers?.Link);
  }

  console.log(`ℹ️ Cached Shopify customers by email: ${shopifyCustomerIdByEmailCache.size}`);
}

async function saveCustomerMappingByEmail(email, shopifyId) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !shopifyId) {
    return false;
  }

  const normalizedShopifyId = String(shopifyId).replace(/\.0$/, '');
  await customerTracker.save(`bulk:${normalizedEmail}`, normalizedShopifyId, normalizedEmail);
  await customerTracker.saveByEmail(normalizedEmail, normalizedShopifyId);
  return true;
}

async function triggerBulkMigration(stagedPath, mutationString = DEFAULT_CUSTOMER_BULK_MUTATION) {
  const query = `
    mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
        bulkOperation {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    // The specific mutation Shopify will run for each line in your JSONL.
    mutation: mutationString,
    stagedUploadPath: stagedPath
  };

  try {
    const response = await axios({
      url: `${process.env.SHOPIFY_URL}/admin/api/2026-01/graphql.json`,
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN
      },
      data: { query, variables }
    });

    const result = response.data?.data?.bulkOperationRunMutation;
    if (!result) {
      throw new Error('No bulkOperationRunMutation result returned from Shopify');
    }

    if (result.userErrors.length > 0) {
      console.error('❌ Bulk Trigger Errors:', result.userErrors);
      logResult('SYSTEM', 'N/A', 'FAILED', `Bulk trigger user errors: ${JSON.stringify(result.userErrors)}`);
      return null;
    }

    console.log(`🚀 Bulk Operation Started! ID: ${result.bulkOperation.id}`);
    logResult('SYSTEM', 'N/A', 'SUCCESS', `Bulk operation started: ${result.bulkOperation.id}`);
    return result.bulkOperation.id;
  } catch (err) {
    console.error('💀 Fatal Trigger Error:', err.response?.data || err.message);
    logResult('SYSTEM', 'N/A', 'FAILED', `Bulk trigger fatal: ${err.message}`);
    throw err;
  }
}

async function pollBulkOperationStatus(operationId, maxAttempts = 120, intervalMs = 5000) {
  const statusQuery = `
    query BulkOperationStatus($id: ID!) {
      node(id: $id) {
        ... on BulkOperation {
          id
          status
          errorCode
          objectCount
          fileSize
          url
          partialDataUrl
          createdAt
          completedAt
        }
      }
    }
  `;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await axios({
      url: `${process.env.SHOPIFY_URL}/admin/api/2026-01/graphql.json`,
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN
      },
      data: {
        query: statusQuery,
        variables: { id: operationId }
      }
    });

    const op = response.data?.data?.node;
    if (!op) {
      throw new Error(`Bulk operation not found for id: ${operationId}`);
    }

    console.log(`⏱️ Bulk status [attempt ${attempt}/${maxAttempts}]: ${op.status}`);

    if (op.status === 'COMPLETED') {
      console.log(`✅ Bulk Operation Completed! ID: ${op.id}`);
      logResult('SYSTEM', 'N/A', 'SUCCESS', `Bulk completed: ${op.id}`);
      return op;
    }

    if (op.status === 'FAILED' || op.status === 'CANCELED' || op.status === 'CANCELING') {
      const message = `Bulk operation ended with status ${op.status}. errorCode=${op.errorCode || 'N/A'}`;
      console.error(`❌ ${message}`);
      logResult('SYSTEM', 'N/A', 'FAILED', message);
      throw new Error(message);
    }

    await delay(intervalMs);
  }

  const timeoutMessage = `Bulk operation polling timed out after ${maxAttempts} attempts`;
  logResult('SYSTEM', 'N/A', 'FAILED', timeoutMessage);
  throw new Error(timeoutMessage);
}

async function fetchAllWooCustomers() {
  const allCustomers = [];
  let page = 1;
  let morePages = true;

  while (morePages) {
    console.log(`📥 Fetching page ${page}...`);
    const response = await Woo.get('customers', { per_page: 100, page: page });
    const data = response.data || [];
    const totalPages = Number(response.headers?.['x-wp-totalpages'] || 0);

    if (data.length > 0) {
      allCustomers.push(...data);
      page++;

      if (totalPages > 0 && page > totalPages) {
        morePages = false;
      }
    } else {
      morePages = false;
    }
  }

  return allCustomers;
}

async function fetchAllWooOrders() {
  const allOrders = [];
  let page = 1;
  let morePages = true;

  while (morePages) {
    console.log(`📦 Fetching orders page ${page}...`);
    const response = await Woo.get('orders', {
      per_page: 100,
      page
    });
    const data = response.data || [];
    const totalPages = Number(response.headers?.['x-wp-totalpages'] || 0);

    if (data.length > 0) {
      allOrders.push(...data);
      page++;

      if (totalPages > 0 && page > totalPages) {
        morePages = false;
      }
    } else {
      morePages = false;
    }
  }

  return allOrders;
}

async function fetchAllWooProducts() {
  const allProducts = [];
  let page = 1;
  let morePages = true;

  while (morePages) {
    console.log(`📦 Fetching products page ${page}...`);
    const response = await Woo.get('products', {
      per_page: 100,
      page
    });
    const data = response.data || [];
    const totalPages = Number(response.headers?.['x-wp-totalpages'] || 0);

    if (data.length > 0) {
      allProducts.push(...data);
      page++;

      if (totalPages > 0 && page > totalPages) {
        morePages = false;
      }
    } else {
      morePages = false;
    }
  }

  return allProducts;
}

async function generateCustomersJsonl(filePath) {
  const lines = [];
  const seenEmails = new Set();
  let skippedMapped = 0;

  const addCustomerLine = (input) => {
    const email = String(input?.email || '').trim().toLowerCase();
    if (!email || seenEmails.has(email)) {
      return;
    }

    // Idempotency: do not re-submit customers already mapped locally.
    // This prevents duplicate customerCreate attempts during re-runs.
    // Note: this check is async at call-sites before addCustomerLine.

    seenEmails.add(email);
    lines.push(JSON.stringify({
      input: {
        firstName: input.firstName || 'Guest',
        lastName: input.lastName || 'Customer',
        email
      }
    }));
  };

  // 1) Registered Woo customers
  const wooCustomers = await fetchAllWooCustomers();
  console.log(`👥 Registered Woo customers fetched: ${wooCustomers.length}`);
  for (const wooCustomer of wooCustomers) {
    const normalizedEmail = normalizeEmail(wooCustomer?.email || wooCustomer?.billing?.email);
    const existingByEmail = normalizedEmail
      ? await customerTracker.getIdByEmail(normalizedEmail)
      : null;
    if (existingByEmail) {
      skippedMapped += 1;
      continue;
    }

    addCustomerLine({
      firstName: wooCustomer?.first_name || wooCustomer?.billing?.first_name,
      lastName: wooCustomer?.last_name || wooCustomer?.billing?.last_name,
      email: wooCustomer?.email || wooCustomer?.billing?.email
    });
  }

  // 2) Guest customers from first 5 pages of orders only (to avoid infinite fetch loop)
  console.log('👥 Sampling guest emails from order billing data (limiting to first 5 pages)...');
  let samplePage = 1;
  let sampleCount = 0;
  const MAX_SAMPLE_PAGES = 5;
  while (samplePage <= MAX_SAMPLE_PAGES) {
    const { data: orders } = await Woo.get('orders', { per_page: 100, page: samplePage });
    if (!orders || orders.length === 0) {
      break;
    }
    for (const order of orders) {
      const billing = order?.billing || {};
      const normalizedBillingEmail = normalizeEmail(billing?.email);
      const existingByEmail = normalizedBillingEmail
        ? await customerTracker.getIdByEmail(normalizedBillingEmail)
        : null;
      if (existingByEmail) {
        skippedMapped += 1;
        continue;
      }

      addCustomerLine({
        firstName: billing?.first_name,
        lastName: billing?.last_name,
        email: billing?.email
      });
      sampleCount += 1;
    }
    samplePage += 1;
  }
  console.log(`📧 Guest emails sampled: ${sampleCount}`);

  fs.writeFileSync(filePath, lines.join('\n') + (lines.length ? '\n' : ''));
  console.log(`✅ Generated bulk customer file: ${filePath} (${lines.length} unique emails, skippedMapped=${skippedMapped})`);
  logResult('SYSTEM', 'N/A', 'SUCCESS', `Generated bulk file ${filePath} with ${lines.length} records (skippedMapped=${skippedMapped})`);
  return lines.length;
}

function mapWooProductToBulkInput(wooProduct) {
  const fallbackTitle = `Woo Product ${wooProduct?.id || 'Unknown'}`;
  const title = String(wooProduct?.name || fallbackTitle).trim();
  const vendor = String(wooProduct?.brand || 'YourBrand');

  // ProductInput in GraphQL bulk create does not accept variants/images directly.
  // Keep bulk creation valid, then rely on the fallback path for richer fields.
  return {
    title,
    vendor
  };
}

async function generateProductsJsonl(filePath) {
  const lines = [];
  const wooProducts = await fetchAllWooProducts();
  let skippedMapped = 0;
  console.log(`🧱 Woo products fetched for bulk product migration: ${wooProducts.length}`);

  for (const wooProduct of wooProducts) {
    const existingId = await tracker.isMigrated(String(wooProduct.id));
    if (existingId) {
      skippedMapped += 1;
      continue;
    }

    lines.push(JSON.stringify({
      wooId: String(wooProduct.id),
      input: mapWooProductToBulkInput(wooProduct)
    }));
  }

  fs.writeFileSync(filePath, lines.join('\n') + (lines.length ? '\n' : ''));
  console.log(`✅ Generated bulk product file: ${filePath} (${lines.length} records, skippedMapped=${skippedMapped})`);
  logResult('SYSTEM', 'N/A', 'SUCCESS', `Generated bulk file ${filePath} with ${lines.length} records (skippedMapped=${skippedMapped})`);
  return lines.length;
}

async function syncProductIds(bulkUrl, sourceFilePath) {
  const sourceLines = fs.existsSync(sourceFilePath)
    ? fs.readFileSync(sourceFilePath, 'utf8').split('\n').filter(Boolean)
    : [];

  const response = await axios.get(bulkUrl, { responseType: 'stream' });
  const rl = readline.createInterface({ input: response.data });

  let updated = 0;
  let skipped = 0;
  let errorCount = 0;
  const sampleErrors = [];
  const syncedWooIds = [];

  for await (const line of rl) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (parseErr) {
      skipped += 1;
      continue;
    }

    const rawId = record?.data?.productCreate?.product?.id;
    const userErrors = record?.data?.productCreate?.userErrors || [];
    if (Array.isArray(userErrors) && userErrors.length > 0) {
      errorCount += userErrors.length;
      if (sampleErrors.length < 5) {
        sampleErrors.push(...userErrors.slice(0, 5 - sampleErrors.length).map((e) => e?.message || JSON.stringify(e)));
      }
    }

    const lineIndex = Number(record?.__lineNumber);
    const sourceLine = Number.isFinite(lineIndex)
      ? (sourceLines[lineIndex] || sourceLines[lineIndex - 1])
      : null;

    let wooId = null;
    if (sourceLine) {
      try {
        wooId = JSON.parse(sourceLine)?.wooId || null;
      } catch (sourceParseErr) {
        wooId = null;
      }
    }

    if (rawId && wooId) {
      const shopifyId = String(rawId).split('/').pop();
      await tracker.saveMapping(String(wooId), shopifyId);
      updated += 1;
      syncedWooIds.push(String(wooId));
      continue;
    }

    skipped += 1;
  }

  logResult('SYSTEM', 'N/A', 'SUCCESS', `Bulk product ID sync completed. updated=${updated}, skipped=${skipped}`);
  console.log(`✅ Product Sync Complete: Updated ${updated} products in local DB. Skipped=${skipped}`);
  if (errorCount > 0) {
    console.warn(`⚠️ Product bulk reported ${errorCount} userErrors. Sample: ${sampleErrors.join(' | ')}`);
    logResult('SYSTEM', 'N/A', 'FAILED', `Product bulk userErrors=${errorCount}. Sample=${sampleErrors.join(' | ')}`);
  }
  return { updated, skipped, syncedWooIds };
}

async function syncCustomerIds(bulkUrl, sourceFilePath) {
  const sourceLines = fs.existsSync(sourceFilePath)
    ? fs.readFileSync(sourceFilePath, 'utf8').split('\n').filter(Boolean)
    : [];

  const response = await axios.get(bulkUrl, { responseType: 'stream' });
  const rl = readline.createInterface({ input: response.data });

  let updated = 0;
  let skipped = 0;
  let sequentialLine = 0;

  for await (const line of rl) {
    sequentialLine += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch (parseErr) {
      skipped++;
      continue;
    }

    const lineIndex = Number(record.__lineNumber);
    const sourceLine = Number.isFinite(lineIndex)
      ? (sourceLines[lineIndex] || sourceLines[lineIndex - 1])
      : (sourceLines[sequentialLine - 1] || null);

    // Prefer email directly from the bulk response payload if present.
    let email = record?.input?.email || null;
    if (!email && sourceLine) {
      try {
        email = JSON.parse(sourceLine)?.input?.email || null;
      } catch (sourceParseErr) {
        email = null;
      }
    }

    const rawId = record?.data?.customerCreate?.customer?.id;
    let shopifyId = rawId ? String(rawId).split('/').pop() : null;

    if (!shopifyId && email) {
      shopifyId = await findShopifyCustomerIdByEmail(email);
    }

    if (shopifyId && email) {
      const saved = await saveCustomerMappingByEmail(email, shopifyId);
      if (saved) {
        updated += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    skipped += 1;
  }

  logResult('SYSTEM', 'N/A', 'SUCCESS', `Bulk ID sync completed. updated=${updated}, skipped=${skipped}`);
  console.log(`✅ Sync Complete: Updated ${updated} customers in local DB. Skipped=${skipped}`);
  return updated;
}

async function forceSyncIds(bulkUrl) {
  const response = await axios.get(bulkUrl, { responseType: 'stream' });
  const rl = readline.createInterface({ input: response.data });

  let count = 0;

  for await (const line of rl) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (parseErr) {
      continue;
    }

    const email = record?.input?.email || record?.data?.customerCreate?.customer?.email;
    const rawId = record?.data?.customerCreate?.customer?.id;
    let shopifyId = rawId ? String(rawId).split('/').pop() : null;

    if (!shopifyId && email) {
      shopifyId = await findShopifyCustomerIdByEmail(email);
    }

    if (shopifyId && email) {
      const saved = await saveCustomerMappingByEmail(email, shopifyId);
      if (saved) {
        count += 1;
      }
    }
  }

  console.log(`✅ Force Sync Successful! ${count} Shopify IDs are now in your DB.`);
  logResult('SYSTEM', 'N/A', 'SUCCESS', `Force sync completed. count=${count}`);
  return count;
}

async function finalForceSync(bulkUrl) {
  const response = await axios.get(bulkUrl, { responseType: 'stream' });
  const rl = readline.createInterface({ input: response.data });

  let count = 0;
  for await (const line of rl) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (parseErr) {
      continue;
    }

    // DEBUG: Look for the email and ID
    let shopifyId = record?.data?.customerCreate?.customer?.id?.split('/').pop();
    const email = record?.input?.email || record?.data?.customerCreate?.customer?.email;

    if (!shopifyId && email) {
      shopifyId = await findShopifyCustomerIdByEmail(email);
    }

    if (shopifyId && email) {
      const saved = await saveCustomerMappingByEmail(email, shopifyId);
      if (saved) {
        count += 1;
      }
    }
  }

  console.log(`✅ Final Sync Result: ${count} IDs mapped.`);
  logResult('SYSTEM', 'N/A', 'SUCCESS', `Final force sync completed. count=${count}`);
  return count;
}

async function runSmokeTest() {
  console.log('🧪 Starting 1% Smoke Test...');

  try {
    // 1. Run Customers
    await migrateCustomers();

    // 2. FORCE a 2-second pause to ensure SQLite has finished writing
    console.log('⏳ Cooling down to sync database...');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 3. Run Orders
    await migrateOrders();

    console.log('✅ Smoke Test Loop Finished.');
  } catch (error) {
    if (error.response) {
      // This will print the EXACT reason Shopify rejected the request
      console.error("❌ Shopify API Error Details:", JSON.stringify(error.response.data, null, 2));
    } else {
      console.error("❌ Smoke Test Failed:", error.message);
    }
  }
}

async function migrateAllProducts() {
  console.log('🔄 Starting fallback product REST migration...');
  let page = 1;
  let keepGoing = true;
  let totalProcessed = 0;

  while (keepGoing) {
    console.log(`📄 Fallback migration: Fetching page ${page}...`);

    try {
      const { data: products } = await Woo.get('products', {
        per_page: 50,
        page: page
      });

      if (products.length === 0) {
        console.log(`✅ Fallback product migration complete. Total processed: ${totalProcessed}`);
        logResult('PRODUCT', 'N/A', 'COMPLETE', `Fallback migration done. Processed ${totalProcessed}`);
        keepGoing = false;
        break;
      }

      const pageTasks = [];
      for (const item of products) {
        const existingId = await tracker.isMigrated(item.id.toString());

        if (existingId) {
          console.log(`  ⏩ Already migrated: ${item.name} -> Shopify ${existingId}`);
          logResult('PRODUCT', item.id, 'SKIPPED', `Already mapped to Shopify ${existingId}`);
          continue;
        }

        const task = limiter.schedule(async () => {
          try {
            const shopifyData = mapWooProductToShopify(item);
            const response = await Shopify.post('/products.json', shopifyData);
            const createdId = response.data.product.id;
            await tracker.saveMapping(item.id.toString(), createdId);
            console.log(`  ✅ Created via REST: ${item.name} -> Shopify ${createdId}`);
            logResult('PRODUCT', item.id, 'SUCCESS', `Shopify ${createdId}`);
            totalProcessed += 1;
          } catch (err) {
            console.error(`  ❌ Failed ${item.name}:`, err.response?.data?.errors || err.message);
            logResult('PRODUCT', item.id, 'FAILED', err.message || 'Unknown error');
          }
        });
        pageTasks.push(task);
      }

      console.log(`  ⏳ Processing ${pageTasks.length} unmapped products (page ${page}, max 2 concurrent)...`);
      await Promise.all(pageTasks);
      console.log(`  ✅ Page ${page} complete.`);
      page++;
    } catch (error) {
      console.error('💀 Batch Error:', error.message);
      logResult('PRODUCT', 'N/A', 'FAILED', error.message || 'Batch error');
      keepGoing = false;
    }
  }
}

async function enrichBulkCreatedProducts(wooIdsToEnrich = null) {
  console.log('🎨 Starting product enrichment for bulk-created items...');
  const wooProducts = await fetchAllWooProducts();
  const targetIds = wooIdsToEnrich ? new Set(wooIdsToEnrich.map((id) => String(id))) : null;
  let enriched = 0;
  let skipped = 0;
  let failed = 0;
  let completed = 0;

  const tasks = [];
  for (const wooProduct of wooProducts) {
    const wooId = String(wooProduct?.id || '');

    // Enrich only explicitly requested products when IDs are provided.
    if (targetIds && !targetIds.has(wooId)) {
      continue;
    }

    const mappedShopifyId = await tracker.isMigrated(wooId);
    const shopifyId = mappedShopifyId ? String(mappedShopifyId).replace(/\.0$/, '') : null;

    if (!shopifyId) {
      skipped += 1;
      continue;
    }

    const task = limiter.schedule(async () => {
      try {
        const mapped = mapWooProductToShopify(wooProduct)?.product || {};
        const tags = [
          ...(wooProduct?.categories || []).map((c) => c?.name).filter(Boolean),
          ...(wooProduct?.tags || []).map((t) => t?.name).filter(Boolean)
        ].join(', ');

        await callShopifyWithRetry(
          () => Shopify.put(
            `/products/${shopifyId}.json`,
            {
              product: {
                id: Number(shopifyId),
                body_html: mapped.body_html || '',
                status: mapped.status || 'active',
                product_type: String(wooProduct?.type || ''),
                tags
              }
            },
            { timeout: 30000 }
          ),
          `Product update for Woo ${wooId}`
        );

        const existingProductResp = await callShopifyWithRetry(
          () => Shopify.get(
            `/products/${shopifyId}.json`,
            {
              params: { fields: 'id,variants,images' },
              timeout: 30000
            }
          ),
          `Product read for Woo ${wooId}`
        );
        const existingProduct = existingProductResp?.data?.product || {};

        const sourceVariant = (mapped.variants || [])[0] || null;
        const existingVariantId = (existingProduct.variants || [])[0]?.id;
        if (sourceVariant && existingVariantId) {
          await callShopifyWithRetry(
            () => Shopify.put(
              `/variants/${existingVariantId}.json`,
              {
                variant: {
                  id: Number(existingVariantId),
                  sku: sourceVariant.sku || null,
                  price: sourceVariant.price || '0.00',
                  compare_at_price: sourceVariant.compare_at_price || null,
                  inventory_policy: sourceVariant.inventory_policy || 'deny'
                }
              },
              { timeout: 30000 }
            ),
            `Variant update for Woo ${wooId}`
          );
        }

        const sourceImages = (mapped.images || []).map((img) => img?.src).filter(Boolean);
        const existingImagesCount = (existingProduct.images || []).length;
        if (existingImagesCount === 0 && sourceImages.length > 0) {
          for (const src of sourceImages) {
            await callShopifyWithRetry(
              () => Shopify.post(
                `/products/${shopifyId}/images.json`,
                { image: { src } },
                { timeout: 30000 }
              ),
              `Image upload for Woo ${wooId}`
            );
          }
        }
        enriched += 1;
      } catch (error) {
        failed += 1;
        logResult('PRODUCT', wooId, 'FAILED', `Bulk enrichment failed for Shopify ${shopifyId}: ${error.message}`);
      } finally {
        completed += 1;
        if (completed % 25 === 0 || completed === tasks.length) {
          console.log(`⏱️ Enrichment progress: ${completed}/${tasks.length} done (enriched=${enriched}, failed=${failed})`);
        }
      }
    });
    tasks.push(task);
  }

  console.log(`⏳ Enriching ${tasks.length} products (max 2 concurrent)...`);
  await Promise.all(tasks);
  console.log(`✅ Product enrichment complete. enriched=${enriched}, skipped=${skipped}, failed=${failed}`);
  logResult('SYSTEM', 'N/A', 'SUCCESS', `Product enrichment complete. enriched=${enriched}, skipped=${skipped}, failed=${failed}`);
}

async function runFullMigration() {
  const bulkFilePath = 'customers_migration.jsonl';
  console.log('ℹ️ Generating fresh customers_migration.jsonl with GraphQL CustomerInput shape...');
  const customerBulkCount = await generateCustomersJsonl(bulkFilePath);

  if (customerBulkCount <= 0) {
    console.log('ℹ️ No new customers to bulk migrate. Skipping customer bulk phase.');
    logResult('SYSTEM', 'N/A', 'SUCCESS', 'Customer bulk skipped: no new customers to migrate');
  } else {
    const stagedTarget = await createStagedUploadTarget();
    await uploadFile(stagedTarget, bulkFilePath);
    let bulkSummary = null;
    const stagedPath = getStagedUploadPath(stagedTarget);
    if (stagedPath) {
      const bulkOperationId = await triggerBulkMigration(stagedPath);
      if (bulkOperationId) {
        bulkSummary = await pollBulkOperationStatus(bulkOperationId);
        console.log('📊 Bulk Operation Summary:');
        console.log(`   ID: ${bulkSummary.id}`);
        console.log(`   Status: ${bulkSummary.status}`);
        console.log(`   URL: ${bulkSummary.url || 'N/A'}`);
        console.log(`   Partial Data URL: ${bulkSummary.partialDataUrl || 'N/A'}`);
        logResult(
          'SYSTEM',
          'N/A',
          'SUCCESS',
          `Bulk summary id=${bulkSummary.id}, status=${bulkSummary.status}, url=${bulkSummary.url || 'N/A'}, partialDataUrl=${bulkSummary.partialDataUrl || 'N/A'}`
        );

        if (bulkSummary.url) {
          const synced = await syncCustomerIds(bulkSummary.url, bulkFilePath);
          if (!synced) {
            const forced = await forceSyncIds(bulkSummary.url);
            if (!forced) {
              await finalForceSync(bulkSummary.url);
            }
          }
        }
      }
    } else {
      console.warn('⚠️ Could not resolve staged upload path (key) for bulk trigger.');
      logResult('SYSTEM', 'N/A', 'FAILED', 'Missing staged upload path (key) for bulk trigger');
    }
  }

  const bulkProductFilePath = 'products_migration.jsonl';
  console.log('ℹ️ Generating fresh products_migration.jsonl with ProductInput shape...');
  const productBulkCount = await generateProductsJsonl(bulkProductFilePath);

  if (productBulkCount <= 0) {
    console.log('ℹ️ No new products to bulk migrate. Skipping product bulk phase.');
    logResult('SYSTEM', 'N/A', 'SUCCESS', 'Product bulk skipped: no new products to migrate');
  } else {
    const productStagedTarget = await createStagedUploadTarget('products_migration.jsonl');
    await uploadFile(productStagedTarget, bulkProductFilePath);
    const productStagedPath = getStagedUploadPath(productStagedTarget);
    if (productStagedPath) {
      const productBulkOperationId = await triggerBulkMigration(productStagedPath, DEFAULT_PRODUCT_BULK_MUTATION);
      if (productBulkOperationId) {
        const productBulkSummary = await pollBulkOperationStatus(productBulkOperationId);
        console.log('📊 Product Bulk Operation Summary:');
        console.log(`   ID: ${productBulkSummary.id}`);
        console.log(`   Status: ${productBulkSummary.status}`);
        console.log(`   URL: ${productBulkSummary.url || 'N/A'}`);
        console.log(`   Partial Data URL: ${productBulkSummary.partialDataUrl || 'N/A'}`);
        logResult(
          'SYSTEM',
          'N/A',
          'SUCCESS',
          `Product bulk summary id=${productBulkSummary.id}, status=${productBulkSummary.status}, url=${productBulkSummary.url || 'N/A'}, partialDataUrl=${productBulkSummary.partialDataUrl || 'N/A'}`
        );

        if (productBulkSummary.url) {
          const productSyncResult = await syncProductIds(productBulkSummary.url, bulkProductFilePath);
          await enrichBulkCreatedProducts(productSyncResult.syncedWooIds);
        }
      }
    } else {
      console.warn('⚠️ Could not resolve staged upload path (key) for product bulk trigger.');
      logResult('SYSTEM', 'N/A', 'FAILED', 'Missing staged upload path (key) for product bulk trigger');
    }
  }

  // Fallback/cleanup pass for any products not mapped by bulk.
  console.log('🔄 Phase 3: Running REST-based product migration for unmapped items...');
  await migrateAllProducts();
  
  console.log('🔄 Phase 4: Running customer and order migration...');
  await migrateCustomersAndOrders();
  
  console.log('🎉 Full migration workflow complete!');
  logResult('SYSTEM', 'N/A', 'SUCCESS', 'Full migration workflow completed successfully');
}

async function main() {
  const mode = (process.env.MIGRATION_MODE || 'smoke').toLowerCase();

  if (mode === 'full') {
    console.log('🚀 Running FULL migration mode...');
    await runFullMigration();
    return;
  }

  console.log(`🧪 Running SMOKE mode (set MIGRATION_MODE=full for full run). Current mode: ${mode}`);
  await runSmokeTest();
}

main().catch((err) => {
  console.error('Migration Failed:', err.message);
  logResult('SYSTEM', 'N/A', 'FATAL', err.message || 'Unknown main error');
});
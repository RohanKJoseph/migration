const fs = require('fs');
const pLimit = require('p-limit');
const { Woo, Shopify } = require('../config/api-clients');
const tracker = require('./tracker');
const db = require('../database');
const { mapWooCustomerToShopify } = require('../mappers/customer-mapper');

const ORDER_PRESETS = {
  dev: { concurrency: 1, intervalMs: 13000, maxRetries: 6 },
  paid: { concurrency: 2, intervalMs: 2500, maxRetries: 5 }
};

let orderConfig = { ...ORDER_PRESETS.dev };
let orderLimiter = pLimit(orderConfig.concurrency);
const delay = (ms) => new Promise(res => setTimeout(res, ms));
const variantCacheBySku = new Map();
const variantsCacheByProductId = new Map();
const shopifyCustomerIdByEmailCache = new Map();
let lastOrderCreateAt = 0;

async function initializeOrderRateConfig() {
  const presetEnv = String(process.env.ORDER_RATE_PRESET || 'auto').trim().toLowerCase();
  let presetKey = 'dev';

  if (presetEnv === 'dev' || presetEnv === 'paid') {
    presetKey = presetEnv;
  } else {
    // auto mode: infer likely store tier from Shopify shop plan metadata
    try {
      const shopResp = await Shopify.get('/shop.json');
      const planName = String(shopResp?.data?.shop?.plan_name || '').toLowerCase();
      const isDevLike = planName.includes('partner')
        || planName.includes('development')
        || planName.includes('trial')
        || planName.includes('staff');
      presetKey = isDevLike ? 'dev' : 'paid';
    } catch (_) {
      // fallback safely when plan introspection is unavailable
      presetKey = 'dev';
    }
  }

  const preset = ORDER_PRESETS[presetKey] || ORDER_PRESETS.dev;

  const overrideConcurrency = Number(process.env.ORDER_MIGRATION_CONCURRENCY || preset.concurrency);
  const overrideInterval = Number(process.env.ORDER_CREATE_INTERVAL_MS || preset.intervalMs);
  const overrideRetries = Number(process.env.ORDER_CREATE_MAX_RETRIES || preset.maxRetries);

  orderConfig = {
    concurrency: Math.max(1, overrideConcurrency),
    intervalMs: Math.max(1000, overrideInterval),
    maxRetries: Math.max(1, overrideRetries)
  };
  orderLimiter = pLimit(orderConfig.concurrency);

  console.log(`⚙️ Order rate preset: ${presetKey} | concurrency=${orderConfig.concurrency}, intervalMs=${orderConfig.intervalMs}, maxRetries=${orderConfig.maxRetries}`);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isTransientOrderError(err) {
  const status = err?.response?.status;
  const code = err?.code;
  const message = String(err?.response?.data?.errors || err?.message || '').toLowerCase();
  return status === 429
    || (status >= 500 && status < 600)
    || message.includes('rate limit')
    || message.includes('try again in a minute')
    || code === 'ECONNRESET'
    || code === 'ETIMEDOUT'
    || code === 'ECONNABORTED';
}

async function throttleOrderCreate() {
  const now = Date.now();
  const waitMs = Math.max(0, orderConfig.intervalMs - (now - lastOrderCreateAt));
  if (waitMs > 0) {
    await delay(waitMs);
  }
  lastOrderCreateAt = Date.now();
}

async function findShopifyCustomerIdByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return null;
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
  } catch (_) {
    return null;
  }
}

function logResult(type, id, status, message = '') {
  const entry = `${new Date().toISOString()} | ${type} | ID: ${id} | ${status} | ${message}\n`;
  fs.appendFileSync('migration_audit.log', entry);
}

async function migrateCustomers(options = {}) {
  const perPage = options.per_page || 5;

  try {
    console.log('📥 Fetching WooCommerce Customers...');
    const { data: wooCustomers } = await Woo.get('customers', { per_page: perPage });

    for (const wooCust of wooCustomers) {
      const existingId = await tracker.customerTracker.getShopifyId(wooCust.id.toString());
      if (existingId) {
        console.log(`⏩ Already Migrated (Skipping): ${wooCust.email || wooCust.id}`);
        logResult('CUSTOMER', wooCust.id, 'SKIPPED', `Already mapped to Shopify ${existingId}`);
        continue;
      }

      const customerData = mapWooCustomerToShopify(wooCust);

      console.log(`🚀 Sending Customer: ${wooCust.email}`);
      console.dir(customerData, { depth: null });

      try {
        const res = await Shopify.post('/customers.json', customerData);
        await tracker.customerTracker.save(
          wooCust.id.toString(),
          res.data.customer.id.toString(),
          wooCust.email || null
        );
        if (wooCust.email) {
          await tracker.customerTracker.saveByEmail(wooCust.email, res.data.customer.id.toString());
        }
        console.log(`✅ Shopify Customer Created: ${res.data.customer.id}`);
        logResult('CUSTOMER', wooCust.id, 'SUCCESS', `Shopify ${res.data.customer.id}`);
      } catch (err) {
        // If email exists, find the ID to fix the local tracker
        if (err.response?.data?.errors?.email?.[0]?.includes('taken')) {
          const search = await Shopify.get(`/customers/search.json?query=email:${wooCust.email}`);
          if (search.data.customers.length > 0) {
            const existingId = search.data.customers[0].id;
            await tracker.customerTracker.save(
              wooCust.id.toString(),
              existingId.toString(),
              wooCust.email || null
            );
            if (wooCust.email) {
              await tracker.customerTracker.saveByEmail(wooCust.email, existingId.toString());
            }
            console.log(`🔗 Linked existing customer: ${wooCust.email}`);
            logResult('CUSTOMER', wooCust.id, 'LINKED', `Existing Shopify ${existingId}`);
          }
        } else {
          console.error(`❌ Customer Error [${wooCust.email}]:`, err.response?.data || err.message);
          logResult('CUSTOMER', wooCust.id, 'FAILED', err.message || 'Unknown error');
        }
      }
    }
  } catch (fatal) {
    console.error('💀 Customer Migration Fatal:', fatal.message);
    logResult('SYSTEM', 'N/A', 'FATAL', fatal.message || 'Unknown customer migration fatal error');
  }
}

async function migrateOrders() {
  await initializeOrderRateConfig();

  let page = 1;
  let processedPages = 0;
  let totalOrdersFetched = 0;
  let totals = {
    created: 0,
    skippedMapped: 0,
    skippedNoEmail: 0,
    skippedNoCustomer: 0,
    failed: 0
  };

  while (true) {
    const response = await Woo.get('orders', { per_page: 100, page });
    const wooOrders = response?.data || [];

    if (!wooOrders.length) {
      break;
    }

    processedPages += 1;
    totalOrdersFetched += wooOrders.length;
    console.log(`📦 Processing Woo orders page ${page} (${wooOrders.length} orders)`);

    const pageStats = await migrateAllOrders(wooOrders);
    totals.created += pageStats.created;
    totals.skippedMapped += pageStats.skippedMapped;
    totals.skippedNoEmail += pageStats.skippedNoEmail;
    totals.skippedNoCustomer += pageStats.skippedNoCustomer;
    totals.failed += pageStats.failed;

    console.log(
      `📊 Orders page ${page} result: created=${pageStats.created}, skippedMapped=${pageStats.skippedMapped}, skippedNoEmail=${pageStats.skippedNoEmail}, skippedNoCustomer=${pageStats.skippedNoCustomer}, failed=${pageStats.failed}`
    );
    page += 1;
  }

  console.log(`✅ Order pagination complete. pages=${processedPages}, fetched=${totalOrdersFetched}, created=${totals.created}, skippedMapped=${totals.skippedMapped}, skippedNoEmail=${totals.skippedNoEmail}, skippedNoCustomer=${totals.skippedNoCustomer}, failed=${totals.failed}`);
}

async function migrateAllOrders(wooOrders) {
  let created = 0;
  let skippedMapped = 0;
  let skippedNoEmail = 0;
  let skippedNoCustomer = 0;
  let failed = 0;

  const tasks = wooOrders.map((wooOrder) => orderLimiter(async () => {
    try {
      const existingOrderMap = await db.get(
        'SELECT shopify_id FROM order_map WHERE woo_id = ?',
        [String(wooOrder.id)]
      );
      if (existingOrderMap?.shopify_id) {
        console.log(`⏩ Skipped Order ${wooOrder.id}: already mapped to Shopify ${existingOrderMap.shopify_id}`);
        skippedMapped += 1;
        return;
      }

      const billingEmail = String(wooOrder?.billing?.email || '').trim().toLowerCase();
      if (!billingEmail) {
        console.log(`⏭️ Skipped Order ${wooOrder.id}: missing billing email`);
        skippedNoEmail += 1;
        return;
      }

      // 1. Fetch the Shopify Customer ID we just synced
      let shopifyCustomer = await db.get(
        'SELECT shopify_id FROM customer_map WHERE LOWER(email) = ?',
        [billingEmail]
      );

      if (!shopifyCustomer?.shopify_id) {
        shopifyCustomer = await db.get(
          'SELECT shopify_id FROM customer_map_by_email WHERE LOWER(email) = ?',
          [billingEmail]
        );
      }

      if (!shopifyCustomer?.shopify_id) {
        const fallbackId = await tracker.customerTracker.getIdByEmail(billingEmail);
        if (fallbackId) {
          shopifyCustomer = { shopify_id: fallbackId };
        }
      }

      if (!shopifyCustomer?.shopify_id) {
        const searchedId = await findShopifyCustomerIdByEmail(billingEmail);
        if (searchedId) {
          shopifyCustomer = { shopify_id: searchedId };
          await tracker.customerTracker.saveByEmail(billingEmail, searchedId);
        }
      }

      if (!shopifyCustomer?.shopify_id) {
        console.log(`⏭️ Skipped Order ${wooOrder.id}: no Shopify customer mapping for ${billingEmail}`);
        skippedNoCustomer += 1;
        return;
      }

      const normalizedShopifyId = String(shopifyCustomer.shopify_id).replace(/\.0$/, '');
      const payload = {
        order: {
          customer: { id: parseInt(normalizedShopifyId, 10) },
          processed_at: wooOrder.date_created,
          financial_status: 'paid',
          fulfillment_status: 'fulfilled',
          currency: wooOrder.currency,
          total_tax: wooOrder.total_tax,
          line_items: (wooOrder.line_items || []).map((item) => ({
            sku: item.sku,
            quantity: item.quantity,
            price: item.price,
            title: item.name
          })),
          // CRITICAL: Prevent bulk customer notifications during migration
          send_receipt: false,
          send_fulfillment_receipt: false,
          inventory_behavior: 'bypass'
        }
      };

      let response = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= orderConfig.maxRetries; attempt++) {
        try {
          await throttleOrderCreate();
          response = await Shopify.post('/orders.json', payload, { timeout: 45000 });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (!isTransientOrderError(err) || attempt === orderConfig.maxRetries) {
            break;
          }

          const message = String(err?.response?.data?.errors || err?.message || '').toLowerCase();
          const retryWait = message.includes('try again in a minute')
            ? 65000
            : Math.min(30000, (1000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 300));

          console.warn(`⚠️ Order ${wooOrder.id} transient error (attempt ${attempt}/${orderConfig.maxRetries}). Retrying in ${retryWait}ms...`);
          await delay(retryWait);
        }
      }

      if (!response) {
        throw lastErr || new Error('Order create failed with unknown error');
      }
      const createdShopifyOrderId = String(response?.data?.order?.id || '').replace(/\.0$/, '');

      if (createdShopifyOrderId) {
        await db.run(
          'INSERT OR REPLACE INTO order_map (woo_id, shopify_id) VALUES (?, ?)',
          [String(wooOrder.id), createdShopifyOrderId]
        );
      }

      console.log(`✅ Order ${wooOrder.id} -> Shopify ${createdShopifyOrderId || 'unknown'}`);
      created += 1;
    } catch (err) {
      console.error(`❌ Failed Order ${wooOrder.id}:`, err.response?.data || err.message);
      failed += 1;
    }
  }));

  await Promise.all(tasks);
  return { created, skippedMapped, skippedNoEmail, skippedNoCustomer, failed };
}

async function migrateCustomersAndOrders(options = {}) {
  await migrateCustomers(options);
  await migrateOrders(options);
}

async function validateMigration(wooOrderId) {
  // 1. Fetch original from WooCommerce
  const { data: wooOrder } = await Woo.get(`orders/${wooOrderId}`);

  // 2. Fetch the newly created order from Shopify using local mapping
  const mapping = await db.get('SELECT shopify_id FROM order_map WHERE woo_id = ?', [String(wooOrderId)]);
  if (!mapping?.shopify_id) {
    throw new Error(`No Shopify order mapping found for Woo order ${wooOrderId}`);
  }

  const shopifyOrderRes = await Shopify.get(`/orders/${mapping.shopify_id}.json`);
  const shopifyOrder = shopifyOrderRes?.data?.order;
  if (!shopifyOrder) {
    throw new Error(`Unable to fetch Shopify order ${mapping.shopify_id}`);
  }

  const discrepancies = [];
  if (parseFloat(wooOrder.total) !== parseFloat(shopifyOrder.current_total_price)) {
    discrepancies.push(`Price Mismatch: Woo(${wooOrder.total}) vs Shopify(${shopifyOrder.current_total_price})`);
  }

  const wooItemCount = (wooOrder.line_items || []).length;
  const shopifyItemCount = (shopifyOrder.line_items || []).length;
  if (wooItemCount !== shopifyItemCount) {
    discrepancies.push(`Item Count Mismatch: Woo(${wooItemCount}) vs Shopify(${shopifyItemCount})`);
  }

  if (discrepancies.length > 0) {
    console.error(`⚠️ Discrepancy in Order ${wooOrderId}: ${discrepancies.join(' | ')}`);
    return { valid: false, discrepancies, wooOrderId, shopifyOrderId: mapping.shopify_id };
  }

  console.log(`✅ Order ${wooOrderId} is 100% accurate.`);
  return { valid: true, discrepancies: [], wooOrderId, shopifyOrderId: mapping.shopify_id };
}

module.exports = { migrateCustomers, migrateOrders, migrateAllOrders, migrateCustomersAndOrders, validateMigration };

if (require.main === module) {
  migrateCustomersAndOrders();
}
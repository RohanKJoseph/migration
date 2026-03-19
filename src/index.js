const fs = require('fs');
const { Woo, Shopify } = require('./config/api-clients');
const { tracker, customerTracker } = require('./services/tracker');
const { mapWooProductToShopify } = require('./mappers/product-mapper');
const { mapWooCustomerToShopify } = require('./mappers/customer-mapper');
const { mapWooOrderToShopify } = require('./mappers/order-mapper');
const limiter = require('./services/rate-limiter');
const { migrateCustomers, migrateOrders, migrateCustomersAndOrders } = require('./services/migration-service');

function logResult(type, id, status, message = '') {
  const entry = `${new Date().toISOString()} | ${type} | ID: ${id} | ${status} | ${message}\n`;
  fs.appendFileSync('migration_audit.log', entry);
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
  let page = 1;
  let keepGoing = true;

  while (keepGoing) {
    console.log(`\n📦 Fetching Page ${page} of Products...`);

    try {
      const { data: products } = await Woo.get('products', {
        per_page: 50,
        page: page
      });

      if (products.length === 0) {
        console.log('🏁 No more products found.');
        logResult('PRODUCT', 'N/A', 'COMPLETE', `No products on page ${page}`);
        keepGoing = false;
        break;
      }

      for (const item of products) {
        const existingId = await tracker.isMigrated(item.id.toString());

        if (existingId) {
          console.log(`⏩ Skipping: ${item.name}`);
          logResult('PRODUCT', item.id, 'SKIPPED', `Already mapped to Shopify ${existingId}`);
          continue;
        }

        await limiter.schedule(async () => {
          try {
            const shopifyData = mapWooProductToShopify(item);
            const response = await Shopify.post('/products.json', shopifyData);
            tracker.saveMapping(item.id.toString(), response.data.product.id);
            console.log(`✅ Migrated: ${item.name}`);
            logResult('PRODUCT', item.id, 'SUCCESS', `Shopify ${response.data.product.id}`);
          } catch (err) {
            console.error(`❌ Failed ${item.name}:`, err.response?.data || err.message);
            logResult('PRODUCT', item.id, 'FAILED', err.message || 'Unknown error');
          }
        });
      }

      page++;
    } catch (error) {
      console.error('💀 Batch Error:', error.message);
      logResult('PRODUCT', 'N/A', 'FAILED', error.message || 'Batch error');
      keepGoing = false;
    }
  }
}

async function runFullMigration() {
  await migrateAllProducts();
  await migrateCustomersAndOrders();
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
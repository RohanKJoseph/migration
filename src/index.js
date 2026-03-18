const { Woo, Shopify } = require('./config/api-clients');
const { tracker } = require('./services/tracker');
const { mapWooProductToShopify } = require('./mappers/product-mapper');
const limiter = require('./services/rate-limiter');
const { migrateCustomersAndOrders } = require('./services/migration-service');

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
        keepGoing = false;
        break;
      }

      for (const item of products) {
        const existingId = await tracker.isMigrated(item.id.toString());

        if (existingId) {
          // This keeps your console clean while still showing progress
          console.log(`⏩ Skipping: ${item.name}`);
          continue;
        }

        await limiter.schedule(async () => {
          try {
            const shopifyData = mapWooProductToShopify(item);
            const response = await Shopify.post('/products.json', shopifyData);
            tracker.saveMapping(item.id.toString(), response.data.product.id);
            console.log(`✅ Migrated: ${item.name}`);
          } catch (err) {
            console.error(`❌ Failed ${item.name}:`, err.response?.data || err.message);
          }
        });
      }

      page++; // Move to next page for the next loop iteration
    } catch (error) {
      console.error('💀 Batch Error:', error.message);
      keepGoing = false;
    }
  }
}

async function runAllMigrations() {
  await migrateAllProducts();
  await migrateCustomersAndOrders();
}

runAllMigrations().catch((err) => {
  console.error('Migration Failed:', err.message);
});
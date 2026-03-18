const { Woo, Shopify } = require('./config/api-clients');
const { mapWooProductToShopify } = require('./mappers/product-mapper');
const tracker = require('./services/tracker');
const limiter = require('./services/rate-limiter');

async function runSafeMigration() {
    console.log("Woo Client Check:", typeof Woo); // Should be 'object'
    console.log("Woo Get Method Check:", typeof Woo?.get); // Should be 'function'
  try {
    console.log("🔍 Fetching batch from WooCommerce...");
    const { data: wooProducts } = await Woo.get("products", { per_page: 50 });

    for (const item of wooProducts) {
      // 1. CHECK: Has this been migrated already?
      const existingId = await tracker.isMigrated(item.id.toString());
      
      if (existingId) {
        console.log(`⏩ Skipping ${item.name} (Already on Shopify: ${existingId})`);
        continue;
      }

      // 2. SCHEDULE: Add to the rate-limited queue
      await limiter.schedule(async () => {
        try {
          const shopifyData = mapWooProductToShopify(item);
          const response = await Shopify.post('/products.json', shopifyData);
          
          const newShopifyId = response.data.product.id;
          
          // 3. RECORD: Save the success to SQLite
          tracker.saveMapping(item.id.toString(), newShopifyId);
          console.log(`✅ Migrated: ${item.name}`);
        } catch (err) {
          console.error(`❌ Failed ${item.name}:`, err.response?.data || err.message);
        }
      });
    }

    console.log("🏁 Migration loop finished.");
  } catch (error) {
    console.error("FATAL ERROR:", error.message);
  }
}

runSafeMigration();
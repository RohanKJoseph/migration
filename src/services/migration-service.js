const fs = require('fs');
const { Woo, Shopify } = require('../config/api-clients');
const tracker = require('./tracker');
const { mapWooOrderToShopify } = require('../mappers/order-mapper');
const { mapWooCustomerToShopify } = require('../mappers/customer-mapper');

const delay = (ms) => new Promise(res => setTimeout(res, ms));

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
  const { data: wooOrders } = await Woo.get("orders", { per_page: 50 });

  for (const wooOrder of wooOrders) {
    const guestEmail = wooOrder.billing.email;
    let shopifyId = await tracker.customerTracker.getIdByEmail(guestEmail);

    // 1. If not in local DB, check Shopify directly (to prevent duplicates)
    if (!shopifyId) {
      const search = await Shopify.get(`/customers/search.json?query=email:${guestEmail}`);
      if (search.data.customers.length > 0) {
        shopifyId = search.data.customers[0].id;
        // Update local tracker so we don't have to API search again
        await tracker.customerTracker.save("guest", shopifyId, guestEmail);
      }
    }

    // 2. If still no ID, create the Guest Customer on-the-fly
    if (!shopifyId) {
      console.log(`👤 New Guest detected: ${guestEmail}. Creating profile...`);
      const guestData = mapWooCustomerToShopify(wooOrder.billing);
      
      // ADD THIS LOG
      console.log("🛠️ DEBUG: Sending Guest Data to Shopify:");
      console.dir(guestData, { depth: null });

      const res = await Shopify.post('/customers.json', guestData);
      shopifyId = res.data.customer.id;
      await tracker.customerTracker.save("guest", shopifyId, guestEmail);
    }

    // 3. Now migrate the order with the confirmed shopifyId
    const orderData = mapWooOrderToShopify(wooOrder, shopifyId);
    await Shopify.post('/orders.json', orderData);
    console.log(`✅ Order #${wooOrder.id} migrated for ${guestEmail}`);
    
    // Rate limit: Stay under 2 requests per second
    await delay(550);
  }
}

async function migrateCustomersAndOrders(options = {}) {
  await migrateCustomers(options);
  await migrateOrders(options);
}

module.exports = { migrateCustomers, migrateOrders, migrateCustomersAndOrders };

if (require.main === module) {
  migrateCustomersAndOrders();
}
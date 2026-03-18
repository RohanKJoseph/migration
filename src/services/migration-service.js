const { Woo, Shopify } = require('../config/api-clients');
const tracker = require('./tracker');
const { mapWooOrderToShopify } = require('../mappers/order-mapper');
const { mapWooCustomerToShopify } = require('../mappers/customer-mapper');

async function migrateCustomersAndOrders() {
  try {
    console.log('📥 Fetching WooCommerce Customers...');
    const { data: wooCustomers } = await Woo.get('customers', { per_page: 5 });

    for (const wooCust of wooCustomers) {
      const existingId = await tracker.customerTracker.getShopifyId(wooCust.id.toString());
      if (existingId) {
        console.log(`⏩ Already Migrated (Skipping): ${wooCust.email || wooCust.id}`);
        continue;
      }

      const customerData = mapWooCustomerToShopify(wooCust);

      console.log(`🚀 Sending Customer: ${wooCust.email}`);
      console.dir(customerData, { depth: null });

      try {
        const res = await Shopify.post('/customers.json', customerData);
        await tracker.customerTracker.save(wooCust.id.toString(), res.data.customer.id.toString());
        console.log(`✅ Shopify Customer Created: ${res.data.customer.id}`);
      } catch (err) {
        // If email exists, find the ID to fix the local tracker
        if (err.response?.data?.errors?.email?.[0]?.includes('taken')) {
          const search = await Shopify.get(`/customers/search.json?query=email:${wooCust.email}`);
          if (search.data.customers.length > 0) {
            const existingId = search.data.customers[0].id;
            await tracker.customerTracker.save(wooCust.id.toString(), existingId.toString());
            console.log(`🔗 Linked existing customer: ${wooCust.email}`);
          }
        } else {
          console.error(`❌ Customer Error [${wooCust.email}]:`, err.response?.data || err.message);
        }
      }
    }

    console.log('\n📥 Fetching WooCommerce Orders...');
    const { data: wooOrders } = await Woo.get('orders', { per_page: 5 });

    for (const wooOrder of wooOrders) {
      const shopifyCustId = await tracker.customerTracker.getShopifyId(wooOrder.customer_id.toString());

      if (!shopifyCustId) {
        console.log(`⚠️ Skipping Order #${wooOrder.id}: Customer not in Shopify yet.`);
        continue;
      }

      const orderData = mapWooOrderToShopify(wooOrder, shopifyCustId);

      console.log(`🚀 Sending Order #${wooOrder.id} for Shopify Customer ${shopifyCustId}`);
      console.dir(orderData, { depth: null });

      try {
        const res = await Shopify.post('/orders.json', orderData);
        console.log(`✅ Shopify Order Created: ${res.data.order.id}`);
      } catch (err) {
        console.error(`❌ Order Error [#${wooOrder.id}]:`, err.response?.data || err.message);
      }
    }
  } catch (fatal) {
    console.error('💀 Fatal Crash:', fatal.message);
  }
}

module.exports = { migrateCustomersAndOrders };

if (require.main === module) {
  migrateCustomersAndOrders();
}
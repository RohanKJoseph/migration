// src/mappers/order-mapper.js

const mapWooOrderToShopify = (wooOrder, shopifyCustomerId) => {
  return {
    order: {
      // FIX: Force the ID to be an Integer
      customer: { 
        id: parseInt(shopifyCustomerId, 10) 
      },
      line_items: wooOrder.line_items.map(item => ({
        title: item.name || "Product",
        quantity: item.quantity,
        price: item.price,
        sku: item.sku || ""
      })),
      financial_status: 'paid',
      fulfillment_status: 'fulfilled',
      processed_at: wooOrder.date_created,
      send_receipt: false
    }
  };
};

module.exports = { mapWooOrderToShopify };
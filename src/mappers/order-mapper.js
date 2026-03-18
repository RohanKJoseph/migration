// src/mappers/order-mapper.js

const mapWooOrderToShopify = (wooOrder, shopifyCustomerId) => {
  return {
    order: {
      customer: { id: shopifyCustomerId },
      line_items: wooOrder.line_items.map(item => ({
        // Fallback to item name or generic 'Product' to prevent blank title errors
        title: item.name || "Purchased Product", 
        quantity: item.quantity,
        price: item.price,
        sku: item.sku || ""
      })),
      financial_status: 'paid',
      fulfillment_status: 'fulfilled',
      send_receipt: false
    }
  };
};

module.exports = { mapWooOrderToShopify };
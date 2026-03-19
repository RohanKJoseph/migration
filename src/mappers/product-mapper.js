/**
 * Transforms a WooCommerce product object into a Shopify-ready object.
 */
const mapWooMetaToShopify = (wooMetaArray = []) => {
  return wooMetaArray.map((meta) => ({
    namespace: "migration_data",
    key: String(meta.key || "").replace(/^_/, ""),
    value: String(meta.value ?? ""),
    type: "single_line_text_field"
  }));
};

const mapWooProductToShopify = (wooProduct) => {
  return {
    product: {
      title: wooProduct.name,
      body_html: wooProduct.description,
      vendor: "WooCommerce Migration",
      status: wooProduct.status === 'publish' ? 'active' : 'draft',
      variants: [
        {
          price: wooProduct.regular_price || "0.00",
          sku: wooProduct.sku,
          inventory_policy: "deny",
          compare_at_price: wooProduct.sale_price || null
        }
      ],
      metafields: mapWooMetaToShopify(wooProduct.meta_data),
      images: wooProduct.images.map(img => ({ src: img.src })),
    }
  };
};

module.exports = { mapWooProductToShopify };
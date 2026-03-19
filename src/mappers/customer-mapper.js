// src/mappers/customer-mapper.js

const formatPhone = (phone) => {
  if (!phone) return null;
  // Remove everything except digits
  let cleaned = phone.replace(/\D/g, '');
  // Shopify usually requires a '+' and country code (e.g., +91 for India)
  return cleaned.startsWith('91') ? `+${cleaned}` : `+91${cleaned}`;
};

const mapWooMetaToShopify = (wooMetaArray = []) => {
  return wooMetaArray.map((meta) => ({
    namespace: "migration_data",
    key: String(meta.key || "").replace(/^_/, ""),
    value: String(meta.value ?? ""),
    type: "single_line_text_field"
  }));
};

const mapWooCustomerToShopify = (source) => {
  const billing = source?.billing || source || {};
  const metaData = Array.isArray(source?.meta_data) ? source.meta_data : [];

  return {
    customer: {
      first_name: billing.first_name || "Guest",
      last_name: billing.last_name || "Customer", // NEVER leave this blank
      email: billing.email,
      verified_email: true,
      addresses: [{
        address1: billing.address_1 || "",
        city: billing.city || "",
        zip: billing.postcode || "",
        country: billing.country || "IN"
      }],
      ...(metaData.length > 0 ? { metafields: mapWooMetaToShopify(metaData) } : {})
    }
  };
};

module.exports = { mapWooCustomerToShopify }; // Ensure this is exactly like this
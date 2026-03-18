// src/mappers/customer-mapper.js

const formatPhone = (phone) => {
  if (!phone) return null;
  // Remove everything except digits
  let cleaned = phone.replace(/\D/g, '');
  // Shopify usually requires a '+' and country code (e.g., +91 for India)
  return cleaned.startsWith('91') ? `+${cleaned}` : `+91${cleaned}`;
};

const mapWooCustomerToShopify = (woo) => {
  return {
    customer: {
      first_name: woo.first_name || "Guest",
      last_name: woo.last_name || "Customer",
      email: woo.email,
      phone: formatPhone(woo.billing?.phone), // Fixes the 'is invalid' error
      verified_email: true,
      addresses: [{
        address1: woo.billing?.address_1 || "",
        city: woo.billing?.city || "",
        zip: woo.billing?.postcode || "",
        country: woo.billing?.country || "IN"
      }]
    }
  };
};

module.exports = { mapWooCustomerToShopify }; // Ensure this is exactly like this
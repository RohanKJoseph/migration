// src/config/api-clients.js
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const axios = require("axios");
require('dotenv').config();

const Woo = new WooCommerceRestApi({
  url: process.env.WOO_URL,
  consumerKey: process.env.WOO_KEY,
  consumerSecret: process.env.WOO_SECRET,
  version: "wc/v3"
});

// Create a pre-configured axios instance for Shopify
const Shopify = axios.create({
  baseURL: `${process.env.SHOPIFY_URL}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN,
    'Content-Type': 'application/json'
  }
});

// IMPORTANT: Ensure you are exporting them as an object
module.exports = { Woo, Shopify };
const Bottleneck = require("bottleneck");

// Limits to 2 requests per second to stay safe with Shopify's REST API
const limiter = new Bottleneck({
  minTime: 500, 
  maxConcurrent: 1
});

module.exports = limiter;
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Initialize database in the root folder
const db = new sqlite3.Database(path.join(__dirname, '../../migration.db'));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS product_map (
    woo_id TEXT PRIMARY KEY,
    shopify_id TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run("CREATE TABLE IF NOT EXISTS customer_map (woo_id TEXT PRIMARY KEY, shopify_id TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS order_map (woo_id TEXT PRIMARY KEY, shopify_id TEXT)");
});

const tracker = {
  isMigrated: (wooId) => {
    return new Promise((resolve) => {
      db.get("SELECT shopify_id FROM product_map WHERE woo_id = ?", [wooId], (err, row) => {
        resolve(row ? row.shopify_id : null);
      });
    });
  },
  saveMapping: (wooId, shopifyId) => {
    db.run("INSERT INTO product_map (woo_id, shopify_id) VALUES (?, ?)", [wooId, shopifyId]);
  }
};

const customerTracker = {
  getShopifyId: (wooId) => {
    return new Promise((resolve) => {
      db.get("SELECT shopify_id FROM customer_map WHERE woo_id = ?", [wooId], (err, row) => {
        resolve(row ? row.shopify_id : null);
      });
    });
  },
  save: (wooId, shopifyId) => {
    db.run("INSERT INTO customer_map (woo_id, shopify_id) VALUES (?, ?)", [wooId, shopifyId]);
  }
};

module.exports = { tracker, customerTracker };

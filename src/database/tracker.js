const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./migration_tracker.db');

// Create a table to track migrated items
db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS migrated_products (woo_id TEXT PRIMARY KEY, shopify_id TEXT)");
});

const isAlreadyMigrated = (wooId) => {
  return new Promise((resolve) => {
    db.get("SELECT shopify_id FROM migrated_products WHERE woo_id = ?", [wooId], (err, row) => {
      resolve(row ? true : false);
    });
  });
};
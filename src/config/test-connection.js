const { Woo } = require('./api-clients');

async function check() {
  try {
    const { data } = await Woo.get("products", { per_page: 1 });
    console.log("✅ Connection Successful! Found product:", data[0].name);
  } catch (err) {
    console.error("❌ Connection Failed. Check your URL and Keys.");
    console.error("Error Detail:", err.message);
  }
}
check();
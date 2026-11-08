const fs = require("node:fs/promises");
const path = require("node:path");

const root = __dirname;
const output = path.join(root, "dist");
const assets = ["index.html", "desain.css", "animasi.js", "order-app.js"];

async function build() {
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  for (const asset of assets) {
    await fs.copyFile(path.join(root, asset), path.join(output, asset));
  }
  console.log(`Prepared ${assets.length} storefront assets in dist/.`);
}

build().catch(error => {
  console.error("Failed to prepare Cloudflare assets:", error);
  process.exitCode = 1;
});

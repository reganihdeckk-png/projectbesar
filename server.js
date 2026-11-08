const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT || process.env.SERVER_PORT) || 3000;
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const API_KEY = process.env.PREMKU_API_KEY?.trim();
const API_SECRET = process.env.PREMKU_API_SECRET?.trim();
const INSTANCE_ID = process.env.PREMIUM_STORE_INSTANCE_ID || "";
const DATA_DIR = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "premium-orders.json");
const API_BASE = "https://premku.com/api/";
const MAX_BODY_BYTES = 8 * 1024;
const CHECKOUT_TTL_MS = 60 * 60 * 1000;

if (!API_KEY) {
  console.error("Set PREMKU_API_KEY to an active Premku API key before starting the store.");
  process.exit(1);
}

let storeQueue = Promise.resolve();

function withStore(operation) {
  const result = storeQueue.then(async () => {
    let orders = {};
    try {
      orders = JSON.parse(await fs.readFile(ORDERS_FILE, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const value = await operation(orders);
    await fs.mkdir(DATA_DIR, { recursive: true });
    const temporaryFile = `${ORDERS_FILE}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(orders), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryFile, ORDERS_FILE);
    return value;
  });
  storeQueue = result.catch(() => {});
  return result;
}

async function callPremku(endpoint, payload = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(new URL(endpoint, API_BASE), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: API_KEY,
        ...(API_SECRET ? { api_secret: API_SECRET } : {}),
        ...payload
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const details = data && typeof data === "object"
        ? [data.message, data.error, data.msg].find(value => typeof value === "string" && value.trim())
        : "";
      const error = new Error(
        `Premku returned HTTP ${response.status} for "${endpoint}"${details ? `: ${details}` : ""}.`
      );
      error.statusCode = response.status;
      error.endpoint = endpoint;
      throw error;
    }
    if (!data || typeof data !== "object") {
      throw new Error("Premku returned an invalid response.");
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

function publicApiError(error) {
  const upstreamStatus = error.message.match(/Premku returned HTTP (\d+)/);
  if (upstreamStatus && (upstreamStatus[1] === "401" || upstreamStatus[1] === "403")) {
    const endpoint = error.endpoint ? ` pada endpoint "${error.endpoint}"` : "";
    let safeDetails = error.message
      .replace(/Premku returned HTTP \d+ for "[^"]+":?\s*/i, "")
      .replace(/(api[_-]?key|secret)\s*[:=]\s*[^,\s}]+/gi, "$1=[disembunyikan]");
    safeDetails = safeDetails.replaceAll(API_KEY, "[disembunyikan]");
    if (API_SECRET) safeDetails = safeDetails.replaceAll(API_SECRET, "[disembunyikan]");
    safeDetails = safeDetails.slice(0, 240);
    const cause = safeDetails ? ` Detail Premku: ${safeDetails}` : "";
    const guidance = upstreamStatus[1] === "401"
      ? "Pastikan API KEY dan API SECRET benar, tidak tertukar, masih aktif, dan memiliki izin untuk endpoint ini."
      : "Pastikan akun/kunci diizinkan mengakses endpoint ini.";
    return `Premku menolak akses (HTTP ${upstreamStatus[1]})${endpoint}. ${guidance}${cause}`;
  }
  if (error.name === "AbortError") return "Permintaan ke Premku melewati batas waktu. Coba muat ulang.";
  if (upstreamStatus) {
    const endpoint = error.endpoint ? ` pada endpoint "${error.endpoint}"` : "";
    return `Premku mengembalikan HTTP ${upstreamStatus[1]}${endpoint}. Coba muat ulang beberapa saat lagi.`;
  }
  return "Toko tidak dapat memproses permintaan. Silakan coba lagi.";
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    }
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON request body."), { statusCode: 400 });
  }
}

function validId(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function validQuantity(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 10;
}

function validCheckoutToken(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

async function getProduct(productId) {
  const result = await callPremku("products");
  if (!Array.isArray(result.products)) {
    throw new Error(result.message || "Premku did not return a product list.");
  }
  return result.products.find(product => Number(product.id) === Number(productId));
}

function safeProduct(product) {
  if (!product || typeof product !== "object") return null;
  return {
    id: Number(product.id),
    name: String(product.name || "Aplikasi premium").slice(0, 160),
    description: String(product.description || "").slice(0, 500),
    price: Number(product.price),
    stock: Number(product.stock),
    status: String(product.status || ""),
    image: typeof product.image === "string" ? product.image : ""
  };
}

async function getCheckout(token) {
  if (!validCheckoutToken(token)) return null;
  return withStore(orders => orders[token] || null);
}

async function setCheckout(token, update) {
  return withStore(orders => {
    if (!orders[token]) return null;
    Object.assign(orders[token], update);
    return orders[token];
  });
}

async function orderAfterPayment(token) {
  const checkout = await getCheckout(token);
  if (!checkout || checkout.status !== "pending_payment") return checkout;

  const payment = await callPremku("pay_status", { invoice: checkout.paymentInvoice });
  if (payment?.data?.status !== "success") {
    if (payment?.data?.status === "failed" || payment?.data?.status === "expired") {
      return setCheckout(token, { status: "failed", error: "Pembayaran gagal atau kedaluwarsa." });
    }
    return checkout;
  }

  const claimed = await withStore(orders => {
    const current = orders[token];
    if (!current || current.status !== "pending_payment") return null;
    current.status = "ordering";
    return current;
  });
  if (!claimed) return getCheckout(token);

  let result;
  try {
    result = await callPremku("order", {
      product_id: claimed.productId,
      qty: claimed.quantity
    });
  } catch (error) {
    await setCheckout(token, {
      status: "failed",
      error: `Pembayaran terdeteksi, tetapi order tidak dapat dibuat: ${error.message}`
    });
    return getCheckout(token);
  }

  if (!result.success || !result.invoice) {
    await setCheckout(token, {
      status: "failed",
      error: result.message || "Pembayaran terdeteksi, tetapi Premku menolak order."
    });
    return getCheckout(token);
  }
  return setCheckout(token, { status: "processing", orderInvoice: String(result.invoice) });
}

function publicCheckout(checkout) {
  return {
    status: checkout.status,
    productName: checkout.productName,
    quantity: checkout.quantity,
    total: checkout.total,
    paymentInvoice: checkout.paymentInvoice,
    qrImage: checkout.qrImage,
    error: checkout.error || ""
  };
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/premium/health") {
    return sendJson(response, 200, { ready: true, instanceId: INSTANCE_ID });
  }

  if (request.method === "GET" && url.pathname === "/api/premium/products") {
    const result = await callPremku("products");
    if (!Array.isArray(result.products)) {
      return sendJson(response, 502, { error: result.message || "Daftar produk tidak tersedia." });
    }
    const products = result.products
      .map(safeProduct)
      .filter(product => product && Number.isSafeInteger(product.id) && Number.isFinite(product.price) &&
        Number.isFinite(product.stock) && product.status === "available");
    return sendJson(response, 200, { products });
  }

  if (request.method === "POST" && url.pathname === "/api/premium/checkout") {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        !validId(body.productId) || !validQuantity(body.quantity)) {
      return sendJson(response, 400, { error: "Produk atau jumlah tidak valid. Maksimal 10 item." });
    }

    const product = await getProduct(body.productId);
    if (!product || product.status !== "available") {
      return sendJson(response, 409, { error: "Produk tidak tersedia. Muat ulang katalog." });
    }
    const quantity = Number(body.quantity);
    const unitPrice = Number(product.price);
    const stock = Number(product.stock);
    const total = unitPrice * quantity;
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 1 || !Number.isSafeInteger(stock) ||
        stock < quantity || !Number.isSafeInteger(total)) {
      return sendJson(response, 409, { error: "Stok atau harga produk tidak valid." });
    }

    const payment = await callPremku("pay", { amount: total });
    const paymentData = payment.data;
    if (!payment.success || !paymentData?.invoice || !paymentData?.qr_image) {
      return sendJson(response, 502, { error: payment.message || "Premku gagal membuat pembayaran." });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const checkout = {
      productId: Number(product.id),
      productName: String(product.name || "Aplikasi premium").slice(0, 160),
      quantity,
      total,
      paymentInvoice: String(paymentData.invoice),
      qrImage: String(paymentData.qr_image),
      status: "pending_payment",
      createdAt: Date.now()
    };
    await withStore(orders => {
      orders[token] = checkout;
      return null;
    });
    return sendJson(response, 201, { checkoutToken: token, checkout: publicCheckout(checkout) });
  }

  if (request.method === "GET" && url.pathname === "/api/premium/checkout") {
    const token = url.searchParams.get("token");
    let checkout = await getCheckout(token);
    if (!checkout) return sendJson(response, 404, { error: "Pesanan tidak ditemukan." });
    if (Date.now() - checkout.createdAt > CHECKOUT_TTL_MS &&
        checkout.status === "pending_payment") {
      checkout = await setCheckout(token, { status: "expired", error: "Batas waktu pembayaran telah berakhir." });
    }

    if (checkout.status === "pending_payment") {
      checkout = await orderAfterPayment(token);
    } else if (checkout.status === "processing" && checkout.orderInvoice) {
      const result = await callPremku("status", { invoice: checkout.orderInvoice });
      if (result.status === "success") {
        checkout = await setCheckout(token, {
          status: "success",
          accounts: Array.isArray(result.accounts) ? result.accounts : []
        });
      } else if (result.status === "failed") {
        checkout = await setCheckout(token, {
          status: "failed",
          error: result.message || "Order gagal diproses oleh Premku."
        });
      }
    }

    return sendJson(response, 200, {
      checkout: {
        ...publicCheckout(checkout),
        accounts: checkout.status === "success" ? checkout.accounts || [] : []
      }
    });
  }

  return sendJson(response, 404, { error: "API route tidak ditemukan." });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(request, response, url);
    } catch (error) {
      console.error("Store API request failed:", error.message);
      if (!response.headersSent) {
        sendJson(response, error.statusCode || 502, {
          error: error.statusCode ? error.message : publicApiError(error)
        });
      } else {
        response.destroy();
      }
    }
    return;
  }

  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.resolve(__dirname, `.${pathname}`);
  if (!filePath.startsWith(`${__dirname}${path.sep}`)) {
    return sendJson(response, 403, { error: "Forbidden." });
  }
  try {
    const contents = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const types = {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    };
    response.writeHead(200, {
      "Content-Type": types[extension] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(contents);
  } catch (error) {
    sendJson(response, error.code === "ENOENT" ? 404 : 500, { error: "File tidak ditemukan." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Premium store listening on http://localhost:${PORT}`);
});

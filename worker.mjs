const API_BASE = "https://premku.com/api/";
const MAX_BODY_BYTES = 8 * 1024;
const CHECKOUT_TTL_MS = 60 * 60 * 1000;

function jsonResponse(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function redact(message, env) {
  let safe = String(message || "");
  for (const secret of [env.PREMKU_API_KEY, env.PREMKU_API_SECRET]) {
    if (secret) safe = safe.replaceAll(secret, "[disembunyikan]");
  }
  return safe.slice(0, 240);
}

function apiError(error, env) {
  const status = error.statusCode;
  const detail = redact(error.message.replaceAll(/\s+/g, " "), env);
  if (status === 401 || status === 403) {
    return `Premku menolak akses (HTTP ${status}). Periksa API key/secret dan izin endpoint. ${detail}`;
  }
  if (error.name === "AbortError") return "Permintaan ke Premku melewati batas waktu. Coba lagi.";
  if (status) return `Premku mengembalikan HTTP ${status}. ${detail}`;
  return "Toko tidak dapat memproses permintaan. Silakan coba lagi.";
}

async function callPremku(env, endpoint, payload = {}) {
  if (!env.PREMKU_API_KEY) throw new Error("Premku API key belum dikonfigurasi.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(new URL(endpoint, API_BASE), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.PREMKU_API_KEY.trim(),
        ...(env.PREMKU_API_SECRET ? { api_secret: env.PREMKU_API_SECRET.trim() } : {}),
        ...payload
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = data && typeof data === "object"
        ? [data.message, data.error, data.msg].find(value => typeof value === "string" && value.trim())
        : "";
      const error = new Error(
        `Premku returned HTTP ${response.status}${message ? `: ${message}` : ""}.`
      );
      error.statusCode = response.status;
      throw error;
    }
    if (!data || typeof data !== "object") throw new Error("Premku returned an invalid response.");
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON request body."), { status: 400 });
  }
}

function validId(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function validQuantity(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 10;
}

function validToken(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function toCheckout(row) {
  if (!row) return null;
  return {
    token: row.token,
    productId: row.product_id,
    productName: row.product_name,
    quantity: row.quantity,
    total: row.total,
    paymentInvoice: row.payment_invoice,
    qrImage: row.qr_image,
    status: row.status,
    orderInvoice: row.order_invoice,
    accounts: row.accounts_json ? JSON.parse(row.accounts_json) : [],
    error: row.error_message || "",
    createdAt: row.created_at
  };
}

async function readCheckout(env, token) {
  if (!validToken(token)) return null;
  const row = await env.DB.prepare(
    "SELECT * FROM premium_checkouts WHERE token = ?"
  ).bind(token).first();
  return toCheckout(row);
}

async function saveCheckout(env, checkout) {
  await env.DB.prepare(`
    INSERT INTO premium_checkouts (
      token, product_id, product_name, quantity, total, payment_invoice,
      qr_image, status, order_invoice, accounts_json, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      status = excluded.status,
      order_invoice = excluded.order_invoice,
      accounts_json = excluded.accounts_json,
      error_message = excluded.error_message
  `).bind(
    checkout.token,
    checkout.productId,
    checkout.productName,
    checkout.quantity,
    checkout.total,
    checkout.paymentInvoice,
    checkout.qrImage,
    checkout.status,
    checkout.orderInvoice,
    JSON.stringify(checkout.accounts || []),
    checkout.error || "",
    checkout.createdAt
  ).run();
}

async function claimCheckout(env, token) {
  const result = await env.DB.prepare(`
    UPDATE premium_checkouts SET status = 'ordering'
    WHERE token = ? AND status = 'pending_payment'
  `).bind(token).run();
  return result.meta.changes === 1;
}

async function getProduct(env, productId) {
  const result = await callPremku(env, "products");
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

async function finishPaidOrder(env, checkout) {
  if (checkout.status !== "pending_payment") return checkout;

  const payment = await callPremku(env, "pay_status", { invoice: checkout.paymentInvoice });
  if (payment?.data?.status !== "success") {
    if (payment?.data?.status === "failed" || payment?.data?.status === "expired") {
      checkout.status = "failed";
      checkout.error = "Pembayaran gagal atau kedaluwarsa.";
      await saveCheckout(env, checkout);
    }
    return checkout;
  }

  if (!await claimCheckout(env, checkout.token)) return readCheckout(env, checkout.token);
  checkout.status = "ordering";

  let order;
  try {
    order = await callPremku(env, "order", {
      product_id: checkout.productId,
      qty: checkout.quantity
    });
  } catch (error) {
    checkout.status = "failed";
    checkout.error = `Pembayaran terdeteksi, tetapi order tidak dapat dibuat: ${redact(error.message, env)}`;
    await saveCheckout(env, checkout);
    return checkout;
  }

  if (!order.success || !order.invoice) {
    checkout.status = "failed";
    checkout.error = redact(order.message, env) ||
      "Pembayaran terdeteksi, tetapi Premku menolak order.";
  } else {
    checkout.status = "processing";
    checkout.orderInvoice = String(order.invoice);
  }
  await saveCheckout(env, checkout);
  return checkout;
}

function publicCheckout(checkout) {
  return {
    status: checkout.status,
    productName: checkout.productName,
    quantity: checkout.quantity,
    total: checkout.total,
    paymentInvoice: checkout.paymentInvoice,
    qrImage: checkout.qrImage,
    error: checkout.error || "",
    accounts: checkout.status === "success" ? checkout.accounts || [] : []
  };
}

async function handleApi(request, env, url) {
  if (request.method === "GET" && url.pathname === "/api/premium/health") {
    await env.DB.prepare("SELECT 1 AS ok").first();
    return jsonResponse({ ready: true });
  }

  if (request.method === "GET" && url.pathname === "/api/premium/products") {
    const result = await callPremku(env, "products");
    if (!Array.isArray(result.products)) {
      return jsonResponse({ error: result.message || "Daftar produk tidak tersedia." }, 502);
    }
    const products = result.products
      .map(safeProduct)
      .filter(product => product && Number.isSafeInteger(product.id) &&
        Number.isFinite(product.price) && Number.isFinite(product.stock) &&
        product.status === "available");
    return jsonResponse({ products });
  }

  if (request.method === "POST" && url.pathname === "/api/premium/checkout") {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        !validId(body.productId) || !validQuantity(body.quantity)) {
      return jsonResponse({ error: "Produk atau jumlah tidak valid. Maksimal 10 item." }, 400);
    }

    const product = await getProduct(env, body.productId);
    if (!product || product.status !== "available") {
      return jsonResponse({ error: "Produk tidak tersedia. Muat ulang katalog." }, 409);
    }
    const quantity = Number(body.quantity);
    const unitPrice = Number(product.price);
    const stock = Number(product.stock);
    const total = unitPrice * quantity;
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 1 ||
        !Number.isSafeInteger(stock) || stock < quantity || !Number.isSafeInteger(total)) {
      return jsonResponse({ error: "Stok atau harga produk tidak valid." }, 409);
    }

    const payment = await callPremku(env, "pay", { amount: total });
    const paymentData = payment.data;
    if (!payment.success || !paymentData?.invoice || !paymentData?.qr_image) {
      return jsonResponse({ error: payment.message || "Premku gagal membuat pembayaran." }, 502);
    }

    const token = [...crypto.getRandomValues(new Uint8Array(32))]
      .map(value => value.toString(16).padStart(2, "0")).join("");
    const checkout = {
      token,
      productId: Number(product.id),
      productName: String(product.name || "Aplikasi premium").slice(0, 160),
      quantity,
      total,
      paymentInvoice: String(paymentData.invoice),
      qrImage: String(paymentData.qr_image),
      status: "pending_payment",
      orderInvoice: "",
      accounts: [],
      error: "",
      createdAt: Date.now()
    };
    await saveCheckout(env, checkout);
    return jsonResponse({ checkoutToken: token, checkout: publicCheckout(checkout) }, 201);
  }

  if (request.method === "GET" && url.pathname === "/api/premium/checkout") {
    const token = url.searchParams.get("token");
    let checkout = await readCheckout(env, token);
    if (!checkout) return jsonResponse({ error: "Pesanan tidak ditemukan." }, 404);
    if (Date.now() - checkout.createdAt > CHECKOUT_TTL_MS &&
        checkout.status === "pending_payment") {
      checkout.status = "expired";
      checkout.error = "Batas waktu pembayaran telah berakhir.";
      await saveCheckout(env, checkout);
    } else if (checkout.status === "pending_payment") {
      checkout = await finishPaidOrder(env, checkout);
    } else if (checkout.status === "processing" && checkout.orderInvoice) {
      const order = await callPremku(env, "status", { invoice: checkout.orderInvoice });
      if (order.status === "success") {
        checkout.status = "success";
        checkout.accounts = Array.isArray(order.accounts) ? order.accounts : [];
        await saveCheckout(env, checkout);
      } else if (order.status === "failed") {
        checkout.status = "failed";
        checkout.error = order.message || "Order gagal diproses oleh Premku.";
        await saveCheckout(env, checkout);
      }
    }
    return jsonResponse({ checkout: publicCheckout(checkout) });
  }

  return jsonResponse({ error: "API route tidak ditemukan." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      return await handleApi(request, env, url);
    } catch (error) {
      console.error("Store API request failed:", redact(error.message, env));
      const status = error.statusCode || 502;
      return jsonResponse({
        error: error.statusCode ? redact(error.message, env) : apiError(error, env)
      }, status);
    }
  }
};

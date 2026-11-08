(() => {
  const catalog = document.getElementById("order-catalog");
  const refreshButton = document.getElementById("order-refresh");
  const securityTitle = document.getElementById("order-security-title");
  const securityMessage = document.getElementById("order-security-message");
  const checkoutPanel = document.getElementById("checkout-panel");
  const checkoutTitle = document.getElementById("checkout-title");
  const checkoutContent = document.getElementById("checkout-content");
  const closeCheckoutButton = document.getElementById("checkout-close");
  if (!catalog || !refreshButton || !checkoutPanel || !checkoutContent) return;

  const checkoutStorageKey = "premium-store-checkout";
  let loadingProducts = false;
  let startingCheckout = false;
  let pollingCheckout = false;
  let checkoutTimer = 0;
  let checkoutToken = "";

  function setStoreStatus(title, message, isError = false) {
    securityTitle.textContent = title;
    securityMessage.textContent = message;
    securityTitle.style.color = isError ? "#ffc0ca" : "";
  }

  function formatRupiah(value) {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0
    }).format(value);
  }

  async function apiRequest(url, options = {}) {
    let response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        ...options,
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...options.headers
        }
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error("Backend toko tidak dapat dihubungi. Jalankan situs melalui server toko.");
      }
      throw error;
    }

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data && typeof data.error === "string"
        ? data.error
        : `Permintaan gagal (HTTP ${response.status}).`);
    }
    if (!data || typeof data !== "object") throw new Error("Backend memberikan respons yang tidak valid.");
    return data;
  }

  function safeImageUrl(value) {
    if (typeof value !== "string") return "";
    if (/^https:\/\//i.test(value)) return value;
    if (/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value;
    return "";
  }

  function renderProducts(products) {
    catalog.replaceChildren();
    if (!products.length) {
      const empty = document.createElement("p");
      empty.className = "catalog-empty";
      empty.textContent = "Belum ada produk yang tersedia. Coba muat ulang beberapa saat lagi.";
      catalog.append(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "order-products";
    products.forEach(product => {
      const card = document.createElement("article");
      card.className = "order-product";
      if (product.image) {
        const imageUrl = safeImageUrl(product.image);
        if (imageUrl) {
          const image = document.createElement("img");
          image.className = "order-product-image";
          image.src = imageUrl;
          image.alt = "";
          image.loading = "lazy";
          image.referrerPolicy = "no-referrer";
          card.append(image);
        }
      }

      const name = document.createElement("h3");
      name.textContent = product.name;
      const description = document.createElement("p");
      description.className = "order-product-description";
      description.textContent = product.description || "Akun aplikasi premium siap diproses setelah pembayaran.";
      const meta = document.createElement("div");
      meta.className = "order-product-meta";
      const stock = document.createElement("span");
      stock.textContent = `Stok: ${product.stock}`;
      const price = document.createElement("strong");
      price.className = "order-product-price";
      price.textContent = formatRupiah(product.price);
      meta.append(stock, price);

      const buyButton = document.createElement("button");
      buyButton.type = "button";
      buyButton.className = "submit order-buy";
      buyButton.textContent = "Beli sekarang";
      buyButton.disabled = product.stock < 1;
      buyButton.addEventListener("click", () => startCheckout(product));
      card.append(name, description, meta, buyButton);
      grid.append(card);
    });
    catalog.append(grid);
  }

  async function loadProducts() {
    if (loadingProducts) return;
    loadingProducts = true;
    refreshButton.disabled = true;
    refreshButton.textContent = "Memuat...";
    if (window.location.protocol === "file:") {
      const message = "Halaman dibuka langsung sebagai file. Tutup tab ini, jalankan start-store.cmd, lalu buka http://localhost:3000.";
      const empty = document.createElement("p");
      empty.className = "catalog-empty";
      empty.textContent = message;
      catalog.replaceChildren(empty);
      setStoreStatus("Server toko belum berjalan", message, true);
      loadingProducts = false;
      refreshButton.disabled = false;
      refreshButton.textContent = "Muat ulang";
      return;
    }
    setStoreStatus("Memuat katalog", "Mengambil produk, stok, dan harga terbaru dari Premku.");
    try {
      const data = await apiRequest("/api/premium/products");
      if (!Array.isArray(data.products)) throw new Error("Katalog yang diterima tidak valid.");
      renderProducts(data.products);
      setStoreStatus("Toko terhubung", "Katalog, stok, dan harga diperbarui langsung dari Premku.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Terjadi kesalahan saat memuat katalog.";
      const empty = document.createElement("p");
      empty.className = "catalog-empty";
      empty.textContent = message;
      catalog.replaceChildren(empty);
      setStoreStatus("Toko belum terhubung", message, true);
    } finally {
      loadingProducts = false;
      refreshButton.disabled = false;
      refreshButton.textContent = "Muat ulang";
    }
  }

  function renderCheckoutState(checkout) {
    checkoutContent.replaceChildren();
    checkoutPanel.hidden = false;
    const itemSummary = document.createElement("p");
    itemSummary.className = "checkout-summary";
    itemSummary.textContent =
      `${checkout.productName} × ${checkout.quantity} · ${formatRupiah(checkout.total)}`;
    checkoutContent.append(itemSummary);

    const state = document.createElement("div");
    state.className = "checkout-state";
    const statusLabels = {
      pending_payment: "Menunggu pembayaran QRIS. Status akan diperiksa otomatis.",
      ordering: "Pembayaran terdeteksi. Mengirim order ke Premku...",
      processing: "Pembayaran berhasil. Premku sedang menyiapkan akun...",
      success: "Order berhasil. Detail akun tersedia di bawah.",
      failed: checkout.error || "Order tidak berhasil diproses. Silakan hubungi pengelola toko.",
      expired: checkout.error || "Batas waktu pembayaran telah berakhir."
    };
    state.textContent = statusLabels[checkout.status] || "Memeriksa status order...";
    if (checkout.status === "failed" || checkout.status === "expired") state.classList.add("error");

    if (checkout.qrImage && checkout.status === "pending_payment") {
      const imageUrl = safeImageUrl(checkout.qrImage);
      if (imageUrl) {
        const image = document.createElement("img");
        image.className = "checkout-qr";
        image.src = imageUrl;
        image.alt = "QR pembayaran";
        checkoutContent.append(image);
      }
    }
    checkoutContent.append(state);

    if (checkout.status === "success") {
      const accounts = Array.isArray(checkout.accounts) ? checkout.accounts : [];
      if (accounts.length) {
        const list = document.createElement("ul");
        list.className = "account-list";
        accounts.forEach(account => {
          const item = document.createElement("li");
          item.className = "account-item";
          if (typeof account === "string") {
            item.textContent = account;
          } else if (account && typeof account === "object" && !Array.isArray(account)) {
            const fields = [
              ["Email", account.username],
              ["Password", account.password],
              ["Info", account.extra]
            ].filter(([, value]) => value !== undefined && value !== null && value !== "");
            item.textContent = fields.length
              ? fields.map(([label, value]) => `${label}: ${String(value)}`).join("\n")
              : JSON.stringify(account, null, 2);
          } else {
            item.textContent = JSON.stringify(account, null, 2);
          }
          list.append(item);
        });
        checkoutContent.append(list);
      } else {
        const noAccount = document.createElement("p");
        noAccount.className = "checkout-summary";
        noAccount.textContent = "Order berhasil, tetapi Premku tidak mengirim detail akun pada respons.";
        checkoutContent.append(noAccount);
      }
    }

    if (checkout.status === "pending_payment" || checkout.status === "processing" || checkout.status === "ordering") {
      const checkButton = document.createElement("button");
      checkButton.type = "button";
      checkButton.className = "submit order-buy";
      checkButton.textContent = "Cek status sekarang";
      checkButton.addEventListener("click", pollCheckout);
      checkoutContent.append(checkButton);
    }

    if (["success", "failed", "expired"].includes(checkout.status)) {
      window.clearInterval(checkoutTimer);
      checkoutTimer = 0;
      window.sessionStorage.removeItem(checkoutStorageKey);
      checkoutToken = "";
    }
  }

  async function pollCheckout() {
    if (!checkoutToken || pollingCheckout) return;
    pollingCheckout = true;
    try {
      const data = await apiRequest(`/api/premium/checkout?token=${encodeURIComponent(checkoutToken)}`);
      if (!data.checkout || typeof data.checkout.status !== "string") {
        throw new Error("Status checkout tidak valid.");
      }
      renderCheckoutState(data.checkout);
      if (data.checkout.status === "failed" || data.checkout.status === "expired") {
        setStoreStatus("Order perlu ditindaklanjuti", data.checkout.error || "Periksa kembali pesanan Anda.", true);
      }
      if (data.checkout.status === "success") {
        setStoreStatus("Order berhasil", "Detail akun ditampilkan di panel pembayaran.");
        await loadProducts();
      }
    } catch (error) {
      const state = document.createElement("div");
      state.className = "checkout-state error";
      state.textContent = error instanceof Error ? error.message : "Gagal memeriksa status checkout.";
      checkoutContent.append(state);
    } finally {
      pollingCheckout = false;
    }
  }

  async function startCheckout(product) {
    if (startingCheckout) return;
    if (checkoutToken) {
      checkoutPanel.hidden = false;
      checkoutPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    startingCheckout = true;
    checkoutPanel.hidden = false;
    checkoutTitle.textContent = "Menyiapkan pembayaran";
    checkoutContent.replaceChildren();
    const state = document.createElement("div");
    state.className = "checkout-state";
    state.textContent = "Memeriksa harga dan stok terbaru, lalu membuat QR pembayaran...";
    checkoutContent.append(state);
    try {
      const data = await apiRequest("/api/premium/checkout", {
        method: "POST",
        body: JSON.stringify({ productId: product.id, quantity: 1 })
      });
      if (typeof data.checkoutToken !== "string" || !data.checkout) {
        throw new Error("Backend tidak mengembalikan informasi checkout.");
      }
      checkoutToken = data.checkoutToken;
      window.sessionStorage.setItem(checkoutStorageKey, checkoutToken);
      checkoutTitle.textContent = "Selesaikan pembayaran";
      renderCheckoutState(data.checkout);
      window.clearInterval(checkoutTimer);
      checkoutTimer = window.setInterval(pollCheckout, 5000);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tidak dapat membuat checkout.";
      state.className = "checkout-state error";
      state.textContent = message;
      setStoreStatus("Checkout gagal dibuat", message, true);
    } finally {
      startingCheckout = false;
    }
  }

  refreshButton.addEventListener("click", loadProducts);
  closeCheckoutButton.addEventListener("click", () => {
    checkoutPanel.hidden = true;
  });
  document.querySelectorAll('[data-go-page="order"]').forEach(button => {
    button.addEventListener("click", loadProducts);
  });

  const savedToken = window.sessionStorage.getItem(checkoutStorageKey);
  if (savedToken && /^[a-f0-9]{64}$/.test(savedToken)) {
    checkoutToken = savedToken;
    checkoutTitle.textContent = "Status pesanan";
    checkoutPanel.hidden = false;
    pollCheckout();
    checkoutTimer = window.setInterval(pollCheckout, 5000);
  }
})();

(() => {
  const shell = document.querySelector(".shell");
  const invite = document.getElementById("channel-invite");
  const inviteDialog = invite && invite.querySelector(".invite-dialog");
  const inviteClose = invite && invite.querySelector(".invite-close");
  const aboutPage = document.querySelector('[data-flow-page="about"]');
  const toolsPage = document.querySelector('[data-flow-page="tools"]');
  const orderPage = document.querySelector('[data-flow-page="order"]');
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const channelAudio = new Audio("https://files.catbox.moe/ah8kxt.mp3");
  channelAudio.preload = "none";

  if (!shell || !invite || !inviteDialog || !inviteClose || !aboutPage || !toolsPage || !orderPage) return;

  function showPage(pageName) {
    if (!["about", "tools", "order"].includes(pageName)) return;
    aboutPage.hidden = pageName !== "about";
    toolsPage.hidden = pageName !== "tools";
    orderPage.hidden = pageName !== "order";
    invite.hidden = true;
    shell.inert = false;
    shell.removeAttribute("aria-hidden");
    document.body.classList.remove("invite-open");
    document.body.dataset.currentPage = pageName;

    const page = pageName === "about" ? aboutPage : pageName === "tools" ? toolsPage : orderPage;
    const focusTarget = page.querySelector(pageName === "about" ? ".page-button" : ".back-link");
    if (focusTarget) focusTarget.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
  }

  document.querySelectorAll("[data-go-page]").forEach(button => {
    button.addEventListener("click", () => showPage(button.dataset.goPage));
  });

  document.querySelector(".brand").addEventListener("click", event => {
    event.preventDefault();
    showPage("about");
  });

  inviteClose.addEventListener("click", () => {
    const playback = channelAudio.play();
    if (playback) {
      playback.catch(error => console.warn("Audio saluran WhatsApp tidak dapat diputar.", error));
    }
    showPage("about");
  });
  invite.addEventListener("click", event => {
    if (event.target === invite) showPage("about");
  });
  document.addEventListener("keydown", event => {
    if (invite.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      showPage("about");
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [inviteClose, invite.querySelector(".invite-join")];
    if (event.shiftKey && document.activeElement === focusable[0]) {
      event.preventDefault();
      focusable[1].focus();
    } else if (!event.shiftKey && document.activeElement === focusable[1]) {
      event.preventDefault();
      focusable[0].focus();
    }
  });

  document.body.dataset.currentPage = "invite";
  document.body.classList.add("invite-open");
  invite.hidden = false;
  shell.inert = true;
  shell.setAttribute("aria-hidden", "true");
  inviteClose.focus();

  const revealItems = document.querySelectorAll(".portfolio-intro, .strengths-heading, .strength-card, .order-security-note");
  if ("IntersectionObserver" in window && !prefersReducedMotion) {
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.dataset.reveal = "visible";
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.16, rootMargin: "0px 0px -24px 0px" });

    revealItems.forEach(item => {
      item.dataset.reveal = "pending";
      revealObserver.observe(item);
    });
  }

  const card = document.querySelector(".app-card");
  if (!card || !window.matchMedia("(hover: hover) and (pointer: fine)").matches ||
      prefersReducedMotion) return;

  let targetX = 50;
  let targetY = 50;
  let currentX = targetX;
  let currentY = targetY;
  let frame = 0;

  function animateHighlight() {
    frame = 0;
    currentX += (targetX - currentX) * 0.14;
    currentY += (targetY - currentY) * 0.14;
    card.style.setProperty("--pointer-x", `${currentX.toFixed(2)}%`);
    card.style.setProperty("--pointer-y", `${currentY.toFixed(2)}%`);

    if (Math.abs(targetX - currentX) > 0.05 || Math.abs(targetY - currentY) > 0.05) {
      frame = requestAnimationFrame(animateHighlight);
    }
  }

  function scheduleAnimation() {
    if (!frame) frame = requestAnimationFrame(animateHighlight);
  }

  card.addEventListener("pointerenter", () => {
    card.dataset.pointerActive = "true";
  });

  card.addEventListener("pointermove", event => {
    const bounds = card.getBoundingClientRect();
    targetX = ((event.clientX - bounds.left) / bounds.width) * 100;
    targetY = ((event.clientY - bounds.top) / bounds.height) * 100;
    scheduleAnimation();
  });

  card.addEventListener("pointerleave", () => {
    card.dataset.pointerActive = "false";
    targetX = 50;
    targetY = 50;
    scheduleAnimation();
  });
})();

(function () {
  const nav = document.getElementById("nav");
  const lid = document.getElementById("lid");
  const fold = document.getElementById("fold");
  const angleValue = document.getElementById("angle-value");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const onScroll = () => {
    nav.classList.toggle("is-scrolled", window.scrollY > 12);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  const applyFold = (angle) => {
    const a = Math.min(180, Math.max(8, Number(angle)));
    const baseline = 100;
    const closed = 8;
    const foldAmt = a >= baseline ? 0 : (baseline - a) / (baseline - closed);
    const inset = (foldAmt * 11.5).toFixed(3);
    const blur = foldAmt < 0.08 ? 0 : foldAmt * 4.4;
    fold.style.clipPath = `polygon(${inset}% 0%, ${100 - inset}% 0%, 100% 100%, 0% 100%)`;
    fold.style.filter = `blur(${blur.toFixed(2)}px) brightness(${(1 - foldAmt * 0.18).toFixed(3)})`;
    if (!reduce) {
      fold.style.transform = `perspective(1400px) rotateX(${(foldAmt * 8).toFixed(2)}deg)`;
    }
    angleValue.textContent = `${Math.round(a)}°`;
    lid.value = String(Math.round(a));
  };

  applyFold(lid.value);
  lid.addEventListener("input", () => applyFold(lid.value));

  const scrollToId = (id, behavior) => {
    const el = document.getElementById(id);
    if (!el) return false;
    el.scrollIntoView({ behavior, block: "start" });
    return true;
  };

  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (event) => {
      const id = link.getAttribute("href").slice(1);
      if (!id || id === "content") return;
      event.preventDefault();
      scrollToId(id, reduce ? "auto" : "smooth");
      history.replaceState(null, "", `#${id}`);
    });
  });

  const initial = new URLSearchParams(location.search).get("section") || location.hash.slice(1);
  if (initial) {
    window.setTimeout(() => scrollToId(initial, "auto"), 50);
  }

  document.querySelectorAll("[data-sha]").forEach((hashEl) => {
    const url = hashEl.getAttribute("data-sha");
    if (!url) return;
    const label = url.split("/").pop().replace(/\.sha256$/, "");
    fetch(url)
      .then((res) => (res.ok ? res.text() : Promise.reject()))
      .then((text) => {
        const digest = text.trim().split(/\s+/)[0];
        if (!digest) return;
        hashEl.hidden = false;
        hashEl.textContent = `SHA-256  ${label}  ${digest}`;
      })
      .catch(() => {});
  });

  document.querySelectorAll(".copy").forEach((button) => {
    button.addEventListener("click", async () => {
      const text = button.getAttribute("data-copy") || "";
      try {
        await navigator.clipboard.writeText(text);
        const prev = button.textContent;
        button.textContent = "Copied";
        button.classList.add("is-copied");
        window.setTimeout(() => {
          button.textContent = prev;
          button.classList.remove("is-copied");
        }, 1400);
      } catch {
        button.textContent = "Select";
      }
    });
  });
})();

(function () {
  const nav = document.getElementById("nav");
  const lid = document.getElementById("lid");
  const fold = document.getElementById("fold");
  const frame = document.getElementById("laptop");
  const angleValue = document.getElementById("angle-value");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  const earth = document.getElementById("earth");

  if (earth && finePointer && !reduce) {
    const root = document.documentElement;
    let targetX = window.innerWidth * 0.5;
    let targetY = window.innerHeight * 0.62;
    let x = targetX;
    let y = targetY;
    let lit = false;

    const tick = () => {
      x += (targetX - x) * 0.14;
      y += (targetY - y) * 0.14;
      root.style.setProperty("--spot-x", `${x.toFixed(1)}px`);
      root.style.setProperty("--spot-y", `${y.toFixed(1)}px`);
      window.requestAnimationFrame(tick);
    };

    window.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
        targetX = event.clientX;
        targetY = event.clientY;
        if (!lit) {
          x = targetX;
          y = targetY;
          lit = true;
          earth.classList.add("is-lit");
          tick();
        }
      },
      { passive: true }
    );
  }

  const onScroll = () => {
    nav.classList.toggle("is-scrolled", window.scrollY > 16);
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

  if (!reduce && frame) {
    frame.addEventListener("pointermove", (event) => {
      const box = frame.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
      applyFold(100 - t * 92);
    });
  }

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

  const hashEl = document.getElementById("hash");
  if (hashEl) {
    fetch("downloads/hinge-gnome.zip.sha256")
      .then((res) => (res.ok ? res.text() : Promise.reject()))
      .then((text) => {
        const digest = text.trim().split(/\s+/)[0];
        if (!digest) return;
        hashEl.hidden = false;
        hashEl.textContent = `SHA-256  ${digest}`;
      })
      .catch(() => {});
  }

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

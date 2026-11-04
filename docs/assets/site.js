// Shared behaviour: nav shadow, reveal-on-scroll, copy buttons, card glow, typed terminals.
(() => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Theme: the stored choice wins, else the system's; the toggle flips the
  // resolved theme and stores it. The inline script in <head> did the same
  // before first paint, so this only keeps it current.
  const root = document.documentElement;
  const lightQuery = window.matchMedia("(prefers-color-scheme: light)");
  const storedTheme = () => { try { return localStorage.getItem("vinta-theme"); } catch { return null; } };
  const applyTheme = () => {
    const t = storedTheme();
    root.dataset.theme = t === "light" || t === "dark" ? t : lightQuery.matches ? "light" : "dark";
  };
  applyTheme();
  lightQuery.addEventListener("change", applyTheme);
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = root.dataset.theme === "light" ? "dark" : "light";
      try { localStorage.setItem("vinta-theme", next); } catch {}
      applyTheme();
    });
  });

  const nav = document.querySelector(".nav");
  const onScroll = () => nav && nav.classList.toggle("scrolled", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(btn.dataset.copy); } catch { return; }
      btn.classList.add("copied");
      const ico = btn.querySelector(".ico");
      const prev = ico ? ico.textContent : "";
      if (ico) ico.textContent = "✓";
      setTimeout(() => { btn.classList.remove("copied"); if (ico) ico.textContent = prev; }, 1400);
    });
  });

  document.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  });

  // Typed terminal. Each .term[data-script] holds JSON lines: {t:"cmd"|"out", s:"html", d:delay}.
  window.runTerminal = (el, lines, { loop = true } = {}) => {
    let stopped = false;
    const sleep = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
    const run = async () => {
      while (!stopped) {
        el.innerHTML = "";
        for (const line of lines) {
          if (stopped) return;
          const div = document.createElement("div");
          div.className = "ln show";
          el.appendChild(div);
          if (line.t === "cmd") {
            const p = document.createElement("span"); p.className = "p"; p.textContent = line.p || "$ ";
            const c = document.createElement("span"); c.className = "c";
            const cur = document.createElement("span"); cur.className = "cur";
            div.append(p, c, cur);
            await sleep(line.d ?? 350);
            for (const ch of line.s) { c.textContent += ch; await sleep(18 + Math.random() * 40); }
            await sleep(260);
            cur.remove();
          } else {
            div.classList.remove("show");
            div.innerHTML = line.s;
            await sleep(line.d ?? 120);
            div.classList.add("show");
          }
        }
        if (!loop) return;
        const cur = document.createElement("span"); cur.className = "cur";
        const end = document.createElement("div"); end.className = "ln show"; end.innerHTML = '<span class="p">$ </span>'; end.appendChild(cur);
        el.appendChild(end);
        await sleep(4200);
      }
    };
    run();
    return () => { stopped = true; };
  };

  document.querySelectorAll(".term[data-script]").forEach((el) => {
    const src = document.getElementById(el.dataset.script);
    if (!src) return;
    const lines = JSON.parse(src.textContent);
    const start = () => window.runTerminal(el, lines);
    const obs = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { start(); obs.disconnect(); } });
    obs.observe(el);
  });
})();

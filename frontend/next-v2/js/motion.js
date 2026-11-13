/* =============================================================================
   motion.js — 动效工具箱（原生实现，无第三方依赖）
   设计原则：
   - 所有动效都可以被 prefers-reduced-motion 关闭；
   - 只动 opacity / transform / 颜色，不动布局；
   - 进入视口才启动，离开不回收（原型场景足够轻）。
   ============================================================================= */

export const reducedMotion =
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const once = new WeakSet();

/** 让元素在进入视口时播放 [data-reveal] 过渡 */
export function initReveal(root = document) {
  const targets = [...root.querySelectorAll("[data-reveal]")].filter((el) => !once.has(el));
  if (!targets.length) return;

  if (reducedMotion || typeof IntersectionObserver !== "function") {
    targets.forEach((el) => el.classList.add("is-in"));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        el.classList.add("is-in");
        once.add(el);
        io.unobserve(el);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );
  targets.forEach((el) => io.observe(el));
}

/** 磁吸按钮：指针靠近时轻微吸附 */
export function initMagnetic(root = document) {
  if (reducedMotion || matchMedia("(hover: none)").matches) return;
  for (const el of root.querySelectorAll("[data-magnetic]")) {
    if (once.has(el)) continue;
    once.add(el);
    const strength = Number(el.dataset.magnetic) || 4;
    let frame = 0;
    const move = (event) => {
      const rect = el.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.transform = `translate(${x * strength * 2}px, ${y * strength}px)`;
      });
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      el.style.transform = "";
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("blur", leave);
  }
}

/** 光斑跟随：把鼠标位置写入 --mx / --my */
export function initSpotlight(root = document) {
  if (matchMedia("(hover: none)").matches) return;
  for (const el of root.querySelectorAll("[data-spotlight]")) {
    if (once.has(el)) continue;
    once.add(el);
    el.addEventListener("pointermove", (event) => {
      const rect = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${event.clientX - rect.left}px`);
      el.style.setProperty("--my", `${event.clientY - rect.top}px`);
    });
  }
}

/** 数字滚动 */
function animateNumber(el, to, { duration = 1100, decimals = 0, prefix = "", suffix = "" } = {}) {
  if (reducedMotion) {
    el.textContent = `${prefix}${to.toFixed(decimals)}${suffix}`;
    return;
  }
  const start = performance.now();
  const from = 0;
  const tick = (now) => {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = `${prefix}${(from + (to - from) * eased).toFixed(decimals)}${suffix}`;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** [data-count="92"] 进入视口时滚动到目标值 */
export function initCounters(root = document) {
  const targets = [...root.querySelectorAll("[data-count]")].filter((el) => !once.has(el));
  if (!targets.length) return;
  const run = (el) => {
    const to = Number(el.dataset.count) || 0;
    animateNumber(el, to, {
      decimals: Number(el.dataset.decimals) || 0,
      prefix: el.dataset.prefix || "",
      suffix: el.dataset.suffix || "",
    });
  };
  if (reducedMotion || typeof IntersectionObserver !== "function") {
    targets.forEach(run);
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        run(entry.target);
        once.add(entry.target);
        io.unobserve(entry.target);
      }
    },
    { threshold: 0.4 }
  );
  targets.forEach((el) => io.observe(el));
}

/** 让内联 SVG 线稿逐笔画出 */
export function drawLineArt(svg, { delay = 120 } = {}) {
  if (!svg) return;
  const shapes = svg.querySelectorAll("path, circle, line, ellipse, polyline, polygon");
  shapes.forEach((shape, index) => {
    shape.setAttribute("pathLength", "1");
    shape.style.setProperty("--d", String(Math.min(index, 22)));
  });
  if (reducedMotion) {
    svg.classList.add("is-drawn");
    return;
  }
  setTimeout(() => svg.classList.add("is-drawn"), delay);
}

/** 轻微视差：[data-parallax="0.08"] */
export function initParallax(root = document) {
  if (reducedMotion) return;
  const targets = [...root.querySelectorAll("[data-parallax]")].filter((el) => !once.has(el));
  if (!targets.length) return;
  targets.forEach((el) => once.add(el));
  let ticking = false;
  const update = () => {
    ticking = false;
    const viewport = window.innerHeight;
    for (const el of targets) {
      const rect = el.getBoundingClientRect();
      const speed = Number(el.dataset.parallax) || 0.08;
      const progress = (rect.top + rect.height / 2 - viewport / 2) / viewport;
      el.style.transform = `translate3d(0, ${(-progress * speed * 120).toFixed(2)}px, 0)`;
    }
  };
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  };
  update();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
}

/** 一次性进入视口回调 */
export function whenVisible(el, callback, { threshold = 0.25 } = {}) {
  if (!el) return;
  if (reducedMotion || typeof IntersectionObserver !== "function") {
    callback();
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.disconnect();
        callback();
      }
    },
    { threshold }
  );
  io.observe(el);
}

/** 章节分隔线在进入视口时从左往右画出 */
export function initRuleDraw(root = document) {
  const targets = [...root.querySelectorAll(".sec-head, [data-rule-draw]")].filter((el) => !once.has(el));
  if (!targets.length) return;
  targets.forEach((el) => once.add(el));
  if (reducedMotion || typeof IntersectionObserver !== "function") {
    targets.forEach((el) => el.classList.add("is-drawn"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-drawn");
        io.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.2 }
  );
  targets.forEach((el) => io.observe(el));
}

/** 指针位置写入 --pointer-x / --pointer-y，供少量局部光晕使用 */
export function initPointerGlow(root = document) {
  if (reducedMotion || matchMedia("(hover: none)").matches) return;
  const targets = [...root.querySelectorAll("[data-pointer-glow]")].filter((el) => !once.has(el));
  if (!targets.length) return;
  targets.forEach((el) => once.add(el));
  for (const el of targets) {
    el.addEventListener("pointermove", (event) => {
      const rect = el.getBoundingClientRect();
      el.style.setProperty("--pointer-x", `${((event.clientX - rect.left) / rect.width) * 100}%`);
      el.style.setProperty("--pointer-y", `${((event.clientY - rect.top) / rect.height) * 100}%`);
    });
  }
}

/** 视图统一初始化入口 */
export function initView(root) {
  initReveal(root);
  initMagnetic(root);
  initSpotlight(root);
  initCounters(root);
  initParallax(root);
  initRuleDraw(root);
  initPointerGlow(root);
}

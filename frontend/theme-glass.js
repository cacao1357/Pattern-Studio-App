/* Pattern Studio glass theme interactions: edge drawer + button ripple. */
const appView = document.getElementById("app-view");

if (appView) {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "drawer-handle";
  handle.setAttribute("aria-label", "收起侧边栏");
  handle.setAttribute("aria-expanded", "true");
  handle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  document.body.append(handle);

  const setClosed = (closed) => {
    appView.classList.toggle("drawer-closed", closed);
    document.body.classList.toggle("drawer-closed", closed);
    handle.setAttribute("aria-expanded", closed ? "false" : "true");
    handle.setAttribute("aria-label", closed ? "展开侧边栏" : "收起侧边栏");
  };

  handle.addEventListener("click", () => setClosed(!appView.classList.contains("drawer-closed")));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !appView.classList.contains("drawer-closed")) setClosed(true);
  });
}

// Lightweight ripple on real controls only; no layout changes.
document.addEventListener("pointerdown", (event) => {
  const target = event.target.closest(".btn, .side-nav-item, .rail-step, .icon-button");
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const ripple = document.createElement("span");
  ripple.className = "ps-ripple";
  ripple.style.left = (event.clientX - rect.left) + "px";
  ripple.style.top = (event.clientY - rect.top) + "px";
  if (getComputedStyle(target).position === "static") target.style.position = "relative";
  target.style.overflow = "hidden";
  target.append(ripple);
  window.setTimeout(() => ripple.remove(), 620);
}, { passive: true });

// Home module shortcuts reuse the existing view/stage/dialog handlers.
document.querySelectorAll("[data-home-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.homeAction;
    if (action === "review") {
      document.getElementById("open-dataset")?.click();
      return;
    }
    document.getElementById("side-nav-workspace")?.click();
    const stage = action === "extract" ? "1" : action === "lineart" ? "3" : "4";
    window.setTimeout(() => {
      document.querySelector('.rail-step[data-stage="' + stage + '"]')?.click();
    }, 0);
  });
});

// Keep the current stage and current nav item centered in their fixed sliders.
const railEl = document.querySelector(".rail");
const sideNavEl = document.querySelector(".side-nav");

function centerRail(behavior = "smooth") {
  if (!railEl) return;
  const active = railEl.querySelector('.rail-step[aria-current="step"]');
  if (!active) return;
  railEl.scrollTo({
    left: active.offsetLeft + active.offsetWidth / 2 - railEl.clientWidth / 2,
    behavior
  });
}

function centerSideNav(behavior = "smooth") {
  if (!sideNavEl) return;
  const active = sideNavEl.querySelector(".side-nav-item.is-active");
  if (!active) return;
  sideNavEl.scrollTo({
    top: active.offsetTop + active.offsetHeight / 2 - sideNavEl.clientHeight / 2,
    behavior
  });
}

if (railEl) {
  new MutationObserver(() => centerRail()).observe(railEl, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-current"]
  });
}

if (sideNavEl) {
  new MutationObserver(() => centerSideNav()).observe(sideNavEl, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class"]
  });
}

window.addEventListener("resize", () => {
  centerRail("auto");
  centerSideNav("auto");
}, { passive: true });

document.addEventListener("ps:viewchange", () => {
  requestAnimationFrame(() => {
    centerRail();
    centerSideNav();
  });
});

requestAnimationFrame(() => {
  centerRail("auto");
  centerSideNav("auto");
});

// Page wipe between views.
const pageWipe = document.createElement("div");
pageWipe.className = "ps-page-wipe";
pageWipe.setAttribute("aria-hidden", "true");
document.body.append(pageWipe);

let wipeTimer = 0;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

document.addEventListener("ps:viewchange", () => {
  if (reduceMotion) {
    pageWipe.classList.remove("is-wiping");
    return;
  }
  pageWipe.classList.remove("is-wiping");
  void pageWipe.offsetWidth;
  pageWipe.classList.add("is-wiping");
  window.clearTimeout(wipeTimer);
  wipeTimer = window.setTimeout(() => pageWipe.classList.remove("is-wiping"), 540);
});

// Magnetic home discs: the displacement is applied through CSS variables so
// hover lift and the magnetic pull can coexist.
document.querySelectorAll(".home-entry").forEach((entry) => {
  const disc = entry.querySelector(".home-disc");
  if (!disc) return;
  entry.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    const rect = disc.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    disc.style.setProperty("--magnet-x", Math.max(-6, Math.min(6, dx * .05)).toFixed(1) + "px");
    disc.style.setProperty("--magnet-y", Math.max(-6, Math.min(6, dy * .05)).toFixed(1) + "px");
  }, { passive: true });
  entry.addEventListener("pointerleave", () => {
    disc.style.setProperty("--magnet-x", "0px");
    disc.style.setProperty("--magnet-y", "0px");
  });
});

if (railEl) {
  railEl.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    railEl.scrollLeft += event.deltaY;
  }, { passive: false });
}

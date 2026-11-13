/* =============================================================================
   app.js — 外壳：路由、共享状态、视图挂载、状态条、提示、抽屉、命令面板。
   视图模块契约（js/views/*.js）：
     export default {
       id: "home",
       title: "首页",
       flush: false,                    // true：视图自己管理滚动
       render(state, api, params) {},   // 返回 HTML 字符串
       mount(root, state, api, params) {},
       unmount() {},
     }
   数据来自本机服务 /api/v1：服务状态、设置、会话资产在 store.js，
   视图自行通过 js/api.js 发起读写。界面仍是静态 HTML + ES Modules，无构建步骤。
   ============================================================================= */

import { injectIcons, icon } from "./icons.js";
import { STAGES } from "./data.js";
import { api as http } from "./api.js";
import { store } from "./store.js";
import { kindLabel, shortId, escapeHtml } from "./format.js";
import { initView } from "./motion.js";
import homeView from "./views/home.js";

const BRAND = "纹样工作台";

const ROUTES = {
  home: homeView,
  workbench: () => import("./views/workbench.js").then((m) => m.default),
  library: () => import("./views/library.js").then((m) => m.default),
  settings: () => import("./views/settings.js").then((m) => m.default),
  notes: () => import("./views/notes.js").then((m) => m.default),
};

const state = {
  route: "home",
  stage: 1,
  compare: false,
  zoom: "fit",
  tile: "2x2",
  brush: 24,
  cmdkOpen: false,
  uploading: false,
};

const api = {
  get state() {
    return state;
  },
  patch(partial) {
    Object.assign(state, partial);
    if (partial.stage) store.noteStage(partial.stage);
    renderView();
  },
  set(partial) {
    Object.assign(state, partial);
  },
  render() {
    renderView();
  },
  go(name, opts = {}) {
    const query = new URLSearchParams(opts.query || {}).toString();
    const hash = `#/${name}${query ? `?${query}` : ""}`;
    if (location.hash === hash) renderView();
    else location.hash = hash;
  },
  toast(message, kind = "info") {
    const stack = document.getElementById("toasts");
    if (!stack) return;
    const tone = kind === "warn" || kind === "done" ? kind : "info";
    const el = document.createElement("div");
    el.className = `toast toast--${tone}`;
    el.innerHTML = `${icon(tone === "warn" ? "alert" : tone === "done" ? "check" : "info")}<span>${message}</span>`;
    stack.append(el);
    setTimeout(() => {
      el.classList.add("is-out");
      setTimeout(() => el.remove(), 220);
    }, 2600);
  },
  icon,
  drawer: openDrawer,
  closeDrawer,
  store,
  http,
  version(id = null) {
    if (id) return store.assetById(id);
    return store.currentAsset();
  },
  stage(key = null) {
    return key ? STAGES.find((s) => s.key === key) : STAGES[state.stage - 1];
  },
  /** 让视图在数据更新后重绘当前路由（页内重绘，不播换页动画）。 */
  refresh() {
    renderView();
  },
};

/* ------------------------------------------------------------------ 路由 */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [name, query] = raw.split("?");
  const route = ROUTES[name] ? name : "home";
  return { route, params: new URLSearchParams(query || "") };
}

function applyParams(params) {
  const stage = Number(params.get("stage"));
  if (stage && STAGES[stage - 1]) {
    state.stage = stage;
    store.noteStage(stage);
  }
  const asset = params.get("asset");
  const image = params.get("image");
  if (asset) {
    // 从纹样库/首页带着具体资产进来：必须载入该资产及其同图来源，
    // 不能只改 currentAssetId（会话资产里可能还没有它）。
    // openAsset 在请求被更新的加载/会话取代时返回 null；此时不 refresh、不报错。
    store
      .openAsset(asset)
      .then((opened) => {
        if (opened) api.refresh();
      })
      .catch((error) => api.toast(error?.message || "载入资产失败", "warn"));
  } else if (image) {
    store
      .ensureSession(image)
      .then((session) => {
        if (session) api.refresh();
      })
      .catch((error) => api.toast(error?.message || "载入纹样失败", "warn"));
  }
  if (params.has("compare")) state.compare = params.get("compare") !== "0";
  const tile = params.get("tile");
  if (tile === "2x2" || tile === "3x3") state.tile = tile;
  const open = params.get("open");
  if (open) store.library.openId = open;
}

async function resolveView(route) {
  const entry = ROUTES[route];
  return typeof entry === "function" && !entry.id ? entry() : entry;
}

function syncNav(route) {
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

/* ------------------------------------------------------------------ 外壳渲染 */

function renderStatusbar() {
  const bar = document.getElementById("statusbar");
  if (!bar) return;
  const stage = STAGES[state.stage - 1] || STAGES[0];
  const health = store.health;
  const online = Boolean(health && health.status === "ok");
  const asset = store.currentAsset();
  const imageId = store.session.imageId;
  const cloud = store.seedream?.enabled ? "云端已连接" : "云端未配置";
  const isWorkbench = state.route === "workbench";
  const datasetTotal = store.dataset?.total_images;
  bar.innerHTML = `
    <span class="statusbar__item" title="${online ? "数据库、存储与后台任务均正常" : escapeHtml(store.healthError || "尚未连接本机服务")}">
      <span class="svc__dot${online ? "" : " is-off"}" aria-hidden="true"></span>${online ? "本机服务正常" : "本机服务未连接"}
    </span>
    <span class="statusbar__item statusbar__item--hide-sm">${imageId ? "#" + shortId(imageId) : "未打开纹样"}</span>
    ${
      isWorkbench
        ? `<span class="statusbar__item"><span class="accent">工序 ${stage.n}</span> ${stage.name}</span>
           ${asset ? `<span class="statusbar__item"><span class="accent">${kindLabel(asset.kind)}</span> ${shortId(asset.asset_id)}</span>` : ""}`
        : `<span class="statusbar__item statusbar__item--hide-sm">数据集 ${datasetTotal ?? "—"} 张</span>
           <span class="statusbar__item statusbar__item--hide-sm">最近 ${store.recentAssets.length} 项成果</span>`
    }
    <span class="statusbar__item statusbar__item--hide-sm">${cloud}</span>
    <span class="statusbar__item statusbar__item--grow"></span>
    ${
      isWorkbench
        ? `<span class="statusbar__item statusbar__item--hide-sm"><span class="statusbar__key">1</span>–<span class="statusbar__key">7</span> 工序</span>
           <span class="statusbar__item statusbar__item--hide-sm"><span class="statusbar__key">[</span><span class="statusbar__key">]</span> 资产</span>
           <span class="statusbar__item"><span class="statusbar__key">C</span> 对比</span>`
        : `<span class="statusbar__item statusbar__item--hide-sm"><span class="statusbar__key">Ctrl</span> <span class="statusbar__key">K</span> 命令面板</span>`
    }
  `;
}


let currentView = null;
let lastHash = null;
let paintedRoute = null;

function renderView() {
  const { route, params } = parseHash();
  const hash = location.hash || "#/home";
  if (hash !== lastHash) {
    lastHash = hash;
    applyParams(params);
  }
  state.route = route;
  syncNav(route);
  renderStatusbar();

  // 只有换页才做入场过渡；同一页内的局部重绘（切工序、改参数、筛选等）
  // 直接换掉内容，避免整页淡入/闪动反复打断注意力。
  // 用路由名而不是完整 hash 判断：抽屉关闭等操作会用 replaceState 清理查询串，
  // 那不属于换页，不应再播一次过渡。
  const nav = route !== paintedRoute;
  paintedRoute = route;

  const paint = async () => {
    const view = await resolveView(route);
    if (!view) return;
    const host = document.getElementById("view");
    if (!host) return;
    if (currentView && currentView.unmount) currentView.unmount();
    currentView = view;
    document.title = view.id === "home" ? BRAND : `${view.title} · ${BRAND}`;
    host.className = `view${view.flush ? " view--flush" : ""}`;
    host.classList.toggle("is-repaint", !nav);
    host.innerHTML = `<div class="view-enter">${view.render(state, api, params)}</div>`;
    if (view.mount) view.mount(host, state, api, params);
    initView(host);
    closeDrawer();
    closeCmdk();
  };

  const progress = document.getElementById("route-progress");
  if (nav && progress) {
    progress.classList.remove("is-running");
    void progress.offsetWidth;
    progress.classList.add("is-running");
  }

  if (nav && !reducedMotionSafe() && document.startViewTransition) {
    const transition = document.startViewTransition(paint);
    // 快速连点导航或窗口尺寸变化会打断过渡，浏览器会 reject 这两个 Promise；
    // 这里吞掉即可，下一帧的 paint 仍会正常执行。
    transition.ready?.catch(() => {});
    transition.finished?.catch(() => {});
  } else {
    paint();
  }

  if (route !== "workbench") window.scrollTo(0, 0);
}

const reducedMotionSafe = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------------ 抽屉 */

let drawerKeyHandler = null;
let drawerReturnFocus = null;

export function openDrawer({ title, meta = "", body }) {
  closeDrawer();
  const el = document.createElement("aside");
  el.className = "drawer";
  el.id = "drawer";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", title);
  el.tabIndex = -1;
  el.innerHTML = `
    <header class="drawer__head">
      <div>
        <h2 class="section-title" style="font-size:22px">${title}</h2>
        ${meta ? `<p class="mono" style="margin-top:6px">${meta}</p>` : ""}
      </div>
      <button class="icon-btn" type="button" data-drawer-close aria-label="关闭">${icon("close")}</button>
    </header>
    <div class="drawer__body">${body}</div>
  `;
  el.querySelector("[data-drawer-close]").addEventListener("click", closeDrawer);
  document.querySelector(".app")?.append(el);
  drawerReturnFocus = document.activeElement;
  el.focus({ preventScroll: true });
  drawerKeyHandler = (event) => {
    if (event.key === "Escape") {
      closeDrawer();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = [...el.querySelectorAll("a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
      (node) => node.offsetParent !== null
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === el)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", drawerKeyHandler);
  return el;
}

export function closeDrawer() {
  const el = document.getElementById("drawer");
  const wasOpen = Boolean(el);
  el?.remove();
  if (drawerKeyHandler) document.removeEventListener("keydown", drawerKeyHandler);
  drawerKeyHandler = null;
  if (wasOpen && drawerReturnFocus && drawerReturnFocus.isConnected) {
    drawerReturnFocus.focus({ preventScroll: true });
  }
  drawerReturnFocus = null;
}

/* ------------------------------------------------------------------ 命令面板 */

const COMMANDS = [
  { group: "页面", label: "首页", hint: "", icon: "home", run: () => api.go("home") },
  { group: "页面", label: "工作台", hint: "", icon: "grid", run: () => api.go("workbench") },
  { group: "页面", label: "纹样库", hint: "", icon: "layers", run: () => api.go("library") },
  { group: "页面", label: "设置", hint: "", icon: "gear", run: () => api.go("settings") },
  { group: "页面", label: "使用说明", hint: "", icon: "file", run: () => api.go("notes") },
  ...STAGES.map((stage, index) => ({
    group: "工序",
    label: `第 ${index + 1} 道 · ${stage.name} · ${stage.title}`,
    hint: String(index + 1),
    icon: ["image", "crop", "flask", "layers", "mask", "brush", "tile"][index],
    run: () => api.go("workbench", { query: { stage: index + 1 } }),
  })),
  { group: "操作", label: "七道工序导览", hint: "", icon: "play", run: () => api.go("home", { query: { tour: 1 } }) },
  { group: "操作", label: "上传纹样", hint: "", icon: "upload", run: () => pickUpload() },
  { group: "操作", label: "对比原图与当前资产", hint: "C", icon: "compare", run: () => api.go("workbench", { query: { compare: 1 } }) },
  { group: "操作", label: "平铺 2 × 2", hint: "", icon: "tile", run: () => api.go("workbench", { query: { stage: 7, tile: "2x2" } }) },
  { group: "操作", label: "平铺 3 × 3", hint: "", icon: "tile", run: () => api.go("workbench", { query: { stage: 7, tile: "3x3" } }) },
  { group: "操作", label: "打包导出", hint: "", icon: "download", run: () => api.go("workbench", { query: { stage: 7 } }) },
];

let cmdkItems = [];
let cmdkIndex = 0;
let cmdkReturnFocus = null;

function openCmdk() {
  const el = document.getElementById("cmdk");
  const input = document.getElementById("cmdk-input");
  if (!el) return;
  cmdkReturnFocus = document.activeElement;
  el.classList.add("is-open");
  el.setAttribute("aria-hidden", "false");
  input.value = "";
  renderCmdk("");
  setTimeout(() => input.focus(), 30);
}

function closeCmdk() {
  const el = document.getElementById("cmdk");
  if (!el) return;
  const wasOpen = el.classList.contains("is-open");
  el.classList.remove("is-open");
  el.setAttribute("aria-hidden", "true");
  if (wasOpen && cmdkReturnFocus && cmdkReturnFocus.isConnected) {
    cmdkReturnFocus.focus({ preventScroll: true });
  }
  cmdkReturnFocus = null;
}

function renderCmdk(query) {
  const list = document.getElementById("cmdk-list");
  if (!list) return;
  const q = query.trim().toLowerCase();
  cmdkItems = COMMANDS.filter((c) => !q || `${c.group} ${c.label} ${c.hint}`.toLowerCase().includes(q));
  cmdkIndex = 0;
  if (!cmdkItems.length) {
    list.innerHTML = `<p class="cmdk__empty">没有匹配的命令</p>`;
    return;
  }
  const groups = new Map();
  cmdkItems.forEach((item) => {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  });
  let html = "";
  for (const [group, items] of groups) {
    html += `<p class="cmdk__group-label">${group}</p>`;
    for (const item of items) {
      const index = cmdkItems.indexOf(item);
      html += `<button class="cmdk__item${index === 0 ? " is-active" : ""}" type="button" data-cmdk-index="${index}">
        ${icon(item.icon)}
        <span>${item.label}</span>
        ${item.hint ? `<span class="cmdk__hint">${item.hint}</span>` : ""}
      </button>`;
    }
  }
  list.innerHTML = html;
  list.querySelectorAll("[data-cmdk-index]").forEach((btn) => {
    btn.addEventListener("click", () => runCmdk(Number(btn.dataset.cmdkIndex)));
    btn.addEventListener("pointermove", () => setCmdkActive(Number(btn.dataset.cmdkIndex)));
  });
}

function setCmdkActive(index) {
  const list = document.getElementById("cmdk-list");
  if (!list) return;
  cmdkIndex = (index + cmdkItems.length) % cmdkItems.length;
  list.querySelectorAll("[data-cmdk-index]").forEach((btn) => {
    btn.classList.toggle("is-active", Number(btn.dataset.cmdkIndex) === cmdkIndex);
  });
  list.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
}

function runCmdk(index) {
  const item = cmdkItems[index];
  if (!item) return;
  closeCmdk();
  item.run();
}

/* ------------------------------------------------------------------ 上传 */

function pickUpload() {
  if (state.uploading) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) uploadFile(file);
  });
  input.click();
}

async function uploadFile(file) {
  state.uploading = true;
  const button = document.querySelector('[data-action="upload"]');
  if (button) {
    button.disabled = true;
    button.classList.add("is-busy");
  }
  api.toast(`正在上传 ${file.name}…`, "info");
  try {
    // store 在上传请求发出前就捕获会话归属：上传期间切到别的会话时，
    // 晚到的上传结果不再发布、也不导航，避免抢回用户已打开的会话。
    const { result, session } = await store.uploadToSession(file);
    if (!session) {
      store.loadRecent();
      api.toast("已上传，但会话已切换，未自动打开这张纹样；可在纹样库中重新进入。", "warn");
      return;
    }
    const grade = result.original?.grade ? `等级 ${result.original.grade}` : "已登记";
    const duplicates = Array.isArray(result.duplicates) ? result.duplicates.length : 0;
    api.toast(
      `已上传：${result.original?.width || "—"} × ${result.original?.height || "—"}，${grade}${duplicates ? `；发现 ${duplicates} 个近似版本` : ""}`,
      "done"
    );
    store.loadRecent();
    api.go("workbench", { query: { image: result.image_id, stage: 1 } });
  } catch (error) {
    api.toast(error?.message || "上传失败，请稍后重试", "warn");
  } finally {
    state.uploading = false;
    if (button) {
      button.disabled = false;
      button.classList.remove("is-busy");
    }
  }
}

function renderServiceChip() {
  const chip = document.querySelector(".svc");
  if (!chip) return;
  const online = store.health?.status === "ok";
  chip.classList.toggle("is-off", !online);
  chip.innerHTML = `<span class="svc__dot${online ? "" : " is-off"}" aria-hidden="true"></span>${online ? "本机服务就绪" : "本机服务未连接"}`;
  chip.title = online ? "数据库、存储与后台任务均正常" : store.healthError || "尚未连接本机服务";
}

/* ------------------------------------------------------------------ 外壳事件 */

function bindShell() {
  document.querySelector('[data-action="notes"]')?.addEventListener("click", () => api.go("notes"));
  document.querySelector('[data-action="upload"]')?.addEventListener("click", pickUpload);
  document.querySelector("[data-open-cmdk]")?.addEventListener("click", openCmdk);

  const topbar = document.getElementById("topbar");
  const onScroll = () => topbar?.classList.toggle("is-stuck", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  window.addEventListener("hashchange", renderView);

  document.getElementById("cmdk")?.addEventListener("click", (event) => {
    if (event.target.id === "cmdk") closeCmdk();
  });
  document.getElementById("cmdk-input")?.addEventListener("input", (event) => renderCmdk(event.target.value));
  document.getElementById("cmdk-input")?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCmdkActive(cmdkIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCmdkActive(cmdkIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runCmdk(cmdkIndex);
    }
  });

  window.addEventListener("keydown", (event) => {
    const tag = event.target?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (document.getElementById("cmdk")?.classList.contains("is-open")) closeCmdk();
      else openCmdk();
      return;
    }
    if (event.key === "Escape") {
      closeCmdk();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

    if (state.route !== "workbench") return;
    if (/^[1-7]$/.test(event.key)) {
      api.patch({ stage: Number(event.key) });
    } else if (event.key === "[") {
      cycleAsset(-1);
    } else if (event.key === "]") {
      cycleAsset(1);
    } else if (event.key.toLowerCase() === "c") {
      api.patch({ compare: !state.compare });
    }
  });
}

function cycleAsset(delta) {
  const assets = store.session.assets;
  if (!assets.length) return;
  const index = assets.findIndex((asset) => asset.asset_id === store.session.currentAssetId);
  const next = assets[(index + delta + assets.length) % assets.length];
  if (!next || next.asset_id === store.session.currentAssetId) return;
  store.setCurrentAsset(next.asset_id);
  api.refresh();
}

export function boot() {
  injectIcons();
  bindShell();
  store.subscribe(() => {
    renderStatusbar();
    renderServiceChip();
  });
  store.loadHealth();
  store.loadSettings();
  store.loadRecent();
  // 30 秒轮询只刷新 health（含 lineart_model 前置能力）；不重载设置，
  // 也不触碰工作台里的用户参数；能力读取失败时 store 保留上一次已知值。
  window.setInterval(() => store.loadHealth(), 30000);
  renderView();
}

boot();
export { api as app, state };


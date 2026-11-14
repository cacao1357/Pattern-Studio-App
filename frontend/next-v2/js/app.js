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
import { STAGES, resolveStage } from "./data.js";
import { api as http } from "./api.js";
import { store } from "./store.js";
import { kindLabel, shortId, escapeHtml } from "./format.js";
import { initView } from "./motion.js";
import homeView from "./views/home.js";

const BRAND = "纹样工作台";

const ROUTES = {
  home: homeView,
  workbench: () => import("./views/workbench.js").then((m) => m.default),
  tasks: () => import("./views/tasks.js").then((m) => m.default),
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
  /** 最近一次深链目标载入失败：{ image, asset, message }；工作台据此立即显示错误。 */
  targetError: null,
};

const api = {
  get state() {
    return state;
  },
  patch(partial) {
    Object.assign(state, partial);
    if (partial.stage) store.noteStage(partial.stage);
    renderView();
    syncWorkbenchUrl();
  },
  syncUrl() {
    syncWorkbenchUrl();
  },
  set(partial) {
    Object.assign(state, partial);
  },
  /**
   * 清除“已处理的深链目标”。会话被清空后，同一个 URL 目标不再是已载入状态；
   * 只清 targetError 不够，因为 shouldLoadTarget 会误以为上次已经打开过。
   */
  resetTarget() {
    lastAppliedTarget = null;
    lastHash = null;
  },
  render() {
    renderView();
  },
  go(name, opts = {}) {
    const query = new URLSearchParams(opts.query || {});
    // 新工序编号与旧深链共用 stage 参数：站内跳转带上 v=2，旧链接（没有 v）
    // 仍按 data.js 的 LEGACY_STAGE_ALIAS 落到对应工序。
    if (query.has("stage") && !query.has("v")) query.set("v", "2");
    const hash = `#/${name}${query.toString() ? `?${query}` : ""}`;
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
    return el;
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

/**
 * 只有 URL 的 image/asset 是“要载入的目标”；stage/compare/tile 只是同一目标上的
 * 展示参数，不能触发 openAsset（那会 sessionEpoch++ 并 blankSession）。
 */
export function loadTarget(params) {
  return {
    image: params.get("image") || "",
    asset: params.get("asset") || "",
  };
}

/**
 * 判断本次 hash 变化是否需要重建会话。
 * - previous 是上一次实际处理的 URL 目标，不是 currentAssetId：用户新产物被设为
 *   当前后，URL 仍可能指原输入，切工序必须保留新产物。
 * - asset 仍是同一个就不重开；URL 只去掉 asset、image 未变也不重置。
 * - 没有 image/asset 的站内导航（纯 stage/compare/tile）不加载。
 */
export function shouldLoadTarget(next, previous, session = null) {
  if (!next || (!next.asset && !next.image)) return false;
  // 会话已被清空时，即使 URL 目标与上次相同也必须重新载入：lastAppliedTarget
  // 只说明“上次处理过这个 URL”，不说明对应会话还在内存里。
  if (session && !session.imageId && !(Array.isArray(session.assets) && session.assets.length)) return true;
  if (!previous) return true;
  if (next.asset) {
    if (next.asset !== previous.asset) return true;
    // 同一资产但 URL 明确换了图片：按新目标打开，避免跨图错配。
    return Boolean(next.image && previous.image && next.image !== previous.image);
  }
  if (!next.image) return false;
  if (!previous.asset) return next.image !== previous.image;
  // 只把 asset 查询参数去掉、图片没变：保留当前会话与已选层。
  return next.image !== previous.image;
}

let lastAppliedTarget = null;

/** 深链目标不存在时给用户看得懂的话，而不是 404/422 的接口措辞。 */
function targetErrorMessage(error, kind) {
  if (error?.status === 404 || error?.status === 422) {
    return kind === "asset"
      ? "没有找到这个资产，链接可能已失效。"
      : "没有找到这张纹样，链接可能已失效。";
  }
  return error?.message || (kind === "asset" ? "载入资产失败。" : "载入纹样失败。");
}

function applyParams(params, route) {
  const stage = resolveStage(params.get("stage"), params.get("v"));
  if (stage) {
    state.stage = stage;
    store.noteStage(stage);
  }
  const target = loadTarget(params);
  if (shouldLoadTarget(target, lastAppliedTarget, store.session)) {
    const previousTarget = lastAppliedTarget;
    lastAppliedTarget = target;
    state.targetError = null;
    if (target.asset) {
      // 从纹样库/首页带着具体资产进来：必须载入该资产及其同图来源，
      // 不能只改 currentAssetId（会话资产里可能还没有它）。
      // openAsset 在请求被更新的加载/会话取代时返回 null；此时不 refresh、不报错。
      store
        .openAsset(target.asset)
        .then((opened) => {
          if (opened) api.refresh();
        })
        .catch((error) => {
          // 真正失败时允许下一次 hash 变化重试；成功的会话不在这里重置。
          if (lastAppliedTarget === target) lastAppliedTarget = previousTarget;
          api.toast(targetErrorMessage(error, "asset"), "warn");
        });
    } else {
      store
        .ensureSession(target.image)
        .then((session) => {
          if (session) {
            state.targetError = null;
            api.refresh();
          }
        })
        .catch((error) => {
          if (lastAppliedTarget === target) lastAppliedTarget = previousTarget;
          const message = targetErrorMessage(error, "image");
          state.targetError = { image: target.image, asset: "", message };
          api.toast(message, "warn");
          // 立即重绘工作台：render() 会读取 targetError 并把加载态换成错误态。
          api.refresh();
        });
    }
  }
  if (params.has("compare")) state.compare = params.get("compare") !== "0";
  const tile = params.get("tile");
  if (tile === "2x2" || tile === "3x3") state.tile = tile;
  const open = params.get("open");
  // 只有纹样库的 ?open= 才应该打开档案抽屉；其它路由上带这个参数不能留给下一次进库。
  if (open && route === "library") store.library.openId = open;
}

async function resolveView(route) {
  const entry = ROUTES[route];
  return typeof entry === "function" && !entry.id ? entry() : entry;
}

/**
 * 工作台内的工序/资产/对比/平铺变化同步回地址栏。
 * 用 replaceState 不产生历史记录；同时更新 lastHash，避免下一次重绘把这次
 * 同步当成新的深链再载入一遍。
 */
function syncWorkbenchUrl() {
  if (state.route !== "workbench") return;
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  if (store.session.imageId) params.set("image", store.session.imageId);
  else params.delete("image");
  if (store.session.currentAssetId) params.set("asset", store.session.currentAssetId);
  else params.delete("asset");
  params.set("stage", String(state.stage || 1));
  params.set("v", "2");
  if (state.compare) params.set("compare", "1");
  else params.delete("compare");
  if (state.tile === "3x3") params.set("tile", "3x3");
  else params.delete("tile");
  const next = `#/workbench?${params.toString()}`;
  if (location.hash !== next) {
    history.replaceState(null, "", next);
    lastHash = next;
  }
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
  const cloud = store.seedream?.enabled ? "云端已连接" : "云端未配置";
  const isWorkbench = state.route === "workbench";
  bar.innerHTML = `
    <span class="statusbar__item" title="${online ? "数据库、存储与后台任务均正常" : escapeHtml(store.healthError || "尚未连接本机服务")}">
      <span class="svc__dot${online ? "" : " is-off"}" aria-hidden="true"></span>${online ? "本机服务正常" : "本机服务未连接"}
    </span>
    ${
      isWorkbench
        ? `<span class="statusbar__item"><span class="accent">工序 ${stage.n}</span> ${stage.name}</span>
           ${asset ? `<span class="statusbar__item">${kindLabel(asset.kind)}</span>` : ""}`
        : ""
    }
    <span class="statusbar__item statusbar__item--hide-sm">${cloud}</span>
    <span class="statusbar__item statusbar__item--grow"></span>
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
    applyParams(params, route);
  }
  state.route = route;
  syncNav(route);
  renderStatusbar();

  // 只有换页才做入场过渡；同一页内的局部重绘（切工序、改参数、筛选等）
  // 直接换掉内容，避免整页淡入/闪动反复打断注意力。
  // 用路由名而不是完整 hash 判断：抽屉关闭等操作会用 replaceState 清理查询串，
  // 那不属于换页，不应再播一次过渡。
  const nav = route !== paintedRoute;
  const firstPaint = paintedRoute === null;
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
    // 换页后把焦点交给主内容（#view 自带 tabindex="-1"），
    // 读屏与键盘用户才会从新页面开始；首屏加载不抢焦点。
    if (nav && !firstPaint) host.focus({ preventScroll: true });
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
  { group: "页面", label: "任务", hint: "", icon: "history", run: () => api.go("tasks") },
  { group: "页面", label: "纹样库", hint: "", icon: "layers", run: () => api.go("library") },
  { group: "页面", label: "设置", hint: "", icon: "gear", run: () => api.go("settings") },
  { group: "页面", label: "使用说明", hint: "", icon: "file", run: () => api.go("notes") },
  ...STAGES.map((stage, index) => ({
    group: "工序",
    label: `第 ${index + 1} 道 · ${stage.name} · ${stage.title}`,
    hint: String(index + 1),
    icon: ["image", "crop", "brush", "layers", "flask", "mask", "spark", "tile"][index],
    run: () => api.go("workbench", { query: { stage: index + 1 } }),
  })),
  { group: "操作", label: "八道工序导览", hint: "", icon: "play", run: () => api.go("home", { query: { tour: 1 } }) },
  { group: "操作", label: "上传纹样", hint: "", icon: "upload", run: () => pickUpload() },
  { group: "操作", label: "对比原图与当前资产", hint: "C", icon: "compare", run: () => api.go("workbench", { query: { compare: 1 } }) },
  { group: "操作", label: "平铺 2 × 2", hint: "", icon: "tile", run: () => api.go("workbench", { query: { stage: 8, tile: "2x2" } }) },
  { group: "操作", label: "平铺 3 × 3", hint: "", icon: "tile", run: () => api.go("workbench", { query: { stage: 8, tile: "3x3" } }) },
  { group: "操作", label: "打包导出", hint: "", icon: "download", run: () => api.go("workbench", { query: { stage: 8 } }) },
];

let cmdkItems = [];
let cmdkIndex = 0;
let cmdkReturnFocus = null;
let cmdkKeyHandler = null;

function openCmdk() {
  const el = document.getElementById("cmdk");
  const input = document.getElementById("cmdk-input");
  if (!el) return;
  if (el.classList.contains("is-open")) return;
  cmdkReturnFocus = document.activeElement;
  el.classList.add("is-open");
  el.setAttribute("aria-hidden", "false");
  input.value = "";
  renderCmdk("");
  // aria-modal 不会自动困住焦点；Tab / Shift+Tab 必须在面板内循环。
  cmdkKeyHandler = (event) => {
    if (event.key !== "Tab") return;
    const focusables = [...el.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((node) => node.offsetParent !== null);
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
  document.addEventListener("keydown", cmdkKeyHandler);
  setTimeout(() => input.focus(), 30);
}

function closeCmdk() {
  const el = document.getElementById("cmdk");
  if (!el) return;
  const wasOpen = el.classList.contains("is-open");
  if (cmdkKeyHandler) document.removeEventListener("keydown", cmdkKeyHandler);
  cmdkKeyHandler = null;
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
  const progressToast = api.toast(`正在上传 ${file.name}…`, "info");
  try {
    // store 在上传请求发出前就捕获会话归属：上传期间切到别的会话时，
    // 晚到的上传结果不再发布、也不导航，避免抢回用户已打开的会话。
    const { result, session } = await store.uploadToSession(file);
    progressToast?.remove();
    if (!session) {
      store.loadRecent();
      api.toast("已上传，但会话已切换，未自动打开这张纹样；可在纹样库中重新进入。", "warn");
      return;
    }
    const grade = result.original?.grade ? `等级 ${result.original.grade}` : "已登记";
    const duplicates = Array.isArray(result.duplicates)
      ? result.duplicates.filter((entry) => entry && entry.image_id)
      : [];
    store.loadRecent();
    if (duplicates.length) {
      // 抽屉自己说明“上传已保留”和近似版本，避免成功 toast 压住底部操作。
      showDuplicateDrawer(result, duplicates, api);
      return;
    }
    api.toast(
      `已上传：${result.original?.width || "—"} × ${result.original?.height || "—"}，${grade}`,
      "done"
    );
    api.go("workbench", { query: { image: result.image_id, stage: 1 } });
  } catch (error) {
    progressToast?.remove();
    api.toast(error?.message || "上传失败，请稍后重试", "warn");
  } finally {
    state.uploading = false;
    if (button) {
      button.disabled = false;
      button.classList.remove("is-busy");
    }
  }
}

/**
 * 上传发现近似版本时先给选择：继续处理新上传，或改用已有版本。
 * 新上传已经落库，不提供“撤销”；这里只负责选一个继续。
 */
function showDuplicateDrawer(result, duplicates, api) {
  const rows = duplicates
    .map((entry) => {
      const assetId = entry.normalized_asset_id || entry.original_asset_id || "";
      const ncc = Number(entry.ncc);
      const score = Number.isFinite(ncc) ? `${(ncc * 100).toFixed(1)}%` : "—";
      const status = entry.status === "confirmed" ? "确认相同" : "疑似相同";
      const thumb = assetId
        ? `<img class="dup-thumb" src="${http.assetPreviewUrl(assetId)}" alt="" loading="lazy" />`
        : `<span class="dup-thumb dup-thumb--file" aria-hidden="true">${icon("image")}</span>`;
      return `<li class="dup-row">
        ${thumb}
        <span class="dup-copy">
          <strong>已有版本 #${escapeHtml(shortId(entry.image_id))}</strong>
          <small>${escapeHtml(status)} · NCC ${escapeHtml(score)}${entry.grade ? ` · 等级 ${escapeHtml(entry.grade)}` : ""}</small>
        </span>
        <button class="btn btn--ghost btn--sm" type="button"
          data-dup-existing
          data-dup-image="${escapeHtml(entry.image_id)}"
          data-dup-asset="${escapeHtml(assetId)}">${icon("history")}使用这一版</button>
      </li>`;
    })
    .join("");
  const el = api.drawer({
    title: "发现近似版本",
    meta: `${duplicates.length} 个已有纹样与这次上传相近`,
    body: `<p class="drawer-lead">新上传已经保留。若这是同一张纹样，直接使用已有版本可以避免重复处理与重复登记。</p>
      <ul class="dup-list">${rows}</ul>
      <div class="drawer-actions">
        <button class="btn btn--primary btn--sm" type="button" data-dup-new>${icon("grid")}保留新上传并打开</button>
        <button class="btn btn--quiet btn--sm" type="button" data-dup-later>稍后决定</button>
      </div>
      <p class="drawer-foot">已有版本按接近程度排序；NCC 是归一化互相关，越接近 100% 越相似。</p>`,
  });
  el?.addEventListener("click", (event) => {
    const existing = event.target.closest("[data-dup-existing]");
    if (existing) {
      const image = existing.dataset.dupImage || "";
      const asset = existing.dataset.dupAsset || "";
      if (!image) return;
      api.closeDrawer();
      api.go("workbench", { query: { image, ...(asset ? { asset } : {}), stage: 1 } });
      return;
    }
    if (event.target.closest("[data-dup-new]")) {
      api.closeDrawer();
      api.go("workbench", { query: { image: result.image_id, stage: 1 } });
      return;
    }
    if (event.target.closest("[data-dup-later]")) api.closeDrawer();
  });
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

  // 跳过链接只移动焦点，不写 hash；否则 #view 会被路由当成未知页面并送回首页。
  document.querySelector(".skip-link")?.addEventListener("click", (event) => {
    const view = document.getElementById("view");
    if (!view) return;
    event.preventDefault();
    view.focus({ preventScroll: true });
    view.scrollIntoView({ block: "start" });
  });

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
    if (/^[1-8]$/.test(event.key)) {
      const stage = Number(event.key);
      // 08 平铺不支持对比；键盘切过去时和点击一样关掉对比。
      api.patch({ stage, ...(stage === 8 ? { compare: false } : {}) });
    } else if (event.key === "[") {
      cycleAsset(-1);
    } else if (event.key === "]") {
      cycleAsset(1);
    } else if (event.key.toLowerCase() === "c") {
      // 交给工作台做可用性检查；直接改 state 会在不可对比时留下隐式状态。
      document.dispatchEvent(new CustomEvent("ps:toggle-compare"));
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
  syncWorkbenchUrl();
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

// 浏览器里正常启动；Node 测试直接导入本模块的纯路由决策时不触碰 DOM。
if (typeof document !== "undefined") boot();
export { api as app, state };


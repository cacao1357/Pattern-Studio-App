/* =============================================================================
   views/library.js — 纹样库：本机 /api/v1/assets 的真实资产索引。
   数据层：store.library（分页/搜索/类型/评级/排序/视图）+ store.dataset（统计）。
   交互约定：
   - 搜索、类型变化走服务端（q / kind 参数），250ms 防抖；
   - 评级与排序只对已载入项做客户端过滤/排序，不发请求；
   - 结果体局部重绘，输入框与焦点不被整页重绘打断；
   - ?open=<assetId> 深链在列表载入后打开档案抽屉，并用 replaceState 清掉 open；
   - 预览 / 下载 / 在工作台打开都直接走本机服务，不写浏览器存储、不请求外链。
   ============================================================================= */

import { api as http } from "../api.js";
import { store } from "../store.js";
import { icon } from "../icons.js";
import {
  canPreview,
  dimsOf,
  escapeHtml as esc,
  formatBytes,
  formatTime,
  gradeLabel,
  kindLabel,
  licenseLabel,
  relativeTime,
  roleLabel,
  shortId,
  sourceLabel,
} from "../format.js";

/* ---------- 常量 ---------- */

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE = 250;

const SORTS = ["最新", "最早", "评级", "类型"];
const GRADES = ["全部", "A", "B", "C"];
const VIEWS = [
  ["grid", "网格", "gallery"],
  ["list", "列表", "list"],
];

/** 类型筛选 → 后端 kind 值（全部为空数组，由服务端返回所有类型） */
const KIND_FILTERS = [
  { label: "全部", kinds: [] },
  { label: "原图", kinds: ["original", "normalized_input", "crop", "cropped", "working_copy", "enhanced"] },
  { label: "线稿", kinds: ["lineart", "contour_line_art"] },
  { label: "矢量", kinds: ["svg"] },
  { label: "透明 PNG", kinds: ["transparent_png"] },
  { label: "蒙版", kinds: ["foreground_mask"] },
  { label: "平铺", kinds: ["tile_preview"] },
];

const ARCHIVE_KINDS = new Set(["export", "archive", "zip"]);
const SVG_KINDS = new Set(["svg", "monochrome_svg", "color_svg"]);

/* ---------- 视图内状态 ---------- */

/** 已载入的原始资产（服务端顺序：新 → 旧）；评级/排序只作用于这份副本 */
let rawItems = [];
let hasLoaded = false;
let busy = false;
let queued = null;
/** 当前挂载上下文：{ page, api } */
let ctx = null;
let searchTimer = 0;
let composing = false;

/* ---------- 小工具 ---------- */

const library = () => store.library;

const prefersReduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const sameKinds = (a = [], b = []) => a.length === b.length && a.every((kind, index) => kind === b[index]);

function activeKindFilter() {
  return KIND_FILTERS.find((filter) => sameKinds(filter.kinds, library().kinds || [])) || KIND_FILTERS[0];
}

function isFiltered() {
  const lib = library();
  return Boolean(String(lib.q || "").trim()) || (lib.kinds || []).length > 0 || lib.grade !== "全部";
}

function activeFilterText() {
  const lib = library();
  const parts = [];
  if (String(lib.q || "").trim()) parts.push(`关键词「${String(lib.q).trim()}」`);
  const kind = activeKindFilter();
  if (kind.label !== "全部") parts.push(`类型「${kind.label}」`);
  if (lib.grade !== "全部") parts.push(`评级「${lib.grade} 级」`);
  return parts.join(" · ");
}

function currentList() {
  if (!rawItems.length) return [];
  return store.filterAndSort(rawItems);
}

function previewable(asset) {
  const suffix = ARCHIVE_KINDS.has(asset.kind) ? ".zip" : SVG_KINDS.has(asset.kind) ? ".svg" : ".png";
  return canPreview(asset.kind, suffix);
}

function licenseOf(asset) {
  const text = licenseLabel(asset.license);
  return { text: text === "未登记" ? "授权未登记" : text, unset: text === "未登记" };
}

const gradeStamp = (grade) =>
  `<span class="stamp stamp--${esc(String(grade || "U").toLowerCase())}" title="${esc(gradeLabel(grade))}">${esc(grade || "U")}</span>`;

const chip = (act, value, current, text) => {
  const on = current === value;
  return `<button class="chip lb-chip${on ? " chip--accent" : ""}" type="button" data-act="${act}" data-val="${esc(
    value
  )}" aria-pressed="${on}">${esc(text)}</button>`;
};

/* ---------- 统计条 ---------- */

function statValues() {
  const dataset = store.dataset;
  if (!dataset) {
    return { total: "—", a: "—", b: "—", c: "—", duplicate: "—", license: "—", batches: "—" };
  }
  const grades = dataset.grades || {};
  return {
    total: dataset.total_images ?? 0,
    a: grades.A ?? 0,
    b: grades.B ?? 0,
    c: grades.C ?? 0,
    duplicate: dataset.duplicate_content_ids ?? 0,
    license: `${Math.round((dataset.license_coverage || 0) * 100)}%`,
    batches: (dataset.batches || []).length,
  };
}

function statsHtml() {
  const values = statValues();
  const dataset = store.dataset;
  const warn = {
    duplicate: Boolean(dataset && values.duplicate > 0),
    license: Boolean(dataset && (dataset.license_coverage || 0) < 1),
  };
  const rows = [
    ["total", "图片总数"],
    ["a", "A 级"],
    ["b", "B 级"],
    ["c", "C 级"],
    ["duplicate", "重复内容"],
    ["license", "授权覆盖"],
    ["batches", "批次"],
  ];
  return `
  <dl class="lb-stats" aria-label="数据集统计" data-lb-stats>
    ${rows
      .map(
        ([key, label]) => `
      <div class="lb-stat${warn[key] ? " lb-stat--warn" : ""}" data-stat-row="${key}">
        <dt class="label">${label}</dt>
        <dd class="num lb-stat__num" data-stat="${key}">${esc(String(values[key]))}</dd>
      </div>`
      )
      .join("")}
  </dl>`;
}

function paintStats(page) {
  if (!page || !page.isConnected) return;
  const values = statValues();
  const dataset = store.dataset;
  for (const [key, value] of Object.entries(values)) {
    const el = page.querySelector(`[data-stat="${key}"]`);
    if (el && el.textContent !== String(value)) el.textContent = String(value);
  }
  const duplicateRow = page.querySelector('[data-stat-row="duplicate"]');
  if (duplicateRow) duplicateRow.classList.toggle("lb-stat--warn", Boolean(dataset && values.duplicate > 0));
  const licenseRow = page.querySelector('[data-stat-row="license"]');
  if (licenseRow) licenseRow.classList.toggle("lb-stat--warn", Boolean(dataset && (dataset.license_coverage || 0) < 1));
}

/* ---------- 页头 / 筛选栏 ---------- */

function headHtml() {
  return `
  <header class="lb-head">
    <div class="lb-head__text">
      <p class="eyebrow">三 · 资产索引</p>
      <h1 class="title lb-head__title">纹样库</h1>
      <p class="lead lb-head__lead">
        全部资产都在这里，可切换网格或列表查看。
      </p>
    </div>
    <div class="lb-head__acts">
      <a class="btn btn--ghost btn--sm" href="${http.manifestUrl()}" download>${icon("download")}下载数据清单</a>
      <button class="btn btn--primary btn--sm" type="button" data-act="upload" data-magnetic>${icon("upload")}上传纹样</button>
    </div>
  </header>`;
}

function filtersHtml() {
  const lib = library();
  const kind = activeKindFilter();
  return `
  <div class="lb-filters" role="search" aria-label="筛选纹样">
    <div class="lb-filters__top">
      <label class="lb-search" for="lb-search-input">
        <span class="sr-only">搜索纹样编号、类型、来源或评级</span>
        ${icon("search")}
        <input class="input lb-search__input" id="lb-search-input" name="纹样搜索" type="search" data-lb-q
          value="${esc(lib.q)}" placeholder="搜索编号、类型、来源或评级…" autocomplete="off" spellcheck="false" />
      </label>

      <div class="lb-sort">
        <label class="label lb-sort__label" for="lb-sort-select">排序</label>
        <select class="select lb-sort__select" id="lb-sort-select" name="纹样排序" data-lb-sort>
          ${SORTS.map(
            (value) => `<option value="${esc(value)}"${lib.sort === value ? " selected" : ""}>${esc(value)}</option>`
          ).join("")}
        </select>
      </div>

      <div class="seg lb-viewseg" role="group" aria-label="视图方式">
        ${VIEWS.map(
          ([value, label, iconName]) => `
        <button class="seg__btn lb-viewseg__btn" type="button" data-act="view" data-val="${value}"
          aria-pressed="${lib.view === value}" aria-label="${label}视图" title="${label}视图">
          ${icon(iconName)}<span class="lb-viewseg__text">${label}</span>
        </button>`
        ).join("")}
      </div>
    </div>

    <div class="lb-filters__bottom">
      <div class="lb-chipgroup" role="group" aria-label="按类型筛选">
        <span class="label">类型</span>
        ${KIND_FILTERS.map((filter) => chip("kind", filter.label, kind.label, filter.label)).join("")}
      </div>
      <div class="lb-chipgroup" role="group" aria-label="按评级筛选">
        <span class="label">评级</span>
        ${GRADES.map((grade) => chip("grade", grade, lib.grade, grade === "全部" ? "全部" : `${grade} 级`)).join("")}
      </div>
    </div>
  </div>`;
}

function resultsHtml() {
  return `
  <section class="lb-results" aria-labelledby="lb-results-title">
    <div class="lb-results__bar">
      <h2 class="h3 lb-results__title" id="lb-results-title" tabindex="-1">全部登记</h2>
      <p class="mono lb-count" data-lb-count aria-live="polite"></p>
      <button class="btn btn--quiet btn--sm lb-clear" type="button" data-act="clear" hidden>
        ${icon("close")}清除筛选
      </button>
    </div>

    <div class="lb-results__body" data-lb-body></div>

    <div class="lb-more" data-lb-more hidden>
      <button class="btn btn--ghost btn--sm" type="button" data-act="more">加载更多</button>
      <p class="lb-more__note" data-more-note></p>
    </div>

    <p class="lb-foot" data-lb-foot></p>
  </section>`;
}

/* ---------- 结果体：加载 / 错误 / 空态 / 网格 / 列表 ---------- */

function loadingHtml() {
  return `
  <div class="lb-state lb-loading" role="status">
    <span class="lb-state__spinner" aria-hidden="true"></span>
    <p class="lb-state__title">正在读取本机纹样库…</p>
    <p class="lb-state__copy">资产索引来自本机服务 /api/v1/assets。</p>
  </div>`;
}

function errorHtml(message) {
  return `
  <div class="lb-state lb-state--error" role="alert">
    <span class="lb-empty__icon" aria-hidden="true">${icon("alert")}</span>
    <p class="lb-state__title">纹样库读取失败</p>
    <p class="lb-state__copy">${esc(message || "无法连接本机服务，请稍后重试。")}</p>
    <button class="btn btn--ghost btn--sm" type="button" data-act="retry">${icon("history")}重试</button>
  </div>`;
}

function emptyHtml() {
  if (!isFiltered()) {
    return `
    <div class="lb-empty">
      <span class="lb-empty__icon" aria-hidden="true">${icon("layers")}</span>
      <p class="lb-empty__title">还没有纹样</p>
      <p class="lb-empty__copy">
        上传第一张纹样，等级、尺寸与授权记录会一起登记。
      </p>
      <button class="btn btn--primary btn--sm" type="button" data-act="upload">${icon("upload")}上传纹样</button>
      <p class="lb-empty__hint">文件保存在 storage/api/。</p>
    </div>`;
  }
  const condition = activeFilterText();
  return `
  <div class="lb-empty">
    <span class="lb-empty__icon" aria-hidden="true">${icon("search")}</span>
    <p class="lb-empty__title">没有找到匹配的纹样</p>
    <p class="lb-empty__copy" role="status">
      当前条件：${condition ? esc(condition) : "全部"}。试试缩短关键词，或把类型 / 评级改回「全部」。
    </p>
    <button class="btn btn--ghost btn--sm" type="button" data-act="clear">${icon("close")}清除筛选</button>
  </div>`;
}

function mediaHtml(asset, variant) {
  if (!previewable(asset)) {
    const note = ARCHIVE_KINDS.has(asset.kind) ? "打包文件" : "无预览";
    return `<span class="lb-media__ph" aria-hidden="true">${icon("file")}<span>${note}</span></span>`;
  }
  return `<img class="${variant === "row" ? "lb-row__img" : "plate__img lb-card__img"}"
    src="${http.assetPreviewUrl(asset.asset_id)}" alt="" loading="lazy" decoding="async" />`;
}

function cardHtml(asset) {
  const license = licenseOf(asset);
  return `
  <button class="lb-card" type="button" data-open="${asset.asset_id}" data-kind="${esc(asset.kind)}"
    aria-haspopup="dialog" aria-expanded="false">
    <span class="lb-card__plate plate plate--grain">
      ${mediaHtml(asset, "card")}
      <span class="lb-card__grade" aria-hidden="true">${gradeStamp(asset.grade)}</span>
      <span class="lb-card__hover" aria-hidden="true">
        <span class="lb-card__hover-label">${esc(shortId(asset.asset_id))}</span>
        <span class="lb-card__hover-name">${esc(kindLabel(asset.kind))}</span>
        <span class="lb-card__hover-row">${esc(dimsOf(asset))} · ${esc(formatBytes(asset.bytes))}</span>
        <span class="lb-card__hover-row">${esc(sourceLabel(asset))}</span>
        <span class="lb-card__hover-row">授权 · <span class="${license.unset ? "is-warn" : ""}">${esc(license.text)}</span></span>
        <span class="lb-card__hover-cta">查看档案 ${icon("arrow")}</span>
      </span>
    </span>
    <span class="lb-card__meta">
      <span class="lb-card__name">${esc(kindLabel(asset.kind))}</span>
      <span class="lb-card__sub">${esc(shortId(asset.asset_id))} · ${esc(dimsOf(asset))} · ${esc(relativeTime(asset.created_at))}</span>
      <span class="lb-card__tags">
        <span class="lb-tag">${esc(gradeLabel(asset.grade))}</span>
        <span class="lb-tag${license.unset ? " lb-tag--warn" : ""}">${esc(license.text)}</span>
      </span>
    </span>
  </button>`;
}

function rowHtml(asset) {
  const license = licenseOf(asset);
  return `
  <li class="lb-rowli">
    <button class="lb-row" type="button" data-open="${asset.asset_id}"
      aria-haspopup="dialog" aria-expanded="false">
      <span class="lb-row__thumb lb-col--thumb">${mediaHtml(asset, "row")}</span>
      <span class="lb-row__id mono lb-col--id">${esc(shortId(asset.asset_id))}</span>
      <span class="lb-row__name lb-col--name">${esc(kindLabel(asset.kind))}</span>
      <span class="lb-row__origin lb-col--origin">${esc(sourceLabel(asset))}</span>
      <span class="lb-row__type lb-col--type${license.unset ? " is-warn" : ""}">${esc(license.text)}</span>
      <span class="lb-row__grade lb-col--grade">${gradeStamp(asset.grade)}</span>
      <span class="lb-row__dims mono lb-col--dims">${esc(dimsOf(asset))}</span>
      <span class="lb-row__versions mono lb-col--versions">${esc(formatBytes(asset.bytes))}</span>
      <span class="lb-row__updated mono lb-col--updated">${esc(relativeTime(asset.created_at))}</span>
    </button>
  </li>`;
}

function bodyHtml() {
  const lib = library();
  if (!hasLoaded) return loadingHtml();
  if (lib.loading && !rawItems.length) return loadingHtml();
  if (lib.error && !rawItems.length) return errorHtml(lib.error);
  const list = currentList();
  if (!list.length) return emptyHtml();
  if (lib.view === "list") {
    return `
    <div class="lb-table">
      <div class="lb-thead" aria-hidden="true">
        <span class="lb-th lb-col--thumb">缩略</span>
        <span class="lb-th lb-col--id">编号</span>
        <span class="lb-th lb-col--name">类型</span>
        <span class="lb-th lb-col--origin">来源</span>
        <span class="lb-th lb-col--type">授权</span>
        <span class="lb-th lb-col--grade">评级</span>
        <span class="lb-th lb-col--dims">尺寸</span>
        <span class="lb-th lb-col--versions">大小</span>
        <span class="lb-th lb-col--updated">时间</span>
      </div>
      <ul class="lb-rows">${list.map(rowHtml).join("")}</ul>
    </div>`;
  }
  return `<div class="lb-grid">${list.map(cardHtml).join("")}</div>`;
}

function countHtml() {
  const lib = library();
  const filtered = isFiltered();
  const flag = filtered ? '<span class="lb-count__flag">已筛选</span>' : "";
  if (!hasLoaded || (lib.loading && !rawItems.length)) return "正在读取本机纹样库…";
  const list = currentList();
  if (lib.loading) return `更新中… ${flag}`;
  return `命中 <span class="num">${list.length}</span> / 已载入 <span class="num">${rawItems.length}</span> 项${flag}`;
}

function paintMore(page) {
  const wrap = page.querySelector("[data-lb-more]");
  if (!wrap) return;
  const show = rawItems.length > 0;
  wrap.hidden = !show;
  if (!show) return;
  const button = wrap.querySelector('[data-act="more"]');
  const note = wrap.querySelector("[data-more-note]");
  const loading = busy || library().loading;
  const hasMore = Boolean(library().nextCursor);
  if (button) {
    button.disabled = loading || !hasMore;
    button.textContent = loading ? "载入中…" : hasMore ? "加载更多" : "已全部载入";
    button.setAttribute("aria-busy", String(loading));
  }
  if (note) {
    note.textContent = hasMore
      ? `已载入 ${rawItems.length} 项 · 每页 ${PAGE_SIZE} 项`
      : `已载入 ${rawItems.length} 项 · 没有更多资产了`;
  }
}

function paintFooter(page) {
  const foot = page.querySelector("[data-lb-foot]");
  if (!foot) return;
  const total = store.dataset ? store.dataset.total_images : "—";
  foot.innerHTML = `数据来自本机服务 · 已载入 <span class="num">${rawItems.length}</span> 项 · 数据集共
    <span class="num">${esc(String(total))}</span> 张图片 · 每页 ${PAGE_SIZE} 项`;
}

function paintFilters(page) {
  const lib = library();
  const kind = activeKindFilter();
  page.querySelectorAll('[data-act="kind"]').forEach((button) => {
    const on = button.dataset.val === kind.label;
    button.classList.toggle("chip--accent", on);
    button.setAttribute("aria-pressed", String(on));
  });
  page.querySelectorAll('[data-act="grade"]').forEach((button) => {
    const on = button.dataset.val === lib.grade;
    button.classList.toggle("chip--accent", on);
    button.setAttribute("aria-pressed", String(on));
  });
  page.querySelectorAll('[data-act="view"]').forEach((button) => {
    button.setAttribute("aria-pressed", String(lib.view === button.dataset.val));
  });
  const sort = page.querySelector("[data-lb-sort]");
  if (sort && sort.value !== lib.sort) sort.value = lib.sort;
  const search = page.querySelector("[data-lb-q]");
  if (search && document.activeElement !== search && search.value !== lib.q) search.value = lib.q;
}

function paintResults(page, { animate = false } = {}) {
  if (!page || !page.isConnected) return;
  const body = page.querySelector("[data-lb-body]");
  if (body) {
    body.innerHTML = bodyHtml();
    if (animate && !prefersReduced()) {
      body.classList.remove("is-swap");
      void body.offsetWidth;
      body.classList.add("is-swap");
    }
  }

  const count = page.querySelector("[data-lb-count]");
  if (count) {
    const next = countHtml();
    if (count.innerHTML !== next) {
      count.innerHTML = next;
      if (animate && !prefersReduced()) {
        count.classList.remove("is-bump");
        void count.offsetWidth;
        count.classList.add("is-bump");
      }
    }
  }

  const title = page.querySelector(".lb-results__title");
  if (title) title.textContent = isFiltered() ? "筛选结果" : "全部登记";

  const clear = page.querySelector(".lb-clear");
  if (clear) clear.hidden = !isFiltered();

  paintMore(page);
  paintFooter(page);
}

/* ---------- 载入与分页 ---------- */

/**
 * store.loadLibrary 会按当前的 grade / sort 就地过滤已载入项；这里临时用
 * 「全部 / 最新」载入原始分页（服务端顺序），再恢复用户的筛选与排序，
 * 好让评级与排序真正只作用于已载入项、切换时不再回源。
 */
async function loadPage({ append = false } = {}) {
  const lib = library();
  const grade = lib.grade;
  const sort = lib.sort;
  if (grade !== "全部") lib.grade = "全部";
  if (sort !== "最新") lib.sort = "最新";
  try {
    await store.loadLibrary({ append });
  } finally {
    lib.grade = grade;
    lib.sort = sort;
  }
  rawItems = Array.isArray(lib.items) ? lib.items.slice() : [];
  if (!append) hasLoaded = true;
}

function setPendingUI(page) {
  if (!page || !page.isConnected) return;
  if (!rawItems.length) {
    const body = page.querySelector("[data-lb-body]");
    if (body) body.innerHTML = loadingHtml();
    const count = page.querySelector("[data-lb-count]");
    if (count) count.innerHTML = "正在读取本机纹样库…";
  }
  paintMore(page);
}

async function requestLibrary(page, api, { append = false } = {}) {
  if (!page || !page.isConnected) return;
  if (busy) {
    const appendNext = Boolean((queued ? queued.append : false) && append) || (!queued && append);
    queued = { page, api, append: appendNext };
    return;
  }
  busy = true;
  let next = { page, api, append };
  let lastPage = null;
  while (next) {
    const job = next;
    next = null;
    lastPage = job.page;
    setPendingUI(job.page);
    try {
      await loadPage({ append: job.append });
    } catch (error) {
      if (!library().error) library().error = error?.message || "纹样库读取失败。";
    }
    if (ctx && ctx.page === job.page) {
      paintStats(job.page);
      paintResults(job.page, { animate: !job.append });
      notifyLoadError(job.api);
    }
    if (queued) {
      next = queued;
      queued = null;
    }
  }
  busy = false;
  if (lastPage && ctx && ctx.page === lastPage) paintMore(lastPage);
}

function notifyLoadError(api) {
  const error = library().error;
  if (!error || !rawItems.length) return;
  if (ctx && ctx.lastError === error) return;
  if (ctx) ctx.lastError = error;
  api.toast(error, "warn");
}

/* ---------- 筛选动作 ---------- */

function scheduleSearch(page, api, value) {
  store.setLibraryQuery({ q: value });
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = 0;
    requestLibrary(page, api);
  }, SEARCH_DEBOUNCE);
}

function clearFilters(page, api) {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = 0;
  }
  store.setLibraryQuery({ q: "", kinds: [], grade: "全部" });
  const search = page.querySelector("[data-lb-q]");
  if (search) search.value = "";
  paintFilters(page);
  requestLibrary(page, api);
}

function triggerUpload(api) {
  const button = document.querySelector('[data-action="upload"]');
  if (button) {
    button.click();
    return;
  }
  api.toast("请使用页面顶部的「上传纹样」按钮", "info");
}

/* ---------- 档案抽屉 ---------- */

function kvRow(label, value) {
  return `<div class="kv__row"><dt>${label}</dt><dd>${value}</dd></div>`;
}

const shortHash = (value) => {
  const text = String(value || "");
  if (!text) return "—";
  return `<span title="${esc(text)}">${esc(text.slice(0, 12))}…</span>`;
};

function parametersRows(asset) {
  const params = asset.parameters;
  if (!params || typeof params !== "object") return [];
  const options = params.options && typeof params.options === "object" ? params.options : {};
  const rows = [];
  const add = (label, value) => {
    if (value === undefined || value === null || value === "" || typeof value === "object") return;
    rows.push([label, String(value)]);
  };
  add("模式", options.mode ?? params.mode);
  add("阈值", params.threshold);
  add("偏移", params.offset);
  add("颜色数", options.max_colors ?? params.max_colors ?? params.colors);
  add("细节", options.detail);
  if (Number.isFinite(Number(params.foreground_fraction))) {
    add("前景占比", `${(Number(params.foreground_fraction) * 100).toFixed(1)}%`);
  }
  add("最少构件面积", params.min_component_area);
  add("路径数", params.path_count);
  add("SVG 大小", Number.isFinite(Number(params.svg_bytes)) ? formatBytes(params.svg_bytes) : undefined);
  add("线宽", asset.line_width ?? params.line_width);
  return rows;
}

function parentsHtml(asset) {
  const parents = Array.isArray(asset.parents) ? asset.parents.filter((parent) => parent && parent.asset_id) : [];
  if (!parents.length) return "—";
  return `<ul class="lb-parents">${parents
    .map(
      (parent) =>
        `<li><span class="label">${esc(roleLabel(parent.role))}</span><span class="mono">${esc(shortId(parent.asset_id))}</span></li>`
    )
    .join("")}</ul>`;
}

function drawerBody(asset) {
  const license = licenseOf(asset);
  const preview = previewable(asset);
  const params = parametersRows(asset);
  const sourceBits = [`<span>${esc(sourceLabel(asset))}</span>`];
  if (asset.source_type) sourceBits.push(`<span class="mono">类型 ${esc(asset.source_type)}</span>`);
  if (asset.source_url) sourceBits.push(`<span class="mono lb-break">${esc(asset.source_url)}</span>`);
  if (asset.source_note) sourceBits.push(`<span>${esc(asset.source_note)}</span>`);
  if (asset.provenance_status) {
    sourceBits.push(
      `<span class="mono">${asset.provenance_status === "declared" ? "来源已声明" : "来源未核验"}</span>`
    );
  }

  return `
    <div class="drawer-plate plate plate--grain lb-drawer__plate">
      ${
        preview
          ? `<img class="plate__img" src="${http.assetPreviewUrl(asset.asset_id)}" alt="${esc(kindLabel(asset.kind))} 预览" />`
          : `<span class="lb-media__ph lb-media__ph--lg" aria-hidden="true">${icon("file")}<span>打包文件 · 仅可下载</span></span>`
      }
    </div>

    <div class="lb-drawer__facts">
      ${gradeStamp(asset.grade)}
      <span class="chip chip--solid">${esc(kindLabel(asset.kind))}</span>
      ${
        license.unset
          ? `<span class="chip chip--gold">${icon("alert")}${esc(license.text)}</span>`
          : `<span class="chip chip--jade">${icon("check")}${esc(license.text)}</span>`
      }
      ${asset.ai_inferred ? `<span class="chip chip--gold">云端推断</span>` : ""}
      ${asset.geometry_verified === false ? `<span class="chip chip--gold">几何未验证</span>` : ""}
    </div>

    <dl class="kv">
      ${kvRow("资产 ID", `<span class="mono lb-break">${esc(asset.asset_id)}</span>`)}
      ${kvRow("类型", `${esc(kindLabel(asset.kind))}${asset.algorithm_version ? ` · <span class="mono">${esc(asset.algorithm_version)}</span>` : ""}`)}
      ${kvRow("尺寸", dimsOf(asset) === "—" ? "—" : `<span class="mono">${esc(dimsOf(asset))}</span> 像素`)}
      ${kvRow("大小", `<span class="mono">${esc(formatBytes(asset.bytes))}</span>`)}
      ${kvRow("评级", `${esc(gradeLabel(asset.grade))}${asset.grade_version ? ` · <span class="mono">${esc(asset.grade_version)}</span>` : ""}`)}
      ${kvRow("许可证", license.unset ? `${esc(license.text)} · 打包前需逐条确认` : esc(license.text))}
      ${kvRow("来源", sourceBits.join("<br />"))}
      ${kvRow("采集日期", `<span class="mono">${esc(asset.collected_at || "—")}</span>`)}
      ${kvRow("批次", `<span class="mono">${esc(asset.batch_id || "—")}</span>`)}
      ${kvRow("sha256", `<span class="mono">${shortHash(asset.sha256)}</span>`)}
      ${kvRow("内容 ID", `<span class="mono">${asset.content_id ? esc(asset.content_id) : "—"}</span>`)}
      ${kvRow("坐标空间", `<span class="mono">${asset.coordinate_space_id ? esc(shortId(asset.coordinate_space_id)) : "—"}</span>`)}
      ${kvRow("生成任务", `<span class="mono">${asset.generated_by_job_id ? esc(shortId(asset.generated_by_job_id)) : "—"}</span>`)}
      ${kvRow("父资产", parentsHtml(asset))}
      ${kvRow("创建时间", `<span class="mono">${esc(formatTime(asset.created_at, { withDate: true }))}</span>`)}
    </dl>

    ${
      params.length
        ? `<section class="lb-drawer__block" aria-labelledby="lb-params-title">
            <div class="lb-drawer__block-head">
              <span class="label" id="lb-params-title">处理参数</span>
              <span class="mono">${params.length} 项</span>
            </div>
            <dl class="kv lb-kv--dense">
              ${params.map(([label, value]) => kvRow(esc(label), `<span class="mono">${esc(value)}</span>`)).join("")}
            </dl>
          </section>`
        : ""
    }

    <div class="drawer-actions lb-drawer__actions">
      ${
        preview
          ? `<button class="btn btn--ghost btn--sm" type="button" data-drawer-action="preview">${icon("eye")}预览</button>`
          : ""
      }
      <a class="btn btn--ghost btn--sm" href="${http.assetDownloadUrl(asset.asset_id)}" download>${icon("download")}下载</a>
      <button class="btn btn--ghost btn--sm" type="button" data-drawer-action="copy">${icon("file")}复制资产 ID</button>
      <button class="btn btn--primary btn--sm" type="button" data-drawer-action="workbench">${icon("arrow")}在工作台打开</button>
    </div>
    <p class="drawer-foot">字段来自本机资产记录；预览与下载直接读取本机文件。</p>
  `;
}

async function drawerAction(action, asset, button, api) {
  if (action === "preview") {
    const opened = window.open(http.assetPreviewUrl(asset.asset_id), "_blank");
    if (opened) opened.opener = null;
    else api.toast("浏览器拦截了新窗口，请允许弹出窗口后重试", "warn");
    return;
  }
  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(asset.asset_id);
      api.toast("资产 ID 已复制", "done");
    } catch {
      api.toast("无法写入剪贴板，请手动选择资产 ID", "warn");
    }
    return;
  }
  if (action === "workbench") {
    if (button) button.disabled = true;
    try {
      const result = await store.openAsset(asset.asset_id);
      if (!result) return;
      const { asset: opened, stage } = result;
      const query = { asset: opened.asset_id, stage };
      if (opened.image_id) query.image = opened.image_id;
      api.closeDrawer();
      api.go("workbench", { query });
    } catch (error) {
      if (button) button.disabled = false;
      api.toast(error?.message || "无法在工作台打开这个资产", "warn");
    }
  }
}

function openAssetDrawer(asset, trigger, api) {
  const el = api.drawer({
    title: esc(kindLabel(asset.kind)),
    meta: `${esc(shortId(asset.asset_id))} · ${esc(formatTime(asset.created_at, { withDate: true }))}`,
    body: drawerBody(asset),
  });
  if (!el) return;
  el.classList.add("lb-drawer");
  if (trigger && trigger.setAttribute) trigger.setAttribute("aria-expanded", "true");

  el.addEventListener("click", (event) => {
    const hit = event.target.closest("[data-drawer-action]");
    if (!hit || !el.contains(hit)) return;
    event.preventDefault();
    drawerAction(hit.dataset.drawerAction, asset, hit, api);
  });

  /* 抽屉被外壳移除后复位触发按钮的 aria-expanded；焦点由 api.drawer 归还 */
  const observer = new MutationObserver(() => {
    if (document.body.contains(el)) return;
    observer.disconnect();
    if (trigger && trigger.setAttribute) trigger.setAttribute("aria-expanded", "false");
  });
  const host = document.querySelector(".app");
  if (host) observer.observe(host, { childList: true });
}

/* ---------- 深链 ---------- */

function stripOpenParam() {
  const raw = location.hash.replace(/^#\/?/, "");
  if (!raw.includes("open=")) return;
  const [name, query] = raw.split("?");
  const params = new URLSearchParams(query || "");
  params.delete("open");
  const next = `#/${name}${params.toString() ? `?${params.toString()}` : ""}`;
  try {
    history.replaceState(null, "", next);
  } catch {
    /* 地址栏受限时忽略：不影响页面本身 */
  }
}

async function openDeepLinkedAsset(page, api, params) {
  const openId = (params && params.get("open")) || store.library.openId || "";
  if (!openId) return;
  store.library.openId = null;
  try {
    const asset = await http.asset(openId);
    if (!ctx || ctx.page !== page) return;
    openAssetDrawer(asset, null, api);
  } catch (error) {
    if (ctx && ctx.page === page) {
      api.toast(error?.status === 404 ? "没有找到这个资产" : error?.message || "无法打开这个资产", "warn");
    }
  } finally {
    stripOpenParam();
  }
}

/* ---------- 视图模块 ---------- */

export default {
  id: "library",
  title: "纹样库",

  render() {
    return `
    <div class="lb-page">
      <div class="wrap">
        ${headHtml()}
        ${statsHtml()}
        ${filtersHtml()}
        ${resultsHtml()}
      </div>
    </div>`;
  },

  mount(root, state, api, params) {
    const page = root.querySelector(".lb-page");
    if (!page) return;
    ctx = { page, api, lastError: "" };

    paintFilters(page);
    paintStats(page);
    paintResults(page);

    const search = page.querySelector("[data-lb-q]");
    const sort = page.querySelector("[data-lb-sort]");

    /* 统一事件委托：筛选、视图、加载更多、重试、上传、打开档案 */
    page.addEventListener("click", (event) => {
      const hit = event.target.closest("[data-open], [data-act]");
      if (!hit || !page.contains(hit)) return;

      if (hit.dataset.open) {
        const asset =
          rawItems.find((item) => item.asset_id === hit.dataset.open) ||
          currentList().find((item) => item.asset_id === hit.dataset.open);
        if (asset) openAssetDrawer(asset, hit, api);
        return;
      }

      switch (hit.dataset.act) {
        case "kind": {
          const filter = KIND_FILTERS.find((item) => item.label === hit.dataset.val) || KIND_FILTERS[0];
          store.setLibraryQuery({ kinds: filter.kinds.slice() });
          paintFilters(page);
          requestLibrary(page, api);
          break;
        }
        case "grade":
          store.setLibraryQuery({ grade: hit.dataset.val });
          paintFilters(page);
          paintResults(page, { animate: true });
          break;
        case "view":
          store.setLibraryQuery({ view: hit.dataset.val });
          paintFilters(page);
          paintResults(page, { animate: true });
          break;
        case "clear":
          clearFilters(page, api);
          break;
        case "more":
          requestLibrary(page, api, { append: true });
          paintMore(page);
          break;
        case "retry":
          requestLibrary(page, api);
          break;
        case "upload":
          triggerUpload(api);
          break;
        default:
          break;
      }
    });

    /* 搜索：中文组字期间不打断候选，停下来 250ms 后再回源 */
    if (search) {
      search.addEventListener("input", (event) => {
        if (event.isComposing || composing) return;
        scheduleSearch(page, api, search.value);
      });
      search.addEventListener("compositionstart", () => {
        composing = true;
      });
      search.addEventListener("compositionend", () => {
        composing = false;
        scheduleSearch(page, api, search.value);
      });
      search.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !search.value) return;
        event.preventDefault();
        search.value = "";
        store.setLibraryQuery({ q: "" });
        requestLibrary(page, api);
        paintFilters(page);
      });
    }

    /* 排序只在已载入项上重排，不发请求 */
    if (sort) {
      sort.addEventListener("change", () => {
        store.setLibraryQuery({ sort: sort.value });
        paintResults(page, { animate: true });
      });
    }

    (async () => {
      const loading = requestLibrary(page, api);
      const dataset = store.loadDataset();
      await loading;
      if (!ctx || ctx.page !== page) return;
      paintStats(page);
      await dataset;
      if (!ctx || ctx.page !== page) return;
      paintStats(page);
      await openDeepLinkedAsset(page, api, params);
    })();
  },

  unmount() {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = 0;
    }
    composing = false;
    ctx = null;
  },
};

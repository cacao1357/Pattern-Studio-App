/* =============================================================================
   views/library.js — 纹样库：按原图 image_id 分组的真实资产索引。
   数据层：store.patterns（GET /api/v1/patterns 服务端分页 + 手动分类）
           store.dataset（数据集统计，保持原有统计条）。
   交互约定：
   - 搜索 / 类型 / 题材走服务端（q / kind / category_id），250ms 防抖；
     快速切换以最新条件为准，旧请求由 store 取消，慢响应不会覆盖新结果。
   - 评级 / 组内排序 / 网格-列表视图只作用于**已载入的组**，不回源；
     分页继续使用 next_cursor，不把「已载入」说成「全库」。
   - 分类可新建 / 重命名 / 删除；一个原图组可属于多个分类；删除分类只解除归类，
     不删除原图或任何版本。
   - ?open=<assetId> 深链在列表载入后打开档案抽屉，并用 replaceState 清掉 open。
   - 预览 / 下载 / 在工作台打开继续直接走本机服务，不写浏览器存储、不请求外链。
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
import { openBatchExport } from "./batch-export.js";
import { openRunDialog } from "./processing-panel.js";

/* ---------- 常量 ---------- */

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE = 250;

const SORTS = ["最新", "最早", "评级", "类型"];
const GRADES = ["全部", "A", "B", "C"];
const VIEWS = [
  ["grid", "网格", "gallery"],
  ["list", "列表", "list"],
];

/** 处理类型筛选 → 后端 kind 精确值（空字符串表示全部） */
const KIND_FILTERS = [
  { label: "全部", kind: "" },
  { label: "原图", kind: "original" },
  { label: "规范输入", kind: "normalized_input" },
  { label: "裁切", kind: "cropped" },
  { label: "线稿", kind: "lineart" },
  { label: "透明 PNG", kind: "transparent_png" },
  { label: "矢量 SVG", kind: "svg" },
  { label: "平铺", kind: "tile_preview" },
];

const ARCHIVE_KINDS = new Set(["export", "archive", "zip"]);
const SVG_KINDS = new Set(["svg", "monochrome_svg", "color_svg"]);
const GRADE_ORDER = { A: 0, B: 1, C: 2, U: 3 };

/* ---------- 视图内状态 ---------- */

let ctx = null;
let searchTimer = 0;
let composing = false;
/** 结果绘制序号：旧请求即使晚到也不能把新筛选的结果盖回去。 */
let paintSeq = 0;
let catManage = false;
/** { mode: "create" | "rename", id } */
let catForm = null;
let catDeletePending = "";
let catDeleteTimer = 0;

/* ---------- 小工具 ---------- */

const patterns = () => store.patterns;
const loaded = () => patterns().loadedAt > 0;

const prefersReduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const activeKind = () => KIND_FILTERS.find((entry) => entry.kind === (patterns().kind || "")) || KIND_FILTERS[0];

function isFiltered() {
  const lib = patterns();
  return Boolean(String(lib.q || "").trim()) || Boolean(lib.kind) || Boolean(lib.categoryId) || lib.grade !== "全部";
}

function activeFilterText() {
  const lib = patterns();
  const parts = [];
  if (String(lib.q || "").trim()) parts.push(`关键词「${String(lib.q).trim()}」`);
  const kind = activeKind();
  if (kind.kind) parts.push(`类型「${kind.label}」`);
  if (lib.categoryId) {
    const category = store.categoryById(lib.categoryId);
    parts.push(`题材「${category?.name || "已删除"}」`);
  }
  if (lib.grade !== "全部") parts.push(`评级「${lib.grade} 级」`);
  return parts.join(" · ");
}

const createdMs = (value) => {
  const ms = Date.parse(String(value || ""));
  return Number.isNaN(ms) ? 0 : ms;
};

/** 组内排序；组顺序始终按服务端的原图登记顺序（新 → 旧）。 */
export function sortGroupAssets(assets, sort = "最新") {
  const list = [...(assets || [])];
  const newest = (a, b) => createdMs(b.created_at) - createdMs(a.created_at);
  if (sort === "最早") return list.sort((a, b) => createdMs(a.created_at) - createdMs(b.created_at));
  if (sort === "评级") {
    return list.sort(
      (a, b) =>
        (GRADE_ORDER[a.grade || "U"] ?? 4) - (GRADE_ORDER[b.grade || "U"] ?? 4) || newest(a, b)
    );
  }
  if (sort === "类型") {
    return list.sort(
      (a, b) => kindLabel(a.kind).localeCompare(kindLabel(b.kind), "zh-Hans-CN") || newest(a, b)
    );
  }
  return list.sort(newest);
}

/** 当前筛选下要显示的组：评级只筛组内版本，不让空组留在结果里。 */
export function displayedPatterns(items = patterns().items, { grade = "全部", sort = "最新" } = {}) {
  return (items || [])
    .map((group) => {
      const assets = (group.assets || []).filter(
        (asset) => grade === "全部" || (asset.grade || "U") === grade
      );
      return { ...group, assets: sortGroupAssets(assets, sort) };
    })
    .filter((group) => group.assets.length > 0);
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

const chip = (act, value, current, text, extra = "") => {
  const on = current === value;
  return `<button class="chip lb-chip${on ? " chip--accent" : ""}" type="button" data-act="${act}" data-val="${esc(
    value
  )}" aria-pressed="${on}"${extra}>${esc(text)}</button>`;
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
    ["total", "原图总数"],
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
  page.querySelector('[data-stat-row="duplicate"]')?.classList.toggle("lb-stat--warn", Boolean(dataset && values.duplicate > 0));
  page
    .querySelector('[data-stat-row="license"]')
    ?.classList.toggle("lb-stat--warn", Boolean(dataset && (dataset.license_coverage || 0) < 1));
}

/* ---------- 页头 ---------- */

function headHtml() {
  return `
  <header class="lb-head">
    <div class="lb-head__text">
      <h1 class="title lb-head__title">纹样库</h1>
      <p class="lead lb-head__lead">按原图分组查看全部版本：同一张原图的处理结果留在一组，不同原图分开。</p>
    </div>
    <div class="lb-head__acts">
      <a class="btn btn--ghost btn--sm" href="${http.manifestUrl()}" download>${icon("download")}下载数据清单</a>
      <button class="btn btn--ghost btn--sm" type="button" data-act="export-loaded">${icon("download")}导出已载入</button>
      <button class="btn btn--ghost btn--sm" type="button" data-act="process-batch">${icon("play")}批量处理</button>
      <button class="btn btn--primary btn--sm" type="button" data-act="upload" data-magnetic>${icon("upload")}上传纹样</button>
    </div>
  </header>`;
}

/* ---------- 筛选栏 ---------- */

function filtersHtml() {
  const lib = patterns();
  const kind = activeKind();
  return `
  <div class="lb-filters" role="search" aria-label="筛选纹样">
    <div class="lb-filters__top">
      <label class="lb-search" for="lb-search-input">
        <span class="sr-only">搜索纹样名称、来源、类型或资产编号</span>
        ${icon("search")}
        <input class="input lb-search__input" id="lb-search-input" name="纹样搜索" type="search" data-lb-q
          value="${esc(lib.q)}" placeholder="搜索名称、来源、类型或资产编号…" autocomplete="off" spellcheck="false" />
      </label>

      <div class="lb-sort">
        <label class="label lb-sort__label" for="lb-sort-select">组内排序</label>
        <select class="select lb-sort__select" id="lb-sort-select" name="版本排序" data-lb-sort>
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
      <div class="lb-chipgroup" role="group" aria-label="按处理类型筛选">
        <span class="label">类型</span>
        ${KIND_FILTERS.map((filter) => chip("kind", filter.label, kind.label, filter.label)).join("")}
      </div>
      <div class="lb-chipgroup" role="group" aria-label="按评级筛选（只作用于已载入的组）">
        <span class="label">评级</span>
        ${GRADES.map((grade) => chip("grade", grade, lib.grade, grade === "全部" ? "全部" : `${grade} 级`)).join("")}
      </div>
    </div>

    <div class="lb-cats" data-lb-cats>${categoryBarHtml()}</div>
  </div>`;
}

function categoryChipsHtml() {
  const lib = patterns();
  return `
    <button class="chip lb-chip${lib.categoryId ? "" : " chip--accent"}" type="button" data-act="cat-filter" data-val=""
      aria-pressed="${lib.categoryId ? "false" : "true"}">全部题材</button>
    ${(lib.categories || [])
      .map(
        (category) =>
          `<button class="chip lb-chip${lib.categoryId === category.category_id ? " chip--accent" : ""}" type="button"
            data-act="cat-filter" data-val="${esc(category.category_id)}"
            aria-pressed="${lib.categoryId === category.category_id}">${esc(category.name)}</button>`
      )
      .join("")}
  `;
}

function categoryBarHtml() {
  const lib = patterns();
  const form = catForm;
  return `
  <div class="lb-cats__row" role="group" aria-label="按题材分类筛选">
    <span class="label">题材</span>
    ${categoryChipsHtml()}
    <span class="lb-cats__spacer"></span>
    <button class="btn btn--quiet btn--sm" type="button" data-act="cat-new">${icon("plus")}新建分类</button>
    <button class="btn btn--quiet btn--sm lb-cats__manage" type="button" data-act="cat-manage" aria-pressed="${catManage}">
      ${icon("sliders")}${catManage ? "收起管理" : "管理分类"}
    </button>
  </div>
  ${
    lib.categoriesError
      ? `<p class="lb-cats__error" role="alert">${esc(lib.categoriesError)} <button class="btn btn--quiet btn--sm" type="button" data-act="cat-reload">重试</button></p>`
      : ""
  }
  ${
    form?.mode === "create"
      ? `<div class="lb-cat-form" data-cat-form>
          <label class="sr-only" for="lb-cat-input">新分类名称</label>
          <input class="input lb-cat-form__input" id="lb-cat-input" data-cat-input maxlength="60"
            value="${esc(form.value || "")}" placeholder="例如：祥云、花卉、几何…" autocomplete="off" />
          <button class="btn btn--primary btn--sm" type="button" data-act="cat-save">创建</button>
          <button class="btn btn--quiet btn--sm" type="button" data-act="cat-cancel">取消</button>
        </div>`
      : ""
  }
  ${
    catManage
      ? `<div class="lb-cats__manage-list" data-cat-manage-list>
          ${
            (lib.categories || []).length
              ? lib.categories
                  .map((category) => {
                    const renaming = form?.mode === "rename" && form.id === category.category_id;
                    const pending = catDeletePending === category.category_id;
                    return `<div class="lb-cat-row" data-cat-row="${esc(category.category_id)}">
                      ${
                        renaming
                          ? `<label class="sr-only" for="lb-cat-input">重命名 ${esc(category.name)}</label>
                             <input class="input lb-cat-form__input" id="lb-cat-input" data-cat-input maxlength="60"
                               value="${esc(form.value ?? category.name)}" autocomplete="off" />
                             <button class="btn btn--primary btn--sm" type="button" data-act="cat-save">保存</button>
                             <button class="btn btn--quiet btn--sm" type="button" data-act="cat-cancel">取消</button>`
                          : `<span class="lb-cat-row__name">${esc(category.name)}</span>
                             <span class="mono lb-cat-row__rev">修订 ${category.revision}</span>
                             <button class="btn btn--quiet btn--sm" type="button" data-act="cat-rename" data-id="${esc(category.category_id)}">重命名</button>
                             <button class="btn ${pending ? "btn--ghost" : "btn--quiet"} btn--sm" type="button"
                               data-act="cat-delete" data-id="${esc(category.category_id)}" data-rev="${category.revision}">
                               ${pending ? "确认删除？" : "删除"}</button>`
                      }
                    </div>`;
                  })
                  .join("")
              : `<p class="field__hint">还没有题材分类。新建后可以把同一张原图归入多个分类。</p>`
          }
          <p class="field__hint">删除分类只解除归类，不会删除纹样、原图或任何处理结果。</p>
        </div>`
      : ""
  }`;
}

/* ---------- 结果区 ---------- */

function resultsHtml() {
  return `
  <section class="lb-results" aria-labelledby="lb-results-title">
    <div class="lb-results__bar">
      <h2 class="h3 lb-results__title" id="lb-results-title" tabindex="-1">全部纹样</h2>
      <p class="mono lb-count" data-lb-count aria-live="polite"></p>
      <button class="btn btn--quiet btn--sm lb-clear" type="button" data-act="clear" hidden>
        ${icon("close")}清除筛选
      </button>
    </div>

    <div class="lb-results__body" data-lb-body></div>

    <div class="lb-more" data-lb-more hidden>
      <button class="btn btn--ghost btn--sm" type="button" data-act="more">加载更多原图组</button>
      <p class="lb-more__note" data-more-note></p>
    </div>

    <p class="lb-foot" data-lb-foot></p>
  </section>`;
}

function loadingHtml() {
  return `
  <div class="lb-state lb-loading" role="status">
    <span class="lb-state__spinner" aria-hidden="true"></span>
    <p class="lb-state__title">正在读取本机纹样库…</p>
    <p class="lb-state__copy">按原图分组来自本机服务 /api/v1/patterns。</p>
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
      <p class="lb-empty__copy">上传第一张原图，等级、尺寸与授权记录会一起登记；处理结果按原图分组显示。</p>
      <button class="btn btn--primary btn--sm" type="button" data-act="upload">${icon("upload")}上传纹样</button>
      <p class="lb-empty__hint">文件保存在本机 storage/api/。</p>
    </div>`;
  }
  const condition = activeFilterText();
  return `
  <div class="lb-empty">
    <span class="lb-empty__icon" aria-hidden="true">${icon("search")}</span>
    <p class="lb-empty__title">没有找到匹配的原图组</p>
    <p class="lb-empty__copy" role="status">
      当前条件：${condition ? esc(condition) : "全部"}。类型筛选会隐藏不匹配的组，组内仍保留全部版本；可缩短关键词或把条件改回「全部」。
    </p>
    <button class="btn btn--ghost btn--sm" type="button" data-act="clear">${icon("close")}清除筛选</button>
  </div>`;
}

function mediaHtml(asset, variant = "card") {
  if (!previewable(asset)) {
    const note = ARCHIVE_KINDS.has(asset.kind) ? "打包文件" : "无预览";
    return `<span class="lb-media__ph" aria-hidden="true">${icon("file")}<span>${note}</span></span>`;
  }
  return `<img class="${variant === "row" ? "lb-prow__img" : "plate__img lb-asset__img"}"
    src="${http.assetPreviewUrl(asset.asset_id)}" alt="" loading="lazy" decoding="async" />`;
}

function assetCardHtml(asset) {
  const license = licenseOf(asset);
  return `
  <li class="lb-assetli">
    <button class="lb-asset" type="button" data-open="${esc(asset.asset_id)}" data-kind="${esc(asset.kind)}"
      aria-haspopup="dialog" aria-expanded="false"
      title="${esc(`${kindLabel(asset.kind)} · ${dimsOf(asset)} · ${formatTime(asset.created_at, { withDate: true })}`)}">
      <span class="lb-asset__plate plate plate--grain">
        ${mediaHtml(asset)}
        <span class="lb-asset__grade" aria-hidden="true">${gradeStamp(asset.grade)}</span>
        <span class="lb-asset__hover" aria-hidden="true">
          <span class="lb-asset__hover-name">${esc(kindLabel(asset.kind))}</span>
          <span class="lb-asset__hover-row">${esc(dimsOf(asset))} · ${esc(formatBytes(asset.bytes))}</span>
          <span class="lb-asset__hover-cta">查看档案 ${icon("arrow")}</span>
        </span>
      </span>
      <span class="lb-asset__meta">
        <span class="lb-asset__name">${esc(kindLabel(asset.kind))}</span>
        <span class="lb-asset__sub mono">${esc(dimsOf(asset))} · ${esc(formatBytes(asset.bytes))}</span>
        <span class="lb-asset__tags">
          <span class="lb-tag${license.unset ? " lb-tag--warn" : ""}">${esc(license.text)}</span>
          <span class="lb-tag">${esc(relativeTime(asset.created_at))}</span>
        </span>
      </span>
    </button>
  </li>`;
}

function assetRowHtml(asset) {
  const license = licenseOf(asset);
  return `
  <li class="lb-prowli">
    <button class="lb-prow" type="button" data-open="${esc(asset.asset_id)}"
      aria-haspopup="dialog" aria-expanded="false">
      <span class="lb-prow__thumb">${mediaHtml(asset, "row")}</span>
      <span class="lb-prow__name">${esc(kindLabel(asset.kind))}</span>
      <span class="lb-prow__grade">${gradeStamp(asset.grade)}</span>
      <span class="lb-prow__license${license.unset ? " is-warn" : ""}">${esc(license.text)}</span>
      <span class="lb-prow__dims mono">${esc(dimsOf(asset))}</span>
      <span class="lb-prow__bytes mono">${esc(formatBytes(asset.bytes))}</span>
      <span class="lb-prow__time mono">${esc(relativeTime(asset.created_at))}</span>
    </button>
  </li>`;
}

export function patternGroupHtml(group) {
  const categories = group.categories || [];
  return `
  <section class="lb-pattern" data-pattern="${esc(group.image_id)}">
    <header class="lb-pattern__head">
      <div class="lb-pattern__title">
        <h3 class="lb-pattern__name">${esc(group.name || "未命名纹样")}</h3>
        <p class="mono lb-pattern__meta">#${esc(shortId(group.image_id))} · 登记 ${esc(
          formatTime(group.created_at, { withDate: true })
        )} · ${group.assets.length} 个版本</p>
      </div>
      <div class="lb-pattern__cats">
        ${
          categories.length
            ? categories
                .map(
                  (category) =>
                    `<button class="chip lb-chip lb-pattern__cat" type="button" data-act="cat-filter"
                      data-val="${esc(category.category_id)}" title="筛选题材 ${esc(category.name)}">${esc(category.name)}</button>`
                )
                .join("")
            : `<span class="lb-pattern__uncat">未归类</span>`
        }
        <button class="btn btn--quiet btn--sm" type="button" data-act="assign" data-image="${esc(group.image_id)}">
          ${icon("star")}归类
        </button>
      </div>
      <div class="lb-pattern__acts">
        <button class="btn btn--ghost btn--sm" type="button" data-act="pattern-workbench" data-image="${esc(group.image_id)}">
          ${icon("arrow")}在工作台打开
        </button>
        <button class="btn btn--ghost btn--sm" type="button" data-act="process-group" data-image="${esc(group.image_id)}">
          ${icon("play")}处理本组
        </button>
        <button class="btn btn--quiet btn--sm" type="button" data-act="pattern-export" data-image="${esc(group.image_id)}">
          ${icon("download")}导出本组
        </button>
      </div>
    </header>
    ${
      patterns().view === "list"
        ? `<ul class="lb-prows">${group.assets.map(assetRowHtml).join("")}</ul>`
        : `<ul class="lb-assets">${group.assets.map(assetCardHtml).join("")}</ul>`
    }
  </section>`;
}

function bodyHtml() {
  const lib = patterns();
  if (!loaded()) return loadingHtml();
  if (lib.loading && !lib.items.length) return loadingHtml();
  if (lib.error && !lib.items.length) return errorHtml(lib.error);
  const groups = displayedPatterns(lib.items, { grade: lib.grade, sort: lib.sort });
  if (!groups.length) return emptyHtml();
  return `<div class="lb-patterns">${groups.map(patternGroupHtml).join("")}</div>`;
}

function countHtml() {
  const lib = patterns();
  if (!loaded() || (lib.loading && !lib.items.length)) return "正在读取本机纹样库…";
  const groups = displayedPatterns(lib.items, { grade: lib.grade, sort: lib.sort });
  const flag = isFiltered() ? '<span class="lb-count__flag">已筛选</span>' : "";
  if (lib.loading) return `更新中… ${flag}`;
  return `命中 <span class="num">${groups.length}</span> 个原图组 / 已载入 <span class="num">${lib.items.length}</span> 组${flag}`;
}

function paintMore(page) {
  const wrap = page.querySelector("[data-lb-more]");
  if (!wrap) return;
  const lib = patterns();
  const show = lib.items.length > 0;
  wrap.hidden = !show;
  if (!show) return;
  const button = wrap.querySelector('[data-act="more"]');
  const note = wrap.querySelector("[data-more-note]");
  const hasMore = Boolean(lib.nextCursor);
  if (button) {
    button.disabled = lib.loading || !hasMore;
    button.textContent = lib.loading ? "载入中…" : hasMore ? "加载更多原图组" : "已全部载入";
    button.setAttribute("aria-busy", String(lib.loading));
  }
  if (note) {
    note.textContent = hasMore
      ? `已载入 ${lib.items.length} 个原图组 · 每页 ${PAGE_SIZE} 组 · 未载入的组不在当前选择与导出范围内`
      : `已载入 ${lib.items.length} 个原图组 · 没有更多了`;
  }
}

function paintFooter(page) {
  const foot = page.querySelector("[data-lb-foot]");
  if (!foot) return;
  const lib = patterns();
  const total = store.dataset ? store.dataset.total_images : "—";
  foot.innerHTML = `数据来自本机服务 · 已载入 <span class="num">${lib.items.length}</span> 个原图组 · 数据集共
    <span class="num">${esc(String(total))}</span> 张原图 · 每组包含全部处理版本`;
}

function paintFilters(page) {
  const lib = patterns();
  const kind = activeKind();
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
  paintCategories(page);
}

function paintCategories(page) {
  if (!page || !page.isConnected) return;
  const host = page.querySelector("[data-lb-cats]");
  if (!host) return;
  host.innerHTML = categoryBarHtml();
  if (catForm) page.querySelector("[data-cat-input]")?.focus({ preventScroll: true });
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
  if (title) title.textContent = isFiltered() ? "筛选结果" : "全部纹样";
  const clear = page.querySelector(".lb-clear");
  if (clear) clear.hidden = !isFiltered();
  paintMore(page);
  paintFooter(page);
}

/* ---------- 载入（最新查询优先） ---------- */

function setPendingUI(page, { append = false } = {}) {
  if (!page || !page.isConnected) return;
  if (!append && !patterns().items.length) {
    const body = page.querySelector("[data-lb-body]");
    if (body) body.innerHTML = loadingHtml();
    const count = page.querySelector("[data-lb-count]");
    if (count) count.innerHTML = "正在读取本机纹样库…";
  }
  paintMore(page);
}

async function requestPatterns(page, api, { append = false } = {}) {
  if (!page || !page.isConnected) return;
  const seq = ++paintSeq;
  setPendingUI(page, { append });
  await store.loadPatterns({ append });
  // 旧请求即使已返回，也只让最新一次绘制结果。
  if (seq !== paintSeq || !ctx || ctx.page !== page || !page.isConnected) return;
  paintStats(page);
  paintResults(page, { animate: !append });
  const error = patterns().error;
  if (error && patterns().items.length && ctx.lastError !== error) {
    ctx.lastError = error;
    api.toast(error, "warn");
  }
}

function scheduleSearch(page, api, value) {
  store.setPatternQuery({ q: value });
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = 0;
    requestPatterns(page, api);
  }, SEARCH_DEBOUNCE);
}

function clearFilters(page, api) {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = 0;
  }
  store.setPatternQuery({ q: "", kind: "", categoryId: "", grade: "全部" });
  const search = page.querySelector("[data-lb-q]");
  if (search) search.value = "";
  paintFilters(page);
  requestPatterns(page, api);
}

function triggerUpload(api) {
  const button = document.querySelector('[data-action="upload"]');
  if (button) {
    button.click();
    return;
  }
  api.toast("请使用页面顶部的「上传纹样」按钮", "info");
}

/* ---------- 分类操作 ---------- */

function resetCategoryForm() {
  catForm = null;
  if (catDeleteTimer) clearTimeout(catDeleteTimer);
  catDeleteTimer = 0;
  catDeletePending = "";
}

function focusCategoryInput(page) {
  page?.querySelector("[data-cat-input]")?.focus({ preventScroll: true });
}

async function saveCategoryForm(page, api) {
  if (!catForm) return;
  const input = page.querySelector("[data-cat-input]");
  const value = String(input?.value ?? catForm.value ?? "").trim();
  if (!value) {
    api.toast("分类名不能为空。", "warn");
    focusCategoryInput(page);
    return;
  }
  const mode = catForm.mode;
  const categoryId = catForm.id;
  const revision = Number(store.categoryById(categoryId)?.revision || 0);
  try {
    if (mode === "rename" && categoryId) {
      await store.renamePatternCategory(categoryId, value, revision);
      api.toast("分类已重命名。", "done");
    } else {
      await store.createPatternCategory(value);
      api.toast(`已创建题材分类「${value}」。`, "done");
    }
    catForm = null;
    paintFilters(page);
    paintResults(page, { animate: true });
  } catch (error) {
    if (error?.code === "STALE_REVISION") {
      await store.loadPatternCategories();
      catForm = null;
      paintFilters(page);
      api.toast("分类已被其他操作更新，已重新读取，请再试一次。", "warn");
      return;
    }
    if (error?.code === "CATEGORY_EXISTS") api.toast("已经有同名的题材分类。", "warn");
    else api.toast(error?.message || "分类保存失败。", "warn");
    focusCategoryInput(page);
  }
}

async function deleteCategory(page, api, categoryId) {
  const category = store.categoryById(categoryId);
  if (!category) return;
  try {
    await store.deletePatternCategory(categoryId, category.revision);
    resetCategoryForm();
    paintFilters(page);
    paintResults(page, { animate: true });
    api.toast(`已删除分类「${category.name}」；只解除归类，纹样与版本都保留。`, "done");
    if (!patterns().categoryId) requestPatterns(page, api);
  } catch (error) {
    if (error?.code === "STALE_REVISION") {
      await store.loadPatternCategories();
      resetCategoryForm();
      paintFilters(page);
      api.toast("分类已被其他操作更新，已重新读取。", "warn");
      return;
    }
    api.toast(error?.message || "删除分类失败。", "warn");
  }
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

function drawerBody(asset, pattern = null) {
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
      ${
        pattern
          ? `<span class="chip lb-drawer__version">所属原图 #${esc(shortId(pattern.image_id))} · ${esc(
              pattern.name || "未命名纹样"
            )}</span>`
          : ""
      }
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
    <p class="drawer-foot">字段来自本机资产记录；预览与下载直接读取本机文件。一个原图组可同时归入多个题材分类。</p>
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

function openAssetDrawer(asset, trigger, api, pattern = null) {
  const el = api.drawer({
    title: esc(kindLabel(asset.kind)),
    meta: `${esc(shortId(asset.asset_id))} · ${esc(formatTime(asset.created_at, { withDate: true }))}`,
    body: drawerBody(asset, pattern),
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

  const observer = new MutationObserver(() => {
    if (document.body.contains(el)) return;
    observer.disconnect();
    if (trigger && trigger.setAttribute) trigger.setAttribute("aria-expanded", "false");
  });
  const host = document.querySelector(".app");
  if (host) observer.observe(host, { childList: true });
}

function findLoadedAsset(assetId) {
  for (const group of patterns().items) {
    const asset = (group.assets || []).find((entry) => entry.asset_id === assetId);
    if (asset) return { asset, pattern: group };
  }
  return null;
}

/* ---------- 归类抽屉 ---------- */

async function openAssignDrawer(pattern, api) {
  if (!patterns().categories.length && !patterns().categoriesLoading) {
    await store.loadPatternCategories();
  }
  const categories = patterns().categories;
  const selected = new Set(pattern.category_ids || []);
  const body = `
    <p class="drawer-lead">同一张原图可以同时归入多个题材分类；保存会替换这一组的全部归类。删除分类只会解除归类，不删除纹样。</p>
    ${
      categories.length
        ? `<ul class="lb-assign">${categories
            .map(
              (category) => `<li>
                <label class="lb-assign__row">
                  <input type="checkbox" data-assign="${esc(category.category_id)}" ${
                    selected.has(category.category_id) ? "checked" : ""
                  } />
                  <span>${esc(category.name)}</span>
                  <span class="mono lb-assign__rev">修订 ${category.revision}</span>
                </label>
              </li>`
            )
            .join("")}</ul>`
        : `<p class="field__hint">还没有题材分类。先关闭这里，在筛选栏「新建分类」创建。</p>`
    }
    <div class="drawer-actions">
      <button class="btn btn--primary btn--sm" type="button" data-assign-save${categories.length ? "" : " disabled"}>
        ${icon("check")}保存归类
      </button>
      <button class="btn btn--quiet btn--sm" type="button" data-assign-cancel>取消</button>
    </div>
    <p class="drawer-foot">保存时使用该组当前修订号 ${Number(pattern.revision) || 0}；若已被其他窗口更新，会提示重新读取。</p>
  `;
  const el = api.drawer({
    title: `归类 · ${esc(pattern.name || "未命名纹样")}`,
    meta: `#${esc(shortId(pattern.image_id))} · 可同时属于多个分类`,
    body,
  });
  if (!el) return;
  el.addEventListener("click", async (event) => {
    if (event.target.closest("[data-assign-cancel]")) {
      api.closeDrawer();
      return;
    }
    const save = event.target.closest("[data-assign-save]");
    if (!save) return;
    const ids = [...el.querySelectorAll("[data-assign]")].filter((input) => input.checked).map((input) => input.dataset.assign);
    save.disabled = true;
    try {
      await store.setPatternCategoriesFor(pattern.image_id, ids, Number(pattern.revision) || 0);
      api.closeDrawer();
      paintResults(ctx?.page, { animate: true });
      api.toast(ids.length ? `已归入 ${ids.length} 个题材分类。` : "已清除这张原图的全部归类。", "done");
    } catch (error) {
      save.disabled = false;
      if (error?.code === "STALE_REVISION") {
        try {
          const fresh = await http.pattern(pattern.image_id);
          store.replacePattern(fresh);
          paintResults(ctx?.page, { animate: true });
        } catch {
          /* 读取失败时保留抽屉，让用户重试 */
        }
        api.toast("这一组的归类已被其他操作更新，已重新读取后再试。", "warn");
        return;
      }
      if (error?.code === "CATEGORY_NOT_FOUND") await store.loadPatternCategories();
      api.toast(error?.message || "归类保存失败。", "warn");
    }
  });
}

/* ---------- 批量导出 ---------- */

function exportGroups(groups) {
  return groups.map((group) => ({
    imageId: group.image_id,
    name: group.name,
    current: false,
    assets: group.assets || [],
  }));
}

function openExportFor(groups, scopeNote, api) {
  if (!groups.length) {
    api.toast("当前没有可导出的原图组。", "info");
    return;
  }
  openBatchExport({ api, groups: exportGroups(groups), scopeNote });
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
  const openId = (params && params.get("open")) || patterns().openId || "";
  if (!openId) return;
  patterns().openId = "";
  try {
    const asset = await http.asset(openId);
    if (!ctx || ctx.page !== page) return;
    const found = findLoadedAsset(openId);
    openAssetDrawer(asset, null, api, found?.pattern || null);
  } catch (error) {
    if (ctx && ctx.page === page) {
      const missing = error?.status === 404 || error?.status === 422;
      api.toast(missing ? "没有找到这个资产（编号无效或已删除）" : error?.message || "无法打开这个资产", "warn");
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

    /* 统一事件委托：筛选、分类、分页、重试、上传、导出、打开档案 */
    page.addEventListener("click", async (event) => {
      const hit = event.target.closest("[data-open], [data-act]");
      if (!hit || !page.contains(hit)) return;

      if (hit.dataset.open) {
        const found = findLoadedAsset(hit.dataset.open);
        if (found) {
          openAssetDrawer(found.asset, hit, api, found.pattern);
          return;
        }
        try {
          const asset = await http.asset(hit.dataset.open);
          openAssetDrawer(asset, hit, api);
        } catch (error) {
          api.toast(error?.message || "无法打开这个资产", "warn");
        }
        return;
      }

      switch (hit.dataset.act) {
        case "kind": {
          const filter = KIND_FILTERS.find((item) => item.label === hit.dataset.val) || KIND_FILTERS[0];
          store.setPatternQuery({ kind: filter.kind });
          paintFilters(page);
          requestPatterns(page, api);
          break;
        }
        case "grade":
          store.setPatternQuery({ grade: hit.dataset.val });
          paintFilters(page);
          paintResults(page, { animate: true });
          break;
        case "view":
          store.setPatternQuery({ view: hit.dataset.val });
          paintFilters(page);
          paintResults(page, { animate: true });
          break;
        case "clear":
          clearFilters(page, api);
          break;
        case "more":
          requestPatterns(page, api, { append: true });
          paintMore(page);
          break;
        case "retry":
          requestPatterns(page, api);
          break;
        case "upload":
          triggerUpload(api);
          break;
        case "cat-filter":
          store.setPatternQuery({ categoryId: hit.dataset.val || "" });
          paintFilters(page);
          requestPatterns(page, api);
          break;
        case "cat-new":
          catForm = { mode: "create", id: "", value: "" };
          paintCategories(page);
          focusCategoryInput(page);
          break;
        case "cat-manage":
          catManage = !catManage;
          if (!catManage) catForm = null;
          paintCategories(page);
          break;
        case "cat-rename":
          catForm = {
            mode: "rename",
            id: hit.dataset.id,
            value: store.categoryById(hit.dataset.id)?.name || "",
          };
          paintCategories(page);
          focusCategoryInput(page);
          break;
        case "cat-cancel":
          resetCategoryForm();
          paintCategories(page);
          break;
        case "cat-save":
          saveCategoryForm(page, api);
          break;
        case "cat-reload":
          await store.loadPatternCategories();
          paintFilters(page);
          break;
        case "cat-delete": {
          const id = hit.dataset.id;
          if (catDeletePending !== id) {
            catDeletePending = id;
            if (catDeleteTimer) clearTimeout(catDeleteTimer);
            catDeleteTimer = setTimeout(() => {
              catDeletePending = "";
              catDeleteTimer = 0;
              paintCategories(page);
            }, 4000);
            paintCategories(page);
            break;
          }
          if (catDeleteTimer) clearTimeout(catDeleteTimer);
          catDeleteTimer = 0;
          catDeletePending = "";
          deleteCategory(page, api, id);
          break;
        }
        case "assign": {
          const pattern = patterns().items.find((item) => item.image_id === hit.dataset.image);
          if (pattern) openAssignDrawer(pattern, api);
          break;
        }
        case "pattern-workbench":
          api.go("workbench", { query: { image: hit.dataset.image, stage: 1 } });
          break;
        case "process-batch": {
          const groups = displayedPatterns(patterns().items, {
            grade: patterns().grade,
            sort: patterns().sort,
          });
          // 库里的批处理默认勾选当前已载入的组；用户可在浮窗里逐个取消。
          openRunDialog({
            groups,
            preselectedImageIds: groups.map((pattern) => pattern.image_id),
            sourceLabel: "纹样库 · 批量处理",
          });
          break;
        }
        case "process-group": {
          const pattern = patterns().items.find((item) => item.image_id === hit.dataset.image);
          if (pattern) {
            openRunDialog({
              groups: [pattern],
              preselectedImageIds: [pattern.image_id],
              sourceLabel: "纹样库 · 处理本组",
            });
          }
          break;
        }
        case "pattern-export": {
          const pattern = patterns().items.find((item) => item.image_id === hit.dataset.image);
          if (pattern) {
            openExportFor([pattern], `本组「${pattern.name || "未命名纹样"}」的 ${pattern.assets.length} 个版本`, api);
          }
          break;
        }
        case "export-loaded": {
          const groups = displayedPatterns(patterns().items, {
            grade: patterns().grade,
            sort: patterns().sort,
          });
          openExportFor(
            groups,
            `本次已载入且当前筛选可见的 ${groups.length} 个原图组（不含未载入分页）`,
            api
          );
          break;
        }
        default:
          break;
      }
    });

    page.addEventListener("keydown", (event) => {
      const input = event.target.closest("[data-cat-input]");
      if (!input) return;
      if (event.key === "Enter") {
        event.preventDefault();
        saveCategoryForm(page, api);
      } else if (event.key === "Escape") {
        event.preventDefault();
        resetCategoryForm();
        paintCategories(page);
      }
    });

    /* 搜索：中文组字期间不打断候选，停下来 250ms 后再回源 */
    const search = page.querySelector("[data-lb-q]");
    if (search) {
      search.addEventListener("input", () => {
        if (composing) return;
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
        store.setPatternQuery({ q: "" });
        requestPatterns(page, api);
        paintFilters(page);
      });
    }

    /* 组内排序与视图只重排已载入项，不发请求 */
    const sort = page.querySelector("[data-lb-sort]");
    if (sort) {
      sort.addEventListener("change", () => {
        store.setPatternQuery({ sort: sort.value });
        paintResults(page, { animate: true });
      });
    }

    (async () => {
      const loading = requestPatterns(page, api);
      const dataset = store.loadDataset();
      const categories = store.loadPatternCategories();
      await loading;
      if (!ctx || ctx.page !== page) return;
      paintStats(page);
      await dataset;
      if (!ctx || ctx.page !== page) return;
      paintStats(page);
      await categories;
      if (!ctx || ctx.page !== page) return;
      paintCategories(page);
      await openDeepLinkedAsset(page, api, params);
    })();
  },

  unmount() {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = 0;
    }
    if (catDeleteTimer) {
      clearTimeout(catDeleteTimer);
      catDeleteTimer = 0;
    }
    composing = false;
    catManage = false;
    catForm = null;
    catDeletePending = "";
    ctx = null;
  },
};

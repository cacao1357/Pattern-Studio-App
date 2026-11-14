/* =============================================================================
   views/pattern-picker.js — 「添加纹样到工作台」浮窗。
   边界：
   - 数据来自 /api/v1/patterns（纹样库全量索引），只读；勾选并确认后才写
     /api/v1/workbench/items，加入的是用户明确选择的组。
   - 已在工作台的组显示为「已加入」，不能重复勾选。
   - 浮窗只负责选择与提交，不改写会话；成功后的列表合并由调用方完成。
   ============================================================================= */

import { api } from "../api.js";
import { icon } from "../icons.js";
import { escapeHtml as esc, formatTime, shortId } from "../format.js";
import { MAX_WORKBENCH_SELECTION } from "../batch.js";

const modal = {
  el: null,
  existing: new Set(),
  selected: new Set(),
  items: [],
  byId: new Map(),
  nextCursor: null,
  query: "",
  loading: false,
  error: "",
  adding: false,
  seq: 0,
  searchTimer: 0,
  returnFocus: null,
  keyHandler: null,
  onAdd: null,
};

const originalAsset = (item) =>
  (item.assets || []).find((asset) => asset.asset_id === item.original_asset_id) ||
  (item.assets || []).find((asset) => asset.kind === "original") ||
  null;

function itemHtml(item) {
  const added = modal.existing.has(item.image_id);
  const checked = modal.selected.has(item.image_id);
  const original = originalAsset(item);
  const preview =
    original && !["zip", "export", "archive"].includes(original.kind)
      ? `<img src="${api.assetPreviewUrl(original.asset_id)}" alt="" loading="lazy" decoding="async" />`
      : `<span class="pp-item__file" aria-hidden="true">${icon("file")}</span>`;
  const categories = (item.categories || []).map((entry) => entry.name).join("、");
  const meta = [`#${shortId(item.image_id)}`, `${(item.assets || []).length} 个版本`];
  if (categories) meta.push(categories);
  if (item.created_at) meta.push(formatTime(item.created_at, { withDate: true }));
  return `
  <label class="pp-item${added ? " is-added" : ""}${checked ? " is-checked" : ""}" data-pp-row="${esc(item.image_id)}">
    <input type="checkbox" data-pp-item="${esc(item.image_id)}" ${checked ? "checked" : ""}
      ${added ? "disabled" : ""} aria-label="${esc(`选择 ${item.name || "未命名纹样"}`)}" />
    <span class="pp-check" aria-hidden="true">${icon("check")}</span>
    <span class="pp-item__thumb plate plate--grain">${preview}</span>
    <span class="pp-item__text">
      <span class="pp-item__name">${esc(item.name || "未命名纹样")}</span>
      <span class="pp-item__meta mono">${esc(meta.join(" · "))}</span>
    </span>
    ${added ? `<span class="pp-item__added">已在工作台</span>` : ""}
  </label>`;
}

function listHtml() {
  if (modal.loading && !modal.items.length) {
    return `<p class="pp-state" role="status">正在读取纹样库…</p>`;
  }
  if (modal.error && !modal.items.length) {
    return `<div class="pp-state pp-state--error" role="alert">
      <p>${esc(modal.error)}</p>
      <button class="btn btn--quiet btn--sm" type="button" data-pp-act="retry">${icon("history")}重试</button>
    </div>`;
  }
  if (!modal.items.length) {
    return `<p class="pp-state">${modal.query ? "没有匹配的纹样，换个关键词试试。" : "纹样库还没有可添加的纹样。"}</p>`;
  }
  return `<div class="pp-items">${modal.items.map(itemHtml).join("")}</div>`;
}

function paint() {
  if (!modal.el) return;
  const list = modal.el.querySelector("[data-pp-list]");
  if (list) list.innerHTML = listHtml();
  const count = modal.el.querySelector("[data-pp-count]");
  if (count) count.textContent = `已选 ${modal.selected.size} / ${MAX_WORKBENCH_SELECTION}`;
  const add = modal.el.querySelector("[data-pp-act='add']");
  if (add) {
    add.disabled = modal.adding || modal.selected.size === 0;
    add.textContent = modal.adding ? "正在加入…" : `加入工作台${modal.selected.size ? `（${modal.selected.size}）` : ""}`;
  }
  const all = modal.el.querySelector("[data-pp-act='all']");
  if (all) {
    all.disabled = modal.adding || !modal.items.some((item) => !modal.existing.has(item.image_id));
  }
  const more = modal.el.querySelector("[data-pp-more]");
  if (more) more.hidden = !modal.nextCursor || modal.loading;
  const error = modal.el.querySelector("[data-pp-error]");
  if (error) {
    error.textContent = modal.error && modal.items.length ? modal.error : "";
    error.hidden = !error.textContent;
  }
}

async function loadPage({ append = false } = {}) {
  modal.loading = true;
  modal.error = "";
  const seq = ++modal.seq;
  paint();
  try {
    const page = await api.patterns({
      limit: 20,
      cursor: append ? modal.nextCursor || "" : "",
      q: modal.query,
    });
    if (seq !== modal.seq || !modal.el) return;
    const items = (page?.items || []).filter((item) => item?.image_id);
    if (!append) {
      modal.items = items;
      // 已勾选项可能来自上一次搜索：保留其对象，提交时仍能加入工作台。
      for (const item of items) modal.byId.set(item.image_id, item);
    } else {
      const seen = new Set(modal.items.map((item) => item.image_id));
      for (const item of items) {
        if (seen.has(item.image_id)) continue;
        modal.items.push(item);
        modal.byId.set(item.image_id, item);
      }
    }
    modal.nextCursor = page?.next_cursor || null;
  } catch (error) {
    if (seq !== modal.seq) return;
    modal.error = error?.message || "纹样库读取失败，请稍后重试。";
  } finally {
    if (seq === modal.seq) {
      modal.loading = false;
      paint();
    }
  }
}

function scheduleSearch() {
  if (modal.searchTimer) clearTimeout(modal.searchTimer);
  modal.searchTimer = setTimeout(() => {
    modal.searchTimer = 0;
    modal.nextCursor = null;
    loadPage({ append: false });
  }, 250);
}

function close() {
  if (!modal.el) return;
  if (modal.searchTimer) clearTimeout(modal.searchTimer);
  modal.searchTimer = 0;
  modal.seq += 1;
  if (modal.keyHandler) document.removeEventListener("keydown", modal.keyHandler);
  modal.keyHandler = null;
  modal.el.remove();
  const focus = modal.returnFocus;
  modal.el = null;
  modal.items = [];
  modal.byId = new Map();
  modal.selected = new Set();
  modal.existing = new Set();
  modal.nextCursor = null;
  modal.error = "";
  modal.loading = false;
  modal.adding = false;
  modal.query = "";
  modal.onAdd = null;
  modal.returnFocus = null;
  if (focus && typeof focus.focus === "function") focus.focus({ preventScroll: true });
}

async function submit() {
  if (modal.adding || !modal.selected.size) return;
  const items = [...modal.selected].map((imageId) => modal.byId.get(imageId)).filter(Boolean);
  if (!items.length) return;
  modal.adding = true;
  modal.error = "";
  paint();
  try {
    await modal.onAdd?.(items);
    close();
  } catch (error) {
    modal.adding = false;
    modal.error = error?.message || "加入工作台失败，请稍后再试。";
    paint();
  }
}

function bind() {
  modal.el.addEventListener("click", (event) => {
    const hit = event.target.closest("[data-pp-act], [data-pp-close]");
    if (!hit || !modal.el.contains(hit)) return;
    if (hit.hasAttribute("data-pp-close")) {
      close();
      return;
    }
    switch (hit.dataset.ppAct) {
      case "add":
        submit();
        break;
      case "cancel":
        close();
        break;
      case "retry":
        loadPage({ append: false });
        break;
      case "more":
        loadPage({ append: true });
        break;
      case "all": {
        const addable = modal.items.filter((item) => !modal.existing.has(item.image_id));
        if (modal.selected.size >= MAX_WORKBENCH_SELECTION) break;
        modal.selected = new Set(
          [...modal.selected, ...addable.map((item) => item.image_id)].slice(0, MAX_WORKBENCH_SELECTION)
        );
        paint();
        break;
      }
      default:
        break;
    }
  });
  modal.el.addEventListener("change", (event) => {
    const input = event.target.closest("[data-pp-item]");
    if (!input) return;
    const imageId = input.dataset.ppItem || "";
    if (!imageId || modal.existing.has(imageId)) return;
    if (input.checked) {
      if (modal.selected.size >= MAX_WORKBENCH_SELECTION) {
        input.checked = false;
        modal.error = `一次最多加入 ${MAX_WORKBENCH_SELECTION} 张纹样。`;
        paint();
        return;
      }
      modal.selected.add(imageId);
    } else {
      modal.selected.delete(imageId);
    }
    modal.error = "";
    paint();
  });
  const search = modal.el.querySelector("[data-pp-search]");
  search?.addEventListener("input", () => {
    modal.query = search.value.trim();
    scheduleSearch();
  });
  modal.keyHandler = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  document.addEventListener("keydown", modal.keyHandler);
  requestAnimationFrame(() => search?.focus({ preventScroll: true }));
}

/** 打开选择浮窗；onAdd 收到完整纹样对象，需自行完成服务端写入。 */
export function openPatternPicker({ existing = [], onAdd = null } = {}) {
  if (modal.el) return false;
  modal.existing = new Set(existing || []);
  modal.selected = new Set();
  modal.items = [];
  modal.byId = new Map();
  modal.nextCursor = null;
  modal.query = "";
  modal.loading = false;
  modal.error = "";
  modal.adding = false;
  modal.onAdd = onAdd;
  modal.returnFocus = typeof document !== "undefined" ? document.activeElement : null;
  const layer = document.createElement("div");
  layer.className = "pp-layer";
  layer.dataset.ppLayer = "";
  layer.innerHTML = `
  <div class="pp" role="dialog" aria-modal="true" aria-labelledby="pp-title">
    <header class="pp__head">
      <div>
        <p class="eyebrow">工作台</p>
        <h2 class="pp__title" id="pp-title">添加纹样</h2>
        <p class="pp__lead">纹样库保持完整；只有勾选的组会出现在工作台并跨刷新保留。</p>
      </div>
      <button class="icon-btn pp__close" type="button" data-pp-close aria-label="关闭">${icon("close")}</button>
    </header>
    <label class="pp__search">
      ${icon("search")}
      <input class="input" type="search" data-pp-search placeholder="搜索名称、来源、类型或资产编号…"
        autocomplete="off" spellcheck="false" aria-label="搜索纹样" />
    </label>
    <p class="pp__error" data-pp-error role="alert" hidden></p>
    <div class="pp__list" data-pp-list></div>
    <button class="btn btn--quiet btn--sm btn--block pp__more" type="button" data-pp-more data-pp-act="more" hidden>
      载入更多纹样
    </button>
    <footer class="pp__foot">
      <span class="mono pp__count" data-pp-count>已选 0 / ${MAX_WORKBENCH_SELECTION}</span>
      <span class="pp__acts">
        <button class="btn btn--quiet btn--sm" type="button" data-pp-act="all">全选已载入</button>
        <button class="btn btn--quiet btn--sm" type="button" data-pp-act="cancel">取消</button>
        <button class="btn btn--primary btn--sm" type="button" data-pp-act="add" disabled>加入工作台</button>
      </span>
    </footer>
  </div>`;
  modal.el = layer;
  document.body.appendChild(layer);
  layer.addEventListener("mousedown", (event) => {
    if (event.target === layer) close();
  });
  bind();
  paint();
  loadPage({ append: false });
  return true;
}

export function isPatternPickerOpen() {
  return Boolean(modal.el);
}

/** 路由离开时关闭浮窗，避免它压在新页面上。 */
export function closePatternPicker() {
  if (modal.el) close();
}

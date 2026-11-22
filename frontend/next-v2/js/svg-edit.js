/* =============================================================================
   svg-edit.js — SVG 图形级编辑：按视觉独立图形选择、移动、删除、撤销/重做、保存新版本。
   契约：docs/contracts/svg-editing-contract.md（消费者依据，不另建接口）
   - 只消费 GET /assets/{id}/svg-elements 的受控字段，路径只写入 d/fill/
     fill-rule/transform 等白名单属性，不插入未经检查的原始 SVG。
   - 草稿按当前 SVG 纹样隔离；编辑只改 DOM 预览，保存时经 /jobs/edit-svg
     发布新的 SVG 纹样，原文件不变。
   - 本模块不直接提交任务：保存回调由工作台注入，沿用现有任务条、取消与错误文案。
   ============================================================================= */

import { api as http } from "./api.js";
import { escapeHtml, formatTime, kindLabel, shortId } from "./format.js";
import { icon } from "./icons.js";
import { store } from "./store.js";

/** 与契约一致：单次最多 2000 个元素变化。 */
export const SVG_EDIT_MAX_CHANGES = 2000;
/** 每个纹样保留的撤销步数；只存 edits 快照，不复制路径数据。 */
const HISTORY_LIMIT = 60;
/** 同时保留的 SVG 草稿数；只回收无改动的旧草稿，绝不静默丢弃未保存改动。 */
const DRAFT_LIMIT = 24;

const SHA256 = /^[a-f0-9]{64}$/i;
const ELEMENT_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const round = (value) => Math.round(Number(value) || 0);
const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const esc = (value) => escapeHtml(value);

/** 草稿按纹样 id 隔离：切换纹样再回来，未保存改动仍在。 */
const drafts = new Map();
const loadState = { seq: 0, loadingAssetId: "", errorAssetId: "", error: "" };
const historyState = { imageId: "", items: [], loading: false, error: "", loadedAt: 0, seq: 0 };
/** 已尝试补齐来源链的纹样（按会话令牌），避免每次重绘重复请求；换会话后可重试。 */
const sourceChecked = new Map();
const sourceFetches = new Set();
let historyPick = "";
let mountedRoot = null;
let onChange = null;
let saveHandler = null;
let apiRef = null;
let beforeUnload = null;
let navGuard = null;
let keyHandler = null;
let drag = null;
let externalBusy = false;

/* ------------------------------------------------------------------ 解析与草稿 */

function normalizeBbox(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const values = raw.map((value) => Number(value));
  if (!values.every(Number.isFinite)) return null;
  const [left, top, right, bottom] = values;
  if (right <= left || bottom <= top) return null;
  return [left, top, right, bottom];
}

/**
 * 解析 svg-elements 响应。只接受契约里的字段；缺少画布尺寸或输入指纹时拒绝，
 * 避免在不知道来源版本的情况下保存。
 */
export function parseSvgElements(payload, { assetId = "" } = {}) {
  if (!payload || typeof payload !== "object") throw new Error("SVG 图形数据为空。");
  const width = num(payload.width);
  const height = num(payload.height);
  if (!(width > 0) || !(height > 0)) throw new Error("SVG 图形数据缺少有效的画布尺寸。");
  const sourceSha256 = String(payload.source_sha256 || "").trim().toLowerCase();
  if (!SHA256.test(sourceSha256)) {
    throw new Error("这段 SVG 缺少来源校验信息，不能安全保存；请重新读取后再编辑。");
  }
  const returnedId = String(payload.asset_id || "").trim();
  if (assetId && returnedId && returnedId !== assetId) {
    throw new Error("返回的 SVG 图形不属于当前纹样，已停止加载。");
  }
  if (!Array.isArray(payload.elements)) {
    throw new Error("SVG 图形数据缺少可读取的图形列表。");
  }
  const seen = new Set();
  const elements = [];
  for (const raw of payload.elements) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id || "").trim();
    if (!ELEMENT_ID.test(id) || seen.has(id)) continue;
    const d = String(raw.d || "").trim();
    if (!d) continue;
    seen.add(id);
    elements.push({
      id,
      d,
      fill: String(raw.fill || "#000000"),
      fillRule: String(raw.fill_rule || ""),
      transform: String(raw.transform || ""),
      bbox: normalizeBbox(raw.bbox),
    });
  }
  // 空白 SVG 是合法的已保存版本（允许删除全部元素后保存）；只有“返回了元素但没有一个可用”
  // 才视为数据损坏，避免把删空后的画布误报成读取失败。
  if (payload.elements.length && !elements.length) {
    throw new Error("这个 SVG 返回的图形都缺少可用的 id 或路径数据。");
  }
  return {
    assetId: returnedId || String(assetId || ""),
    sourceSha256,
    version: String(payload.version || ""),
    width,
    height,
    elements,
  };
}

export function createSvgDraft(parsed) {
  return {
    assetId: parsed.assetId,
    sourceSha256: parsed.sourceSha256,
    version: parsed.version || "",
    width: parsed.width,
    height: parsed.height,
    elements: parsed.elements,
    edits: {},
    selection: [],
    past: [],
    future: [],
  };
}

/** 把响应装入按纹样隔离的草稿表；返回新草稿。 */
export function adoptSvgPayload(asset, payload) {
  const parsed = parseSvgElements(payload, { assetId: asset?.asset_id || "" });
  const key = parsed.assetId || String(asset?.asset_id || "");
  if (!key) throw new Error("SVG 纹样缺少 asset_id。");
  parsed.assetId = key;
  const draft = createSvgDraft(parsed);
  drafts.set(key, draft);
  trimDrafts(key);
  return draft;
}

function trimDrafts(keepId) {
  if (drafts.size <= DRAFT_LIMIT) return;
  for (const [id, candidate] of drafts) {
    if (id === keepId) continue;
    if (!hasChanges(candidate)) {
      drafts.delete(id);
      return;
    }
  }
}

export function draftFor(assetId) {
  return drafts.get(String(assetId || "")) || null;
}

export function currentSvgDraft() {
  return draftFor(store.currentAsset()?.asset_id || "");
}

export function discardSvgDraft(assetId) {
  if (!assetId) return false;
  return drafts.delete(String(assetId));
}

export function discardAllSvgDrafts() {
  const count = drafts.size;
  drafts.clear();
  historyPick = "";
  return count;
}

/* ------------------------------------------------------------------ 编辑与历史 */

const cloneEdits = (edits) => {
  const out = {};
  for (const [id, edit] of Object.entries(edits || {})) {
    out[id] = { dx: num(edit.dx), dy: num(edit.dy), deleted: Boolean(edit.deleted) };
  }
  return out;
};

const isChanged = (edit) => Boolean(edit && (round(edit.dx) || round(edit.dy) || edit.deleted));

function normalizeEdits(edits) {
  const out = {};
  for (const [id, edit] of Object.entries(edits || {})) {
    const next = { dx: round(edit.dx), dy: round(edit.dy), deleted: Boolean(edit.deleted) };
    if (next.dx || next.dy || next.deleted) out[id] = next;
  }
  return out;
}

function pushHistory(draft) {
  draft.past.push(cloneEdits(draft.edits));
  if (draft.past.length > HISTORY_LIMIT) draft.past.shift();
  draft.future = [];
}

export function hasChanges(draft) {
  if (!draft) return false;
  return Object.values(draft.edits || {}).some(isChanged);
}

export function changeCount(draft) {
  if (!draft) return 0;
  return Object.values(draft.edits || {}).filter(isChanged).length;
}

export function deletedCount(draft) {
  if (!draft) return 0;
  return Object.values(draft.edits || {}).filter((edit) => edit?.deleted).length;
}

export function selectedCount(draft) {
  return Array.isArray(draft?.selection) ? draft.selection.length : 0;
}

export function canUndo(draft) {
  return Boolean(draft?.past?.length);
}

export function canRedo(draft) {
  return Boolean(draft?.future?.length);
}

/** 已保存/已加载的图形是否有这个 id。 */
export function hasElement(draft, id) {
  return Boolean(draft?.elements?.some((element) => element.id === id));
}

/** 对一组视觉独立图形叠加累计像素平移；推进一次撤销历史。返回实际改动的图形数。 */
export function applyTranslation(draft, ids, dx, dy) {
  if (!draft) return 0;
  const moveX = round(dx);
  const moveY = round(dy);
  if (!moveX && !moveY) return 0;
  const valid = [...new Set(Array.isArray(ids) ? ids : [])].filter((id) => hasElement(draft, id));
  if (!valid.length) return 0;
  pushHistory(draft);
  for (const id of valid) {
    const previous = draft.edits[id] || { dx: 0, dy: 0, deleted: false };
    draft.edits[id] = {
      dx: round(previous.dx) + moveX,
      dy: round(previous.dy) + moveY,
      deleted: Boolean(previous.deleted),
    };
  }
  draft.edits = normalizeEdits(draft.edits);
  return valid.length;
}

/** 标记删除或恢复一组图形；推进一次撤销历史。 */
export function applyDeleted(draft, ids, deleted = true) {
  if (!draft) return 0;
  const valid = [...new Set(Array.isArray(ids) ? ids : [])].filter((id) => hasElement(draft, id));
  if (!valid.length) return 0;
  pushHistory(draft);
  for (const id of valid) {
    const previous = draft.edits[id] || { dx: 0, dy: 0, deleted: false };
    draft.edits[id] = {
      dx: round(previous.dx),
      dy: round(previous.dy),
      deleted: Boolean(deleted),
    };
  }
  draft.edits = normalizeEdits(draft.edits);
  return valid.length;
}

/** 清掉某个图形的改动（位移与删除一起恢复）。 */
export function resetElementEdit(draft, id) {
  if (!draft?.edits?.[id]) return false;
  pushHistory(draft);
  delete draft.edits[id];
  draft.selection = draft.selection.filter((entry) => entry !== id);
  return true;
}

/** 放弃全部改动但保留图形与草稿（可继续编辑）。 */
export function resetDraftEdits(draft) {
  if (!draft || !hasChanges(draft)) return false;
  pushHistory(draft);
  draft.edits = {};
  draft.selection = [];
  return true;
}

export function undoDraft(draft) {
  if (!draft?.past?.length) return false;
  draft.future.push(cloneEdits(draft.edits));
  draft.edits = draft.past.pop();
  draft.selection = draft.selection.filter((id) => hasElement(draft, id));
  return true;
}

export function redoDraft(draft) {
  if (!draft?.future?.length) return false;
  draft.past.push(cloneEdits(draft.edits));
  draft.edits = draft.future.pop();
  draft.selection = draft.selection.filter((id) => hasElement(draft, id));
  return true;
}

/** 改动清单：按原 SVG 中的出现顺序返回，便于面板定位。 */
export function changedElements(draft) {
  if (!draft) return [];
  const rows = [];
  for (const element of draft.elements) {
    const edit = draft.edits[element.id];
    if (isChanged(edit)) rows.push({ element, edit: { ...edit } });
  }
  return rows;
}

/* ------------------------------------------------------------------ 保存请求 */

export function validateSvgSave(draft) {
  if (!draft) return "还没有读取到可编辑的 SVG 图形。";
  if (!SHA256.test(String(draft.sourceSha256 || ""))) {
    return "缺少来源校验信息，不能安全保存；请重新读取这个 SVG。";
  }
  if (!hasChanges(draft)) return "还没有改动；先选择、移动或删除图形。";
  const count = changeCount(draft);
  if (count > SVG_EDIT_MAX_CHANGES) {
    return `本次有 ${count} 个图形变化，超过单次 ${SVG_EDIT_MAX_CHANGES} 个的上限；请分批保存，前端不会删除结构或降低质量。`;
  }
  return "";
}

/**
 * edit-svg 请求体：只发送实际变化的元素；dx/dy 是相对该输入图形的累计像素平移。
 * 不携带 SVG 文本、路径内容或任意属性。
 */
export function buildEditSvgPayload(draft) {
  const edits = changedElements(draft).map(({ element, edit }) => ({
    element_id: element.id,
    dx: round(edit.dx),
    dy: round(edit.dy),
    deleted: Boolean(edit.deleted),
  }));
  return {
    input_asset_id: draft?.assetId || "",
    source_sha256: String(draft?.sourceSha256 || ""),
    edits,
  };
}

/** 提交时的改动快照签名：保存返回后只有草稿仍与它一致，才清空未保存标记。 */
export function editsSignature(draft) {
  return JSON.stringify(
    changedElements(draft).map(({ element, edit }) => [
      element.id,
      round(edit.dx),
      round(edit.dy),
      Boolean(edit.deleted),
    ])
  );
}

/* ------------------------------------------------------------------ 受控 SVG 输出 */

const attr = (name, value) => (value ? ` ${name}="${esc(value)}"` : "");
const TRANSLATE = /^translate\(\s*([+\-\d.eE]+)(?:[\s,]+([+\-\d.eE]+))?\s*\)$/;

/** 后端返回的 transform 只允许累计 translate；解析失败时保留原始字符串做兼容。 */
function parseTranslation(value) {
  const text = String(value || "").trim();
  if (!text) return { x: 0, y: 0 };
  const match = TRANSLATE.exec(text);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2] || 0);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function formatNumber(value) {
  const number = Number(value);
  return Object.is(number, -0) ? "0" : String(number);
}

function translateAttr(translation) {
  return `translate(${formatNumber(translation.x)},${formatNumber(translation.y)})`;
}

/**
 * 当前元素的有效绘制变换。前端预览与后端保存都按“原累计平移 + 编辑位移”
 * 计算同一份坐标，保证同源同变换的组件能稳定合并。
 */
export function effectiveTransform(element, edit = null) {
  const dx = round(edit?.dx);
  const dy = round(edit?.dy);
  const base = parseTranslation(element?.transform);
  if (base) return translateAttr({ x: base.x + dx, y: base.y + dy });
  // 契约之外的历史 transform：不猜测含义，保留原值并追加平移。
  const delta = dx || dy ? `translate(${dx} ${dy})` : "";
  return [String(element?.transform || ""), delta].filter(Boolean).join(" ");
}

/** 同一原始 path 的 p 前缀；与后端 apply_edits 的 id.split("c")[0] 保持一致。 */
export function sourcePathKey(element) {
  return String(element?.id || "").split("c")[0];
}

/**
 * 实际填色绘制层：同一原始 path（p 前缀）、相同累计平移、相同填色与填充规则
 * 的组件合并成一条 <path>，避免分开绘制造成亚像素抗锯齿差异。
 * 组顺序按元素首次出现顺序，与后端保存顺序一致。
 */
export function mergedDrawMarkup(draft, previewEdits = null) {
  if (!draft) return "";
  const groups = new Map();
  for (const element of draft.elements) {
    const edit = previewEdits?.[element.id] || draft.edits[element.id] || null;
    if (edit?.deleted) continue;
    const transform = effectiveTransform(element, edit);
    const fill = element.fill || "#000000";
    const fillRule = element.fillRule || "";
    const key = `${sourcePathKey(element)}\u0000${transform}\u0000${fill}\u0000${fillRule}`;
    let group = groups.get(key);
    if (!group) {
      group = { fill, fillRule, transform, paths: [] };
      groups.set(key, group);
    }
    group.paths.push(element.d);
  }
  return [...groups.values()]
    .map(
      (group) =>
        `<path${attr("d", group.paths.join(" "))}${attr("fill", group.fill)}${attr(
          "fill-rule",
          group.fillRule
        )}${attr("transform", group.transform)} />`
    )
    .join("");
}

/** 交互命中层：每个视觉独立组件单独一条透明 path，命中仍按组件独立。
 *  fill-rule 必须与绘制层一致，否则 evenodd 孔洞内部会被误当成可命中区域。 */
export function hitComponentMarkup(element, edit = null, selected = false) {
  if (edit?.deleted) return "";
  const classes = `wb-svg-edit__hit${selected ? " is-selected" : ""}`;
  return `<path${attr("d", element.d)}${attr("fill-rule", element.fillRule)}${attr(
    "transform",
    effectiveTransform(element, edit)
  )} fill="transparent" pointer-events="all"${attr("class", classes)}${attr("data-svg-element", element.id)} />`;
}

/**
 * 兼容的单元素受控输出（测试/调试用）；画布本身使用分离的绘制层与命中层。
 * 只用白名单属性，绝不拼接原始 SVG 片段。
 */
export function svgElementMarkup(element, edit = null, selected = false) {
  if (edit?.deleted) return "";
  const classes = `wb-svg-edit__shape${selected ? " is-selected" : ""}`;
  return `<path${attr("d", element.d)}${attr("fill", element.fill)}${attr("fill-rule", element.fillRule)}${attr(
    "transform",
    effectiveTransform(element, edit)
  )}${attr("class", classes)}${attr("data-svg-element", element.id)} />`;
}

/**
 * 可编辑的 SVG 表面分三层：
 * 1) 背景透明矩形负责“点空白取消选择”；
 * 2) 合并后的实际填色层（pointer-events:none，只负责像素外观）；
 * 3) 透明组件命中/选中描边层（data-svg-element，按组件独立命中）。
 */
export function svgSurfaceMarkup(draft) {
  if (!draft) return "";
  const hits = draft.elements
    .map((element) => hitComponentMarkup(element, draft.edits[element.id], draft.selection.includes(element.id)))
    .join("");
  return `<svg class="wb-svg-edit__svg" data-svg-surface viewBox="0 0 ${draft.width} ${draft.height}" preserveAspectRatio="xMidYMid meet" role="group" aria-label="SVG 图形编辑区">
    <rect class="wb-svg-edit__void" x="0" y="0" width="${draft.width}" height="${draft.height}" fill="transparent" data-svg-void />
    <g class="wb-svg-edit__draw" data-svg-draw pointer-events="none">${mergedDrawMarkup(draft)}</g>
    <g class="wb-svg-edit__hits" data-svg-hits>${hits}</g>
  </svg>`;
}

export function svgLiveText(draft) {
  if (!draft) return "正在读取图形…";
  if (!draft.elements.length) return "空白 SVG · 0 个图形";
  const selected = selectedCount(draft);
  const changes = changeCount(draft);
  return `${draft.elements.length} 个图形${selected ? ` · 已选 ${selected}` : ""}${changes ? ` · 未保存 ${changes}` : ""}`;
}

/** 画布只返回内容与尺寸，图版外框仍由工作台的 mediaFrame 统一负责。 */
export function svgPlate(asset) {
  if (!asset || asset.kind !== "svg") return null;
  const width = Math.max(1, num(asset.width));
  const height = Math.max(1, num(asset.height));
  const draft = draftFor(asset.asset_id);
  if (draft) {
    const locked = editingLocked();
    return {
      kind: "editor",
      width: draft.width || width,
      height: draft.height || height,
      inner: `<div class="wb-svg-edit${locked ? " is-locked" : ""}" data-svg-editor>
        ${svgSurfaceMarkup(draft)}
        ${
          draft.elements.length
            ? ""
            : `<span class="wb-svg-edit__empty">空白 SVG · 没有填色图形<br /><span>可从历史版本重开，或重新矢量化</span></span>`
        }
        <span class="wb-badge mono" data-svg-live>${esc(svgLiveText(draft))}</span>
        <span class="wb-svg-edit__tip">${
          locked ? "任务进行中 · 编辑已锁定" : draft.elements.length ? "单击选择 · Shift 多选 · 拖动移动 · Delete 删除" : "空白版本"
        }</span>
      </div>`,
    };
  }
  if (loadState.errorAssetId === asset.asset_id && loadState.error) {
    return { kind: "error", width, height, message: loadState.error };
  }
  return { kind: "loading", width, height, message: "正在读取 SVG 图形…" };
}

/* ------------------------------------------------------------------ 面板片段 */

const sec = (title, extra, body) => `
  <section class="wb-sec">
    <header class="wb-sec__head">
      <span class="label">${esc(title)}</span>
      ${extra ? `<span class="mono wb-sec__extra">${esc(extra)}</span>` : ""}
    </header>
    ${body}
  </section>`;

const note = (text, kind = "info") => `
  <div class="wb-note${kind === "error" ? " wb-error" : ""}" role="${kind === "error" ? "alert" : "note"}">
    ${icon(kind === "error" ? "alert" : "info")}<span>${esc(text)}</span>
  </div>`;

const loading = () =>
  `<div class="wb-loading" role="status"><span class="wb-loading__dot" aria-hidden="true"></span><span>正在读取 SVG 图形…</span></div>`;

const historyLoading = () =>
  `<div class="wb-loading" role="status"><span class="wb-loading__dot" aria-hidden="true"></span><span>正在读取历史版本…</span></div>`;

function toggleButton(action, label, iconName, { disabled = false, title = "" } = {}) {
  return `<button class="btn btn--quiet btn--sm" type="button" data-svg-act="${action}"${
    disabled ? " disabled" : ""
  }${title ? ` title="${esc(title)}"` : ""}>${iconName ? icon(iconName) : ""}${esc(label)}</button>`;
}

function changesList(draft) {
  const rows = changedElements(draft);
  if (!rows.length) return `<p class="field__hint">还没有改动。选中的图形可以拖动或用方向键微调。</p>`;
  const shown = rows.slice(0, 40);
  return `<ul class="wb-svg-edit__changes">${shown
    .map(({ element, edit }) => {
      const detail = edit.deleted
        ? "已删除"
        : `位移 ${edit.dx >= 0 ? "+" : ""}${edit.dx}, ${edit.dy >= 0 ? "+" : ""}${edit.dy} px`;
      return `<li class="wb-svg-edit__change">
        <span class="mono">${esc(element.id)}</span>
        <span class="wb-svg-edit__change-detail">${esc(detail)}</span>
        <button class="btn btn--quiet btn--sm" type="button" data-svg-act="${edit.deleted ? "undelete" : "reset"}"
          data-id="${esc(element.id)}">${edit.deleted ? "恢复" : "重置"}</button>
      </li>`;
    })
    .join("")}</ul>${
    rows.length > shown.length
      ? `<p class="field__hint">另有 ${rows.length - shown.length} 个改动未在列表中展开，保存时会一并提交。</p>`
      : ""
  }`;
}

function saveSection(draft, asset = null) {
  const changes = changeCount(draft);
  const deleted = deletedCount(draft);
  const problem = validateSvgSave(draft);
  const manualGeometry =
    asset?.manual_geometry_edit === true || asset?.parameters?.manual_geometry_edit === true;
  return `${sec(
    "保存为新版本",
    changes ? `${changes} 处改动` : "未改动",
    `<dl class="kv wb-kv">
      <div class="kv__row"><dt>输入版本</dt><dd class="mono">#${esc(shortId(draft.assetId))}${
      draft.version ? ` · v${esc(draft.version)}` : ""
    }</dd></div>
      <div class="kv__row"><dt>本次改动</dt><dd>${changes} 个图形${deleted ? ` · 删除 ${deleted} 个` : ""}</dd></div>
      <div class="kv__row"><dt>上限</dt><dd>单次最多 ${SVG_EDIT_MAX_CHANGES} 个图形变化</dd></div>
    </dl>
    <p class="field__hint">保存会发布新的 SVG 版本；原文件不变，来源、许可与修复记录沿用。只提交实际变化的图形，不会重新描图或改写未选中的部分。允许删除全部图形后保存为空白 SVG。</p>
    ${
      manualGeometry
        ? note(
            "这是人工几何编辑版本：这次保存会把结果标记为“几何尚未核验”，人工移动或删除不会被当成自动核验通过；原来源与许可仍然保留。"
          )
        : ""
    }
    ${changes ? (problem ? note(problem, "error") : note("可以保存：保存成功后自动切到新版本，原版本仍可从历史重开。")) : ""}`
  )}`;
}

function historySection(asset, busy = false) {
  const imageId = store.session.imageId;
  const sameImage = Boolean(historyState.imageId && historyState.imageId === imageId);
  const items = sameImage ? historyState.items : [];
  const waiting = Boolean(imageId) && (historyState.loading || (!historyState.loadedAt && !historyState.error));
  const body = !imageId
    ? `<p class="field__hint">当前纹样没有关联原图记录，无法按图列出历史版本；可从左侧纹样轨切换已保存版本。</p>`
    : waiting
    ? historyLoading()
    : historyState.error && sameImage
    ? `${note(historyState.error, "error")}${toggleButton("history-refresh", "重试读取历史", "history")}`
    : !items.length
    ? `<p class="field__hint">这张纹样还没有可重开的 SVG 历史版本。保存一次后，新版本会出现在这里。</p>`
    : `<label class="field" for="wb-svg-history">
        <span class="field__label"><span>按图历史</span><span class="mono">${items.length} 个 SVG</span></span>
        <select class="select" id="wb-svg-history" data-svg-history>
          ${items
            .map((entry) => {
              const editSource = (entry.parents || []).some((parent) => parent?.role === "svg_edit_source");
              const label = `${formatTime(entry.created_at, { withDate: true })} · ${kindLabel(entry.kind)} · #${shortId(
                entry.asset_id
              )}${editSource ? " · 编辑版" : ""}`;
              return `<option value="${esc(entry.asset_id)}"${
                entry.asset_id === (historyPick || asset.asset_id) ? " selected" : ""
              }>${esc(label)}</option>`;
            })
            .join("")}
        </select>
      </label>
      <div class="wb-inline">
        ${toggleButton("reopen", "重开此版本", "history", {
          disabled: busy || (historyPick || asset.asset_id) === asset.asset_id,
        })}
        ${toggleButton("history-refresh", "刷新历史", "history")}
      </div>
      <p class="field__hint">历史版本来自这张纹样的保存记录；重开只切换当前版本，不复制或改写文件。刷新页面后可通过地址栏的纹样或这里回到已保存版本。</p>`;
  return sec("历史版本", sameImage ? `${items.length} 个` : "", body);
}

export function svgPanelHtml(asset) {
  if (!asset || asset.kind !== "svg") return "";
  const draft = draftFor(asset.asset_id);
  if (!draft) {
    const failed = loadState.errorAssetId === asset.asset_id && loadState.error;
    return `${sec(
      "SVG 图形编辑",
      "独立图形",
      failed
        ? `${note(loadState.error, "error")}${toggleButton("reload", "重新读取图形", "history")}`
        : `${loading()}<p class="field__hint">读取后可按视觉独立图形选择、移动或删除，不按整条 path 操作。</p>`
    )}${historySection(asset, editingLocked())}`;
  }
  const busy = editingLocked();
  const selected = selectedCount(draft);
  const changes = changeCount(draft);
  const deleted = deletedCount(draft);
  return `${sec(
    "SVG 图形编辑",
    `${draft.elements.length} 个图形`,
    `${
      draft.elements.length
        ? ""
        : note(
            "这个 SVG 是空白版本（可能在删除全部图形后保存）。空白是合法的已保存结果；可从下面的历史版本重开上一版，或回到 07 重新矢量化生成图形。",
            "info"
          )
    }
    <p class="mono wb-svg-edit__stats" data-svg-stats>版本 ${esc(draft.version || "—")} · 已选 ${selected} · 未保存 ${changes}${
      deleted ? ` · 删除 ${deleted}` : ""
    }</p>
    <div class="wb-svg-edit__tools">
      ${toggleButton("undo", "撤销", "undo", { disabled: busy || !canUndo(draft) })}
      ${toggleButton("redo", "重做", "redo", { disabled: busy || !canRedo(draft) })}
      ${toggleButton("select-all", "全选图形", "check", {
        disabled: busy || !draft.elements.length,
      })}
      ${toggleButton("delete-selected", "删除所选", "trash", {
        disabled: busy || !selected,
        title: selected ? `标记删除 ${selected} 个图形；保存后生效` : "先选择图形",
      })}
      ${toggleButton("clear-selection", "取消选择", "close", { disabled: busy || !selected })}
    </div>
    ${
      deleted
        ? `<div class="wb-inline">${toggleButton("restore-deleted", `恢复已删除（${deleted}）`, "undo", {
            disabled: busy,
          })}</div>`
        : ""
    }
    ${
      draft.elements.length
        ? `<p class="field__hint">单击选择视觉独立图形；Shift / Ctrl 点击多选；拖动移动，方向键微调 1 px（Shift 10 px），Delete 删除。同一原始形状中视觉不相连的填色区域会单独出现；孔洞与所属区域、同一连通区域的像素块一起移动。画布尺寸保持不变，移出画布的部分会裁切显示与导出，可撤销或重置位置。</p>
    ${changesList(draft)}`
        : ""
    }`
  )}${saveSection(draft, asset)}${historySection(asset, busy)}`;
}

export function svgActionsHtml(asset, { busy = false } = {}) {
  if (!asset || asset.kind !== "svg") return "";
  const draft = draftFor(asset.asset_id);
  if (!draft) {
    return `<button class="btn btn--ghost btn--sm" type="button" data-svg-act="reload"${
      busy ? " disabled" : ""
    }>${icon("history")}重新读取图形</button>`;
  }
  const changes = changeCount(draft);
  const problem = validateSvgSave(draft);
  const reason = busy ? "任务运行中，完成后再保存。" : problem;
  return `<button class="btn btn--primary btn--sm" type="button" data-svg-act="save"${
    reason ? " disabled" : ""
  } title="${esc(reason || "发布新的 SVG 版本")}">${icon("check")}保存为新版本${
    changes ? `（${changes}）` : ""
  }</button>
  <button class="btn btn--ghost btn--sm" type="button" data-svg-act="discard"${
    busy || !changes ? " disabled" : ""
  }>${icon("undo")}放弃改动</button>`;
}

export function svgCaption(asset, { zoomLabel = "" } = {}) {
  if (!asset || asset.kind !== "svg") return "";
  const draft = draftFor(asset.asset_id);
  if (!draft) {
    return loadState.errorAssetId === asset.asset_id && loadState.error
      ? `SVG 图形读取失败：${loadState.error}`
      : "SVG · 正在读取可编辑图形…";
  }
  if (!draft.elements.length) {
    return `空白 SVG · 没有填色图形 · 可从历史版本重开或重新矢量化${
      zoomLabel ? ` · 缩放 ${zoomLabel}` : ""
    }`;
  }
  const changes = changeCount(draft);
  const selected = selectedCount(draft);
  return `SVG 图形编辑 · ${draft.elements.length} 个独立图形 · ${selected ? `已选 ${selected}` : "未选择"} · ${
    changes ? `${changes} 处未保存` : "未改动"
  }${zoomLabel ? ` · 缩放 ${zoomLabel}` : ""}`;
}

export function svgStatus(asset) {
  if (!asset || asset.kind !== "svg") return "";
  if (editingLocked()) return "任务运行中，SVG 编辑暂时锁定；完成后再继续。";
  const draft = draftFor(asset.asset_id);
  if (!draft) {
    return loadState.errorAssetId === asset.asset_id && loadState.error
      ? loadState.error
      : "正在读取 SVG 图形…";
  }
  if (!draft.elements.length) {
    return "这是空白 SVG（没有填色图形）· 可从历史版本重开上一版，或重新矢量化";
  }
  const changes = changeCount(draft);
  return changes
    ? `有 ${changes} 处未保存改动 · 保存后发布新版本，原文件不变`
    : "没有未保存改动 · 可以继续选择、移动或删除图形";
}

/* ------------------------------------------------------------------ 读取与历史 */

const SOURCE_PARENT_ROLES = [
  "vector_input",
  "svg_edit_source",
  "lineart_rgb",
  "source_rgb",
  "original_input_reference",
  "accepted_repair_version",
  "local_composite",
  "full_ai_candidate",
  "original",
];

/** 直接来源 id：先看 source_asset_id，再看已知 parent role。 */
function nextSourceId(asset) {
  if (asset?.source_asset_id) return String(asset.source_asset_id);
  const parents = Array.isArray(asset?.parents) ? asset.parents : [];
  for (const role of SOURCE_PARENT_ROLES) {
    const parent = parents.find((entry) => entry?.role === role && entry.asset_id);
    if (parent) return String(parent.asset_id);
  }
  return "";
}

/**
 * 沿 source_asset_id / vector_input 链补齐当前纹样在本次会话里缺失的来源。
 * 保存过的新 SVG 的 source_asset_id 指向前一 SVG；前一层光栅可能不在会话里，
 * 不补齐的话叠加会误判“没有对照”。只读 GET /assets/{id}，不提交任务。
 */
export async function ensureAssetSourceChain(asset, { depthLimit = 8 } = {}) {
  if (!asset?.asset_id) return;
  const rootId = String(asset.asset_id);
  const token = store.sessionToken();
  const imageId = store.session.imageId;
  if (sourceChecked.get(rootId) === token) return;
  sourceChecked.set(rootId, token);
  let cursor = asset;
  let settled = false;
  // 只有真正到达光栅（或确认没有上一层）才算补齐成功；失败/切图后释放，
  // 下一次挂载还能重试，不会被一次失败永久锁死。
  const release = () => {
    if (sourceChecked.get(rootId) === token) sourceChecked.delete(rootId);
  };
  try {
    for (let depth = 0; depth < depthLimit && cursor; depth += 1) {
      const id = nextSourceId(cursor);
      if (!id || id === cursor.asset_id) {
        settled = true;
        return;
      }
      let next = store.assetById(id);
      if (!next) {
        const fetchKey = `${token}:${id}`;
        if (sourceFetches.has(fetchKey)) return;
        sourceFetches.add(fetchKey);
        try {
          next = await http.asset(id);
        } catch {
          return;
        } finally {
          sourceFetches.delete(fetchKey);
        }
        if (!store.isSessionCurrent(token)) return;
        if (!next?.asset_id) return;
        if (next.image_id && imageId && next.image_id !== imageId) return;
        store.rememberAsset(next, { token });
      } else if (next.image_id && imageId && next.image_id !== imageId) {
        // 来源记录跨到了别的原图：不并入当前会话，避免跨图纹样污染。
        return;
      }
      // 找到光栅来源即可停止；继续往前是原图，不需要为叠加再拉一层。
      if (String(next.kind || "") !== "svg") {
        settled = true;
        return;
      }
      cursor = next;
    }
    settled = true;
  } finally {
    if (!settled) release();
  }
}

export function ensureSvgDraft(asset, { force = false } = {}) {
  if (!asset || asset.kind !== "svg" || !asset.asset_id) return;
  const id = asset.asset_id;
  if (!force) {
    if (drafts.has(id)) return;
    if (loadState.loadingAssetId === id) return;
    if (loadState.errorAssetId === id) return;
  }
  const seq = ++loadState.seq;
  // 读取绑定发起时的会话：晚到的旧图响应不能把来源补进新图会话。
  const token = store.sessionToken();
  loadState.loadingAssetId = id;
  loadState.error = "";
  loadState.errorAssetId = "";
  historyPick = "";
  http
    .svgElements(id)
    .then((payload) => {
      if (seq !== loadState.seq) return;
      if (!store.isSessionCurrent(token)) {
        if (loadState.loadingAssetId === id) loadState.loadingAssetId = "";
        // 新会话可能正好也打开了同一个 SVG：允许下一次挂载重新读取。
        if (store.currentAsset()?.asset_id === id && mountedRoot?.isConnected) notifyChange();
        return;
      }
      adoptSvgPayload(asset, payload);
      loadState.loadingAssetId = "";
      ensureAssetSourceChain(asset);
      if (store.currentAsset()?.asset_id === id) notifyChange();
    })
    .catch((error) => {
      if (seq !== loadState.seq) return;
      if (!store.isSessionCurrent(token)) {
        if (loadState.loadingAssetId === id) loadState.loadingAssetId = "";
        return;
      }
      loadState.loadingAssetId = "";
      loadState.errorAssetId = id;
      loadState.error = error?.message || "读取 SVG 图形失败，请稍后重试。";
      if (store.currentAsset()?.asset_id === id) notifyChange();
    });
  ensureSvgHistory();
}

export function ensureSvgHistory(force = false) {
  const imageId = store.session.imageId;
  if (!imageId) return;
  if (!force && historyState.imageId === imageId && (historyState.loading || historyState.loadedAt || historyState.error)) {
    return;
  }
  historyState.loading = true;
  historyState.error = "";
  historyState.imageId = imageId;
  if (mountedRoot?.isConnected) notifyChange();
  const seq = ++historyState.seq;
  const token = store.sessionToken();
  store
    .imageHistory(imageId, "assets", { limit: 50 })
    .then(({ items }) => {
      if (seq !== historyState.seq) return;
      if (!store.isSessionCurrent(token) || historyState.imageId !== imageId) return;
      historyState.items = (items || [])
        .filter((entry) => entry?.kind === "svg" && entry.asset_id)
        .sort((a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || ""));
      historyState.loadedAt = Date.now();
    })
    .catch((error) => {
      if (seq !== historyState.seq) return;
      if (!store.isSessionCurrent(token) || historyState.imageId !== imageId) return;
      historyState.error = error?.message || "读取 SVG 历史版本失败。";
    })
    .finally(() => {
      if (seq !== historyState.seq) return;
      historyState.loading = false;
      if (!store.isSessionCurrent(token) || historyState.imageId !== imageId) return;
      const asset = store.currentAsset();
      if (asset?.kind === "svg" && mountedRoot?.isConnected) notifyChange();
    });
}

/** 保存成功后：草稿与提交快照一致才归零；保存期间又发生的改动保留。 */
export function markSvgSaved(assetId, savedAsset = null, submittedSignature = "") {
  const draft = draftFor(assetId);
  let savedClean = true;
  if (draft) {
    savedClean = !submittedSignature || editsSignature(draft) === submittedSignature;
    if (savedClean) {
      draft.edits = {};
      draft.selection = [];
      draft.past = [];
      draft.future = [];
      draft.savedAt = Date.now();
    }
  }
  if (savedAsset?.asset_id) {
    drafts.delete(savedAsset.asset_id);
    loadState.errorAssetId = loadState.errorAssetId === savedAsset.asset_id ? "" : loadState.errorAssetId;
    historyState.loadedAt = 0;
    historyState.error = "";
  }
  historyPick = "";
  return savedClean;
}

/* ------------------------------------------------------------------ 未保存草稿处理 */

export function svgHasUnsaved(assetId = "") {
  if (assetId) return hasChanges(draftFor(assetId));
  for (const draft of drafts.values()) if (hasChanges(draft)) return true;
  return false;
}

/** 返回 false 表示用户取消；没有未保存草稿时直接返回 true。 */
export function confirmDiscardSvgDraft(label = "继续") {
  if (!svgHasUnsaved()) return true;
  if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
  return window.confirm(
    `当前还有未保存的 SVG 编辑草稿。${label}会丢弃这些改动（原 SVG 文件不受影响）。继续？`
  );
}

/* ------------------------------------------------------------------ 事件与挂载 */

function notifyChange() {
  if (typeof onChange === "function") onChange();
}

/** 保存或其它任务运行期间，SVG 编辑入口统一锁定；避免提交后继续改草稿。 */
function editingLocked() {
  return externalBusy || Boolean(store.session.activeJob);
}

export function svgEditingLocked() {
  return editingLocked();
}

/** 工作台在任务提交到 activeJob 写入之间也要立即锁定编辑入口。 */
export function setSvgEditingBusy(value) {
  externalBusy = Boolean(value);
}

function isTextTarget(target) {
  return Boolean(
    target?.closest?.(
      "input, textarea, select, button, a, [contenteditable='true'], [contenteditable=''], [role='slider']"
    )
  );
}

function activeDraft() {
  const asset = store.currentAsset();
  return asset?.kind === "svg" ? draftFor(asset.asset_id) : null;
}

function paintSelection(surface, draft) {
  if (!surface || !draft) return;
  for (const node of surface.querySelectorAll("[data-svg-element]")) {
    node.classList.toggle("is-selected", draft.selection.includes(node.getAttribute("data-svg-element")));
  }
  const live = surface.closest("[data-svg-editor]")?.querySelector("[data-svg-live]");
  if (live) live.textContent = svgLiveText(draft);
}

/**
 * 只改选择时避免整页重绘：局部更新右侧统计与按钮，防止 pointerup 后的异步
 * 重绘抢走紧接着的 mousedown 拖拽序列。真正的编辑提交仍走完整重绘。
 */
function updatePanelSelection(root, draft) {
  if (!root || !draft) return;
  const panel = root.querySelector("[data-panel]");
  if (!panel) return;
  const selected = selectedCount(draft);
  const changes = changeCount(draft);
  const deleted = deletedCount(draft);
  const stats = panel.querySelector("[data-svg-stats]");
  if (stats) {
    stats.textContent = `版本 ${draft.version || "—"} · 已选 ${selected} · 未保存 ${changes}${
      deleted ? ` · 删除 ${deleted}` : ""
    }`;
  }
  const disable = (action, value) => {
    const button = panel.querySelector(`[data-svg-act="${action}"]`);
    if (button) button.disabled = Boolean(value);
  };
  disable("undo", !canUndo(draft));
  disable("redo", !canRedo(draft));
  disable("delete-selected", !selected);
  disable("clear-selection", !selected);
  const reopen = panel.querySelector('[data-svg-act="reopen"]');
  if (reopen) reopen.disabled = !historyPick || targetIdsMatch(historyPick, draft.assetId);
  const caption = root.querySelector("[data-live='caption']");
  if (caption) {
    const zoom = root.querySelector("[data-live='zoom']")?.textContent || "";
    const text = svgCaption({ asset_id: draft.assetId, kind: "svg" }, { zoomLabel: zoom });
    caption.textContent = text;
    caption.title = text;
  }
}

function selectionAfterPointer(id, additive) {
  const draft = activeDraft();
  if (!draft) return null;
  if (additive) {
    draft.selection = draft.selection.includes(id)
      ? draft.selection.filter((entry) => entry !== id)
      : [...draft.selection, id];
  } else if (!draft.selection.includes(id)) {
    draft.selection = [id];
  }
  return draft;
}

/** CSS 属性选择器转义：元素 id 已限制为安全字符，这里只处理引号与反斜杠。 */
function escapeAttrSelector(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function previewEditsFor(draft, ids, dx, dy) {
  const preview = {};
  for (const id of ids) {
    const base = draft.edits[id] || { dx: 0, dy: 0, deleted: false };
    preview[id] = {
      dx: round(base.dx) + round(dx),
      dy: round(base.dy) + round(dy),
      deleted: Boolean(base.deleted),
    };
  }
  return preview;
}

/**
 * 拖动时同步重建合并绘制层：被拖动的组件若与同源组件平移不再相同，
 * 会立即拆成新的填色组；命中层只移动对应的透明组件与选中描边。
 */
function applyDragPreview(surface, draft, ids, dx, dy) {
  const preview = previewEditsFor(draft, ids, dx, dy);
  const draw = surface.querySelector("[data-svg-draw]");
  if (draw) draw.innerHTML = mergedDrawMarkup(draft, preview);
  for (const id of ids) {
    const node = surface.querySelector(`[data-svg-element="${escapeAttrSelector(id)}"]`);
    const element = draft.elements.find((entry) => entry.id === id);
    if (node && element) node.setAttribute("transform", effectiveTransform(element, preview[id]));
  }
  return preview;
}

/**
 * 把指针位置换算成 SVG 用户坐标。优先用 getScreenCTM().inverse()，
 * 因此 100% / 200% 画布缩放、非正方形 viewBox 与窗口缩放都不会放大位移误差；
 * 没有 SVG CTM 的环境（测试/旧浏览器）按 preserveAspectRatio="meet" 的
 * 实际内容区与统一缩放退回计算。
 */
export function clientPointToSvg(surface, clientX, clientY, width, height) {
  try {
    if (surface?.getScreenCTM && typeof surface.createSVGPoint === "function") {
      const ctm = surface.getScreenCTM();
      if (ctm && typeof ctm.inverse === "function") {
        const point = surface.createSVGPoint();
        point.x = clientX;
        point.y = clientY;
        const local = point.matrixTransform(ctm.inverse());
        if (Number.isFinite(local?.x) && Number.isFinite(local?.y)) return { x: local.x, y: local.y };
      }
    }
  } catch {
    /* 合成事件或已卸载的节点：退回几何计算 */
  }
  const rect = surface?.getBoundingClientRect?.();
  if (!rect || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / Math.max(1, width), rect.height / Math.max(1, height));
  if (!scale) return null;
  const contentWidth = width * scale;
  const contentHeight = height * scale;
  const left = rect.left + (rect.width - contentWidth) / 2;
  const top = rect.top + (rect.height - contentHeight) / 2;
  return { x: (clientX - left) / scale, y: (clientY - top) / scale };
}

function beginDrag(event, surface) {
  if (editingLocked()) return;
  const draft = activeDraft();
  if (!draft) return;
  const shape = event.target?.closest?.("[data-svg-element]");
  const additive = Boolean(event.shiftKey || event.metaKey || event.ctrlKey);
  if (!shape) {
    if (draft.selection.length) {
      draft.selection = [];
      paintSelection(surface, draft);
      updatePanelSelection(mountedRoot, draft);
    }
    return;
  }
  const id = shape.getAttribute("data-svg-element");
  if (!id || !hasElement(draft, id) || draft.edits[id]?.deleted) return;
  if (additive) {
    selectionAfterPointer(id, true);
    paintSelection(surface, draft);
    updatePanelSelection(mountedRoot, draft);
    if (!draft.selection.includes(id)) return;
  } else {
    selectionAfterPointer(id, false);
    paintSelection(surface, draft);
    updatePanelSelection(mountedRoot, draft);
  }
  const start = clientPointToSvg(surface, event.clientX, event.clientY, draft.width, draft.height);
  if (!start) return;
  drag = {
    surface,
    assetId: draft.assetId,
    ids: [...draft.selection],
    start,
    dx: 0,
    dy: 0,
    moved: false,
  };
  try {
    surface.setPointerCapture?.(event.pointerId);
  } catch {
    /* 合成事件或指针已释放时忽略 */
  }
  event.preventDefault();
}

function moveDrag(event) {
  if (!drag) return;
  let { surface } = drag;
  const draft = activeDraft();
  if (!draft || draft.assetId !== drag.assetId) {
    drag = null;
    return;
  }
  // 选择后的异步重绘可能在拖动开始前替换 DOM：继续用新 surface 的同一坐标序列。
  if (!surface?.isConnected) {
    surface = mountedRoot?.querySelector?.("[data-svg-surface]") || null;
    if (!surface) {
      drag = null;
      return;
    }
    drag.surface = surface;
  }
  const local = clientPointToSvg(surface, event.clientX, event.clientY, draft.width, draft.height);
  if (!local) return;
  const dx = local.x - drag.start.x;
  const dy = local.y - drag.start.y;  if (!drag.moved && Math.hypot(dx, dy) < 0.6) return;
  drag.moved = true;
  drag.dx = dx;
  drag.dy = dy;
  applyDragPreview(surface, draft, drag.ids, dx, dy);
  const live = surface.closest("[data-svg-editor]")?.querySelector("[data-svg-live]");
  if (live) {
    live.textContent = `移动 ${round(dx) >= 0 ? "+" : ""}${round(dx)}, ${round(dy) >= 0 ? "+" : ""}${round(
      dy
    )} px · ${draft.selection.length} 个图形`;
  }
}

function endDrag(event) {
  if (!drag) return;
  const { ids, dx, dy, moved, assetId } = drag;
  let { surface } = drag;
  drag = null;
  if (!surface?.isConnected) surface = mountedRoot?.querySelector?.("[data-svg-surface]") || surface;
  try {
    if (surface?.hasPointerCapture?.(event.pointerId)) surface.releasePointerCapture(event.pointerId);
  } catch {
    /* ignore */
  }
  const draft = activeDraft();
  if (!draft || draft.assetId !== assetId) return;
  if (moved) {
    applyTranslation(draft, ids, dx, dy);
    notifyChange();
  } else {
    // 纯选择不触发整页重绘，避免紧接着的 mousedown 落在旧 DOM 上。
    updatePanelSelection(mountedRoot, draft);
  }
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  const surface = event.target?.closest?.("[data-svg-surface]");
  if (!surface) return;
  beginDrag(event, surface);
}

function onPointerMove(event) {
  if (!drag) return;
  moveDrag(event);
}

function onPointerUp(event) {
  if (!drag) return;
  endDrag(event);
}

function onKeyDown(event) {
  if (isTextTarget(event.target)) return;
  if (typeof document === "undefined" || !document.querySelector("[data-svg-surface]")) return;
  if (editingLocked()) return;
  const draft = activeDraft();
  if (!draft) return;
  const meta = event.ctrlKey || event.metaKey;
  if (meta && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey ? redoDraft(draft) : undoDraft(draft)) notifyChange();
    return;
  }
  if (meta && event.key.toLowerCase() === "y") {
    event.preventDefault();
    if (redoDraft(draft)) notifyChange();
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    if (!draft.selection.length) return;
    event.preventDefault();
    applyDeleted(draft, draft.selection, true);
    draft.selection = [];
    notifyChange();
    return;
  }
  if (event.key === "Escape") {
    if (!draft.selection.length) return;
    event.preventDefault();
    draft.selection = [];
    notifyChange();
    return;
  }
  const step = event.shiftKey ? 10 : 1;
  const delta =
    event.key === "ArrowLeft"
      ? [-step, 0]
      : event.key === "ArrowRight"
      ? [step, 0]
      : event.key === "ArrowUp"
      ? [0, -step]
      : event.key === "ArrowDown"
      ? [0, step]
      : null;
  if (!delta) return;
  if (!draft.selection.length) return;
  event.preventDefault();
  applyTranslation(draft, draft.selection, delta[0], delta[1]);
  notifyChange();
}

function reopenHistory(api) {
  const asset = store.currentAsset();
  if (!asset || asset.kind !== "svg") return;
  const targetId = historyPick || asset.asset_id;
  if (targetIdsMatch(targetId, asset.asset_id)) {
    api?.toast?.("这就是当前版本。", "info");
    return;
  }
  const target = historyState.items.find((entry) => entry.asset_id === targetId);
  if (!target) {
    api?.toast?.("先选择一个历史版本。", "warn");
    return;
  }
  if (
    svgHasUnsaved() &&
    typeof window !== "undefined" &&
    typeof window.confirm === "function" &&
    !window.confirm("当前 SVG 还有未保存改动；切换后草稿会保留在本次页面，可切回继续编辑。继续打开所选历史版本？")
  ) {
    return;
  }
  store.setCurrentAsset(target.asset_id);
}

function targetIdsMatch(a, b) {
  return String(a || "") === String(b || "");
}

function handleSvgAction(el, api) {
  const action = el.dataset.svgAct;
  const asset = store.currentAsset();
  const draft = activeDraft();
  if (!action) return;
  if (editingLocked() && action !== "history-refresh") {
    api?.toast?.("保存或其它任务进行中，完成后再编辑 SVG。", "info");
    return;
  }
  if (action === "save") {
    if (typeof saveHandler === "function") saveHandler();
    return;
  }
  if (action === "reload") {
    if (!asset || asset.kind !== "svg") return;
    if (!confirmDiscardSvgDraft("重新读取图形")) return;
    drafts.delete(asset.asset_id);
    loadState.errorAssetId = "";
    ensureSvgDraft(asset, { force: true });
    notifyChange();
    return;
  }
  if (action === "history-refresh") {
    ensureSvgHistory(true);
    notifyChange();
    return;
  }
  if (action === "reopen") {
    reopenHistory(api);
    return;
  }
  if (!draft) return;
  switch (action) {
    case "undo":
      if (undoDraft(draft)) notifyChange();
      break;
    case "redo":
      if (redoDraft(draft)) notifyChange();
      break;
    case "delete-selected": {
      const count = applyDeleted(draft, draft.selection, true);
      draft.selection = [];
      if (count) {
        notifyChange();
        api?.toast?.(`已标记删除 ${count} 个图形；保存新版本后生效。`, "info");
      }
      break;
    }
    case "restore-deleted": {
      const ids = Object.keys(draft.edits).filter((id) => draft.edits[id]?.deleted);
      const count = applyDeleted(draft, ids, false);
      if (count) {
        notifyChange();
        api?.toast?.(`已恢复 ${count} 个图形；保存前原文件不受影响。`, "info");
      }
      break;
    }
    case "clear-selection":
      if (draft.selection.length) {
        draft.selection = [];
        notifyChange();
      }
      break;
    case "select-all": {
      draft.selection = draft.elements
        .filter((element) => !draft.edits[element.id]?.deleted)
        .map((element) => element.id);
      notifyChange();
      break;
    }
    case "reset": {
      if (resetElementEdit(draft, el.dataset.id || "")) notifyChange();
      break;
    }
    case "undelete": {
      const id = el.dataset.id || "";
      if (!id) break;
      pushHistory(draft);
      draft.edits[id] = { ...(draft.edits[id] || { dx: 0, dy: 0, deleted: false }), deleted: false };
      draft.edits = normalizeEdits(draft.edits);
      notifyChange();
      break;
    }
    case "discard": {
      if (!hasChanges(draft)) return;
      if (typeof window !== "undefined" && typeof window.confirm === "function") {
        if (!window.confirm(`放弃当前 SVG 的 ${changeCount(draft)} 处未保存改动？原 SVG 文件不受影响。`)) return;
      }
      resetDraftEdits(draft);
      notifyChange();
      break;
    }
    default:
      break;
  }
}

function onRootClick(event) {
  const el = event.target?.closest?.("[data-svg-act]");
  if (!el || el.disabled) return;
  event.preventDefault();
  handleSvgAction(el, apiRef);
}

function onRootChange(event) {
  const select = event.target?.closest?.("[data-svg-history]");
  if (!select) return;
  historyPick = select.value;
  const reopen = mountedRoot?.querySelector?.('[data-svg-act="reopen"]');
  if (reopen) {
    const asset = store.currentAsset();
    reopen.disabled = !historyPick || targetIdsMatch(historyPick, asset?.asset_id);
  }
}

const handleBeforeUnload = (event) => {
  if (!svgHasUnsaved()) return;
  event.preventDefault();
  event.returnValue = "";
  return "";
};

function attachGuards() {
  if (typeof window !== "undefined" && !beforeUnload) {
    beforeUnload = handleBeforeUnload;
    window.addEventListener("beforeunload", beforeUnload);
  }
  if (typeof document !== "undefined" && !navGuard) {
    navGuard = (event) => {
      const link = event.target?.closest?.('a[href^="#/"]');
      if (!link) return;
      const href = String(link.getAttribute("href") || "");
      if (href.includes("#/workbench")) return;
      if (!svgHasUnsaved()) return;
      if (!confirmDiscardSvgDraft("离开工作台")) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      discardAllSvgDrafts();
    };
    document.addEventListener("click", navGuard, true);
  }
}

function detachNavGuard() {
  if (typeof document !== "undefined" && navGuard) {
    document.removeEventListener("click", navGuard, true);
  }
  navGuard = null;
}

/** 工作台挂载时调用：绑定编辑区事件，并按当前 SVG 拉取元素。 */
export function mountSvgEditor(root, api, options = {}) {
  if (typeof document === "undefined" || !root) return;
  mountedRoot = root;
  apiRef = api || null;
  onChange = typeof options.repaint === "function" ? options.repaint : null;
  saveHandler = typeof options.save === "function" ? options.save : null;
  root.addEventListener("click", onRootClick);
  root.addEventListener("change", onRootChange);
  if (!keyHandler) {
    keyHandler = onKeyDown;
    document.addEventListener("keydown", keyHandler);
  }
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerUp);
  attachGuards();
  const asset = store.currentAsset();
  if (asset?.kind === "svg") {
    ensureSvgDraft(asset);
    ensureSvgHistory();
    historyPick = historyPick || asset.asset_id;
  }
}

/** 局部重绘前调用：清掉视图引用；离开工作台时同时移除导航拦截。 */
export function suspendSvgEditor({ leaving = false } = {}) {
  mountedRoot = null;
  if (leaving) {
    onChange = null;
    saveHandler = null;
    apiRef = null;
    drag = null;
  }
  if (typeof document !== "undefined" && keyHandler) {
    document.removeEventListener("keydown", keyHandler);
  }
  keyHandler = null;
  if (leaving) detachNavGuard();
}

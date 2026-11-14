/* =============================================================================
   views/batch-export.js — 网页内「批量导出」浮窗。
   约定：
   - 只导出真实存在的资产：原始文件、已有 PNG、已有 SVG 原样打包，不伪造转换；
     ZIP / 导出包不能再嵌套，所以不出现在清单里。
   - 请求沿用 POST /api/v1/exports：{asset_ids, layout:"by_image", license_acknowledged}，
     单个资产最多 500，总大小上限 128 MiB 由后端再次校验。
   - 选择范围只限本次浮窗已载入的原图组；分页之外的分组不会被「全选」选中。
   - 浮窗是只读选择 + 一个导出任务；不改写会话、不删除或合并任何资产。
   ============================================================================= */

import { api, waitForJob } from "../api.js";
import { icon } from "../icons.js";
import {
  dimsOf,
  escapeHtml as esc,
  formatBytes,
  formatTime,
  gradeLabel,
  jobStateLabel,
  kindLabel,
  licenseLabel,
  progressOf,
  shortId,
} from "../format.js";
import { MAX_BATCH_SELECTION, MAX_EXPORT_BYTES } from "../batch.js";

const NO_EXPORT_KINDS = new Set(["zip", "export", "archive"]);
const MAX_VISIBLE_BYTES = MAX_EXPORT_BYTES;

const modal = {
  el: null,
  api: null,
  groups: [],
  selected: new Set(),
  licenseAck: false,
  zoomAsset: null,
  running: false,
  job: null,
  zip: null,
  error: "",
  scopeNote: "",
  returnFocus: null,
  keyHandler: null,
  onDone: null,
  runSeq: 0,
  abort: null,
};

/* ------------------------------------------------------------------ 纯逻辑 */

export function exportableAssets(groups) {
  const seen = new Set();
  const out = [];
  for (const group of groups || []) {
    for (const asset of group.assets || []) {
      if (!asset?.asset_id || seen.has(asset.asset_id)) continue;
      if (NO_EXPORT_KINDS.has(asset.kind)) continue;
      seen.add(asset.asset_id);
      out.push({ asset, imageId: group.imageId, groupName: group.name, current: Boolean(group.current) });
    }
  }
  return out;
}

export function selectionStats(groups, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const entries = exportableAssets(groups);
  const chosen = entries.filter((entry) => selected.has(entry.asset.asset_id));
  const imageIds = new Set(chosen.map((entry) => entry.imageId));
  const bytes = chosen.reduce((sum, entry) => sum + (Number(entry.asset.bytes) || 0), 0);
  return {
    total: entries.length,
    count: chosen.length,
    groups: imageIds.size,
    bytes,
    overCount: chosen.length > MAX_BATCH_SELECTION,
    overBytes: bytes > MAX_VISIBLE_BYTES,
  };
}

export function selectionForGroup(groups, imageId, selectedIds, on) {
  const next = new Set(selectedIds instanceof Set ? selectedIds : selectedIds || []);
  for (const entry of exportableAssets(groups)) {
    if (entry.imageId !== imageId) continue;
    if (on) next.add(entry.asset.asset_id);
    else next.delete(entry.asset.asset_id);
  }
  return next;
}

export function selectionForKind(groups, kind, selectedIds, on) {
  const next = new Set(selectedIds instanceof Set ? selectedIds : selectedIds || []);
  for (const entry of exportableAssets(groups)) {
    if (String(entry.asset.kind) !== String(kind)) continue;
    if (on) next.add(entry.asset.asset_id);
    else next.delete(entry.asset.asset_id);
  }
  return next;
}

export function allSelection(groups, on) {
  return on ? new Set(exportableAssets(groups).map((entry) => entry.asset.asset_id)) : new Set();
}

export function invertSelection(groups, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const next = new Set();
  for (const entry of exportableAssets(groups)) {
    if (!selected.has(entry.asset.asset_id)) next.add(entry.asset.asset_id);
  }
  return next;
}

/** 默认只勾当前原图组的关键结果；其它组需要用户明确全选或按类型选。 */
export function defaultExportSelection(groups, currentImageId, currentAssetId = "") {
  const entries = exportableAssets(groups);
  const wanted = [];
  if (currentAssetId && entries.some((entry) => entry.asset.asset_id === currentAssetId)) {
    wanted.push(currentAssetId);
  }
  const group = (groups || []).find((item) => item.imageId === currentImageId);
  const pool = group ? exportableAssets([group]) : [];
  for (const kind of ["original", "transparent_png", "svg", "lineart", "cropped", "accepted_repair"]) {
    for (let index = pool.length - 1; index >= 0; index -= 1) {
      if (pool[index].asset.kind === kind && !wanted.includes(pool[index].asset.asset_id)) {
        wanted.push(pool[index].asset.asset_id);
        break;
      }
    }
    if (wanted.length >= 5) break;
  }
  return new Set(wanted.slice(0, 5));
}

export function buildExportPayload(selectedIds, { licenseAcknowledged = false } = {}) {
  return {
    asset_ids: [...selectedIds],
    layout: "by_image",
    license_acknowledged: Boolean(licenseAcknowledged),
  };
}

export function submitBlockReason(stats, licenseAcknowledged) {
  if (!stats || !stats.count) return "至少勾选一个要导出的版本。";
  if (stats.overCount) return `单次最多导出 ${MAX_BATCH_SELECTION} 个资产，请少选一些。`;
  if (stats.overBytes) return `所选文件超过 128 MiB 导出上限，请少选几个。`;
  if (!licenseAcknowledged) return "导出前需要确认许可提示。";
  return "";
}

export function groupKindOptions(groups) {
  const counts = new Map();
  for (const entry of exportableAssets(groups)) {
    const kind = String(entry.asset.kind || "other");
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count, label: kindLabel(kind) }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
}

function unregisteredLicenseCount(entries, selected) {
  return entries.filter(
    (entry) => selected.has(entry.asset.asset_id) && licenseLabel(entry.asset.license) === "未登记"
  ).length;
}

/* ------------------------------------------------------------------ 片段 */

function thumbHtml(entry, selected) {
  const { asset } = entry;
  const on = selected.has(asset.asset_id);
  const license = licenseLabel(asset.license);
  const unset = license === "未登记";
  return `
  <li class="bx-thumb-item">
    <button class="bx-thumb" type="button" data-bx-toggle="${esc(asset.asset_id)}" aria-pressed="${on}"
      title="${esc(`${kindLabel(asset.kind)} · ${dimsOf(asset)} · ${formatTime(asset.created_at, { withDate: true })}`)}">
      <span class="bx-thumb__plate plate plate--grain">
        ${assetPreview(asset)}
        <span class="bx-thumb__check" aria-hidden="true">${icon("check")}</span>
        ${on ? `<span class="bx-thumb__on" aria-hidden="true">已选</span>` : ""}
      </span>
      <span class="bx-thumb__meta">
        <span class="bx-thumb__name">${esc(kindLabel(asset.kind))}</span>
        <span class="bx-thumb__sub mono">${esc(dimsOf(asset))} · ${esc(formatBytes(asset.bytes))}</span>
        <span class="bx-thumb__tags">
          <span class="bx-tag">${esc(gradeLabel(asset.grade))}</span>
          <span class="bx-tag${unset ? " bx-tag--warn" : ""}">${esc(unset ? "授权未登记" : license)}</span>
        </span>
      </span>
    </button>
    <button class="bx-zoom-btn" type="button" data-bx-zoom="${esc(asset.asset_id)}"
      aria-label="${esc(`放大预览 ${kindLabel(asset.kind)}`)}" title="放大预览">${icon("eye")}</button>
  </li>`;
}

function assetPreview(asset) {
  return asset?.asset_id
    ? `<img class="plate__img" src="${api.assetPreviewUrl(asset.asset_id)}" alt="" loading="lazy" decoding="async" />`
    : `<span class="bx-thumb__file" aria-hidden="true">${icon("file")}</span>`;
}

function groupSectionHtml(group, selected) {
  const entries = exportableAssets([group]);
  const selectedCount = entries.filter((entry) => selected.has(entry.asset.asset_id)).length;
  const all = entries.length > 0 && selectedCount === entries.length;
  return `
  <section class="bx-group" data-bx-group-section="${esc(group.imageId)}">
    <header class="bx-group__head">
      <div class="bx-group__title">
        <span class="bx-group__name">${esc(group.name || "未命名纹样")}</span>
        <span class="mono bx-group__meta">#${esc(shortId(group.imageId))} · ${entries.length} 个版本${
          group.current ? " · 当前原图" : ""
        }</span>
      </div>
      <div class="bx-group__acts">
        <span class="mono">${selectedCount}/${entries.length}</span>
        <button class="btn btn--quiet btn--sm" type="button" data-bx-group="${esc(group.imageId)}" data-on="${all ? "false" : "true"}">
          ${all ? "取消本组" : "全选本组"}
        </button>
      </div>
    </header>
    <ul class="bx-grid">${entries.map((entry) => thumbHtml(entry, selected)).join("")}</ul>
  </section>`;
}

/**
 * 生成浮窗 HTML；纯函数，测试可直接断言范围文案、选择状态与许可提示。
 * model: { groups, selected, licenseAck, scopeNote, running, job, zip, error, zoomAsset }
 */
export function exportModalHtml(model = {}) {
  const groups = model.groups || [];
  const selected = model.selected instanceof Set ? model.selected : new Set(model.selected || []);
  const stats = selectionStats(groups, selected);
  const kinds = groupKindOptions(groups);
  const entries = exportableAssets(groups);
  const unregistered = unregisteredLicenseCount(entries, selected);
  const block = submitBlockReason(stats, model.licenseAck);
  const job = model.job || null;
  const percent = job ? progressOf(job) : 0;
  const running = Boolean(model.running);
  const groupCount = groups.length;
  const scope = model.scopeNote || `本次已载入 ${groupCount} 个原图组`;
  const zoomEntry = model.zoomAsset
    ? entries.find((entry) => entry.asset.asset_id === model.zoomAsset)
    : null;
  return `
  <div class="bx" data-bx-layer role="dialog" aria-modal="true" aria-label="批量导出">
    <div class="bx__backdrop" data-bx-close aria-hidden="true"></div>
    <div class="bx__panel">
      <header class="bx__head">
        <div>
          <p class="label">按原图分目录导出</p>
          <h2 class="bx__title">批量导出</h2>
          <p class="bx__lead">ZIP 内每个原图一个目录（images/&lt;原图 ID&gt;/…）；原始文件、已有 PNG 与已有 SVG 原样打包，不做格式转换。</p>
        </div>
        <button class="icon-btn" type="button" data-bx-close aria-label="关闭批量导出">${icon("close")}</button>
      </header>

      <div class="bx__toolbar">
        <div class="bx__scope" data-bx-scope>
          ${icon("info")}
          <span>范围：${esc(scope)}。全选 / 反选 / 按类型批选只作用于这些已载入的分组，未载入的分组不会被选中。</span>
        </div>
        <div class="bx__actions" role="group" aria-label="选择操作">
          <button class="btn btn--ghost btn--sm" type="button" data-bx-all>全选已载入</button>
          <button class="btn btn--quiet btn--sm" type="button" data-bx-none>取消选择</button>
          <button class="btn btn--quiet btn--sm" type="button" data-bx-invert>反选</button>
        </div>
        ${
          kinds.length
            ? `<div class="bx__kinds" role="group" aria-label="按处理类型批量选择">
                <span class="label">按处理类型</span>
                ${kinds
                  .map((kind) => {
                    const allOfKind = entries.filter((entry) => String(entry.asset.kind) === kind.kind);
                    const allOn = allOfKind.length > 0 && allOfKind.every((entry) => selected.has(entry.asset.asset_id));
                    return `<button class="chip bx-kind${allOn ? " chip--accent" : ""}" type="button" data-bx-kind="${esc(kind.kind)}"
                      data-on="${allOn ? "false" : "true"}" aria-pressed="${allOn}"
                      title="${esc(allOn ? `取消选择全部 ${kind.label}` : `选择全部 ${kind.label}`)}">${esc(kind.label)} · ${kind.count}</button>`;
                  })
                  .join("")}
              </div>`
            : ""
        }
      </div>

      <div class="bx__body">
        ${
          groupCount
            ? groups.map((group) => groupSectionHtml(group, selected)).join("")
            : `<p class="bx__empty">这批纹样还没有可导出的版本。先完成处理，或在纹样库载入更多原图组。</p>`
        }
      </div>

      <footer class="bx__foot">
        <div class="bx__summary" data-bx-summary>
          <span>已选 <b class="num">${stats.count}</b> / ${stats.total} 项 · 涉及 <b class="num">${stats.groups}</b> 个原图组</span>
          <span class="mono">约 ${stats.bytes ? formatBytes(stats.bytes) : "0 B"} / 128 MiB</span>
        </div>
        ${unregistered ? `<p class="bx__warn">${icon("alert")}所选版本中有 ${unregistered} 个授权未登记；导出清单会记录这次确认，不代替授权审查。</p>` : ""}
        <label class="bx__license">
          <input type="checkbox" data-bx-license ${model.licenseAck ? "checked" : ""} />
          <span>许可证已确认：只导出我有权使用的素材；删除分类、未写入记录的文件不会被自动补登。</span>
        </label>
        ${model.error ? `<p class="bx__error" role="alert">${esc(model.error)}</p>` : ""}
        ${
          running || job
            ? `<div class="bx__run" data-bx-run>
                 <div class="bx__run-head">
                   <span data-bx-progress-state>${esc(job ? jobStateLabel(job.state) : "提交中…")}</span>
                   <span class="mono" data-bx-progress-percent>${percent}%</span>
                 </div>
                 <div class="bx__meter" aria-hidden="true"><span data-bx-progress-bar style="width:${Math.max(2, percent)}%"></span></div>
               </div>`
            : ""
        }
        ${
          model.zip
            ? `<a class="btn btn--paper btn--sm bx__download" href="${api.assetDownloadUrl(model.zip.asset_id)}" download
                 data-bx-download>${icon("download")}下载 ZIP · ${esc(formatBytes(model.zip.bytes))}</a>`
            : ""
        }
        <div class="bx__foot-actions">
          <button class="btn btn--quiet btn--sm" type="button" data-bx-close>关闭</button>
          <button class="btn btn--primary btn--sm" type="button" data-bx-submit ${block || running ? "disabled" : ""}
            title="${esc(block || "按原图分目录打包导出")}">${icon("download")}导出 ZIP</button>
        </div>
        <p class="bx__hint">单次最多 500 个资产、总大小 128 MiB；超过上限时请分批导出。任务提交后仍可在任务页查看结果。</p>
      </footer>
    </div>
    ${
      zoomEntry
        ? `<div class="bx__zoom" data-bx-zoom-layer role="dialog" aria-modal="true" aria-label="放大预览">
            <button class="bx__zoom-backdrop" type="button" data-bx-zoom-close aria-label="关闭放大预览"></button>
            <figure class="bx__zoom-panel">
              <img src="${api.assetPreviewUrl(zoomEntry.asset.asset_id)}" alt="${esc(kindLabel(zoomEntry.asset.kind))} 放大预览" />
              <figcaption>
                <span>${esc(kindLabel(zoomEntry.asset.kind))} · ${esc(dimsOf(zoomEntry.asset))}</span>
                <span class="mono">${esc(shortId(zoomEntry.asset.asset_id))}</span>
                <button class="btn btn--quiet btn--sm" type="button" data-bx-zoom-close>关闭预览</button>
              </figcaption>
            </figure>
          </div>`
        : ""
    }
  </div>`;
}

/* ------------------------------------------------------------------ 浮窗生命周期 */

function model() {
  return {
    groups: modal.groups,
    selected: modal.selected,
    licenseAck: modal.licenseAck,
    scopeNote: modal.scopeNote,
    running: modal.running,
    job: modal.job,
    zip: modal.zip,
    error: modal.error,
    zoomAsset: modal.zoomAsset,
  };
}

function paint({ focusSelector = "" } = {}) {
  const host = document.querySelector(".app");
  const current = modal.el;
  if (!host || !current) return;
  const body = current.querySelector(".bx__body");
  const scrollTop = body?.scrollTop || 0;
  const template = document.createElement("template");
  template.innerHTML = exportModalHtml(model()).trim();
  const next = template.content.firstElementChild;
  current.replaceWith(next);
  modal.el = next;
  bind();
  const nextBody = next.querySelector(".bx__body");
  if (nextBody) nextBody.scrollTop = scrollTop;
  if (focusSelector) {
    const target = next.querySelector(focusSelector);
    if (target) target.focus({ preventScroll: true });
  }
}

function selected() {
  return modal.selected;
}

function setSelected(next, focusSelector = "") {
  modal.selected = next;
  paint({ focusSelector });
}

function toggle(assetId, focusSelector) {
  const next = new Set(selected());
  if (next.has(assetId)) next.delete(assetId);
  else next.add(assetId);
  setSelected(next, focusSelector);
}

function rootApi() {
  return modal.api;
}

function footerMessage(text) {
  modal.error = text || "";
  paint();
}

function paintProgress() {
  const layer = modal.el;
  if (!layer) return;
  const job = modal.job;
  const percent = job ? progressOf(job) : 2;
  const percentEl = layer.querySelector("[data-bx-progress-percent]");
  if (percentEl) percentEl.textContent = `${percent}%`;
  const bar = layer.querySelector("[data-bx-progress-bar]");
  if (bar) bar.style.width = `${Math.max(2, percent)}%`;
  const state = layer.querySelector("[data-bx-progress-state]");
  if (state) state.textContent = job ? jobStateLabel(job.state) : "提交中…";
}

function exportJobError(job) {
  const code = String(job?.error?.code || "");
  const map = {
    NESTED_EXPORT: "不能把已有的 ZIP 再打包一次，请只选图片或 SVG。",
    EXPORT_SIZE_LIMIT: "所选文件超过 128 MiB 导出上限，请少选几个。",
    EXPORT_LAYOUT_INVALID: "导出目录布局不受支持，请刷新页面后重试。",
    SOURCE_NOT_FOUND: "有资产已经不存在，请重新载入纹样库后再选。",
    NOT_FOUND: "有资产已经不存在，请重新载入纹样库后再选。",
  };
  if (map[code]) return map[code];
  const detail = String(job?.error?.message || "").trim();
  if (detail && /[\u4e00-\u9fa5]/.test(detail)) return `导出没有完成：${detail}`;
  return "导出没有完成，请稍后重试。";
}

async function submit() {
  if (modal.running) return;
  const stats = selectionStats(modal.groups, modal.selected);
  const block = submitBlockReason(stats, modal.licenseAck);
  if (block) {
    footerMessage(block);
    return;
  }
  const entries = exportableAssets(modal.groups);
  const ordered = entries
    .map((entry) => entry.asset.asset_id)
    .filter((id) => modal.selected.has(id));
  const seq = ++modal.runSeq;
  modal.running = true;
  modal.job = null;
  modal.zip = null;
  modal.error = "";
  paint();
  try {
    const queued = await api.exportAssets(buildExportPayload(ordered, { licenseAcknowledged: modal.licenseAck }));
    if (seq !== modal.runSeq) return;
    modal.job = queued;
    paint();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    modal.abort = controller;
    const final = await waitForJob(queued.job_id, {
      signal: controller?.signal,
      interval: 1200,
      onTick: (snapshot) => {
        if (seq !== modal.runSeq) return;
        modal.job = snapshot;
        paintProgress();
      },
    });
    if (!final || seq !== modal.runSeq) return;
    modal.job = final;
    if (final.state === "succeeded") {
      const zip = (final.result?.assets || []).find((asset) => asset.kind === "zip") || null;
      modal.zip = zip;
      modal.error = zip ? "" : "导出任务完成，但没有返回 ZIP 资产。";
      if (zip) rootApi()?.toast?.("导出完成，可在浮窗或纹样库下载 ZIP。", "done");
    } else if (final.state !== "cancelled") {
      modal.error = exportJobError(final);
    }
  } catch (error) {
    if (seq !== modal.runSeq) return;
    modal.error = error?.message || "导出失败，请稍后重试。";
  } finally {
    if (seq === modal.runSeq) {
      modal.running = false;
      modal.abort = null;
      modal.job = modal.job || null;
      paint();
    }
  }
}

/* ------------------------------------------------------------------ 事件 */

function onClick(event) {
  const layer = modal.el;
  if (!layer || !layer.contains(event.target)) return;
  const close = event.target.closest("[data-bx-close]");
  if (close) {
    closeBatchExport();
    return;
  }
  if (event.target.closest("[data-bx-zoom-close]") || event.target.closest("[data-bx-zoom-layer]") === event.target) {
    modal.zoomAsset = null;
    paint({ focusSelector: "[data-bx-all]" });
    return;
  }
  const zoom = event.target.closest("[data-bx-zoom]");
  if (zoom) {
    modal.zoomAsset = zoom.dataset.bxZoom;
    paint({ focusSelector: "[data-bx-zoom-close]" });
    return;
  }
  const toggleBtn = event.target.closest("[data-bx-toggle]");
  if (toggleBtn) {
    toggle(toggleBtn.dataset.bxToggle, `[data-bx-toggle="${toggleBtn.dataset.bxToggle}"]`);
    return;
  }
  const groupBtn = event.target.closest("[data-bx-group]");
  if (groupBtn) {
    const on = groupBtn.dataset.on === "true";
    setSelected(selectionForGroup(modal.groups, groupBtn.dataset.bxGroup, modal.selected, on), "[data-bx-all]");
    return;
  }
  const kindBtn = event.target.closest("[data-bx-kind]");
  if (kindBtn) {
    const on = kindBtn.dataset.on === "true";
    setSelected(selectionForKind(modal.groups, kindBtn.dataset.bxKind, modal.selected, on), "[data-bx-all]");
    return;
  }
  if (event.target.closest("[data-bx-all]")) {
    setSelected(allSelection(modal.groups, true), "[data-bx-all]");
    return;
  }
  if (event.target.closest("[data-bx-none]")) {
    setSelected(allSelection(modal.groups, false), "[data-bx-none]");
    return;
  }
  if (event.target.closest("[data-bx-invert]")) {
    setSelected(invertSelection(modal.groups, modal.selected), "[data-bx-invert]");
    return;
  }
  if (event.target.closest("[data-bx-submit]")) {
    submit();
  }
}

function onKeydown(event) {
  if (!modal.el) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (modal.zoomAsset) {
      modal.zoomAsset = null;
      paint({ focusSelector: "[data-bx-all]" });
    } else {
      closeBatchExport();
    }
    return;
  }
  if (event.key !== "Tab") return;
  const focusables = [...modal.el.querySelectorAll("button:not([disabled]), input, a[href]")].filter(
    (node) => node.offsetParent !== null
  );
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === modal.el)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function bind() {
  if (!modal.el) return;
  modal.el.addEventListener("click", onClick);
  modal.el.addEventListener("change", (event) => {
    if (event.target.matches("[data-bx-license]")) {
      modal.licenseAck = Boolean(event.target.checked);
      paint({ focusSelector: "[data-bx-license]" });
    }
  });
}

/**
 * 打开批量导出浮窗。
 * @param {{api: object, groups: Array, defaultImageId?: string, currentAssetId?: string, scopeNote?: string, onDone?: Function}} options
 */
export function openBatchExport({
  api: appApi,
  groups,
  defaultImageId = "",
  currentAssetId = "",
  preselected = null,
  scopeNote = "",
  onDone = null,
} = {}) {
  closeBatchExport();
  modal.api = appApi;
  modal.groups = (groups || []).map((group) => ({
    imageId: group.imageId,
    name: group.name,
    current: Boolean(group.current),
    assets: [...(group.assets || [])],
  }));
  const available = new Set(exportableAssets(modal.groups).map((entry) => entry.asset.asset_id));
  const preseed = Array.isArray(preselected) ? preselected.filter((id) => available.has(id)) : [];
  modal.selected = preseed.length
    ? new Set(preseed)
    : defaultExportSelection(modal.groups, defaultImageId, currentAssetId);
  modal.licenseAck = false;
  modal.zoomAsset = null;
  modal.running = false;
  modal.job = null;
  modal.zip = null;
  modal.error = "";
  modal.scopeNote = scopeNote;
  modal.onDone = onDone;
  modal.returnFocus = typeof document !== "undefined" ? document.activeElement : null;
  modal.runSeq += 1;

  const host = document.querySelector(".app");
  if (!host) return null;
  const template = document.createElement("template");
  template.innerHTML = exportModalHtml(model()).trim();
  modal.el = template.content.firstElementChild;
  host.append(modal.el);
  bind();
  modal.keyHandler = onKeydown;
  document.addEventListener("keydown", modal.keyHandler);
  modal.el.querySelector("[data-bx-all]")?.focus({ preventScroll: true });
  return modal.el;
}

export function closeBatchExport() {
  modal.runSeq += 1;
  modal.abort?.abort?.();
  modal.abort = null;
  if (modal.keyHandler) document.removeEventListener("keydown", modal.keyHandler);
  modal.keyHandler = null;
  modal.el?.remove();
  modal.el = null;
  if (modal.returnFocus?.isConnected) modal.returnFocus.focus({ preventScroll: true });
  modal.returnFocus = null;
  return modal.zip;
}

/** 供测试/外部读取当前浮窗的选择摘要。 */
export function exportModalSnapshot() {
  const stats = selectionStats(modal.groups, modal.selected);
  return {
    open: Boolean(modal.el),
    groups: modal.groups.map((group) => ({ imageId: group.imageId, name: group.name })),
    selected: [...modal.selected],
    stats,
    running: modal.running,
    zip: modal.zip ? modal.zip.asset_id : "",
  };
}

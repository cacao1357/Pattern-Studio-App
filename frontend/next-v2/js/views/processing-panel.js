/* =============================================================================
   views/processing-panel.js — 流程预设编辑器、批次启动浮窗与可收起的进度浮窗。
   约定：
   - 所有进度来自服务端批次；这里只轮询展示，不推进、不自动续接、不自动重试。
   - 人工门只提供“在工作台处理 → 回来选择后代版本续接”，不会自动挑选旧结果。
   - 结果缩略图与导出复用 /patterns 与 batch-export.js，不新建素材索引。
   - 预设编辑冻结在提交快照里；修改预设不会改变已提交批次。
   ============================================================================= */

import { api as http } from "../api.js";
import { icon } from "../icons.js";
import {
  dimsOf,
  escapeHtml as esc,
  formatTime,
  kindLabel,
  shortId,
} from "../format.js";
import {
  batchErrorText,
  batchInputs,
  batchProgress,
  canCancelBatch,
  cancelNote,
  compatibleInputAssets,
  defaultPresetOptions,
  effectiveWorkingLimit,
  estimateProviderCalls,
  formatPixels,
  healthPixelLimits,
  itemStateLabel,
  loadBatch,
  loadBatches,
  loadPattern,
  loadPresets,
  manualCandidates,
  manualStage,
  manualStepLabel,
  normalizePresetOptions,
  patternFor,
  presetById,
  presetSteps,
  presetValidation,
  processing,
  recipeLabel,
  resultAssetIds,
  resultGroups,
  resumeItem,
  runValidation,
  selectBatch,
  startProcessingPolling,
  stepLabel,
  stepStateLabel,
  subscribeProcessing,
  createBatch,
  createPreset,
  updatePreset,
  deletePreset,
  copyPreset,
  cancelBatch,
  activeBatchCount,
} from "../processing.js";
import { openBatchExport } from "./batch-export.js";

const EXTRACT_MODES = [
  ["otsu", "Otsu 全局阈值"],
  ["manual", "手动阈值"],
  ["adaptive_mean", "自适应均值"],
  ["adaptive_gaussian", "自适应高斯"],
  ["sauvola", "Sauvola 局部"],
];
const VECTOR_MODES = [
  ["color", "彩色"],
  ["monochrome", "单色"],
  ["contour", "轮廓"],
];
const DETAILS = [
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
];
const COLORS = [2, 4, 8, 16];
const BATCH_STATE = {
  running: "进行中",
  cancelling: "取消中",
  succeeded: "已完成",
  completed: "已结束",
};

let appApi = null;
let dockEl = null;
let windowEl = null;
let runEl = null;
let presetEl = null;

const ui = {
  windowOpen: false,
  collapsed: false,
  zoomAsset: "",
  run: null,
  runBusy: false,
  presetMode: "",
  editingId: "",
  draft: null,
  presetError: "",
  presetBusy: false,
  itemBusy: "",
  itemErrors: new Map(),
  resultBusy: false,
  lastPresetId: "",
};

/* ------------------------------------------------------------------ 工具 */

const presetOptions = (preset) => normalizePresetOptions(preset?.options);
const isCloud = (options) => normalizePresetOptions(options).recipe === "cloud_lineart";

function batchStateLabel(state) {
  return BATCH_STATE[state] || state || "未知";
}

function normalizeGroups(groups) {
  return (groups || [])
    .map((group) => ({
      imageId: group.imageId || group.image_id || "",
      name: group.name || "未命名纹样",
      normalizedAssetId: group.normalizedAssetId || group.normalized_asset_id || "",
      assets: [...(group.assets || [])],
    }))
    .filter((group) => group.imageId);
}

function groupAssetName(group) {
  const asset = group?.assets?.[0];
  return group?.name || asset?.source_name || "未命名纹样";
}

function stepChip(step, item) {
  const name = step?.name || "";
  const active = item?.waiting_for
    ? item.waiting_for === name
    : (item?.steps || [])[item?.cursor] === step;
  return `<span class="pf-step${active ? " is-current" : ""}" data-state="${esc(step?.state || "")}">
    <span class="pf-step__name">${esc(stepLabel(name))}</span>
    <span class="pf-step__state">${esc(stepStateLabel(step, item))}</span>
  </span>`;
}

function resultAsset(assetId) {
  for (const entry of processing.patterns.values()) {
    const found = (entry.pattern?.assets || []).find((asset) => asset.asset_id === assetId);
    if (found) return found;
  }
  return { asset_id: assetId, kind: "asset", width: 0, height: 0 };
}

/* ------------------------------------------------------------------ 启动入口 */

export function initProcessingUI(api) {
  if (appApi) return;
  appApi = api;
  ensureDock();
  subscribeProcessing((reason) => {
    paintDock();
    if (ui.windowOpen) paintWindow();
    if (ui.run && reason.startsWith("presets")) paintRun();
    if (ui.presetMode && reason === "presets") paintPresets();
  });
  document.addEventListener("keydown", onGlobalKey);
  loadPresets({ silent: true });
  loadBatches({ silent: true }).then(() => paintDock());
  startProcessingPolling();
}

function ensureDock() {
  if (dockEl) return dockEl;
  dockEl = document.createElement("button");
  dockEl.type = "button";
  dockEl.className = "pf-dock";
  dockEl.id = "pf-dock";
  dockEl.hidden = true;
  dockEl.addEventListener("click", () => {
    if (ui.windowOpen) closeProcessingWindow();
    else openProcessingWindow();
  });
  document.querySelector(".app")?.append(dockEl);
  paintDock();
  return dockEl;
}

function paintDock() {
  if (!dockEl) return;
  const active = activeBatchCount();
  const total = processing.batches.length;
  dockEl.hidden = total === 0;
  dockEl.setAttribute("aria-expanded", String(ui.windowOpen));
  dockEl.innerHTML = `
    <span class="pf-dock__dot${active ? " is-active" : ""}" aria-hidden="true"></span>
    <span class="pf-dock__label">处理批次</span>
    <span class="pf-dock__meta mono">${active ? `${active} 个进行中` : total ? `${total} 个记录` : ""}</span>
  `;
  dockEl.title = active ? "有批次正在处理；打开进度浮窗" : "打开处理批次";
}

/* ------------------------------------------------------------------ 进度浮窗 */

function ensureWindow() {
  if (windowEl) return windowEl;
  windowEl = document.createElement("section");
  windowEl.className = "pf-window";
  windowEl.setAttribute("role", "dialog");
  windowEl.setAttribute("aria-label", "批量处理进度");
  windowEl.hidden = true;
  windowEl.addEventListener("click", onWindowClick);
  windowEl.addEventListener("change", onWindowChange);
  document.querySelector(".app")?.append(windowEl);
  return windowEl;
}

/** 打开进度浮窗；不传 batchId 时恢复服务端最近的批次。 */
export async function openProcessingWindow({ batchId = "" } = {}) {
  ensureWindow();
  ui.windowOpen = true;
  ui.collapsed = false;
  windowEl.hidden = false;
  if (!processing.presets.length) loadPresets({ silent: true });
  if (batchId) {
    processing.selectedBatchId = batchId;
    await loadBatch(batchId);
  } else {
    if (!processing.batches.length) await loadBatches();
    if (processing.selectedBatchId) await loadBatch(processing.selectedBatchId);
  }
  paintWindow();
  windowEl.querySelector("[data-pf-close-window]")?.focus({ preventScroll: true });
}

export function closeProcessingWindow() {
  ui.windowOpen = false;
  ui.zoomAsset = "";
  if (windowEl) windowEl.hidden = true;
  paintDock();
}

function paintWindow() {
  if (!windowEl) return;
  const body = windowEl.querySelector(".pf-window__body");
  const scrollTop = body?.scrollTop || 0;
  windowEl.classList.toggle("is-collapsed", ui.collapsed);
  windowEl.innerHTML = windowHtml();
  const next = windowEl.querySelector(".pf-window__body");
  if (next) next.scrollTop = scrollTop;
}

function windowHtml() {
  const batch = processing.detail;
  const progress = batch ? batchProgress(batch) : null;
  const state = batch ? batchStateLabel(batch.state) : "未选择批次";
  return `
  <header class="pf-window__head">
    <div class="pf-window__title">
      <span class="label">批量处理</span>
      <h2>${batch ? esc(batch.snapshot?.name || "处理批次") : "处理批次"}</h2>
      <p class="mono pf-window__meta">${
        batch
          ? `${esc(state)} · ${batch.progress?.completed ?? 0}/${batch.progress?.total ?? batch.items?.length ?? 0} 张 · ${esc(
              formatTime(batch.created_at, { withDate: true })
            )}`
          : "从工作台或纹样库发起一次处理"
      }</p>
    </div>
    <div class="pf-window__head-acts">
      <button class="icon-btn" type="button" data-pf-collapse aria-label="${ui.collapsed ? "展开进度浮窗" : "收起进度浮窗"}"
        aria-expanded="${ui.collapsed ? "false" : "true"}">${icon("chevron")}</button>
      <button class="icon-btn" type="button" data-pf-close-window aria-label="关闭批次浮窗">${icon("close")}</button>
    </div>
  </header>
  ${
    ui.collapsed
      ? `<p class="pf-window__collapsed" data-pf-collapsed-summary>${
          batch
            ? `${esc(state)} · ${progress.percent}% · 待确认 ${progress.waiting} · 失败 ${progress.failed}`
            : "未选择批次"
        }</p>`
      : `<div class="pf-window__body">
          ${windowToolbarHtml(batch)}
          ${
            processing.listError
              ? `<p class="pf-error" role="alert">${esc(processing.listError)}</p>`
              : ""
          }
          ${
            processing.detailError
              ? `<p class="pf-error" role="alert">${esc(processing.detailError)}</p>`
              : ""
          }
          ${batch ? batchDetailHtml(batch, progress) : emptyWindowHtml()}
        </div>`
  }
  ${windowZoomHtml()}`;
}

function emptyWindowHtml() {
  return `
  <div class="pf-empty">
    <p>最近还没有处理批次。</p>
    <p class="field__hint">从工作台「一键处理」或纹样库「批量处理」发起；提交后进度保存在本机服务，刷新页面也能从这里恢复。</p>
  </div>`;
}

function windowToolbarHtml(batch) {
  const options = [...(processing.batches || [])];
  return `
  <div class="pf-toolbar">
    <label class="pf-select" for="pf-batch-select">
      <span class="label">批次</span>
      <select class="select" id="pf-batch-select" data-pf-batch>
        ${
          options.length
            ? options
                .map(
                  (entry) =>
                    `<option value="${esc(entry.batch_id)}"${
                      entry.batch_id === (batch?.batch_id || processing.selectedBatchId) ? " selected" : ""
                    }>${esc(entry.snapshot?.name || "批次")} · ${esc(batchStateLabel(entry.state))} · ${esc(
                      formatTime(entry.created_at, { withDate: true })
                    )}</option>`
                )
                .join("")
            : `<option value="">没有批次</option>`
        }
      </select>
    </label>
    <div class="pf-toolbar__acts">
      <button class="btn btn--quiet btn--sm" type="button" data-pf-refresh${batch ? "" : " disabled"}>${icon("history")}刷新</button>
      ${
        processing.listNextCursor
          ? `<button class="btn btn--quiet btn--sm" type="button" data-pf-more-batches>更早批次</button>`
          : ""
      }
      <button class="btn btn--quiet btn--sm" type="button" data-pf-open-presets>${icon("sliders")}预设管理</button>
    </div>
  </div>`;
}

function batchDetailHtml(batch, progress) {
  const options = normalizePresetOptions(batch.snapshot?.options);
  const steps = presetSteps(options);
  return `
  <div class="pf-summary">
    <div class="pf-progress" role="group" aria-label="整体进度">
      <div class="pf-progress__head">
        <span>${esc(batchStateLabel(batch.state))}</span>
        <span class="mono">${progress.completed}/${progress.total} · ${progress.percent}%</span>
      </div>
      <div class="pf-meter" aria-hidden="true"><span style="width:${Math.max(2, progress.percent)}%"></span></div>
      <p class="pf-progress__counts mono">成功 ${progress.succeeded} · 待确认 ${progress.waiting} · 处理中 ${progress.running} · 排队 ${progress.queued} · 失败 ${progress.failed} · 取消 ${progress.cancelled}</p>
    </div>
    <p class="pf-snapshot">
      预设「${esc(batch.snapshot?.name || "")}」· ${esc(recipeLabel(options.recipe))} · 修订 ${Number(
        batch.snapshot?.preset_revision || 0
      )}<br />
      快照固定于提交时：之后修改预设不会改变这一批。预计自动云端调用
      <span class="mono">${Number(batch.snapshot?.planned_provider_calls) || 0}</span> 次；人工门里的云端操作另计。
    </p>
    <div class="pf-steps" aria-label="预设步骤">
      ${steps
        .map(
          (step) =>
            `<span class="pf-stepchip${step.manual ? " is-manual" : ""}${step.cloud ? " is-cloud" : ""}">${esc(
              step.label
            )}</span>`
        )
        .join("")}
    </div>
  </div>
  <ul class="pf-items">
    ${(batch.items || []).map((item) => itemHtml(batch, item)).join("")}
  </ul>
  <footer class="pf-window__foot">
    <button class="btn btn--ghost btn--sm" type="button" data-pf-export-results${
      resultAssetIds(batch).length ? "" : " disabled"
    }>${icon("download")}导出结果</button>
    <span class="pf-foot-note">${ui.resultBusy ? "正在准备结果…" : "结果导出按原图分组，可选整组或同处理类型。"}</span>
    <button class="btn btn--quiet btn--sm" type="button" data-pf-cancel-batch${
      canCancelBatch(batch) ? "" : " disabled"
    }>取消批次</button>
  </footer>
  <p class="pf-window__hint">批次由本机服务后台推进，页面关闭或刷新都不会停止；这里只读取状态。失败不会自动重试，尤其云端结果未知时请先在任务记录核对。</p>`;
}

function itemHtml(batch, item) {
  const pattern = patternFor(item.image_id);
  const name = pattern?.name || `#${shortId(item.image_id)}`;
  const queueBlocked = (item.steps || []).some((step) => step.queue_blocked);
  const results = [...new Set(item.results || [])];
  const waiting = item.waiting_for;
  const candidates = waiting ? manualCandidates(waiting, pattern) : [];
  const patternEntry = processing.patterns.get(item.image_id);
  const itemError = ui.itemErrors.get(item.item_id) || "";
  const busy = ui.itemBusy === item.item_id;
  return `
  <li class="pf-item" data-pf-item="${esc(item.item_id)}" data-state="${esc(item.state)}">
    <header class="pf-item__head">
      <span class="pf-item__name">${esc(name)}</span>
      <span class="pf-badge" data-state="${esc(item.state)}">${esc(itemStateLabel(item.state))}</span>
    </header>
    <div class="pf-item__steps">${(item.steps || []).map((step) => stepChip(step, item)).join("")}</div>
    ${
      queueBlocked
        ? `<p class="pf-note pf-note--queue">${icon("info")}队列已满：这张图在等待空位，未失败；空位释放后会自动继续。</p>`
        : ""
    }
    ${
      item.error?.code
        ? `<p class="pf-error" role="alert">${esc(batchErrorText(item.error.code))} 不会自动重试${
            /cloud|provider/i.test(item.error.code) ? "；云端结果未知时请先核对任务记录。" : "。"
          }</p>`
        : ""
    }
    ${
      waiting
        ? waitingHtml(batch, item, { candidates, patternEntry, busy })
        : ""
    }
    ${results.length ? resultThumbsHtml(item, results) : ""}
    ${
      item.state === "cancelling" || item.state === "cancelled" || item.state === "running" || item.state === "queued"
        ? `<p class="pf-note">${esc(cancelNote(batch, item))}</p>`
        : ""
    }
    ${itemError ? `<p class="pf-error" role="alert">${esc(itemError)}</p>` : ""}
  </li>`;
}

function waitingHtml(batch, item, { candidates, patternEntry, busy }) {
  return `
  <div class="pf-gate">
    <p class="pf-gate__title">${icon("alert")}等待「${esc(manualStepLabel(item.waiting_for))}」的人工确认</p>
    <p class="pf-gate__copy">这一步不会自动生成结果。请到既有工作台完成「${esc(
      manualStepLabel(item.waiting_for)
    )}」，再回到这里选择这次生成的后代版本；不能用旧结果自动通过。</p>
    <p class="pf-gate__hint">人工门里的云端操作可能产生额外费用，沿用工作台现有的同意项，不计入本批次的预计云端调用。</p>
    <div class="pf-gate__acts">
      <button class="btn btn--ghost btn--sm" type="button" data-pf-workbench="${esc(item.item_id)}"${
        busy ? " disabled" : ""
      }>${icon("arrow")}在工作台处理</button>
      <button class="btn btn--quiet btn--sm" type="button" data-pf-refresh-item="${esc(item.item_id)}"${
        busy ? " disabled" : ""
      }>${icon("history")}刷新候选</button>
    </div>
    ${
      patternEntry?.loading && !patternEntry?.pattern
        ? `<p class="pf-gate__state">正在读取这张原图的候选…</p>`
        : candidates.length
        ? `<ul class="pf-candidates">
            ${candidates
              .map(
                (asset) => `<li class="pf-candidate">
                  <span class="pf-candidate__thumb"><img src="${http.assetPreviewUrl(
                    asset.asset_id
                  )}" alt="" loading="lazy" decoding="async" /></span>
                  <span class="pf-candidate__meta">
                    <span>${esc(kindLabel(asset.kind))} · ${esc(dimsOf(asset))}</span>
                    <span class="mono">${esc(formatTime(asset.created_at, { withDate: true }))} · ${esc(
                      shortId(asset.asset_id)
                    )}</span>
                  </span>
                  <button class="btn btn--primary btn--sm" type="button" data-pf-resume="${esc(
                    item.item_id
                  )}" data-asset="${esc(asset.asset_id)}"${busy ? " disabled" : ""}>用这个结果续接</button>
                </li>`
              )
              .join("")}
          </ul>
          <p class="pf-gate__hint">只列出同图、同类型的版本；是否为当前版本的后代由服务端校验，选错会被拒绝。</p>`
        : `<p class="pf-gate__state">还没有「${esc(manualStepLabel(item.waiting_for))}」类型的后代版本。请先在工作台生成，再点刷新候选。</p>`
    }
  </div>`;
}

function resultThumbsHtml(item, results) {
  const shown = results.slice(-8);
  return `
  <div class="pf-results">
    <div class="pf-results__head">
      <span class="label">结果</span>
      <span class="mono">${results.length} 个版本${results.length > shown.length ? ` · 仅显示最近 ${shown.length} 个` : ""}</span>
    </div>
    <ul class="pf-results__grid">
      ${shown
        .map((assetId) => {
          const asset = resultAsset(assetId);
          return `<li>
            <button class="pf-result" type="button" data-pf-zoom="${esc(assetId)}"
              aria-label="${esc(`放大预览 ${kindLabel(asset.kind)}`)}">
              <img src="${http.assetPreviewUrl(assetId)}" alt="" loading="lazy" decoding="async" />
              <span class="pf-result__cap">${esc(kindLabel(asset.kind))}</span>
            </button>
          </li>`;
        })
        .join("")}
    </ul>
  </div>`;
}

function windowZoomHtml() {
  if (!ui.zoomAsset) return "";
  const asset = resultAsset(ui.zoomAsset);
  return `
  <div class="pf-zoom" data-pf-zoom-layer role="dialog" aria-modal="true" aria-label="结果放大预览">
    <button class="pf-zoom__backdrop" type="button" data-pf-zoom-close aria-label="关闭放大预览"></button>
    <figure class="pf-zoom__panel">
      <img src="${http.assetPreviewUrl(ui.zoomAsset)}" alt="${esc(kindLabel(asset.kind))} 放大预览" />
      <figcaption>
        <span>${esc(kindLabel(asset.kind))} · ${esc(dimsOf(asset))}</span>
        <span class="mono">${esc(shortId(ui.zoomAsset))}</span>
        <button class="btn btn--quiet btn--sm" type="button" data-pf-zoom-close>关闭</button>
      </figcaption>
    </figure>
  </div>`;
}

/* ------------------------------------------------------------------ 进度浮窗事件 */

async function onWindowClick(event) {
  const target = event.target.closest("[data-pf-close-window], [data-pf-collapse], [data-pf-refresh], [data-pf-more-batches], [data-pf-open-presets], [data-pf-workbench], [data-pf-refresh-item], [data-pf-resume], [data-pf-cancel-batch], [data-pf-export-results], [data-pf-zoom], [data-pf-zoom-close]");
  if (!target) return;
  if (target.dataset.pfMoreBatches !== undefined) {
    target.disabled = true;
    await loadBatches({ cursor: processing.listNextCursor || "" });
    paintWindow();
    return;
  }
  if (target.dataset.pfCloseWindow !== undefined) {
    closeProcessingWindow();
    return;
  }
  if (target.dataset.pfCollapse !== undefined) {
    ui.collapsed = !ui.collapsed;
    paintWindow();
    return;
  }
  if (target.dataset.pfOpenPresets !== undefined) {
    openPresetManager();
    return;
  }
  if (target.dataset.pfZoomClose !== undefined) {
    ui.zoomAsset = "";
    paintWindow();
    return;
  }
  if (target.dataset.pfZoom) {
    ui.zoomAsset = target.dataset.pfZoom;
    paintWindow();
    return;
  }
  if (target.dataset.pfRefresh !== undefined) {
    const batch = processing.detail;
    if (!batch) return;
    target.disabled = true;
    await loadBatch(batch.batch_id);
    for (const item of batch.items || []) {
      if (item.state === "waiting" || (item.results || []).length) await loadPattern(item.image_id, { force: true });
    }
    paintWindow();
    return;
  }
  if (target.dataset.pfWorkbench) {
    const item = (processing.detail?.items || []).find((entry) => entry.item_id === target.dataset.pfWorkbench);
    if (!item) return;
    const stage = manualStage(item.waiting_for);
    const query = { image: item.image_id, stage };
    if (item.current_asset_id) query.asset = item.current_asset_id;
    ui.collapsed = true;
    paintWindow();
    appApi?.toast(`已打开工作台：完成「${manualStepLabel(item.waiting_for)}」后回到批次浮窗，选择这次生成的后代版本续接。`, "info");
    appApi?.go("workbench", { query });
    return;
  }
  if (target.dataset.pfRefreshItem) {
    const item = (processing.detail?.items || []).find((entry) => entry.item_id === target.dataset.pfRefreshItem);
    if (!item) return;
    target.disabled = true;
    await loadPattern(item.image_id, { force: true });
    ui.itemErrors.delete(item.item_id);
    paintWindow();
    return;
  }
  if (target.dataset.pfResume) {
    const itemId = target.dataset.pfResume;
    const assetId = target.dataset.asset;
    const batch = processing.detail;
    const item = (batch?.items || []).find((entry) => entry.item_id === itemId);
    if (!batch || !item || !assetId) return;
    ui.itemBusy = itemId;
    ui.itemErrors.delete(itemId);
    paintWindow();
    try {
      await resumeItem(batch.batch_id, itemId, batch.revision, assetId);
      appApi?.toast("已确认续接这张图，后续步骤继续由服务端推进。", "done");
    } catch (error) {
      const message = error?.message || "续接没有完成。";
      ui.itemErrors.set(itemId, message);
      appApi?.toast(message, "warn");
    } finally {
      ui.itemBusy = "";
      paintWindow();
    }
    return;
  }
  if (target.dataset.pfCancelBatch !== undefined) {
    const batch = processing.detail;
    if (!batch) return;
    const confirmed = window.confirm(
      "取消这一批处理？\n未启动步骤会停止；已发往云端的请求无法撤回，云端结果仍会保留。"
    );
    if (!confirmed) return;
    target.disabled = true;
    try {
      await cancelBatch(batch.batch_id, batch.revision);
      appApi?.toast("已请求取消批次；已发送的云端调用会等待终态，不会显示为已撤回。", "info");
    } catch (error) {
      appApi?.toast(error?.message || "取消批次失败。", "warn");
    }
    paintWindow();
    return;
  }
  if (target.dataset.pfExportResults !== undefined) {
    await exportBatchResults();
  }
}

async function onWindowChange(event) {
  if (event.target.matches("[data-pf-batch]")) {
    await selectBatch(event.target.value);
    paintWindow();
  }
}

async function exportBatchResults() {
  const batch = processing.detail;
  if (!batch || ui.resultBusy) return;
  ui.resultBusy = true;
  paintWindow();
  try {
    for (const item of batch.items || []) {
      if ((item.results || []).length) await loadPattern(item.image_id, { force: true });
    }
    const groups = resultGroups(batch);
    if (!groups.length) {
      appApi?.toast("这批还没有可导出的结果；完成或人工续接后再试。", "warn");
      return;
    }
    openBatchExport({
      api: appApi,
      groups,
      preselected: resultAssetIds(batch),
      scopeNote: `本批次结果所在的 ${groups.length} 个原图组（含这些组的全部已有版本）`,
    });
  } finally {
    ui.resultBusy = false;
    paintWindow();
  }
}

/* ------------------------------------------------------------------ 预设管理 */

export async function openPresetManager({ presetId = "" } = {}) {
  if (!processing.presets.length) await loadPresets({ silent: true });
  const presets = processing.presets;
  const selected = presetById(presetId) || presetById(ui.editingId) || presets[0] || null;
  ui.presetMode = selected ? "edit" : "create";
  ui.editingId = selected?.preset_id || "";
  ui.draft = selected
    ? { name: selected.name, options: presetOptions(selected) }
    : { name: "", options: defaultPresetOptions() };
  ui.presetError = "";
  ensurePresetEl();
  presetEl.hidden = false;
  paintPresets();
  presetEl.querySelector("[data-pf-name]")?.focus({ preventScroll: true });
}

function ensurePresetEl() {
  if (presetEl) return presetEl;
  presetEl = document.createElement("div");
  presetEl.className = "pf-layer pf-layer--top";
  presetEl.hidden = true;
  presetEl.addEventListener("click", onPresetClick);
  presetEl.addEventListener("change", onPresetChange);
  presetEl.addEventListener("input", onPresetInput);
  document.querySelector(".app")?.append(presetEl);
  return presetEl;
}

function closePresetManager() {
  if (presetEl) presetEl.hidden = true;
  ui.presetMode = "";
  ui.presetError = "";
  if (ui.run) paintRun();
}

function paintPresets() {
  if (!presetEl) return;
  presetEl.innerHTML = presetLayerHtml();
}

function presetLayerHtml() {
  const presets = processing.presets;
  const selected = presetById(ui.editingId);
  return `
  <div class="pf-layer__backdrop" data-pf-close-presets aria-hidden="true"></div>
  <div class="pf-modal pf-presets" role="dialog" aria-modal="true" aria-label="流程预设管理">
    <header class="pf-modal__head">
      <div>
        <span class="label">流程预设</span>
        <h2>预设管理</h2>
        <p class="pf-modal__lead">预设保存处理步骤与参数；提交批次时冻结为快照，之后修改不会改变已有批次。</p>
      </div>
      <button class="icon-btn" type="button" data-pf-close-presets aria-label="关闭预设管理">${icon("close")}</button>
    </header>
    <div class="pf-presets__body">
      <aside class="pf-presets__list" aria-label="预设列表">
        <div class="pf-presets__list-head">
          <span class="label">全部预设</span>
          <button class="btn btn--quiet btn--sm" type="button" data-pf-preset-new>${icon("plus")}新建</button>
        </div>
        <ul>
          ${presets
            .map(
              (preset) => `<li>
                <button class="pf-preset-row${preset.preset_id === ui.editingId ? " is-active" : ""}" type="button"
                  data-pf-preset-select="${esc(preset.preset_id)}">
                  <span class="pf-preset-row__name">${esc(preset.name)}</span>
                  <span class="pf-preset-row__meta mono">${esc(recipeLabel(presetOptions(preset).recipe))} · 修订 ${preset.revision}${
                    preset.builtin ? " · 内置" : ""
                  }</span>
                </button>
              </li>`
            )
            .join("")}
        </ul>
        <p class="field__hint">内置预设可以修改，也可以复制成自己的预设；只有自建预设能删除。</p>
      </aside>
      <section class="pf-presets__editor" aria-label="预设编辑">
        ${presetEditorHtml(selected)}
      </section>
    </div>
  </div>`;
}

function presetEditorHtml(selected) {
  const draft = ui.draft || { name: "", options: defaultPresetOptions() };
  const options = normalizePresetOptions(draft.options);
  const creating = ui.presetMode === "create";
  const steps = presetSteps(options);
  const limits = healthPixelLimits();
  const effective = effectiveWorkingLimit(options, limits);
  const workingMax = limits.workingCopy;
  const pngOnly = !options.vectorize && !options.tile;
  const effectiveText = effective.complete ? `${formatPixels(effective.value)} 像素` : "未知（本机服务未报告全部上限）";
  const copyText =
    options.working_max_pixels === null
      ? "未设置显式副本：不会自动缩放；超过路线有效上限时该步会失败，可在工作台手动创建工作副本。"
      : effective.complete
      ? `实际副本上限 = min(设置 ${formatPixels(options.working_max_pixels)}, 路线 ${formatPixels(
          effective.value
        )}) = ${formatPixels(effective.copy)} 像素。`
      : "设置了显式副本，但本机服务未报告完整上限，实际值由服务端按整条路线取较小值。";
  return `
  <div class="pf-form" data-pf-preset-form role="group" aria-label="预设参数">
    <div class="pf-field">
      <label class="field__label" for="pf-preset-name"><span>预设名称</span><span class="mono">${creating ? "新建" : `修订 ${selected?.revision ?? ""}`}</span></label>
      <input class="input" id="pf-preset-name" data-pf-name maxlength="80" value="${esc(draft.name)}" autocomplete="off" />
    </div>
    <div class="pf-field">
      <label class="field__label" for="pf-recipe"><span>处理路线</span></label>
      <select class="select" id="pf-recipe" data-pf-recipe>
        ${[
          ["model_lineart", "本地模型线稿 → SVG"],
          ["cloud_lineart", "云端线稿 → SVG"],
          ["color", "颜色提取 → SVG"],
        ]
          .map(
            ([value, label]) => `<option value="${value}"${options.recipe === value ? " selected" : ""}>${esc(label)}</option>`
          )
          .join("")}
      </select>
    </div>
    ${
      options.recipe === "color"
        ? `<fieldset class="pf-fieldset">
            <legend class="label">颜色提取参数</legend>
            <div class="pf-grid2">
              <label class="field" for="pf-extract-mode">
                <span class="field__label">提取模式</span>
                <select class="select" id="pf-extract-mode" data-pf-extract-mode>
                  ${EXTRACT_MODES.map(
                    ([value, label]) =>
                      `<option value="${value}"${options.extract.mode === value ? " selected" : ""}>${esc(label)}</option>`
                  ).join("")}
                </select>
              </label>
              <label class="field" for="pf-extract-polarity">
                <span class="field__label">前景</span>
                <select class="select" id="pf-extract-polarity" data-pf-extract-polarity>
                  <option value="dark"${options.extract.polarity === "dark" ? " selected" : ""}>深色前景</option>
                  <option value="light"${options.extract.polarity === "light" ? " selected" : ""}>浅色前景</option>
                </select>
              </label>
              <label class="field" for="pf-extract-threshold">
                <span class="field__label">阈值 <span class="mono">0–255</span></span>
                <input class="input" id="pf-extract-threshold" type="number" min="0" max="255" step="1"
                  data-pf-extract-threshold value="${Number(options.extract.threshold) || 127}" />
              </label>
              <label class="field" for="pf-extract-area">
                <span class="field__label">最少构件面积 <span class="mono">px</span></span>
                <input class="input" id="pf-extract-area" type="number" min="0" max="10000" step="1"
                  data-pf-extract-area value="${Number(options.extract.min_component_area) || 0}" />
              </label>
            </div>
          </fieldset>`
        : ""
    }
    <fieldset class="pf-fieldset">
      <legend class="label">矢量化参数</legend>
      <div class="pf-grid2">
        <label class="field" for="pf-vector-mode">
          <span class="field__label">模式</span>
          <select class="select" id="pf-vector-mode" data-pf-vector-mode>
            ${VECTOR_MODES.map(
              ([value, label]) =>
                `<option value="${value}"${options.vector.mode === value ? " selected" : ""}>${esc(label)}</option>`
            ).join("")}
          </select>
        </label>
        <label class="field" for="pf-vector-colors">
          <span class="field__label">颜色数</span>
          <select class="select" id="pf-vector-colors" data-pf-vector-colors>
            ${COLORS.map(
              (value) => `<option value="${value}"${Number(options.vector.max_colors) === value ? " selected" : ""}>${value} 色</option>`
            ).join("")}
          </select>
        </label>
        <label class="field" for="pf-vector-detail">
          <span class="field__label">细节</span>
          <select class="select" id="pf-vector-detail" data-pf-vector-detail>
            ${DETAILS.map(
              ([value, label]) =>
                `<option value="${value}"${options.vector.detail === value ? " selected" : ""}>${esc(label)}</option>`
            ).join("")}
          </select>
        </label>
        <label class="field" for="pf-working-max">
          <span class="field__label">工作副本上限 <span class="mono">px</span></span>
          <input class="input" id="pf-working-max" type="number" min="10000"${workingMax ? ` max="${workingMax}"` : ""} step="1000"
            data-pf-working-max placeholder="留空 = 不缩放"
            value="${options.working_max_pixels === null ? "" : Number(options.working_max_pixels)}" />
        </label>
      </div>
      <p class="field__hint">显式副本范围 10,000–${
        workingMax ? `${formatPixels(workingMax)}` : "由服务端决定"
      } 像素。批次整条路线有效上限：${effectiveText}。${copyText}</p>
      ${pngOnly ? `<p class="field__hint">当前关闭矢量化与平铺：批次只生成提取 PNG，不产出 SVG/平铺，仍是有效流程。</p>` : ""}
    </fieldset>
    <fieldset class="pf-fieldset">
      <legend class="label">人工确认门与输出</legend>
      <div class="pf-toggles">
        ${toggleHtml("crop", "裁切", options.crop)}
        ${toggleHtml("repair", "修复", options.repair)}
        ${toggleHtml("candidates", "候选合成", options.candidates)}
        ${toggleHtml("mask", "蒙版修正", options.mask)}
        ${toggleHtml("vectorize", "矢量化", options.vectorize)}
        ${toggleHtml("tile", "平铺", options.tile)}
      </div>
      <p class="field__hint">人工门不会自动生成结果：批次会暂停该图，需回到工作台完成后再选择后代版本续接。矢量化与平铺都关闭时只生成 PNG 提取结果。</p>
    </fieldset>
    <div class="pf-steps-preview">
      <span class="label">步骤预览</span>
      ${steps
        .map(
          (step) =>
            `<span class="pf-stepchip${step.manual ? " is-manual" : ""}${step.cloud ? " is-cloud" : ""}">${esc(
              step.label
            )}${step.manual ? " · 人工" : ""}</span>`
        )
        .join("")}
    </div>
    ${ui.presetError ? `<p class="pf-error" role="alert">${esc(ui.presetError)}</p>` : ""}
    <div class="pf-form__acts">
      <button class="btn btn--primary btn--sm" type="button" data-pf-preset-save${ui.presetBusy ? " disabled" : ""}>${
        creating ? "创建预设" : "保存修改"
      }</button>
      ${
        creating
          ? ""
          : `<button class="btn btn--ghost btn--sm" type="button" data-pf-preset-copy${ui.presetBusy ? " disabled" : ""}>复制为新预设</button>
             <button class="btn btn--quiet btn--sm" type="button" data-pf-preset-delete${
               selected?.builtin || ui.presetBusy ? " disabled" : ""
             } title="${selected?.builtin ? "内置预设不能删除" : "删除这个预设"}">删除</button>`
      }
      <button class="btn btn--quiet btn--sm" type="button" data-pf-close-presets>关闭</button>
    </div>
    <p class="pf-form__hint">保存不会改变已经提交的批次；已提交批次使用提交时的快照。</p>
  </div>`;
}

function toggleHtml(key, label, checked) {
  return `
  <label class="pf-toggle">
    <input type="checkbox" data-pf-option="${key}" ${checked ? "checked" : ""} />
    <span>${esc(label)}</span>
  </label>`;
}

function readPresetDraft() {
  const form = presetEl?.querySelector("[data-pf-preset-form]");
  if (!form) return ui.draft;
  const options = normalizePresetOptions(ui.draft?.options);
  const value = (selector) => form.querySelector(selector);
  options.recipe = value("[data-pf-recipe]")?.value || options.recipe;
  options.extract.mode = value("[data-pf-extract-mode]")?.value || options.extract.mode;
  options.extract.polarity = value("[data-pf-extract-polarity]")?.value || options.extract.polarity;
  options.extract.threshold = Number(value("[data-pf-extract-threshold]")?.value ?? options.extract.threshold);
  options.extract.min_component_area = Number(value("[data-pf-extract-area]")?.value ?? options.extract.min_component_area);
  options.vector.mode = value("[data-pf-vector-mode]")?.value || options.vector.mode;
  options.vector.max_colors = Number(value("[data-pf-vector-colors]")?.value ?? options.vector.max_colors);
  options.vector.detail = value("[data-pf-vector-detail]")?.value || options.vector.detail;
  const workingRaw = value("[data-pf-working-max]")?.value;
  options.working_max_pixels = String(workingRaw || "").trim() === "" ? null : Number(workingRaw);
  for (const key of ["crop", "repair", "candidates", "mask", "vectorize", "tile"]) {
    options[key] = Boolean(value(`[data-pf-option="${key}"]`)?.checked);
  }
  return {
    name: value("[data-pf-name]")?.value || "",
    options,
  };
}

function syncDraftFromForm() {
  const draft = readPresetDraft();
  if (draft) ui.draft = draft;
  return draft;
}

function onPresetInput(event) {
  if (event.target.matches("[data-pf-name], [data-pf-working-max], [data-pf-extract-threshold], [data-pf-extract-area]")) {
    syncDraftFromForm();
  }
}

function onPresetChange(event) {
  if (!event.target.matches("[data-pf-recipe], [data-pf-extract-mode], [data-pf-extract-polarity], [data-pf-vector-mode], [data-pf-vector-colors], [data-pf-vector-detail], [data-pf-option]")) {
    return;
  }
  syncDraftFromForm();
  paintPresets();
}

async function onPresetClick(event) {
  const target = event.target.closest(
    "[data-pf-close-presets], [data-pf-preset-select], [data-pf-preset-new], [data-pf-preset-save], [data-pf-preset-copy], [data-pf-preset-delete]"
  );
  if (!target) return;
  if (target.dataset.pfClosePresets !== undefined) {
    closePresetManager();
    return;
  }
  if (target.dataset.pfPresetSelect) {
    const preset = presetById(target.dataset.pfPresetSelect);
    if (!preset) return;
    ui.presetMode = "edit";
    ui.editingId = preset.preset_id;
    ui.draft = { name: preset.name, options: presetOptions(preset) };
    ui.presetError = "";
    paintPresets();
    return;
  }
  if (target.dataset.pfPresetNew !== undefined) {
    ui.presetMode = "create";
    ui.editingId = "";
    ui.draft = { name: "", options: defaultPresetOptions() };
    ui.presetError = "";
    paintPresets();
    presetEl.querySelector("[data-pf-name]")?.focus({ preventScroll: true });
    return;
  }
  if (target.dataset.pfPresetSave !== undefined) {
    const draft = syncDraftFromForm();
    const error = presetValidation(draft.name, draft.options, healthPixelLimits());
    if (error) {
      ui.presetError = error;
      paintPresets();
      return;
    }
    const editing = presetById(ui.editingId);
    if (ui.presetMode !== "create" && !editing) {
      ui.presetError = "预设已不存在，请重新选择或新建。";
      paintPresets();
      return;
    }
    ui.presetBusy = true;
    ui.presetError = "";
    try {
      let saved;
      if (ui.presetMode === "create") saved = await createPreset(draft.name, draft.options);
      else saved = await updatePreset(editing, draft.name, draft.options);
      ui.presetMode = "edit";
      ui.editingId = saved.preset_id;
      ui.draft = { name: saved.name, options: presetOptions(saved) };
      ui.lastPresetId = saved.preset_id;
      appApi?.toast("预设已保存；已提交批次不受影响。", "done");
    } catch (error) {
      ui.presetError = error?.message || "预设保存失败。";
    } finally {
      ui.presetBusy = false;
      paintPresets();
    }
    return;
  }
  if (target.dataset.pfPresetCopy !== undefined) {
    const preset = presetById(ui.editingId);
    if (!preset) return;
    ui.presetBusy = true;
    try {
      const copy = await copyPreset(preset, `${preset.name} 副本`);
      ui.presetMode = "edit";
      ui.editingId = copy.preset_id;
      ui.draft = { name: copy.name, options: presetOptions(copy) };
      ui.lastPresetId = copy.preset_id;
      appApi?.toast("已复制为新预设，可继续修改名称与参数。", "done");
    } catch (error) {
      ui.presetError = error?.message || "复制预设失败。";
    } finally {
      ui.presetBusy = false;
      paintPresets();
    }
    return;
  }
  if (target.dataset.pfPresetDelete !== undefined) {
    const preset = presetById(ui.editingId);
    if (!preset) return;
    if (!window.confirm(`删除预设「${preset.name}」？已提交批次仍使用它们的快照。`)) return;
    ui.presetBusy = true;
    try {
      await deletePreset(preset);
      const next = processing.presets[0] || null;
      ui.presetMode = next ? "edit" : "create";
      ui.editingId = next?.preset_id || "";
      ui.draft = next
        ? { name: next.name, options: presetOptions(next) }
        : { name: "", options: defaultPresetOptions() };
      appApi?.toast("预设已删除；已有批次不变。", "done");
    } catch (error) {
      ui.presetError = error?.message || "删除预设失败。";
    } finally {
      ui.presetBusy = false;
      paintPresets();
    }
  }
}

/* ------------------------------------------------------------------ 启动浮窗 */

export async function openRunDialog({ groups, preselectedImageIds = [], preferredInputs = {}, sourceLabel = "" } = {}) {
  if (!processing.presets.length) await loadPresets({ silent: true });
  const defaultPreset = presetById(ui.lastPresetId) || processing.presets[0] || null;
  const normalized = normalizeGroups(groups);
  ui.run = {
    groups: normalized,
    selected: new Set(preselectedImageIds.filter((id) => normalized.some((group) => group.imageId === id))),
    preferredInputs: { ...preferredInputs },
    presetId: defaultPreset?.preset_id || "",
    consentUpload: false,
    consentCharge: false,
    error: "",
    sourceLabel,
  };
  pruneRunSelection(ui.run);
  ensureRunEl();
  runEl.hidden = false;
  paintRun();
  runEl.querySelector("[data-pf-run-preset]")?.focus({ preventScroll: true });
}

function ensureRunEl() {
  if (runEl) return runEl;
  runEl = document.createElement("div");
  runEl.className = "pf-layer";
  runEl.hidden = true;
  runEl.addEventListener("click", onRunClick);
  runEl.addEventListener("change", onRunChange);
  document.querySelector(".app")?.append(runEl);
  return runEl;
}

function closeRunDialog() {
  if (runEl) runEl.hidden = true;
  ui.run = null;
  ui.runBusy = false;
}

/** 换预设后不能保留该路线不支持的已选图片，否则预计调用数会虚高。 */
function pruneRunSelection(run) {
  if (!run) return;
  const preset = presetById(run.presetId);
  const options = preset ? presetOptions(preset) : defaultPresetOptions();
  const compatible = new Set(
    run.groups.filter((group) => compatibleInputAssets(group, options).length).map((group) => group.imageId)
  );
  run.selected = new Set([...run.selected].filter((id) => compatible.has(id)));
}

function paintRun() {
  if (!runEl || !ui.run) return;
  runEl.innerHTML = runLayerHtml();
}

function runLayerHtml() {
  const run = ui.run;
  const preset = presetById(run.presetId);
  const options = preset ? presetOptions(preset) : defaultPresetOptions();
  const { inputs, missing } = batchInputs(run.groups, options, run.selected, run.preferredInputs);
  const missingIds = new Set(missing.map((group) => group.imageId));
  const cloud = isCloud(options);
  const estimate = estimateProviderCalls(options, run.selected.size);
  const steps = presetSteps(options);
  const limits = healthPixelLimits();
  const effective = effectiveWorkingLimit(options, limits);
  const routeCapText = effective.complete ? `${formatPixels(effective.value)} 像素` : "未知（服务未报告完整上限）";
  const pngOnly = !options.vectorize && !options.tile;
  const copyText =
    options.working_max_pixels === null
      ? "未设置显式副本（不会自动缩放）"
      : effective.complete
      ? `显式副本 ${formatPixels(options.working_max_pixels)} → 实际 ≤ ${formatPixels(effective.copy)} 像素`
      : "显式副本实际值由服务端按整条路线取较小值";
  const problem = runValidation({
    presetId: run.presetId,
    groups: run.groups,
    selectedImageIds: run.selected,
    options,
    consentToUpload: run.consentUpload,
    consentToCharge: run.consentCharge,
  });
  const startDisabled = ui.runBusy || Boolean(problem);
  return `
  <div class="pf-layer__backdrop" data-pf-close-run aria-hidden="true"></div>
  <div class="pf-modal pf-run" role="dialog" aria-modal="true" aria-label="开始批量处理">
    <header class="pf-modal__head">
      <div>
        <span class="label">${esc(run.sourceLabel || "批量处理")}</span>
        <h2>开始批量处理</h2>
        <p class="pf-modal__lead">先核对预设步骤、图片与预计云端调用；提交后由本机服务持久推进。</p>
      </div>
      <button class="icon-btn" type="button" data-pf-close-run aria-label="关闭">${icon("close")}</button>
    </header>
    <div class="pf-run__body">
      <div class="pf-run__preset">
        <div class="pf-run__preset-head">
          <label class="label" for="pf-run-preset">流程预设</label>
          <button class="btn btn--quiet btn--sm" type="button" data-pf-open-presets>${icon("sliders")}管理预设</button>
        </div>
        <select class="select" id="pf-run-preset" data-pf-run-preset>
          ${
            processing.presets.length
              ? processing.presets
                  .map(
                    (entry) =>
                      `<option value="${esc(entry.preset_id)}"${
                        entry.preset_id === run.presetId ? " selected" : ""
                      }>${esc(entry.name)}${entry.builtin ? "（内置）" : ""}</option>`
                  )
                  .join("")
              : `<option value="">还没有预设</option>`
          }
        </select>
        <p class="pf-run__meta">${esc(recipeLabel(options.recipe))} · ${steps.length} 步 · 批次路线有效上限 ${esc(
          routeCapText
        )} · ${esc(copyText)}</p>
        <p class="field__hint">${
          pngOnly
            ? "当前关闭矢量化与平铺：批次只生成 PNG 提取结果，不产出 SVG/平铺。"
            : "超过路线有效上限的单图会在该步失败；可在预设里设置显式副本，或先在工作台手动创建工作副本。"
        }</p>
        <div class="pf-steps-preview">
          ${steps
            .map(
              (step) =>
                `<span class="pf-stepchip${step.manual ? " is-manual" : ""}${step.cloud ? " is-cloud" : ""}">${esc(
                  step.label
                )}${step.manual ? " · 人工" : ""}</span>`
            )
            .join("")}
        </div>
        ${
          steps.some((step) => step.manual)
            ? `<p class="pf-gate__hint">裁切 / 修复 / 候选 / 蒙版是人工确认门：不会自动生成结果，该图会暂停，其余图片继续。届时从进度浮窗打开工作台处理，再回来选择后代版本续接。人工步骤里的云端操作可能另计费用。</p>`
            : ""
        }
      </div>

      <div class="pf-run__images">
        <div class="pf-run__images-head">
          <span class="label">选择原图（${run.selected.size}/${run.groups.length}）</span>
          <span class="pf-run__images-acts">
            <button class="btn btn--quiet btn--sm" type="button" data-pf-select-all>全选可用</button>
            <button class="btn btn--quiet btn--sm" type="button" data-pf-select-none>取消全选</button>
          </span>
        </div>
        ${
          run.groups.length
            ? `<ul class="pf-picklist">
                ${run.groups
                  .map((group) => {
                    const asset = inputs.find((entry) => entry.group.imageId === group.imageId)?.asset;
                    const unavailable = missingIds.has(group.imageId) || !asset;
                    const checked = run.selected.has(group.imageId) && !unavailable;
                    const pixels = Number(asset?.width) * Number(asset?.height);
                    const over = Boolean(effective.complete && pixels && pixels > effective.value);
                    const overNote = over
                      ? options.working_max_pixels === null
                        ? " · 超出路线有效上限，会在此步失败；请设置显式副本"
                        : ` · 超出路线有效上限，会先创建工作副本 ≤ ${formatPixels(effective.copy)} 像素`
                      : "";
                    return `<li>
                      <label class="pf-pick${unavailable ? " is-disabled" : ""}">
                        <input type="checkbox" data-pf-image="${esc(group.imageId)}" ${checked ? "checked" : ""}
                          ${unavailable ? "disabled" : ""} />
                        <span class="pf-pick__body">
                          <span class="pf-pick__name">${esc(groupAssetName(group))}</span>
                          <span class="pf-pick__meta mono">#${
                            esc(shortId(group.imageId))
                          } · ${group.assets.length} 个版本 · ${
                            unavailable
                              ? "这个预设没有兼容的输入版本"
                              : `输入：${esc(kindLabel(asset.kind))} · ${esc(dimsOf(asset))}${esc(overNote)}`
                          }</span>
                        </span>
                      </label>
                    </li>`;
                  })
                  .join("")}
              </ul>`
            : `<p class="field__hint">还没有可选原图组。先在纹样库载入或在工作台打开一张纹样。</p>`
        }
      </div>

      <div class="pf-run__cloud">
        <p class="pf-run__estimate">预计自动云端调用 <b class="num">${estimate}</b> 次${
          cloud ? "（每张图一次云端线稿）" : ""
        }。人工门里的云端操作另计，不包含在这里。</p>
        ${
          cloud
            ? `<div class="pf-consents">
                <label class="pf-consent">
                  <input type="checkbox" data-pf-consent-upload ${run.consentUpload ? "checked" : ""} />
                  <span>我确认这一批图片会上传到云端服务商（${run.selected.size} 张）。</span>
                </label>
                <label class="pf-consent">
                  <input type="checkbox" data-pf-consent-charge ${run.consentCharge ? "checked" : ""} />
                  <span>我确认这次批次可能产生 ${estimate} 次云端调用费用。</span>
                </label>
                <p class="field__hint">两项都不会默认勾选；缺少任意一项，云端批次会被服务端拒绝。</p>
              </div>`
            : `<p class="field__hint">本地路线不产生云端调用；若人工门里另选云端操作，沿用工作台现有确认。</p>`
        }
      </div>
      ${run.error ? `<p class="pf-error" role="alert">${esc(run.error)}</p>` : ""}
    </div>
    <footer class="pf-modal__foot">
      <span class="pf-foot-note">${problem ? esc(problem) : "单个批次最多 100 张；输入将使用每张原图的兼容版本。"}</span>
      <button class="btn btn--quiet btn--sm" type="button" data-pf-close-run>取消</button>
      <button class="btn btn--primary btn--sm" type="button" data-pf-run-start${startDisabled ? " disabled" : ""}>${
        ui.runBusy ? "提交中…" : "开始处理"
      }</button>
    </footer>
  </div>`;
}

function onRunChange(event) {
  const run = ui.run;
  if (!run) return;
  if (event.target.matches("[data-pf-image]")) {
    const id = event.target.dataset.pfImage;
    if (event.target.checked) run.selected.add(id);
    else run.selected.delete(id);
    run.error = "";
    paintRun();
    return;
  }
  if (event.target.matches("[data-pf-run-preset]")) {
    run.presetId = event.target.value;
    run.consentUpload = false;
    run.consentCharge = false;
    run.error = "";
    ui.lastPresetId = run.presetId;
    pruneRunSelection(run);
    paintRun();
    return;
  }
  if (event.target.matches("[data-pf-consent-upload]")) {
    run.consentUpload = event.target.checked;
    paintRun();
    return;
  }
  if (event.target.matches("[data-pf-consent-charge]")) {
    run.consentCharge = event.target.checked;
    paintRun();
  }
}

async function onRunClick(event) {
  const target = event.target.closest(
    "[data-pf-close-run], [data-pf-open-presets], [data-pf-select-all], [data-pf-select-none], [data-pf-run-start]"
  );
  if (!target || !ui.run) return;
  if (target.dataset.pfCloseRun !== undefined) {
    closeRunDialog();
    return;
  }
  if (target.dataset.pfOpenPresets !== undefined) {
    openPresetManager({ presetId: ui.run.presetId });
    return;
  }
  if (target.dataset.pfSelectAll !== undefined) {
    const preset = presetById(ui.run.presetId);
    const options = preset ? presetOptions(preset) : defaultPresetOptions();
    ui.run.selected = new Set(
      ui.run.groups
        .filter((group) => compatibleInputAssets(group, options).length)
        .map((group) => group.imageId)
    );
    paintRun();
    return;
  }
  if (target.dataset.pfSelectNone !== undefined) {
    ui.run.selected.clear();
    paintRun();
    return;
  }
  if (target.dataset.pfRunStart !== undefined) {
    await startRun();
  }
}

async function startRun() {
  const run = ui.run;
  if (!run || ui.runBusy) return;
  const preset = presetById(run.presetId);
  if (!preset) {
    run.error = processing.presets.length ? "先选择一个流程预设。" : "还没有预设，请先到预设管理创建。";
    paintRun();
    return;
  }
  const options = presetOptions(preset);
  const error = runValidation({
    presetId: run.presetId,
    groups: run.groups,
    selectedImageIds: run.selected,
    options,
    consentToUpload: run.consentUpload,
    consentToCharge: run.consentCharge,
  });
  if (error) {
    run.error = error;
    paintRun();
    return;
  }
  const { inputs } = batchInputs(run.groups, options, run.selected, run.preferredInputs);
  ui.runBusy = true;
  run.error = "";
  paintRun();
  try {
    const batch = await createBatch({
      presetId: run.presetId,
      inputs,
      consentToUpload: run.consentUpload,
      consentToCharge: run.consentCharge,
    });
    closeRunDialog();
    await openProcessingWindow({ batchId: batch.batch_id });
    appApi?.toast(`批次已提交：${inputs.length} 张原图。进度保存在本机服务，可收起浮窗后继续。`, "done");
  } catch (error) {
    run.error = error?.message || "批次提交失败。";
  } finally {
    ui.runBusy = false;
    if (ui.run) paintRun();
  }
}

/* ------------------------------------------------------------------ 全局键盘 */

function onGlobalKey(event) {
  if (event.key !== "Escape") return;
  if (ui.zoomAsset) {
    ui.zoomAsset = "";
    paintWindow();
    return;
  }
  if (presetEl && !presetEl.hidden) {
    closePresetManager();
    return;
  }
  if (runEl && !runEl.hidden) {
    closeRunDialog();
    return;
  }
  if (ui.windowOpen) closeProcessingWindow();
}

/* 供测试读取面板状态；不暴露可变结构。 */
export function processingUiSnapshot() {
  return {
    windowOpen: ui.windowOpen,
    collapsed: ui.collapsed,
    runOpen: Boolean(runEl && !runEl.hidden),
    presetOpen: Boolean(presetEl && !presetEl.hidden),
    batches: processing.batches.length,
  };
}

/* =============================================================================
   views/workbench.js — 工作台：三栏（文档/工序/资产 · 纸本图版 · 本工序参数）
   数据全部来自本机 /api/v1：
   - 会话（图片、资产、任务）在 store.js，头像用 http.assetPreviewUrl，下载用
     http.assetDownloadUrl；本视图只读 store，不自己持有服务端数据副本。
   - 七道工序：01 来源、02 裁切、03 颜色/线稿、04 云端候选、05 蒙版、06 云端修复、
     07 平铺与导出。任务统一经 store.runJob 提交并轮询，期间维护 busy 与产物资产。
   - 未提交的界面参数（选区、阈值、笔迹、同意项、导出勾选等）放在模块内 draft，
     api.patch / api.refresh 重绘后仍在；高频输入用局部 DOM 更新。
   - 云端未配置时（store.seedream.enabled === false）04/06 只显示禁用原因与去设置入口。
   本文件只写这两个视图文件，不改 app.js / api.js / store.js / format.js / 后端。
   ============================================================================= */

import { STAGES } from "../data.js";
import { icon } from "../icons.js";
import { store } from "../store.js";
import { api as http } from "../api.js";
import {
  blockerLabel,
  dimsOf,
  escapeHtml,
  formatBytes,
  formatTime,
  gradeLabel,
  jobKindLabel,
  jobStateLabel,
  kindLabel,
  licenseLabel,
  progressOf,
  shortId,
  sourceLabel,
} from "../format.js";

/* ------------------------------------------------------------------ 常量 */

/** 100% 时纸本图版的名义边长（px）；缩放以它为基准 */
const UNIT = 560;
/** 画布井内边距（与 CSS 一致：.wb-canvas__sizer 的 padding 28 × 2） */
const CANVAS_PAD = 56;
const MIN_SCALE = 0.2;
const MAX_SCALE = 3;
const CROP_MIN_PX = 4;
const MASK_MAX_POINTS = 2048;

/** 平铺单元允许的资产类型（与后端 TILE_UNIT_KINDS 一致） */
const TILE_UNIT_KINDS = new Set(["cropped", "transparent_png", "lineart", "accepted_repair"]);
/** 本机 RGB/RGBA 输入资产类型（裁切/提取/线稿/矢量化的合法输入） */
const RGB_KINDS = new Set([
  "normalized_input",
  "cropped",
  "working_copy",
  "prepared",
  "enhanced",
  "transparent_png",
  "lineart",
  "edit_candidate",
  "composed_candidate",
  "accepted_repair",
]);
/** 有预览图的资产类型；ZIP 只给下载链接 */
const NO_PREVIEW_KINDS = new Set(["zip", "export", "archive"]);

const STAGE_COPY = {
  source: { title: "放入纹样", note: "原件与规范输入各留一份", desc: "原件只读；规范输入另外保存。尺寸、等级、来源与哈希都来自本机服务。" },
  crop: { title: "框定纹样", note: "坐标使用当前资产真实像素", desc: "在纸面上拖框，或直接填写像素坐标。right / bottom 是开区间终点。" },
  process: { title: "提取与矢量化", note: "模型一键、颜色提取或线稿分步", desc: "模型一键直接出线稿 PNG 与黑白 SVG；也可颜色提取，或先出线稿 PNG 再单独矢量化。" },
  candidate: { title: "选候选层", note: "按提示词拆分", desc: "云端按层拆分后，在本地合成候选。每次调用都要显式同意上传与计费。" },
  mask: { title: "修正前景", note: "只改透明 PNG", desc: "在源图上补前景或擦除杂点，提交后生成新的透明 PNG，旧结果保留。" },
  repair: { title: "局部修复", note: "只改选定区域", desc: "框出问题区域，云端返回修复候选，再由你决定接受或拒绝。" },
  tile: { title: "检查接缝", note: "2×2 / 3×3", desc: "从会话资产选一个单元做整数重复；接缝观察写入资产元数据。导出可勾选多个资产。" },
};

const EXTRACT_MODES = [
  ["otsu", "Otsu 全局阈值"],
  ["manual", "手动阈值"],
  ["adaptive_mean", "自适应均值"],
  ["adaptive_gaussian", "自适应高斯"],
  ["sauvola", "Sauvola 局部"],
  ["grabcut", "GrabCut（需框选）"],
];
const POLARITIES = [
  ["dark", "深色前景"],
  ["light", "浅色前景"],
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
const COLOR_OPTIONS = [
  [2, "2 色"],
  [4, "4 色"],
  [8, "8 色"],
  [16, "16 色"],
];
const SEAM_LABELS = { not_reviewed: "未检查", visible: "明显", not_obvious: "不明显" };
const SEAM_OPTIONS = [
  ["not_reviewed", "未检查"],
  ["visible", "明显"],
  ["not_obvious", "不明显"],
];
const REPAIR_INTENTS = [
  ["restore_small_gap", "补小缺口"],
  ["reconnect_lines", "接断线"],
];
const SIZE_OPTIONS = [
  ["1K", "1K"],
  ["1.5K", "1.5K"],
  ["2K", "2K"],
  ["auto", "自动"],
];
const AI_SIZE_OPTIONS = [
  ["1K", "1K"],
  ["1.5K", "1.5K"],
  ["2K", "2K"],
  ["auto", "自动"],
];

const STEP_STATE = {
  queued: "排队",
  running: "处理中",
  succeeded: "完成",
  failed: "失败",
  cancelled: "已取消",
  pending: "等待",
  skipped: "跳过",
  blocked: "阻塞",
  waiting_user: "等待选择",
};

const JOB_STEP_LABELS = {
  crop: "裁切",
  "working-copy": "工作副本",
  "working_copy": "工作副本",
  extract: "前景提取",
  enhance: "轻增强",
  prepare: "图像准备",
  lineart: "线稿",
  vectorize: "矢量化",
  export: "导出",
  "tile-preview": "平铺预览",
  tile_preview: "平铺预览",
  "refine-mask": "蒙版修正",
  refine_mask: "蒙版修正",
  "repair-candidate": "修复候选",
  "protect-region": "区域保护",
  "decompose-layers": "云端拆分",
  "compose-layers": "候选合成",
  "select_layers": "选择图层",
};

/** 任务失败 / 接口报错时优先展示的中文说明（后端原始 message 放在 title 里） */
const ERROR_TEXT = {
  WORKER_MEMORY_LIMIT: "本机处理达到内存上限：请换更小的图，或在 03 降低矢量化细节。",
  WORKER_TIMEOUT: "本机处理超时，请换更小的图或稍后重试。",
  WORKER_BUSY: "本机处理队列正在忙，请等当前任务结束后再试。",
  EMPTY_MASK: "当前图没有可用的前景，请调整提取参数或先补前景。",
  WORKING_COPY_REQUIRED: "图像超过本机处理上限，请先创建工作副本或换更小的图。",
  BBOX_OUT_OF_BOUNDS: "选区超出了当前资产的像素范围。",
  RGB_INPUT_REQUIRED: "当前资产不能作为这一步的输入，请先选一张原图、规范输入或裁切图。",
  PIXEL_LIMIT: "图片像素超过上限，请先创建工作副本或换更小的图。",
  UPLOAD_TOO_LARGE: "图片超过 20 MB，请先压缩或裁切。",
  UNSUPPORTED_FORMAT: "不支持这种图片格式，请使用 PNG 或 JPEG。",
  PREVIEW_NOT_AVAILABLE: "这个资产没有预览图，请下载文件查看。",
  GRABCUT_NEEDS_BACKGROUND: "GrabCut 需要把背景留在框外：请先在 02 缩小选区。",
  INVALID_FOREGROUND_MASK: "蒙版不是二值，或与源图尺寸/坐标不一致。",
  MASK_SOURCE_MISMATCH: "蒙版的尺寸、坐标空间或源图记录不一致。",
  FOREGROUND_MASK_REQUIRED: "这一步需要透明 PNG 和它的前景蒙版记录。",
  BRUSH_OUT_OF_BOUNDS: "画笔点位超出了源图范围，请重画。",
  TILE_UNIT_REQUIRED: "请选择裁切、透明 PNG、线稿 PNG 或已接受的修复图作为平铺单元。",
  TILE_PIXEL_LIMIT: "平铺结果超过 4 MP，请换更小的单元。",
  LICENSE_REVIEW_REQUIRED: "所选资产里有未登记的许可证，请先勾选「许可证已确认」再导出。",
  NESTED_EXPORT: "不能把已有的 ZIP 再打包一次，请只选图片或 SVG。",
  EXPORT_SIZE_LIMIT: "所选文件超过 128 MiB 导出上限，请少选几个。",
  STALE_SEAM_OBSERVATION: "接缝记录已被更新，已重新读取资产，请再保存一次。",
  SEAM_OBSERVATION_CONFLICT: "接缝记录已被更新，请重新读取资产后再保存。",
  TILE_PREVIEW_REQUIRED: "只有平铺预览资产能记录接缝观察。",
  TILE_PREVIEW_NOT_READY: "平铺结果还没生成完成，请稍后重试。",
  STALE_REVISION: "这份记录已被更新，请重新读取后再操作。",
  FULL_IMAGE_CONSENT_REQUIRED: "接受全图候选前，需要显式确认它可能改变整个画面。",
  INVALID_REPAIR_SELECTION: "请选择这次修复自己的候选或本地合成。",
  REPAIR_SIZE_LIMIT: "修复最多支持 1024 × 1024 像素，请先准备更小的输入。",
  PROVIDER_DISABLED: "云端尚未就绪，请先在设置里配置密钥、付费开关与预算。",
  PROVIDER_INPUT_KIND: "云端这一步需要规范输入（normalized_input）。",
  PROVIDER_INPUT_DIMENSIONS: "输入的像素或长宽比不在云端允许范围内。",
  LAYERS_NOT_READY: "云端拆分还没有成功完成，暂时不能选层。",
  QUEUE_FULL: "任务队列已满，请稍后再试。",
  RETRY_NOT_ALLOWED: "只有失败的本机任务才能重试。",
  PAID_RETRY_REQUIRES_NEW_CONSENT: "付费调用不会自动重试，需要重新确认。",
  LINEART_MODEL_UNAVAILABLE: "模型线稿不可用：模型权重/配置缺失、校验未通过，或运行依赖不可用（torch、segmentation_models_pytorch）；可改用 OpenCV 路线，或按 README 检查模型环境。",
  LOCAL_REQUEST_HEADER_REQUIRED: "请求缺少本机写标记，请刷新页面后重试。",
  NOT_FOUND: "没有找到对应的资产或任务。",
  INVALID_REQUEST: "参数没有通过接口校验，请检查填写内容。",
  INTERNAL_ERROR: "本机服务内部出错，没有自动重试。",
};

/* ------------------------------------------------------------------ 模块状态 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const esc = (value) => escapeHtml(value);
const mono = (value) => `<span class="mono">${esc(value)}</span>`;

function defaultDraft() {
  return {
    crop: null,
    cropPreset: "original",
    /* 默认本地一键路线：POST /pipelines + recipe:"model_lineart" */
    processRoute: "model",
    extractMode: "otsu",
    polarity: "dark",
    threshold: 127,
    colors: 4,
    detail: "medium",
    vectorMode: "color",
    lineMethod: "opencv",
    lineColors: 2,
    lineDetail: "medium",
    lineVectorMode: "monochrome",
    candSize: "1K",
    candColors: 4,
    candDetail: "low",
    consentUpload: false,
    consentCharge: false,
    maskMode: "add",
    repair: null,
    repairIntent: "restore_small_gap",
    repairFeather: 0,
    repairSize: "1K",
    repairConsentUpload: false,
    repairConsentCharge: false,
    acceptFull: false,
    tileUnitId: "",
    tileUnitTouched: false,
    seamGrid: false,
    exportIds: [],
    exportInit: false,
    licenseAck: false,
  };
}

let draft = defaultDraft();

const ui = {
  running: false,
  job: null,
  jobId: "",
  jobStage: 0,
  error: "",
  errorDetail: "",
  notice: "",
  sessionError: "",
  lastExport: null,
  compareX: 55,
};

const cand = { jobId: "", layers: [], selected: [], loading: false, error: "" };
const repairState = { info: null, loading: false, error: "" };
const maskState = { strokes: [], drawing: null };

let viewState = null;
let expectedImage = "";
let lastCurrentId = "";
let lastImageId = "";
let lastSessionToken = null;
let lastHealthCapability = "";
let panelPref = null;
let sessionTimer = null;
let resizeHandler = null;
let canvasObserver = null;
let unsubscribe = null;
let scrollMemo = null;
let focusMemo = null;

/* ------------------------------------------------------------------ 小工具 */

const currentStage = (state) => STAGES[clamp(Number(state.stage) || 1, 1, STAGES.length) - 1];
const stageCopy = (stage) => STAGE_COPY[stage.key] || STAGE_COPY.source;
const currentAsset = () => store.currentAsset();
const sessionImage = () => store.session.image;
const imageMeta = () => sessionImage()?.meta || {};
const brushRadius = () => clamp(Math.round(Number(viewState?.brush) || 24), 1, 128);

const assetPreview = (asset) =>
  asset && asset.asset_id && !NO_PREVIEW_KINDS.has(asset.kind) ? http.assetPreviewUrl(asset.asset_id) : "";

const isImageLike = (asset) => Boolean(asset && RGB_KINDS.has(asset.kind));

const stepStateLabel = (state) => STEP_STATE[state] || jobStateLabel(state);
const stepLabel = (name) => JOB_STEP_LABELS[name] || name;

function lastJob(kinds = []) {
  const jobs = store.session.jobs || [];
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    const job = jobs[i];
    if (!kinds.length || kinds.includes(job.kind)) return job;
  }
  return null;
}

function jobErrorText(job) {
  const code = job?.error?.code || "";
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  const message = String(job?.error?.message || "").trim();
  return message ? `任务没有完成：${message}` : "任务没有完成，后端没有给出错误说明。";
}

function errorText(error) {
  const code = error?.code || "";
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  const message = String(error?.message || "").trim();
  return message || "请求没有完成，请稍后重试。";
}

/* ------------------------------------------------------------ 模型线稿能力 */

/** health.capabilities.lineart_model.reason 的中文说明（只描述前置检查）。 */
const LINEART_REASON_TEXT = {
  dependencies_missing: "本机缺少模型运行依赖（torch / segmentation_models_pytorch）。OpenCV 路线仍可用。",
  model_files_missing: "模型权重或配置文件尚未安装（model/model.pt、model/inference.json）。OpenCV 路线仍可用。",
  model_config_invalid: "模型配置与推理规格不一致，请检查 model/inference.json。OpenCV 路线仍可用。",
  model_check_failed: "模型前置检查执行失败，暂时无法判断模型是否可用；仍可尝试，或先用 OpenCV。",
};

/** 只读 health 能力；available 为 null 表示未知，绝不能当成“不可用”。 */
function lineartCapability() {
  const raw = store.lineartModel || {};
  return {
    available: raw.available === true ? true : raw.available === false ? false : null,
    reason: String(raw.reason || ""),
    checked: String(raw.checked || ""),
  };
}

/** 能力文案：只在后端明确 available=false 时才给出缺依赖/缺文件等判断。 */
function lineartCapabilityText() {
  const cap = lineartCapability();
  if (cap.available === true) {
    return "前置检查通过：模型文件与依赖已就绪。只检查前置条件，不保证 GPU 或推理一定成功；失败按任务错误展示。";
  }
  if (cap.available === false) {
    return LINEART_REASON_TEXT[cap.reason] || "模型前置检查未通过。OpenCV 路线仍可用。";
  }
  return "模型能力未知：后端没有返回该能力，或健康检查暂时读取失败。仍可尝试；失败按任务错误展示。";
}

function healthCapabilitySignature() {
  const model = store.lineartModel || {};
  return JSON.stringify([model.available ?? null, model.reason || "", model.checked || ""]);
}

function currentDims(asset = currentAsset()) {
  if (!asset || !asset.width || !asset.height) return null;
  return { width: Number(asset.width), height: Number(asset.height) };
}

function mediaStyle(asset) {
  const width = Math.max(1, Number(asset?.width) || 1);
  const height = Math.max(1, Number(asset?.height) || 1);
  const scale = Math.min(UNIT / width, UNIT / height);
  const left = (UNIT - width * scale) / 2;
  const top = (UNIT - height * scale) / 2;
  return `left:${((left / UNIT) * 100).toFixed(3)}%;top:${((top / UNIT) * 100).toFixed(3)}%;width:${(
    (width * scale) / UNIT * 100
  ).toFixed(3)}%;height:${((height * scale) / UNIT * 100).toFixed(3)}%`;
}

function zoomMode(state) {
  if (state.zoom === "fit") return "fit";
  return Number(state.zoom) === 2 ? "2" : "1";
}

const zoomLabel = (mode) => (mode === "fit" ? "适应" : mode === "2" ? "200%" : "100%");

const tileN = (state) => (state.tile === "3x3" ? 3 : 2);
const tileSpec = (state) => (state.tile === "3x3" ? "3 × 3" : "2 × 2");

const stageNo = (stage) => Number(stage.n) || 1;

/* ------------------------------------------------------------------ 文档信息 */

function docName() {
  const meta = imageMeta();
  const image = sessionImage();
  const named =
    String(meta.source_name || "").trim() ||
    String(image?.original?.source_name || "").trim() ||
    String(currentAsset()?.source_name || "").trim();
  if (named) return named;
  if (image) return "未命名纹样";
  return currentAsset() ? `${kindLabel(currentAsset().kind)}资产` : "未打开纹样";
}

function sourceText() {
  const meta = imageMeta();
  const parts = [];
  if (meta.source_type && meta.source_type !== "未确认") parts.push(meta.source_type);
  if (meta.source_url) parts.push(meta.source_url);
  if (meta.source_note) parts.push(meta.source_note);
  return parts.length ? parts.join(" · ") : sourceLabel(meta);
}

function gradeOf() {
  return imageMeta().grade || sessionImage()?.original?.grade || currentAsset()?.grade || "";
}

function createdText() {
  return formatTime(imageMeta().created_at || sessionImage()?.created_at || currentAsset()?.created_at, { withDate: true });
}

function stageStatuses() {
  const assets = store.session.assets || [];
  const jobs = store.session.jobs || [];
  const kindSet = new Set(assets.map((asset) => asset.kind));
  const jobSet = new Set(jobs.filter((job) => job.state === "succeeded").map((job) => job.kind));
  const hasKind = (...kinds) => kinds.some((kind) => kindSet.has(kind));
  const hasJob = (...kinds) => kinds.some((kind) => jobSet.has(kind));
  const refined = assets.some(
    (asset) =>
      asset.kind === "transparent_png" &&
      (asset.annotation_source === "human_foreground_correction" ||
        asset.parameters?.annotation_source === "human_foreground_correction")
  );
  return {
    source: Boolean(sessionImage()),
    crop: hasKind("cropped") || hasJob("crop"),
    process: hasKind("transparent_png", "lineart", "contour_line_art", "svg", "foreground_mask") || hasJob("pipeline", "lineart"),
    candidate: hasKind("composed_candidate", "generated_layer", "placed_generated_layer", "ai_layer") || hasJob("decompose-layers"),
    mask: refined || hasJob("refine-mask"),
    repair: hasKind("repair_composite", "accepted_repair", "edit_candidate") || hasJob("repair"),
    tile: hasKind("tile_preview") || hasJob("tile-preview", "export"),
  };
}

function tileUnitAssets() {
  return (store.session.assets || []).filter((asset) => TILE_UNIT_KINDS.has(asset.kind));
}

function tileUnit() {
  const list = tileUnitAssets();
  const selected = list.find((asset) => asset.asset_id === draft.tileUnitId);
  if (selected) return selected;
  return list[list.length - 1] || null;
}

function tilePreviewFor(unitId, n) {
  const assets = store.session.assets || [];
  for (let i = assets.length - 1; i >= 0; i -= 1) {
    const asset = assets[i];
    if (asset.kind !== "tile_preview") continue;
    const sameUnit = (asset.unit_asset_id || asset.parameters?.unit_asset_id) === unitId;
    const rows = asset.rows || asset.parameters?.rows;
    const cols = asset.cols || asset.parameters?.cols;
    if (sameUnit && Number(rows) === n && Number(cols) === n) return asset;
  }
  return null;
}

function tilePreviewLatest() {
  const assets = store.session.assets || [];
  for (let i = assets.length - 1; i >= 0; i -= 1) if (assets[i].kind === "tile_preview") return assets[i];
  return null;
}

function exportableAssets() {
  return (store.session.assets || []).filter((asset) => !NO_PREVIEW_KINDS.has(asset.kind));
}

function defaultExportIds() {
  const list = exportableAssets();
  const ids = [];
  const current = currentAsset();
  if (current && !NO_PREVIEW_KINDS.has(current.kind)) ids.push(current.asset_id);
  const wanted = ["transparent_png", "svg", "cropped", "accepted_repair", "lineart"];
  for (const kind of wanted) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].kind === kind && !ids.includes(list[i].asset_id)) {
        ids.push(list[i].asset_id);
        break;
      }
    }
    if (ids.length >= 4) break;
  }
  return ids.slice(0, 24);
}

function exportSelection() {
  const valid = new Set(exportableAssets().map((asset) => asset.asset_id));
  if (!draft.exportInit) {
    draft.exportIds = defaultExportIds();
    draft.exportInit = true;
  }
  return draft.exportIds.filter((id) => valid.has(id));
}

function compareInfo(stage) {
  if (stage?.key === "tile") return { ok: false, reason: "平铺视图不支持对比，先切回其它工序。" };
  const current = currentAsset();
  if (!current) return { ok: false, reason: "还没有打开资产。" };
  if (current.kind === "original" || current.kind === "normalized_input") {
    return { ok: false, reason: "当前就是原件或规范输入，没有可对比的另一个版本。" };
  }
  if (!assetPreview(current)) return { ok: false, reason: "当前资产没有可预览的图片（ZIP 包请下载）。" };
  const original = (store.session.assets || []).find(
    (asset) => asset.kind === "original" || asset.kind === "normalized_input"
  );
  if (!original) return { ok: false, reason: "这张纹样没有留下原件记录，无法对比。" };
  return { ok: true, current, original };
}

/* ------------------------------------------------------------------ 草稿同步 */

function resetMaskStrokes() {
  maskState.strokes = [];
  maskState.drawing = null;
}

function syncDrafts(state) {
  const sessionToken = store.sessionToken();
  if (lastSessionToken !== null && sessionToken !== lastSessionToken) {
    // 会话身份已切换：上一个会话遗留的任务、候选与修复状态不能带到新会话；
    // 但用户已选的路线、线稿方法等界面参数保留（只在 imageId 变化时清与图相关的草稿）。
    ui.running = false;
    ui.job = null;
    ui.jobId = "";
    ui.jobStage = 0;
    ui.error = "";
    ui.errorDetail = "";
    ui.notice = "";
    ui.sessionError = "";
    cand.jobId = "";
    cand.layers = [];
    cand.selected = [];
    cand.loading = false;
    cand.error = "";
    repairState.info = null;
    repairState.loading = false;
    repairState.error = "";
    resetMaskStrokes();
    if (sessionTimer) {
      window.clearTimeout(sessionTimer);
      sessionTimer = null;
    }
  }
  lastSessionToken = sessionToken;
  const asset = currentAsset();
  const id = asset?.asset_id || "";
  const imageId = store.session.imageId || "";
  if (imageId !== lastImageId) {
    lastImageId = imageId;
    draft.exportIds = [];
    draft.exportInit = false;
    draft.licenseAck = false;
    draft.tileUnitId = "";
    draft.tileUnitTouched = false;
    draft.seam = "not_reviewed";
    cand.jobId = "";
    cand.layers = [];
    cand.selected = [];
    cand.error = "";
    repairState.info = null;
    repairState.error = "";
    ui.lastExport = null;
  }
  if (expectedImage && imageId === expectedImage) ui.sessionError = "";
  if (id !== lastCurrentId) {
    lastCurrentId = id;
    if (asset) {
      draft.crop = { left: 0, top: 0, width: Math.max(1, asset.width || 1), height: Math.max(1, asset.height || 1) };
      draft.cropPreset = "original";
      draft.repair = { left: 0, top: 0, width: Math.max(1, asset.width || 1), height: Math.max(1, asset.height || 1) };
    } else {
      draft.crop = null;
      draft.repair = null;
    }
    resetMaskStrokes();
    ui.error = "";
    ui.errorDetail = "";
    cand.selected = [];
  }
  const units = tileUnitAssets();
  if (!units.length) {
    draft.tileUnitId = "";
  } else {
    const exists = units.some((asset) => asset.asset_id === draft.tileUnitId);
    const newest = units[units.length - 1].asset_id;
    if (!exists || (!draft.tileUnitTouched && newest !== draft.tileUnitId)) draft.tileUnitId = newest;
  }
}

/* ------------------------------------------------------------------ 组件片段 */

const sec = (title, extra, body) => `
  <section class="wb-sec">
    <header class="wb-sec__head">
      <span class="label">${esc(title)}</span>
      ${extra ? `<span class="mono wb-sec__extra">${extra}</span>` : ""}
    </header>
    ${body}
  </section>`;

const numField = (key, label, value, min, max) => {
  const id = `wb-${key}`;
  return `
  <label class="field wb-num" for="${id}">
    <span class="field__label"><span>${esc(label)}</span><span class="mono">px</span></span>
    <input class="input" id="${id}" type="number" inputmode="numeric" min="${min}" max="${max}" step="1"
      value="${Math.round(Number(value) || 0)}" data-field="${key}" />
  </label>`;
};

const rangeField = (key, label, min, max, step, value, hint = "") => {
  const id = `wb-${key}`;
  const numeric = Number(value);
  return `
  <div class="field">
    <label class="field__label" for="${id}">
      <span>${esc(label)}</span>
      <output class="mono" for="${id}" data-out="${key}">${Math.round(numeric)}</output>
    </label>
    <input class="range" id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${numeric}"
      data-range="${key}" style="--range-fill:${(((numeric - min) / (max - min)) * 100).toFixed(1)}%" />
    ${hint ? `<p class="field__hint">${hint}</p>` : ""}
  </div>`;
};

const segField = (key, label, options, current) => `
  <div class="seg wb-seg" role="group" aria-label="${esc(label)}">
    ${options
      .map(
        ([value, text]) =>
          `<button class="seg__btn" type="button" data-seg="${key}" data-val="${value}" aria-pressed="${
            String(current) === String(value)
          }">${esc(text)}</button>`
      )
      .join("")}
  </div>`;

const selectField = (key, label, options, current, extra = "") => {
  const id = `wb-${key}`;
  return `
  <label class="field" for="${id}">
    <span class="field__label"><span>${esc(label)}</span>${extra}</span>
    <select class="select" id="${id}" data-select="${key}" aria-label="${esc(label)}">
      ${options
        .map(
          ([value, text]) =>
            `<option value="${value}"${String(current) === String(value) ? " selected" : ""}>${esc(text)}</option>`
        )
        .join("")}
    </select>
  </label>`;
};

const switchRow = (key, label, checked) => `
  <div class="wb-switch">
    <button class="switch" type="button" role="switch" aria-checked="${Boolean(checked)}" aria-label="${esc(label)}"
      data-switch="${key}"></button>
    <span class="wb-switch__label">${esc(label)}</span>
  </div>`;

const checkRow = (key, label, checked, hint = "") => `
  <label class="wb-check">
    <input class="wb-check__input" type="checkbox" data-check="${key}" ${checked ? "checked" : ""}
      aria-label="${esc(label)}" />
    <span class="wb-check__box" aria-hidden="true">${icon("check")}</span>
    <span class="wb-check__text"><span>${esc(label)}</span>${hint ? `<span class="field__hint">${esc(hint)}</span>` : ""}</span>
  </label>`;

const noteBox = (text, kind = "info") => `
  <div class="wb-note${kind === "error" ? " wb-error" : ""}" role="${kind === "error" ? "alert" : "note"}">
    ${icon(kind === "error" ? "alert" : "info")}<span>${text}</span>
  </div>`;

function errorBox() {
  if (!ui.error) return "";
  return noteBox(esc(ui.error), "error");
}

function noticeBox() {
  if (!ui.notice) return "";
  return noteBox(esc(ui.notice));
}

function stepItems(steps) {
  return (steps || [])
    .map(
      (step) =>
        `<li class="wb-run__step" data-state="${esc(step.state || "")}"><span>${esc(
          stepLabel(step.name)
        )}</span><span class="mono">${esc(stepStateLabel(step.state))}</span></li>`
    )
    .join("");
}

function jobBox(stage) {
  const job = ui.job;
  if (!job || ui.jobStage !== stageNo(stage)) return "";
  const steps = job.result?.steps || [];
  const percent = progressOf(job);
  return `
  <div class="wb-run" data-run>
    <div class="wb-run__head">
      <span>${esc(jobKindLabel(job.kind))} · <span data-run-state>${esc(jobStateLabel(job.state))}</span></span>
      <span class="mono" data-run-percent>${percent}%</span>
    </div>
    <div class="wb-meter" aria-hidden="true"><span data-run-bar style="width:${Math.max(2, percent)}%"></span></div>
    ${steps.length ? `<ol class="wb-run__steps" data-run-steps>${stepItems(steps)}</ol>` : ""}
    ${ui.running ? `<p class="field__hint">任务已提交，等待本机处理；可在下方取消。</p>` : ""}
  </div>`;
}

function assetRow(asset, { currentId = "", action = "use-asset", meta = "" } = {}) {
  const active = asset.asset_id === currentId;
  const url = assetPreview(asset);
  return `
  <li>
    <button class="wb-asset-choice" type="button" data-act="${action}" data-id="${asset.asset_id}"
      aria-pressed="${active}" title="${esc(asset.asset_id)} · ${esc(dimsOf(asset))}">
      <span class="wb-asset-choice__thumb">${
        url ? `<img src="${url}" alt="" loading="lazy" decoding="async" />` : icon("file")
      }</span>
      <span class="wb-asset-choice__body">
        <span class="wb-asset-choice__name">${esc(kindLabel(asset.kind))}</span>
        <span class="wb-asset-choice__meta">${esc(dimsOf(asset))} · ${esc(shortId(asset.asset_id))}${
          meta ? ` · ${esc(meta)}` : ""
        }</span>
      </span>
      ${active ? `<span class="chip chip--accent">当前</span>` : `<span class="wb-asset-choice__tag mono">${esc(formatTime(asset.created_at))}</span>`}
    </button>
  </li>`;
}

function assetChoices(assets, opts = {}) {
  if (!assets.length) return "";
  return `<ul class="wb-asset-list">${assets.map((asset) => assetRow(asset, opts)).join("")}</ul>`;
}

function cloudDisabled(api) {
  const seedream = store.seedream;
  if (!seedream) {
    if (store.settingsError) return noteBox(esc(`读取云端设置失败：${store.settingsError}`), "error");
    return `<div class="wb-disabled"><p class="field__hint">正在读取云端配置…</p></div>`;
  }
  const blockers = Array.isArray(seedream.blockers) ? seedream.blockers : store.settings?.blockers || [];
  return `
  <div class="wb-disabled">
    <div class="wb-disabled__head"><span class="chip chip--gold">${icon("cloud")}云端未启用</span></div>
    <p class="wb-disabled__text">这一步需要云端模型。当前设置还缺少：</p>
    <ul class="wb-disabled__list">
      ${(blockers.length ? blockers : ["SETTINGS_NOT_READY"]).map((code) => `<li>${esc(blockerLabel(code))} <span class="mono">${esc(code)}</span></li>`).join("")}
    </ul>
    <button class="btn btn--ghost btn--sm btn--block" type="button" data-act="settings">${icon("gear")}去设置</button>
    <p class="field__hint">本机处理（裁切、提取、线稿、蒙版、平铺、导出）不需要云端，仍可正常使用。</p>
  </div>`;
}

function loadingBox() {
  return `<div class="wb-loading" role="status"><span class="wb-loading__dot" aria-hidden="true"></span><span>正在读取本机纹样…</span></div>`;
}

function noAssetPanel() {
  return `
  ${sec(
    "开始",
    "",
    `<div class="wb-note">${icon("info")}<span>先打开一张纹样，再进入这一步。</span></div>
     <button class="wb-drop" type="button" data-act="upload">
       ${icon("upload")}
       <span class="wb-drop__title">上传原件</span>
       <span class="mono wb-drop__hint">PNG / JPEG · 单张 ≤ 20 MB</span>
     </button>
     <button class="btn btn--ghost btn--sm btn--block" type="button" data-act="library">${icon("gallery")}去纹样库挑一件</button>`
  )}`;
}

/* ------------------------------------------------------------------ 左栏 */

function railHtml(state) {
  const image = sessionImage();
  const meta = imageMeta();
  const asset = currentAsset();
  const statuses = stageStatuses();
  const doneCount = STAGES.filter((stage) => statuses[stage.key]).length;
  const assets = store.session.assets || [];
  const grade = gradeOf();
  const stampClass = grade && "ABCU".includes(grade) ? `stamp--${grade.toLowerCase()}` : "stamp--u";

  return `
  <aside class="wb-rail" aria-label="文档、工序与资产">
    <div class="wb-doc">
      <div class="wb-doc__top">
        <span class="label">文档</span>
        ${grade ? `<span class="stamp ${stampClass}" title="评级">${esc(grade)}</span>` : ""}
      </div>
      <h1 class="wb-doc__name">${esc(docName())}</h1>
      <p class="mono wb-doc__id">${
        image ? `#${esc(shortId(image.image_id))}` : asset ? `#${esc(shortId(asset.asset_id))}` : "—"
      }</p>
      <dl class="wb-doc__meta">
        ${
          image
            ? `<div><dt>尺寸</dt><dd class="mono">${esc(dimsOf(image.original))}</dd></div>
               <div><dt>等级</dt><dd>${esc(gradeLabel(gradeOf()))}</dd></div>
               <div><dt>来源</dt><dd>${esc(sourceText())}</dd></div>
               <div><dt>许可证</dt><dd>${esc(licenseLabel(meta.license || image.original?.license))}</dd></div>
               <div><dt>创建</dt><dd class="mono">${esc(createdText())}</dd></div>`
            : asset
            ? `<div><dt>资产</dt><dd>${esc(kindLabel(asset.kind))}</dd></div>
               <div><dt>尺寸</dt><dd class="mono">${esc(dimsOf(asset))}</dd></div>
               <div><dt>创建</dt><dd class="mono">${esc(formatTime(asset.created_at, { withDate: true }))}</dd></div>`
            : `<div><dt>状态</dt><dd>尚未打开纹样</dd></div>
               <div><dt>方式</dt><dd>上传或从纹样库打开</dd></div>`
        }
      </dl>
    </div>

    <section class="wb-rail__sec">
      <header class="wb-rail__head">
        <span class="label">工序</span>
        <span class="mono">${STAGES.length} 步 · ${doneCount} 步有产物</span>
      </header>
      <ol class="wb-steps">
        ${STAGES.map((stage, index) => {
          const n = index + 1;
          const current = n === Number(state.stage);
          const mode = current ? "current" : statuses[stage.key] ? "done" : "todo";
          const stateText = current ? "当前工序" : statuses[stage.key] ? "已有产物" : "未开始";
          return `<li>
            <button class="wb-step" type="button" data-act="stage" data-n="${n}" data-state="${mode}"
              aria-current="${current ? "step" : "false"}"
              title="${esc(`${stage.n} ${stage.name} · ${stateText}`)}"
              aria-label="${esc(`${stage.n} ${stage.name} · ${stateText}`)}">
              <span class="wb-step__n">${esc(stage.n)}</span>
              <span class="wb-step__name">${esc(stage.name)}</span>
              <span class="wb-step__dot" aria-hidden="true"></span>
            </button>
          </li>`;
        }).join("")}
      </ol>
    </section>

    <section class="wb-rail__sec wb-rail__sec--film">
      <header class="wb-rail__head">
        <span class="label">资产</span>
        <span class="mono">${assets.length} 项</span>
      </header>
      ${
        assets.length
          ? `<ul class="wb-film">
              ${[...assets]
                .reverse()
                .map((entry) => {
                  const on = entry.asset_id === store.session.currentAssetId;
                  const url = assetPreview(entry);
                  return `<li>
                    <button class="wb-ver" type="button" data-act="asset" data-id="${entry.asset_id}"
                      aria-current="${on ? "true" : "false"}"
                      title="${esc(`${kindLabel(entry.kind)} · ${dimsOf(entry)} · ${formatTime(entry.created_at, { withDate: true })} · ${entry.asset_id}`)}">
                      <span class="wb-ver__thumb">${
                        url ? `<img src="${url}" alt="" loading="lazy" decoding="async" />` : icon("file")
                      }</span>
                      <span class="wb-ver__text">
                        <span class="wb-ver__label">${esc(kindLabel(entry.kind))}</span>
                        <span class="wb-ver__meta mono">${esc(dimsOf(entry))} · ${esc(formatTime(entry.created_at))}</span>
                      </span>
                      <span class="wb-ver__id mono">${esc(shortId(entry.asset_id))}</span>
                    </button>
                  </li>`;
                })
                .join("")}
            </ul>`
          : `<div class="wb-assets-empty">
               <p>这个会话还没有资产。上传一张原图，或从纹样库挑一件。</p>
               <button class="btn btn--ghost btn--sm btn--block" type="button" data-act="upload">${icon("upload")}上传纹样</button>
               <button class="btn btn--quiet btn--sm btn--block" type="button" data-act="library">去纹样库挑一件</button>
             </div>`
      }
    </section>

    <div class="wb-rail__foot">
      <button class="btn btn--ghost btn--sm btn--block" type="button" data-act="go-export">
        ${icon("download")}平铺与导出
      </button>
    </div>
  </aside>`;
}

/* ------------------------------------------------------------------ 中栏画布 */

function mediaFrame(width, height, url, inner = "", extra = "") {
  return `
  <div class="wb-media ${extra}" data-media data-w="${width}" data-h="${height}" style="${mediaStyle({ width, height })}">
    ${url ? `<img class="wb-media__img" src="${url}" alt="" draggable="false" data-preview />` : ""}
    ${inner}
  </div>`;
}

function mediaBox(asset, inner = "", extra = "") {
  return mediaFrame(asset.width || 1, asset.height || 1, assetPreview(asset), inner, extra);
}

function cropOverlay(asset) {
  const crop = draft.crop;
  if (!crop) return "";
  const total = currentDims(asset);
  if (!total) return "";
  const left = (crop.left / total.width) * 100;
  const top = (crop.top / total.height) * 100;
  const width = (crop.width / total.width) * 100;
  const height = (crop.height / total.height) * 100;
  const guides = ["v1", "v2", "h1", "h2"].map((name) => `<span class="wb-crop__guide wb-crop__guide--${name}"></span>`);
  const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map(
    (name) => `<span class="wb-crop__h wb-crop__h--${name}"></span>`
  );
  return `
  <div class="wb-crop" data-crop>
    <div class="wb-crop__frame" data-crop-frame
      style="left:${left}%;top:${top}%;width:${width}%;height:${height}%">
      ${guides.join("")}
      ${handles.join("")}
      <span class="wb-crop__size mono" data-crop-size>${Math.round(crop.width)} × ${Math.round(crop.height)}</span>
    </div>
  </div>`;
}

function maskSvg(asset) {
  const width = Math.max(1, asset.width || 1);
  const height = Math.max(1, asset.height || 1);
  const marks = maskState.strokes
    .map((stroke) =>
      stroke.points
        .map(
          (point) =>
            `<circle class="wb-mask-dot${stroke.mode === "erase" ? " is-erase" : ""}" cx="${point.x}" cy="${point.y}" r="${stroke.radius}" />`
        )
        .join("")
    )
    .join("");
  return `<svg class="wb-mask-svg" data-mask-svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${marks}</svg>`;
}

function maskOverlay(asset) {
  const radius = brushRadius();
  const size = `${((radius * 2) / Math.max(1, asset.width)) * 100}%`;
  return `${maskSvg(asset)}<span class="wb-brush" data-brush style="width:${size};height:${size}" aria-hidden="true"></span>`;
}

function repairOverlay(asset) {
  const box = draft.repair;
  const total = currentDims(asset);
  if (!box || !total) return "";
  return `
  <div class="wb-repair" data-repair-overlay>
    <span class="wb-repair__region is-active"
      style="left:${(box.left / total.width) * 100}%;top:${(box.top / total.height) * 100}%;width:${
        (box.width / total.width) * 100
      }%;height:${(box.height / total.height) * 100}%">
      <span class="wb-repair__tag mono">修复框 ${Math.round(box.width)} × ${Math.round(box.height)}</span>
    </span>
  </div>`;
}

function compareHtml(info) {
  const pos = clamp(Number(ui.compareX) || 55, 4, 96);
  return `
  <div class="wb-compare" data-compare style="--wb-pos:${pos}%">
    <img class="wb-compare__img" src="${assetPreview(info.current)}" alt="当前资产 ${esc(kindLabel(info.current.kind))}" draggable="false" />
    <div class="wb-compare__orig">
      <img src="${assetPreview(info.original)}" alt="${esc(kindLabel(info.original.kind))}" draggable="false" />
    </div>
    <span class="wb-compare__tag wb-compare__tag--a">${esc(kindLabel(info.original.kind))}</span>
    <span class="wb-compare__tag wb-compare__tag--b">${esc(kindLabel(info.current.kind))}</span>
    <span class="wb-compare__divider" aria-hidden="true"></span>
    <button class="wb-compare__handle" type="button" role="slider" data-cmp-handle
      aria-label="对比分割线" aria-orientation="horizontal"
      aria-valuemin="4" aria-valuemax="96" aria-valuenow="${Math.round(pos)}" aria-valuetext="${Math.round(pos)}% 原件"
      title="左右拖动，或用方向键移动">${icon("chevronLeft")}${icon("chevron")}</button>
  </div>`;
}

function emptyPlate() {
  return `
  <div class="wb-plate plate wb-plate--empty" data-plate>
    <div class="wb-empty-state">
      <span class="wb-empty-state__icon">${icon("image")}</span>
      <h3>还没有打开纹样</h3>
      <p>上传一张 PNG 或 JPEG，或从纹样库挑一件已经处理过的资产。处理结果都保存本机。</p>
      <div class="wb-empty-state__actions">
        <button class="btn btn--primary btn--sm" type="button" data-act="upload">${icon("upload")}上传纹样</button>
        <button class="btn btn--ghost btn--sm" type="button" data-act="library">去纹样库</button>
      </div>
    </div>
  </div>`;
}

function loadingPlate() {
  return `<div class="wb-plate plate wb-plate--loading" data-plate><div class="wb-loading">${loadingBox()}</div></div>`;
}

function tilePlate(state, stage) {
  const asset = currentAsset();
  const n = tileN(state);
  const unit = tileUnit();
  const preview = unit ? tilePreviewFor(unit.asset_id, n) : null;
  if (preview) {
    return mediaFrame(
      preview.width || 1,
      preview.height || 1,
      assetPreview(preview),
      `<span class="wb-badge mono">平铺结果 ${n} × ${n}</span>`,
      "wb-media--tile"
    );
  }
  if (asset && asset.kind === "tile_preview" && (!unit || !tilePreviewFor(unit.asset_id, n))) {
    return mediaFrame(
      asset.width || 1,
      asset.height || 1,
      assetPreview(asset),
      `<span class="wb-badge mono">平铺结果</span>`,
      "wb-media--tile"
    );
  }
  if (!unit) {
    return `
    <div class="wb-plate plate wb-plate--empty">
      <div class="wb-empty-state">
        <span class="wb-empty-state__icon">${icon("tile")}</span>
        <h3>还没有可平铺的单元</h3>
        <p>先在 02 裁切，或在 03 生成透明 PNG / 线稿 PNG，再回来选单元做 2×2 或 3×3 平铺。</p>
        <div class="wb-empty-state__actions">
          <button class="btn btn--primary btn--sm" type="button" data-act="stage" data-n="3">${icon("flask")}去 03 处理</button>
          <button class="btn btn--ghost btn--sm" type="button" data-act="stage" data-n="2">去 02 裁切</button>
        </div>
      </div>
    </div>`;
  }
  const cells = Array.from(
    { length: n * n },
    () => `<span class="wb-tile__cell"><img src="${assetPreview(unit)}" alt="" aria-hidden="true" draggable="false" /></span>`
  ).join("");
  const seams = [];
  for (let i = 1; i < n; i += 1) {
    seams.push(`<span class="wb-tile__seam wb-tile__seam--v" style="left:${((i / n) * 100).toFixed(2)}%"></span>`);
    seams.push(`<span class="wb-tile__seam wb-tile__seam--h" style="top:${((i / n) * 100).toFixed(2)}%"></span>`);
  }
  return `
  <div class="wb-tile" data-tile style="--wb-tile-n:${n}" role="img"
    aria-label="${esc(`${docName()} ${tileSpec(state)} 平铺预览`)}">
    ${cells}
    ${Boolean(state.seam) ? seams.join("") : ""}
    <span class="wb-badge mono">${esc(`${kindLabel(unit.kind)} · ${n} × ${n}`)}</span>
  </div>`;
}

function plateContent(stage, state, params) {
  const loading = Boolean(expectedImage && store.session.imageId !== expectedImage && !ui.sessionError);
  if (loading) return loadingPlate();
  const asset = currentAsset();
  if (!asset) {
    if (ui.sessionError) {
      return `<div class="wb-plate plate wb-plate--empty"><div class="wb-empty-state">
        <span class="wb-empty-state__icon">${icon("alert")}</span>
        <h3>没有读到这张纹样</h3>
        <p>${esc(ui.sessionError)}</p>
        <div class="wb-empty-state__actions">
          <button class="btn btn--primary btn--sm" type="button" data-act="retry-session">${icon("history")}重试读取</button>
          <button class="btn btn--ghost btn--sm" type="button" data-act="upload">重新上传</button>
        </div></div></div>`;
    }
    return emptyPlate();
  }
  if (stage.key === "tile") {
    return `<div class="wb-plate plate plate--grain" data-plate>${tilePlate(state, stage)}</div>`;
  }
  if (state.compare) {
    const info = compareInfo(stage);
    if (info.ok) return `<div class="wb-plate plate plate--grain" data-plate>${compareHtml(info)}</div>`;
  }
  let inner = "";
  if (stage.key === "crop") inner = cropOverlay(asset);
  if (stage.key === "mask") {
    const source = maskSource();
    const sourceId = source?.sourceId || asset.asset_id;
    const width = source?.width || asset.width || 1;
    const height = source?.height || asset.height || 1;
    const url = sourceId ? http.assetPreviewUrl(sourceId) : assetPreview(asset);
    return `<div class="wb-plate plate plate--grain" data-plate>${mediaFrame(
      width,
      height,
      url,
      maskOverlay(asset),
      "wb-media--paint"
    )}</div>`;
  }
  if (stage.key === "repair") {
    const input = repairInputAsset();
    if (input) {
      return `<div class="wb-plate plate plate--grain" data-plate>${mediaBox(input, repairOverlay(input))}</div>`;
    }
  }
  if (stage.key === "candidate" && cand.selected.length) {
    inner = `<span class="wb-badge mono">已选 ${cand.selected.length} 层</span>`;
  }
  return `<div class="wb-plate plate plate--grain" data-plate>${mediaBox(asset, inner)}</div>`;
}

function captionFor(stage, state) {
  const asset = currentAsset();
  const image = sessionImage();
  if (expectedImage && store.session.imageId !== expectedImage && !ui.sessionError) return "正在读取本机纹样…";
  if (!asset) return ui.sessionError || "上传一张纹样开始";
  if (state.compare) {
    const info = compareInfo(stage);
    if (info.ok) return `对比：左${kindLabel(info.original.kind)} / 右${kindLabel(info.current.kind)} · 拖动分割线或用方向键微调`;
  }
  switch (stage.key) {
    case "source": {
      const meta = imageMeta();
      return `${kindLabel(asset.kind)} ${dimsOf(asset)} · ${gradeLabel(gradeOf())} · ${licenseLabel(
        meta.license || image?.original?.license
      )}`;
    }
    case "crop": {
      const crop = draft.crop;
      return crop
        ? `选区 ${Math.round(crop.width)} × ${Math.round(crop.height)} · 原点 (${Math.round(crop.left)}, ${Math.round(
            crop.top
          )}) · 输入 ${dimsOf(asset)}`
        : `输入 ${dimsOf(asset)}`;
    }
    case "process":
      if (draft.processRoute === "model") {
        const cap = lineartCapability();
        return `模型一键 · ${
          cap.available === true ? "前置检查通过" : cap.available === false ? "前置检查未通过" : "能力未知"
        } · 当前 ${kindLabel(asset.kind)}`;
      }
      return draft.processRoute === "color"
        ? `颜色提取 · ${extractModeLabel(draft.extractMode)} · ${draft.colors} 色 · 细节${detailLabel(draft.detail)}`
        : `线稿分步 · ${draft.lineMethod === "model" ? "模型" : "OpenCV"} · 当前 ${kindLabel(asset.kind)}`;
    case "candidate": {
      if (!store.seedream?.enabled) return "云端未配置：候选层需要在设置里启用云端";
      if (cand.layers.length) return `云端候选 ${cand.layers.length} 层 · 已选 ${cand.selected.length} 层`;
      return `输入 ${kindLabel(asset.kind)} ${dimsOf(asset)} · 等待生成候选`;
    }
    case "mask": {
      const source = maskSource();
      if (!source?.sourceId) return "当前资产缺少源图记录，不能直接修正";
      const points = maskState.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
      return `源图 ${dimsOf(asset)} · ${draft.maskMode === "add" ? "补前景" : "擦除"} · 半径 ${brushRadius()} px · ${points} 个点`;
    }
    case "repair": {
      if (!store.seedream?.enabled) return "云端未配置：局部修复需要在设置里启用云端";
      const box = draft.repair;
      return box
        ? `修复框 ${Math.round(box.width)} × ${Math.round(box.height)} · ${repairIntentLabel(draft.repairIntent)} · 羽化 ${draft.repairFeather} px`
        : "选择修复区域";
    }
    case "tile": {
      const unit = tileUnit();
      return `${tileSpec(state)} · ${unit ? kindLabel(unit.kind) : "未选单元"} · 接缝${SEAM_LABELS[draftSeam()]}`;
    }
    default:
      return "";
  }
}

function statusFor(stage, state) {
  const asset = currentAsset();
  if (!asset) return ui.sessionError || "未打开资产";
  if (ui.running) return `任务运行中：${ui.job?.kind ? jobKindLabel(ui.job.kind) : "提交中"} · ${progressOf(ui.job)}%`;
  if (ui.error) return ui.error;
  const done = ui.job && ui.jobStage === stageNo(stage) && ui.job.state === "succeeded";
  switch (stage.key) {
    case "source":
      return `原件只读 · 当前资产 ${kindLabel(asset.kind)} ${dimsOf(asset)}`;
    case "crop":
      return done
        ? "裁切完成 · 可在资产轨切换结果"
        : draft.crop
        ? `裁切未提交 · ${Math.round(draft.crop.width)} × ${Math.round(draft.crop.height)} · 原点 (${Math.round(
            draft.crop.left
          )}, ${Math.round(draft.crop.top)})`
        : "未设置选区";
    case "process": {
      const routeLabel = draft.processRoute === "model" ? "模型一键" : draft.processRoute === "color" ? "颜色提取" : "线稿";
      if (done) return `${routeLabel}完成 · 当前 ${kindLabel(asset.kind)} ${dimsOf(asset)}`;
      if (draft.processRoute === "model") return `模型一键 · ${isImageLike(asset) ? "可尝试" : "当前资产不能作为输入"}`;
      if (draft.processRoute === "color") return "颜色提取未提交";
      return `线稿路线 · ${isImageLike(asset) ? "可生成线稿" : "当前资产不能作为线稿输入"}`;
    }
    case "candidate":
      return store.seedream?.enabled ? `${cand.selected.length} 层已选 · 未合成` : "云端未配置，候选不可用";
    case "mask": {
      const source = maskSource();
      const points = maskState.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
      if (done) return "蒙版修正完成 · 已生成新的透明 PNG";
      return source?.sourceId
        ? `蒙版修正未提交 · ${maskState.strokes.length} 笔 / ${points} 个点`
        : "缺少源图或蒙版记录，无法提交";
    }
    case "repair":
      return store.seedream?.enabled ? "修复候选未生成" : "云端未配置，修复不可用";
    case "tile": {
      const unit = tileUnit();
      if (done) return "平铺预览完成 · 可在资产轨查看结果";
      return unit
        ? `${tileSpec(state)} 平铺 · 单元 ${kindLabel(unit.kind)} ${dimsOf(unit)} · 接缝${SEAM_LABELS[draftSeam()]}`
        : "没有可平铺的单元";
    }
    default:
      return "";
  }
}

function statusShort(stage, state) {
  if (ui.running) return "任务运行中";
  if (ui.error) return "上一步失败";
  const asset = currentAsset();
  if (!asset) return "未打开资产";
  const done = ui.job && ui.jobStage === stageNo(stage) && ui.job.state === "succeeded";
  switch (stage.key) {
    case "source":
      return "原件只读 · 不上传云端";
    case "crop":
      return done ? "裁切完成" : "裁切未提交";
    case "process":
      return done
        ? "任务已完成"
        : draft.processRoute === "model"
        ? "模型一键未提交"
        : draft.processRoute === "color"
        ? "颜色提取未提交"
        : "线稿未提交";
    case "candidate":
      return store.seedream?.enabled ? `${cand.selected.length} 层已选` : "云端未配置";
    case "mask":
      return done ? "蒙版修正完成" : maskState.strokes.length ? `${maskState.strokes.length} 笔未提交` : "还没有笔迹";
    case "repair":
      if (repairState.info) return "修复候选待决定";
      return store.seedream?.enabled ? "候选未生成" : "云端未配置";
    case "tile": {
      const unit = tileUnit();
      return done ? "平铺预览已生成" : unit ? `${tileSpec(state)} 未生成` : "没有平铺单元";
    }
    default:
      return "";
  }
}

/* ------------------------------------------------------------------ 中栏 */

function mainHtml(stage, state) {
  const asset = currentAsset();
  const tilePreview = stage.key === "tile" ? (tilePreviewFor(tileUnit()?.asset_id || "", tileN(state)) || (asset?.kind === "tile_preview" ? asset : null)) : null;
  const dims = stage.key === "tile" ? tilePreview || tileUnit() : asset;
  const zoom = zoomMode(state);
  const compare = compareInfo(stage);
  const compareOn = stage.key !== "tile" && Boolean(state.compare) && compare.ok;
  const caption = captionFor(stage, state);
  return `
  <section class="wb-main" aria-label="画布与纸本图版">
    <header class="wb-main__head">
      <div class="wb-main__id">
        <span class="wb-main__no">${stage.n}</span>
        <div class="wb-main__titles">
          <h2 class="wb-main__title">${esc(stageCopy(stage).title)}</h2>
          <p class="wb-main__sub"><span class="wb-main__stage">${esc(stage.name)}</span> · ${esc(stageCopy(stage).note)}</p>
        </div>
      </div>
      <div class="wb-tools" role="toolbar" aria-label="画布工具">
        <button class="icon-btn" type="button" data-act="prev-asset" aria-label="上一个资产" title="上一个资产（[）">
          ${icon("undo")}
        </button>
        <button class="icon-btn" type="button" data-act="next-asset" aria-label="下一个资产" title="下一个资产（]）">
          ${icon("redo")}
        </button>
        <span class="wb-tools__sep" aria-hidden="true"></span>
        <div class="seg wb-zoom" role="group" aria-label="画布缩放">
          ${[
            ["fit", "适应"],
            ["1", "100%"],
            ["2", "200%"],
          ]
            .map(
              ([value, label]) =>
                `<button class="seg__btn" type="button" data-act="zoom" data-val="${value}" aria-pressed="${
                  zoom === value
                }">${label}</button>`
            )
            .join("")}
        </div>
        <button class="wb-toggle" type="button" data-act="compare" aria-pressed="${compareOn}"
          aria-disabled="${!compare.ok}"
          aria-label="${esc(compare.ok ? "对比原件与当前资产" : compare.reason)}"
          title="${esc(compare.ok ? "对比原件与当前资产（C）" : compare.reason)}">
          ${icon("compare")}<span>对比</span>
        </button>
      </div>
    </header>

    <div class="wb-main__caption">
      <span class="mono wb-caption__tag">图版 ${stage.n}</span>
      <span class="wb-caption__text" data-live="caption" title="${esc(caption)}">${esc(caption)}</span>
      <span class="mono wb-caption__zoom" data-live="zoom">${zoomLabel(zoom)}</span>
    </div>

    <div class="wb-canvas" data-canvas>
      <div class="wb-canvas__sizer">
        <div class="wb-frame" data-frame>
          ${plateContent(stage, state, null)}
        </div>
      </div>
    </div>

    <footer class="wb-main__foot">
      <span class="wb-main__status" data-live="status" title="${esc(statusFor(stage, state))}">${esc(
        statusFor(stage, state)
      )}</span>
      <span class="mono wb-main__dim">${
        dims ? esc(`${dimsOf(dims)} · ${kindLabel(dims.kind)}`) : "—"
      }</span>
    </footer>
  </section>`;
}

/* ------------------------------------------------------------------ 右栏：面板片段 */

const extractModeLabel = (mode) => (EXTRACT_MODES.find(([value]) => value === mode) || ["", mode])[1];
const detailLabel = (detail) => (DETAILS.find(([value]) => value === detail) || ["", detail])[1];
const repairIntentLabel = (intent) => (REPAIR_INTENTS.find(([value]) => value === intent) || ["", intent])[1];

function draftSeam() {
  return draft.seam || "not_reviewed";
}

function sourcePanel(state) {
  const image = sessionImage();
  const meta = imageMeta();
  const asset = currentAsset();
  if (!image && !asset) {
    return `
    ${sec(
      "放入纹样",
      "单张",
      `<button class="wb-drop" type="button" data-act="upload">
        ${icon("upload")}
        <span class="wb-drop__title">上传原件或点击选择</span>
        <span class="mono wb-drop__hint">PNG / JPEG · 单张 ≤ 20 MB</span>
      </button>
      <p class="field__hint">上传后本机服务会保存原件、规范输入、aHash、清晰度与来源记录；不写入浏览器存储。</p>`
    )}
    ${sec(
      "或从纹样库开始",
      "",
      `<button class="btn btn--ghost btn--sm btn--block" type="button" data-act="library">${icon("gallery")}去纹样库挑一件</button>`
    )}`;
  }
  const original = image?.original || null;
  const normalized = image?.normalized || null;
  const sessionAssets = (store.session.assets || []).filter(
    (entry) => entry.kind === "original" || entry.kind === "normalized_input"
  );
  return `
  ${sec(
    "原件信息",
    image ? `#${esc(shortId(image.image_id))}` : esc(kindLabel(asset.kind)),
    `<dl class="kv wb-kv">
      ${image ? `<div class="kv__row"><dt>名称</dt><dd>${esc(docName())}</dd></div>` : ""}
      <div class="kv__row"><dt>尺寸</dt><dd class="mono">${esc(dimsOf(original || asset))}</dd></div>
      <div class="kv__row"><dt>格式</dt><dd>${esc(original?.original_format || "—")}</dd></div>
      <div class="kv__row"><dt>等级</dt><dd>${esc(gradeLabel(gradeOf()))}</dd></div>
      <div class="kv__row"><dt>内容 ID</dt><dd class="mono" title="${esc(meta.content_id || original?.content_id || "")}">${esc(
        String(meta.content_id || original?.content_id || "—").slice(0, 16)
      )}</dd></div>
      <div class="kv__row"><dt>sha256</dt><dd class="mono" title="${esc(original?.sha256 || "")}">${esc(
        String(original?.sha256 || "—").slice(0, 12)
      )}…</dd></div>
      <div class="kv__row"><dt>许可证</dt><dd>${esc(licenseLabel(meta.license || original?.license))}</dd></div>
      <div class="kv__row"><dt>来源</dt><dd>${esc(sourceText())}</dd></div>
      <div class="kv__row"><dt>采集</dt><dd>${esc(meta.collected_at || "—")}</dd></div>
      <div class="kv__row"><dt>批次</dt><dd>${esc(meta.batch_id || "—")}</dd></div>
      <div class="kv__row"><dt>清晰度 / 对比度</dt><dd class="mono">${
        Number.isFinite(Number(meta.sharpness)) ? Number(meta.sharpness).toFixed(1) : "—"
      } / ${Number.isFinite(Number(meta.contrast)) ? Number(meta.contrast).toFixed(1) : "—"}</dd></div>
      <div class="kv__row"><dt>创建</dt><dd class="mono">${esc(createdText())}</dd></div>
    </dl>
    <p class="field__hint">原件只读：路径、哈希与上传时间都不会被改写。</p>`
  )}
  ${sec(
    "原件与规范输入",
    sessionAssets.length ? `${sessionAssets.length} 个资产` : "",
    `${
      sessionAssets.length
        ? assetChoices(sessionAssets, { currentId: store.session.currentAssetId })
        : `<p class="field__hint">当前会话没有登记原始资产。</p>`
    }
     <div class="wb-inline">
       <button class="btn btn--ghost btn--sm" type="button" data-act="upload">${icon("upload")}重新上传</button>
       <button class="btn btn--quiet btn--sm" type="button" data-act="library">换一件</button>
     </div>`
  )}
  ${
    normalized
      ? sec(
          "规范输入",
          esc(dimsOf(normalized)),
          `<dl class="kv wb-kv">
            <div class="kv__row"><dt>色彩</dt><dd>${esc(normalized.normalization?.color_conversion || "—")}</dd></div>
            <div class="kv__row"><dt>透明通道</dt><dd>${normalized.normalization?.has_transparency ? "有" : "无"}</dd></div>
            <div class="kv__row"><dt>变换</dt><dd class="mono">${esc(normalized.normalization?.transform?.operation || "—")}</dd></div>
          </dl>
          <p class="field__hint">规范输入是后续裁切、提取与矢量的默认输入。</p>`
        )
      : ""
  }`;
}

function cropPanel(state) {
  const asset = currentAsset();
  if (!asset) return noAssetPanel();
  const dims = currentDims(asset);
  if (!dims) return noAssetPanel();
  const crop = draft.crop || { left: 0, top: 0, width: dims.width, height: dims.height };
  const error = cropError();
  const usable = isImageLike(asset);
  return `
  ${jobBox(currentStage(state))}
  ${errorBox()}
  ${noticeBox()}
  ${usable ? "" : noteBox("当前资产不是 RGB 图片（例如 SVG 或 ZIP），不能作为裁切输入。请先在资产轨选一张原图、规范输入或裁切图。", "error")}
  ${sec(
    "选区坐标",
    `输入 ${esc(dimsOf(asset))}`,
    `<div class="wb-grid2">
      ${numField("cropLeft", "左", crop.left, 0, dims.width - 1)}
      ${numField("cropTop", "上", crop.top, 0, dims.height - 1)}
      ${numField("cropWidth", "宽", crop.width, 1, dims.width)}
      ${numField("cropHeight", "高", crop.height, 1, dims.height)}
    </div>
    <p class="wb-crop-summary mono" data-live="crop-summary">${Math.round(crop.width)} × ${Math.round(
      crop.height
    )} · 原点 (${Math.round(crop.left)}, ${Math.round(crop.top)})</p>
    <p class="field__hint">坐标使用当前资产真实像素：right = left + width，bottom = top + height，均为开区间终点。也可以直接在纸面上拖一个框。</p>`
  )}
  ${sec(
    "比例预设",
    "",
    `${segField(
      "cropPreset",
      "裁切比例",
      [
        ["original", "原比例"],
        ["square", "1:1"],
      ],
      draft.cropPreset || "original"
    )}
    <p class="field__hint">原比例取整幅；1:1 以短边为边长居中。拖动仍可任意改。</p>`
  )}
  ${sec(
    "提交",
    "本机任务",
    `<p class="field__hint">裁切是独立的本机任务，产物类型为「裁切」，原图与规范输入保留。${
      error ? `<strong class="wb-field-error">${esc(error)}</strong>` : ""
    }</p>`
  )}`;
}

function processPanel(state) {
  const asset = currentAsset();
  if (!asset) return noAssetPanel();
  const stage = currentStage(state);
  const cap = lineartCapability();
  const outputs = (ui.job && ui.jobStage === stageNo(stage) ? ui.job.result?.assets || [] : []).filter(Boolean);
  const lastPipeline = lastJob(["pipeline", "lineart", "vectorize"]);
  const jobAssets = outputs.length
    ? outputs
    : (store.session.assets || []).filter((entry) => lastPipeline && entry.generated_by_job_id === lastPipeline.job_id);
  const routeHint =
    draft.processRoute === "model"
      ? "模型一键：直接以当前资产为输入，依次发布线稿 PNG 与黑白 SVG；不发送提取/增强参数，也不发起云端调用。"
      : draft.processRoute === "color"
      ? "先做前景提取，再按颜色矢量化；一步生成蒙版、透明 PNG、轮廓线稿与 SVG。"
      : "先单独生成线稿 PNG（模型或 OpenCV），再单独矢量化成单色或轮廓 SVG。";
  return `
  ${jobBox(stage)}
  ${errorBox()}
  ${noticeBox()}
  ${sec(
    "路线",
    "都在本机",
    `${segField(
      "processRoute",
      "处理路线",
      [
        ["model", "模型一键"],
        ["color", "颜色提取"],
        ["line", "线稿分步"],
      ],
      draft.processRoute
    )}
    <p class="field__hint">${esc(routeHint)}</p>`
  )}
  ${
    draft.processRoute === "model"
      ? `${sec(
          "模型线稿",
          cap.available === true ? "前置检查通过" : cap.available === false ? "前置检查未通过" : "能力未知",
          `${noteBox(esc(lineartCapabilityText()), cap.available === false ? "error" : "info")}
          <p class="field__hint">${
            cap.available === false
              ? "这条路线暂不可用；可切到「颜色提取」或「线稿分步」，OpenCV 线稿仍在本机可用。"
              : "可以先尝试；若前置检查未通过，提交会被本机服务拒绝或任务失败，失败时已发布的 PNG 会保留。"
          }</p>`
        )}`
      : draft.processRoute === "color"
      ? `${sec(
          "提取",
          `输入 ${esc(dimsOf(asset))}`,
          `${selectField("extractMode", "提取模式", EXTRACT_MODES, draft.extractMode)}
          ${segField("polarity", "前景极性", POLARITIES, draft.polarity)}
          ${rangeField("threshold", "阈值", 0, 255, 1, draft.threshold, "Otsu / 手动阈值用到；自适应与 GrabCut 模式会忽略或作为参考。")}
          <p class="field__hint">${
            draft.extractMode === "grabcut"
              ? "GrabCut 需要矩形：默认使用 02 的选区，整幅时会自动内缩 5% 留出背景。"
              : "颜色提取只处理当前资产；复杂背景建议先裁切。"
          }</p>`
        )}
        ${sec(
          "矢量化",
          "vtracer",
          `${segField("vectorMode", "矢量模式", VECTOR_MODES, draft.vectorMode)}
          ${segField("colors", "颜色数", COLOR_OPTIONS.map(([value, text]) => [value, text]), draft.colors)}
          ${segField("detail", "细节", DETAILS, draft.detail)}
          <p class="field__hint">颜色数只影响 SVG 填充；细节越高路径越多、越接近原图，也更容易碰到本机内存上限。</p>`
        )}`
      : `${sec(
          "线稿",
          "本机",
          `${segField(
            "lineMethod",
            "线稿方法",
            [
              ["opencv", "OpenCV（本机）"],
              ["model", "模型线稿（本机）"],
            ],
            draft.lineMethod
          )}
          <p class="field__hint">${
            draft.lineMethod === "model"
              ? `${esc(lineartCapabilityText())}${
                  cap.available === false ? " 当前前置检查未通过，请切回 OpenCV。" : ""
                }`
              : "OpenCV 线稿在本机完成，不发起云端调用，也不产生费用。"
          }</p>`
        )}
        ${sec(
          "矢量化线稿 PNG",
          isImageLike(asset) ? "当前可作为输入" : "当前不可作为输入",
          `${segField("lineVectorMode", "矢量模式", [["monochrome", "单色"], ["contour", "轮廓"]], draft.lineVectorMode)}
          ${segField("lineColors", "颜色数", COLOR_OPTIONS.map(([value, text]) => [value, text]), draft.lineColors)}
          ${segField("lineDetail", "细节", DETAILS, draft.lineDetail)}
          <p class="field__hint">先生成线稿 PNG，再把当前资产切到 PNG / 透明 PNG 后矢量化；也能对已提取的透明 PNG 使用。</p>`
        )}`
  }
  ${sec(
    "最新产物",
    jobAssets.length ? `${jobAssets.length} 个` : "暂无",
    `${
      jobAssets.length
        ? assetChoices(jobAssets, { currentId: store.session.currentAssetId })
        : `<p class="field__hint">提交后这里会列出线稿 PNG、SVG、前景蒙版与透明 PNG，可直接设为当前资产。</p>`
    }`
  )}`;
}

function candidatePanel(state) {
  const stage = currentStage(state);
  if (!store.seedream?.enabled) {
    return `${jobBox(stage)}${errorBox()}${noticeBox()}${cloudDisabled(null)}${sec(
      "本机替代",
      "",
      `<p class="field__hint">没有云端也可以完成颜色提取、线稿、蒙版与导出；候选层是可选增强。</p>`
    )}`;
  }
  const normalized = (store.session.assets || []).find((entry) => entry.kind === "normalized_input") || null;
  const inputAsset = normalized || (currentAsset()?.kind === "normalized_input" ? currentAsset() : null);
  const enabled = inputAsset && draft.consentUpload && draft.consentCharge && !ui.running;
  return `
  ${jobBox(stage)}
  ${errorBox()}
  ${noticeBox()}
  ${inputAsset ? "" : noteBox("云端候选需要规范输入：请在 01 把「规范输入」设为当前资产，或重新打开这张纹样。", "error")}
  ${sec(
    "云端参数",
    `${esc(store.seedream?.model || "云端模型")}`,
    `${selectField("candSize", "生成尺寸", AI_SIZE_OPTIONS, draft.candSize)}
    ${segField("candColors", "颜色数", COLOR_OPTIONS.map(([value, text]) => [value, text]), draft.candColors)}
    ${segField("candDetail", "细节", DETAILS, draft.candDetail)}
    <p class="field__hint">尺寸与颜色数会随请求一起存档；费用门禁与预算来自设置页。</p>`
  )}
  ${sec(
    "显式同意",
    "每次调用都要确认",
    `${checkRow("consentUpload", "同意把当前规范输入上传到云端服务商", draft.consentUpload, "只发送这一次请求所需的输入图。")}
    ${checkRow("consentCharge", "同意按设置里的价格为本调用计费", draft.consentCharge, "失败不自动重试，也不会自动再次计费。")}
    <p class="field__hint">两项都勾选后才能生成候选。</p>`
  )}
  ${sec(
    "候选层",
    cand.layers.length ? `${cand.layers.length} 层` : "尚未生成",
    `${
      cand.loading
        ? loadingBox()
        : cand.error
        ? noteBox(esc(cand.error), "error")
        : cand.layers.length
        ? `<ul class="wb-cands">${cand.layers
            .map((layer) => {
              const placed = layer.placed_asset || layer.asset || {};
              const on = cand.selected.includes(layer.layer_id);
              const url = assetPreview(placed);
              return `<li>
                <button class="wb-cand" type="button" data-act="layer" data-id="${layer.layer_id}" aria-pressed="${on}"
                  aria-label="${esc(`候选层 ${layer.z_index}${on ? " · 已选" : ""}`)}">
                  <span class="wb-cand__thumb">${url ? `<img src="${url}" alt="" loading="lazy" />` : icon("layers")}</span>
                  <span class="wb-cand__body">
                    <span class="wb-cand__name">第 ${layer.z_index} 层</span>
                    <span class="wb-cand__meta mono">${esc(shortId(layer.layer_id))}${
                      layer.bbox ? ` · ${esc(`${layer.bbox.left},${layer.bbox.top}`)}` : ""
                    }</span>
                  </span>
                  <span class="wb-cand__score mono">${on ? "✓" : ""}</span>
                </button>
              </li>`;
            })
            .join("")}</ul>
          <p class="field__hint">选中的层会按顺序在本地合成；不重新调用云端。</p>`
        : `<p class="field__hint">生成云端候选后，这里会显示可选的层。选定前不会写入版本。</p>`
    }`
  )}`;
}

function maskPanel(state) {
  const stage = currentStage(state);
  const asset = currentAsset();
  if (!asset) return noAssetPanel();
  const source = maskSource();
  const usable = (store.session.assets || []).filter(
    (entry) =>
      entry.kind === "transparent_png" &&
      (entry.source_rgb_asset_id || (entry.parents || []).some((parent) => parent.role === "source_rgb")) &&
      (entry.source_mask_asset_id || (entry.parents || []).some((parent) => parent.role === "foreground_mask"))
  );
  const points = maskState.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
  const error = maskError();
  return `
  ${jobBox(stage)}
  ${errorBox()}
  ${noticeBox()}
  ${sec(
    "蒙版来源",
    source?.sourceId ? `源图 ${esc(shortId(source.sourceId))}` : "缺少记录",
    source?.sourceId && source?.maskId
      ? `<dl class="kv wb-kv">
          <div class="kv__row"><dt>源图</dt><dd class="mono">${esc(source.sourceId)}</dd></div>
          <div class="kv__row"><dt>基础蒙版</dt><dd class="mono">${esc(source.maskId)}</dd></div>
          <div class="kv__row"><dt>画布</dt><dd class="mono">${esc(dimsOf(asset))}</dd></div>
        </dl>
        <p class="field__hint">画笔坐标使用源图 RGB 像素；提交后生成新的透明 PNG，旧 PNG 与来源记录保留。</p>`
      : `${noteBox(
          "当前资产不是可修正的透明 PNG（或缺少来源蒙版）。请先在 03 做颜色提取，或从下面选择一个透明 PNG。",
          "error"
        )}
        ${usable.length ? assetChoices(usable, { currentId: store.session.currentAssetId }) : ""}`
  )}
  ${sec(
    "模式",
    "只改前景",
    `${segField(
      "maskMode",
      "画笔模式",
      [
        ["add", "补前景"],
        ["erase", "擦除"],
      ],
      draft.maskMode
    )}
    <p class="field__hint">补前景加不透明像素，擦除只去掉杂点；原图不动。</p>`
  )}
  ${sec(
    "画笔",
    `半径 ${brushRadius()} px`,
    `${rangeField("maskRadius", "笔刷半径", 1, 128, 1, brushRadius())}
    <div class="wb-inline">
      <button class="btn btn--ghost btn--sm" type="button" data-act="undo-stroke">${icon("undo")}撤销上一笔</button>
      <span class="mono wb-inline__note" data-live="mask-points">${maskState.strokes.length} 笔 · ${points} 点</span>
    </div>
    <p class="field__hint">在纸面上拖动即可记录笔迹；可以连续画多笔，最多 ${MASK_MAX_POINTS} 个采样点。${
      error ? `<strong class="wb-field-error">${esc(error)}</strong>` : ""
    }</p>`
  )}`;
}

function repairCandidateList(info) {
  if (!info) return "";
  const rows = [];
  if (info.composited_asset) {
    rows.push({
      asset: info.composited_asset,
      label: "本地局部合成",
      full: false,
    });
  }
  if (info.candidate_asset) {
    rows.push({
      asset: info.candidate_asset,
      label: "全图 AI 候选",
      full: true,
    });
  }
  if (!rows.length) return `<p class="field__hint">这次修复没有返回候选资产。</p>`;
  const decided = Boolean(info.decision);
  return `
  <ul class="wb-cands">
    ${rows
      .map((row) => {
        const url = assetPreview(row.asset);
        return `<li>
          <div class="wb-cand">
            <span class="wb-cand__thumb">${url ? `<img src="${url}" alt="" loading="lazy" />` : icon("file")}</span>
            <span class="wb-cand__body">
              <span class="wb-cand__name">${esc(row.label)}${row.full ? `<span class="wb-cand__tag">全图</span>` : ""}</span>
              <span class="wb-cand__meta mono">${esc(kindLabel(row.asset.kind))} · ${esc(dimsOf(row.asset))}</span>
            </span>
            ${
              decided
                ? ""
                : `<button class="btn btn--primary btn--sm" type="button" data-act="accept-repair"
                    data-id="${row.asset.asset_id}" data-full="${row.full ? "1" : "0"}">接受</button>`
            }
          </div>
        </li>`;
      })
      .join("")}
  </ul>
  ${decided ? "" : `<button class="btn btn--quiet btn--sm btn--block" type="button" data-act="reject-repair">拒绝这次修复</button>`}`;
}

function repairPanel(state) {
  const stage = currentStage(state);
  if (!store.seedream?.enabled) {
    return `${jobBox(stage)}${errorBox()}${noticeBox()}${cloudDisabled(null)}`;
  }
  const asset = currentAsset();
  const normalized = (store.session.assets || []).find((entry) => entry.kind === "normalized_input") || null;
  const inputAsset = normalized || (asset?.kind === "normalized_input" ? asset : null);
  const info = repairState.info;
  const box = draft.repair;
  const dims = inputAsset ? currentDims(inputAsset) : null;
  const enabled = Boolean(inputAsset && box && draft.repairConsentUpload && draft.repairConsentCharge && !ui.running);
  return `
  ${jobBox(stage)}
  ${errorBox()}
  ${noticeBox()}
  ${inputAsset ? "" : noteBox("局部修复需要规范输入（normalized_input）。请在 01 把规范输入设为当前资产。", "error")}
  ${sec(
    "修复区域",
    inputAsset ? esc(dimsOf(inputAsset)) : "",
    `${
      dims
        ? `<div class="wb-grid2">
            ${numField("repairLeft", "左", box.left, 0, dims.width - 1)}
            ${numField("repairTop", "上", box.top, 0, dims.height - 1)}
            ${numField("repairWidth", "宽", box.width, 1, dims.width)}
            ${numField("repairHeight", "高", box.height, 1, dims.height)}
          </div>`
        : ""
    }
    <p class="field__hint">区域使用规范输入的像素坐标；云端的全图候选可能改变整幅画面，接受前需额外确认。</p>`
  )}
  ${sec(
    "修复参数",
    `最大 1024 × 1024`,
    `${segField("repairIntent", "意图", REPAIR_INTENTS, draft.repairIntent)}
    ${rangeField("repairFeather", "羽化", 0, 64, 1, draft.repairFeather)}
    ${selectField("repairSize", "生成尺寸", SIZE_OPTIONS.filter(([value]) => value !== "auto"), draft.repairSize)}`
  )}
  ${sec(
    "显式同意",
    "每次调用都要确认",
    `${checkRow("repairConsentUpload", "同意上传当前规范输入到云端服务商", draft.repairConsentUpload)}
    ${checkRow("repairConsentCharge", "同意按设置里的价格为本调用计费", draft.repairConsentCharge)}
    <p class="field__hint">失败不自动重发；旧结果与来源记录保留。</p>`
  )}
  ${sec(
    "修复候选",
    info ? esc(jobStateLabel(info.state === "waiting_user" ? "running" : info.state === "accepted" ? "succeeded" : info.state === "rejected" ? "cancelled" : info.state)) : "",
    `${
      repairState.loading
        ? loadingBox()
        : repairState.error
        ? noteBox(esc(repairState.error), "error")
        : info
        ? `${repairCandidateList(info)}
           ${info.decision ? `<p class="field__hint">已${info.decision.action === "accept" ? "接受" : "拒绝"}这次修复。</p>` : ""}
           ${checkRow("acceptFull", "接受全图 AI 候选前，我确认它可能改变整个画面", draft.acceptFull)}`
        : `<p class="field__hint">提交后这里会显示全图候选与本地局部合成，由你决定接受或拒绝。</p>`
    }`
  )}`;
}

function exportsSection(state) {
  const assets = exportableAssets();
  const selection = exportSelection();
  const selectedSet = new Set(selection);
  const zip = ui.lastExport;
  return sec(
    "导出",
    selection.length ? `${selection.length} 个资产` : "未选",
    `${
      assets.length
        ? `<ul class="wb-export-list">
            ${assets
              .map(
                (asset) => `<li>
                  <label class="wb-export-row">
                    <input class="wb-check__input" type="checkbox" data-export="${asset.asset_id}"
                      ${selectedSet.has(asset.asset_id) ? "checked" : ""} aria-label="${esc(kindLabel(asset.kind))}" />
                    <span class="wb-check__box" aria-hidden="true">${icon("check")}</span>
                    <span class="wb-export-row__body">
                      <span class="wb-export-row__name">${esc(kindLabel(asset.kind))}</span>
                      <span class="mono wb-export-row__meta">${esc(dimsOf(asset))} · ${esc(shortId(asset.asset_id))}</span>
                    </span>
                  </label>
                </li>`
              )
              .join("")}
          </ul>`
        : `<p class="field__hint">会话里还没有可导出的资产。</p>`
    }
    ${checkRow(
      "licenseAck",
      "许可证已确认（勾选后才能导出未登记许可证的资产）",
      draft.licenseAck,
      "导出清单会记录这次确认。"
    )}
    <div class="wb-inline">
      <button class="btn btn--primary btn--sm" type="button" data-act="run-export"${
        selection.length && draft.licenseAck && !ui.running ? "" : " disabled"
      }>${icon("download")}导出 ZIP</button>
      <span class="mono wb-inline__note">${selection.length} / 24</span>
    </div>
    ${
      zip
        ? `<a class="btn btn--paper btn--sm btn--block wb-download" href="${http.assetDownloadUrl(zip.asset_id)}" download>
            ${icon("download")}下载 ZIP · ${esc(formatBytes(zip.bytes))}
          </a>`
        : ""
    }`
  );
}

function tilePanel(state) {
  const stage = currentStage(state);
  const units = tileUnitAssets();
  const unit = tileUnit();
  const n = tileN(state);
  const preview = unit ? tilePreviewFor(unit.asset_id, n) : null;
  const previewAsset = preview || (currentAsset()?.kind === "tile_preview" ? currentAsset() : null);
  const revision = previewAsset?.seam_observation_revision ?? 0;
  return `
  ${jobBox(stage)}
  ${errorBox()}
  ${noticeBox()}
  ${sec(
    "平铺单元",
    unit ? esc(kindLabel(unit.kind)) : "无",
    units.length
      ? `${selectField(
          "tileUnit",
          "单元来源",
          units.map((entry) => [
            entry.asset_id,
            `${kindLabel(entry.kind)} · ${dimsOf(entry)} · ${shortId(entry.asset_id)}`,
          ]),
          draft.tileUnitId
        )}
        <p class="field__hint">只有裁切、透明 PNG、线稿 PNG 与已接受的修复图能作为平铺单元；单元本身不会被改写。</p>`
      : `<p class="field__hint">还没有可平铺的单元：先做 02 裁切，或在 03 生成透明 PNG / 线稿 PNG。</p>`
  )}
  ${sec(
    "规格",
    "",
    `${segField(
      "tile",
      "平铺规格",
      [
        ["2x2", "2 × 2"],
        ["3x3", "3 × 3"],
      ],
      state.tile
    )}
    ${switchRow("seamGrid", "显示接缝网格", Boolean(state.seam))}
    <p class="field__hint">平铺是整数重复，不重新采样；预览结果会保存为独立资产。</p>`
  )}
  ${sec(
    "接缝观察",
    previewAsset ? `预览 ${esc(shortId(previewAsset.asset_id))}` : "未生成",
    `${segField("tileSeam", "接缝观察", SEAM_OPTIONS, draft.seam || "not_reviewed")}
    <div class="wb-inline">
      <button class="btn btn--ghost btn--sm" type="button" data-act="save-seam"${
        previewAsset ? "" : " disabled"
      }>${icon("history")}保存接缝观察</button>
      <span class="mono wb-inline__note">修订 ${revision}</span>
    </div>
    <p class="field__hint">观察结果与单元、规格一起写入平铺资产元数据；冲突时会重新读取后再提示。</p>`
  )}
  ${exportsSection(state)}`;
}

function panelBody(stage, state) {
  switch (stage.key) {
    case "source":
      return sourcePanel(state);
    case "crop":
      return cropPanel(state);
    case "process":
      return processPanel(state);
    case "candidate":
      return candidatePanel(state);
    case "mask":
      return maskPanel(state);
    case "repair":
      return repairPanel(state);
    case "tile":
      return tilePanel(state);
    default:
      return "";
  }
}

/* ------------------------------------------------------------------ 右栏：底部动作 */

function primaryButton(act, label, iconName, disabled = false) {
  return `<button class="btn btn--primary btn--sm" type="button" data-act="${act}"${
    disabled ? " disabled" : ""
  }>${iconName ? icon(iconName) : ""}${esc(label)}</button>`;
}

function stageActions(stage, state) {
  const asset = currentAsset();
  const busy = ui.running;
  const disabled = (condition) => busy || condition;
  switch (stage.key) {
    case "source":
      return `${primaryButton("upload", asset ? "重新上传" : "上传纹样", "upload")}
        <button class="btn btn--ghost btn--sm" type="button" data-act="library">${icon("gallery")}纹样库</button>`;
    case "crop":
      return `<button class="btn btn--quiet btn--sm" type="button" data-act="reset-crop"${
        disabled(!asset) ? " disabled" : ""
      }>重置选区</button>
        ${primaryButton("apply-crop", "应用裁切", "crop", disabled(!isImageLike(asset) || Boolean(cropError())))}`;
    case "process": {
      const cap = lineartCapability();
      if (draft.processRoute === "model") {
        return primaryButton(
          "run-model-lineart",
          cap.available === false ? "模型暂不可用" : "模型一键提取",
          "flask",
          disabled(!isImageLike(asset) || cap.available === false)
        );
      }
      if (draft.processRoute === "color") {
        return primaryButton("run-color", "开始颜色提取", "flask", disabled(!isImageLike(asset)));
      }
      const modelBlocked = draft.lineMethod === "model" && cap.available === false;
      return `<button class="btn btn--ghost btn--sm" type="button" data-act="run-lineart"${
        disabled(!isImageLike(asset) || modelBlocked) ? " disabled" : ""
      }>${icon("brush")}生成线稿</button>
        ${primaryButton("run-vectorize", "矢量化当前", "spark", disabled(!isImageLike(asset)))}`;
    }
    case "candidate":
      if (!store.seedream?.enabled) {
        return `<button class="btn btn--ghost btn--sm" type="button" data-act="settings">${icon("gear")}去设置</button>`;
      }
      if (cand.layers.length) {
        return `<button class="btn btn--ghost btn--sm" type="button" data-act="run-candidate"${
          busy ? " disabled" : ""
        }>${icon("cloud")}重新生成</button>
          ${primaryButton("compose-layers", `合成 ${cand.selected.length} 层`, "layers", disabled(!cand.selected.length))}`;
      }
      return primaryButton(
        "run-candidate",
        "生成云端候选",
        "cloud",
        disabled(!draft.consentUpload || !draft.consentCharge)
      );
    case "mask": {
      const error = maskError();
      return `<button class="btn btn--quiet btn--sm" type="button" data-act="undo-stroke"${
        disabled(!maskState.strokes.length) ? " disabled" : ""
      }>撤销上一笔</button>
        ${primaryButton("run-mask", "提交蒙版修正", "mask", disabled(Boolean(error)))}`;
    }
    case "repair":
      if (!store.seedream?.enabled) {
        return `<button class="btn btn--ghost btn--sm" type="button" data-act="settings">${icon("gear")}去设置</button>`;
      }
      return primaryButton(
        "run-repair",
        "生成修复候选",
        "cloud",
        disabled(!draft.repairConsentUpload || !draft.repairConsentCharge)
      );
    case "tile":
      return primaryButton("run-tile", "生成平铺预览", "tile", disabled(!tileUnit()));
    default:
      return "";
  }
}

function panelHtml(stage, state) {
  const collapsed = panelCollapsed();
  const busyHere = ui.running && ui.jobStage === stageNo(stage);
  const busyElsewhere = ui.running && ui.jobStage !== stageNo(stage);
  return `
  <aside class="wb-panel${collapsed ? " is-collapsed" : ""}" data-panel aria-label="本工序参数">
    <header class="wb-panel__head">
      <div class="wb-panel__top">
        <span class="label">参数 ${stage.n}</span>
        <button class="wb-panel__toggle" type="button" data-act="panel-toggle"
          aria-expanded="${!collapsed}" aria-controls="wb-panel-body">
          <span data-live="panel-toggle-label">${collapsed ? "展开参数" : "收起"}</span>${icon("chevron")}
        </button>
      </div>
      <h2 class="wb-panel__title">${esc(stage.name)} · ${esc(stageCopy(stage).title)}</h2>
      <p class="wb-panel__desc">${esc(stageCopy(stage).desc)}</p>
    </header>
    <div class="wb-panel__body" id="wb-panel-body">${panelBody(stage, state)}</div>
    <footer class="wb-panel__foot">
      <p class="mono wb-panel__status" data-live="panel-status">${
        busyElsewhere ? "另一道工序的任务正在运行…" : esc(statusShort(stage, state))
      }</p>
      <div class="wb-panel__actions">${
        busyHere
          ? `<button class="btn btn--ghost btn--sm" type="button" data-act="cancel">${icon("close")}取消任务</button>`
          : stageActions(stage, state)
      }</div>
    </footer>
  </aside>`;
}

/* ------------------------------------------------------------------ 局部更新 / 记忆 */

function panelCollapsed() {
  const twoCol = window.matchMedia("(min-width: 821px) and (max-width: 1080px)").matches;
  if (!twoCol) return false;
  return panelPref !== "open";
}

function currentCropDims() {
  const dims = currentDims();
  return dims || { width: 1, height: 1 };
}

function applyCropToDom(root) {
  if (!root) return;
  const crop = draft.crop;
  const dims = currentCropDims();
  if (!crop) return;
  const frame = root.querySelector("[data-crop-frame]");
  if (frame) {
    frame.style.left = `${(crop.left / dims.width) * 100}%`;
    frame.style.top = `${(crop.top / dims.height) * 100}%`;
    frame.style.width = `${(crop.width / dims.width) * 100}%`;
    frame.style.height = `${(crop.height / dims.height) * 100}%`;
  }
  const size = root.querySelector("[data-crop-size]");
  if (size) size.textContent = `${Math.round(crop.width)} × ${Math.round(crop.height)}`;
  const summary = root.querySelector("[data-live='crop-summary']");
  if (summary) {
    summary.textContent = `${Math.round(crop.width)} × ${Math.round(crop.height)} · 原点 (${Math.round(
      crop.left
    )}, ${Math.round(crop.top)})`;
  }
  root.querySelectorAll("[data-field]").forEach((input) => {
    const key = input.dataset.field;
    const mapping = { cropLeft: "left", cropTop: "top", cropWidth: "width", cropHeight: "height" };
    if (mapping[key]) input.value = String(Math.round(crop[mapping[key]]));
  });
}

function applyRepairToDom(root) {
  if (!root) return;
  const marker = root.querySelector("[data-repair-overlay] .wb-repair__region");
  const dims = currentDims(repairInputAsset());
  if (!marker || !dims || !draft.repair) return;
  const box = draft.repair;
  marker.style.left = `${(box.left / dims.width) * 100}%`;
  marker.style.top = `${(box.top / dims.height) * 100}%`;
  marker.style.width = `${(box.width / dims.width) * 100}%`;
  marker.style.height = `${(box.height / dims.height) * 100}%`;
  const tag = marker.querySelector(".wb-repair__tag");
  if (tag) tag.textContent = `修复框 ${Math.round(box.width)} × ${Math.round(box.height)}`;
}

function refreshLive(root, state) {
  if (!root) return;
  const stage = currentStage(state);
  const setText = (selector, value) => {
    const el = root.querySelector(selector);
    if (el) el.textContent = value;
  };
  const caption = captionFor(stage, state);
  setText("[data-live='caption']", caption);
  const captionEl = root.querySelector("[data-live='caption']");
  if (captionEl) captionEl.title = caption;
  const status = statusFor(stage, state);
  setText("[data-live='status']", status);
  const statusEl = root.querySelector("[data-live='status']");
  if (statusEl) statusEl.title = status;
  setText("[data-live='panel-status']", statusShort(stage, state));
  setText("[data-live='zoom']", zoomLabel(zoomMode(state)));
  setText("[data-live='mask-points']", `${maskState.strokes.length} 笔 · ${maskState.strokes.reduce(
    (sum, stroke) => sum + stroke.points.length,
    0
  )} 点`);
  const maskButton = root.querySelector('[data-act="run-mask"]');
  if (maskButton) {
    const problem = maskError();
    maskButton.disabled = Boolean(problem);
    maskButton.title = problem || "提交蒙版修正";
  }
}

function remember(root) {
  if (!root || !root.querySelector) return;
  const film = root.querySelector(".wb-film");
  const panel = root.querySelector(".wb-panel__body");
  const canvas = root.querySelector("[data-canvas]");
  scrollMemo = {
    at: Date.now(),
    film: film ? film.scrollTop : 0,
    panel: panel ? panel.scrollTop : 0,
    x: canvas ? canvas.scrollLeft : 0,
    y: canvas ? canvas.scrollTop : 0,
  };
  const el = document.activeElement;
  if (!el || !el.matches || !root.contains(el)) {
    focusMemo = null;
    return;
  }
  const data = el.dataset || {};
  if (data.field) focusMemo = { at: Date.now(), field: data.field };
  else if (data.range) focusMemo = { at: Date.now(), range: data.range };
  else if (data.check) focusMemo = { at: Date.now(), check: data.check };
  else if (data.export) focusMemo = { at: Date.now(), export: data.export };
  else if (data.seg) focusMemo = { at: Date.now(), seg: data.seg, val: data.val || "" };
  else if (data.act) focusMemo = { at: Date.now(), act: data.act, id: data.id || "", val: data.val || "" };
  else focusMemo = null;
}

function restoreScroll(root) {
  if (!scrollMemo) return;
  const memo = scrollMemo;
  scrollMemo = null;
  if (Date.now() - memo.at > 2000) return;
  const film = root.querySelector(".wb-film");
  if (film) film.scrollTop = memo.film;
  const panel = root.querySelector(".wb-panel__body");
  if (panel) panel.scrollTop = memo.panel;
  const canvas = root.querySelector("[data-canvas]");
  if (canvas) {
    canvas.scrollLeft = memo.x;
    canvas.scrollTop = memo.y;
  }
}

function restoreFocus(root) {
  if (!focusMemo) return;
  const memo = focusMemo;
  focusMemo = null;
  if (Date.now() - memo.at > 2000) return;
  let selector = "";
  if (memo.field) selector = `[data-field="${memo.field}"]`;
  else if (memo.range) selector = `[data-range="${memo.range}"]`;
  else if (memo.check) selector = `[data-check="${memo.check}"]`;
  else if (memo.export) selector = `[data-export="${memo.export}"]`;
  else if (memo.seg) selector = `[data-seg="${memo.seg}"][data-val="${memo.val}"]`;
  else if (memo.act) {
    selector = `[data-act="${memo.act}"]`;
    if (memo.id) selector += `[data-id="${memo.id}"]`;
    if (memo.val) selector += `[data-val="${memo.val}"]`;
  }
  if (!selector) return;
  const target = root.querySelector(selector);
  if (target && !target.disabled) target.focus({ preventScroll: true });
}

function repaint(root, api) {
  remember(root);
  api.refresh();
}

/** 整个视图重绘结束后仍停在本页时使用；离开工作台就不再触发页面重绘。 */
function repaintIfHere(api) {
  if (!(location.hash || "").includes("#/workbench")) return;
  const root = document.querySelector(".wb");
  remember(root);
  api.refresh();
}

/* ------------------------------------------------------------------ 任务执行 */

function tickProgress(job) {
  if (!job) return;
  const percent = progressOf(job);
  document.querySelectorAll("[data-run]").forEach((el) => {
    const percentEl = el.querySelector("[data-run-percent]");
    if (percentEl) percentEl.textContent = `${percent}%`;
    const bar = el.querySelector("[data-run-bar]");
    if (bar) bar.style.width = `${Math.max(2, percent)}%`;
    const stateEl = el.querySelector("[data-run-state]");
    if (stateEl) stateEl.textContent = jobStateLabel(job.state);
    const steps = el.querySelector("[data-run-steps]");
    if (steps) steps.innerHTML = stepItems(job.result?.steps || []);
  });
}

/** 云端相关任务：取消/失败文案要避免声称撤销云端请求或退费。 */
const CLOUD_JOB_KINDS = new Set(["repair", "decompose-layers", "compose-layers", "ai", "ai-pipeline"]);

function isCloudJob(job) {
  const kind = String(job?.kind || "");
  return Boolean(
    job?.result?.provider_call_id ||
      job?.parameters?.consent_to_charge ||
      job?.parameters?.consent_to_upload ||
      CLOUD_JOB_KINDS.has(kind) ||
      kind.startsWith("ai")
  );
}

/**
 * 失败/取消任务的准确文案：区分“有保留产物”和“无产物”。
 * 失败或取消时后端仍可能已发布 result.assets（例如线稿 PNG 已发布、后续矢量化失败），
 * 这些产物会由 store 保留，界面不能再说“没有写入新的产物”。
 * @returns {{ state: string, retained: string[], hasRetained: boolean, cloud: boolean, message: string }}
 */
function taskOutcomeCopy(final) {
  const job = final || {};
  const state = String(job.state || "");
  const assets = (Array.isArray(job.result?.assets) ? job.result.assets : []).filter(Boolean);
  const retained = [...new Set(assets.map((asset) => String(asset.kind || "")).filter(Boolean))];
  const hasRetained = retained.length > 0;
  const labels = retained.map((kind) => kindLabel(kind)).join("、");
  const cloud = isCloudJob(job);
  if (state === "failed") {
    return {
      state,
      retained,
      hasRetained,
      cloud,
      message: hasRetained
        ? `任务失败，但已发布的 ${labels} 已保留，可以继续在会话里使用。`
        : "任务失败，没有可用的保留产物。",
    };
  }
  if (state === "cancelled") {
    const base = hasRetained
      ? `任务已取消，但已发布的 ${labels} 已保留，可以继续在会话里使用。`
      : "任务已取消，没有已发布的保留产物。";
    const fee = cloud
      ? "已请求取消本机任务；本地取消不等于撤回已经发出的云端请求，也不退费，费用以服务商结算为准。"
      : "";
    return { state, retained, hasRetained, cloud, message: fee ? `${base}${fee}` : base };
  }
  return { state, retained, hasRetained, cloud, message: "" };
}

async function startJob(api, submit, onSuccess) {
  if (ui.running) {
    api.toast("已有任务在运行，请等待或取消后再试。", "warn");
    return;
  }
  // 在提交前捕获会话归属：任务结束、成功回调、清理 busy 都只对原会话生效。
  const token = store.sessionToken();
  const owned = () => store.isSessionCurrent(token);
  const root = document.querySelector(".wb");
  ui.running = true;
  ui.job = null;
  ui.jobId = "";
  ui.jobStage = Number(api.state.stage) || 1;
  ui.error = "";
  ui.errorDetail = "";
  ui.notice = "";
  repaint(root, api);

  let outcome = null;
  let failure = null;
  try {
    outcome = await store.runJob(submit, {
      onQueued: (queued) => {
        if (!owned()) return;
        if (queued?.job_id) ui.jobId = queued.job_id;
      },
      onTick: (snapshot) => {
        if (!owned()) return;
        ui.job = snapshot;
        tickProgress(snapshot);
      },
    });
  } catch (error) {
    failure = error;
  }

  if (owned()) {
    ui.running = false;
    ui.jobId = "";
    repaintIfHere(api);
  }
  // 会话已切换：旧任务不弹错、不写 ui、不清新会话的状态，安静退出。
  if (!owned()) return;

  if (failure) {
    ui.error = errorText(failure);
    ui.errorDetail = String(failure?.message || "");
    api.toast(ui.error, "warn");
    repaintIfHere(api);
    return;
  }
  if (!outcome || !outcome.owned || !outcome.job) return;

  const final = outcome.job;
  ui.job = final;
  if (final.state === "succeeded") {
    await onSuccess?.(final, api);
  } else if (final.state === "failed") {
    const copy = taskOutcomeCopy(final);
    ui.error = jobErrorText(final);
    ui.errorDetail = String(final.error?.message || "");
    ui.notice = copy.message;
    api.toast(copy.hasRetained ? "任务失败，但已保留部分产物。" : "任务失败。", "warn");
  } else if (final.state === "cancelled") {
    const copy = taskOutcomeCopy(final);
    ui.notice = copy.message;
    api.toast(copy.hasRetained ? "任务已取消，已保留部分产物。" : "任务已取消。", "info");
  }
  repaintIfHere(api);
  // 终态后的轻量刷新：失败静默，不覆盖任务结果。
  store.loadRecent();
  store.refreshBudget();
}

async function cancelActive(api) {
  if (!ui.jobId) {
    api.toast("任务还在提交，请稍后再取消。", "info");
    return;
  }
  try {
    await http.cancelJob(ui.jobId);
    api.toast("已请求取消任务。", "info");
  } catch (error) {
    api.toast(errorText(error), "warn");
  }
}

async function fetchLayers(api, jobId) {
  const token = store.sessionToken();
  const owned = () => store.isSessionCurrent(token);
  cand.loading = true;
  cand.error = "";
  repaintIfHere(api);
  let payload = null;
  let failure = null;
  try {
    payload = await http.layers(jobId);
  } catch (error) {
    failure = error;
  }
  if (!owned()) return null;
  cand.jobId = jobId;
  if (failure) {
    cand.error = errorText(failure);
  } else {
    cand.layers = Array.isArray(payload?.layers) ? payload.layers : [];
    cand.selected = cand.selected.filter((id) => cand.layers.some((layer) => layer.layer_id === id));
    if (!cand.layers.length) cand.error = "云端拆分没有返回可合成的层。";
  }
  cand.loading = false;
  repaintIfHere(api);
  return payload;
}

async function fetchRepair(api, jobId, token = store.sessionToken()) {
  const owned = () => store.isSessionCurrent(token);
  repairState.loading = true;
  repairState.error = "";
  repaintIfHere(api);
  let info = null;
  let failure = null;
  try {
    info = await http.repairInfo(jobId);
  } catch (error) {
    failure = error;
  }
  if (!owned()) return null;
  if (failure) {
    repairState.error = errorText(failure);
  } else {
    repairState.info = info;
  }
  repairState.loading = false;
  repaintIfHere(api);
  return failure ? null : info;
}

/* ------------------------------------------------------------------ 输入校验 */

function cropError() {
  const asset = currentAsset();
  const dims = currentDims(asset);
  const crop = draft.crop;
  if (!asset || !dims) return "先打开一个资产";
  if (!crop) return "没有选区";
  if (crop.width <= 0 || crop.height <= 0) return "选区必须是正面积";
  if (crop.width < CROP_MIN_PX || crop.height < CROP_MIN_PX) return `选区至少 ${CROP_MIN_PX} × ${CROP_MIN_PX} 像素`;
  if (crop.left < 0 || crop.top < 0) return "选区原点不能为负";
  if (crop.left + crop.width > dims.width || crop.top + crop.height > dims.height) return "选区超出当前资产范围";
  return "";
}

function maskSource() {
  const asset = currentAsset();
  if (!asset) return null;
  const parents = Array.isArray(asset.parents) ? asset.parents : [];
  const parentRole = (role) => parents.find((parent) => parent.role === role)?.asset_id || "";
  const sourceId = asset.source_rgb_asset_id || parentRole("source_rgb");
  const maskId =
    asset.kind === "foreground_mask"
      ? asset.asset_id
      : asset.source_mask_asset_id || parentRole("foreground_mask");
  return {
    sourceId,
    maskId,
    width: Number(asset.width) || 0,
    height: Number(asset.height) || 0,
  };
}

function maskError() {
  const asset = currentAsset();
  if (!asset) return "先打开一个资产";
  const source = maskSource();
  if (!source?.sourceId || !source?.maskId) return "当前资产缺少源图或蒙版记录";
  const points = maskState.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
  if (!points) return "先在纸面上画几笔";
  return "";
}

function repairInputAsset() {
  return (
    (store.session.assets || []).find((asset) => asset.kind === "normalized_input") ||
    (currentAsset()?.kind === "normalized_input" ? currentAsset() : null) ||
    currentAsset()
  );
}

function grabcutBbox() {
  const dims = currentDims();
  const crop = draft.crop;
  if (!dims || !crop) return null;
  const width = Math.max(1, Math.round(crop.width));
  const height = Math.max(1, Math.round(crop.height));
  let left = Math.round(crop.left);
  let top = Math.round(crop.top);
  let right = left + width;
  let bottom = top + height;
  if (left <= 0 && top <= 0 && right >= dims.width && bottom >= dims.height) {
    const insetX = Math.max(8, Math.round(dims.width * 0.05));
    const insetY = Math.max(8, Math.round(dims.height * 0.05));
    left = Math.min(insetX, dims.width - 2);
    top = Math.min(insetY, dims.height - 2);
    right = Math.max(left + 1, dims.width - insetX);
    bottom = Math.max(top + 1, dims.height - insetY);
  }
  left = clamp(left, 0, dims.width - 1);
  top = clamp(top, 0, dims.height - 1);
  right = clamp(right, left + 1, dims.width);
  bottom = clamp(bottom, top + 1, dims.height);
  return { left, top, right, bottom };
}

/* ------------------------------------------------------------------ 点击处理 */

function patchStage(api, root, patched) {
  remember(root);
  api.patch(patched);
}

function stageClick(root, api, el) {
  const n = Number(el.dataset.n);
  const target = STAGES[n - 1];
  if (!target) return;
  const current = currentStage(api.state);
  if (n === stageNo(current)) return;
  ui.error = "";
  ui.errorDetail = "";
  ui.notice = "";
  patchStage(api, root, { stage: n, ...(target.key === "tile" ? { compare: false } : {}) });
}

function switchAsset(api, root, assetId) {
  if (!assetId || store.session.currentAssetId === assetId) return;
  store.setCurrentAsset(assetId);
}

function cycleAsset(root, api, delta) {
  const assets = store.session.assets || [];
  if (!assets.length) return;
  const index = assets.findIndex((asset) => asset.asset_id === store.session.currentAssetId);
  const next = assets[(index + delta + assets.length) % assets.length];
  if (!next || next.asset_id === store.session.currentAssetId) return;
  store.setCurrentAsset(next.asset_id);
  api.toast(`${delta < 0 ? "上一个" : "下一个"}资产：${kindLabel(next.kind)} ${shortId(next.asset_id)}`, "info");
}

function handleSeg(root, state, api, button) {
  const key = button.dataset.seg;
  const value = button.dataset.val;
  if (key === "tile") {
    patchStage(api, root, { tile: value });
    api.toast(`平铺规格切到 ${value === "3x3" ? "3 × 3" : "2 × 2"}`, "info");
    return;
  }
  switch (key) {
    case "processRoute":
      draft.processRoute = value;
      break;
    case "extractMode":
    case "polarity":
      draft[key] = value;
      break;
    case "vectorMode":
    case "detail":
    case "lineVectorMode":
    case "lineDetail":
    case "lineMethod":
      draft[key] = value;
      break;
    case "colors":
      draft.colors = Number(value);
      break;
    case "lineColors":
      draft.lineColors = Number(value);
      break;
    case "maskMode":
      draft.maskMode = value;
      break;
    case "repairIntent":
      draft.repairIntent = value;
      break;
    case "tileSeam":
      draft.seam = value;
      break;
    case "candColors":
      draft.candColors = Number(value);
      break;
    case "candDetail":
      draft.candDetail = value;
      break;
    case "cropPreset":
      draft.cropPreset = value;
      applyCropPreset(root, value);
      repaint(root, api);
      return;
    default:
      break;
  }
  repaint(root, api);
}

function applyCropPreset(root, preset) {
  const dims = currentDims();
  if (!dims) return;
  if (preset === "square") {
    const side = Math.min(dims.width, dims.height);
    draft.crop = {
      left: Math.round((dims.width - side) / 2),
      top: Math.round((dims.height - side) / 2),
      width: side,
      height: side,
    };
  } else {
    draft.crop = { left: 0, top: 0, width: dims.width, height: dims.height };
  }
  applyCropToDom(root);
}

function patchCheckbox(root, state, api, key, checked) {
  switch (key) {
    case "consentUpload":
    case "consentCharge":
    case "repairConsentUpload":
    case "repairConsentCharge":
    case "licenseAck":
    case "acceptFull":
      draft[key] = checked;
      break;
    default:
      break;
  }
  repaint(root, api);
}

/* ------------------------------------------------------------------ 事件绑定 */

function bindCompare(root, api) {
  const compare = root.querySelector("[data-compare]");
  if (!compare) return;
  const handle = compare.querySelector("[data-cmp-handle]");
  if (!handle) return;

  const paint = (value) => {
    const pos = Math.round(clamp(value, 4, 96));
    compare.style.setProperty("--wb-pos", `${pos}%`);
    handle.setAttribute("aria-valuenow", String(pos));
    handle.setAttribute("aria-valuetext", `${pos}% 原件`);
    ui.compareX = pos;
  };
  const fromClientX = (clientX) => {
    const rect = compare.getBoundingClientRect();
    if (!rect.width) return 55;
    return ((clientX - rect.left) / rect.width) * 100;
  };
  let dragging = false;
  compare.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    compare.classList.add("is-dragging");
    try {
      compare.setPointerCapture?.(event.pointerId);
    } catch {
      /* 合成事件或指针已释放时忽略 */
    }
    paint(fromClientX(event.clientX));
    if (!handle.contains(event.target)) event.preventDefault();
  });
  compare.addEventListener("pointermove", (event) => {
    if (dragging) paint(fromClientX(event.clientX));
  });
  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    compare.classList.remove("is-dragging");
    try {
      if (compare.hasPointerCapture?.(event.pointerId)) compare.releasePointerCapture(event.pointerId);
    } catch {
      /* 同上 */
    }
  };
  compare.addEventListener("pointerup", stop);
  compare.addEventListener("pointercancel", stop);
  handle.addEventListener("keydown", (event) => {
    const now = Number(handle.getAttribute("aria-valuenow")) || 55;
    const step = event.shiftKey ? 10 : 4;
    let next = null;
    if (event.key === "ArrowLeft") next = now - step;
    if (event.key === "ArrowRight") next = now + step;
    if (event.key === "Home") next = 4;
    if (event.key === "End") next = 96;
    if (next === null) return;
    event.preventDefault();
    paint(next);
  });
}

function bindCrop(root, state, api) {
  const overlay = root.querySelector("[data-crop]");
  if (!overlay || !currentAsset()) return;
  const dims = currentDims();
  if (!dims) return;
  let origin = null;
  const toPoint = (event) => {
    const rect = overlay.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * dims.width, 0, dims.width),
      y: clamp(((event.clientY - rect.top) / rect.height) * dims.height, 0, dims.height),
    };
  };
  overlay.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const point = toPoint(event);
    if (!point) return;
    origin = point;
    draft.crop = { left: point.x, top: point.y, width: 1, height: 1 };
    applyCropToDom(root);
    try {
      overlay.setPointerCapture?.(event.pointerId);
    } catch {
      /* ignore */
    }
    event.preventDefault();
  });
  overlay.addEventListener("pointermove", (event) => {
    if (!origin) return;
    const point = toPoint(event);
    if (!point) return;
    const left = Math.min(origin.x, point.x);
    const top = Math.min(origin.y, point.y);
    draft.crop = {
      left,
      top,
      width: Math.max(1, Math.abs(point.x - origin.x)),
      height: Math.max(1, Math.abs(point.y - origin.y)),
    };
    applyCropToDom(root);
    refreshLive(root, state);
  });
  const finish = (event) => {
    if (!origin) return;
    origin = null;
    try {
      if (overlay.hasPointerCapture?.(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    if (draft.crop) {
      draft.crop.left = Math.round(draft.crop.left);
      draft.crop.top = Math.round(draft.crop.top);
      draft.crop.width = Math.max(1, Math.round(draft.crop.width));
      draft.crop.height = Math.max(1, Math.round(draft.crop.height));
    }
    applyCropToDom(root);
    refreshLive(root, state);
  };
  overlay.addEventListener("pointerup", finish);
  overlay.addEventListener("pointercancel", finish);
}

function bindMask(root, state, api) {
  const media = root.querySelector("[data-media][data-paint]") || root.querySelector("[data-media]");
  const asset = currentAsset();
  if (!media || !asset || asset.kind === "tile_preview") return;
  if (currentStage(state).key !== "mask") return;
  const svg = media.querySelector("[data-mask-svg]");
  const cursor = media.querySelector("[data-brush]");
  const dims = currentDims(asset);
  if (!dims) return;

  const toPoint = (event) => {
    const rect = media.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * dims.width, 0, dims.width - 0.01),
      y: clamp(((event.clientY - rect.top) / rect.height) * dims.height, 0, dims.height - 0.01),
    };
  };
  const totalPoints = () => maskState.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
  const addPoint = (stroke, point) => {
    if (stroke.points.length >= MASK_MAX_POINTS || totalPoints() >= MASK_MAX_POINTS) return false;
    const x = Math.round(point.x * 10) / 10;
    const y = Math.round(point.y * 10) / 10;
    stroke.points.push({ x, y });
    if (svg) {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", String(x));
      dot.setAttribute("cy", String(y));
      dot.setAttribute("r", String(stroke.radius));
      dot.setAttribute("class", `wb-mask-dot${stroke.mode === "erase" ? " is-erase" : ""}`);
      svg.appendChild(dot);
    }
    return true;
  };
  const moveCursor = (event) => {
    if (!cursor) return;
    const point = toPoint(event);
    if (!point) {
      cursor.classList.remove("is-visible");
      return;
    }
    cursor.style.left = `${(point.x / dims.width) * 100}%`;
    cursor.style.top = `${(point.y / dims.height) * 100}%`;
    cursor.classList.add("is-visible");
  };

  media.addEventListener("pointermove", (event) => {
    moveCursor(event);
    if (!maskState.drawing) return;
    const point = toPoint(event);
    if (point) {
      addPoint(maskState.drawing, point);
      refreshLive(root, state);
    }
  });
  media.addEventListener("pointerleave", () => cursor?.classList.remove("is-visible"));
  media.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const point = toPoint(event);
    if (!point) return;
    if (totalPoints() >= MASK_MAX_POINTS) {
      api.toast(`最多 ${MASK_MAX_POINTS} 个采样点，请分多次提交。`, "warn");
      return;
    }
    const stroke = { mode: draft.maskMode, radius: brushRadius(), points: [] };
    maskState.strokes.push(stroke);
    maskState.drawing = stroke;
    addPoint(stroke, point);
    try {
      media.setPointerCapture?.(event.pointerId);
    } catch {
      /* ignore */
    }
    refreshLive(root, state);
    event.preventDefault();
  });
  const stop = (event) => {
    if (!maskState.drawing) return;
    maskState.drawing = null;
    try {
      if (media.hasPointerCapture?.(event.pointerId)) media.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    refreshLive(root, state);
  };
  media.addEventListener("pointerup", stop);
  media.addEventListener("pointercancel", stop);
}

/* ------------------------------------------------------------------ 任务动作 */

async function runCrop(api) {
  const asset = currentAsset();
  if (!asset) return;
  if (!isImageLike(asset)) {
    api.toast("当前资产不能作为裁切输入，请先选一张原图、规范输入或裁切图。", "warn");
    return;
  }
  const error = cropError();
  if (error) {
    api.toast(error, "warn");
    return;
  }
  const crop = draft.crop;
  const bbox = {
    left: Math.round(crop.left),
    top: Math.round(crop.top),
    right: Math.round(crop.left + crop.width),
    bottom: Math.round(crop.top + crop.height),
  };
  await startJob(api, () => http.crop({ input_asset_id: asset.asset_id, bbox }), (final) => {
    const produced = (final.result?.assets || []).find((entry) => entry.kind === "cropped") || final.result?.assets?.[0] || null;
    if (produced) {
      store.setCurrentAsset(produced.asset_id);
      ui.notice = `已生成裁切 ${dimsOf(produced)}，并设为当前资产。`;
      api.toast("裁切完成，已设为当前资产。", "done");
    } else {
      ui.notice = "裁切完成，但后端没有返回产物资产。";
    }
  });
}

async function runColorPipeline(api) {
  const asset = currentAsset();
  if (!asset) return;
  if (!isImageLike(asset)) {
    api.toast("当前资产不能作为颜色提取输入，请先选一张原图或裁切图。", "warn");
    return;
  }
  const extract = {
    mode: draft.extractMode,
    polarity: draft.polarity,
    threshold: Math.round(draft.threshold),
  };
  if (draft.extractMode === "grabcut") {
    const bbox = grabcutBbox();
    if (bbox) extract.bbox = bbox;
  }
  const vector = { mode: draft.vectorMode, max_colors: draft.colors, detail: draft.detail };
  const payload = {
    input_asset_id: asset.asset_id,
    recipe: "color",
    extract,
    vector,
    working_max_pixels: 1000000,
  };
  await startJob(api, () => http.pipeline(payload), (final) => {
    const produced = final.result?.assets || [];
    const transparent = produced.find((entry) => entry.kind === "transparent_png");
    if (transparent) store.setCurrentAsset(transparent.asset_id);
    const kinds = [...new Set(produced.map((entry) => kindLabel(entry.kind)))];
    ui.notice = `颜色提取完成：${kinds.join("、") || "无产物"}。${transparent ? "已把透明 PNG 设为当前资产。" : ""}`;
    api.toast("颜色提取完成。", "done");
  });
}

/**
 * 模型一键线稿请求体：input_asset_id + recipe:"model_lineart" + 可选 vector。
 * 模型路线直接处理输入，不携带 extract / enhance（后端会以 422 拒绝）。
 */
function buildModelLineartPayload(assetId, draftLike = {}) {
  const local = draftLike || {};
  return {
    input_asset_id: assetId,
    recipe: "model_lineart",
    vector: {
      mode: "monochrome",
      detail: local.detail || "medium",
    },
    working_max_pixels: 1000000,
  };
}

/**
 * 单独线稿请求体：只包含 input_asset_id 与 method。
 * method:"model" 时不能携带任何 OpenCV 选项（local/med/min_area 等）。
 */
function buildLineartPayload(assetId, draftLike = {}) {
  const local = draftLike || {};
  return {
    input_asset_id: assetId,
    method: local.lineMethod === "model" ? "model" : "opencv",
  };
}

/** 本地一键模型路线：recipe:"model_lineart"，任务依次发布 lineart PNG 与 SVG。 */
async function runModelLineart(api) {
  const asset = currentAsset();
  if (!asset) return;
  if (!isImageLike(asset)) {
    api.toast("当前资产不能作为模型线稿输入，请先选一张原图或裁切图。", "warn");
    return;
  }
  const payload = buildModelLineartPayload(asset.asset_id, draft);
  await startJob(api, () => http.pipeline(payload), (final) => {
    const produced = final.result?.assets || [];
    const png = produced.find((entry) => entry.kind === "lineart") || null;
    const svg = produced.find((entry) => entry.kind === "svg") || null;
    if (png) store.setCurrentAsset(png.asset_id);
    const kinds = [...new Set(produced.map((entry) => kindLabel(entry.kind)))];
    ui.notice = `模型一键线稿完成：${kinds.length ? `已生成 ${kinds.join("、")}` : "没有返回产物"}${
      png ? "，并把线稿 PNG 设为当前资产" : ""
    }。`;
    api.toast(png && svg ? "模型线稿已生成 PNG 与 SVG。" : "模型线稿任务完成。", "done");
  });
}

async function runLineart(api) {
  const asset = currentAsset();
  if (!asset) return;
  if (!isImageLike(asset)) {
    api.toast("当前资产不能作为线稿输入，请先选一张原图或裁切图。", "warn");
    return;
  }
  const method = draft.lineMethod === "model" ? "model" : "opencv";
  const payload = buildLineartPayload(asset.asset_id, draft);
  await startJob(api, () => http.lineart(payload), (final) => {
    const produced = (final.result?.assets || []).find((entry) => entry.kind === "lineart") || null;
    if (produced) {
      store.setCurrentAsset(produced.asset_id);
      ui.notice =
        method === "model"
          ? `模型线稿 PNG 已生成（${dimsOf(produced)}），已设为当前资产，可以继续矢量化。`
          : `OpenCV 线稿 PNG 已生成（${dimsOf(produced)}），已设为当前资产，可以继续矢量化。`;
      api.toast("线稿 PNG 已生成。", "done");
    } else {
      ui.notice = "线稿任务完成，但没有返回 PNG。";
    }
  });
}

async function runVectorize(api) {
  const asset = currentAsset();
  if (!asset) return;
  if (!isImageLike(asset)) {
    api.toast("当前资产不能作为矢量化输入，请先选一张 PNG。", "warn");
    return;
  }
  const payload = {
    input_asset_id: asset.asset_id,
    mode: draft.lineVectorMode,
    detail: draft.lineDetail,
    max_colors: draft.lineColors,
  };
  await startJob(api, () => http.vectorize(payload), (final) => {
    const produced = (final.result?.assets || []).find((entry) => entry.kind === "svg") || null;
    if (produced) {
      store.setCurrentAsset(produced.asset_id);
      ui.notice = `矢量化完成：${kindLabel(produced.kind)} ${formatBytes(produced.bytes)}，已设为当前资产。`;
      api.toast("矢量化完成。", "done");
    } else {
      ui.notice = "矢量化任务完成，但没有返回 SVG。";
    }
  });
}

async function runCandidate(api) {
  const normalized =
    (store.session.assets || []).find((entry) => entry.kind === "normalized_input") ||
    (currentAsset()?.kind === "normalized_input" ? currentAsset() : null);
  if (!normalized) {
    api.toast("云端候选需要规范输入，请先在 01 选择规范输入。", "warn");
    return;
  }
  if (!draft.consentUpload || !draft.consentCharge) {
    api.toast("请先勾选上传与计费两项同意。", "warn");
    return;
  }
  const payload = {
    input_asset_id: normalized.asset_id,
    consent_to_upload: true,
    consent_to_charge: true,
    size: draft.candSize,
    vector: { mode: "color", max_colors: draft.candColors, detail: draft.candDetail },
  };
  const wrap = http.aiPipeline(payload).then((flow) => ({ ...flow, job_id: flow?.decomposition_job_id || flow?.job_id || "" }));
  cand.layers = [];
  cand.selected = [];
  cand.error = "";
  await startJob(api, () => wrap, (final) => {
    ui.notice = "云端候选层已生成，请勾选要合成的层。";
    api.toast("候选层已生成。", "done");
    fetchLayers(api, final.job_id);
  });
}

async function composeLayers(api) {
  if (!cand.layers.length || !cand.selected.length) {
    api.toast("至少选一层候选才能合成。", "warn");
    return;
  }
  const payload = {
    decomposition_job_id: cand.jobId,
    layer_ids: cand.selected.slice(),
    vector: { mode: "color", max_colors: draft.candColors, detail: draft.candDetail },
  };
  await startJob(api, () => http.composeLayers(payload), (final) => {
    const produced = (final.result?.assets || []).find((entry) => entry.kind === "composed_candidate");
    if (produced) store.setCurrentAsset(produced.asset_id);
    ui.notice = "候选合成本地完成，已把合成候选设为当前资产。";
    api.toast("候选合成完成。", "done");
  });
}

async function runMask(api) {
  const error = maskError();
  if (error) {
    api.toast(error, "warn");
    return;
  }
  const source = maskSource();
  const strokes = maskState.strokes
    .filter((stroke) => stroke.points.length)
    .map((stroke) => ({
      mode: stroke.mode,
      radius: clamp(Math.round(stroke.radius), 1, 128),
      points: stroke.points.map((point) => ({ x: point.x, y: point.y })),
    }));
  const payload = {
    source_rgb_asset_id: source.sourceId,
    base_mask_asset_id: source.maskId,
    algorithm: "brush",
    strokes,
  };
  await startJob(api, () => http.refineMask(payload), (final) => {
    const produced = final.result?.assets || [];
    const transparent = produced.find((entry) => entry.kind === "transparent_png");
    if (transparent) store.setCurrentAsset(transparent.asset_id);
    resetMaskStrokes();
    ui.notice = `蒙版修正完成：${produced.filter((entry) => entry.kind === "transparent_png").length ? "已生成新的透明 PNG 并设为当前资产。" : "已写入新的蒙版资产。"}`;
    api.toast("蒙版修正完成。", "done");
  });
}

async function runRepair(api) {
  const input = repairInputAsset();
  if (!input || input.kind !== "normalized_input") {
    api.toast("局部修复需要规范输入，请先在 01 把规范输入设为当前资产。", "warn");
    return;
  }
  if (!draft.repairConsentUpload || !draft.repairConsentCharge) {
    api.toast("请先勾选上传与计费两项同意。", "warn");
    return;
  }
  const dims = currentDims(input);
  const box = draft.repair;
  if (!dims || !box) {
    api.toast("请设置修复区域。", "warn");
    return;
  }
  const left = Math.round(box.left);
  const top = Math.round(box.top);
  const right = Math.min(dims.width, Math.round(box.left + box.width));
  const bottom = Math.min(dims.height, Math.round(box.top + box.height));
  if (right <= left || bottom <= top) {
    api.toast("修复区域必须是正面积。", "warn");
    return;
  }
  const payload = {
    input_asset_id: input.asset_id,
    bbox: { left, top, right, bottom },
    intent: draft.repairIntent,
    feather_px: Math.round(draft.repairFeather),
    size: draft.repairSize,
    consent_to_upload: true,
    consent_to_charge: true,
  };
  await startJob(api, () => http.repair(payload), (final) => {
    repairState.info = null;
    repairState.error = "";
    ui.notice = "修复候选已生成，请选择接受或拒绝。";
    api.toast("修复候选已生成。", "done");
    fetchRepair(api, final.job_id);
  });
}

/** 采纳已接受的修复资产：只有读取并写入会话成功才提示“可用于平铺/导出”。 */
async function adoptRepairAsset(api, info, token) {
  const result = await store.adoptAcceptedRepair(info, token);
  if (!store.isSessionCurrent(token)) return result;
  if (result.status === "adopted" || result.status === "already_present") {
    if (result.asset) store.setCurrentAsset(result.asset.asset_id);
    ui.notice = "已接受这次修复，修复结果已加入会话资产，可用于平铺与导出。";
    api.toast("已接受修复，已加入会话资产。", "done");
  } else if (result.status === "fetch_failed") {
    // 接受记录已在服务端，但资产还没读进会话：不能声称已可用。
    ui.notice = "已记录接受，但修复资产尚未加载成功；请刷新页面或到纹样库重试。";
    api.toast(ui.notice, "warn");
  } else if (result.status === "no_accepted_asset") {
    ui.notice = "已记录接受，但返回信息里没有新资产 id；请刷新或到纹样库查看。";
    api.toast(ui.notice, "warn");
  }
  return result;
}

async function decideRepair(api, action, assetId = "", full = false) {
  const info = repairState.info;
  if (!info) return;
  if (action === "accept" && full && !draft.acceptFull) {
    api.toast("接受全图候选前，请先勾选确认它可能改变整个画面。", "warn");
    return;
  }
  // 修复决定属于当前会话；网络返回前会话切换了就不再写任何界面状态。
  const token = store.sessionToken();
  const jobId = info.repair_job_id || info.job_id || cand.jobId || "";
  const payload = {
    revision: info.revision,
    action,
    ...(action === "accept" ? { selected_asset_id: assetId, accept_full_image_changes: Boolean(full && draft.acceptFull) } : {}),
  };
  let next = null;
  try {
    next = await http.repairDecision(jobId, payload);
  } catch (error) {
    if (!store.isSessionCurrent(token)) return;
    if (error?.code === "STALE_REVISION") {
      repairState.error = "修复记录已更新，正在重新读取…";
      api.toast(repairState.error, "warn");
      const fresh = await fetchRepair(api, jobId, token);
      if (!fresh || !store.isSessionCurrent(token)) return;
      if (fresh.decision?.action === "accept") {
        // 重复点击或另一处已接受：按 accepted_asset_id 幂等补齐，不重复添加资产。
        repairState.error = "";
        await adoptRepairAsset(api, fresh, token);
      } else if (fresh.decision?.action === "reject") {
        repairState.error = "";
        ui.notice = "这次修复之前已被拒绝；没有生成新资产，原有结果保留。";
        api.toast(ui.notice, "info");
      }
      repaintIfHere(api);
      return;
    }
    repairState.error = errorText(error);
    api.toast(repairState.error, "warn");
    repaintIfHere(api);
    return;
  }
  if (!store.isSessionCurrent(token)) return;
  repairState.info = next;
  repairState.error = "";
  if (action === "reject") {
    ui.notice = "已拒绝这次修复；没有生成新资产，原有结果保留。";
    api.toast(ui.notice, "info");
    repaintIfHere(api);
    return;
  }
  repairState.loading = true;
  repaintIfHere(api);
  await adoptRepairAsset(api, next, token);
  if (!store.isSessionCurrent(token)) return;
  repairState.loading = false;
  repaintIfHere(api);
  store.loadRecent();
}

async function saveSeam(api) {
  const asset = tilePreviewFor(tileUnit()?.asset_id || "", tileN(api.state)) || tilePreviewLatest();
  if (!asset) {
    api.toast("先生成平铺预览，再记录接缝观察。", "warn");
    return;
  }
  const revision = asset.seam_observation_revision ?? 0;
  try {
    const updated = await http.seamObservation(asset.asset_id, {
      seam_observation: draft.seam || "not_reviewed",
      revision,
    });
    const index = store.session.assets.findIndex((entry) => entry.asset_id === updated.asset_id);
    if (index >= 0) store.session.assets[index] = updated;
    store.notify("session");
    draft.seam = updated.seam_observation;
    ui.notice = `接缝观察已保存为「${SEAM_LABELS[updated.seam_observation] || updated.seam_observation}」。`;
    api.toast(ui.notice, "done");
    repaintIfHere(api);
  } catch (error) {
    if (error?.code === "STALE_SEAM_OBSERVATION" || error?.code === "SEAM_OBSERVATION_CONFLICT") {
      ui.notice = "";
      try {
        const fresh = await http.asset(asset.asset_id);
        const index = store.session.assets.findIndex((entry) => entry.asset_id === fresh.asset_id);
        if (index >= 0) store.session.assets[index] = fresh;
        store.notify("session");
      } catch {
        /* 读取失败时保留提示 */
      }
      api.toast("接缝记录已被更新，已重新读取资产，请再保存一次。", "warn");
      repaintIfHere(api);
    } else {
      ui.error = errorText(error);
      api.toast(ui.error, "warn");
      repaintIfHere(api);
    }
  }
}

async function runTile(api) {
  const unit = tileUnit();
  if (!unit) {
    api.toast("没有可平铺的单元。", "warn");
    return;
  }
  const n = tileN(api.state);
  const payload = {
    unit_asset_id: unit.asset_id,
    rows: n,
    cols: n,
    seam_observation: draft.seam || "not_reviewed",
  };
  await startJob(api, () => http.tilePreview(payload), (final) => {
    const produced = (final.result?.assets || []).find((entry) => entry.kind === "tile_preview");
    if (produced) {
      store.setCurrentAsset(produced.asset_id);
      ui.notice = `平铺预览已生成：${n} × ${n}，${dimsOf(produced)}，已设为当前资产。`;
      api.toast("平铺预览已生成。", "done");
    } else {
      ui.notice = "平铺任务完成，但没有返回预览资产。";
    }
  });
}

async function runExport(api) {
  const selection = exportSelection();
  if (!selection.length) {
    api.toast("至少勾选一个资产再导出。", "warn");
    return;
  }
  if (!draft.licenseAck) {
    api.toast("请先勾选「许可证已确认」。", "warn");
    return;
  }
  ui.lastExport = null;
  const payload = { asset_ids: selection.slice(0, 24), license_acknowledged: true };
  await startJob(api, () => http.exportAssets(payload), (final) => {
    const zip = (final.result?.assets || []).find((entry) => entry.kind === "zip") || null;
    if (zip) {
      ui.lastExport = zip;
      ui.notice = `导出完成：${selection.length} 个资产，ZIP ${formatBytes(zip.bytes)}。`;
      api.toast("导出完成，可下载 ZIP。", "done");
    } else {
      ui.notice = "导出任务完成，但没有返回 ZIP 资产。";
    }
  });
}

/* ------------------------------------------------------------------ 顶层点击 / 输入 */

function handleClick(root, state, api, event) {
  const segBtn = event.target.closest("[data-seg]");
  if (segBtn && root.contains(segBtn)) {
    handleSeg(root, state, api, segBtn);
    return;
  }
  const switchBtn = event.target.closest("[data-switch]");
  if (switchBtn && root.contains(switchBtn)) {
    if (switchBtn.dataset.switch === "seamGrid") {
      patchStage(api, root, { seam: !state.seam });
    }
    return;
  }
  const el = event.target.closest("[data-act]");
  if (!el || !root.contains(el)) return;
  if (el.disabled) return;
  const act = el.dataset.act;
  const stage = currentStage(state);

  switch (act) {
    case "stage":
      stageClick(root, api, el);
      break;
    case "asset":
      switchAsset(api, root, el.dataset.id);
      break;
    case "prev-asset":
      cycleAsset(root, api, -1);
      break;
    case "next-asset":
      cycleAsset(root, api, 1);
      break;
    case "zoom":
      patchStage(api, root, { zoom: el.dataset.val === "fit" ? "fit" : Number(el.dataset.val) });
      break;
    case "compare": {
      const info = compareInfo(stage);
      if (!info.ok) {
        api.toast(info.reason, "warn");
        break;
      }
      const next = !state.compare;
      patchStage(api, root, { compare: next });
      api.toast(next ? "对比已开：左原件 / 右当前资产" : "对比已关", "info");
      break;
    }
    case "panel-toggle": {
      const panel = root.querySelector("[data-panel]");
      if (!panel) return;
      const collapsed = panel.classList.toggle("is-collapsed");
      panelPref = collapsed ? "closed" : "open";
      const toggle = panel.querySelector("[data-act='panel-toggle']");
      if (toggle) toggle.setAttribute("aria-expanded", String(!collapsed));
      const label = panel.querySelector("[data-live='panel-toggle-label']");
      if (label) label.textContent = collapsed ? "展开参数" : "收起";
      applyZoom(root, state);
      break;
    }
    case "upload":
      document.querySelector('[data-action="upload"]')?.click();
      break;
    case "library":
      api.go("library");
      break;
    case "settings":
      api.go("settings");
      break;
    case "go-export":
      patchStage(api, root, { stage: 7 });
      api.toast("在 07 勾选要导出的资产，并勾选许可证确认。", "info");
      break;
    case "use-asset":
      switchAsset(api, root, el.dataset.id);
      break;
    case "reset-crop":
      draft.crop = null;
      draft.cropPreset = "original";
      applyCropPreset(root, "original");
      repaint(root, api);
      break;
    case "apply-crop":
      runCrop(api);
      break;
    case "run-color":
      runColorPipeline(api);
      break;
    case "run-model-lineart":
      runModelLineart(api);
      break;
    case "run-lineart":
      runLineart(api);
      break;
    case "run-vectorize":
      runVectorize(api);
      break;
    case "run-candidate":
      runCandidate(api);
      break;
    case "compose-layers":
      composeLayers(api);
      break;
    case "run-mask":
      runMask(api);
      break;
    case "undo-stroke": {
      const removed = maskState.strokes.pop();
      if (!removed) {
        api.toast("没有可撤销的笔画。", "info");
        break;
      }
      repaint(root, api);
      break;
    }
    case "run-repair":
      runRepair(api);
      break;
    case "accept-repair":
      decideRepair(api, "accept", el.dataset.id, el.dataset.full === "1");
      break;
    case "reject-repair":
      decideRepair(api, "reject");
      break;
    case "run-tile":
      runTile(api);
      break;
    case "save-seam":
      saveSeam(api);
      break;
    case "run-export":
      runExport(api);
      break;
    case "cancel":
      cancelActive(api);
      break;
    case "retry-session":
      if (expectedImage) {
        const token = store.sessionToken();
        ui.sessionError = "";
        store
          .ensureSession(expectedImage)
          .then((session) => {
            // 被更新的加载取代时 ensureSession 返回 null：不重绘、不报错。
            if (session) repaintIfHere(api);
          })
          .catch((error) => {
            if (!store.isSessionCurrent(token)) return;
            ui.sessionError = error?.message || "读取纹样失败。";
            repaintIfHere(api);
          });
      }
      break;
    case "layer": {
      const id = el.dataset.id;
      cand.selected = cand.selected.includes(id)
        ? cand.selected.filter((item) => item !== id)
        : [...cand.selected, id];
      repaint(root, api);
      break;
    }
    default:
      break;
  }
}

function setCropFromField(key, value) {
  const dims = currentDims();
  const crop = draft.crop;
  if (!dims || !crop) return;
  const mapping = { cropLeft: "left", cropTop: "top", cropWidth: "width", cropHeight: "height" };
  const prop = mapping[key];
  if (!prop) return;
  let numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return;
  if (prop === "left") numeric = clamp(numeric, 0, dims.width - 1);
  if (prop === "top") numeric = clamp(numeric, 0, dims.height - 1);
  if (prop === "width") numeric = clamp(numeric, 1, dims.width - crop.left);
  if (prop === "height") numeric = clamp(numeric, 1, dims.height - crop.top);
  crop[prop] = numeric;
  if (crop.left + crop.width > dims.width) crop.width = dims.width - crop.left;
  if (crop.top + crop.height > dims.height) crop.height = dims.height - crop.top;
}

function setRepairFromField(key, value) {
  const input = repairInputAsset();
  const dims = currentDims(input);
  const box = draft.repair;
  if (!dims || !box) return;
  const mapping = { repairLeft: "left", repairTop: "top", repairWidth: "width", repairHeight: "height" };
  const prop = mapping[key];
  if (!prop) return;
  let numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return;
  if (prop === "left") numeric = clamp(numeric, 0, dims.width - 1);
  if (prop === "top") numeric = clamp(numeric, 0, dims.height - 1);
  if (prop === "width") numeric = clamp(numeric, 1, dims.width - box.left);
  if (prop === "height") numeric = clamp(numeric, 1, dims.height - box.top);
  box[prop] = numeric;
  if (box.left + box.width > dims.width) box.width = dims.width - box.left;
  if (box.top + box.height > dims.height) box.height = dims.height - box.top;
}

function handleInput(root, state, api, event) {
  const input = event.target;
  if (input.matches("[data-range]")) {
    const key = input.dataset.range;
    const value = Number(input.value);
    if (key === "maskRadius") {
      api.set({ brush: value });
      const cursor = root.querySelector("[data-brush]");
      const asset = currentAsset();
      if (cursor && asset) {
        cursor.style.width = `${((value * 2) / Math.max(1, asset.width)) * 100}%`;
        cursor.style.height = `${((value * 2) / Math.max(1, asset.height)) * 100}%`;
      }
      const label = root.querySelector("[data-out='maskRadius']");
      if (label) label.textContent = String(Math.round(value));
    } else if (key === "threshold") {
      draft.threshold = value;
      const out = root.querySelector("[data-out='threshold']");
      if (out) out.textContent = String(Math.round(value));
    } else if (key === "repairFeather") {
      draft.repairFeather = value;
      const out = root.querySelector("[data-out='repairFeather']");
      if (out) out.textContent = String(Math.round(value));
    }
    input.style.setProperty("--range-fill", `${(((value - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100).toFixed(1)}%`);
    refreshLive(root, state);
    return;
  }
  if (input.matches("[data-field]")) {
    if (String(input.value).trim() === "") return;
    const key = input.dataset.field;
    if (key.startsWith("crop")) {
      setCropFromField(key, input.value);
      applyCropToDom(root);
    } else if (key.startsWith("repair")) {
      setRepairFromField(key, input.value);
      applyRepairToDom(root);
    }
    refreshLive(root, state);
  }
}

function handleChange(root, state, api, event) {
  const input = event.target;
  if (input.matches("[data-check]")) {
    patchCheckbox(root, state, api, input.dataset.check, input.checked);
    return;
  }
  if (input.matches("[data-export]")) {
    const id = input.dataset.export;
    const selection = new Set(exportSelection());
    if (input.checked) selection.add(id);
    else selection.delete(id);
    draft.exportIds = [...selection];
    draft.exportInit = true;
    repaint(root, api);
    return;
  }
  const select = input.closest("[data-select]");
  if (!select) return;
  const key = select.dataset.select;
  const value = select.value;
  switch (key) {
    case "extractMode":
      draft.extractMode = value;
      break;
    case "candSize":
      draft.candSize = value;
      break;
    case "repairSize":
      draft.repairSize = value;
      break;
    case "tileUnit":
      draft.tileUnitId = value;
      draft.tileUnitTouched = true;
      break;
    default:
      break;
  }
  repaint(root, api);
}

/* ------------------------------------------------------------------ 缩放 */

function applyZoom(root, state) {
  const viewport = root.querySelector("[data-canvas]");
  const frame = root.querySelector("[data-frame]");
  if (!viewport || !frame) return;
  const mode = zoomMode(state);
  let scale = 1;
  if (mode === "fit") {
    const rect = viewport.getBoundingClientRect();
    const available = Math.min(rect.width - CANVAS_PAD, rect.height - CANVAS_PAD);
    scale = clamp(available / UNIT, MIN_SCALE, MAX_SCALE);
  } else if (mode === "2") {
    scale = 2;
  }
  frame.style.setProperty("--wb-scale", scale.toFixed(3));
}

function syncPanel(root) {
  const panel = root.querySelector("[data-panel]");
  if (!panel) return;
  const collapsed = panelCollapsed();
  panel.classList.toggle("is-collapsed", collapsed);
  const toggle = panel.querySelector("[data-act='panel-toggle']");
  if (toggle) toggle.setAttribute("aria-expanded", String(!collapsed));
  const label = panel.querySelector("[data-live='panel-toggle-label']");
  if (label) label.textContent = collapsed ? "展开参数" : "收起";
}

/* ------------------------------------------------------------------ 视图模块 */

export default {
  id: "workbench",
  title: "工作台",
  flush: true,

  render(state, api, params) {
    viewState = state;
    expectedImage = params?.get?.("image") || "";
    syncDrafts(state);
    const stage = currentStage(state);
    return `
    <div class="wb" data-stage="${stage.key}">
      ${railHtml(state)}
      ${mainHtml(stage, state)}
      ${panelHtml(stage, state)}
    </div>`;
  },

  mount(root, state, api, params) {
    const wb = root.querySelector(".wb");
    if (!wb) return;

    wb.addEventListener("click", (event) => handleClick(wb, state, api, event));
    wb.addEventListener("input", (event) => handleInput(wb, state, api, event));
    wb.addEventListener("change", (event) => handleChange(wb, state, api, event));

    bindCompare(wb, api);
    bindCrop(wb, state, api);
    bindMask(wb, state, api);

    const want = params?.get?.("image") || "";
    if (want && store.session.imageId !== want) {
      ui.sessionError = "";
      if (sessionTimer) window.clearTimeout(sessionTimer);
      sessionTimer = window.setTimeout(() => {
        if (store.session.imageId !== want) {
          ui.sessionError = "读取纹样超时。请重试，或重新上传一张。";
          repaintIfHere(api);
        }
      }, 8000);
    }
    // app.applyParams loads deep-link assets once when the URL changes.
    // Repainting must preserve the user's selection and newly adopted results.

    lastHealthCapability = healthCapabilitySignature();
    unsubscribe = store.subscribe((reason) => {
      if (reason === "health") {
        // 30 秒 health 轮询只在模型能力真的变化时重绘；不重置 draft 里的用户选择。
        const signature = healthCapabilitySignature();
        if (signature === lastHealthCapability) return;
        lastHealthCapability = signature;
        repaintIfHere(api);
        return;
      }
      if (!["session", "job-start", "job-end", "settings", "seedream"].includes(reason)) return;
      repaintIfHere(api);
    });

    syncPanel(wb);
    applyZoom(wb, state);
    restoreScroll(wb);
    restoreFocus(wb);
    requestAnimationFrame(() => {
      if (wb.isConnected) applyZoom(wb, state);
    });

    resizeHandler = () => {
      const live = document.querySelector(".wb");
      if (!live) return;
      syncPanel(live);
      applyZoom(live, state);
    };
    window.addEventListener("resize", resizeHandler, { passive: true });

    if (typeof ResizeObserver === "function") {
      canvasObserver = new ResizeObserver(() => {
        const live = document.querySelector(".wb");
        if (live) applyZoom(live, state);
      });
      const canvas = wb.querySelector("[data-canvas]");
      if (canvas) canvasObserver.observe(canvas);
    }
  },

  unmount() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (resizeHandler) window.removeEventListener("resize", resizeHandler);
    resizeHandler = null;
    if (canvasObserver) canvasObserver.disconnect();
    canvasObserver = null;
    if (sessionTimer) window.clearTimeout(sessionTimer);
    sessionTimer = null;
    scrollMemo = null;
    focusMemo = null;
  },
};

/* 供 node:test 直接导入的行为纯函数；默认导出保持不变。 */
export { buildLineartPayload, buildModelLineartPayload, taskOutcomeCopy };

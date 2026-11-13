/* =============================================================================
   views/workbench.js — 工作台：三栏（文档/工序/资产 · 纸本图版 · 本工序参数）
   数据全部来自本机 /api/v1：
   - 会话（图片、资产、任务）在 store.js，头像用 http.assetPreviewUrl，下载用
     http.assetDownloadUrl；本视图只读 store，不自己持有服务端数据副本。
   - 八道工序：01 来源、02 裁切、03 修复（可跳过）、04 候选、05 处理（本地/云端
     线稿、OpenCV、颜色提取）、06 蒙版、07 矢量化、08 平铺与导出。任务统一经
     store.runJob 提交并轮询，期间维护 busy 与产物资产。
   - 修复排在线稿提取之前；完整纹样可明确跳过修复。矢量化从提取中分离，蒙版修改
     完再矢量化，平铺/导出最后。云端线稿只生成 lineart PNG，不自动矢量化。
   - 未提交的界面参数（选区、阈值、笔迹、同意项、导出勾选等）放在模块内 draft，
     api.patch / api.refresh 重绘后仍在；高频输入用局部 DOM 更新。
   - 云端未配置时（store.seedream.enabled === false）新的生成入口受门禁约束；
     已归档的候选仍可读取、选层并本地合成/重合成；本地路线始终可用。
   本视图不直接持有服务端数据副本；共享请求与枚举在 store.js / api.js / format.js。
   ============================================================================= */

import { STAGES } from "../data.js";
import { icon } from "../icons.js";
import { store } from "../store.js";
import { api as http } from "../api.js";
import {
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
  stageForJobKind,
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
/** 本机 RGB/RGBA 输入资产类型（裁切/提取/线稿/矢量化的合法输入）。
 *  未接受的修复候选（edit_candidate 等）不在此列：它们只能看/下载，不能继续当输入。 */
const RGB_KINDS = new Set([
  "normalized_input",
  "cropped",
  "working_copy",
  "prepared",
  "enhanced",
  "transparent_png",
  "lineart",
  "composed_candidate",
  "accepted_repair",
]);
/**
 * 云端输入白名单，与后端 services/provider_validation.py 的 PROVIDER_INPUT_KINDS 一致。
 * 修复、候选与云端线稿都只接受这些类型；未接受的 edit_candidate / repair_composite
 * 不在后端白名单里，前端也不把它们当输入。
 */
const CLOUD_INPUT_KINDS = new Set([
  "normalized_input",
  "cropped",
  "working_copy",
  "prepared",
  "enhanced",
  "accepted_repair",
  "composed_candidate",
  "transparent_png",
]);
const CLOUD_INPUT_MIN_PIXELS = 262_144;
const CLOUD_INPUT_MAX_PIXELS = 25_000_000;
const CLOUD_INPUT_ASPECT_MIN = 1 / 16;
const CLOUD_INPUT_ASPECT_MAX = 16;
/** 矢量化输入：只接受流程产出的 PNG / 已接受修复 / 候选合成；未接受候选不在此列。 */
const VECTOR_INPUT_KINDS = new Set(["lineart", "transparent_png", "accepted_repair", "composed_candidate"]);
/** 有预览图的资产类型；ZIP 只给下载链接 */
const NO_PREVIEW_KINDS = new Set(["zip", "export", "archive"]);
/** 后端局部修复的输入上限（与 finishing_workbench.MAX_REPAIR_PIXELS 一致）。 */
const REPAIR_MAX_PIXELS = 1_048_576;

const STAGE_COPY = {
  source: { title: "放入纹样", note: "原件与规范输入各留一份", desc: "原件只用于对照与重新导出，后续工序产出的是新资产。" },
  crop: { title: "框定纹样", note: "坐标使用当前资产真实像素", desc: "在纸面上拖框，或直接填写像素坐标。right / bottom 是开区间终点。" },
  repair: { title: "局部修复", note: "可跳过；完整纹样直接下一步", desc: "框出问题区域，云端返回修复候选；接受或拒绝都在右侧完成。纹样完整时可明确跳过。" },
  candidate: { title: "选候选层", note: "按提示词拆分（可选）", desc: "云端按层拆分，勾选后合成一张候选；这一步不生成线稿。" },
  process: { title: "生成线稿", note: "本地模型 / 云端模型", desc: "明确选择本地模型或云端模型；也可以改用 OpenCV 或颜色提取。这里只出 PNG，矢量化在 07。" },
  mask: { title: "修正前景", note: "只改透明 PNG", desc: "在源图上补前景或擦除杂点；修正完成后再到 07 矢量化。" },
  vector: { title: "转成矢量", note: "PNG → SVG", desc: "把线稿或透明 PNG 转成可编辑 SVG；颜色与细节在这一步调整。" },
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
  continuing: "继续处理",
  decomposing: "云端拆分中",
  rejected: "已拒绝",
};

const JOB_STEP_LABELS = {
  crop: "裁切",
  "working-copy": "工作副本",
  "working_copy": "工作副本",
  extract: "前景提取",
  enhance: "轻增强",
  prepare: "图像准备",
  lineart: "线稿",
  "cloud-lineart": "云端线稿",
  cloud_lineart: "云端线稿",
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
  WORKER_MEMORY_LIMIT: "本机处理达到内存上限：请换更小的图，或在 07 降低矢量化细节。",
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
  PROVIDER_DISABLED: "云端尚未就绪，请先在设置里完成 API Key 与调用许可。",
  PROVIDER_INPUT_KIND: "云端这一步需要接口支持的输入类型；请先切换到规范输入、裁切图、工作副本、候选合成、透明 PNG、轻增强或已接受修复。",
  PROVIDER_INPUT_DIMENSIONS: "输入的像素或长宽比不在云端允许范围内。",
  NORMALIZED_TOO_LARGE: "云端输入文件超过 20 MB；请先创建工作副本或压缩后再上传。",
  CLOUD_LINEART_DISABLED: "云端线稿未启用：请先在设置里完成云端配置。",
  CLOUD_LINEART_INPUT: "当前资产不能作为云端线稿输入，请切换为规范输入、裁切图、工作副本、候选合成或透明 PNG。",
  CLOUD_LINEART_PIXELS: "云端线稿要求 262,144–25,000,000 像素；当前图不符合，请先裁切或创建工作副本。",
  CLOUD_LINEART_NOT_READY: "云端线稿尚未返回可用结果；不会自动重发，请到任务记录核对。",
  CLOUD_LINEART_FAILED: "云端线稿没有完成；请核对已有调用，不会自动重发。",
  LAYERS_NOT_READY: "云端拆分还没有成功完成，暂时不能选层。",
  QUEUE_FULL: "任务队列已满，请稍后再试。",
  RETRY_NOT_ALLOWED: "只有失败的本机任务才能重试。",
  PAID_RETRY_REQUIRES_NEW_CONSENT: "云端调用需要重新确认后才能重试。",
  LINEART_MODEL_UNAVAILABLE: "模型线稿不可用：模型权重/配置缺失、校验未通过，或运行依赖不可用（torch、图像分割与骨干模型库）；可改用 OpenCV 路线，或按 README 检查模型环境。",
  LINEART_MODEL_GPU_OOM: "显存不足，释放竞争 GPU 任务后重试。",
  LOCAL_REQUEST_HEADER_REQUIRED: "请求缺少本机写标记，请刷新页面后重试。",
  NOT_FOUND: "没有找到对应的资产或任务。",
  INVALID_REQUEST: "参数没有通过接口校验，请检查填写内容。",
  INTERNAL_ERROR: "本机服务内部出错。",
};

/* ------------------------------------------------------------------ 模块状态 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const esc = (value) => escapeHtml(value);
const mono = (value) => `<span class="mono">${esc(value)}</span>`;

function defaultDraft() {
  return {
    crop: null,
    cropPreset: "original",
    /* 05 处理：明确选择本地模型 / 云端模型；OpenCV 与颜色提取是传统算法路线。 */
    processRoute: "local",
    extractMode: "otsu",
    polarity: "dark",
    threshold: 127,
    colors: 4,
    detail: "medium",
    vectorMode: "color",
    candSize: "1K",
    candColors: 4,
    candDetail: "low",
    cloudConsentUpload: false,
    cloudConsentCharge: false,
    consentUpload: false,
    consentCharge: false,
    maskMode: "add",
    repair: null,
    repairIntent: "restore_small_gap",
    repairFeather: 0,
    repairSize: "1K",
    repairConsentUpload: false,
    repairConsentCharge: false,
    repairSkipped: false,
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

const cand = {
  flow: null,
  flowId: "",
  jobId: "",
  layers: [],
  selected: [],
  loading: false,
  restoring: false,
  error: "",
  /* 用户在当前流程里亲手改过勾选后，旧的异步恢复不得再用流程快照覆盖。 */
  selectionTouched: false,
};
const repairState = { info: null, loading: false, error: "" };
const maskState = { strokes: [], drawing: null };

/** 供回归测试读取任务条状态；不暴露可变对象。 */
export function taskUiState() {
  return { running: ui.running, jobId: ui.jobId, jobStage: ui.jobStage, job: ui.job };
}

let viewState = null;
let expectedImage = "";
let lastCurrentId = "";
let lastImageId = "";
let lastSessionToken = null;
let lastHealthCapability = "";
let panelPref = null;
let lastRestoredFlowKey = "";
let lastRestoredRepairKey = "";
/* 修复记录里的旧框：等当前资产切到记录中的 input_asset 后再套用，避免坐标错位。 */
let pendingRepairBox = null;
/* 任务归属：旧会话任务结束时只清理自己留下的 busy，不碰新会话已启动的任务。 */
let activeJobToken = null;
/* 同一 DOM 只挂一次事件与订阅；重复 mount 不再重复绑定点击处理。 */
let mountedRoot = null;
/* 候选层请求序号：较旧的异步响应不能覆盖较新的层列表。 */
let layersRequestSeq = 0;
/* 折叠的资产分组（key = 工序号）与上一次滚动定位到的资产 */
const collapsedGroups = new Set();
let lastRevealedId = "";
/* 切换当前资产后由 revealCurrentThumb 决定缩略图区滚动位置，重绘时不再恢复旧值 */
let filmRestoreSkip = false;
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
  dependencies_missing: "缺少模型运行依赖（torch、图像分割与骨干模型库，详见 README）。",
  model_files_missing: "模型权重或配置文件尚未安装（model/model.pt、model/inference.json）。",
  model_config_invalid: "模型配置与推理规格不一致，请检查 model/inference.json。",
  model_check_failed: "模型前置检查执行失败，暂时无法判断模型是否可用。",
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
    return "前置检查通过：模型文件与依赖已就绪。";
  }
  if (cap.available === false) {
    return LINEART_REASON_TEXT[cap.reason] || "模型前置检查未通过。";
  }
  return "模型能力未知：后端没有返回该能力，或健康检查暂时读取失败。";
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
    crop: hasKind("cropped", "working_copy") || hasJob("crop", "working-copy"),
    /* 修复可跳过：跳过也算这一道“已处理”，但不产生调用和资产。 */
    repair: hasKind("accepted_repair", "repair_composite") || hasJob("repair") || Boolean(draft.repairSkipped),
    candidate:
      hasKind("composed_candidate", "generated_layer", "placed_generated_layer", "ai_layer") ||
      hasJob("decompose-layers", "compose-layers", "ai-pipeline"),
    process:
      hasKind("lineart", "transparent_png", "foreground_mask") ||
      hasJob("lineart", "cloud-lineart", "extract", "pipeline"),
    mask: refined || hasJob("refine-mask"),
    vector: hasKind("svg") || hasJob("vectorize"),
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
    cand.flow = null;
    cand.flowId = "";
    cand.layers = [];
    cand.selected = [];
    cand.loading = false;
    cand.restoring = false;
    cand.error = "";
    cand.selectionTouched = false;
    repairState.info = null;
    repairState.loading = false;
    repairState.error = "";
    resetMaskStrokes();
    resetCandidateConsent();
    resetRepairConsent();
    resetCloudConsent();
    draft.repairSkipped = false;
    lastRestoredRepairKey = "";
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
    cand.flow = null;
    cand.flowId = "";
    cand.layers = [];
    cand.selected = [];
    cand.error = "";
    cand.selectionTouched = false;
    resetCandidateConsent();
    resetRepairConsent();
    resetCloudConsent();
    draft.repairSkipped = false;
    lastRestoredRepairKey = "";
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
    if (asset && pendingRepairBox && pendingRepairBox.assetId === id) {
      draft.repair = { ...pendingRepairBox.box };
      pendingRepairBox = null;
    }
    resetMaskStrokes();
    resetCandidateConsent();
    resetRepairConsent();
    resetCloudConsent();
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
    ${ui.running ? `<p class="field__hint">任务已提交，可在下方取消。</p>` : ""}
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
  return `
  <div class="wb-disabled">
    <div class="wb-disabled__head"><span class="chip chip--gold">${icon("cloud")}云端未启用</span></div>
    <p class="wb-disabled__text">这一步需要云端模型。请到设置里完成云端配置后再试。</p>
    <button class="btn btn--ghost btn--sm btn--block" type="button" data-act="settings">${icon("gear")}去设置</button>
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

/* ------------------------------------------------------------------ 资产分组 */

/** 资产类型 → 生成它的工序号；会话里还留着对应任务时以任务类型为准（如 06 蒙版也产出透明 PNG）。 */
const KIND_STAGE = {
  original: 1,
  normalized_input: 1,
  cropped: 2,
  working_copy: 2,
  prepared: 2,
  enhanced: 2,
  repair_composite: 3,
  edit_candidate: 3,
  edit_mask: 3,
  blend_weight: 3,
  difference_map: 3,
  damage_mask: 3,
  repair_candidate: 3,
  accepted_repair: 3,
  generated_basemap: 4,
  generated_layer: 4,
  placed_generated_layer: 4,
  ai_layer: 4,
  composed_candidate: 4,
  foreground_mask: 5,
  transparent_png: 5,
  lineart: 5,
  contour_line_art: 5,
  svg: 7,
  tile_preview: 8,
  zip: 8,
};

/** 同一道工序内部的排列顺序：输入 → 修复结果 → 候选 → 线稿/蒙版 → 矢量 → 平铺。 */
const KIND_RANK = {
  original: 0,
  normalized_input: 1,
  working_copy: 2,
  cropped: 3,
  prepared: 4,
  enhanced: 5,
  edit_candidate: 0,
  repair_candidate: 1,
  repair_composite: 2,
  edit_mask: 3,
  blend_weight: 4,
  difference_map: 5,
  damage_mask: 6,
  accepted_repair: 7,
  generated_basemap: 0,
  generated_layer: 1,
  placed_generated_layer: 2,
  ai_layer: 3,
  composed_candidate: 4,
  foreground_mask: 0,
  transparent_png: 1,
  lineart: 2,
  contour_line_art: 3,
  svg: 0,
  tile_preview: 0,
  zip: 1,
};

const PARAM_VALUE_LABELS = {
  otsu: "Otsu",
  manual: "手动阈值",
  adaptive_mean: "自适应均值",
  adaptive_gaussian: "自适应高斯",
  sauvola: "Sauvola",
  grabcut: "GrabCut",
  monochrome: "单色",
  color: "彩色",
  contour: "轮廓",
  low: "低",
  medium: "中",
  high: "高",
};

const createdMs = (asset) => {
  const ms = Date.parse(String(asset?.created_at || ""));
  return Number.isNaN(ms) ? 0 : ms;
};

/** 生成时间精确到秒：同一分钟里跑出来的多个版本靠它区分。 */
function clockOf(asset) {
  const ms = createdMs(asset);
  if (!ms) return "—";
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function assetStageNo(asset) {
  // 蒙版修正产物即使没有带 job 记录（例如从纹样库重新打开），也归到 06 蒙版。
  if (
    asset?.annotation_source === "human_foreground_correction" ||
    asset?.parameters?.annotation_source === "human_foreground_correction"
  ) {
    return 6;
  }
  const job = (store.session.jobs || []).find((entry) => entry?.job_id && entry.job_id === asset?.generated_by_job_id);
  return (job && stageForJobKind(job.kind)) || KIND_STAGE[String(asset?.kind || "")] || 0;
}

/**
 * 按工序把会话资产分组：同一步跑过多次时，同类型的多个结果在组内编号 v1…vN。
 * 组与组内顺序都按工序推进，和左栏工序轨一致；stageOf 可注入，便于测试。
 */
function groupAssets(assets, stageOf = assetStageNo) {
  const map = new Map();
  for (const asset of assets || []) {
    if (!asset?.asset_id) continue;
    const stageNo = stageOf(asset);
    const key = String(stageNo || 0);
    if (!map.has(key)) {
      map.set(key, { key, stageNo, stage: stageNo ? STAGES[stageNo - 1] : null, items: [] });
    }
    map.get(key).items.push(asset);
  }
  const groups = [...map.values()];
  for (const group of groups) {
    const ordered = [...group.items].sort(
      (a, b) => createdMs(a) - createdMs(b) || (KIND_RANK[a.kind] ?? 90) - (KIND_RANK[b.kind] ?? 90)
    );
    const counts = new Map();
    for (const asset of ordered) {
      const kind = String(asset.kind || "");
      counts.set(kind, (counts.get(kind) || 0) + 1);
    }
    const seen = new Map();
    group.entries = ordered.map((asset) => {
      const kind = String(asset.kind || "");
      const version = (seen.get(kind) || 0) + 1;
      seen.set(kind, version);
      return { asset, version, versions: counts.get(kind) || 1, label: kindLabel(kind) };
    });
    group.count = ordered.length;
    group.label = group.stage ? group.stage.name : "其它";
  }
  groups.sort((a, b) => (a.stageNo || 99) - (b.stageNo || 99));
  return groups;
}

/** 参数摘要：同类版本的区别主要在参数上，写进缩略图的 title。 */
function assetParamLine(asset) {
  const raw = asset?.parameters || {};
  const params = { ...(asset?.method ? { method: asset.method } : {}), ...(raw.options || {}), ...raw };
  const label = (value) => PARAM_VALUE_LABELS[String(value)] || value;
  const bits = [];
  if (params.method) {
    bits.push(`方法 ${params.method === "model" ? "模型" : params.method === "cloud" ? "云端" : "OpenCV"}`);
  }
  if (params.mode) bits.push(`模式 ${label(params.mode)}`);
  if (params.polarity) bits.push(`前景 ${params.polarity === "light" ? "浅色" : "深色"}`);
  if (Number.isFinite(Number(params.threshold))) {
    const threshold = Number(params.threshold);
    bits.push(`阈值 ${threshold < 1 ? threshold : Math.round(threshold)}`);
  }
  if (Number.isFinite(Number(params.max_colors))) bits.push(`颜色 ${params.max_colors} 色`);
  if (params.detail) bits.push(`细节 ${label(params.detail)}`);
  return bits.slice(0, 3).join(" · ");
}

/** 缩略图 title：类型 + 版本 + 尺寸 + 生成时刻 + 参数 + 资产 id。 */
function assetThumbTitle(asset, version, versions = 1) {
  const parts = [
    versions > 1 ? `${kindLabel(asset.kind)} · v${version}` : kindLabel(asset.kind),
    `${dimsOf(asset)} · ${formatTime(asset.created_at, { withDate: true })}`,
  ];
  const params = assetParamLine(asset);
  if (params) parts.push(params);
  parts.push(shortId(asset.asset_id));
  return parts.join("\n");
}

function assetGroupMarkup(group) {
  const collapsed = collapsedGroups.has(group.key);
  const currentId = store.session.currentAssetId;
  const headTitle = `${group.stage ? `第 ${group.stage.n} 道 ${group.stage.name}` : "其它资产"} · ${group.count} 项`;
  /* 组内先按类型（工序内的固定顺序）再按时间倒序：同类型的版本挨在一起，方便对比。 */
  const ordered = [...group.entries].sort(
    (a, b) =>
      (KIND_RANK[a.asset.kind] ?? 90) - (KIND_RANK[b.asset.kind] ?? 90) ||
      createdMs(b.asset) - createdMs(a.asset)
  );
  const cards = ordered
    .map(({ asset, version, versions, label }) => {
      const on = asset.asset_id === currentId;
      const url = assetPreview(asset);
      const versionText = versions > 1 ? ` v${version}` : "";
      return `<li>
        <button class="wb-thumb" type="button" data-act="asset" data-id="${asset.asset_id}"
          aria-current="${on ? "true" : "false"}"
          aria-label="${esc(`${label}${versionText} · ${dimsOf(asset)} · ${clockOf(asset)}${on ? " · 当前资产" : ""}`)}"
          title="${esc(assetThumbTitle(asset, version, versions))}">
          <span class="wb-thumb__plate plate plate--grain">
            ${
              url
                ? `<img class="plate__img" src="${url}" alt="" loading="lazy" decoding="async" />`
                : `<span class="wb-thumb__file" aria-hidden="true">${icon("file")}</span>`
            }
            ${versions > 1 ? `<span class="wb-thumb__ver mono">v${version}</span>` : ""}
            ${on ? `<span class="wb-thumb__now">当前</span>` : ""}
          </span>
          <span class="wb-thumb__cap">${esc(label)}</span>
        </button>
      </li>`;
    })
    .join("");
  return `
  <section class="wb-group" data-group="${esc(group.key)}">
    <button class="wb-group__head" type="button" data-act="toggle-group" data-group="${esc(group.key)}"
      aria-expanded="${collapsed ? "false" : "true"}" title="${esc(headTitle)}">
      <span class="wb-group__no mono">${esc(group.stage ? group.stage.n : "··")}</span>
      <span class="wb-group__name">${esc(group.label)}</span>
      <span class="wb-group__count mono">${group.count > 1 ? `${group.count} 项` : ""}</span>
      <span class="wb-group__chev" aria-hidden="true">${icon("chevron")}</span>
    </button>
    <ul class="wb-group__grid"${collapsed ? " hidden" : ""}>${cards}</ul>
  </section>`;
}

/** 切到别的资产后把缩略图滚进视野；同一资产不重复滚动，也不在单栏布局里滚动整页。 */
function revealCurrentThumb(root) {
  const id = store.session.currentAssetId || "";
  if (!id || id === lastRevealedId) return;
  lastRevealedId = id;
  filmRestoreSkip = true;
  const card = root?.querySelector(`.wb-thumb[data-id="${id}"]`);
  if (!card) return;
  // 当前资产落在折叠组里（例如刚跑完的新结果）：展开它，否则结果看不见。
  const grid = card.closest(".wb-group__grid");
  if (grid?.hidden) {
    grid.hidden = false;
    const group = grid.closest(".wb-group");
    const head = group?.querySelector(".wb-group__head");
    if (head) head.setAttribute("aria-expanded", "true");
    if (group?.dataset.group) collapsedGroups.delete(group.dataset.group);
  }
  const scroller = root.querySelector(".wb-groups");
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
  if (typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/* ------------------------------------------------------------------ 左栏 */

function railHtml(state) {
  const image = sessionImage();
  const meta = imageMeta();
  const asset = currentAsset();
  const statuses = stageStatuses();
  const doneCount = STAGES.filter((stage) => statuses[stage.key]).length;
  const assets = store.session.assets || [];
  const assetGroups = groupAssets(assets);
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
          const skipped = stage.key === "repair" && draft.repairSkipped;
          const stateText = current ? "当前工序" : skipped ? "已跳过" : statuses[stage.key] ? "已有产物" : "未开始";
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
        <span class="mono">${assets.length} 项 · ${assetGroups.length} 组</span>
      </header>
      ${
        assets.length
          ? `<div class="wb-groups">${assetGroups.map((group) => assetGroupMarkup(group)).join("")}</div>`
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

/** 一笔笔迹的路径：采样点连成一条圆头折线，和提交给后端的点位一一对应。 */
function strokePath(points) {
  const [first, ...rest] = points;
  if (!first) return "";
  // 单点也要有长度：零长度子路径配圆头线帽在部分浏览器里画不出点。
  if (!rest.length) return `M${first.x} ${first.y}l0.01 0`;
  return `M${first.x} ${first.y}${rest.map((point) => `L${point.x} ${point.y}`).join("")}`;
}

/** 一笔笔迹 = 一条描边路径（半透明宽带 + 一条细中线）；线宽取笔刷直径，两端与转角都是圆的。 */
function maskStrokeMarkup(stroke) {
  const d = strokePath(stroke.points);
  if (!d) return "";
  const erase = stroke.mode === "erase" ? " is-erase" : "";
  return `<g class="wb-mask-mark${erase}" data-mask-mark>
    <path class="wb-mask-mark__body" d="${d}" stroke-width="${Math.max(1, stroke.radius * 2)}" />
    <path class="wb-mask-mark__line" d="${d}" />
  </g>`;
}

function maskSvg(asset) {
  const width = Math.max(1, asset.width || 1);
  const height = Math.max(1, asset.height || 1);
  const marks = maskState.strokes.map(maskStrokeMarkup).join("");
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
      <p>上传一张 PNG 或 JPEG，或从纹样库挑一件已经处理过的资产。</p>
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
        <p>先在 02 裁切，或在 05 生成透明 PNG / 线稿 PNG，再回来选单元做 2×2 或 3×3 平铺。</p>
        <div class="wb-empty-state__actions">
          <button class="btn btn--primary btn--sm" type="button" data-act="stage" data-n="5">${icon("flask")}去 05 处理</button>
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
    case "repair": {
      if (draft.repairSkipped) return "已跳过修复 · 纹样完整，不调用云端";
      if (!store.seedream?.enabled) return "云端未配置：修复可跳过，也可到设置里启用";
      const input = cloudRepairInput();
      if (!input.asset) return "先选择修复输入：裁切图、工作副本或已接受修复";
      const box = draft.repair;
      return box
        ? `输入 ${kindLabel(input.asset.kind)} ${dimsOf(input.asset)} · 修复框 ${Math.round(box.width)} × ${Math.round(
            box.height
          )} · ${repairIntentLabel(draft.repairIntent)} · 羽化 ${draft.repairFeather} px`
        : "选择修复区域";
    }
    case "candidate": {
      if (!store.seedream?.enabled) return "云端未配置：候选层可跳过，本地流程仍可用";
      const input = cloudCandidateInput();
      if (!input.asset) return "先选择候选输入：裁切图、工作副本或已接受修复";
      if (cand.layers.length) return `云端候选 ${cand.layers.length} 层 · 已选 ${cand.selected.length} 层`;
      return `输入 ${kindLabel(input.asset.kind)} ${dimsOf(input.asset)} · 等待生成候选`;
    }
    case "process": {
      if (draft.processRoute === "local") {
        const cap = lineartCapability();
        return `本地模型 · ${
          cap.available === true ? "前置检查通过" : cap.available === false ? "前置检查未通过" : "能力未知"
        } · 当前 ${kindLabel(asset.kind)}`;
      }
      if (draft.processRoute === "cloud") {
        const input = cloudLineartInput(store.session.assets, asset);
        return `云端模型 · ${input.asset ? `输入 ${kindLabel(input.asset.kind)} ${dimsOf(input.asset)}` : "输入不可用"} · 只生成线稿 PNG`;
      }
      if (draft.processRoute === "opencv") return `OpenCV 线稿 · 本机生成 PNG · 当前 ${kindLabel(asset.kind)}`;
      return `颜色提取 · ${extractModeLabel(draft.extractMode)} · ${draft.polarity === "light" ? "浅色前景" : "深色前景"}`;
    }
    case "mask": {
      const source = maskSource();
      if (!source?.sourceId) return "当前资产缺少源图记录，不能直接修正";
      const points = maskState.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
      return `源图 ${dimsOf(asset)} · ${draft.maskMode === "add" ? "补前景" : "擦除"} · 半径 ${brushRadius()} px · ${points} 个点`;
    }
    case "vector": {
      const input = vectorInput(store.session.assets, asset);
      if (!input.asset) return "先选择线稿 PNG、透明 PNG、候选合成或已接受修复";
      return `输入 ${kindLabel(input.asset.kind)} ${dimsOf(input.asset)} · ${vectorModeLabel(draft.vectorMode)} · ${
        draft.vectorMode === "monochrome" ? "单色" : `${draft.colors} 色`
      } · 细节${detailLabel(draft.detail)}`;
    }
    case "tile": {
      const unit = tileUnit();
      return `${tileSpec(state)} · ${unit ? kindLabel(unit.kind) : "未选单元"} · 接缝${SEAM_LABELS[draftSeam()]}`;
    }
    default:
      return "";
  }
}

function processJobMatches(job, route) {
  if (!job) return false;
  if (route === "cloud") return job.kind === "cloud-lineart";
  if (route === "color") return job.kind === "extract";
  if (route === "local") return job.kind === "lineart" && job.parameters?.method === "model";
  if (route === "opencv") return job.kind === "lineart" && job.parameters?.method === "opencv";
  return false;
}

function statusFor(stage, state) {
  const asset = currentAsset();
  if (!asset) return ui.sessionError || "未打开资产";
  if (ui.running) return `任务运行中：${ui.job?.kind ? jobKindLabel(ui.job.kind) : "提交中"} · ${progressOf(ui.job)}%`;
  if (ui.error) return ui.error;
  const done = ui.job && ui.jobStage === stageNo(stage) && ui.job.state === "succeeded";
  switch (stage.key) {
    case "source":
      return "无需提交";
    case "crop":
      return done
        ? "裁切完成 · 可在资产轨切换结果"
        : draft.crop
        ? `裁切未提交 · ${Math.round(draft.crop.width)} × ${Math.round(draft.crop.height)} · 原点 (${Math.round(
            draft.crop.left
          )}, ${Math.round(draft.crop.top)})`
        : "未设置选区";
    case "repair":
      if (draft.repairSkipped) return "已跳过修复 · 不会调用云端，也不产生新资产";
      if (!store.seedream?.enabled) return "云端未配置，修复不可用；完整纹样可直接跳过";
      return done ? "修复任务完成 · 在右侧接受或拒绝候选" : "修复候选未生成";
    case "candidate":
      return store.seedream?.enabled ? `${cand.selected.length} 层已选 · 未合成` : "候选层可跳过：云端未配置";
    case "process": {
      const routeLabel =
        draft.processRoute === "local"
          ? "本地模型"
          : draft.processRoute === "cloud"
          ? "云端模型"
          : draft.processRoute === "opencv"
          ? "OpenCV"
          : "颜色提取";
      if (done && processJobMatches(ui.job, draft.processRoute)) {
        return `${routeLabel}完成 · 当前 ${kindLabel(asset.kind)} ${dimsOf(asset)} · 到 07 矢量化`;
      }
      if (draft.processRoute === "cloud") {
        const input = cloudLineartInput(store.session.assets, asset);
        if (!store.seedream?.enabled) return "云端模型未启用：可改用本地模型、OpenCV 或颜色提取";
        if (!input.asset) return "先选择云端线稿输入";
        if (input.error === "pixels") return "云端线稿要求 262,144–25,000,000 像素";
        return `云端线稿未提交 · ${dimsOf(input.asset)} · 到 07 再矢量化`;
      }
      if (draft.processRoute === "color") return "颜色提取未提交 · 产物为蒙版与透明 PNG";
      return `${routeLabel}线稿未提交 · ${isImageLike(asset) ? "可以运行" : "需要先切到支持的图片资产"}`;
    }
    case "mask": {
      const source = maskSource();
      const points = maskState.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
      if (done) return "蒙版修正完成 · 到 07 矢量化";
      return source?.sourceId
        ? `蒙版修正未提交 · ${maskState.strokes.length} 笔 / ${points} 个点`
        : "缺少源图或蒙版记录，无法提交";
    }
    case "vector": {
      const input = vectorInput(store.session.assets, asset);
      if (done) return "矢量化完成 · 当前 SVG";
      if (!input.asset) return "先选择线稿或透明 PNG；未接受的修复候选不能作为输入";
      return `矢量化未提交 · 输入 ${kindLabel(input.asset.kind)} ${dimsOf(input.asset)}`;
    }
    case "tile": {
      const unit = tileUnit();
      if (done) return "平铺预览完成 · 可在资产轨查看结果";
      return unit
        ? `${kindLabel(unit.kind)} ${dimsOf(unit)} · 接缝${SEAM_LABELS[draftSeam()]}`
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
      return "无需提交";
    case "crop":
      return done ? "裁切完成" : "裁切未提交";
    case "repair":
      if (draft.repairSkipped) return "已跳过修复";
      return done ? "修复任务完成" : store.seedream?.enabled ? "候选未生成" : "云端未配置 · 可跳过";
    case "candidate":
      return store.seedream?.enabled ? `${cand.selected.length} 层已选` : "云端未配置 · 可跳过";
    case "process":
      if (done && processJobMatches(ui.job, draft.processRoute)) return "线稿已生成";
      if (draft.processRoute === "local") return "本地模型未提交";
      if (draft.processRoute === "cloud") return "云端线稿未提交";
      if (draft.processRoute === "opencv") return "OpenCV 线稿未提交";
      return "颜色提取未提交";
    case "mask":
      return done ? "蒙版修正完成" : maskState.strokes.length ? `${maskState.strokes.length} 笔未提交` : "还没有笔迹";
    case "vector":
      return done ? "矢量化完成" : "未矢量化";
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
const vectorModeLabel = (mode) => (VECTOR_MODES.find(([value]) => value === mode) || ["", mode])[1];
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
      <p class="field__hint">上传后保存原件、规范输入、aHash、清晰度与来源记录。</p>`
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
    </dl>`
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
    "",
    `<p class="field__hint">裁切产物类型为「裁切」，可作为 05 的输入，也是 08 的平铺单元。${
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
  const lastProcess = lastJob(["lineart", "cloud-lineart", "extract", "pipeline"]);
  const jobAssets = outputs.length
    ? outputs
    : (store.session.assets || []).filter((entry) => lastProcess && entry.generated_by_job_id === lastProcess.job_id);
  const route = draft.processRoute;
  const cloudEnabled = Boolean(store.seedream?.enabled);
  const cloudInput = cloudLineartInput(store.session.assets, asset);
  const localInput = isImageLike(asset) ? { asset, error: "", candidates: [] } : { asset: null, error: "unsupported", candidates: (store.session.assets || []).filter(isImageLike) };
  const input = route === "cloud" ? cloudInput : localInput;
  const routeLabel =
    route === "local" ? "本地模型" : route === "cloud" ? "云端模型" : route === "opencv" ? "OpenCV" : "颜色提取";
  const routeHint =
    route === "local"
      ? "本地模型：直接用本机模型生成线稿 PNG，不调用云端，也不会自动矢量化。"
      : route === "cloud"
      ? "云端模型：把当前输入上传到云端生成线稿 PNG；每次调用都要分别确认上传与调用，失败不自动重发，也不会自动矢量化。"
      : route === "opencv"
      ? "OpenCV：本机传统算法生成线稿 PNG，不依赖模型权重，也不调用云端。"
      : "颜色提取：本机生成前景蒙版、透明 PNG 与外轮廓线稿；蒙版修正后再到 07 矢量化。";
  const inputProblem = !input.asset
    ? input.error === "unsupported"
      ? `当前资产是「${kindLabel(asset.kind)}」，不能作为${routeLabel}输入。请从下面明确选择一个支持的输入；未接受的修复候选不能继续使用。`
      : "先打开一张纹样，或从纹样库打开一个资产。"
    : input.error === "pixels"
    ? `当前输入 ${Number(input.pixels).toLocaleString("zh-CN")} 像素，不在云端允许的 262,144–25,000,000 像素内；请先裁切或创建工作副本。`
    : input.error === "aspect"
    ? "当前输入的长宽比不在云端允许的 1/16–16 之间；请先裁切或创建工作副本。"
    : "";
  return `
  ${jobBox(stage)}
  ${errorBox()}
  ${noticeBox()}
  ${sec(
    "生成方式",
    "",
    `${segField(
      "processRoute",
      "线稿生成方式",
      [
        ["local", "本地模型"],
        ["cloud", "云端模型"],
        ["opencv", "OpenCV"],
        ["color", "颜色提取"],
      ],
      route
    )}
    <p class="field__hint">${esc(routeHint)}</p>`
  )}
  ${
    input.asset
      ? sec(
          "输入",
          `${esc(kindLabel(input.asset.kind))} · ${esc(dimsOf(input.asset))}`,
          `${input.error ? noteBox(esc(inputProblem), "error") : ""}
           <p class="field__hint">使用当前资产作为输入。要换输入，直接在左栏资产轨切换；这里不会自动改用原图或规范输入。</p>`
        )
      : sec(
          "可用输入",
          "需要明确选择",
          `${noteBox(esc(inputProblem), "error")}${assetChoices(input.candidates, {
            currentId: store.session.currentAssetId,
          })}`
        )
  }
  ${
    route === "local"
      ? `${sec(
          "本地模型",
          cap.available === true ? "前置检查通过" : cap.available === false ? "前置检查未通过" : "能力未知",
          `${noteBox(esc(lineartCapabilityText()), cap.available === false ? "error" : "info")}
          <p class="field__hint">${
            cap.available === false
              ? "这条路线暂不可用；请改用「云端模型」「OpenCV」或「颜色提取」。"
              : "只生成线稿 PNG，不自动矢量化。"
          }</p>`
        )}`
      : route === "cloud"
      ? cloudEnabled
        ? `${sec(
            "云端模型",
            `${esc(store.seedream?.model || "云端模型")}`,
            `<p class="field__hint">云端线稿只返回一张 lineart PNG；识别的提示词版本与调用编号会写进资产记录，方便核对。</p>
            ${checkRow("cloudConsentUpload", "同意把当前输入上传到云端服务商", draft.cloudConsentUpload, "只发送当前输入这一张图。")}
            ${checkRow("cloudConsentCharge", "同意本次云端调用（可能产生费用）", draft.cloudConsentCharge, "失败不自动重发；提交后自动清空，下一次需重新勾选。")}`
          )}`
        : cloudDisabled(null)
      : route === "opencv"
      ? `${sec(
          "OpenCV 线稿",
          "本机",
          `<p class="field__hint">用图像处理直接生成线稿 PNG；不需要模型权重，也不会调用云端。结果仍需人工核对。</p>`
        )}`
      : `${sec(
          "提取",
          `输入 ${esc(dimsOf(input.asset || asset))}`,
          `${selectField("extractMode", "提取模式", EXTRACT_MODES, draft.extractMode)}
          ${segField("polarity", "前景极性", POLARITIES, draft.polarity)}
          ${rangeField("threshold", "阈值", 0, 255, 1, draft.threshold, "Otsu / 手动阈值用到；自适应与 GrabCut 模式会忽略或作为参考。")}
          <p class="field__hint">${
            draft.extractMode === "grabcut"
              ? "GrabCut 需要矩形：默认使用 02 的选区，整幅时会自动内缩 5% 留出背景。"
              : "颜色提取只处理当前资产；复杂背景建议先裁切。矢量化在 07 单独完成。"
          }</p>`
        )}`
  }
  ${sec(
    "最新产物",
    jobAssets.length ? `${jobAssets.length} 个` : "暂无",
    `${
      jobAssets.length
        ? `${assetChoices(jobAssets, { currentId: store.session.currentAssetId })}
           <div class="wb-inline">
             <button class="btn btn--ghost btn--sm" type="button" data-act="go-vector">${icon("spark")}去 07 矢量化</button>
           </div>`
        : `<p class="field__hint">提交后这里会列出线稿 PNG、前景蒙版与透明 PNG；矢量化请到 07。</p>`
    }`
  )}`;
}

function candidatePanel(state) {
  const stage = currentStage(state);
  const cloudEnabled = Boolean(store.seedream?.enabled);
  const hasArchive = Boolean(cand.flow || cand.layers.length);
  if (!cloudEnabled && !hasArchive) {
    return `${jobBox(stage)}${errorBox()}${noticeBox()}${cloudDisabled(null)}${sec(
      "不启用云端时",
      "",
      `<p class="field__hint">候选层这一步可跳过：直接在 05 选择本地模型、OpenCV 或颜色提取，再到 06 修正蒙版。已有归档候选仍可读取。</p>`
    )}`;
  }
  const input = cloudCandidateInput();
  const action = flowDecisionAction(cand.flow);
  const recompose = action === "select_layers";
  return `
  ${jobBox(stage)}
  ${errorBox()}
  ${noticeBox()}
  ${
    cloudEnabled
      ? ""
      : noteBox("云端新生成已关闭；已有归档候选仍可读取、选层并本地合成或重合成，不会新增云端调用。", "info")
  }
  ${
    cloudEnabled && input.error
      ? noteBox(
          esc(
            input.error === "pixels"
              ? `当前输入 ${Number(input.pixels).toLocaleString("zh-CN")} 像素，不在云端允许的 262,144–25,000,000 像素内；请先裁切或创建工作副本。`
              : input.error === "aspect"
              ? "当前输入的长宽比不在云端允许的 1/16–16 之间；请先裁切或创建工作副本。"
              : input.error === "missing"
              ? "先打开一张纹样，或从纹样库打开一个资产。"
              : `当前资产是「${kindLabel(currentAsset()?.kind || "资产")}」，不能作为候选输入。请从下面明确选择一个支持的输入；未接受的修复候选不能继续使用。`
          ),
          "error"
        )
      : ""
  }
  ${
    cloudEnabled && !input.asset
      ? sec(
          "可用输入",
          "需要明确选择",
          `${assetChoices(input.candidates, { currentId: store.session.currentAssetId })}
           <p class="field__hint">候选输入只使用当前选中的资产，不会自动换回原图或规范输入。</p>`
        )
      : ""
  }
  ${
    cloudEnabled
      ? `${input.asset
          ? sec(
              "输入",
              `${esc(kindLabel(input.asset.kind))} · ${esc(dimsOf(input.asset))}`,
              `<p class="field__hint">云端拆分使用当前资产；要换输入，直接在左栏资产轨切换。</p>`
            )
          : ""}
        ${sec(
          "云端参数",
          `${esc(store.seedream?.model || "云端模型")}`,
          `${selectField("candSize", "生成尺寸", AI_SIZE_OPTIONS, draft.candSize)}
          ${segField("candColors", "颜色数", COLOR_OPTIONS.map(([value, text]) => [value, text]), draft.candColors)}
          ${segField("candDetail", "细节", DETAILS, draft.candDetail)}
          <p class="field__hint">尺寸与颜色数会随请求一起存档；这一步只拆分候选，不生成线稿。</p>`
        )}
        ${sec(
          "显式同意",
          "每次调用都要确认",
          `${checkRow("consentUpload", "同意把当前输入上传到云端服务商", draft.consentUpload, "只发送当前输入这一张图。")}
          ${checkRow("consentCharge", "同意本次云端调用（可能产生费用）", draft.consentCharge, "失败不自动重发；提交后自动清空，下一次需重新勾选。")}
          <p class="field__hint">两项都勾选后才能生成候选；提交后自动清空，下一次需重新勾选。</p>`
        )}`
      : ""
  }
  ${sec(
    "候选层",
    cand.layers.length ? `${cand.layers.length} 层${recompose ? " · 已选过层" : ""}` : cand.flow ? esc(stepStateLabel(cand.flow.state)) : "尚未生成",
    `${
      cand.loading
        ? loadingBox()
        : `${cand.error ? noteBox(esc(cand.error), "error") : ""}${
            cand.layers.length
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
                <p class="field__hint">${
                  flowActiveJobId(cand.flow)
                    ? "云端流程仍在处理；页面只轮询已有任务，不会重新提交。"
                    : recompose
                      ? "已做过一次选层；改选后「重新合成」会新建本机分支，不会新增云端调用。"
                      : "选中的层会按顺序合成成一张候选；首次合成会结束这个云端流程的等待状态。"
                }</p>`
              : cand.flow && flowActiveJobId(cand.flow)
                ? `<p class="field__hint">云端流程仍在处理；页面只轮询已有任务，不会重新提交。</p>`
                : `<p class="field__hint">${
                    cloudEnabled
                      ? "生成云端候选后，这里会显示可选的层。"
                      : "没有找到可恢复的已归档候选。"
                  }</p>`
          }`
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
        <p class="field__hint">画笔坐标使用源图 RGB 像素；提交后生成新的透明 PNG，修正完成再到 07 矢量化。</p>`
      : `${noteBox(
          "当前资产不是可修正的透明 PNG（或缺少来源蒙版）。请先在 05 用颜色提取生成透明 PNG，或从下面选择一个透明 PNG。",
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
    <p class="field__hint">补前景写入不透明像素；擦除把笔迹范围改成透明。</p>`
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

function vectorPanel(state) {
  const stage = currentStage(state);
  const asset = currentAsset();
  if (!asset) return noAssetPanel();
  const input = vectorInput(store.session.assets, asset);
  const outputs = (ui.job && ui.jobStage === stageNo(stage) ? ui.job.result?.assets || [] : []).filter(Boolean);
  const lastVector = lastJob(["vectorize"]);
  const jobAssets = outputs.length
    ? outputs
    : (store.session.assets || []).filter((entry) => lastVector && entry.generated_by_job_id === lastVector.job_id);
  const inputProblem = !input.asset
    ? input.error === "unsupported"
      ? `当前资产是「${kindLabel(asset.kind)}」，不能直接矢量化。未接受的修复候选不能作为输入；请从下面选择线稿 PNG、透明 PNG、候选合成或已接受修复。`
      : "先打开一张纹样，或从纹样库打开一个资产。"
    : "";
  return `
  ${jobBox(stage)}
  ${errorBox()}
  ${noticeBox()}
  ${
    input.asset
      ? sec(
          "输入",
          `${esc(kindLabel(input.asset.kind))} · ${esc(dimsOf(input.asset))}`,
          `<p class="field__hint">矢量化使用当前资产；要换输入，直接在左栏资产轨切换。未接受的修复候选不会出现在可用输入里。</p>`
        )
      : sec(
          "可用输入",
          "需要明确选择",
          `${noteBox(esc(inputProblem), "error")}${assetChoices(input.candidates, {
            currentId: store.session.currentAssetId,
          })}`
        )
  }
  ${sec(
    "矢量参数",
    "vtracer",
    `${segField("vectorMode", "矢量模式", VECTOR_MODES, draft.vectorMode)}
    ${segField("colors", "颜色数", COLOR_OPTIONS.map(([value, text]) => [value, text]), draft.colors)}
    ${segField("detail", "细节", DETAILS, draft.detail)}
    <p class="field__hint">颜色数只影响 SVG 填充；细节越高路径越多、越接近原图，也更容易碰到本机内存上限。颜色模式建议不超过 25 万像素，单色/轮廓上限 100 万像素。</p>`
  )}
  ${sec(
    "最新产物",
    jobAssets.length ? `${jobAssets.length} 个` : "暂无",
    `${
      jobAssets.length
        ? assetChoices(jobAssets, { currentId: store.session.currentAssetId })
        : `<p class="field__hint">提交后这里会出现新的 SVG；平铺与导出在 08。</p>`
    }`
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
  const cloudEnabled = Boolean(store.seedream?.enabled);
  const info = repairState.info;
  const skipped = Boolean(draft.repairSkipped);
  const asset = currentAsset();
  const input = cloudRepairInput();
  const recordedInput = info
    ? (store.session.assets || []).find((entry) => entry.asset_id === info.input_asset_id) || null
    : null;
  const recordText = info ? repairRecordText(info, recordedInput) : "";
  const box = draft.repair;
  const dims = input.asset ? currentDims(input.asset) : null;
  const inputProblem = !input.asset
    ? input.error === "pixels"
      ? `当前输入 ${Number(input.pixels).toLocaleString("zh-CN")} 像素，不在局部修复允许的 262,144–1,048,576 像素内；请先裁切或创建工作副本。`
      : input.error === "aspect"
      ? "当前输入的长宽比不在云端允许的 1/16–16 之间；请先裁切或创建工作副本。"
      : input.error === "missing"
      ? "先打开一张纹样，或从纹样库打开一个资产。"
      : `当前资产是「${kindLabel(asset?.kind || "资产")}」，不能作为修复输入。请从下面明确选择一个支持的输入；未接受的修复候选不能继续使用。`
    : "";
  return `
  ${jobBox(stage)}
  ${errorBox()}
  ${noticeBox()}
  ${
    skipped
      ? noteBox("已跳过修复：纹样按完整处理，不生成修复候选，也不会调用云端。", "info")
      : cloudEnabled
      ? ""
      : noteBox("云端新生成已关闭；这次修复的候选仍可接受或拒绝，不会新增云端调用。纹样完整也可以直接跳过。", "info")
  }
  ${sec(
    "修复可跳过",
    skipped ? "已跳过" : "完整纹样不必做",
    `<p class="field__hint">修复排在线稿提取之前；纹样完整、没有明显缺口或断线时，可以明确跳过，不产生资产与调用。</p>
     <button class="btn btn--ghost btn--sm" type="button" data-act="skip-repair">${
       skipped ? "继续修复" : "完整，跳过修复"
     }</button>`
  )}
  ${
    skipped
      ? ""
      : !cloudEnabled
      ? cloudDisabled(null)
      : `${input.asset
          ? sec(
              "输入",
              `${esc(kindLabel(input.asset.kind))} · ${esc(dimsOf(input.asset))}`,
              `${input.error ? noteBox(esc(inputProblem), "error") : ""}
               <p class="field__hint">修复使用当前资产；要换输入，直接在左栏资产轨切换，不会自动改用原图或规范输入。</p>`
            )
          : sec(
              "可用输入",
              "需要明确选择",
              `${noteBox(esc(inputProblem), "error")}${assetChoices(input.candidates, {
                currentId: store.session.currentAssetId,
              })}`
            )}
        ${sec(
          "修复区域",
          input.asset ? esc(dimsOf(input.asset)) : "",
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
          <p class="field__hint">区域使用当前输入的像素坐标；云端的全图候选可能改变整幅画面，接受前需额外确认。</p>`
        )}
        ${sec(
          "修复参数",
          `262,144–1,048,576 px`,
          `${segField("repairIntent", "意图", REPAIR_INTENTS, draft.repairIntent)}
          ${rangeField("repairFeather", "羽化", 0, 64, 1, draft.repairFeather)}
          ${selectField("repairSize", "生成尺寸", SIZE_OPTIONS.filter(([value]) => value !== "auto"), draft.repairSize)}`
        )}
        ${sec(
          "显式同意",
          "每次调用都要确认",
          `${checkRow("repairConsentUpload", "同意把当前输入上传到云端服务商", draft.repairConsentUpload)}
          ${checkRow("repairConsentCharge", "同意本次云端调用（可能产生费用）", draft.repairConsentCharge)}
          <p class="field__hint">失败不自动重发；提交后自动清空，下一次需重新勾选。</p>`
        )}`
  }
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
           ${recordText ? `<p class="field__hint">${esc(recordText)}</p>` : ""}
           ${info.decision ? `<p class="field__hint">已${info.decision.action === "accept" ? "接受" : "拒绝"}这次修复。</p>` : ""}
           ${checkRow("acceptFull", "接受全图 AI 候选前，我确认它可能改变整个画面", draft.acceptFull)}`
        : `<p class="field__hint">提交后这里会显示全图候选与本地局部合成；刷新后会按这张图的修复任务恢复，不重新提交。</p>`
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
        <p class="field__hint">只有裁切、透明 PNG、线稿 PNG 与已接受的修复图能作为平铺单元。</p>`
      : `<p class="field__hint">还没有可平铺的单元：先做 02 裁切，或在 05 生成透明 PNG / 线稿 PNG。</p>`
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
    case "repair":
      return repairPanel(state);
    case "candidate":
      return candidatePanel(state);
    case "process":
      return processPanel(state);
    case "mask":
      return maskPanel(state);
    case "vector":
      return vectorPanel(state);
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
    case "repair": {
      const skipped = Boolean(draft.repairSkipped);
      const input = cloudRepairInput();
      const cloudEnabled = Boolean(store.seedream?.enabled);
      const skipButton = `<button class="btn btn--ghost btn--sm" type="button" data-act="skip-repair"${
        busy ? " disabled" : ""
      }>${skipped ? "继续修复" : "完整，跳过修复"}</button>`;
      if (skipped) {
        return `${skipButton}
          <button class="btn btn--primary btn--sm" type="button" data-act="go-process">${icon("arrow")}去 05 生成线稿</button>`;
      }
      if (!cloudEnabled) {
        return `${skipButton}
          <button class="btn btn--ghost btn--sm" type="button" data-act="settings">${icon("gear")}去设置</button>`;
      }
      return `${skipButton}
        ${primaryButton(
          "run-repair",
          input.asset ? "生成修复候选" : "先选修复输入",
          "cloud",
          disabled(!input.asset || Boolean(input.error) || !draft.repairConsentUpload || !draft.repairConsentCharge)
        )}`;
    }
    case "candidate": {
      const cloudEnabled = Boolean(store.seedream?.enabled);
      const input = cloudCandidateInput();
      const canRegenerate = Boolean(input.asset) && !input.error;
      const composeLabel = flowDecisionAction(cand.flow) === "select_layers" ? "重新合成" : "合成";
      if (cand.restoring || flowActiveJobId(cand.flow)) {
        return `<button class="btn btn--ghost btn--sm" type="button" disabled>${icon("history")}恢复云端流程中</button>`;
      }
      const goProcess = `<button class="btn btn--ghost btn--sm" type="button" data-act="go-process">${icon("flask")}去 05 生成线稿</button>`;
      if (!cloudEnabled) {
        if (!cand.layers.length) {
          return `<button class="btn btn--ghost btn--sm" type="button" data-act="settings">${icon("gear")}去设置</button>
            ${goProcess}`;
        }
        return `<button class="btn btn--ghost btn--sm" type="button" data-act="settings">${icon("gear")}云端生成设置</button>
          ${goProcess}
          ${primaryButton("compose-layers", `${composeLabel} ${cand.selected.length} 层`, "layers", disabled(!cand.selected.length))}`;
      }
      if (cand.layers.length) {
        return `<button class="btn btn--ghost btn--sm" type="button" data-act="run-candidate"${
          busy || !canRegenerate ? " disabled" : ""
        }>${icon("cloud")}重新生成</button>
          ${goProcess}
          ${primaryButton("compose-layers", `${composeLabel} ${cand.selected.length} 层`, "layers", disabled(!cand.selected.length))}`;
      }
      return primaryButton(
        "run-candidate",
        "生成云端候选",
        "cloud",
        disabled(!canRegenerate || !draft.consentUpload || !draft.consentCharge)
      );
    }
    case "process": {
      const cap = lineartCapability();
      const localInput = isImageLike(asset);
      const cloudInput = cloudLineartInput(store.session.assets, asset);
      const goVector = vectorInput(store.session.assets, asset).asset
        ? `<button class="btn btn--ghost btn--sm" type="button" data-act="go-vector">${icon("spark")}去 07 矢量化</button>`
        : "";
      if (draft.processRoute === "local") {
        return `${primaryButton(
          "run-model-lineart",
          cap.available === false ? "本地模型暂不可用" : "本地模型生成线稿",
          "flask",
          disabled(!localInput || cap.available === false)
        )}${goVector}`;
      }
      if (draft.processRoute === "cloud") {
        return `${primaryButton(
          "run-cloud-lineart",
          "云端生成线稿",
          "cloud",
          disabled(
            !store.seedream?.enabled ||
              !cloudInput.asset ||
              Boolean(cloudInput.error) ||
              !draft.cloudConsentUpload ||
              !draft.cloudConsentCharge
          )
        )}${goVector}`;
      }
      if (draft.processRoute === "opencv") {
        return `${primaryButton("run-opencv-lineart", "OpenCV 生成线稿", "brush", disabled(!localInput))}${goVector}`;
      }
      return `${primaryButton("run-extract", "开始颜色提取", "flask", disabled(!localInput))}${goVector}`;
    }
    case "mask": {
      const error = maskError();
      const goVector = vectorInput(store.session.assets, asset).asset
        ? `<button class="btn btn--ghost btn--sm" type="button" data-act="go-vector">${icon("spark")}去 07 矢量化</button>`
        : "";
      return `<button class="btn btn--quiet btn--sm" type="button" data-act="undo-stroke"${
        disabled(!maskState.strokes.length) ? " disabled" : ""
      }>撤销上一笔</button>
        ${primaryButton("run-mask", "提交蒙版修正", "mask", disabled(Boolean(error)))}${goVector}`;
    }
    case "vector": {
      const input = vectorInput(store.session.assets, asset);
      return primaryButton("run-vectorize", "矢量化当前 PNG", "spark", disabled(!input.asset));
    }
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
  const groups = root.querySelector(".wb-groups");
  const panel = root.querySelector(".wb-panel__body");
  const canvas = root.querySelector("[data-canvas]");
  scrollMemo = {
    at: Date.now(),
    film: groups ? groups.scrollTop : 0,
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
  const groups = root.querySelector(".wb-groups");
  // 刚切换过当前资产时，让 revealCurrentThumb 的滚动说了算，不再恢复旧位置。
  if (groups && !filmRestoreSkip) groups.scrollTop = memo.film;
  filmRestoreSkip = false;
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

/** 云端相关任务：取消/失败文案要避免声称撤销云端请求。 */
const CLOUD_JOB_KINDS = new Set(["repair", "decompose-layers", "compose-layers", "ai", "ai-pipeline", "cloud-lineart"]);

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
      ? "已请求取消；已发出的云端请求不会撤回。"
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
  activeJobToken = token;
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

  if (activeJobToken === token) {
    // 旧会话任务结束时也要清掉它留下的 busy；如果新会话已有新任务，
    // activeJobToken 已换成新令牌，这里不会误清。
    ui.running = false;
    ui.jobId = "";
    if (!owned()) {
      ui.job = null;
      ui.jobStage = 0;
    }
    activeJobToken = null;
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
  const seq = ++layersRequestSeq;
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
  // 会话已切换或已有更新的层请求：旧响应直接丢弃，不覆盖新的层列表/勾选。
  if (!owned() || seq !== layersRequestSeq) return undefined;
  if (failure) {
    cand.error = errorText(failure);
  } else {
    cand.layers = Array.isArray(payload?.layers) ? payload.layers : [];
    cand.jobId = jobId;
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

/* ------------------------------------------------------------------ 云端流程恢复 */

/** 读取流程最新快照；只 GET，不提交、不重试。 */
async function refreshCandidateFlow(api, flowId, token) {
  if (!flowId) return null;
  let flow = null;
  try {
    flow = await http.pipelineInfo(flowId);
  } catch (error) {
    if (store.isSessionCurrent(token)) cand.error = errorText(error);
    return null;
  }
  if (!store.isSessionCurrent(token)) return null;
  return flow && flow.pipeline_id ? flow : null;
}

/**
 * 把流程快照写入候选状态；可合成分解时只读取已归档层。
 * `selection` 为 true 时用流程记录的选择覆盖当前勾选（首次恢复/首次继续）。
 */
async function adoptCandidateFlow(api, flow, token, { selection = false } = {}) {
  if (!flow || !store.isSessionCurrent(token)) return null;
  const previousFlowId = cand.flowId;
  if (flow.pipeline_id !== previousFlowId) {
    cand.layers = [];
    cand.selected = [];
    cand.selectionTouched = false;
  }
  cand.flow = flow;
  cand.flowId = flow.pipeline_id || "";
  cand.jobId = flow.decomposition_job_id || cand.jobId;
  cand.error = "";
  const recovered = [
    ...(Array.isArray(flow.result?.assets) ? flow.result.assets : []),
    ...(Array.isArray(flow.branches)
      ? flow.branches.flatMap((branch) => (Array.isArray(branch?.result?.assets) ? branch.result.assets : []))
      : []),
  ];
  if (recovered.length) store.addJobAssets({ result: { assets: recovered } }, { token });
  if (selection) {
    cand.selected = selectionAfterFlowAdopt(cand.selected, candidateSelectionForFlow(flow), {
      selection: true,
      touched: cand.selectionTouched,
    });
  }
  const action = flowDecisionAction(flow);
  const failureText =
    flow.state === "failed" && flow.error?.message ? `云端流程失败：${String(flow.error.message)}` : "";
  if (action && action !== "select_layers") {
    cand.error = "这个云端流程已选择本地处理或已拒绝，不能再合成候选。";
  } else if (flow.recovery?.needs_reconcile) {
    cand.error = "上一次云端调用结果尚未确认；请先在任务记录中核对，不会自动重发。";
  } else {
    if (failureText) cand.error = failureText;
    if (flowCanCompose(flow)) {
      const payload = await fetchLayers(api, flow.decomposition_job_id);
      if (!store.isSessionCurrent(token)) return null;
      // 已有更新的层请求接管；旧恢复不再改写错误或勾选。
      if (payload === undefined) return flow;
      if (!payload) cand.error = cand.error || "候选层读取失败，请稍后重试。";
      else if (failureText && !cand.error) cand.error = failureText;
    }
  }
  return flow;
}

/** 轮询流程已有的分解/合成任务，只读已有 job，不重新提交云端请求。 */
async function resumeCandidateJob(api, flow, token) {
  const jobId = flowActiveJobId(flow);
  if (!jobId) return;
  const submit = () => Promise.resolve({ job_id: jobId, state: "queued" });
  await startJob(api, submit, async () => {
    const fresh = await refreshCandidateFlow(api, flow.pipeline_id, token);
    if (!fresh) return;
    await adoptCandidateFlow(api, fresh, token, { selection: true });
    if (flowCanCompose(fresh)) {
      ui.notice = "已恢复云端候选流程，可继续选层并本地合成；没有新增云端调用。";
    }
  });
}

/**
 * 进入工作台/刷新后按图恢复最近的云端候选流程。
 * 只读取历史、流程和已归档层；未配置密钥时同样可用。
 */
async function restoreCandidateFlow(api) {
  const token = store.sessionToken();
  const imageId = store.session.imageId;
  if (!imageId || cand.restoring || ui.running) return;
  const key = `${token}:${imageId}`;
  if (lastRestoredFlowKey === key) return;
  lastRestoredFlowKey = key;
  cand.restoring = true;
  try {
    const history = await store.imageHistory(imageId, "flows");
    if (!store.isSessionCurrent(token)) return;
    const historyWarning = history.complete ? "" : "云端流程历史分页未读完，只恢复了已读取到的最新流程。";
    const assetIds = (store.session.assets || []).map((asset) => asset.asset_id);
    const found = pickCandidateFlow(history.items, assetIds);
    if (!found) {
      if (historyWarning) cand.error = historyWarning;
      return;
    }
    const flow = await refreshCandidateFlow(api, found.pipeline_id, token);
    if (!flow) return;
    await adoptCandidateFlow(api, flow, token, { selection: true });
    if (!store.isSessionCurrent(token)) return;
    if (historyWarning && !cand.error) cand.error = historyWarning;
    if (flowActiveJobId(flow) && !cand.error) {
      ui.notice = "正在恢复上一次云端流程，只轮询已有任务，不会重新提交。";
      await resumeCandidateJob(api, flow, token);
    } else if (flowCanCompose(flow) && !cand.error) {
      ui.notice = "已恢复云端候选流程：可继续选层并本地合成，不会新增云端调用。";
    }
  } catch (error) {
    if (store.isSessionCurrent(token)) cand.error = errorText(error);
  } finally {
    if (store.isSessionCurrent(token)) cand.restoring = false;
    repaintIfHere(api);
  }
}

/* ------------------------------------------------------------------ 修复记录恢复 */

/**
 * 从按图 jobs 历史里选最近的修复任务（新→旧）。
 * 优先输入属于当前会话的资产；找不到时回落到最近一条已完成的修复任务。
 * 只恢复 succeeded 的任务：失败/取消没有可接受候选，运行中的任务等它结束再看。
 */
export function pickRepairJob(jobs, assetIds) {
  const ids = assetIds instanceof Set ? assetIds : new Set(assetIds || []);
  let fallback = null;
  for (const job of jobs || []) {
    if (!job || job.kind !== "repair" || !job.job_id || job.state !== "succeeded") continue;
    if (!fallback) fallback = job;
    if (!ids.size || ids.has(job.input_asset_id)) return job;
  }
  return fallback;
}

/**
 * 把修复任务 parameters.bbox 换算成界面草稿框。
 * bbox 是修复任务 input_asset 的像素坐标（right/bottom 为开区间）；只有拿到该
 * 输入资产的宽高时才换算，绝不套到规范输入或原图上。
 */
export function repairBoxFromJob(info, inputAsset) {
  const bbox = info?.parameters?.bbox;
  if (!bbox || !inputAsset) return null;
  const width = Number(inputAsset.width || 0);
  const height = Number(inputAsset.height || 0);
  if (!width || !height) return null;
  const left = clamp(Math.round(Number(bbox.left)), 0, width - 1);
  const top = clamp(Math.round(Number(bbox.top)), 0, height - 1);
  const right = clamp(Math.round(Number(bbox.right)), left + 1, width);
  const bottom = clamp(Math.round(Number(bbox.bottom)), top + 1, height);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** 修复记录里的旧框说明：明确坐标按修复任务 input_asset 的像素解释。 */
export function repairRecordText(info, inputAsset) {
  if (!info?.parameters?.bbox) return "";
  if (!inputAsset) {
    return `修复记录引用的输入资产 #${shortId(info?.input_asset_id || "")} 不在当前会话，未套用旧修复框。`;
  }
  const box = repairBoxFromJob(info, inputAsset);
  if (!box) return "";
  return `修复框 ${box.width} × ${box.height} px（left ${box.left}, top ${box.top}）来自输入资产 ${kindLabel(
    inputAsset.kind
  )} ${dimsOf(inputAsset)}（#${shortId(inputAsset.asset_id)}）的像素坐标。`;
}

/**
 * 刷新/重进工作台后按这张图的 jobs 历史恢复修复候选。
 * 只 GET 历史与 /repairs/{id}，不提交 repair、不重试、不核销云端调用。
 * 已接受的修复会按 accepted_asset_id 读取一次，加入会话（读取仍是只读）。
 */
async function restoreRepairState(api) {
  const token = store.sessionToken();
  const imageId = store.session.imageId;
  if (!imageId || ui.running || repairState.info) return;
  const key = `${token}:${imageId}`;
  if (lastRestoredRepairKey === key) return;
  lastRestoredRepairKey = key;
  try {
    const history = await store.imageHistory(imageId, "jobs");
    if (!store.isSessionCurrent(token)) return;
    const assetIds = (store.session.assets || []).map((asset) => asset.asset_id);
    const job = pickRepairJob(history.items, assetIds);
    if (!job) return;
    const info = await http.repairInfo(job.job_id);
    if (!store.isSessionCurrent(token)) return;
    if (!info || !info.repair_job_id) return;
    repairState.info = info;
    repairState.error = "";
    let inputAsset = (store.session.assets || []).find((asset) => asset.asset_id === info.input_asset_id) || null;
    if (!inputAsset && info.input_asset_id) {
      try {
        inputAsset = await http.asset(info.input_asset_id);
      } catch {
        inputAsset = null;
      }
      if (!store.isSessionCurrent(token)) return;
      if (inputAsset) store.rememberAsset(inputAsset, { token });
    }
    const box = repairBoxFromJob(info, inputAsset);
    let boxApplied = false;
    if (box) {
      pendingRepairBox = { assetId: inputAsset.asset_id, box };
      if (store.session.currentAssetId === inputAsset.asset_id) {
        draft.repair = { ...box };
        pendingRepairBox = null;
        boxApplied = true;
      } else if (currentStage(api.state).key === "repair") {
        // 修复框按 input_asset 像素解释；切到该资产后再套用，绝不错位到原图/规范输入。
        store.setCurrentAsset(inputAsset.asset_id);
        boxApplied = true;
      }
    }
    if (info.decision?.action === "accept" && info.decision.accepted_asset_id) {
      await store.adoptAcceptedRepair(info, token);
    }
    if (store.isSessionCurrent(token)) {
      const restored = boxApplied ? "候选与旧修复框" : "候选";
      ui.notice =
        ui.notice ||
        `已按这张图的修复任务恢复${restored}；只读取记录，没有重新提交云端调用。`;
    }
  } catch (error) {
    if (store.isSessionCurrent(token)) repairState.error = errorText(error);
  } finally {
    repaintIfHere(api);
  }
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

/**
 * 云端/矢量化输入解析：只有当前资产本身在允许集合里才直接使用；
 * 否则返回 null + 可选输入列表，由界面让用户明确切换——绝不悄悄换回规范输入或原图。
 * `error` 为 "missing"（没有输入）、"unsupported"（类型不支持）、"pixels"（像素不在范围）
 * 或 "aspect"（长宽比不在 1/16–16）。
 */
export function resolveCloudInput(
  assets,
  current,
  allowed,
  { minPixels = 0, maxPixels = Infinity, aspect = false } = {}
) {
  const candidates = (assets || []).filter((asset) => asset?.asset_id && allowed.has(asset.kind));
  const asset = current && allowed.has(current.kind) ? current : null;
  if (!asset) {
    return { asset: null, error: current ? "unsupported" : "missing", candidates, pixels: 0 };
  }
  const width = Number(asset.width || 0);
  const height = Number(asset.height || 0);
  const pixels = width * height;
  if (pixels && (pixels < minPixels || pixels > maxPixels)) {
    return { asset, error: "pixels", candidates, pixels };
  }
  if (aspect && width && height) {
    const ratio = width / height;
    if (ratio < CLOUD_INPUT_ASPECT_MIN || ratio > CLOUD_INPUT_ASPECT_MAX) {
      return { asset, error: "aspect", candidates, pixels };
    }
  }
  return { asset, error: "", candidates, pixels };
}

export function cloudLineartInput(assets, current) {
  return resolveCloudInput(assets, current, CLOUD_INPUT_KINDS, {
    minPixels: CLOUD_INPUT_MIN_PIXELS,
    maxPixels: CLOUD_INPUT_MAX_PIXELS,
    aspect: true,
  });
}

/** 云端修复/候选共用同一份后端输入白名单；修复另有 1024×1024 的像素上限。 */
export function cloudEditInput(assets, current, maxPixels = CLOUD_INPUT_MAX_PIXELS) {
  return resolveCloudInput(assets, current, CLOUD_INPUT_KINDS, {
    minPixels: CLOUD_INPUT_MIN_PIXELS,
    maxPixels,
    aspect: true,
  });
}

export function vectorInput(assets, current) {
  return resolveCloudInput(assets, current, VECTOR_INPUT_KINDS);
}

function cloudRepairInput() {
  return cloudEditInput(store.session.assets, currentAsset(), REPAIR_MAX_PIXELS);
}

function cloudCandidateInput() {
  return cloudEditInput(store.session.assets, currentAsset());
}

function repairInputAsset() {
  return cloudRepairInput().asset;
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
      draft[key] = value;
      break;
    case "colors":
      draft.colors = Number(value);
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
    case "cloudConsentUpload":
    case "cloudConsentCharge":
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
  // 每笔对应页面上的一条路径：继续画时只改它的 d，不重建元素。
  const strokeNodes = new Map();
  const addPoint = (stroke, point) => {
    if (stroke.points.length >= MASK_MAX_POINTS || totalPoints() >= MASK_MAX_POINTS) return false;
    // 采样点太密没有意义：先按笔刷大小抽稀，笔迹更顺，提交的点位也少。
    const last = stroke.points[stroke.points.length - 1];
    const step = Math.max(1.2, stroke.radius * 0.15);
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < step) return false;
    stroke.points.push({ x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 });
    if (svg) {
      const node = strokeNodes.get(stroke);
      if (node) {
        const d = strokePath(stroke.points);
        for (const path of node.querySelectorAll("path")) path.setAttribute("d", d);
      } else {
        svg.insertAdjacentHTML("beforeend", maskStrokeMarkup(stroke));
        if (svg.lastElementChild) strokeNodes.set(stroke, svg.lastElementChild);
      }
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

/** 颜色提取：POST /jobs/extract，只生成蒙版、透明 PNG 与外轮廓，不矢量化。 */
async function runExtract(api) {
  const asset = currentAsset();
  if (!asset) return;
  if (!isImageLike(asset)) {
    api.toast("当前资产不能作为颜色提取输入，请先选一张支持的图片资产。", "warn");
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
  await startJob(api, () => http.extract({ input_asset_id: asset.asset_id, ...extract }), (final) => {
    const produced = final.result?.assets || [];
    const transparent = produced.find((entry) => entry.kind === "transparent_png");
    if (transparent) store.setCurrentAsset(transparent.asset_id);
    const kinds = [...new Set(produced.map((entry) => kindLabel(entry.kind)))];
    ui.notice = `颜色提取完成：${kinds.join("、") || "无产物"}。${
      transparent ? "已把透明 PNG 设为当前资产，可到 06 修正、再到 07 矢量化。" : ""
    }`;
    api.toast("颜色提取完成。", "done");
  });
}

/**
 * 云端线稿请求体：契约只允许 input_asset_id 与两项显式同意；
 * 不带 size、提示词、模型或端点，这些由服务端在提交时形成快照。
 * 产物是单张 lineart PNG，不自动矢量化。
 */
function buildCloudLineartPayload(assetId) {
  return {
    input_asset_id: assetId,
    consent_to_upload: true,
    consent_to_charge: true,
  };
}

/**
 * 本机线稿请求体：只包含 input_asset_id 与 method。
 * method:"model" 时不能携带任何 OpenCV 选项（local/med/min_area 等）。
 */
function buildLineartPayload(assetId, method = "opencv") {
  return {
    input_asset_id: assetId,
    method: method === "model" ? "model" : "opencv",
  };
}

/**
 * 云端候选请求体：只发送规范输入、显式同意、尺寸与矢量参数。
 * 不携带提示词、模型或端点；这些由服务端在提交时形成快照。
 */
function buildCandidatePayload(assetId, draftLike = {}) {
  const local = draftLike || {};
  return {
    input_asset_id: assetId,
    consent_to_upload: true,
    consent_to_charge: true,
    size: local.candSize || "1K",
    vector: {
      mode: "color",
      max_colors: local.candColors || 4,
      detail: local.candDetail || "low",
    },
  };
}

/** 选层合成请求体：复用已归档候选层，不回传云端输入。 */
function buildComposePayload(decompositionJobId, layerIds, draftLike = {}) {
  const local = draftLike || {};
  return {
    decomposition_job_id: decompositionJobId,
    layer_ids: [...layerIds],
    vector: {
      mode: "color",
      max_colors: local.candColors || 4,
      detail: local.candDetail || "low",
    },
  };
}

function candidateVector(draftLike = {}) {
  const local = draftLike || {};
  return { mode: "color", max_colors: local.candColors || 4, detail: local.candDetail || "low" };
}

/** 首次选层：POST /pipelines/{id}/continue，关闭等待用户的流程并生成合成任务。 */
function buildContinuePayload(flow, layerIds, draftLike = {}) {
  return {
    revision: Number(flow?.revision) || 0,
    action: "select_layers",
    layer_ids: [...layerIds],
    vector: candidateVector(draftLike),
  };
}

/** 已做过选择后的重合成：POST /pipelines/{id}/rerun，只创建本地分支。 */
function buildRerunComposePayload(flow, layerIds, draftLike = {}) {
  return {
    revision: Number(flow?.revision) || 0,
    action: "compose",
    layer_ids: [...layerIds],
    vector: candidateVector(draftLike),
  };
}

/** 从按图历史里选本次会话可恢复的云端流程（优先可用/进行中，其次最新）。 */
function pickCandidateFlow(flows, assetIds) {
  const ids = assetIds instanceof Set ? assetIds : new Set(assetIds || []);
  let fallback = null;
  for (const flow of flows || []) {
    if (!flow || flow.kind !== "ai_pipeline" || !flow.pipeline_id || !flow.decomposition_job_id) continue;
    if (ids.size && !ids.has(flow.input_asset_id)) continue;
    if (flowCanCompose(flow) || flowActiveJobId(flow)) return flow;
    if (!fallback) fallback = flow;
  }
  return fallback;
}

/** 流程是否还有可轮询的任务；只读已有 job，不重新提交。 */
function flowActiveJobId(flow) {
  if (!flow) return "";
  if (!["decomposing", "queued", "running", "continuing"].includes(String(flow.state))) return "";
  return flow.continuation_job_id || flow.decomposition_job_id || "";
}

function flowDecisionAction(flow) {
  return flow?.decision && typeof flow.decision === "object" ? String(flow.decision.action || "") : "";
}

function flowCanCompose(flow) {
  if (!flow) return false;
  const action = flowDecisionAction(flow);
  const archived = flow.recovery?.can_compose !== false;
  return action ? action === "select_layers" && archived : Boolean(flow.recovery?.can_compose);
}

/** 恢复勾选：优先最近一次本地重跑分支的层，其次首次 continue 的选择。 */
function candidateSelectionForFlow(flow) {
  const branches = Array.isArray(flow?.branches) ? flow.branches : [];
  for (let index = branches.length - 1; index >= 0; index -= 1) {
    const branch = branches[index];
    const layers = branch?.action === "compose" ? branch?.parameters?.layer_ids : null;
    if (Array.isArray(layers) && layers.length) return layers.slice();
  }
  return Array.isArray(flow?.selected_layer_ids) ? flow.selected_layer_ids.slice() : [];
}

/**
 * 流程快照带来的勾选只在用户还没亲手改过选择时应用。
 * `touched=true` 表示当前流程里用户已经点过层，旧异步恢复/续接不能覆盖。
 */
export function selectionAfterFlowAdopt(current, flowSelection, { selection = false, touched = false } = {}) {
  const currentIds = Array.isArray(current) ? current.slice() : [];
  if (!selection || touched) return currentIds;
  return Array.isArray(flowSelection) ? flowSelection.slice() : [];
}

/** 勾选/取消一个候选层；返回新的选择数组。 */
function toggleCandidateLayer(layerId) {
  if (!layerId) return cand.selected;
  cand.selectionTouched = true;
  cand.selected = cand.selected.includes(layerId)
    ? cand.selected.filter((item) => item !== layerId)
    : [...cand.selected, layerId];
  return cand.selected;
}

/** 局部修复请求体：把界面框裁剪到规范输入像素范围，保留每次显式同意。 */
function buildRepairPayload(inputAssetId, box, dims, draftLike = {}) {
  const local = draftLike || {};
  const left = Math.round(Number(box.left) || 0);
  const top = Math.round(Number(box.top) || 0);
  const right = Math.min(dims.width, Math.round((Number(box.left) || 0) + (Number(box.width) || 0)));
  const bottom = Math.min(dims.height, Math.round((Number(box.top) || 0) + (Number(box.height) || 0)));
  return {
    input_asset_id: inputAssetId,
    bbox: { left, top, right, bottom },
    intent: local.repairIntent || "restore_small_gap",
    feather_px: Math.round(Number(local.repairFeather) || 0),
    size: local.repairSize || "1K",
    consent_to_upload: true,
    consent_to_charge: true,
  };
}

/** 每次云端提交成功后清空勾选，下一次调用必须重新确认上传与调用。 */
function resetCandidateConsent() {
  draft.consentUpload = false;
  draft.consentCharge = false;
}

function resetRepairConsent() {
  draft.repairConsentUpload = false;
  draft.repairConsentCharge = false;
}

function resetCloudConsent() {
  draft.cloudConsentUpload = false;
  draft.cloudConsentCharge = false;
}

/** 线稿资产的来源信息：云端产物记录 method=cloud、provider_call_id、prompt_version。 */
function lineartMeta(asset) {
  const params = asset?.parameters || {};
  return {
    method: String(params.method || asset?.method || ""),
    providerCallId: String(params.provider_call_id || asset?.provider_call_id || ""),
    promptVersion: String(params.prompt_version || asset?.prompt_version || ""),
  };
}

function lineartNotice(asset, sourceLabelText) {
  const meta = lineartMeta(asset);
  const bits = [];
  if (meta.method === "cloud") bits.push("云端模型");
  if (meta.promptVersion) bits.push(`提示词 ${meta.promptVersion}`);
  if (meta.providerCallId) bits.push(`调用 ${shortId(meta.providerCallId)}`);
  return `${sourceLabelText}线稿 PNG 已生成${bits.length ? `（${bits.join(" · ")}）` : ""}，已设为当前资产；请人工核对，确认后到 07 矢量化。`;
}

/** 本地模型线稿：POST /jobs/lineart method=model，只出 PNG，不自动矢量化。 */
async function runLocalLineart(api) {
  const asset = currentAsset();
  if (!asset) return;
  if (!isImageLike(asset)) {
    api.toast("当前资产不能作为本地模型输入，请先选一张支持的图片资产。", "warn");
    return;
  }
  await startJob(api, () => http.lineart(buildLineartPayload(asset.asset_id, "model")), (final) => {
    const produced = (final.result?.assets || []).find((entry) => entry.kind === "lineart") || null;
    if (produced) {
      store.setCurrentAsset(produced.asset_id);
      ui.notice = lineartNotice(produced, "本地模型");
      api.toast("本地模型线稿已生成。", "done");
    } else {
      ui.notice = "本地模型任务完成，但没有返回线稿 PNG。";
      api.toast("没有返回线稿 PNG。", "warn");
    }
  });
}

/** OpenCV 线稿：POST /jobs/lineart method=opencv，本机执行，不调用云端。 */
async function runOpenLineart(api) {
  const asset = currentAsset();
  if (!asset) return;
  if (!isImageLike(asset)) {
    api.toast("当前资产不能作为 OpenCV 线稿输入，请先选一张支持的图片资产。", "warn");
    return;
  }
  await startJob(api, () => http.lineart(buildLineartPayload(asset.asset_id, "opencv")), (final) => {
    const produced = (final.result?.assets || []).find((entry) => entry.kind === "lineart") || null;
    if (produced) {
      store.setCurrentAsset(produced.asset_id);
      ui.notice = lineartNotice(produced, "OpenCV");
      api.toast("OpenCV 线稿已生成。", "done");
    } else {
      ui.notice = "OpenCV 任务完成，但没有返回线稿 PNG。";
      api.toast("没有返回线稿 PNG。", "warn");
    }
  });
}

/**
 * 云端线稿：POST /jobs/cloud-lineart，只发送 input_asset_id 与两项显式同意。
 * 每次提交前都要重新勾选；失败不自动重发，也绝不自动矢量化。
 */
async function runCloudLineart(api) {
  if (!store.seedream?.enabled) {
    api.toast("云端未启用；本地模型、OpenCV 与颜色提取仍然可用。", "warn");
    return;
  }
  const asset = currentAsset();
  const input = cloudLineartInput(store.session.assets, asset);
  if (!input.asset) {
    api.toast(
      input.error === "unsupported"
        ? "当前资产不能作为云端线稿输入，请切换为规范输入、裁切图、工作副本、候选合成、透明 PNG 或已接受修复。"
        : "先打开一张纹样，或从纹样库打开一个资产。",
      "warn"
    );
    return;
  }
  if (input.error === "pixels") {
    api.toast("云端线稿要求 262,144–25,000,000 像素；请先裁切或创建工作副本。", "warn");
    return;
  }
  if (input.error === "aspect") {
    api.toast("云端线稿要求长宽比在 1/16–16 之间；请先裁切或创建工作副本。", "warn");
    return;
  }
  if (!draft.cloudConsentUpload || !draft.cloudConsentCharge) {
    api.toast("请先勾选上传与调用两项同意。", "warn");
    return;
  }
  const payload = buildCloudLineartPayload(input.asset.asset_id);
  const submit = () =>
    http.cloudLineart(payload).then((queued) => {
      // 服务端已接受请求；本次上传/调用同意到此用尽，下一次必须重新勾选。
      resetCloudConsent();
      repaintIfHere(api);
      return queued;
    });
  await startJob(api, submit, (final) => {
    const produced = (final.result?.assets || []).find((entry) => entry.kind === "lineart") || null;
    if (produced) {
      store.setCurrentAsset(produced.asset_id);
      ui.notice = lineartNotice(produced, "云端模型");
      api.toast("云端线稿已生成，请人工核对。", "done");
    } else {
      ui.notice = "云端线稿任务完成，但没有返回 lineart PNG；不会自动重发。";
      api.toast("云端线稿没有返回 PNG，请核对任务记录。", "warn");
    }
  });
}

/** 矢量化：只接受线稿/透明 PNG/候选合成/已接受修复，未接受候选不在可用输入里。 */
async function runVectorize(api) {
  const asset = currentAsset();
  const input = vectorInput(store.session.assets, asset);
  if (!input.asset) {
    api.toast("当前资产不能矢量化；请选择线稿 PNG、透明 PNG、候选合成或已接受修复。", "warn");
    return;
  }
  const payload = {
    input_asset_id: input.asset.asset_id,
    mode: draft.vectorMode,
    detail: draft.detail,
    max_colors: draft.colors,
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
  if (!store.seedream?.enabled) {
    api.toast("云端新生成已关闭；已有归档候选仍可读取、选层并本地合成。", "warn");
    return;
  }
  if (cand.restoring || flowActiveJobId(cand.flow)) {
    api.toast("上一次云端流程仍在处理，请等它结束或刷新后再试。", "warn");
    return;
  }
  const input = cloudCandidateInput();
  if (!input.asset) {
    api.toast(
      input.error === "pixels"
        ? "候选输入不在云端允许的 262,144–25,000,000 像素内；请先裁切或创建工作副本。"
        : input.error === "aspect"
        ? "候选输入的长宽比不在云端允许的 1/16–16 之间；请先裁切或创建工作副本。"
        : input.error === "missing"
        ? "先打开一张纹样，或从纹样库打开一个资产。"
        : "当前资产不能作为候选输入；请切换为规范输入、裁切图、工作副本、候选合成、透明 PNG 或已接受修复。",
      "warn"
    );
    return;
  }
  if (!draft.consentUpload || !draft.consentCharge) {
    api.toast("请先勾选上传与调用两项同意。", "warn");
    return;
  }
  const token = store.sessionToken();
  const payload = buildCandidatePayload(input.asset.asset_id, draft);
  // 不在提交前清空旧候选：新请求失败时仍可用上一次的层继续合成。
  cand.error = "";
  let createdFlow = null;
  const wrap = http.aiPipeline(payload).then((flow) => {
    createdFlow = flow;
    // 新流程已建立：允许刷新后按图恢复它（即使本次任务随后失败）。
    lastRestoredFlowKey = "";
    // 服务端已接受请求；本次上传/调用同意到此用尽，下一次必须重新勾选。
    resetCandidateConsent();
    repaintIfHere(api);
    return { ...flow, job_id: flow?.decomposition_job_id || flow?.job_id || "" };
  });
  await startJob(api, () => wrap, async (final) => {
    if (createdFlow?.pipeline_id) {
      const fresh = await refreshCandidateFlow(api, createdFlow.pipeline_id, token);
      const flow = fresh || createdFlow;
      await adoptCandidateFlow(api, flow, token, { selection: true });
      lastRestoredFlowKey = `${token}:${store.session.imageId}`;
      if (flowActiveJobId(flow) && !cand.error) {
        await resumeCandidateJob(api, flow, token);
        if (ui.error) return;
      }
    } else {
      await fetchLayers(api, final.job_id);
    }
    const count = cand.layers.length;
    if (cand.error) {
      ui.notice = cand.error;
      api.toast(cand.error, "warn");
    } else if (count) {
      ui.notice = `云端候选层已生成：${count} 层，请勾选要合成的层。`;
      api.toast("候选层已生成。", "done");
    } else {
      ui.notice = "云端拆分任务完成，但没有返回可合成的候选层。";
      api.toast("没有返回可合成的候选层。", "warn");
    }
  });
}

/** 无流程记录时的兼容路径：直接复用已归档层合成，不发起云端调用。 */
async function composeArchivedCandidate(api) {
  const payload = buildComposePayload(cand.jobId, cand.selected, draft);
  await startJob(api, () => http.composeLayers(payload), async (final) => {
    const produced = (final.result?.assets || []).find((entry) => entry.kind === "composed_candidate");
    if (produced) {
      store.setCurrentAsset(produced.asset_id);
      ui.notice = "候选合成本地完成，已把合成候选设为当前资产。";
      api.toast("候选合成完成。", "done");
    } else {
      ui.notice = "候选合成任务完成，但没有返回合成候选。";
      api.toast("候选合成完成，但没有返回合成候选。", "warn");
    }
  });
}

async function composeLayers(api) {
  if (!cand.layers.length || !cand.selected.length) {
    api.toast("至少选一层候选才能合成。", "warn");
    return;
  }
  const flowId = cand.flow?.pipeline_id || "";
  if (!flowId) {
    await composeArchivedCandidate(api);
    return;
  }
  const token = store.sessionToken();
  let flow = await refreshCandidateFlow(api, flowId, token);
  if (!flow) {
    repaintIfHere(api);
    return;
  }
  cand.error = "";
  if (flow.recovery?.needs_reconcile) {
    cand.error = "上一次云端调用结果尚未确认；请先在任务记录中核对，不会自动重发。";
    repaintIfHere(api);
    return;
  }
  const blocked = flowDecisionAction(flow);
  if (blocked && blocked !== "select_layers") {
    cand.error = "这个云端流程已选择本地处理或已拒绝，不能再合成候选。";
    repaintIfHere(api);
    return;
  }
  if (flowActiveJobId(flow)) {
    cand.error = "云端流程仍在处理，请等已有任务结束后再合成。";
    repaintIfHere(api);
    return;
  }
  let useRerun = flowDecisionAction(flow) === "select_layers";
  const submit = async () => {
    if (!useRerun) {
      try {
        const response = await http.continuePipeline(flowId, buildContinuePayload(flow, cand.selected, draft));
        const jobId = response?.continuation_job_id || "";
        if (!jobId) throw new Error("云端流程没有返回合成任务。");
        flow = response;
        return { ...response, job_id: jobId };
      } catch (error) {
        // 流程可能已被自动选层或另一处操作推进：重读后改走本地重跑。
        if (error?.status === 409 || error?.code === "STALE_REVISION" || error?.code === "DECISION_NOT_AVAILABLE") {
          const fresh = await refreshCandidateFlow(api, flowId, token);
          if (fresh && flowDecisionAction(fresh) === "select_layers") {
            flow = fresh;
            useRerun = true;
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
    }
    return await http.rerunPipeline(flowId, buildRerunComposePayload(flow, cand.selected, draft));
  };
  await startJob(api, submit, async (final) => {
    const produced = (final.result?.assets || []).find((entry) => entry.kind === "composed_candidate");
    if (produced) store.setCurrentAsset(produced.asset_id);
    const fresh = await refreshCandidateFlow(api, flowId, token);
    if (fresh) {
      flow = fresh;
      cand.flow = fresh;
      cand.flowId = fresh.pipeline_id;
      cand.jobId = fresh.decomposition_job_id || cand.jobId;
      cand.selected = selectionAfterFlowAdopt(cand.selected, candidateSelectionForFlow(fresh), {
        selection: true,
        touched: cand.selectionTouched,
      });
    }
    if (produced) {
      ui.notice = "候选合成本地完成，已把合成候选设为当前资产。";
      api.toast("候选合成完成。", "done");
    } else {
      ui.notice = "候选合成任务完成，但没有返回合成候选。";
      api.toast("候选合成完成，但没有返回合成候选。", "warn");
    }
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
  if (!store.seedream?.enabled) {
    api.toast("云端新生成已关闭；已有修复候选仍可接受或拒绝，纹样完整也可以直接跳过。", "warn");
    return;
  }
  const input = cloudRepairInput();
  if (!input.asset) {
    api.toast(
      input.error === "pixels"
        ? "局部修复允许 262,144–1,048,576 像素；请先裁切或创建工作副本。"
        : input.error === "aspect"
        ? "修复输入的长宽比不在云端允许的 1/16–16 之间；请先裁切或创建工作副本。"
        : input.error === "missing"
        ? "先打开一张纹样，或从纹样库打开一个资产。"
        : "当前资产不能作为修复输入；请切换为规范输入、裁切图、工作副本、候选合成、透明 PNG 或已接受修复。",
      "warn"
    );
    return;
  }
  if (!draft.repairConsentUpload || !draft.repairConsentCharge) {
    api.toast("请先勾选上传与调用两项同意。", "warn");
    return;
  }
  const dims = currentDims(input.asset);
  const box = draft.repair;
  if (!dims || !box) {
    api.toast("请设置修复区域。", "warn");
    return;
  }
  if (dims.width * dims.height > REPAIR_MAX_PIXELS) {
    api.toast("局部修复最多支持 1024 × 1024 像素，请先准备更小的输入。", "warn");
    return;
  }
  const payload = buildRepairPayload(input.asset.asset_id, box, dims, draft);
  const { left, top, right, bottom } = payload.bbox;
  if (right <= left || bottom <= top) {
    api.toast("修复区域必须是正面积。", "warn");
    return;
  }
  draft.repairSkipped = false;
  const submit = () =>
    http.repair(payload).then((queued) => {
      // 服务端已接受请求；本次上传/调用同意到此用尽，下一次必须重新勾选。
      resetRepairConsent();
      repaintIfHere(api);
      return queued;
    });
  await startJob(api, submit, async (final) => {
    repairState.info = null;
    repairState.error = "";
    const info = await fetchRepair(api, final.job_id);
    if (info) {
      ui.notice = "修复候选已生成，请选择接受或拒绝。";
      api.toast("修复候选已生成。", "done");
    } else {
      ui.notice = "修复任务完成，但候选信息读取失败；请重新读取或到纹样库查看。";
      api.toast("修复候选信息读取失败。", "warn");
    }
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
        ui.notice = "这次修复之前已被拒绝，没有生成新资产。";
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
    ui.notice = "已拒绝这次修复，没有生成新资产。";
    api.toast(ui.notice, "info");
    repaintIfHere(api);
    return;
  }
  draft.repairSkipped = false;
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
    case "toggle-group": {
      const open = el.getAttribute("aria-expanded") !== "false";
      const key = el.dataset.group || "";
      el.setAttribute("aria-expanded", open ? "false" : "true");
      const grid = el.closest(".wb-group")?.querySelector(".wb-group__grid");
      if (grid) grid.hidden = open;
      if (key) {
        if (open) collapsedGroups.add(key);
        else collapsedGroups.delete(key);
      }
      break;
    }
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
      patchStage(api, root, { stage: 8 });
      api.toast("在 08 勾选要导出的资产，并勾选许可证确认。", "info");
      break;
    case "go-vector":
      patchStage(api, root, { stage: 7 });
      api.toast("矢量化在 07：先选线稿或透明 PNG，再调整颜色与细节。", "info");
      break;
    case "go-process":
      patchStage(api, root, { stage: 5 });
      api.toast("在 05 明确选择本地模型或云端模型生成线稿。", "info");
      break;
    case "skip-repair":
      draft.repairSkipped = !draft.repairSkipped;
      ui.error = "";
      ui.errorDetail = "";
      if (draft.repairSkipped) {
        resetRepairConsent();
        ui.notice = "已跳过修复：纹样按完整处理，不生成修复候选，也不会调用云端。";
        api.toast("已跳过修复。", "info");
      } else {
        ui.notice = "已恢复修复，可以重新生成候选。";
        api.toast("已恢复修复。", "info");
      }
      repaint(root, api);
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
    case "run-extract":
      runExtract(api);
      break;
    case "run-model-lineart":
      runLocalLineart(api);
      break;
    case "run-cloud-lineart":
      runCloudLineart(api);
      break;
    case "run-opencv-lineart":
      runOpenLineart(api);
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
      toggleCandidateLayer(el.dataset.id);
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
    // 同一节点重复 mount（竞态重绘/重复刷新）只挂一次事件与订阅；
    // 否则一次点击会被两个 handleClick 处理，勾选先加后删。
    if (mountedRoot === wb) return;
    mountedRoot = wb;

    wb.addEventListener("click", (event) => handleClick(wb, state, api, event));
    wb.addEventListener("input", (event) => handleInput(wb, state, api, event));
    wb.addEventListener("change", (event) => handleChange(wb, state, api, event));

    bindCompare(wb, api);
    bindCrop(wb, state, api);
    bindMask(wb, state, api);
    revealCurrentThumb(wb);

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
    // 刷新/重进工作台时按图恢复最近的云端候选流程与修复候选；只读历史与归档层。
    restoreCandidateFlow(api);
    restoreRepairState(api);
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
    if (mountedRoot) mountedRoot = null;
  },
};

/* 供 node:test 直接导入的行为纯函数；默认导出保持不变。 */
export {
  adoptCandidateFlow,
  assetParamLine,
  buildCandidatePayload,
  buildCloudLineartPayload,
  buildComposePayload,
  buildContinuePayload,
  buildLineartPayload,
  buildRepairPayload,
  buildRerunComposePayload,
  candidateSelectionForFlow,
  composeLayers,
  flowActiveJobId,
  flowCanCompose,
  flowDecisionAction,
  groupAssets,
  pickCandidateFlow,
  restoreCandidateFlow,
  restoreRepairState,
  runCandidate,
  runCloudLineart,
  startJob,
  taskOutcomeCopy,
  toggleCandidateLayer,
};

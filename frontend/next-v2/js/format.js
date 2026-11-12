/* =============================================================================
   format.js — 把后端的英文 kind / code / 时间 / 单位换成界面中文。
   只做纯函数映射，不碰 DOM，不发请求。
   ============================================================================= */

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const KIND_LABELS = {
  original: "原图",
  normalized_input: "规范输入",
  normalized: "规范输入",
  crop: "裁切",
  cropped: "裁切",
  prepared: "图像准备",
  prepare: "图像准备",
  working_copy: "工作副本",
  enhanced: "轻增强",
  enhance: "轻增强",
  foreground_mask: "前景蒙版",
  mask: "前景蒙版",
  transparent_png: "透明 PNG",
  foreground: "透明 PNG",
  contour_line_art: "轮廓线稿",
  contour: "轮廓线稿",
  lineart: "线稿 PNG",
  svg: "矢量 SVG",
  monochrome_svg: "黑白 SVG",
  color_svg: "彩色 SVG",
  export: "ZIP 包",
  archive: "ZIP 包",
  zip: "ZIP 包",
  tile_preview: "平铺预览",
  tile: "平铺预览",
  ai_layer: "云端候选层",
  generated_layer: "云端候选层",
  composed_candidate: "候选合成",
  repair_composite: "修复局部保护版",
  accepted_repair: "已接受修复",
  repair_candidate: "修复全图候选",
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || String(kind || "资产");
}

/** 资产大致属于哪一道工序，用于“在哪个阶段打开它”。 */
export function stageForKind(kind) {
  switch (kind) {
    case "original":
    case "normalized_input":
    case "normalized":
      return 1;
    case "crop":
    case "cropped":
    case "prepared":
    case "working_copy":
    case "enhanced":
      return 2;
    case "foreground_mask":
    case "mask":
    case "transparent_png":
    case "foreground":
    case "contour_line_art":
    case "contour":
    case "lineart":
    case "svg":
    case "monochrome_svg":
    case "color_svg":
      return 3;
    case "tile_preview":
    case "tile":
      return 7;
    case "ai_layer":
    case "generated_layer":
    case "composed_candidate":
      return 4;
    case "repair_composite":
    case "accepted_repair":
    case "repair_candidate":
      return 6;
    default:
      return 1;
  }
}

/** 任务类型大致落在哪一道工序；一键处理从提取开始，算第 3 道。 */
const JOB_STAGE = {
  crop: 2,
  "working-copy": 2,
  working_copy: 2,
  prepare: 2,
  enhance: 2,
  extract: 3,
  pipeline: 3,
  lineart: 3,
  vectorize: 3,
  "ai-pipeline": 4,
  compose: 4,
  "compose-layers": 4,
  "refine-mask": 5,
  repair: 6,
  "tile-preview": 7,
  export: 7,
};

export function stageForJobKind(kind) {
  return JOB_STAGE[kind] || 0;
}

/**
 * 一个任务走到第几道工序：任务类型与它已经发布的产物里更靠后的一步。
 * 失败或取消的任务同样按已发布的产物计，界面据此如实显示停在哪一步。
 */
export function stageForJob(job) {
  if (!job) return 0;
  const produced = (job.result?.assets || []).map((asset) => stageForKind(asset.kind));
  return Math.max(stageForJobKind(job.kind), ...produced, 0);
}

export function canPreview(kind, suffix = "") {
  if (["export", "archive", "zip"].includes(kind)) return false;
  return [".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"].includes(String(suffix).toLowerCase());
}

export function formatTime(value, { withDate = false } = {}) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (!withDate) return time;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export function relativeTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return formatTime(value, { withDate: true });
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function dimsOf(asset) {
  if (!asset || !asset.width || !asset.height) return "—";
  return `${asset.width} × ${asset.height}`;
}

export function pixelsOf(asset) {
  if (!asset || !asset.width || !asset.height) return 0;
  return asset.width * asset.height;
}

export function gradeLabel(grade) {
  const map = { A: "A 级", B: "B 级", C: "C 级", U: "未分级" };
  return map[grade] || "未分级";
}

export function licenseLabel(license) {
  if (!license || license === "未确认") return "未登记";
  return license;
}

export function splitLabel(split) {
  const map = { train: "训练", val: "验证", test: "测试", unassigned: "未划分" };
  return map[split] || "未划分";
}

export function sourceLabel(meta = {}) {
  if (meta.source_name) return meta.source_name;
  if (meta.source_type && meta.source_type !== "未确认") return meta.source_type;
  return "来源未登记";
}

export function progressOf(job) {
  if (!job) return 0;
  if (job.state === "succeeded") return 100;
  const steps = job.result?.steps || [];
  if (!steps.length) return job.state === "running" ? 12 : 4;
  const done = steps.filter((step) => step.state === "succeeded").length;
  return Math.max(6, Math.round((done / steps.length) * 100));
}

export function jobStateLabel(state) {
  const map = {
    queued: "排队中",
    running: "处理中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return map[state] || "未知状态";
}

export function blockerLabel(code) {
  const map = {
    API_KEY_MISSING: "未填写 API Key",
    PAID_CALLS_DISABLED: "付费开关未开启",
    PRICING_NOT_CONFIRMED: "价格未确认",
    BUDGET_NOT_CONFIGURED: "预算未设置",
    RESERVATION_NOT_CONFIGURED: "单次预留未设置",
    MAX_CALLS_NOT_CONFIGURED: "调用上限未设置",
  };
  return map[code] || code;
}

export function jobKindLabel(kind) {
  const map = {
    crop: "裁切",
    prepare: "图像准备",
    "working-copy": "工作副本",
    working_copy: "工作副本",
    enhance: "轻增强",
    extract: "前景提取",
    lineart: "线稿",
    vectorize: "矢量化",
    pipeline: "一键处理",
    "refine-mask": "蒙版修正",
    "tile-preview": "平铺预览",
    export: "导出",
    repair: "局部修复",
    "ai-pipeline": "云端候选",
    compose: "候选合成",
  };
  return map[kind] || kind;
}

export function shortId(value) {
  const text = String(value || "");
  return text.length > 8 ? text.slice(0, 8) : text;
}

export function roleLabel(role) {
  const map = {
    original: "原件",
    lineart_rgb: "线稿输入",
    source_rgb: "源图",
    foreground_mask: "前景蒙版",
    source_mask: "源蒙版",
  };
  return map[role] || role;
}

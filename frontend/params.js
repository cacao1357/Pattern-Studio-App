"use strict";

/* Parameter vocabulary and validation for the local workbench.
 *
 * This module is deliberately DOM-free: the page reads controls, this module
 * decides what the API accepts and which fields belong to the chosen method.
 * It mirrors backend/app/schemas/workbench.py:
 *   - adaptive_mean / adaptive_gaussian / sauvola local thresholds
 *   - window_size odd 3..255 (default 31), offset -50..50 (default 10)
 *   - clahe bool (default false), min_component_area / max_hole_area 0..10000
 *   - enhance brightness / contrast both 0.2..3 (default 1)
 * Existing-alpha extraction preserves the source alpha and rejects cleanup.
 */

export const EXTRACT_DEFAULTS = Object.freeze({
  mode: "otsu",
  polarity: "dark",
  threshold: 127,
  iterations: 5,
  window_size: 31,
  offset: 10,
  clahe: false,
  min_component_area: 0,
  max_hole_area: 0
});

export const EXTRACT_MODE_INFO = Object.freeze({
  alpha: Object.freeze({
    value: "alpha",
    label: "既有 Alpha",
    short: "Alpha",
    hint: "保留源文件的透明边缘，不使用阈值、清理或 CLAHE。透明输入前后接近是正常保真。",
    threshold: false,
    window: false,
    offset: false,
    clahe: false,
    cleanup: false,
    bbox: false,
    iterations: false
  }),
  otsu: Object.freeze({
    value: "otsu",
    label: "Otsu",
    short: "Otsu",
    hint: "按全图明暗自动选择分界；可先做局部对比预处理。",
    threshold: false,
    window: false,
    offset: false,
    clahe: true,
    cleanup: true,
    bbox: false,
    iterations: false
  }),
  manual: Object.freeze({
    value: "manual",
    label: "手动阈值",
    short: "手动",
    hint: "按指定的 0–255 分界与前景极性分离。",
    threshold: true,
    window: false,
    offset: false,
    clahe: true,
    cleanup: true,
    bbox: false,
    iterations: false
  }),
  adaptive_mean: Object.freeze({
    value: "adaptive_mean",
    label: "自适应均值",
    short: "局部均值",
    hint: "按局部邻域均值决定分界，适合光照不均的细线；可能掏空大面积色块。",
    threshold: false,
    window: true,
    offset: true,
    clahe: true,
    cleanup: true,
    bbox: false,
    iterations: false
  }),
  adaptive_gaussian: Object.freeze({
    value: "adaptive_gaussian",
    label: "自适应高斯",
    short: "局部高斯",
    hint: "按局部高斯加权决定分界，适合光照不均的细线；可能掏空大面积色块。",
    threshold: false,
    window: true,
    offset: true,
    clahe: true,
    cleanup: true,
    bbox: false,
    iterations: false
  }),
  sauvola: Object.freeze({
    value: "sauvola",
    label: "Sauvola",
    short: "Sauvola",
    hint: "扫描线稿的补充候选；可能把纸纹当前景，也可能掏空大色块，需与基线对照。",
    threshold: false,
    window: true,
    offset: true,
    clahe: true,
    cleanup: true,
    bbox: false,
    iterations: false
  }),
  grabcut: Object.freeze({
    value: "grabcut",
    label: "框选 GrabCut",
    short: "GrabCut",
    hint: "需要有效矩形；框外按背景处理，仍可做小区域清理。",
    threshold: false,
    window: false,
    offset: false,
    clahe: false,
    cleanup: true,
    bbox: true,
    iterations: true
  })
});

export const EXTRACT_MODES = Object.freeze(Object.keys(EXTRACT_MODE_INFO));

export const ENHANCE_LIMITS = Object.freeze({
  brightness: Object.freeze({ min: 0.2, max: 3, step: 0.05, default: 1 }),
  contrast: Object.freeze({ min: 0.2, max: 3, step: 0.05, default: 1 }),
  sharpen: Object.freeze({ min: 0, max: 1, step: 0.05, default: 0 })
});

export const DENOISE_LABELS = Object.freeze({ 0: "关闭", 1: "3×3 中值", 2: "5×5 中值" });

export function modeInfo(mode) {
  return EXTRACT_MODE_INFO[String(mode || "")] || EXTRACT_MODE_INFO.otsu;
}

/** Only a true backend flag recommends Alpha; missing/false is never guessed. */
export function recommendExtractMode(context = {}) {
  return context.hasTransparency === true ? "alpha" : "";
}

export function defaultExtractOptions() {
  return { ...EXTRACT_DEFAULTS };
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeInteger(value, fallback) {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) ? number : fallback;
}

function normalizeNumber(value, fallback) {
  const number = finiteNumber(value);
  return number !== null ? number : fallback;
}

/** Fill a raw payload/history record with defaults without dropping unknown fields. */
export function normalizeExtractOptions(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const mode = EXTRACT_MODES.includes(source.mode) ? source.mode : EXTRACT_DEFAULTS.mode;
  return {
    ...source,
    mode,
    polarity: source.polarity === "light" ? "light" : "dark",
    threshold: normalizeInteger(source.threshold, EXTRACT_DEFAULTS.threshold),
    iterations: normalizeInteger(source.iterations, EXTRACT_DEFAULTS.iterations),
    window_size: normalizeInteger(source.window_size, EXTRACT_DEFAULTS.window_size),
    offset: normalizeNumber(source.offset, EXTRACT_DEFAULTS.offset),
    clahe: Boolean(source.clahe),
    min_component_area: normalizeInteger(source.min_component_area, EXTRACT_DEFAULTS.min_component_area),
    max_hole_area: normalizeInteger(source.max_hole_area, EXTRACT_DEFAULTS.max_hole_area)
  };
}

/**
 * Validate an extraction option draft.
 * `bbox` is validated by the caller against the current asset, but grabcut
 * must have one before this returns ok.
 */
export function validateExtractOptions(raw) {
  const value = normalizeExtractOptions(raw);
  if (!EXTRACT_MODES.includes(raw && raw.mode)) {
    return { ok: false, error: "请选择有效的提取方式。" };
  }
  if (!["dark", "light"].includes(raw && raw.polarity)) {
    return { ok: false, error: "请选择前景极性。" };
  }
  if (!Number.isInteger(value.window_size) || value.window_size < 3 || value.window_size > 255) {
    return { ok: false, error: "局部窗口必须是 3–255 之间的整数。" };
  }
  if (value.window_size % 2 === 0) {
    return { ok: false, error: "局部窗口必须是奇数，例如 31 或 51。" };
  }
  if (value.offset < -50 || value.offset > 50) {
    return { ok: false, error: "局部偏移必须在 -50–50 之间。" };
  }
  for (const [field, label] of [["min_component_area", "最小连通面积"], ["max_hole_area", "最大孔洞面积"]]) {
    const number = value[field];
    if (!Number.isInteger(number) || number < 0 || number > 10000) {
      return { ok: false, error: label + "必须是 0–10000 之间的整数。" };
    }
  }
  if (typeof value.clahe !== "boolean") {
    return { ok: false, error: "局部对比开关状态无效。" };
  }
  const info = modeInfo(value.mode);
  if (info.threshold) {
    if (!Number.isInteger(value.threshold) || value.threshold < 0 || value.threshold > 255) {
      return { ok: false, error: "阈值必须是 0–255 之间的整数。" };
    }
  }
  if (info.iterations) {
    if (!Number.isInteger(value.iterations) || value.iterations < 1 || value.iterations > 10) {
      return { ok: false, error: "迭代次数必须是 1–10 之间的整数。" };
    }
  }
  if (info.bbox && !value.bbox) {
    return { ok: false, error: "GrabCut 需要有效框选。请拖拽或填写四个坐标。" };
  }
  if (value.mode === "alpha" && (value.clahe || value.min_component_area > 0 || value.max_hole_area > 0)) {
    return { ok: false, error: "既有 Alpha 保留源透明度，不能同时启用 CLAHE 或区域清理。" };
  }
  return { ok: true, value };
}

/**
 * Build the request body containing only parameters the chosen method uses.
 * Sending irrelevant defaults would imply they changed the result.
 */
export function extractPayload(raw) {
  const validation = validateExtractOptions(raw);
  if (!validation.ok) return validation;
  const value = validation.value;
  const info = modeInfo(value.mode);
  const payload = { mode: value.mode, polarity: value.polarity };
  if (info.threshold) payload.threshold = value.threshold;
  if (info.iterations) payload.iterations = value.iterations;
  if (info.bbox && value.bbox) {
    payload.bbox = {
      left: Number(value.bbox.left),
      top: Number(value.bbox.top),
      right: Number(value.bbox.right),
      bottom: Number(value.bbox.bottom)
    };
  }
  if (value.mode !== "alpha") {
    if (info.clahe) payload.clahe = Boolean(value.clahe);
    if (info.window) {
      payload.window_size = value.window_size;
      payload.offset = value.offset;
    }
    if (info.cleanup) {
      payload.min_component_area = value.min_component_area;
      payload.max_hole_area = value.max_hole_area;
    }
  }
  return { ok: true, value, payload };
}

export function validateEnhanceOptions(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const brightness = finiteNumber(source.brightness);
  const contrast = finiteNumber(source.contrast);
  const denoise = normalizeInteger(source.denoise, 0);
  const sharpen = finiteNumber(source.sharpen);
  if (brightness === null || brightness < ENHANCE_LIMITS.brightness.min || brightness > ENHANCE_LIMITS.brightness.max) {
    return { ok: false, error: "亮度必须在 0.2–3.0 之间。" };
  }
  if (contrast === null || contrast < ENHANCE_LIMITS.contrast.min || contrast > ENHANCE_LIMITS.contrast.max) {
    return { ok: false, error: "对比度必须在 0.2–3.0 之间。" };
  }
  if (![0, 1, 2].includes(denoise)) {
    return { ok: false, error: "降噪必须是关闭、3×3 或 5×5 中值。" };
  }
  if (sharpen === null || sharpen < 0 || sharpen > 1) {
    return { ok: false, error: "锐化必须在 0–1 之间。" };
  }
  const round = (number) => Math.round(number * 100) / 100;
  return {
    ok: true,
    value: {
      brightness: round(brightness),
      contrast: round(contrast),
      denoise,
      sharpen: round(sharpen)
    }
  };
}

export function enhancePayload(raw) {
  const validation = validateEnhanceOptions(raw);
  if (!validation.ok) return validation;
  return { ok: true, value: validation.value, payload: { ...validation.value } };
}

export function isNeutralEnhance(raw) {
  const validation = validateEnhanceOptions(raw);
  if (!validation.ok) return false;
  const value = validation.value;
  return value.brightness === 1 && value.contrast === 1 && value.denoise === 0 && value.sharpen === 0;
}

/* -------------------------------------------------------------------------- */
/* Preparation geometry (mirror of backend preparation.py)                    */
/* -------------------------------------------------------------------------- */

function round15(value) {
  return Math.round(value * 1e15) / 1e15;
}

function straightenDimensions(width, height, degrees) {
  // Python's % is non-negative; normalize before the same reverse-affine
  // corner-bounds calculation used by backend _straighten_geometry.
  const normalized = (((Number(degrees) % 360) + 360) % 360);
  const angle = -(normalized * Math.PI / 180);
  const cosine = round15(Math.cos(angle));
  const sine = round15(Math.sin(angle));
  const yCosine = round15(-Math.sin(angle));
  const ySine = round15(Math.cos(angle));
  const centerX = width / 2;
  const centerY = height / 2;
  const tx = cosine * -centerX + sine * -centerY + centerX;
  const ty = yCosine * -centerX + ySine * -centerY + centerY;
  const corners = [[0, 0], [width, 0], [width, height], [0, height]]
    .map(([x, y]) => [
      cosine * x + sine * y + tx,
      yCosine * x + ySine * y + ty
    ]);
  const xs = corners.map((point) => point[0]);
  const ys = corners.map((point) => point[1]);
  return [
    Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs)),
    Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys))
  ];
}

/**
 * Predict `prepare_image` output for the current input size.
 * Straightening is applied after the right-angle rotation, with Pillow's
 * expand=True corner bounds. Returns null for invalid values.
 */
export function predictPreparedSize(width, height, rotation = 0, straighten = 0, maxPixels = 1_000_000) {
  const w = Number(width);
  const h = Number(height);
  const turn = Number(rotation);
  const angle = Number(straighten);
  if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) return null;
  if (![0, 90, 180, 270].includes(turn)) return null;
  if (!Number.isFinite(angle) || angle < -15 || angle > 15) return null;
  const rotatedWidth = turn === 90 || turn === 270 ? h : w;
  const rotatedHeight = turn === 90 || turn === 270 ? w : h;
  const expanded = angle !== 0;
  const [outWidth, outHeight] = expanded
    ? straightenDimensions(rotatedWidth, rotatedHeight, angle)
    : [rotatedWidth, rotatedHeight];
  const pixels = outWidth * outHeight;
  return {
    width: outWidth,
    height: outHeight,
    pixels,
    rotatedWidth,
    rotatedHeight,
    expanded,
    overLimit: pixels > Number(maxPixels)
  };
}

export function extractSummary(raw) {
  const value = normalizeExtractOptions(raw);
  const info = modeInfo(value.mode);
  const bits = [info.label, value.polarity === "light" ? "浅色前景" : "深色前景"];
  if (info.threshold) bits.push("阈值 " + value.threshold);
  if (info.window) bits.push("窗口 " + value.window_size, "偏移 " + formatSigned(value.offset));
  if (value.mode !== "alpha" && info.clahe && value.clahe) bits.push("CLAHE");
  if (value.mode !== "alpha" && info.cleanup) {
    if (value.min_component_area > 0) bits.push("去小区域 " + value.min_component_area);
    if (value.max_hole_area > 0) bits.push("补小孔 " + value.max_hole_area);
  }
  if (info.iterations) bits.push("迭代 " + value.iterations);
  if (info.bbox && value.bbox) {
    bits.push("框选 [" + value.bbox.left + ", " + value.bbox.top + ", " + value.bbox.right + ", " + value.bbox.bottom + ")");
  }
  return bits.filter(Boolean).join(" · ");
}

export function enhanceSummary(raw) {
  const validation = validateEnhanceOptions(raw);
  if (!validation.ok) return "增强参数";
  const value = validation.value;
  const bits = ["亮度 " + value.brightness.toFixed(2), "对比 " + value.contrast.toFixed(2)];
  if (value.denoise) bits.push("降噪 " + DENOISE_LABELS[value.denoise]);
  if (value.sharpen) bits.push("锐化 " + value.sharpen.toFixed(2));
  return bits.join(" · ");
}

function formatSigned(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return number > 0 ? "+" + number : String(number);
}

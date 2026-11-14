/* =============================================================================
   processing.js — 流程预设与持久批次的共享状态 / 纯逻辑（无 DOM）。
   约定：
   - 批次由服务端后台推进；这里只读取状态、提交新建/取消/人工续接，绝不另跑
     一套本地流程，也不自动续接或重试。
   - 人工门（裁切/修复/候选/蒙版）暂停该图，其余图片继续；界面只提供回到既有
     工作台处理、再显式选择后代资产续接的入口。
   - 预设编辑只影响之后的提交；每个批次保存提交时的快照。
   - 结果分组复用 /patterns，不新建第二份素材索引。
   ============================================================================= */

import { api } from "./api.js";
import { store } from "./store.js";

const MANUAL_STEPS = {
  crop: { label: "裁切", kind: "cropped", stage: 2 },
  repair: { label: "修复", kind: "accepted_repair", stage: 3 },
  candidates: { label: "候选合成", kind: "composed_candidate", stage: 4 },
  mask: { label: "蒙版修正", kind: "transparent_png", stage: 6 },
};

const STEP_LABELS = {
  crop: "裁切",
  repair: "修复",
  candidates: "候选合成",
  working_copy: "创建工作副本",
  model_lineart: "本地模型线稿",
  cloud_lineart: "云端线稿",
  color: "颜色提取",
  prepare_mask: "准备蒙版",
  mask: "蒙版修正",
  vectorize: "矢量化",
  tile: "平铺",
};

const RECIPE_LABELS = {
  model_lineart: "本地模型线稿 → SVG",
  cloud_lineart: "云端线稿 → SVG",
  color: "颜色提取 → SVG",
};

const RECIPE_INPUT_KINDS = {
  model_lineart: new Set([
    "normalized_input",
    "cropped",
    "working_copy",
    "prepared",
    "enhanced",
    "accepted_repair",
    "composed_candidate",
  ]),
  cloud_lineart: new Set([
    "normalized_input",
    "cropped",
    "working_copy",
    "prepared",
    "enhanced",
    "accepted_repair",
    "composed_candidate",
    "transparent_png",
  ]),
  color: new Set([
    "normalized_input",
    "cropped",
    "working_copy",
    "prepared",
    "enhanced",
    "transparent_png",
    "lineart",
    "composed_candidate",
    "accepted_repair",
  ]),
};

export const ITEM_STATE_LABELS = {
  queued: "排队中",
  running: "处理中",
  waiting: "等待人工确认",
  cancelling: "取消中",
  failed: "失败",
  succeeded: "成功",
  cancelled: "已取消",
};

export const STEP_STATE_LABELS = {
  queued: "排队",
  running: "处理中",
  waiting: "等待确认",
  succeeded: "完成",
  failed: "失败",
  cancelled: "已取消",
  pending: "等待",
  skipped: "跳过",
};

const BATCH_ERROR_TEXT = {
  BATCH_CLOUD_CONSENT_REQUIRED: "云端预设需要同时确认当批次上传与可能费用。",
  BATCH_INPUT_KIND: "所选预设不能处理这个资产类型。",
  BATCH_IMAGE_REQUIRED: "请选择属于已登记原图的输入资产。",
  BATCH_RESUME_ASSET_MISMATCH: "这个结果不是当前版本的后代，或类型不符合这一步；请在工作台生成正确结果后再选。",
  BATCH_ITEM_NOT_WAITING: "这张图当前没有待确认的人工步骤，请刷新批次。",
  BATCH_ITEM_NOT_FOUND: "找不到这张图的批次项，请刷新。",
  BATCH_NOT_FOUND: "找不到这个批次，可能已被移除。",
  PRESET_NOT_FOUND: "找不到这个预设。",
  BUILTIN_PRESET: "内置预设不能删除，可以复制或修改。",
  STALE_REVISION: "记录已被其他操作更新，已重新读取。",
  QUEUE_FULL: "队列已满，批次会等待空位后继续。",
  BATCH_OUTPUT_MISSING: "任务完成但没有发布预期产物，请检查任务记录。",
  BATCH_STEP_FAILED: "批次步骤失败，不会自动重试。",
  BATCH_PRESET_INVALID: "预设参数未通过校验。",
  IDEMPOTENCY_CONFLICT: "提交标识冲突，请重新发起。",
  INVALID_PRESET_NAME: "预设名需要 1–80 个字符。",
  BATCH_STEP_UNSUPPORTED: "预设里有当前服务不支持的步骤。",
  BATCH_RECIPE_INVALID: "预设路线与步骤不匹配，请重新保存预设。",
  PROVIDER_DISABLED: "云端尚未就绪，批次会在这一步失败；不会自动改用本地。",
  PROVIDER_OUTCOME_UNKNOWN: "云端结果未知：不会自动重试，请先到任务记录核对。",
  CANCEL_REQUIRES_RECONCILIATION: "云端调用需要先核对结果，取消会等待终态。",
};

const listeners = new Set();

export const processing = {
  presets: [],
  presetsLoading: false,
  presetsError: "",
  batches: [],
  listNextCursor: null,
  listLoading: false,
  listError: "",
  selectedBatchId: "",
  detail: null,
  detailLoading: false,
  detailError: "",
  /** imageId -> { pattern, at, loading, promise, resultCount } */
  patterns: new Map(),
  busyKey: "",
};

/* ------------------------------------------------------------------ 通知 */

export function subscribeProcessing(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyProcessing(reason = "update") {
  for (const listener of listeners) {
    try {
      listener(reason);
    } catch (error) {
      console.error("processing listener failed", error);
    }
  }
}

/* ------------------------------------------------------------------ 纯逻辑 */

export function defaultPresetOptions() {
  return {
    recipe: "color",
    extract: {
      mode: "otsu",
      polarity: "dark",
      threshold: 127,
      iterations: 5,
      window_size: 31,
      offset: 10,
      clahe: false,
      min_component_area: 0,
      max_hole_area: 0,
    },
    vector: { mode: "color", max_colors: 8, detail: "medium" },
    working_max_pixels: null,
    crop: false,
    repair: false,
    candidates: false,
    mask: false,
    vectorize: true,
    tile: false,
  };
}

export function normalizePresetOptions(options) {
  const defaults = defaultPresetOptions();
  const value = options && typeof options === "object" ? options : {};
  return {
    ...defaults,
    ...value,
    extract: { ...defaults.extract, ...(value.extract || {}) },
    vector: { ...defaults.vector, ...(value.vector || {}) },
    working_max_pixels:
      value.working_max_pixels === null || value.working_max_pixels === undefined
        ? null
        : Number(value.working_max_pixels),
  };
}

export function recipeLabel(recipe) {
  return RECIPE_LABELS[recipe] || recipe || "未选择";
}

/** 与后端 advance() 相同的步骤顺序；prepare_mask 是自动步骤，不是人工门。 */
export function presetSteps(options) {
  const opts = normalizePresetOptions(options);
  const steps = [];
  if (opts.crop) steps.push({ name: "crop", label: STEP_LABELS.crop, manual: true });
  if (opts.repair) steps.push({ name: "repair", label: STEP_LABELS.repair, manual: true });
  if (opts.candidates) steps.push({ name: "candidates", label: STEP_LABELS.candidates, manual: true });
  if (opts.working_max_pixels !== null && opts.working_max_pixels !== undefined) {
    steps.push({ name: "working_copy", label: STEP_LABELS.working_copy, manual: false });
  }
  steps.push({
    name: opts.recipe,
    label: STEP_LABELS[opts.recipe] || opts.recipe,
    manual: false,
    cloud: opts.recipe === "cloud_lineart",
  });
  if (opts.mask) {
    if (opts.recipe !== "color") {
      steps.push({ name: "prepare_mask", label: STEP_LABELS.prepare_mask, manual: false });
    }
    steps.push({ name: "mask", label: STEP_LABELS.mask, manual: true });
  }
  if (opts.vectorize) steps.push({ name: "vectorize", label: STEP_LABELS.vectorize, manual: false });
  if (opts.tile) steps.push({ name: "tile", label: STEP_LABELS.tile, manual: false });
  return steps;
}

export function manualSteps(options) {
  return presetSteps(options).filter((step) => step.manual);
}

/** 预计自动云端调用：每张图一次云端线稿；人工门里的云端操作另计。 */
export function estimateProviderCalls(options, imageCount) {
  if (normalizePresetOptions(options).recipe !== "cloud_lineart") return 0;
  return Math.max(0, Number(imageCount) || 0);
}

/* ------------------------------------------------------------------ 像素上限 */
/*
 * 上限全部从 /health.limits 读取，不在界面写死最终数值：
 * working_pixels、color_vector_pixels、model_lineart_pixels、working_copy_pixels、
 * tile_pixels。后端 working_limit(options) 取所有启用自动阶段中较低者。
 */

export function healthPixelLimits() {
  const raw = store.health?.limits;
  const value = (key) => {
    const number = Number(raw?.[key]);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
  };
  return {
    working: value("working_pixels"),
    colorVector: value("color_vector_pixels"),
    modelLineart: value("model_lineart_pixels"),
    threshold: value("threshold_pixels"),
    workingCopy: value("working_copy_pixels"),
    tile: value("tile_pixels"),
    decode: value("decode_pixels"),
  };
}

export function formatPixels(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toLocaleString("zh-CN") : "未知";
}

/** Otsu 提取有独立上限；其它提取模式仍按 working_pixels。 */
export function pixelLimitForExtractMode(mode, limits = healthPixelLimits()) {
  return mode === "otsu" ? limits.threshold : limits.working;
}

/**
 * 工作台单图路线：本地模型用专属 cap；OpenCV 用 working_pixels；
 * 颜色提取按当前提取模式区分 Otsu（threshold_pixels）与其它模式。
 */
export function pixelLimitForProcessRoute(route, limits = healthPixelLimits(), extractMode = "otsu") {
  if (route === "local" || route === "model_lineart") return limits.modelLineart;
  if (route === "opencv") return limits.working;
  if (route === "color") return pixelLimitForExtractMode(extractMode, limits);
  if (route === "cloud") return limits.decode;
  return null;
}

/**
 * 单图 /jobs/vectorize 入口上限：现有 working_pixels（所有模式）。
 * color_vector_pixels 是组合/批次颜色矢量副本的安全建议，不是这个按钮的硬上限。
 */
export function pixelLimitForVectorMode(mode, limits = healthPixelLimits()) {
  return limits.working;
}

/** 彩色矢量的组合/批次安全建议值；只用于提示，不在这里禁用单图入口。 */
export function colorVectorRecommendation(limits = healthPixelLimits()) {
  return limits.colorVector;
}

/**
 * 与后端 working_limit(options) 一致的整条路线有效上限。
 * 任一启用阶段缺少 health 字段时 complete=false，value=null；不猜最后数值。
 */
export function effectiveWorkingLimit(options, limits = healthPixelLimits()) {
  const opts = normalizePresetOptions(options);
  const caps = [];
  const add = (value) => caps.push(value === null || value === undefined ? null : Math.floor(Number(value)));
  if (opts.recipe === "model_lineart") add(limits.modelLineart);
  else if (opts.recipe === "cloud_lineart") add(limits.decode);
  else add(opts.extract.mode === "otsu" ? limits.threshold : limits.working);
  if (opts.mask) add(limits.working);
  if (opts.vectorize) add(opts.vector.mode === "color" ? limits.colorVector : limits.working);
  if (opts.tile) add(limits.tile === null || limits.tile === undefined ? null : Math.floor(limits.tile / 4));
  const known = caps.filter((value) => value !== null && Number.isFinite(value));
  const complete = caps.length > 0 && known.length === caps.length;
  return {
    value: complete ? Math.min(...known) : null,
    complete,
    partial: known.length ? Math.min(...known) : null,
    requested: opts.working_max_pixels,
    /** 显式副本实际值 = min(用户设置, 整条路线有效上限)；未设置则为 null。 */
    copy:
      opts.working_max_pixels !== null && complete
        ? Math.min(opts.working_max_pixels, Math.min(...known))
        : null,
  };
}

export function stepLabel(name) {
  return STEP_LABELS[name] || name;
}

export function expectedManualKind(waitingFor) {
  return MANUAL_STEPS[waitingFor]?.kind || "";
}

export function manualStage(waitingFor) {
  return MANUAL_STEPS[waitingFor]?.stage || 1;
}

export function manualStepLabel(waitingFor) {
  return MANUAL_STEPS[waitingFor]?.label || waitingFor || "";
}

export function batchErrorText(code) {
  return BATCH_ERROR_TEXT[code] || (code ? `批次错误：${code}` : "");
}

export function itemStateLabel(state) {
  return ITEM_STATE_LABELS[state] || state || "未知";
}

/** 队列满时 item/step 仍是 queued + queue_blocked，不能当失败显示。 */
export function stepStateLabel(step, item = null) {
  if (step?.queue_blocked) return "等待空位";
  if (step?.state === "queued" && item?.state === "queued") return "排队";
  return STEP_STATE_LABELS[step?.state] || step?.state || "等待";
}

export function batchProgress(batch) {
  const progress = batch?.progress || {};
  const counts = progress.counts || {};
  const total = Number(progress.total) || (batch?.items || []).length;
  const completed = Number(progress.completed) || 0;
  return {
    total,
    completed,
    percent: total ? Math.round((completed / total) * 100) : 0,
    succeeded: counts.succeeded || 0,
    failed: counts.failed || 0,
    cancelled: counts.cancelled || 0,
    waiting: counts.waiting || 0,
    running: counts.running || 0,
    queued: counts.queued || 0,
    cancelling: counts.cancelling || 0,
  };
}

export function isBatchActive(batch) {
  return Boolean(batch && (batch.state === "running" || batch.state === "cancelling"));
}

export function canCancelBatch(batch) {
  return Boolean(
    batch &&
      batch.state === "running" &&
      (batch.items || []).some((item) => !["succeeded", "failed", "cancelled"].includes(item.state))
  );
}

/**
 * 取消的准确说法：未启动的本地步骤可以停；已发往云端的请求无法撤回，
 * cancelling 只是等待云端终态后停止后续步骤。
 */
export function cancelNote(batch, item) {
  const state = item?.state;
  if (["succeeded", "failed", "cancelled"].includes(state)) return itemStateLabel(state);
  if (state === "waiting") return "等待人工确认；取消后这张图不会继续后续步骤。";
  if (state === "cancelling") {
    return "已请求取消：云端请求已发出，无法撤回；将等待终态并停止后续步骤。";
  }
  const steps = item?.steps || [];
  const cloudStep = steps.find((step) => step.name === "cloud_lineart");
  const cloudSent = Boolean(
    batch?.snapshot?.options?.recipe === "cloud_lineart" &&
      cloudStep &&
      ["running", "succeeded"].includes(cloudStep.state)
  );
  if (cloudSent) return "云端请求已发出，无法撤回；取消会停止后续步骤并保留已有结果。";
  if (state === "queued") return "尚未启动，可取消。";
  return "本机任务可停止；取消会停止这张图的后续步骤。";
}

/** 单个图片当前正在执行的步骤（用于展示逐图步骤）。 */
export function currentStep(item) {
  if (!item) return null;
  const steps = item.steps || [];
  if (item.waiting_for) return steps.find((step) => step.name === item.waiting_for) || null;
  return steps[item.cursor] || steps[steps.length - 1] || null;
}

/* ------------------------------------------------------------------ 预设输入资产 */

export function compatibleInputAssets(group, options) {
  const recipe = normalizePresetOptions(options).recipe;
  const kinds = RECIPE_INPUT_KINDS[recipe] || RECIPE_INPUT_KINDS.color;
  return (group?.assets || [])
    .filter((asset) => asset?.asset_id && kinds.has(asset.kind) && Number(asset.width) > 0 && Number(asset.height) > 0)
    .sort((a, b) => createdMs(b.created_at) - createdMs(a.created_at));
}

const createdMs = (value) => {
  const ms = Date.parse(String(value || ""));
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * 每张原图只选一个输入资产：优先调用方指定的当前版本（若类型兼容），
 * 其次规范输入，最后选最新的兼容版本。绝不使用原图 original 作为处理输入。
 */
export function pickInputAsset(group, options, preferredId = "") {
  const list = compatibleInputAssets(group, options);
  if (!list.length) return null;
  const preferred = preferredId && list.find((asset) => asset.asset_id === preferredId);
  if (preferred) return preferred;
  const normalizedId = group?.normalized_asset_id || "";
  const normalized = normalizedId && list.find((asset) => asset.asset_id === normalizedId);
  if (normalized) return normalized;
  const normalizedKind = list.find((asset) => asset.kind === "normalized_input");
  return normalizedKind || list[0];
}

/** 提交前的输入：每个原图组一个兼容资产；没有兼容资产的组不能选中。 */
export function batchInputs(groups, options, selectedImageIds, preferredInputs = {}) {
  const selected = selectedImageIds instanceof Set ? selectedImageIds : new Set(selectedImageIds || []);
  const inputs = [];
  const missing = [];
  for (const group of groups || []) {
    if (!selected.has(group.imageId)) continue;
    const asset = pickInputAsset(group, options, preferredInputs[group.imageId]);
    if (!asset) {
      missing.push(group);
      continue;
    }
    inputs.push({ group, asset });
  }
  return { inputs, missing };
}

export function buildBatchPayload(presetId, inputs, { consentToUpload = false, consentToCharge = false } = {}) {
  return {
    preset_id: presetId,
    input_asset_ids: inputs.map((entry) => entry.asset.asset_id),
    consent_to_upload: Boolean(consentToUpload),
    consent_to_charge: Boolean(consentToCharge),
  };
}

export function buildResumePayload(revision, inputAssetId) {
  return { revision: Number(revision) || 1, input_asset_id: inputAssetId };
}

export function buildPresetPayload(name, options, revision = null) {
  const payload = { name: String(name || "").trim(), options: normalizePresetOptions(options) };
  if (revision) payload.revision = Number(revision);
  return payload;
}

export function presetValidation(name, options, limits = healthPixelLimits()) {
  const opts = normalizePresetOptions(options);
  if (!String(name || "").trim()) return "预设名不能为空。";
  if (String(name).trim().length > 80) return "预设名最多 80 个字符。";
  // 矢量化与平铺都关闭是合法的 PNG-only 流程，不再强制二选一。
  if (opts.working_max_pixels !== null) {
    const value = Number(opts.working_max_pixels);
    const maxCopy = Number(limits.workingCopy) > 0 ? Number(limits.workingCopy) : null;
    if (!Number.isFinite(value) || value < 10_000) {
      return "工作副本像素上限不能小于 10,000。";
    }
    if (maxCopy && value > maxCopy) {
      return `工作副本像素上限不能超过本机上限 ${formatPixels(maxCopy)} 像素。`;
    }
  }
  return "";
}

export function runValidation({ presetId, groups, selectedImageIds, options, consentToUpload, consentToCharge } = {}) {
  if (!presetId) return "先选择一个流程预设。";
  const selected = selectedImageIds instanceof Set ? selectedImageIds : new Set(selectedImageIds || []);
  if (!selected.size) return "至少选择一张原图。";
  if (selected.size > 100) return "单个批次最多 100 张原图。";
  const { inputs, missing } = batchInputs(groups, options, selected);
  if (missing.length) return `有 ${missing.length} 张原图没有该预设可用的输入版本，请取消选择它们。`;
  if (inputs.length !== selected.size) return "输入资产不完整，请重新选择原图。";
  if (normalizePresetOptions(options).recipe === "cloud_lineart" && !(consentToUpload && consentToCharge)) {
    return "云端预设需要同时确认本批次上传与可能费用。";
  }
  return "";
}

/* ------------------------------------------------------------------ 数据读取 */

export async function loadPresets({ silent = false } = {}) {
  processing.presetsLoading = true;
  if (!silent) processing.presetsError = "";
  try {
    const page = await api.workflowPresets();
    processing.presets = (page?.items || []).map((preset) => ({
      ...preset,
      options: normalizePresetOptions(preset.options),
    }));
    notifyProcessing("presets");
    return processing.presets;
  } catch (error) {
    processing.presetsError = error?.message || "预设读取失败。";
    if (!silent) notifyProcessing("presets-error");
    return processing.presets;
  } finally {
    processing.presetsLoading = false;
  }
}

export function presetById(presetId) {
  return processing.presets.find((preset) => preset.preset_id === presetId) || null;
}

export async function loadBatches({ cursor = "", silent = false } = {}) {
  if (!silent) {
    processing.listLoading = true;
    processing.listError = "";
    notifyProcessing("batches-loading");
  }
  try {
    const page = await api.processingBatches({ limit: 20, cursor });
    const items = (page?.items || []).filter((batch) => batch?.batch_id);
    processing.batches = cursor ? [...processing.batches, ...items] : items;
    processing.listNextCursor = page?.next_cursor || null;
    if (!processing.selectedBatchId && items.length) {
      const active = items.find((batch) => isBatchActive(batch));
      processing.selectedBatchId = (active || items[0]).batch_id;
    }
    if (processing.selectedBatchId) {
      const match = processing.batches.find((batch) => batch.batch_id === processing.selectedBatchId);
      if (match && !processing.detail) processing.detail = match;
    }
    if (!silent) notifyProcessing("batches");
    return items;
  } catch (error) {
    processing.listError = error?.message || "批次列表读取失败。";
    if (!silent) notifyProcessing("batches-error");
    return [];
  } finally {
    processing.listLoading = false;
  }
}

export async function loadBatch(batchId, { silent = false } = {}) {
  if (!batchId) return null;
  if (!silent) {
    processing.detailLoading = true;
    processing.detailError = "";
    notifyProcessing("batch-loading");
  }
  try {
    const batch = await api.processingBatch(batchId);
    processing.detail = batch;
    processing.selectedBatchId = batchId;
    const index = processing.batches.findIndex((entry) => entry.batch_id === batchId);
    if (index >= 0) processing.batches[index] = batch;
    else processing.batches.unshift(batch);
    if (!silent) notifyProcessing("batch");
    // 结果与人工门候选都复用 /patterns；后台补齐，不阻塞进度展示。
    ensurePatternsForBatch(batch);
    return batch;
  } catch (error) {
    processing.detailError = error?.message || "批次读取失败。";
    if (!silent) notifyProcessing("batch-error");
    return null;
  } finally {
    processing.detailLoading = false;
  }
}

export async function selectBatch(batchId) {
  if (!batchId) return null;
  processing.selectedBatchId = batchId;
  const local = processing.batches.find((batch) => batch.batch_id === batchId);
  if (local) processing.detail = local;
  notifyProcessing("select");
  return loadBatch(batchId);
}

/** /patterns 结果缓存：结果缩略图、导出分组与人工门候选共用同一份。 */
export async function loadPattern(imageId, { force = false } = {}) {
  if (!imageId) return null;
  const entry = processing.patterns.get(imageId);
  if (!force && entry?.pattern && Date.now() - (entry.at || 0) < 5000) return entry.pattern;
  if (entry?.loading && entry.promise) return entry.promise;
  const promise = api
    .pattern(imageId)
    .then((pattern) => {
      processing.patterns.set(imageId, {
        pattern,
        at: Date.now(),
        loading: false,
        promise: null,
        resultCount: entry?.resultCount || 0,
      });
      notifyProcessing("pattern");
      return pattern;
    })
    .catch(() => {
      processing.patterns.set(imageId, { ...(entry || {}), loading: false, promise: null, error: true });
      return null;
    });
  processing.patterns.set(imageId, { ...(entry || {}), loading: true, promise });
  return promise;
}

export function patternFor(imageId) {
  return processing.patterns.get(imageId)?.pattern || null;
}

/** 批次里出现结果的图片：仅在结果数量变化时重新读 /patterns。 */
export function ensurePatternsForBatch(batch) {
  for (const item of batch?.items || []) {
    if (!item?.image_id) continue;
    // 结果缩略图与人工门候选都需要这张原图的资产清单。
    if (!(item.results || []).length && item.state !== "waiting") continue;
    const previous = processing.patterns.get(item.image_id);
    const changed = !previous || previous.resultCount !== (item.results || []).length;
    if (changed) {
      processing.patterns.set(item.image_id, { ...(previous || {}), resultCount: (item.results || []).length });
      loadPattern(item.image_id, { force: true });
    } else if (!previous.pattern) {
      loadPattern(item.image_id);
    }
  }
}

export function resultAssetIds(batch) {
  const ids = [];
  for (const item of batch?.items || []) {
    const results = item.results || [];
    if (results.length) ids.push(results[results.length - 1]);
  }
  return [...new Set(ids)];
}

/** 结果导出分组：原图组 + 全部已有版本；没有读到的组先跳过。 */
export function resultGroups(batch) {
  const groups = [];
  const seen = new Set();
  for (const item of batch?.items || []) {
    if (!item?.image_id || seen.has(item.image_id)) continue;
    if (!(item.results || []).length) continue;
    const pattern = patternFor(item.image_id);
    if (!pattern) continue;
    seen.add(item.image_id);
    groups.push({
      imageId: item.image_id,
      name: pattern.name,
      current: false,
      assets: pattern.assets || [],
    });
  }
  return groups;
}

/** 人工门候选：同图、后端要求的类型；是否真正后代由后端校验。 */
export function manualCandidates(waitingFor, pattern) {
  const kind = expectedManualKind(waitingFor);
  if (!kind || !pattern) return [];
  return (pattern.assets || [])
    .filter((asset) => asset?.kind === kind)
    .sort((a, b) => createdMs(b.created_at) - createdMs(a.created_at));
}

/* ------------------------------------------------------------------ 写操作 */

async function withBusy(key, run) {
  if (processing.busyKey) return null;
  processing.busyKey = key;
  notifyProcessing("busy");
  try {
    return await run();
  } finally {
    processing.busyKey = "";
    notifyProcessing("busy-end");
  }
}

export async function createPreset(name, options) {
  return withBusy("preset-create", async () => {
    const created = await api.createWorkflowPreset(buildPresetPayload(name, options));
    processing.presets = [...processing.presets, { ...created, options: normalizePresetOptions(created.options) }];
    notifyProcessing("presets");
    return created;
  });
}

export async function updatePreset(preset, name, options) {
  return withBusy(`preset-${preset.preset_id}`, async () => {
    const updated = await api.updateWorkflowPreset(
      preset.preset_id,
      buildPresetPayload(name, options, preset.revision)
    );
    const next = { ...updated, options: normalizePresetOptions(updated.options) };
    processing.presets = processing.presets.map((entry) =>
      entry.preset_id === preset.preset_id ? next : entry
    );
    notifyProcessing("presets");
    return next;
  });
}

export async function deletePreset(preset) {
  return withBusy(`preset-${preset.preset_id}`, async () => {
    const result = await api.deleteWorkflowPreset(preset.preset_id, preset.revision);
    processing.presets = processing.presets.filter((entry) => entry.preset_id !== preset.preset_id);
    notifyProcessing("presets");
    return result;
  });
}

export async function copyPreset(preset, name) {
  return createPreset(name || `${preset.name} 副本`, preset.options);
}

export async function createBatch({ presetId, inputs, consentToUpload = false, consentToCharge = false }) {
  return withBusy("batch-create", async () => {
    const batch = await api.createProcessingBatch(
      buildBatchPayload(presetId, inputs, { consentToUpload, consentToCharge })
    );
    if (!batch?.batch_id) throw new Error("批次提交没有返回编号，请稍后重试。");
    processing.detail = batch;
    processing.selectedBatchId = batch.batch_id;
    processing.batches = [batch, ...processing.batches.filter((entry) => entry.batch_id !== batch.batch_id)];
    notifyProcessing("batch-created");
    ensurePatternsForBatch(batch);
    return batch;
  });
}

export async function resumeItem(batchId, itemId, revision, inputAssetId) {
  return withBusy(`resume-${itemId}`, async () => {
    const batch = await api.resumeProcessingItem(batchId, itemId, buildResumePayload(revision, inputAssetId));
    processing.detail = batch;
    processing.selectedBatchId = batchId;
    const index = processing.batches.findIndex((entry) => entry.batch_id === batchId);
    if (index >= 0) processing.batches[index] = batch;
    notifyProcessing("batch");
    ensurePatternsForBatch(batch);
    return batch;
  });
}

export async function cancelBatch(batchId, revision) {
  return withBusy(`cancel-${batchId}`, async () => {
    const batch = await api.cancelProcessingBatch(batchId, { revision: Number(revision) || 1 });
    processing.detail = batch;
    const index = processing.batches.findIndex((entry) => entry.batch_id === batchId);
    if (index >= 0) processing.batches[index] = batch;
    notifyProcessing("batch");
    return batch;
  });
}

export function activeBatchCount() {
  return processing.batches.filter((batch) => isBatchActive(batch)).length;
}

/* ------------------------------------------------------------------ 轮询 */

let pollTimer = null;
let polling = false;

function signature(batch) {
  if (!batch) return "";
  const items = (batch.items || [])
    .map((item) => `${item.item_id}:${item.state}:${item.cursor}:${(item.results || []).length}:${item.error?.code || ""}`)
    .join("|");
  return `${batch.batch_id}:${batch.revision}:${batch.state}:${items}`;
}

export function startProcessingPolling({ interval = 2800 } = {}) {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (polling) return;
    const selectedActive = isBatchActive(processing.detail);
    const anyActive = activeBatchCount() > 0;
    if (!selectedActive && !anyActive) return;
    polling = true;
    const before = signature(processing.detail);
    const beforeActive = activeBatchCount();
    try {
      await loadBatches({ silent: true });
      if (processing.selectedBatchId) await loadBatch(processing.selectedBatchId, { silent: true });
      if (signature(processing.detail) !== before || activeBatchCount() !== beforeActive) {
        notifyProcessing("poll");
      }
    } finally {
      polling = false;
    }
  }, interval);
}

export function stopProcessingPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

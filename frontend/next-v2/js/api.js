/* =============================================================================
   api.js — 本机服务 /api/v1 的薄客户端。
   只做三件事：拼请求、把错误统一成带中文说明的 ApiError、给任务轮询一个入口。
   不持有页面状态；状态在 store.js，视图在 js/views/。
   ============================================================================= */

const BASE = "/api/v1";

export class ApiError extends Error {
  constructor(message, { status = 0, code = "", network = false, detail = "" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.network = network;
    this.detail = detail;
  }
}

const CODE_MESSAGES = {
  LOCAL_ACCESS_ONLY: "本机服务只接受同源访问，请从 127.0.0.1:8765 打开工作台。",
  LOCAL_REQUEST_HEADER_REQUIRED: "请求缺少本机写标记，请刷新页面后重试。",
  BODY_TOO_LARGE: "提交内容超过本机服务允许的大小。",
  HEADERS_TOO_LARGE: "请求头超过本机服务允许的大小。",
  UPLOAD_TOO_LARGE: "图片超过 20 MB，请先压缩或裁切。",
  PIXEL_LIMIT: "图片像素超过上限，请先创建工作副本。",
  UNSUPPORTED_FORMAT: "不支持这种图片格式，请使用 PNG 或 JPEG。",
  FORMAT_MISMATCH: "文件内容与扩展名不一致。",
  NOT_FOUND: "没有找到对应的资产或任务。",
  INVALID_REQUEST: "请求参数不符合接口约定。",
  INVALID_SETTINGS: "设置校验未通过，请检查填写内容。",
  STALE_SETTINGS: "设置已被其他操作更新，请刷新后重新保存。",
  STALE_REVISION: "这份记录已被其他操作更新，请重新读取后再保存。",
  CATEGORY_EXISTS: "已经有同名的题材分类，请换一个名字。",
  CATEGORY_LIMIT: "题材分类最多 200 个，请先删除不用的分类。",
  CATEGORY_NOT_FOUND: "找不到这个题材分类，可能已被删除。",
  INVALID_CATEGORY_NAME: "分类名需要 1–60 个字符，且不能包含控制字符。",
  IMAGE_NOT_FOUND: "没有找到这张原图，可能已被移除。",
  PATTERN_BUSY: "这张纹样还有排队或进行中的任务；完成或取消后再删除。",
  PATTERN_IN_BATCH: "这张纹样正在批处理中；先取消该批次再删除。",
  WORKBENCH_LIMIT: "工作台最多保留 500 张纹样，请先移出一些再添加。",
  INVALID_WORKBENCH_SELECTION: "请选择 1–200 张纹样。",
  EXPORT_SIZE_LIMIT: "所选文件超过 128 MiB 导出上限，请少选几个。",
  EXPORT_LAYOUT_INVALID: "导出目录布局不受支持。",
  NESTED_EXPORT: "不能把已有的 ZIP 再打包一次，请只选图片或 SVG。",
  LICENSE_REVIEW_REQUIRED: "所选资产里有未登记的许可证，请先确认许可提示再导出。",
  BATCH_CLOUD_CONSENT_REQUIRED: "云端预设需要同时确认本批次上传与可能费用，两项都不默认勾选。",
  BATCH_INPUT_KIND: "所选预设不能处理这个资产类型，请换一个输入版本。",
  BATCH_IMAGE_REQUIRED: "请选择属于已登记原图的输入资产。",
  BATCH_RESUME_ASSET_MISMATCH: "这个结果不是当前版本的后代，或类型不符合这一步；请在工作台生成正确结果后再选。",
  BATCH_ITEM_NOT_WAITING: "这张图当前没有待确认的人工步骤，请刷新批次。",
  BATCH_ITEM_NOT_FOUND: "找不到这张图的批次项，请刷新批次。",
  BATCH_NOT_FOUND: "找不到这个批次，可能已被移除。",
  BATCH_OUTPUT_MISSING: "任务完成但没有发布预期产物，请检查任务记录。",
  BATCH_STEP_FAILED: "批次步骤失败，不会自动重试。",
  BATCH_STEP_UNSUPPORTED: "预设里有当前服务不支持的步骤。",
  BATCH_RECIPE_INVALID: "预设路线与步骤不匹配，请重新保存预设。",
  BATCH_PRESET_INVALID: "预设参数未通过校验，请检查后重新保存。",
  PRESET_NOT_FOUND: "找不到这个流程预设。",
  BUILTIN_PRESET: "内置预设不能删除；可以复制或修改。",
  INVALID_PRESET_NAME: "预设名需要 1–80 个字符。",
  IDEMPOTENCY_CONFLICT: "提交标识冲突，请重新发起。",
  QUEUE_FULL: "本机任务队列已满，批次会等待空位后继续，不算失败。",
  PROVIDER_OUTCOME_UNKNOWN: "云端结果未知：不会自动重试，请先到任务记录核对。",
  CANCEL_REQUIRES_RECONCILIATION: "云端调用需要先核对结果；取消会等待终态，不能撤回已发送的请求。",
  WORKER_BUSY: "本机处理队列正在忙，请等当前任务结束后再试。",
  WORKER_MEMORY_LIMIT: "本机处理达到内存上限，请换更小的图或降低矢量化细节。",
  WORKER_TIMEOUT: "本机处理超时，请换更小的图或稍后重试。",
  SVG_SIZE_LIMIT: "生成的 SVG 超过大小上限，请降低细节或缩小图幅。",
  SVG_PATH_LIMIT: "生成的 SVG 路径过多，请降低细节或换更简单的图。",
  VECTOR_PIXEL_LIMIT: "矢量化像素超过上限，请先缩小工作图。",
  EMPTY_MASK: "当前图没有可矢量化的前景。",
  VECTOR_PALETTE_LIMIT: "颜色数超过所选上限，请调低颜色数或简化图片。",
  AI_PIPELINE_NOT_FOUND: "找不到对应的云端流程。",
  PIPELINE_NOT_FOUND: "找不到对应的处理流程。",
  SEAM_OBSERVATION_CONFLICT: "接缝记录已被更新，请重新读取资产后再保存。",
  SEAM_OBSERVATION_NOT_TILE: "这个资产不是平铺结果，不能记录接缝。",
  TILE_NOT_READY: "平铺结果尚未生成完成。",
  LINEART_MODEL_UNAVAILABLE: "模型线稿不可用：模型权重/配置缺失、校验未通过，或运行依赖不可用（torch、图像分割与骨干模型库）；可改用 OpenCV 路线，或按 README 检查模型环境。",
  LINEART_MODEL_GPU_OOM: "显存不足，释放竞争 GPU 任务后重试。",
  LEFTREFILL_MODEL_UNAVAILABLE: "本地修复模型不可用：缺少基础网络、模型文件或运行依赖；不会自动改用云端。请按 README 检查本地模型环境。",
  LEFTREFILL_GPU_REQUIRED: "本地修复需要可用的 NVIDIA 显卡（CUDA）；当前没有可用的 GPU。不会自动改用云端。",
  LEFTREFILL_GPU_OOM: "本地修复显存不足，请关闭其他占用显卡的程序后重试。",
  LEFTREFILL_INFERENCE_FAILED: "本地修复推理失败，没有生成候选；不会自动改用云端。请检查模型文件或稍后重试。",
  LEFTREFILL_INPUT_SIZE: "本地修复目标必须是 512 × 512；请先在 02 裁切出 512 × 512 图块，不会自动缩放。",
  LEFTREFILL_REFERENCE_INVALID: "参考图不可用：需要一张不超过 1,048,576 像素的已保存光栅图，请重新选择。",
  LEFTREFILL_EMPTY_MASK: "修复框内没有可修复的内容（损伤蒙版为空）；请调整修复区域后重试。",
  PROVIDER_BUSY: "已有一个云端请求在运行，请等待它结束后再试。",
  PROVIDER_DISABLED: "云端尚未就绪，请先在设置里完成 API Key 与调用许可。",
  PROVIDER_INPUT_KIND: "当前资产不能作为这次云端请求的输入，请先切换到接口支持的输入类型。",
  PROVIDER_INPUT_DIMENSIONS: "输入的像素或长宽比不在云端允许范围内。",
  NORMALIZED_TOO_LARGE: "云端输入文件超过 20 MB；请先创建工作副本或压缩后再上传。",
  NEEDS_RECONCILIATION: "上一次云端调用的结果尚未确认；请先在任务记录中核对，不会自动重发。",
  RETRY_NOT_ALLOWED: "只有失败的本机任务可以重试；云端调用需要重新发起并确认。",
  PAID_RETRY_REQUIRES_NEW_CONSENT: "云端调用不能自动重试；请在工作台重新发起并确认费用。",
  CANCEL_REQUIRES_RECONCILIATION: "这条任务可能有外部调用在进行，需要先核对云端状态，暂时不能取消。",
  JOB_NOT_FOUND: "找不到这条任务。",
  DECOMPOSITION_NOT_READY: "云端拆分尚未成功完成，暂时没有可选的候选层。",
  DECOMPOSITION_INPUT_MISMATCH: "这份云端拆分不是用当前规范输入生成的，请重新生成候选。",
  DECOMPOSITION_ARCHIVE_INVALID: "云端候选归档不完整，无法安全合成；请重新生成候选。",
  LAYERS_NOT_READY: "云端拆分尚未成功完成，暂时不能选层。",
  INVALID_LAYER_SELECTION: "请选择这次拆分里的候选层，且每层只能选一次。",
  REPAIR_NOT_FOUND: "找不到这次修复记录。",
  REPAIR_NOT_READY: "修复候选尚未完成，暂时不能接受或拒绝。",
  REPAIR_SIZE_LIMIT: "局部修复最多支持 1024 × 1024 像素，请先准备更小的规范输入。",
  INVALID_REPAIR_SELECTION: "请选择这次修复自己的候选或本地合成。",
  FULL_IMAGE_CONSENT_REQUIRED: "接受全图候选前，需要先确认它可能改变整个画面。",
  OUTSIDE_REGION_CHANGED: "修复候选改变了选区外的像素，已保留为预览，不能直接接受。",
  DAMAGE_MASK_SOURCE_MISMATCH: "损伤蒙版与当前规范输入的来源或坐标不一致。",
  REPAIR_ARCHIVE_MISMATCH: "归档的修复候选与当前输入、区域或参数不一致。",
  REPAIR_CANDIDATE_COUNT: "这次归档修复没有唯一的候选图，不能继续。",
  DECISION_NOT_AVAILABLE: "这个流程已经做过选择，或还没到可选择的状态，请重新读取。",
  PROMPT_VERSION_UNAVAILABLE: "所选提示词版本不可用，请换一个已登记的版本。",
  EDIT_BOX_TOO_SMALL: "修复区域在云端坐标精度下过小，请扩大选区。",
  SERVICE_ERROR: "本机服务未能完成请求，请稍后重试。",
  INTERNAL_ERROR: "本机服务内部出错。",
};

function errorMessage(data, status) {
  const error = data && typeof data === "object" ? data.error : null;
  const code = error && error.code ? String(error.code) : "";
  const compact = error && typeof error.message === "string" ? error.message.trim() : "";
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  if (code === "PROVIDER_NOT_READY" || code === "PROVIDER_BLOCKED") {
    return "云端调用尚未就绪，请先在设置里完成云端配置。";
  }
  if (code.startsWith("PROVIDER_")) return "云端请求没有完成：" + (compact || "请检查服务商配置与网络。");
  if (status >= 500) return compact && /[\u4e00-\u9fa5]/.test(compact) ? compact : "本机服务没有完成请求，请稍后重试。";
  if (compact && /[\u4e00-\u9fa5]/.test(compact)) return compact;
  if (compact) return `请求未被接受：${compact}`;
  return status === 403 ? CODE_MESSAGES.LOCAL_ACCESS_ONLY : "请求未被接受，请检查参数与当前状态。";
}

export function idempotencyKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function request(path, { method = "GET", json, form, headers, signal, raw = false, timeout } = {}) {
  const head = new Headers(headers || {});
  head.set("Accept", raw ? "*/*" : "application/json");
  let body;
  if (json !== undefined) {
    head.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }
  if (!["GET", "HEAD"].includes(method)) head.set("X-Pattern-Studio", "local");

  // 本机服务也可能卡住：默认上限避免页面永远停在加载态。
  const budget = timeout === undefined ? (form ? 120000 : 30000) : Number(timeout);
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  if (budget > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, budget);
  }
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }

  let response;
  try {
    response = await fetch(BASE + path, {
      method,
      headers: head,
      body,
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", forwardAbort);
    if (timedOut) throw new ApiError("本机服务响应超时，请稍后重试。", { network: true });
    if ((signal && signal.aborted) || (error && error.name === "AbortError")) {
      throw new ApiError("请求已取消。", { network: true });
    }
    throw new ApiError("无法连接本机服务，请确认工作台服务正在运行。", { network: true });
  }

  // 超时预算必须覆盖响应体：fetch 在收到响应头时就 resolve，若此时清掉计时器，
  // 服务端卡在响应体时页面会一直等下去。计时器与中断转发都移到读完正文之后再清理。
  try {
    if (!response.ok) {
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (timedOut) throw new ApiError("本机服务响应超时，请稍后重试。", { network: true });
      throw new ApiError(errorMessage(data, response.status), {
        status: response.status,
        code: data?.error?.code || "",
        detail: typeof data?.error?.message === "string" ? data.error.message.trim() : "",
      });
    }
    if (raw) return response;
    const text = await response.text();
    if (timedOut) throw new ApiError("本机服务响应超时，请稍后重试。", { network: true });
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) throw new ApiError("本机服务响应超时，请稍后重试。", { network: true });
    if ((signal && signal.aborted) || (error && error.name === "AbortError")) {
      throw new ApiError("请求已取消。", { network: true });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", forwardAbort);
  }
}

const enc = (value) => encodeURIComponent(String(value));

export const api = {
  request,

  /* --- 服务与设置 --- */
  health: (options) => request("/health", options),
  settings: (options) => request("/settings", options),
  updateSettings: (payload, options) => request("/settings", { method: "PUT", json: payload, ...options }),
  seedreamStatus: (options) => request("/seedream/status", options),

  /* --- 图片与上传 --- */
  image: (imageId, options) => request(`/images/${enc(imageId)}`, options),
  imageHistory: (imageId, { collection = "assets", limit = 50, cursor = "", ...rest } = {}) => {
    const query = new URLSearchParams({ collection, limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request(`/images/${enc(imageId)}/history?${query}`, rest);
  },
  images: ({ limit = 20, cursor = "", ...rest } = {}) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request(`/images?${query}`, rest);
  },
  uploadImage(file, provenance = {}, { signal, onProgress } = {}) {
    const form = new FormData();
    form.set("file", file, file.name || "upload.png");
    for (const [key, value] of Object.entries(provenance)) {
      if (value !== undefined && value !== null && String(value).trim() !== "") form.set(key, String(value));
    }
    onProgress?.();
    return request(`/images?filename=${enc(file.name || "upload.png")}`, {
      method: "POST",
      form,
      signal,
      headers: { "Idempotency-Key": idempotencyKey() },
    });
  },

  /* --- 资产 --- */
  assets: ({ limit = 20, cursor = "", q = "", kinds = [], ...rest } = {}) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    if (q) query.set("q", q);
    for (const kind of kinds) if (kind) query.append("kind", kind);
    return request(`/assets?${query}`, rest);
  },

  /* --- 纹样分组与手动分类（接口合同见 docs/batch-workbench-contract.md） --- */
  patterns: ({ limit = 20, cursor = "", q = "", kind = "", categoryId = "", ...rest } = {}) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    if (q) query.set("q", q);
    if (kind) query.set("kind", kind);
    if (categoryId) query.set("category_id", categoryId);
    return request(`/patterns?${query}`, rest);
  },
  pattern: (imageId, options) => request(`/patterns/${enc(imageId)}`, options),
  deletePattern: (imageId) => request(`/patterns/${enc(imageId)}`, { method: "DELETE" }),
  workbenchItems: ({ limit = 20, cursor = "", ...rest } = {}) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request(`/workbench/items?${query}`, rest);
  },
  addWorkbenchItems: (imageIds) =>
    request("/workbench/items", { method: "POST", json: { image_ids: [...imageIds] } }),
  removeWorkbenchItems: (imageIds) =>
    request("/workbench/items", { method: "DELETE", json: { image_ids: [...imageIds] } }),
  patternCategories: (options) => request("/pattern-categories", options),
  createPatternCategory: (name) =>
    request("/pattern-categories", { method: "POST", json: { name } }),
  renamePatternCategory: (categoryId, payload) =>
    request(`/pattern-categories/${enc(categoryId)}`, { method: "PUT", json: payload }),
  deletePatternCategory: (categoryId, revision) =>
    request(`/pattern-categories/${enc(categoryId)}?revision=${enc(revision)}`, { method: "DELETE" }),
  setPatternCategories: (imageId, payload) =>
    request(`/patterns/${enc(imageId)}/categories`, { method: "PUT", json: payload }),
  asset: (assetId, options) => request(`/assets/${enc(assetId)}`, options),
  assetPreviewUrl: (assetId, stamp = "") =>
    `${BASE}/assets/${enc(assetId)}/preview${stamp ? `?v=${enc(stamp)}` : ""}`,
  assetDownloadUrl: (assetId) => `${BASE}/assets/${enc(assetId)}/download`,
  seamObservation: (assetId, payload) =>
    request(`/assets/${enc(assetId)}/seam-observation`, { method: "PUT", json: payload }),

  /* --- 任务 --- */
  job: (jobId, options) => request(`/jobs/${enc(jobId)}`, options),
  jobs: ({ limit = 20, cursor = "", ...rest } = {}) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request(`/jobs?${query}`, rest);
  },
  cancelJob: (jobId) => request(`/jobs/${enc(jobId)}/cancel`, { method: "POST" }),
  retryJob: (jobId) =>
    request(`/jobs/${enc(jobId)}/retry`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey() } }),

  /* --- 本地处理 --- */
  submitJob(kind, payload) {
    return request(`/jobs/${enc(kind)}`, {
      method: "POST",
      json: payload,
      headers: { "Idempotency-Key": idempotencyKey() },
    });
  },
  crop: (payload) => api.submitJob("crop", payload),
  workingCopy: (payload) => api.submitJob("working-copy", payload),
  prepare: (payload) => api.submitJob("prepare", payload),
  enhance: (payload) => api.submitJob("enhance", payload),
  extract: (payload) => api.submitJob("extract", payload),
  lineart: (payload) => api.submitJob("lineart", payload),
  cloudLineart: (payload) =>
    request("/jobs/cloud-lineart", {
      method: "POST",
      json: payload,
      headers: { "Idempotency-Key": idempotencyKey() },
    }),
  vectorize: (payload) => api.submitJob("vectorize", payload),
  pipeline: (payload) =>
    request("/pipelines", { method: "POST", json: payload, headers: { "Idempotency-Key": idempotencyKey() } }),
  pipelineInfo: (pipelineId, options) => request(`/pipelines/${enc(pipelineId)}`, options),
  exportAssets: (payload) =>
    request("/exports", { method: "POST", json: payload, headers: { "Idempotency-Key": idempotencyKey() } }),

  /* --- 云端候选与局部修复 --- */
  aiPipeline: (payload) =>
    request("/pipelines/ai", { method: "POST", json: payload, headers: { "Idempotency-Key": idempotencyKey() } }),
  continuePipeline: (pipelineId, payload) =>
    request(`/pipelines/${enc(pipelineId)}/continue`, {
      method: "POST",
      json: payload,
      headers: { "Idempotency-Key": idempotencyKey() },
    }),
  rerunPipeline: (pipelineId, payload) =>
    request(`/pipelines/${enc(pipelineId)}/rerun`, {
      method: "POST",
      json: payload,
      headers: { "Idempotency-Key": idempotencyKey() },
    }),
  layers: (jobId, options) => request(`/jobs/${enc(jobId)}/layers`, options),
  composeLayers: (payload) =>
    request("/jobs/compose-layers", { method: "POST", json: payload, headers: { "Idempotency-Key": idempotencyKey() } }),
  refineMask: (payload) =>
    request("/jobs/refine-mask", { method: "POST", json: payload, headers: { "Idempotency-Key": idempotencyKey() } }),
  repair: (payload) =>
    request("/jobs/repair", { method: "POST", json: payload, headers: { "Idempotency-Key": idempotencyKey() } }),
  repairInfo: (jobId, options) => request(`/repairs/${enc(jobId)}`, options),
  repairDecision: (jobId, payload) =>
    request(`/repairs/${enc(jobId)}/decision`, {
      method: "POST",
      json: payload,
      headers: { "Idempotency-Key": idempotencyKey() },
    }),

  /* --- 流程预设与持久批次（接口合同见 docs/batch-workbench-contract.md） --- */
  workflowPresets: (options) => request("/workflow-presets", options),
  createWorkflowPreset: (payload) =>
    request("/workflow-presets", { method: "POST", json: payload }),
  updateWorkflowPreset: (presetId, payload) =>
    request(`/workflow-presets/${enc(presetId)}`, { method: "PUT", json: payload }),
  deleteWorkflowPreset: (presetId, revision) =>
    request(`/workflow-presets/${enc(presetId)}?revision=${enc(revision)}`, { method: "DELETE" }),
  processingBatches: ({ limit = 20, cursor = "", ...rest } = {}) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request(`/processing-batches?${query}`, rest);
  },
  processingBatch: (batchId, options) => request(`/processing-batches/${enc(batchId)}`, options),
  createProcessingBatch: (payload) =>
    request("/processing-batches", {
      method: "POST",
      json: payload,
      headers: { "Idempotency-Key": idempotencyKey() },
    }),
  resumeProcessingItem: (batchId, itemId, payload) =>
    request(`/processing-batches/${enc(batchId)}/items/${enc(itemId)}/resume`, {
      method: "POST",
      json: payload,
    }),
  cancelProcessingBatch: (batchId, payload) =>
    request(`/processing-batches/${enc(batchId)}/cancel`, { method: "POST", json: payload }),

  /* --- 平铺与数据集 --- */
  tilePreview: (payload) =>
    request("/jobs/tile-preview", { method: "POST", json: payload, headers: { "Idempotency-Key": idempotencyKey() } }),
  datasetAudit: (options) => request("/datasets/audit", options),
  manifestUrl: () => `${BASE}/datasets/manifest.csv`,
};

export const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

export function isTerminal(job) {
  return Boolean(job && TERMINAL_STATES.has(job.state));
}

/**
 * 轮询任务直到终态。返回最后一次任务快照；失败会抛出 ApiError，
 * 但“任务本身 failed”不算异常，交给调用方按状态展示。
 *
 * 可选 `abandon`：每轮请求前与收到快照后调用；返回 true 时表示调用方已不再
 * 关心这个任务（例如会话已切换），此时停止轮询并返回 null，不抛异常，
 * 也不再把任何快照交给 onTick。默认不放弃。
 */
export async function waitForJob(jobId, { signal, onTick, interval = 1200, maxFailures = 5, abandon } = {}) {
  const abandoned = () => Boolean(abandon?.());
  let failures = 0;
  let snapshot = null;
  for (;;) {
    if (abandoned()) return null;
    if (signal?.aborted) throw new ApiError("请求已取消。", { network: true });
    try {
      snapshot = await api.job(jobId, { signal });
      failures = 0;
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) {
        throw new ApiError("请求已取消。", { network: true });
      }
      failures += 1;
      if (failures >= maxFailures) throw error;
    }
    if (abandoned()) return null;
    onTick?.(snapshot);
    if (snapshot && isTerminal(snapshot)) return snapshot;
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ApiError("请求已取消。", { network: true }));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, interval);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

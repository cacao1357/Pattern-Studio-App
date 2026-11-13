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
  PROVIDER_BUSY: "已有一个云端请求在运行，请等待它结束后再试。",
  PROVIDER_DISABLED: "云端尚未就绪，请先在设置里完成 API Key 与调用许可。",
  PROVIDER_INPUT_KIND: "当前资产不能作为这次云端请求的输入，请先切换到接口支持的输入类型。",
  PROVIDER_INPUT_DIMENSIONS: "输入的像素或长宽比不在云端允许范围内。",
  NORMALIZED_TOO_LARGE: "云端输入文件超过 20 MB；请先创建工作副本或压缩后再上传。",
  NEEDS_RECONCILIATION: "上一次云端调用的结果尚未确认；请先在任务记录中核对，不会自动重发。",
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

async function request(path, { method = "GET", json, form, headers, signal, raw = false } = {}) {
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

  let response;
  try {
    response = await fetch(BASE + path, {
      method,
      headers: head,
      body,
      signal,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (error) {
    if (error && error.name === "AbortError") throw new ApiError("请求已取消。", { network: true });
    throw new ApiError("无法连接本机服务，请确认工作台服务正在运行。", { network: true });
  }

  if (!response.ok) {
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    throw new ApiError(errorMessage(data, response.status), {
      status: response.status,
      code: data?.error?.code || "",
      detail: typeof data?.error?.message === "string" ? data.error.message.trim() : "",
    });
  }
  if (raw) return response;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
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

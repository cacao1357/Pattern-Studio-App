"use strict";

/* Pattern Studio settings and workflow-trace helpers.
 *
 * This module intentionally has no DOM, storage or logging side effects:
 * - the API key is only ever passed through the caller's one-shot request;
 * - settings are never written to localStorage/sessionStorage or cookies;
 * - unknown server fields are ignored rather than rendered.
 *
 * The functions are exported separately so the settings contract and the
 * workflow/recovery/branches envelope can be tested without a browser.
 */

export const SETTINGS_API_PATH = "/settings";
export const SETTINGS_API_KEY_ACTIONS = ["keep", "replace", "clear"];
export const SETTINGS_MAX_CENTS = 100_000_000;

const BLOCKER_LABELS = {
  API_KEY_MISSING: "尚未配置 API Key。",
  PAID_CALLS_DISABLED: "付费调用开关已关闭；新的云端请求不会开始。",
  PRICING_NOT_CONFIRMED: "尚未确认价格。",
  BUDGET_NOT_CONFIGURED: "预算或单次预留尚未配置为大于 0。",
  PROVIDER_DISABLED: "AI 新生成不可用。",
  SETTINGS_NOT_LOADED: "设置尚未读取。"
};

const SELECTION_POLICY_LABELS = {
  auto_or_confirm: "自动或人工确认",
  auto: "自动选层",
  manual: "人工确认",
  human_confirm: "人工确认",
  required: "需要人工确认",
  none: "不自动选择"
};

const WORKFLOW_PNG_KINDS = [
  "composed_candidate",
  "transparent_png",
  "accepted_repair",
  "edit_candidate",
  "placed_generated_layer",
  "generated_layer"
];

function textValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function firstValue(...values) {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return "";
}

function integerValue(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function normalizeKind(value) {
  return textValue(value).toLowerCase().replace(/-/g, "_").replace(/\s+/g, "_");
}

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

export function yuanToCents(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(text)) {
    return { ok: false, error: "金额必须是元，最多两位小数，且不能为负。" };
  }
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > SETTINGS_MAX_CENTS) {
    return { ok: false, error: "金额超出支持范围（最多 1,000,000.00 元）。" };
  }
  return { ok: true, cents };
}

export function centsToYuan(cents) {
  const value = Number(cents);
  if (!Number.isInteger(value) || value < 0) return "";
  return Math.floor(value / 100) + "." + String(value % 100).padStart(2, "0");
}

/* -------------------------------------------------------------------------- */
/* Settings responses and write payloads                                      */
/* -------------------------------------------------------------------------- */

export function normalizeSettings(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("设置响应不是有效对象。");
  }
  const revision = Number(data.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error("设置响应缺少有效 revision。");
  }
  return {
    revision,
    apiKeyConfigured: data.api_key_configured === true || data.configured === true,
    model: textValue(data.model),
    baseUrl: textValue(data.base_url),
    paidCallsEnabled: data.paid_calls_enabled === true,
    pricingConfirmed: data.pricing_confirmed === true,
    budgetCents: Math.max(0, integerValue(data.budget_cents, 0)),
    reservationCents: Math.max(0, integerValue(data.reservation_cents, 0)),
    maxCalls: Math.max(1, integerValue(data.max_calls, 5)),
    blockers: Array.isArray(data.blockers)
      ? data.blockers.map((item) => textValue(item)).filter(Boolean)
      : [],
    effective: textValue(data.effective) || "next_provider_job",
    requiresRestart: data.requires_restart === true
  };
}

export function settingsBlockerLabels(blockers) {
  const list = Array.isArray(blockers) ? blockers : [];
  const output = [];
  for (const raw of list) {
    const code = textValue(raw);
    if (!code || output.includes(code)) continue;
    output.push(code);
  }
  return output.map((code) => BLOCKER_LABELS[code] || ("服务端阻塞：" + code));
}

export function settingsEffective(settings) {
  const value = settings && typeof settings === "object" ? settings : {};
  const blockers = Array.isArray(value.blockers) ? value.blockers.slice() : [];
  const add = (code) => {
    if (!blockers.includes(code)) blockers.push(code);
  };
  if (value.apiKeyConfigured !== true) add("API_KEY_MISSING");
  if (value.paidCallsEnabled !== true) add("PAID_CALLS_DISABLED");
  if (value.pricingConfirmed !== true) add("PRICING_NOT_CONFIRMED");
  if (!(Number(value.budgetCents) > 0) || !(Number(value.reservationCents) > 0)) {
    add("BUDGET_NOT_CONFIGURED");
  }
  const labels = settingsBlockerLabels(blockers);
  const effectiveText = value.requiresRestart === true
    ? "保存需要重启本机服务后生效。"
    : value.effective === "next_provider_job" || !value.effective
      ? "保存后对新任务生效；正在执行的云端请求保持提交时配置。"
      : "保存后对新任务生效。";
  return {
    ready: labels.length === 0,
    blockers,
    labels,
    effectiveText
  };
}

export function buildSettingsUpdate(options) {
  const opts = options || {};
  const revision = Number(opts.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    return { ok: false, error: "设置修订号无效，请重新读取设置。" };
  }
  const action = SETTINGS_API_KEY_ACTIONS.includes(opts.apiKeyAction) ? opts.apiKeyAction : "";
  if (!action) return { ok: false, error: "请选择有效的密钥操作。" };

  const model = typeof opts.model === "string" ? opts.model.trim() : "";
  if (!model || model.length > 128) {
    return { ok: false, error: "模型或接入点不能为空，且最多 128 个字符。" };
  }
  const baseUrl = typeof opts.baseUrl === "string" ? opts.baseUrl.trim() : "";
  if (!baseUrl || baseUrl.length > 256) {
    return { ok: false, error: "Ark 端点不能为空，且最多 256 个字符。" };
  }
  const budget = yuanToCents(opts.budgetYuan);
  if (!budget.ok) return { ok: false, error: "预算（元）无效：" + budget.error };
  const reservation = yuanToCents(opts.reservationYuan);
  if (!reservation.ok) return { ok: false, error: "单次预留（元）无效：" + reservation.error };
  const maxCalls = Number(opts.maxCalls);
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 100) {
    return { ok: false, error: "最大调用数必须是 1–100 之间的整数。" };
  }

  const payload = {
    revision,
    api_key_action: action,
    model,
    base_url: baseUrl,
    paid_calls_enabled: opts.paidCallsEnabled === true,
    pricing_confirmed: opts.pricingConfirmed === true,
    budget_cents: budget.cents,
    reservation_cents: reservation.cents,
    max_calls: maxCalls
  };

  if (action === "replace") {
    const key = typeof opts.apiKey === "string" ? opts.apiKey : "";
    if (!key) return { ok: false, error: "替换密钥时请输入新的 API Key。" };
    if (key.length > 1024 || !/^[\x21-\x7E]+$/.test(key)) {
      return { ok: false, error: "API Key 只能包含可见 ASCII 字符，且最多 1024 个字符。" };
    }
    payload.api_key = key;
  }
  return { ok: true, payload };
}

export function createSettingsClient(options) {
  const opts = options || {};
  const request = opts.request;
  if (typeof request !== "function") {
    throw new TypeError("createSettingsClient requires a request adapter");
  }
  return {
    async load() {
      const result = await request(SETTINGS_API_PATH, { method: "GET" });
      return normalizeSettings(result && result.data);
    },
    async save(payload) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("设置保存请求无效。");
      }
      const result = await request(SETTINGS_API_PATH, { method: "PUT", json: payload });
      return normalizeSettings(result && result.data);
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Workflow / recovery / branches                                             */
/* -------------------------------------------------------------------------- */

function branchItems(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["items", "branches", "jobs", "children"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function normalizeBranch(item) {
  if (!item || typeof item !== "object") return null;
  const job = item.job && typeof item.job === "object" ? item.job : item;
  const parameters = job.parameters && typeof job.parameters === "object"
    ? job.parameters
    : item.parameters && typeof item.parameters === "object" ? item.parameters : {};
  const jobId = firstValue(job.job_id, job.id, item.job_id, item.id);
  if (!jobId) return null;
  return {
    jobId,
    parentJobId: firstValue(item.parent_job_id, item.parent_id, item.parent, job.parent_job_id, job.parent_id, job.retry_of),
    action: firstValue(item.action, parameters.action, parameters.rerun_action, job.action, job.kind, item.kind),
    kind: firstValue(job.kind, item.kind),
    state: firstValue(item.state, job.state),
    createdAt: firstValue(item.created_at, job.created_at, item.updated_at, job.updated_at)
  };
}

function normalizeRecovery(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "string") {
    return {
      state: "",
      message: raw,
      action: "",
      step: "",
      uncertain: false,
      retryable: false,
      autoRetry: false,
      canCompose: null,
      needsReconcile: false,
      vectorInputAssetIds: [],
      providerCallId: "",
      automaticProviderRetry: false
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const needsReconcile = raw.needs_reconcile === true;
  const vectorInputAssetIds = Array.isArray(raw.vector_input_asset_ids)
    ? raw.vector_input_asset_ids.map((item) => textValue(item)).filter(Boolean)
    : [];
  const state = firstValue(raw.state, raw.status, raw.kind) || (needsReconcile ? "needs_reconcile" : "");
  return {
    state,
    message: firstValue(raw.message, raw.detail, raw.reason, raw.note),
    action: firstValue(raw.next_action, raw.action, raw.resume_action, raw.recommended_action),
    step: firstValue(raw.step, raw.failed_step, raw.resume_step, raw.from_step),
    uncertain: raw.uncertain === true || raw.result_unknown === true || needsReconcile ||
      ["uncertain", "unknown", "result_unknown", "needs_reconcile"].includes(state.toLowerCase()),
    retryable: raw.retryable === true,
    autoRetry: false,
    canCompose: raw.can_compose === undefined ? null : raw.can_compose === true,
    needsReconcile,
    vectorInputAssetIds,
    providerCallId: firstValue(raw.provider_call_id),
    automaticProviderRetry: raw.automatic_provider_retry === true
  };
}

export function selectionPolicyLabel(value) {
  const text = textValue(value);
  if (!text) return "";
  return SELECTION_POLICY_LABELS[text.toLowerCase()] || text;
}

export function normalizeWorkflowTrace(pipeline) {
  const source = pipeline && typeof pipeline === "object" ? pipeline : {};
  const workflowRaw = source.workflow && typeof source.workflow === "object" && !Array.isArray(source.workflow)
    ? source.workflow
    : {};
  const snapshotRaw = workflowRaw.snapshot && typeof workflowRaw.snapshot === "object" && !Array.isArray(workflowRaw.snapshot)
    ? workflowRaw.snapshot
    : source.workflow_snapshot && typeof source.workflow_snapshot === "object" && !Array.isArray(source.workflow_snapshot)
      ? source.workflow_snapshot
      : {};
  const workflowId = firstValue(
    workflowRaw.id, workflowRaw.workflow_id, workflowRaw.name,
    typeof source.workflow === "string" ? source.workflow : "", source.workflow_id, source.workflow_name
  );
  const workflow = {
    id: workflowId,
    version: firstValue(workflowRaw.version, workflowRaw.workflow_version, source.workflow_version),
    promptId: firstValue(workflowRaw.prompt_id, snapshotRaw.prompt_id, source.prompt_id),
    promptVersion: firstValue(
      workflowRaw.prompt_version, workflowRaw.promptVersion,
      snapshotRaw.prompt_version, snapshotRaw.promptVersion, source.prompt_version
    ),
    model: firstValue(workflowRaw.model, snapshotRaw.model, source.model),
    selectionPolicy: firstValue(
      workflowRaw.selection_policy, workflowRaw.selectionPolicy,
      snapshotRaw.selection_policy, source.selection_policy
    ),
    inputAssetId: firstValue(workflowRaw.input_asset_id, snapshotRaw.input_asset_id, source.input_asset_id),
    promptText: firstValue(
      snapshotRaw.prompt_text, snapshotRaw.promptText, snapshotRaw.prompt,
      workflowRaw.prompt_text, workflowRaw.prompt
    ),
    snapshotAvailable: Object.keys(snapshotRaw).length > 0
  };
  const branches = branchItems(source.branches)
    .map(normalizeBranch)
    .filter((branch, index, list) => branch && list.findIndex((item) => item.jobId === branch.jobId) === index);
  return {
    available: Boolean(workflow.id || workflow.version || workflow.promptVersion ||
      workflow.model || workflow.selectionPolicy || workflow.snapshotAvailable),
    workflow,
    recovery: normalizeRecovery(source.recovery),
    branches
  };
}

/* -------------------------------------------------------------------------- */
/* Local reruns                                                               */
/* -------------------------------------------------------------------------- */

function validRevision(value) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 1 ? revision : null;
}

export function composeRerunPayload(options) {
  const opts = options || {};
  const revision = validRevision(opts.revision);
  if (revision === null) return { ok: false, error: "流程修订号无效，请重新读取流程。" };
  const rawIds = Array.isArray(opts.layerIds) ? opts.layerIds : [];
  const layerIds = [];
  for (const raw of rawIds) {
    const id = textValue(raw);
    if (id && !layerIds.includes(id)) layerIds.push(id);
  }
  if (!layerIds.length) return { ok: false, error: "请至少选择一个候选图层；底图不能作为图层。" };
  const payload = { action: "compose", revision, layer_ids: layerIds };
  if (opts.vector && typeof opts.vector === "object" && !Array.isArray(opts.vector)) {
    payload.vector = opts.vector;
  }
  return { ok: true, payload };
}

export function vectorizeRerunPayload(options) {
  const opts = options || {};
  const revision = validRevision(opts.revision);
  if (revision === null) return { ok: false, error: "流程修订号无效，请重新读取流程。" };
  const inputAssetId = textValue(opts.inputAssetId);
  if (!inputAssetId) return { ok: false, error: "请选择本流程产生的 PNG 作为矢量化输入。" };
  if (!opts.vector || typeof opts.vector !== "object" || Array.isArray(opts.vector)) {
    return { ok: false, error: "矢量化参数不完整，请检查颜色、细节与阈值。" };
  }
  return {
    ok: true,
    payload: {
      action: "vectorize",
      revision,
      input_asset_id: inputAssetId,
      vector: opts.vector
    }
  };
}

export function workflowPngCandidates(pipeline, assets) {
  const list = Array.isArray(assets)
    ? assets.filter((asset) => asset && typeof asset === "object")
    : assets && typeof assets.values === "function"
      ? Array.from(assets.values()).filter((asset) => asset && typeof asset === "object")
      : [];
  const pipelineSource = pipeline && typeof pipeline === "object" ? pipeline : {};
  const pipelineId = firstValue(pipelineSource.pipeline_id, pipelineSource.id);
  const byId = new Map();
  for (const asset of list) {
    const id = firstValue(asset.asset_id, asset.id);
    if (id && !byId.has(id)) byId.set(id, asset);
  }

  const reachable = new Set();
  const addReachable = (value) => {
    const id = textValue(value);
    if (id) reachable.add(id);
  };
  const resultAssets = Array.isArray(pipelineSource.result && pipelineSource.result.assets)
    ? pipelineSource.result.assets
    : [];
  for (const raw of resultAssets) {
    addReachable(typeof raw === "string" ? raw : raw && (raw.asset_id || raw.id));
  }
  for (const raw of Array.isArray(pipelineSource.selected_layer_ids) ? pipelineSource.selected_layer_ids : []) {
    addReachable(raw);
  }
  const recovery = pipelineSource.recovery && typeof pipelineSource.recovery === "object" &&
    !Array.isArray(pipelineSource.recovery) ? pipelineSource.recovery : null;
  const recoveryHasList = Boolean(recovery && Array.isArray(recovery.vector_input_asset_ids));
  const recoveryIds = recoveryHasList
    ? recovery.vector_input_asset_ids.map((item) => textValue(item)).filter(Boolean)
    : [];
  for (const id of recoveryIds) addReachable(id);
  const authoritativeIds = new Set(recoveryIds);

  const queue = Array.from(reachable);
  while (queue.length) {
    const parentId = queue.shift();
    for (const [id, asset] of byId) {
      if (reachable.has(id)) continue;
      const parents = Array.isArray(asset.parents)
        ? asset.parents
        : asset.metadata && Array.isArray(asset.metadata.parents)
          ? asset.metadata.parents
          : [];
      const linked = parents.some((parent) => firstValue(parent && (parent.asset_id || parent.id), parent) === parentId);
      if (linked) {
        reachable.add(id);
        queue.push(id);
      }
    }
  }

  const output = [];
  const seen = new Set();
  for (const [id, asset] of byId) {
    if (seen.has(id)) continue;
    const kind = normalizeKind(asset.kind);
    const mime = textValue(asset.mime_type || asset.media_type || asset.content_type || asset.mime).toLowerCase();
    const authoritative = authoritativeIds.has(id);
    if (recoveryHasList && !authoritative) continue;
    if (!authoritative && !WORKFLOW_PNG_KINDS.includes(kind)) continue;
    if (kind.includes("svg") || kind.includes("mask") || kind.includes("export") ||
        kind.includes("archive") || kind.includes("zip")) continue;
    if (mime && !mime.includes("png")) continue;
    const context = asset._context && typeof asset._context === "object" ? asset._context : {};
    const linkedByContext = Boolean(pipelineId) && firstValue(context.aiPipelineId, asset.ai_pipeline_id) === pipelineId;
    if (!reachable.has(id) && !linkedByContext && !authoritative) continue;
    seen.add(id);
    output.push(asset);
  }
  return output;
}

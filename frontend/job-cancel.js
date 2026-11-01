"use strict";

/* Cancellation policy for local jobs.
 *
 * The UI distinguishes "cancel the local processing", "abandon this page's
 * tracking" and "cancel a paid external call". The backend answers with the
 * real terminal state: a cancel request that races with success returns the
 * succeeded job, and tasks that may hold an external call answer 409.
 */

const EXTERNAL_CALL_KINDS = new Set([
  "decompose_layers",
  "decomposition",
  "decompose",
  "ai_decompose",
  "ai_pipeline",
  "ai_decomposition"
]);

function normalizeKind(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/\s+/g, "_");
}

function stateOf(job) {
  return String((job && job.state) || "").toLowerCase();
}

/**
 * @returns {{supported:boolean, reason:string, ended:boolean, paid:boolean}}
 */
export function cancelEligibility(job) {
  if (!job) {
    return { supported: false, reason: "当前没有可取消的任务。", ended: false, paid: false };
  }
  const state = stateOf(job);
  if (state === "succeeded" || state === "failed" || state === "cancelled") {
    return { supported: false, reason: "任务已经结束，不需要取消。", ended: true, paid: false };
  }
  if (state !== "queued" && state !== "running") {
    return { supported: false, reason: "任务状态未知，请先重新查询。", ended: false, paid: false };
  }
  const kind = normalizeKind(job.kind);
  if (EXTERNAL_CALL_KINDS.has(kind)) {
    return {
      supported: false,
      reason: "AI 付费调用的取消尚未开放；页面不会伪报“已停止”，也不会自动重发。请等待真实终态。",
      ended: false,
      paid: true
    };
  }
  const parameters = job.parameters && typeof job.parameters === "object" ? job.parameters : {};
  if (kind === "repair" && !parameters.provider_call_id) {
    return {
      supported: false,
      reason: "此修复可能已在外部服务执行，取消前必须先核对供应商状态；本次不发送取消请求。",
      ended: false,
      paid: true
    };
  }
  return {
    supported: true,
    reason: state === "queued"
      ? "任务仍在排队，取消后不会再被处理。"
      : "本地任务可请求停止；已完成步骤的成果会保留在历史中。",
    ended: false,
    paid: false
  };
}

export function cancelledMessage() {
  return "任务已取消，未应用到工作区；处理起点已恢复，已完成的中间成果保留在历史中。";
}

export function successRaceMessage() {
  return "取消请求到达前任务已经完成。页面按真实成功终态处理，没有伪报停止；可用“撤销”回到处理前。";
}

export function cancelConflictMessage(error) {
  const status = error && Number(error.status);
  const code = String((error && error.code) || "");
  if (code === "CANCEL_REQUIRES_RECONCILIATION") {
    return "服务端拒绝取消：该任务可能已提交外部调用，必须先核对供应商状态。本次没有重发或产生新费用。";
  }
  if (status === 409) {
    return "任务状态已经变化（可能已完成或已被取消）。请以重新读取的真实状态为准；如果已完成，可用“撤销”回到处理前。";
  }
  if (status === 404) {
    return "没有找到可取消的任务，或取消接口尚未就绪。请刷新任务状态；页面不会自动重新提交任务。";
  }
  if (status === 0) {
    return "取消请求没有得到确定响应。请先“重新查询”任务状态再决定；页面不会自动再次发送取消请求。";
  }
  return "取消请求未被接受：" + (error && error.message ? error.message : "请重新查询任务状态。");
}

export function isCancelled(job) {
  return stateOf(job) === "cancelled";
}

/**
 * Decide how to treat a terminal task after a confirmed cancel intent.
 * The state is always reported as the server returned it; "history-only" means
 * a succeeded result must never be applied automatically in this race.
 */
export function cancelTerminalOutcome(job, intent) {
  if (!job) return { action: "none", state: "" };
  const state = stateOf(job);
  if (!["succeeded", "failed", "cancelled"].includes(state)) {
    return { action: "wait", state };
  }
  const matches = Boolean(intent && String(intent.jobId) === String(job.job_id));
  if (!matches) return { action: "normal", state };
  if (state === "succeeded") return { action: "history-only", state };
  if (state === "cancelled") return { action: "restore", state };
  return { action: "normal", state };
}

export { normalizeKind };

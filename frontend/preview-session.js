"use strict";

/* One unapplied preview for the current input image.
 *
 * A preview is bound to the input asset, the parameter revision that produced
 * it, and the job that created it. Late or cancelled responses must not replace
 * the canvas or the current workspace, and an expired preview is never applied.
 * The module owns only this small state machine; rendering and job polling stay
 * in the page.
 */

export const PREVIEW_TTL_MS = 30 * 60 * 1000;

const ACTIVE_STATES = new Set(["pending", "ready"]);

function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function copySession(session) {
  if (!session) return null;
  return {
    ...session,
    params: cloneJson(session.params || {}),
    processingSize: session.processingSize ? { ...session.processingSize } : null,
    assetIds: Array.isArray(session.assetIds) ? [...session.assetIds] : [],
    resultAssets: Array.isArray(session.resultAssets) ? cloneJson(session.resultAssets) : []
  };
}

export function createPreviewSession(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
    ? options.ttlMs
    : PREVIEW_TTL_MS;
  const nowFn = typeof options.now === "function" ? options.now : Date.now;
  const idFactory = typeof options.idFactory === "function"
    ? options.idFactory
    : () => "pv_" + Math.random().toString(36).slice(2, 10);

  let session = null;

  function begin(input = {}) {
    const startedAt = nowFn();
    session = {
      id: input.id || idFactory(),
      inputAssetId: String(input.inputAssetId || ""),
      returnAssetId: String(input.returnAssetId || input.inputAssetId || ""),
      stage: String(input.stage || ""),
      baseAssetId: String(input.baseAssetId || ""),
      revision: Number(input.revision) || 0,
      params: cloneJson(input.params || {}),
      label: String(input.label || "预览"),
      kind: String(input.kind || ""),
      jobId: String(input.jobId || ""),
      state: "pending",
      error: "",
      createdAt: startedAt,
      readyAt: null,
      expiresAt: startedAt + ttlMs,
      scale: Number.isFinite(input.scale) ? input.scale : 1,
      processingSize: input.processingSize ? { ...input.processingSize } : null,
      assetIds: [],
      targetId: "",
      resultAssets: []
    };
    return copySession(session);
  }

  function attachJob(jobId) {
    if (!session) return false;
    session.jobId = String(jobId || "");
    return true;
  }

  function isExpired(now = nowFn()) {
    return Boolean(session && ACTIVE_STATES.has(session.state) && session.expiresAt <= now);
  }

  function expire(now = nowFn()) {
    if (!session || !isExpired(now)) return false;
    session.state = "expired";
    return true;
  }

  function resolve(input = {}) {
    if (!session) return { status: "none" };
    const now = Number.isFinite(input.now) ? input.now : nowFn();
    if (isExpired(now)) {
      session.state = "expired";
      return { status: "expired", session: copySession(session) };
    }
    if (!ACTIVE_STATES.has(session.state)) {
      return { status: session.state, session: copySession(session) };
    }
    if (session.state !== "pending") {
      return { status: "ready", session: copySession(session) };
    }
    const jobId = String(input.jobId || "");
    if (!session.jobId || jobId !== session.jobId) {
      return { status: "foreign", session: copySession(session) };
    }
    const revision = Number(input.revision);
    const currentInputId = String(input.inputAssetId || "");
    const currentBaseId = String(input.baseAssetId || "");
    if (
      revision !== session.revision ||
      currentInputId !== session.inputAssetId ||
      (session.baseAssetId && currentBaseId !== session.baseAssetId)
    ) {
      session.state = "stale";
      return { status: "stale", session: copySession(session) };
    }
    session.state = "ready";
    session.readyAt = now;
    session.assetIds = Array.isArray(input.assetIds) ? input.assetIds.map(String) : [];
    session.targetId = String(input.targetId || "");
    session.resultAssets = Array.isArray(input.resultAssets) ? cloneJson(input.resultAssets) : [];
    if (input.processingSize) {
      session.processingSize = { ...input.processingSize };
    }
    return { status: "ready", session: copySession(session) };
  }

  function invalidate(reason = "stale") {
    if (!session || !ACTIVE_STATES.has(session.state)) return false;
    session.state = reason;
    return true;
  }

  function fail(message) {
    if (!session) return false;
    session.state = "failed";
    session.error = String(message || "");
    return true;
  }

  function cancel() {
    if (!session) return false;
    session.state = "cancelled";
    return true;
  }

  function markApplied() {
    if (!session) return false;
    session.state = "applied";
    return true;
  }

  /** Returns the check result; never mutates the workspace. */
  function canApply(input = {}) {
    if (!session) return { ok: false, reason: "none" };
    const now = Number.isFinite(input.now) ? input.now : nowFn();
    if (isExpired(now)) {
      session.state = "expired";
      return { ok: false, reason: "expired", session: copySession(session) };
    }
    if (session.state !== "ready") {
      return { ok: false, reason: session.state, session: copySession(session) };
    }
    const revision = Number(input.revision);
    if (Number.isFinite(revision) && revision !== session.revision) {
      session.state = "stale";
      return { ok: false, reason: "stale", session: copySession(session) };
    }
    const inputAssetId = String(input.inputAssetId || "");
    if (inputAssetId && inputAssetId !== session.inputAssetId) {
      session.state = "stale";
      return { ok: false, reason: "input_changed", session: copySession(session) };
    }
    const baseAssetId = String(input.baseAssetId || "");
    if (session.baseAssetId && baseAssetId !== session.baseAssetId) {
      session.state = "stale";
      return { ok: false, reason: "input_changed", session: copySession(session) };
    }
    return { ok: true, session: copySession(session) };
  }

  function isActive() {
    return Boolean(session && ACTIVE_STATES.has(session.state));
  }

  function remainingMs(now = nowFn()) {
    if (!session) return 0;
    return Math.max(0, session.expiresAt - now);
  }

  function current() {
    return copySession(session);
  }

  function snapshot() {
    return copySession(session);
  }

  function restore(value) {
    session = value ? copySession(value) : null;
    return copySession(session);
  }

  function discard() {
    const previous = copySession(session);
    session = null;
    return previous;
  }

  function clear() {
    session = null;
  }

  return {
    ttlMs,
    begin,
    attachJob,
    resolve,
    invalidate,
    fail,
    cancel,
    markApplied,
    canApply,
    isActive,
    isExpired,
    expire,
    remainingMs,
    current,
    snapshot,
    restore,
    discard,
    clear
  };
}

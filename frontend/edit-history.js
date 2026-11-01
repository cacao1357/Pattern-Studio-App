"use strict";

/* Snapshot-based edit history for the current image/document.
 *
 * Every entry is an opaque workspace snapshot supplied by the page. The module
 * only tracks order, merges rapid parameter revisions, and bounds memory.
 * It never regenerates results: undo/redo restores references that already
 * exist, so redo does not submit another job or paid call.
 */

export const DEFAULT_HISTORY_LIMIT = 80;
export const DEFAULT_MERGE_WINDOW_MS = 1200;

export function createEditHistory(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : DEFAULT_HISTORY_LIMIT;
  const mergeWindowMs = Number.isFinite(options.mergeWindowMs)
    ? Math.max(0, options.mergeWindowMs)
    : DEFAULT_MERGE_WINDOW_MS;
  const nowFn = typeof options.now === "function" ? options.now : Date.now;

  let entries = [];
  let index = -1;
  let merge = null;

  function reset(state, opts = {}) {
    entries = state === undefined || state === null
      ? []
      : [{ state, label: opts.label || "当前状态" }];
    index = entries.length - 1;
    merge = null;
    return api;
  }

  function push(state, opts = {}) {
    if (state === undefined || state === null) return { action: "ignored" };
    const label = opts.label || "编辑";
    const mergeKey = opts.mergeKey ? String(opts.mergeKey) : "";
    const now = nowFn();
    if (
      mergeKey &&
      merge &&
      merge.key === mergeKey &&
      index === entries.length - 1 &&
      now - merge.at <= mergeWindowMs
    ) {
      entries[index] = { state, label };
      merge.at = now;
      return { action: "merged", label };
    }
    if (index >= 0 && index < entries.length - 1) {
      entries = entries.slice(0, index + 1);
    }
    entries.push({ state, label });
    while (entries.length > limit + 1) entries.shift();
    index = entries.length - 1;
    merge = mergeKey ? { key: mergeKey, at: now } : null;
    return { action: "pushed", label };
  }

  function undo() {
    if (index <= 0) return null;
    index -= 1;
    merge = null;
    return { state: entries[index].state, label: entries[index + 1].label, index };
  }

  function redo() {
    if (index < 0 || index >= entries.length - 1) return null;
    index += 1;
    merge = null;
    return { state: entries[index].state, label: entries[index].label, index };
  }

  function current() {
    return index >= 0 ? entries[index] : null;
  }

  function canUndo() {
    return index > 0;
  }

  function canRedo() {
    return index >= 0 && index < entries.length - 1;
  }

  function undoLabel() {
    return canUndo() ? entries[index].label : "";
  }

  function redoLabel() {
    return canRedo() ? entries[index + 1].label : "";
  }

  function size() {
    return entries.length;
  }

  function states() {
    return entries.map((entry) => entry.state);
  }

  const api = {
    reset,
    push,
    undo,
    redo,
    current,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    size,
    states,
    limit,
    mergeWindowMs
  };
  return api;
}

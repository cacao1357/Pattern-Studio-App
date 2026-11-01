"use strict";

/* Per-stroke undo/redo inside the foreground-mask brush.
 *
 * One pointer drag is one action. Invert/denoise toggles are recorded as
 * option actions so Ctrl+Z can also return to the previous mask options.
 * The module never rasterizes: it derives the stroke list and option state,
 * and the page rebuilds the mask from them.
 */

export const DEFAULT_BRUSH_ACTION_LIMIT = 160;

export function createBrushHistory(options = {}) {
  const maxActions = Number.isInteger(options.maxActions) && options.maxActions > 0
    ? options.maxActions
    : DEFAULT_BRUSH_ACTION_LIMIT;

  let baseline = { invert: false, denoise: 0 };
  let actions = [];
  let cursor = 0;

  function reset(initial = {}) {
    baseline = {
      invert: Boolean(initial.invert),
      denoise: Number(initial.denoise) || 0
    };
    actions = [];
    cursor = 0;
  }

  function truncate() {
    if (cursor < actions.length) actions = actions.slice(0, cursor);
  }

  function trim() {
    if (actions.length <= maxActions) return;
    const excess = actions.length - maxActions;
    const removed = actions.splice(0, excess);
    for (const action of removed) {
      if (action.type === "option") {
        baseline = { invert: action.invert, denoise: action.denoise };
      }
    }
    cursor = Math.max(0, cursor - excess);
  }

  function pushStroke(stroke) {
    if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) return false;
    if (!["add", "erase"].includes(stroke.mode)) return false;
    const radius = Number(stroke.radius);
    if (!Number.isInteger(radius) || radius < 1) return false;
    truncate();
    actions.push({
      type: "stroke",
      stroke: {
        mode: stroke.mode,
        radius,
        points: stroke.points.map((point) => ({ x: Number(point.x), y: Number(point.y) }))
      }
    });
    cursor = actions.length;
    trim();
    return true;
  }

  function pushOption(options = {}) {
    const invert = Boolean(options.invert);
    const denoise = Number(options.denoise) || 0;
    const derived = state();
    if (derived.invert === invert && derived.denoise === denoise) return false;
    truncate();
    actions.push({ type: "option", invert, denoise });
    cursor = actions.length;
    trim();
    return true;
  }

  function undo() {
    if (cursor <= 0) return null;
    const action = actions[cursor - 1];
    cursor -= 1;
    return action;
  }

  function redo() {
    if (cursor >= actions.length) return null;
    const action = actions[cursor];
    cursor += 1;
    return action;
  }

  function state() {
    let invert = baseline.invert;
    let denoise = baseline.denoise;
    const strokes = [];
    let points = 0;
    for (let index = 0; index < cursor; index += 1) {
      const action = actions[index];
      if (action.type === "stroke") {
        strokes.push(action.stroke);
        points += action.stroke.points.length;
      } else if (action.type === "option") {
        invert = action.invert;
        denoise = action.denoise;
      }
    }
    return { strokes, invert, denoise, strokeCount: strokes.length, pointCount: points };
  }

  function canUndo() {
    return cursor > 0;
  }

  function canRedo() {
    return cursor < actions.length;
  }

  function undoLabel() {
    if (!canUndo()) return "";
    const action = actions[cursor - 1];
    return action.type === "stroke" ? "撤销一笔" : "撤销参数切换";
  }

  function redoLabel() {
    if (!canRedo()) return "";
    const action = actions[cursor];
    return action.type === "stroke" ? "重做一笔" : "重做参数切换";
  }

  function clear() {
    actions = [];
    cursor = 0;
  }

  function actionCount() {
    return actions.length;
  }

  return {
    maxActions,
    reset,
    pushStroke,
    pushOption,
    undo,
    redo,
    state,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    clear,
    actionCount
  };
}

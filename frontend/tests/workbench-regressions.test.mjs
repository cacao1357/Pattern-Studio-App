import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// workbench.js is a browser module with no exports. These tests extract the
// relevant top-level functions from the real source and run them with explicit
// state/network/dialog doubles, so the checks stay deterministic without a DOM.
const source = await readFile(new URL("../workbench.js", import.meta.url), "utf8");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchingBrace(text, openIndex) {
  let depth = 0;
  let mode = "code";
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (mode === "code") {
      if (char === "/" && next === "/") {
        mode = "line";
        index += 1;
      } else if (char === "/" && next === "*") {
        mode = "block";
        index += 1;
      } else if (char === "'") {
        mode = "single";
      } else if (char === '"') {
        mode = "double";
      } else if (char === "`") {
        mode = "template";
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) return index;
      }
    } else if (mode === "line") {
      if (char === "\n") mode = "code";
    } else if (mode === "block") {
      if (char === "*" && next === "/") {
        mode = "code";
        index += 1;
      }
    } else if (mode === "single" || mode === "double") {
      if (char === "\\") {
        index += 1;
      } else if ((mode === "single" && char === "'") || (mode === "double" && char === '"')) {
        mode = "code";
      }
    } else if (mode === "template") {
      if (char === "\\") {
        index += 1;
      } else if (char === "`") {
        mode = "code";
      }
    }
  }
  throw new Error("Unbalanced function body");
}

function extractFunction(name) {
  const pattern = new RegExp("(?:^|\\n)((?:async\\s+)?function\\s+" + escapeRegExp(name) + "\\s*\\()");
  const match = pattern.exec(source);
  if (!match) throw new Error("Function not found: " + name);
  const start = match.index + match[0].indexOf(match[1]);
  const openIndex = source.indexOf("{", match.index + match[0].length);
  if (openIndex === -1) throw new Error("Function body not found: " + name);
  const closeIndex = matchingBrace(source, openIndex);
  return source.slice(start, closeIndex + 1);
}

function loadFunctions(names, dependencies) {
  const body = names.map(extractFunction).join("\n\n");
  const keys = Object.keys(dependencies);
  const factory = new Function(...keys, body + "\nreturn { " + names.join(", ") + " };");
  return factory(...keys.map((key) => dependencies[key]));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function settle(value, argument) {
  return typeof value === "function" ? value(argument) : value;
}

function duplicateHarness(overrides) {
  const opts = overrides || {};
  const calls = {
    confirm: [],
    request: [],
    adopt: [],
    preview: [],
    brush: [],
    bbox: [],
    toast: [],
    updates: 0
  };
  const state = {
    uploadDuplicates: [{ image_id: "dup-1", ncc: 0.993, status: "confirmed" }],
    currentInputId: "current-1",
    requestInFlight: false,
    cancelBusy: false,
    pendingSubmission: null,
    taskRunning: false,
    duplicateSwitching: false,
    duplicateSwitchToken: 0,
    ...(opts.state || {})
  };
  const dependencies = {
    state,
    confirmAction: async (options) => {
      calls.confirm.push(options);
      return settle(opts.confirm === undefined ? true : opts.confirm, options);
    },
    requestJson: async (path) => {
      calls.request.push(path);
      if (opts.request) return opts.request(path);
      return {
        data: {
          image_id: "dup-1",
          normalized: { asset_id: "dup-normalized" },
          source_note: "已有版本"
        }
      };
    },
    adoptImageRecord: async (data, options) => {
      calls.adopt.push({ data, options });
    },
    guardPendingPreview: async (label) => {
      calls.preview.push(label);
      return settle(opts.preview === undefined ? true : opts.preview, label);
    },
    guardUnsavedBrush: async (label) => {
      calls.brush.push(label);
      return settle(opts.brush === undefined ? true : opts.brush, label);
    },
    guardUnsavedBBox: async (label) => {
      calls.bbox.push(label);
      return settle(opts.bbox === undefined ? true : opts.bbox, label);
    },
    showToast: (message, tone) => calls.toast.push({ message, tone }),
    friendlyError: (error) => String((error && error.message) || error || ""),
    updateActionState: () => {
      calls.updates += 1;
    }
  };
  const api = loadFunctions(
    ["workspaceBusyReason", "duplicateSwitchBlockReason", "useExistingDuplicate"],
    dependencies
  );
  return { api, state, calls };
}

test("duplicate image switch refuses to reset while work is active", async () => {
  const busyStates = [
    { taskRunning: true },
    { requestInFlight: true },
    { cancelBusy: true },
    { pendingSubmission: { label: "unknown" } },
    { duplicateSwitching: true }
  ];
  for (const busy of busyStates) {
    const harness = duplicateHarness({ state: busy });
    await harness.api.useExistingDuplicate();
    assert.equal(harness.calls.request.length, 0, JSON.stringify(busy));
    assert.equal(harness.calls.confirm.length, 0, JSON.stringify(busy));
    assert.equal(harness.calls.adopt.length, 0, JSON.stringify(busy));
    assert.equal(harness.calls.toast.at(-1)?.tone, "warning", JSON.stringify(busy));
  }
});

test("duplicate image switch asks before replacing the current workspace", async () => {
  const harness = duplicateHarness({ confirm: false });
  await harness.api.useExistingDuplicate();
  assert.equal(harness.calls.confirm.length, 1);
  assert.match(harness.calls.confirm[0].title, /切换/);
  assert.match(harness.calls.confirm[0].message, /当前画布/);
  assert.equal(harness.calls.request.length, 0);
  assert.equal(harness.calls.adopt.length, 0);
  assert.equal(harness.calls.preview.length, 0);
  assert.equal(harness.calls.brush.length, 0);
  assert.equal(harness.calls.bbox.length, 0);
  assert.equal(harness.state.duplicateSwitching, false);
  assert.ok(harness.calls.updates >= 2);
});

test("duplicate image switch honours cancellation of preview, brush and bbox", async () => {
  for (const guard of ["preview", "brush", "bbox"]) {
    const harness = duplicateHarness({ [guard]: false });
    await harness.api.useExistingDuplicate();
    assert.equal(harness.calls.confirm.length, 1, guard);
    assert.equal(harness.calls[guard].length, 1, guard);
    assert.equal(harness.calls.adopt.length, 0, guard);
    assert.equal(harness.state.duplicateSwitching, false, guard);
  }
});

test("duplicate image switch adopts only after all confirmations", async () => {
  const harness = duplicateHarness();
  await harness.api.useExistingDuplicate();
  assert.equal(harness.calls.request[0], "/images/dup-1");
  assert.deepEqual(harness.calls.preview, ["切换到已有版本"]);
  assert.deepEqual(harness.calls.brush, ["切换到已有版本"]);
  assert.deepEqual(harness.calls.bbox, ["切换到已有版本"]);
  assert.equal(harness.calls.adopt.length, 1);
  assert.equal(harness.calls.adopt[0].data.image_id, "dup-1");
  assert.deepEqual(harness.calls.adopt[0].options.duplicates, []);
  assert.equal(harness.state.duplicateSwitching, false);
});

test("duplicate image switch aborts if a task appears during the metadata request", async () => {
  const pending = deferred();
  const harness = duplicateHarness({ request: () => pending.promise });
  const operation = harness.api.useExistingDuplicate();
  await tick();
  assert.equal(harness.calls.request.length, 1);
  assert.equal(harness.state.duplicateSwitching, true);
  harness.state.taskRunning = true;
  pending.resolve({ data: { image_id: "dup-1", normalized: { asset_id: "dup-normalized" } } });
  await operation;
  assert.equal(harness.calls.adopt.length, 0);
  assert.equal(harness.state.duplicateSwitching, false);
  assert.ok(harness.calls.toast.some((entry) => entry.tone === "warning" && /任务处理中/.test(entry.message)));
});

test("duplicate image switch aborts if the workspace or duplicate list changes in flight", async () => {
  for (const change of ["workspace", "duplicates"]) {
    const pending = deferred();
    const harness = duplicateHarness({ request: () => pending.promise });
    const operation = harness.api.useExistingDuplicate();
    await tick();
    if (change === "workspace") harness.state.currentInputId = "other-workspace";
    else harness.state.uploadDuplicates = [];
    pending.resolve({ data: { image_id: "dup-1", normalized: { asset_id: "dup-normalized" } } });
    await operation;
    assert.equal(harness.calls.adopt.length, 0, change);
    assert.equal(harness.state.duplicateSwitching, false, change);
    assert.ok(harness.calls.toast.some((entry) => entry.tone === "warning"), change);
  }
});

test("duplicate image switch is re-entrancy safe while confirmation is pending", async () => {
  const pending = deferred();
  const harness = duplicateHarness({ request: () => pending.promise });
  const first = harness.api.useExistingDuplicate();
  await tick();
  const second = harness.api.useExistingDuplicate();
  await tick();
  assert.equal(harness.calls.request.length, 1);
  assert.equal(harness.calls.confirm.length, 1);
  pending.resolve({ data: { image_id: "dup-1", normalized: { asset_id: "dup-normalized" } } });
  await Promise.all([first, second]);
  assert.equal(harness.calls.adopt.length, 1);
  assert.equal(harness.state.duplicateSwitching, false);
});

test("duplicate image switch clears its guard when the metadata request fails", async () => {
  const harness = duplicateHarness({
    request: async () => {
      throw new Error("offline");
    }
  });
  await harness.api.useExistingDuplicate();
  assert.equal(harness.calls.adopt.length, 0);
  assert.equal(harness.state.duplicateSwitching, false);
  assert.ok(harness.calls.toast.some((entry) => entry.tone === "error" && /offline/.test(entry.message)));
});

test("duplicate switch blocks new submissions until it finishes", () => {
  const calls = { send: [], toast: [] };
  const state = { pendingSubmission: null, requestInFlight: false, duplicateSwitching: true };
  const api = loadFunctions(["startSubmission"], {
    state,
    showToast: (message, tone) => calls.toast.push({ message, tone }),
    newIdempotencyKey: () => "test-key",
    sendSubmission: (submission) => calls.send.push(submission)
  });
  assert.equal(api.startSubmission({ path: "/exports", label: "打包平铺单元" }), false);
  assert.equal(calls.send.length, 0);
  assert.ok(calls.toast.some((entry) => entry.tone === "warning"));
  state.duplicateSwitching = false;
  assert.equal(api.startSubmission({ path: "/exports", label: "打包平铺单元" }), true);
  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0].path, "/exports");
});

function tileZipHarness(overrides) {
  const opts = overrides || {};
  const calls = {
    confirm: [],
    submissions: [],
    errors: [],
    toast: []
  };
  const unitLicense = Object.hasOwn(opts, "unitLicense") ? opts.unitLicense : "未确认";
  const previewLicense = Object.hasOwn(opts, "previewLicense") ? opts.previewLicense : "未确认";
  const unit = { asset_id: "unit-1", kind: "cropped", license: unitLicense };
  const preview = { asset_id: "tile-1", kind: "tile_preview", license: previewLicense };
  const state = {
    requestInFlight: false,
    pendingSubmission: null,
    taskRunning: false,
    duplicateSwitching: false,
    assets: new Map([
      [unit.asset_id, unit],
      [preview.asset_id, preview]
    ]),
    tile: { unitId: "unit-1", resultAssetId: "tile-1" },
    ...(opts.state || {})
  };
  const dependencies = {
    state,
    dom: { tileError: { id: "tile-error" } },
    selectedTileUnit: () => (state.tile.unitId ? state.assets.get(state.tile.unitId) || null : null),
    setError: (node, message) => calls.errors.push({ node, message }),
    startSubmission: (config) => {
      calls.submissions.push(config);
      return true;
    },
    confirmAction: async (options) => {
      calls.confirm.push(options);
      return settle(opts.confirm === undefined ? true : opts.confirm, state);
    },
    showToast: (message, tone) => calls.toast.push({ message, tone }),
    friendlyError: (error) => String((error && error.message) || error || ""),
    ApiError: class ApiError extends Error {},
    extractJobFromResponse: () => ({ job_id: "export-job" }),
    adoptJob: async () => {}
  };
  const api = loadFunctions(
    ["unconfirmedLicenseIds", "confirmExportLicense", "handleTileZip"],
    dependencies
  );
  return { api, state, calls, unit, preview };
}

test("tile ZIP export refuses to submit while work is active", async () => {
  for (const busy of [
    { requestInFlight: true },
    { pendingSubmission: { label: "unknown" } },
    { taskRunning: true },
    { duplicateSwitching: true }
  ]) {
    const harness = tileZipHarness({ state: busy });
    await harness.api.handleTileZip();
    assert.equal(harness.calls.confirm.length, 0, JSON.stringify(busy));
    assert.equal(harness.calls.submissions.length, 0, JSON.stringify(busy));
  }
});

test("tile ZIP export keeps the license gate when confirmation is cancelled", async () => {
  const harness = tileZipHarness({ confirm: false });
  await harness.api.handleTileZip();
  assert.equal(harness.calls.confirm.length, 1);
  assert.match(harness.calls.confirm[0].message, /2 个/);
  assert.equal(harness.calls.submissions.length, 0);
});

test("tile ZIP export acknowledges licences only after confirmation", async () => {
  const harness = tileZipHarness({ confirm: true });
  await harness.api.handleTileZip();
  assert.equal(harness.calls.submissions.length, 1);
  const submission = harness.calls.submissions[0];
  assert.equal(submission.path, "/exports");
  assert.equal(submission.method, "POST");
  const body = JSON.parse(submission.bodyFactory());
  assert.deepEqual(body.asset_ids, ["unit-1", "tile-1"]);
  assert.equal(body.license_acknowledged, true);
});

test("tile ZIP export skips the dialog when every licence is confirmed", async () => {
  const harness = tileZipHarness({ unitLicense: "CC0", previewLicense: "已登记授权" });
  await harness.api.handleTileZip();
  assert.equal(harness.calls.confirm.length, 0);
  assert.equal(harness.calls.submissions.length, 1);
  const body = JSON.parse(harness.calls.submissions[0].bodyFactory());
  assert.equal(body.license_acknowledged, false);
});

test("tile ZIP export counts missing licence metadata as unconfirmed", async () => {
  const harness = tileZipHarness({ unitLicense: "", previewLicense: "CC0" });
  await harness.api.handleTileZip();
  assert.equal(harness.calls.confirm.length, 1);
  assert.match(harness.calls.confirm[0].message, /1 个/);
  assert.equal(JSON.parse(harness.calls.submissions[0].bodyFactory()).license_acknowledged, true);
});

test("tile ZIP export re-checks state after the async licence dialog", async () => {
  const busy = tileZipHarness({
    confirm: (state) => {
      state.taskRunning = true;
      return true;
    }
  });
  await busy.api.handleTileZip();
  assert.equal(busy.calls.submissions.length, 0);
  assert.ok(busy.calls.errors.some((entry) => /正在处理/.test(entry.message)));

  const stale = tileZipHarness({
    confirm: (state) => {
      state.tile.resultAssetId = "other-tile";
      return true;
    }
  });
  await stale.api.handleTileZip();
  assert.equal(stale.calls.submissions.length, 0);
  assert.ok(stale.calls.errors.some((entry) => /已变化/.test(entry.message)));
});

function lineartRequestHarness(overrides) {
  const opts = overrides || {};
  const lineartError = { hidden: true, textContent: "" };
  const dom = { lineartError, lineartGroup: { open: false } };
  const api = loadFunctions(["lineartMethod", "buildLineartRequest"], {
    dom: dom,
    checkedValue: (name) => (name === "lineart-method" ? (opts.method || "local") : ""),
    currentAsset: () => (opts.asset === null ? null : { asset_id: "asset-1" }),
    requireProcessReady: () => opts.ready !== false
  });
  return { api, dom };
}

test("lineart keeps the existing OpenCV request and payload", () => {
  const harness = lineartRequestHarness();
  const request = harness.api.buildLineartRequest();
  assert.equal(request.ok, true);
  assert.equal(request.path, "/jobs/lineart");
  assert.equal(request.kind, "lineart");
  assert.equal(request.label, "线稿");
  assert.equal(request.errorNode, harness.dom.lineartError);
  assert.deepEqual(request.payload, { input_asset_id: "asset-1", local: true });
});

test("lineart model entry submits only the input and method", () => {
  const harness = lineartRequestHarness({ method: "model" });
  const request = harness.api.buildLineartRequest();
  assert.equal(request.label, "模型线稿");
  assert.equal(request.path, "/jobs/lineart");
  assert.deepEqual(request.payload, { input_asset_id: "asset-1", method: "model" });
  assert.equal("local" in request.payload, false);
});

test("lineart requests refuse an empty workspace or busy workbench", () => {
  assert.deepEqual(lineartRequestHarness({ asset: null }).api.buildLineartRequest(), {
    ok: false,
    error: "请先选择当前输入。"
  });
  assert.deepEqual(lineartRequestHarness({ ready: false }).api.buildLineartRequest(), {
    ok: false,
    handled: true
  });
});

function lineartFailureHarness() {
  const calls = { errors: [] };
  const lineartError = { hidden: true, textContent: "" };
  const lineartGroup = { open: false };
  const api = loadFunctions(
    ["normalizeKind", "lineartModelUnavailableText", "lineartFailureText", "reportLineartFailure"],
    {
      dom: { lineartError, lineartGroup },
      setError: (node, message) => {
        calls.errors.push({ node, message });
        node.textContent = message || "";
        node.hidden = !message;
      }
    }
  );
  return { api, calls, lineartError, lineartGroup };
}

test("lineart model failure is shown in the normal entry", () => {
  const harness = lineartFailureHarness();
  harness.api.reportLineartFailure({
    kind: "lineart",
    state: "failed",
    error: { code: "LINEART_MODEL_UNAVAILABLE", message: "weights missing" }
  });
  assert.equal(harness.lineartError.hidden, false);
  assert.match(harness.lineartError.textContent, /模型不可用/);
  assert.match(harness.lineartError.textContent, /OpenCV/);
  assert.match(harness.lineartError.textContent, /weights missing/);
  assert.equal(harness.lineartGroup.open, true);
});

test("lineart failure reporting ignores other job kinds", () => {
  const harness = lineartFailureHarness();
  harness.api.reportLineartFailure({ kind: "extract", error: { code: "EXTRACT_FAILED" } });
  assert.equal(harness.calls.errors.length, 0);
  assert.equal(harness.lineartGroup.open, false);
});

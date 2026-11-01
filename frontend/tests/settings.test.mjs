import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../settings.js", import.meta.url), "utf8");
const imported = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const {
  SETTINGS_API_PATH,
  buildSettingsUpdate,
  centsToYuan,
  composeRerunPayload,
  createSettingsClient,
  normalizeSettings,
  normalizeWorkflowTrace,
  selectionPolicyLabel,
  settingsBlockerLabels,
  settingsEffective,
  vectorizeRerunPayload,
  workflowPngCandidates,
  yuanToCents
} = imported;

const BASE_SETTINGS = {
  revision: 4,
  api_key_configured: true,
  model: "doubao-seedream-5-0-pro-260628",
  base_url: "https://ark.cn-beijing.volces.com/api/v3",
  paid_calls_enabled: true,
  pricing_confirmed: true,
  budget_cents: 1234,
  reservation_cents: 50,
  max_calls: 5,
  blockers: [],
  effective: "next_provider_job",
  requires_restart: false
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function startSettingsServer() {
  const state = {
    revision: 4,
    settings: { ...BASE_SETTINGS },
    requests: []
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const bodyText = await readBody(request);
    let body = null;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch (_) {
        body = null;
      }
    }
    state.requests.push({
      method: request.method,
      path: url.pathname,
      body,
      marker: request.headers["x-pattern-studio"] || "",
      contentType: request.headers["content-type"] || ""
    });
    const send = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (url.pathname !== "/api/v1/settings") {
      send(404, { error: { code: "NOT_FOUND", message: "not found" } });
      return;
    }
    if (request.method === "GET") {
      state.settings = { ...state.settings, revision: state.revision };
      send(200, state.settings);
      return;
    }
    if (request.method !== "PUT") {
      send(405, { error: { code: "METHOD_NOT_ALLOWED", message: "method not allowed" } });
      return;
    }
    if (!body || body.revision !== state.revision) {
      send(409, { error: { code: "STALE_SETTINGS", message: "Settings changed; reload and apply your update again" } });
      return;
    }
    if (typeof body.base_url !== "string" || !body.base_url.startsWith("https://ark.cn-beijing.volces.com/")) {
      send(422, { error: { code: "INVALID_REQUEST", message: "Check the documented fields, types and operation constraints" } });
      return;
    }
    state.revision += 1;
    state.settings = {
      ...state.settings,
      revision: state.revision,
      model: body.model,
      base_url: "https://ark.cn-beijing.volces.com/api/v3",
      paid_calls_enabled: body.paid_calls_enabled,
      pricing_confirmed: body.pricing_confirmed,
      budget_cents: body.budget_cents,
      reservation_cents: body.reservation_cents,
      max_calls: body.max_calls,
      api_key_configured: body.api_key_action === "clear" ? false : true
    };
    send(200, state.settings);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        base: "http://127.0.0.1:" + address.port + "/api/v1",
        state,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

function fetchAdapter(base) {
  return async (path, options) => {
    const opts = options || {};
    const headers = { Accept: "application/json" };
    if (opts.json !== undefined) headers["Content-Type"] = "application/json";
    if ((opts.method || "GET").toUpperCase() !== "GET") headers["X-Pattern-Studio"] = "local";
    const response = await fetch(base + path, {
      method: opts.method || "GET",
      headers,
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json)
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = null;
      }
    }
    if (!response.ok) {
      const error = new Error((data && data.error && data.error.message) || "request failed");
      error.status = response.status;
      error.code = data && data.error && data.error.code ? data.error.code : "";
      throw error;
    }
    return { data, status: response.status };
  };
}

function validForm(overrides) {
  return {
    revision: 4,
    apiKeyAction: "keep",
    model: "doubao-seedream-5-0-pro-260628",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    paidCallsEnabled: true,
    pricingConfirmed: true,
    budgetYuan: "12.34",
    reservationYuan: "0.50",
    maxCalls: 5,
    ...(overrides || {})
  };
}

test("yuan and cent conversion is exact and bounded", () => {
  assert.deepEqual(yuanToCents("0"), { ok: true, cents: 0 });
  assert.deepEqual(yuanToCents("0.1"), { ok: true, cents: 10 });
  assert.deepEqual(yuanToCents("12.34"), { ok: true, cents: 1234 });
  assert.deepEqual(yuanToCents("1000000.00"), { ok: true, cents: 100000000 });
  for (const invalid of ["", "-1", "1.234", ".5", "1.", "abc", "1000000.01", "1 2"]) {
    const result = yuanToCents(invalid);
    assert.equal(result.ok, false, invalid);
    assert.ok(result.error);
  }
  assert.equal(centsToYuan(0), "0.00");
  assert.equal(centsToYuan(5), "0.05");
  assert.equal(centsToYuan(1234), "12.34");
  assert.equal(centsToYuan(100000000), "1000000.00");
  assert.equal(centsToYuan(-1), "");
});

test("settings payload keeps the key only for replace", () => {
  const keep = buildSettingsUpdate(validForm());
  assert.equal(keep.ok, true);
  assert.equal(keep.payload.budget_cents, 1234);
  assert.equal(keep.payload.reservation_cents, 50);
  assert.equal(Object.hasOwn(keep.payload, "api_key"), false);

  const clear = buildSettingsUpdate(validForm({ apiKeyAction: "clear", apiKey: "should-not-leak" }));
  assert.equal(clear.ok, true);
  assert.equal(clear.payload.api_key_action, "clear");
  assert.equal(Object.hasOwn(clear.payload, "api_key"), false);

  const replace = buildSettingsUpdate(validForm({ apiKeyAction: "replace", apiKey: "sk-test-abc_123" }));
  assert.equal(replace.ok, true);
  assert.equal(replace.payload.api_key, "sk-test-abc_123");
  assert.equal(Object.keys(replace.payload).filter((key) => key === "api_key").length, 1);

  assert.equal(buildSettingsUpdate(validForm({ apiKeyAction: "replace" })).ok, false);
  assert.equal(buildSettingsUpdate(validForm({ apiKeyAction: "replace", apiKey: "bad key" })).ok, false);
  assert.equal(buildSettingsUpdate(validForm({ apiKeyAction: "replace", apiKey: "密钥" })).ok, false);
  assert.equal(buildSettingsUpdate(validForm({ budgetYuan: "1.234" })).ok, false);
  assert.equal(buildSettingsUpdate(validForm({ maxCalls: 0 })).ok, false);
  assert.equal(buildSettingsUpdate(validForm({ revision: 0 })).ok, false);
});

test("settings normalization and effective state expose blockers", () => {
  const settings = normalizeSettings(BASE_SETTINGS);
  assert.equal(settings.revision, 4);
  assert.equal(settings.apiKeyConfigured, true);
  assert.equal(settings.budgetCents, 1234);
  assert.equal(settingsEffective(settings).ready, true);
  const withUnexpectedSecret = normalizeSettings({ ...BASE_SETTINGS, api_key: "sk-must-not-be-retained" });
  assert.equal(JSON.stringify(withUnexpectedSecret).includes("sk-must-not-be-retained"), false);

  const blocked = normalizeSettings({
    ...BASE_SETTINGS,
    api_key_configured: false,
    paid_calls_enabled: false,
    pricing_confirmed: false,
    budget_cents: 0,
    blockers: ["API_KEY_MISSING", "PAID_CALLS_DISABLED", "UNKNOWN_CODE"]
  });
  const effective = settingsEffective(blocked);
  assert.equal(effective.ready, false);
  assert.ok(effective.labels.some((line) => line.includes("API Key")));
  assert.ok(effective.labels.some((line) => line.includes("付费")));
  assert.ok(effective.labels.some((line) => line.includes("价格")));
  assert.ok(effective.labels.some((line) => line.includes("UNKNOWN_CODE")));
  assert.equal(settingsBlockerLabels(["API_KEY_MISSING"]).length, 1);
  assert.throws(() => normalizeSettings({ revision: 0 }), /revision/);
});

test("settings client performs real GET/PUT, conflict and validation handling", async () => {
  const server = await startSettingsServer();
  const client = createSettingsClient({ request: fetchAdapter(server.base) });
  try {
    const loaded = await client.load();
    assert.equal(loaded.revision, 4);
    assert.equal(loaded.apiKeyConfigured, true);

    const saved = await client.save(buildSettingsUpdate(validForm({ budgetYuan: "99.99" })).payload);
    assert.equal(saved.revision, 5);
    assert.equal(saved.budgetCents, 9999);

    const keepRequest = server.state.requests.filter((item) => item.method === "PUT").at(-1);
    assert.equal(keepRequest.path, "/api/v1/settings");
    assert.equal(keepRequest.marker, "local");
    assert.equal(Object.hasOwn(keepRequest.body, "api_key"), false);
    assert.equal(keepRequest.body.budget_cents, 9999);

    const secret = "sk-test-never-echo-123";
    const replaced = buildSettingsUpdate(validForm({
      revision: 5,
      apiKeyAction: "replace",
      apiKey: secret,
      budgetYuan: "10.00"
    }));
    const replacedState = await client.save(replaced.payload);
    assert.equal(replacedState.revision, 6);
    assert.equal(JSON.stringify(replacedState).includes(secret), false);
    const replaceRequest = server.state.requests.filter((item) => item.method === "PUT").at(-1);
    assert.equal(replaceRequest.body.api_key, secret);

    const clearedState = await client.save(buildSettingsUpdate(validForm({
      revision: 6,
      apiKeyAction: "clear",
      apiKey: "ignored-in-clear"
    })).payload);
    assert.equal(clearedState.revision, 7);
    assert.equal(clearedState.apiKeyConfigured, false);
    const clearRequest = server.state.requests.filter((item) => item.method === "PUT").at(-1);
    assert.equal(Object.hasOwn(clearRequest.body, "api_key"), false);
    assert.equal(clearRequest.body.api_key_action, "clear");

    const stale = buildSettingsUpdate(validForm({ revision: 1 })).payload;
    await assert.rejects(client.save(stale), (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "STALE_SETTINGS");
      return true;
    });
    const conflictPuts = server.state.requests.filter((item) => item.method === "PUT" && item.body.revision === 1);
    assert.equal(conflictPuts.length, 1);

    const beforeInvalid = server.state.requests.length;
    const invalid = buildSettingsUpdate(validForm({
      revision: server.state.revision,
      apiKeyAction: "replace",
      apiKey: secret,
      baseUrl: "https://example.com/api"
    })).payload;
    await assert.rejects(client.save(invalid), (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
    assert.equal(server.state.requests.length, beforeInvalid + 1);
    assert.equal(server.state.requests.every((item) => item.path === "/api/v1/settings"), true);
    assert.equal(JSON.stringify(client).includes(secret), false);
    assert.equal(client.constructor, Object);
  } finally {
    await server.close();
  }
});

test("workflow trace reads workflow, recovery and branches without retrying", () => {
  const pipeline = {
    pipeline_id: "pipeline-1",
    input_asset_id: "input-1",
    workflow: {
      id: "pattern-preserve",
      version: 3,
      prompt_id: "prompt-main",
      prompt_version: "p2",
      model: "doubao-seedream-5-0-pro-260628",
      selection_policy: "auto_or_confirm",
      input_asset_id: "input-1",
      snapshot: { prompt_text: "保留轮廓、孔洞和颜色关系。" }
    },
    recovery: {
      can_compose: true,
      vector_input_asset_ids: ["png-1", "png-2"],
      needs_reconcile: true,
      provider_call_id: "call-1",
      automatic_provider_retry: false
    },
    branches: [
      { job_id: "job-compose", parent_job_id: "decompose-job", action: "compose", state: "succeeded", created_at: "2026-11-01T10:00:00Z" },
      { job: { job_id: "job-vector", kind: "vectorize", state: "queued" }, parent_id: "job-compose", parameters: { action: "vectorize" } }
    ]
  };
  const trace = normalizeWorkflowTrace(pipeline);
  assert.equal(trace.available, true);
  assert.equal(trace.workflow.id, "pattern-preserve");
  assert.equal(trace.workflow.version, "3");
  assert.equal(trace.workflow.promptVersion, "p2");
  assert.equal(trace.workflow.selectionPolicy, "auto_or_confirm");
  assert.equal(selectionPolicyLabel(trace.workflow.selectionPolicy), "自动或人工确认");
  assert.equal(trace.workflow.promptText, "保留轮廓、孔洞和颜色关系。");
  assert.equal(trace.recovery.uncertain, true);
  assert.equal(trace.recovery.retryable, false);
  assert.equal(trace.recovery.autoRetry, false);
  assert.equal(trace.recovery.needsReconcile, true);
  assert.equal(trace.recovery.canCompose, true);
  assert.deepEqual(trace.recovery.vectorInputAssetIds, ["png-1", "png-2"]);
  assert.equal(trace.recovery.providerCallId, "call-1");
  assert.equal(trace.recovery.automaticProviderRetry, false);
  assert.equal(trace.branches.length, 2);
  assert.equal(trace.branches[0].jobId, "job-compose");
  assert.equal(trace.branches[0].parentJobId, "decompose-job");
  assert.equal(trace.branches[1].jobId, "job-vector");
  assert.equal(trace.branches[1].parentJobId, "job-compose");
  assert.equal(trace.branches[1].action, "vectorize");

  const empty = normalizeWorkflowTrace({ pipeline_id: "p2" });
  assert.equal(empty.available, false);
  assert.equal(empty.recovery, null);
  assert.deepEqual(empty.branches, []);
});

test("local rerun payloads reuse selection and require the workflow PNG", () => {
  const compose = composeRerunPayload({ revision: 7, layerIds: ["layer-a", "layer-a", "layer-b"], vector: { mode: "color" } });
  assert.equal(compose.ok, true);
  assert.deepEqual(compose.payload, {
    action: "compose",
    revision: 7,
    layer_ids: ["layer-a", "layer-b"],
    vector: { mode: "color" }
  });
  assert.equal(composeRerunPayload({ revision: 7, layerIds: [] }).ok, false);
  assert.equal(composeRerunPayload({ revision: 0, layerIds: ["layer-a"] }).ok, false);

  const vector = vectorizeRerunPayload({
    revision: 7,
    inputAssetId: "png-1",
    vector: { mode: "color", max_colors: 8, detail: "medium" }
  });
  assert.equal(vector.ok, true);
  assert.equal(vector.payload.action, "vectorize");
  assert.equal(vector.payload.input_asset_id, "png-1");
  assert.equal(vectorizeRerunPayload({ revision: 7, inputAssetId: "", vector: { mode: "color" } }).ok, false);
  assert.equal(vectorizeRerunPayload({ revision: 7, inputAssetId: "png-1" }).ok, false);
});

test("workflow PNG candidates include composed and mask-correction descendants", () => {
  const assets = [
    { asset_id: "composed", kind: "composed_candidate", mime_type: "image/png" },
    { asset_id: "svg", kind: "color_svg", mime_type: "image/svg+xml" },
    { asset_id: "transparent", kind: "transparent_png", mime_type: "image/png", parents: [{ asset_id: "composed" }] },
    { asset_id: "accepted", kind: "accepted_repair", mime_type: "image/png", parents: [{ asset_id: "transparent" }] },
    { asset_id: "selected-layer", kind: "placed_generated_layer", mime_type: "image/png" },
    { asset_id: "unselected-layer", kind: "generated_layer", mime_type: "image/png" },
    { asset_id: "unrelated", kind: "transparent_png", mime_type: "image/png" },
    { asset_id: "mask", kind: "foreground_mask", mime_type: "image/png", parents: [{ asset_id: "composed" }] },
    { asset_id: "input", kind: "normalized_input", mime_type: "image/png", parents: [{ asset_id: "composed" }] },
    { asset_id: "working-copy", kind: "working_copy", mime_type: "image/png" },
    { asset_id: "context-child", kind: "transparent_png", mime_type: "image/png", _context: { aiPipelineId: "pipeline-1" } }
  ];
  const pipeline = {
    pipeline_id: "pipeline-1",
    result: { assets: [{ asset_id: "composed" }, { asset_id: "svg" }] },
    selected_layer_ids: ["selected-layer"]
  };
  const ids = workflowPngCandidates(pipeline, assets).map((asset) => asset.asset_id).sort();
  assert.deepEqual(ids, ["accepted", "composed", "context-child", "selected-layer", "transparent"]);

  const authoritative = workflowPngCandidates({
    ...pipeline,
    recovery: { vector_input_asset_ids: ["working-copy", "composed"] }
  }, assets).map((asset) => asset.asset_id).sort();
  assert.deepEqual(authoritative, ["composed", "working-copy"]);
  assert.deepEqual(workflowPngCandidates({
    ...pipeline,
    recovery: { vector_input_asset_ids: [] }
  }, assets), []);
  assert.deepEqual(workflowPngCandidates(pipeline, []), []);
});

test("settings module has no browser persistence or logging side effects", () => {
  assert.equal(/(?:^|[^.\w])(?:localStorage|sessionStorage|indexedDB)\s*[.[]/.test(source), false);
  assert.equal(/document\s*\.\s*cookie/.test(source), false);
  assert.match(source, /export const SETTINGS_API_PATH = "\/settings"/);
  assert.equal(/console\.(?:log|info|warn|error|debug)/.test(source), false);
  assert.equal(source.includes(SETTINGS_API_PATH), true);
});

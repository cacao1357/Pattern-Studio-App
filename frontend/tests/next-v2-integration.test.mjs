/* =============================================================================
   next-v2-integration.test.mjs — 新版工作台前端（ES Modules，无构建）的行为回归。
   做法：用 data: URL 递归加载真实的 next-v2 模块（相对 import 说明符替换成依赖的
   data URL），再用内存 fetch mock 返回真实 Response 驱动 api.js / store.js。
   不依赖浏览器、DOM、真实网络或真实计时；断言全部落在可观察行为上。
   ============================================================================= */

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/* ------------------------------------------------------------------ 模块加载 */

const JS_ROOT = new URL("../next-v2/js/", import.meta.url);
const moduleCache = new Map();
const RELATIVE_IMPORT = /from\s+["'](\.{1,2}\/[^"']+)["']/g;

async function loadRecord(specifier, baseUrl = JS_ROOT) {
  const url = new URL(specifier, baseUrl);
  const key = url.href;
  if (moduleCache.has(key)) return moduleCache.get(key);
  const pending = (async () => {
    let source = await readFile(url, "utf8");
    const dependencies = [...source.matchAll(RELATIVE_IMPORT)].map((match) => match[1]);
    for (const dependency of dependencies) {
      const dependencyRecord = await loadRecord(dependency, url);
      source = source
        .split(`from "${dependency}"`)
        .join(`from "${dependencyRecord.dataUrl}"`)
        .split(`from '${dependency}'`)
        .join(`from '${dependencyRecord.dataUrl}'`);
    }
    const dataUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
    return { dataUrl, module: await import(dataUrl) };
  })();
  moduleCache.set(key, pending);
  return pending;
}

const { module: storeModule } = await loadRecord("./store.js");
const { module: workbench } = await loadRecord("./views/workbench.js");
const { module: apiModule } = await loadRecord("./api.js");
const store = storeModule.store;

/* ------------------------------------------------------------------ fetch mock */

/*
 * 真实模块通过全局 fetch 发请求：安装一个内存路由。没有设置 handler 时原样转发给
 * 系统 fetch，这样同进程运行其它测试文件（如 settings.test.mjs 的真实本地服务）不受影响。
 */
const realFetch = globalThis.fetch;
const network = { handler: null, calls: [] };

const mockFetch = async (input, init = {}) => {
  if (!network.handler) return realFetch(input, init);
  const url = String(typeof input === "string" ? input : input?.url || input);
  const method = String(init.method || "GET").toUpperCase();
  let body = null;
  if (typeof init.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  const call = { url, path: url.split("?")[0], method, body };
  network.calls.push(call);
  return network.handler(call);
};

globalThis.fetch = mockFetch;

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const textResponse = (body, status = 200) => new Response(body, { status });

function setHandler(handler) {
  network.handler = handler;
}

function countCalls(path, method = "GET") {
  return network.calls.filter((call) => call.path === path && call.method === method).length;
}

function imageRecord(imageId) {
  return {
    image_id: imageId,
    normalized: { asset_id: `${imageId}-normalized`, kind: "normalized_input" },
    original: { asset_id: `${imageId}-original`, kind: "original" },
  };
}

function imageHandler(imageId) {
  return json(imageRecord(imageId));
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 2000, interval = 2 } = {}) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) throw new Error("waitFor timeout");
    await sleep(interval);
  }
}

/** 把 /api/v1/images/{id} 固定成指定图片记录，其它请求交给 handler。 */
function withImage(handler) {
  return (call) => {
    if (call.path.startsWith("/api/v1/images/")) {
      return imageHandler(call.path.split("/").pop());
    }
    return handler(call);
  };
}

beforeEach(() => {
  network.handler = null;
  network.calls.length = 0;
});

afterEach(() => {
  network.handler = null;
  network.calls.length = 0;
});

/* ------------------------------------------------------------------ 1. openAsset */

test("快速连续 openAsset 只发布最新结果，stale 返回 null", async () => {
  const slowResponse = deferred();
  setHandler((call) => {
    if (call.path === "/api/v1/assets/asset-slow") return slowResponse.promise;
    if (call.path === "/api/v1/assets/asset-fast") {
      return json({ asset_id: "asset-fast", kind: "cropped", width: 40, height: 30 });
    }
    throw new Error(`unexpected fetch: ${call.path}`);
  });
  store.resetSession();

  const pendingSlow = store.openAsset("asset-slow");
  await tick();
  const fast = await store.openAsset("asset-fast");
  assert.equal(fast.asset.asset_id, "asset-fast");
  assert.equal(store.session.currentAssetId, "asset-fast");

  slowResponse.resolve(json({ asset_id: "asset-slow", kind: "cropped", width: 10, height: 10 }));
  assert.equal(await pendingSlow, null);
  assert.equal(store.session.currentAssetId, "asset-fast");
  assert.deepEqual(store.session.assets.map((asset) => asset.asset_id), ["asset-fast"]);
});

test("resetSession 让仍在途的 openAsset 失效且不写入", async () => {
  const pendingResponse = deferred();
  setHandler((call) => {
    if (call.path === "/api/v1/assets/asset-pending") return pendingResponse.promise;
    throw new Error(`unexpected fetch: ${call.path}`);
  });
  store.resetSession();
  const pendingOpen = store.openAsset("asset-pending");
  await tick();
  store.resetSession();
  pendingResponse.resolve(json({ asset_id: "asset-pending", kind: "lineart" }));
  assert.equal(await pendingOpen, null);
  assert.deepEqual(store.session.assets, []);
  assert.equal(store.session.currentAssetId, "");
});

/* ------------------------------------------------------------------ 2. ensureSession / startFromImage */

test("ensureSession 慢响应不覆盖后发请求", async () => {
  const slowResponse = deferred();
  setHandler((call) => {
    if (call.path === "/api/v1/images/image-slow") return slowResponse.promise;
    if (call.path === "/api/v1/images/image-fast") return imageHandler("image-fast");
    throw new Error(`unexpected fetch: ${call.path}`);
  });
  store.resetSession();
  const pendingSlow = store.ensureSession("image-slow");
  await tick();
  const fast = await store.ensureSession("image-fast");
  assert.equal(fast.imageId, "image-fast");

  slowResponse.resolve(imageHandler("image-slow"));
  assert.equal(await pendingSlow, null);
  assert.equal(store.session.imageId, "image-fast");
});

test("startFromImage 在会话重置换后返回 null 且不发布", async () => {
  const pendingResponse = deferred();
  setHandler((call) => {
    if (call.path === "/api/v1/images/image-upload") return pendingResponse.promise;
    throw new Error(`unexpected fetch: ${call.path}`);
  });
  store.resetSession();
  const started = store.startFromImage({ image_id: "image-upload" });
  await tick();
  store.resetSession();
  pendingResponse.resolve(imageHandler("image-upload"));
  assert.equal(await started, null);
  assert.equal(store.session.imageId, "");
});

/* ------------------------------------------------------------------ 2b. 上传阶段归属 */

function uploadFileFixture() {
  return new File([new Uint8Array([1, 2, 3])], "upload.png", { type: "image/png" });
}

test("上传期间切到 B 会话：晚到上传不发布会话，也不 GET 上传图片", async () => {
  const uploadResponse = deferred();
  let imageGets = 0;
  setHandler((call) => {
    if (call.method === "POST" && call.path === "/api/v1/images") return uploadResponse.promise;
    if (call.method === "GET" && call.path.startsWith("/api/v1/images/")) {
      imageGets += 1;
      return imageHandler(call.path.split("/").pop());
    }
    throw new Error(`unexpected fetch: ${call.method} ${call.path}`);
  });
  store.resetSession();
  await store.ensureSession("image-A");

  const uploading = store.uploadToSession(uploadFileFixture());
  await waitFor(() => countCalls("/api/v1/images", "POST") >= 1);

  // 上传还没返回时，用户打开 B 图（发布新会话）。
  await store.ensureSession("image-B");
  const sessionB = store.session;
  const getsBefore = imageGets;

  uploadResponse.resolve(json(imageRecord("image-upload")));
  const outcome = await uploading;

  assert.equal(outcome.stale, true);
  assert.equal(outcome.session, null);
  assert.equal(outcome.result.image_id, "image-upload");
  assert.equal(store.session, sessionB);
  assert.equal(store.session.imageId, "image-B");
  assert.equal(imageGets, getsBefore, "晚到上传不应再 GET /images/{upload}");
  assert.ok(!store.session.assets.some((asset) => asset.asset_id === "image-upload-normalized"));
});

test("上传期间未切会话：正常发布并返回 session", async () => {
  setHandler((call) => {
    if (call.method === "POST" && call.path === "/api/v1/images") return json(imageRecord("image-upload-ok"));
    if (call.method === "GET" && call.path.startsWith("/api/v1/images/")) {
      return imageHandler(call.path.split("/").pop());
    }
    throw new Error(`unexpected fetch: ${call.method} ${call.path}`);
  });
  store.resetSession();
  const outcome = await store.uploadToSession(uploadFileFixture());

  assert.equal(outcome.stale, false);
  assert.ok(outcome.session);
  assert.equal(outcome.result.image_id, "image-upload-ok");
  assert.equal(store.session.imageId, "image-upload-ok");
  assert.deepEqual(
    store.session.assets.map((asset) => asset.asset_id),
    ["image-upload-ok-normalized", "image-upload-ok-original"]
  );
  assert.equal(store.session.currentAssetId, "image-upload-ok-normalized");
  assert.ok(countCalls("/api/v1/images/image-upload-ok") >= 1);
});

test("上传期间只发起了 B 的加载（尚未发布）：晚到上传不抢走 B 的加载", async () => {
  const uploadResponse = deferred();
  const pendingB = deferred();
  let uploadImageGets = 0;
  setHandler((call) => {
    if (call.method === "POST" && call.path === "/api/v1/images") return uploadResponse.promise;
    if (call.method === "GET" && call.path === "/api/v1/images/image-B-pending") return pendingB.promise;
    if (call.method === "GET" && call.path.startsWith("/api/v1/images/")) {
      uploadImageGets += 1;
      return imageHandler(call.path.split("/").pop());
    }
    throw new Error(`unexpected fetch: ${call.method} ${call.path}`);
  });
  store.resetSession();

  const uploading = store.uploadToSession(uploadFileFixture());
  await waitFor(() => countCalls("/api/v1/images", "POST") >= 1);
  const loadingB = store.ensureSession("image-B-pending");
  await tick();

  uploadResponse.resolve(json(imageRecord("image-upload-late")));
  const outcome = await uploading;
  assert.equal(outcome.stale, true);
  assert.equal(outcome.session, null);
  assert.equal(uploadImageGets, 0, "晚到上传不应 GET 自己的图片");

  pendingB.resolve(imageHandler("image-B-pending"));
  const sessionB = await loadingB;
  assert.ok(sessionB);
  assert.equal(store.session.imageId, "image-B-pending");
});

/* ------------------------------------------------------------------ 3. runJob 提交前切会话 */

test("runJob 提交前切会话：返回 owned:false 且不污染新会话", async () => {
  setHandler(withImage(() => {
    throw new Error("unexpected non-image fetch");
  }));
  store.resetSession();
  await store.ensureSession("image-one");
  const oldToken = store.sessionToken();
  const submit = deferred();
  const running = store.runJob(() => submit.promise);

  const replacement = await store.ensureSession("image-two");
  assert.ok(replacement);
  assert.notEqual(store.sessionToken(), oldToken);
  const newSession = store.session;
  const snapshot = {
    assets: newSession.assets.length,
    jobs: newSession.jobs.length,
    currentAssetId: newSession.currentAssetId,
  };

  network.calls.length = 0;
  submit.resolve({ job_id: "job-before-submit", state: "queued" });
  const result = await running;

  assert.equal(result.owned, false);
  assert.equal(result.job, null);
  assert.equal(store.session, newSession);
  assert.equal(store.session.assets.length, snapshot.assets);
  assert.equal(store.session.jobs.length, snapshot.jobs);
  assert.equal(store.session.currentAssetId, snapshot.currentAssetId);
  assert.equal(store.session.busy, false);
  assert.equal(store.session.activeJob, null);
  assert.equal(countCalls("/api/v1/jobs/job-before-submit"), 0);
});

/* ------------------------------------------------------------------ 4. runJob 轮询中切会话 */

test("切会话后旧任务停止轮询", async () => {
  const runningJob = { job_id: "job-stop", state: "running", kind: "crop" };
  setHandler(withImage((call) => {
    if (call.path === "/api/v1/jobs/job-stop") return json(runningJob);
    throw new Error(`unexpected fetch: ${call.path}`);
  }));
  store.resetSession();
  await store.ensureSession("image-stop");

  const run = store.runJob(() => Promise.resolve({ job_id: "job-stop", state: "queued" }), { interval: 5 });
  await waitFor(() => countCalls("/api/v1/jobs/job-stop") >= 2);
  await store.ensureSession("image-stop-new");
  await tick();
  const settled = countCalls("/api/v1/jobs/job-stop");
  await sleep(40);
  assert.ok(
    countCalls("/api/v1/jobs/job-stop") - settled <= 1,
    "会话切换后旧任务不应继续轮询"
  );
  const result = await run;
  assert.equal(result.owned, false);
});

test("旧任务终态不写新会话，也不清除新会话任务的 busy/activeJob", async () => {
  const pendingA = deferred();
  let callsA = 0;
  let pendingB = deferred();
  setHandler((call) => {
    if (call.path.startsWith("/api/v1/images/")) {
      return imageHandler(call.path.split("/").pop());
    }
    if (call.path === "/api/v1/jobs/job-old") {
      callsA += 1;
      if (callsA === 1) return json({ job_id: "job-old", state: "running", kind: "pipeline" });
      return pendingA.promise;
    }
    if (call.path === "/api/v1/jobs/job-new") {
      return pendingB.promise;
    }
    throw new Error(`unexpected fetch: ${call.path}`);
  });
  store.resetSession();
  await store.ensureSession("image-old");
  const runOld = store.runJob(() => Promise.resolve({ job_id: "job-old", state: "queued" }), { interval: 5 });
  await waitFor(() => callsA >= 2);

  await store.ensureSession("image-new");
  assert.equal(store.session.imageId, "image-new");

  const runNew = store.runJob(() => Promise.resolve({ job_id: "job-new", state: "queued" }), { interval: 5 });
  await waitFor(() => countCalls("/api/v1/jobs/job-new") >= 1);
  assert.equal(store.session.busy, true);
  assert.equal(store.session.activeJob?.job_id, "job-new");
  const newSession = store.session;
  const assetsBefore = newSession.assets.map((asset) => asset.asset_id);

  pendingA.resolve(
    json({
      job_id: "job-old",
      state: "succeeded",
      kind: "pipeline",
      result: { assets: [{ asset_id: "old-lineart", kind: "lineart" }] },
    })
  );
  const oldOutcome = await runOld;
  assert.equal(oldOutcome.owned, false);
  assert.equal(store.session, newSession);
  assert.equal(store.session.jobs.length, 0);
  assert.deepEqual(store.session.assets.map((asset) => asset.asset_id), assetsBefore);
  assert.equal(store.session.busy, true);
  assert.equal(store.session.activeJob?.job_id, "job-new");

  pendingB.resolve(
    json({
      job_id: "job-new",
      state: "succeeded",
      kind: "vectorize",
      result: { assets: [{ asset_id: "new-svg", kind: "svg" }] },
    })
  );
  const newOutcome = await runNew;
  assert.equal(newOutcome.owned, true);
  assert.equal(store.session.busy, false);
  assert.deepEqual(store.session.jobs.map((job) => job.job_id), ["job-new"]);
  assert.ok(store.session.assets.some((asset) => asset.asset_id === "new-svg"));
  assert.ok(!store.session.assets.some((asset) => asset.asset_id === "old-lineart"));
});

/* ------------------------------------------------------------------ 5. 失败/取消文案 */

test("失败任务保留已发布产物，失败与取消文案区分有无产物", async () => {
  setHandler(withImage((call) => {
    if (call.path === "/api/v1/jobs/job-failed") {
      return json({
        job_id: "job-failed",
        state: "failed",
        kind: "vectorize",
        error: { code: "INTERNAL_ERROR", message: "vectorizer crashed" },
        result: { assets: [{ asset_id: "partial-lineart", kind: "lineart" }] },
      });
    }
    throw new Error(`unexpected fetch: ${call.path}`);
  }));
  store.resetSession();
  await store.ensureSession("image-failed");
  const outcome = await store.runJob(() => Promise.resolve({ job_id: "job-failed", state: "queued" }), {
    interval: 5,
  });

  assert.equal(outcome.owned, true);
  assert.equal(store.session.jobs.length, 1);
  assert.equal(store.session.jobs[0].state, "failed");
  assert.ok(store.session.assets.some((asset) => asset.asset_id === "partial-lineart"));

  const withRetained = workbench.taskOutcomeCopy(store.session.jobs[0]);
  assert.equal(withRetained.state, "failed");
  assert.equal(withRetained.hasRetained, true);
  assert.ok(withRetained.retained.includes("lineart"));
  assert.match(withRetained.message, /线稿 PNG/);
  assert.match(withRetained.message, /已保留/);

  const noRetained = workbench.taskOutcomeCopy({ state: "failed", result: { assets: [] } });
  assert.equal(noRetained.hasRetained, false);
  assert.match(noRetained.message, /没有可用的保留产物/);
  assert.notEqual(noRetained.message, withRetained.message);

  const cancelledLocal = workbench.taskOutcomeCopy({ state: "cancelled", kind: "crop", result: { assets: [] } });
  assert.match(cancelledLocal.message, /没有已发布的保留产物/);
  assert.doesNotMatch(cancelledLocal.message, /费用|退费/);

  const cancelledCloud = workbench.taskOutcomeCopy({
    state: "cancelled",
    kind: "repair",
    parameters: { consent_to_charge: true },
    result: { assets: [{ asset_id: "kept-repair", kind: "accepted_repair" }] },
  });
  assert.equal(cancelledCloud.hasRetained, true);
  assert.equal(cancelledCloud.cloud, true);
  assert.match(cancelledCloud.message, /已接受修复/);
  assert.match(cancelledCloud.message, /已保留/);
  assert.match(cancelledCloud.message, /已请求取消/);
  assert.match(cancelledCloud.message, /不会撤回/);
  assert.match(cancelledCloud.message, /不退费/);
  assert.match(cancelledCloud.message, /费用以服务商结算为准/);
  assert.doesNotMatch(cancelledCloud.message, /已退费|费用已退还|已撤销云端|已撤回云端请求/);
});

/* ------------------------------------------------------------------ 6. 接受修复 */

test("接受修复：按 accepted_asset_id 读取并加入会话，重复调用幂等", async () => {
  const pendingAccepted = deferred();
  setHandler(withImage((call) => {
    if (call.path === "/api/v1/assets/accepted-1") {
      return json({ asset_id: "accepted-1", kind: "accepted_repair", width: 64, height: 64 });
    }
    if (call.path === "/api/v1/assets/accepted-2") {
      return json({ error: { code: "NOT_FOUND", message: "gone" } }, 404);
    }
    if (call.path === "/api/v1/assets/accepted-3") return pendingAccepted.promise;
    throw new Error(`unexpected fetch: ${call.path}`);
  }));
  store.resetSession();
  await store.ensureSession("image-repair");
  const token = store.sessionToken();

  const adopted = await store.adoptAcceptedRepair(
    { decision: { action: "accept", revision: 2, accepted_asset_id: "accepted-1" } },
    token
  );
  assert.equal(adopted.status, "adopted");
  assert.equal(adopted.asset.kind, "accepted_repair");
  assert.ok(store.session.assets.some((asset) => asset.asset_id === "accepted-1"));
  store.setCurrentAsset("accepted-1");
  assert.equal(store.currentAsset().kind, "accepted_repair");

  const getCount = countCalls("/api/v1/assets/accepted-1");
  const again = await store.adoptAcceptedRepair(
    { decision: { action: "accept", revision: 2, accepted_asset_id: "accepted-1" } },
    token
  );
  assert.equal(again.status, "already_present");
  assert.equal(countCalls("/api/v1/assets/accepted-1"), getCount);
  assert.equal(store.session.assets.filter((asset) => asset.asset_id === "accepted-1").length, 1);

  const rejected = await store.adoptAcceptedRepair({ decision: { action: "reject", accepted_asset_id: null } }, token);
  assert.equal(rejected.status, "no_accepted_asset");
  assert.equal(countCalls("/api/v1/assets/accepted-1"), getCount);

  const failed = await store.adoptAcceptedRepair({ decision: { accepted_asset_id: "accepted-2" } }, token);
  assert.equal(failed.status, "fetch_failed");
  assert.equal(store.assetById("accepted-2"), null);

  const pendingAdopt = store.adoptAcceptedRepair({ decision: { accepted_asset_id: "accepted-3" } }, token);
  await tick();
  store.resetSession();
  pendingAccepted.resolve(json({ asset_id: "accepted-3", kind: "accepted_repair" }));
  const stale = await pendingAdopt;
  assert.equal(stale.status, "stale_session");
  assert.equal(store.assetById("accepted-3"), null);

  const staleImmediately = await store.adoptAcceptedRepair(
    { decision: { accepted_asset_id: "accepted-4" } },
    token
  );
  assert.equal(staleImmediately.status, "stale_session");
  assert.equal(store.assetById("accepted-4"), null);
});

/* ------------------------------------------------------------------ 7. 请求构造 */

test("模型一键/单独线稿请求只包含契约允许字段", () => {
  const modelPayload = workbench.buildModelLineartPayload("asset-model", { detail: "high" });
  assert.equal(modelPayload.input_asset_id, "asset-model");
  assert.equal(modelPayload.recipe, "model_lineart");
  assert.equal("extract" in modelPayload, false);
  assert.equal("enhance" in modelPayload, false);
  assert.equal(modelPayload.vector.mode, "monochrome");
  assert.equal(modelPayload.vector.detail, "high");

  const modelLineart = workbench.buildLineartPayload("asset-model", {
    lineMethod: "model",
    colors: 4,
    detail: "high",
    threshold: 100,
  });
  assert.deepEqual(Object.keys(modelLineart).sort(), ["input_asset_id", "method"]);
  assert.equal(modelLineart.method, "model");

  const opencvLineart = workbench.buildLineartPayload("asset-open", { lineMethod: "opencv" });
  assert.deepEqual(Object.keys(opencvLineart).sort(), ["input_asset_id", "method"]);
  assert.equal(opencvLineart.method, "opencv");
});

test("LINEART_MODEL_UNAVAILABLE 错误文案包含“运行依赖不可用”", async () => {
  setHandler((call) => {
    if (call.path === "/api/v1/assets/model-check") {
      return json({ error: { code: "LINEART_MODEL_UNAVAILABLE", message: "checkpoint rejected" } }, 422);
    }
    throw new Error(`unexpected fetch: ${call.path}`);
  });
  await assert.rejects(apiModule.api.asset("model-check"), (error) => {
    assert.equal(error.code, "LINEART_MODEL_UNAVAILABLE");
    assert.match(error.message, /运行依赖不可用/);
    assert.match(error.message, /segmentation_models_pytorch/);
    return true;
  });
});

/* ------------------------------------------------------------------ 8. health 能力 */

test("health 能力：明确 false 才算不可用，缺失/非法/读取失败保持未知", async () => {
  setHandler(() =>
    json({
      status: "ok",
      capabilities: {
        lineart_model: { available: false, reason: "model_files_missing", checked: "prerequisites_only" },
      },
    })
  );
  await store.loadHealth();
  assert.equal(store.lineartModel.available, false);
  assert.equal(store.lineartModel.reason, "model_files_missing");
  assert.equal(store.lineartModel.checked, "prerequisites_only");

  setHandler(() => json({ status: "ok", capabilities: {} }));
  await store.loadHealth();
  assert.equal(store.lineartModel.available, null);
  assert.notEqual(store.lineartModel.available, false);
  assert.doesNotMatch(store.lineartModel.reason, /torch|dependencies/);

  setHandler(() =>
    json({ status: "ok", capabilities: { lineart_model: { available: "yes", reason: 42 } } })
  );
  await store.loadHealth();
  assert.equal(store.lineartModel.available, null);
  assert.equal(store.lineartModel.reason, "");

  // health 整体 503：保持“未知”，不得据此报缺依赖。
  setHandler(() => json({ status: "degraded" }, 503));
  await store.loadHealth();
  assert.equal(store.health, null);
  assert.equal(store.lineartModel.available, null);
  assert.doesNotMatch(store.lineartModel.reason, /torch|dependencies/);

  // 上一次明确不可用：503 时保留已知能力，不改写成其它判断。
  setHandler(() =>
    json({
      status: "ok",
      capabilities: {
        lineart_model: { available: false, reason: "dependencies_missing", checked: "prerequisites_only" },
      },
    })
  );
  await store.loadHealth();
  assert.equal(store.lineartModel.available, false);
  assert.equal(store.lineartModel.reason, "dependencies_missing");
  setHandler(() => textResponse("service unavailable", 503));
  await store.loadHealth();
  assert.equal(store.lineartModel.available, false);
  assert.equal(store.lineartModel.reason, "dependencies_missing");

  // 30 秒轮询语义：重复 loadHealth 不修改 settings 或用户参数。
  const settingsSnapshot = { revision: 9, model: "doubao-seedream-5-0-pro-260628" };
  store.patch({ settings: settingsSnapshot });
  setHandler(() =>
    json({
      status: "ok",
      capabilities: {
        lineart_model: { available: true, reason: null, checked: "prerequisites_only" },
      },
    })
  );
  await store.loadHealth();
  await store.loadHealth();
  assert.equal(store.settings, settingsSnapshot);
  assert.deepEqual(store.settings, { revision: 9, model: "doubao-seedream-5-0-pro-260628" });
  assert.equal(store.lineartModel.available, true);
});

/* ------------------------------------------------------------------ 8. 资产分组（同类多次处理） */

test("资产按工序分组：同一步跑多次时按类型编号版本，跨工序不混组", () => {
  const asset = (id, kind, created, extra = {}) => ({ asset_id: id, kind, created_at: created, ...extra });
  const assets = [
    asset("a1", "original", "2026-11-12T10:00:00+08:00"),
    asset("a4", "transparent_png", "2026-11-12T10:12:00+08:00"),
    asset("a2", "transparent_png", "2026-11-12T10:05:00+08:00"),
    asset("a5", "svg", "2026-11-12T10:20:00+08:00"),
    asset("a3", "transparent_png", "2026-11-12T10:09:00+08:00"),
  ];
  // 03 处理跑两次：两个透明 PNG（v1/v2）＋一个新跑的 SVG；05 蒙版又补了一个透明 PNG。
  const stages = { a1: 1, a2: 3, a3: 3, a4: 5, a5: 3 };
  const groups = workbench.groupAssets(assets, (item) => stages[item.asset_id]);

  assert.deepEqual(
    groups.map((group) => [group.stageNo, group.label, group.count]),
    [
      [1, "来源", 1],
      [3, "处理", 3],
      [5, "蒙版", 1],
    ]
  );
  // 组内按生成时间升序，同类型单独编号；最新一条是最后一个（界面从 vN 往前显示）。
  assert.deepEqual(
    groups[1].entries.map((entry) => [entry.asset.asset_id, entry.version, entry.versions, entry.label]),
    [
      ["a2", 1, 2, "透明 PNG"],
      ["a3", 2, 2, "透明 PNG"],
      ["a5", 1, 1, "矢量 SVG"],
    ]
  );
  // 05 蒙版的透明 PNG 与 03 的分开成组，不会续编成 v3。
  assert.deepEqual(
    groups[2].entries.map((entry) => [entry.asset.asset_id, entry.version, entry.versions]),
    [["a4", 1, 1]]
  );
  assert.equal(groups[0].stage.name, "来源");
  assert.equal(groups[1].stage.name, "处理");
});

test("资产参数摘要区分同类版本", () => {
  const extracted = workbench.assetParamLine({
    kind: "transparent_png",
    parameters: { mode: "otsu", polarity: "dark", threshold: 115.4 },
  });
  assert.equal(extracted, "模式 Otsu · 前景 深色 · 阈值 115");

  const svg = workbench.assetParamLine({
    kind: "svg",
    parameters: { options: { mode: "color", max_colors: 8, detail: "high" } },
  });
  assert.equal(svg, "模式 彩色 · 颜色 8 色 · 细节 高");

  const lineart = workbench.assetParamLine({
    kind: "lineart",
    parameters: { method: "model", threshold: 0.5 },
  });
  assert.equal(lineart, "方法 模型 · 阈值 0.5");

  assert.equal(workbench.assetParamLine({ kind: "lineart", parameters: null }), "");
});

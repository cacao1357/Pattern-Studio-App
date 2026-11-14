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
const { module: formatModule } = await loadRecord("./format.js");
const { module: dataModule } = await loadRecord("./data.js");
const { module: settingsModule } = await loadRecord("./views/settings.js");
const { module: appModule } = await loadRecord("./app.js");
const { module: batchModule } = await loadRecord("./batch.js");
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
  assert.doesNotMatch(cancelledCloud.message, /费用|退费/);
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

test("线稿请求构造：本地模型/OpenCV 与云端线稿只含契约字段", () => {
  const modelLineart = workbench.buildLineartPayload("asset-model", "model");
  assert.deepEqual(Object.keys(modelLineart).sort(), ["input_asset_id", "method"]);
  assert.equal(modelLineart.method, "model");

  const opencvLineart = workbench.buildLineartPayload("asset-open", "opencv");
  assert.deepEqual(Object.keys(opencvLineart).sort(), ["input_asset_id", "method"]);
  assert.equal(opencvLineart.method, "opencv");

  // 云端线稿只允许输入 id 与两项显式同意；没有 size、vector、提示词或模型字段。
  const cloud = workbench.buildCloudLineartPayload("asset-cloud");
  assert.deepEqual(Object.keys(cloud).sort(), ["consent_to_charge", "consent_to_upload", "input_asset_id"]);
  assert.equal(cloud.input_asset_id, "asset-cloud");
  assert.equal(cloud.consent_to_upload, true);
  assert.equal(cloud.consent_to_charge, true);
  assert.equal("size" in cloud, false);
  assert.equal("vector" in cloud, false);
  assert.equal("prompt_version" in cloud, false);
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
    assert.match(error.message, /README/);
    return true;
  });
});

test("LINEART_MODEL_GPU_OOM 显示显存不足与释放 GPU 任务提示", async () => {
  setHandler((call) => {
    if (call.path === "/api/v1/assets/oom-check") {
      return json({ error: { code: "LINEART_MODEL_GPU_OOM", message: "GPU memory allocation failed" } }, 400);
    }
    throw new Error(`unexpected fetch: ${call.path}`);
  });
  await assert.rejects(apiModule.api.asset("oom-check"), (error) => {
    assert.equal(error.code, "LINEART_MODEL_GPU_OOM");
    assert.equal(error.message, "显存不足，释放竞争 GPU 任务后重试。");
    return true;
  });
});

test("本地修复错误码都有中文说明，不落到泛化请求失败文案", async () => {
  const cases = {
    LEFTREFILL_MODEL_UNAVAILABLE: /本地修复模型不可用/,
    LEFTREFILL_GPU_REQUIRED: /NVIDIA/,
    LEFTREFILL_GPU_OOM: /显存不足/,
    LEFTREFILL_INFERENCE_FAILED: /推理失败/,
    LEFTREFILL_INPUT_SIZE: /512 × 512/,
    LEFTREFILL_REFERENCE_INVALID: /参考图/,
    LEFTREFILL_EMPTY_MASK: /没有可修复/,
  };
  for (const [code, pattern] of Object.entries(cases)) {
    setHandler(() =>
      json({ error: { code, message: "internal error detail" } }, 422)
    );
    await assert.rejects(apiModule.api.repair({ method: "leftrefill" }), (error) => {
      assert.equal(error.code, code);
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, /请求未被接受|本机服务没有完成请求/);
      return true;
    });
  }
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

test("health 独立解析 leftrefill_model：明确 false 才禁用，缺失/失败保持未知", async () => {
  setHandler(() =>
    json({
      status: "ok",
      capabilities: {
        leftrefill_model: { available: false, reason: "base_model_missing", checked: "prerequisites_only" },
      },
    })
  );
  await store.loadHealth();
  assert.equal(store.leftrefillModel.available, false);
  assert.equal(store.leftrefillModel.reason, "base_model_missing");
  assert.equal(store.leftrefillModel.checked, "prerequisites_only");

  setHandler(() => json({ status: "ok", capabilities: { lineart_model: { available: true } } }));
  await store.loadHealth();
  assert.equal(store.leftrefillModel.available, null);
  assert.equal(store.leftrefillModel.reason, "");

  setHandler(() =>
    json({
      status: "ok",
      capabilities: {
        leftrefill_model: { available: true, reason: null, checked: "prerequisites_only" },
      },
    })
  );
  await store.loadHealth();
  assert.equal(store.leftrefillModel.available, true);
  // health 整体失败时保留上一次已知能力，不据此断言缺少模型。
  setHandler(() => textResponse("service unavailable", 503));
  await store.loadHealth();
  assert.equal(store.leftrefillModel.available, true);
});

test("request 超时覆盖响应体：收到响应头后卡住也要按超时结束", async () => {
  const originalFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = (input, init = {}) => {
    const signal = init.signal;
    const stream = new ReadableStream({
      start(controller) {
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
          { once: true }
        );
      },
    });
    return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
  };
  try {
    await assert.rejects(apiModule.api.request("/slow-body", { timeout: 20 }), (error) => {
      assert.equal(error.name, "ApiError");
      assert.match(error.message, /响应超时/);
      return true;
    });
    assert.equal(aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  // 05 处理跑两次：两个透明 PNG（v1/v2）；06 蒙版又补了一个透明 PNG；07 矢量化出一个 SVG。
  const stages = { a1: 1, a2: 5, a3: 5, a4: 6, a5: 7 };
  const groups = workbench.groupAssets(assets, (item) => stages[item.asset_id]);

  assert.deepEqual(
    groups.map((group) => [group.stageNo, group.label, group.count]),
    [
      [1, "来源", 1],
      [5, "处理", 2],
      [6, "蒙版", 1],
      [7, "矢量化", 1],
    ]
  );
  // 组内按生成时间升序，同类型单独编号；最新一条是最后一个（界面从 vN 往前显示）。
  assert.deepEqual(
    groups[1].entries.map((entry) => [entry.asset.asset_id, entry.version, entry.versions, entry.label]),
    [
      ["a2", 1, 2, "透明 PNG"],
      ["a3", 2, 2, "透明 PNG"],
    ]
  );
  // 06 蒙版的透明 PNG 与 05 的分开成组，不会续编成 v3。
  assert.deepEqual(
    groups[2].entries.map((entry) => [entry.asset.asset_id, entry.version, entry.versions]),
    [["a4", 1, 1]]
  );
  assert.deepEqual(
    groups[3].entries.map((entry) => [entry.asset.asset_id, entry.label]),
    [["a5", "矢量 SVG"]]
  );
  assert.equal(groups[0].stage.name, "来源");
  assert.equal(groups[1].stage.name, "处理");
  assert.equal(groups[3].stage.name, "矢量化");
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

  const cloudLineart = workbench.assetParamLine({
    kind: "lineart",
    method: "cloud",
    parameters: { prompt_version: "lineart-seedream-v1" },
  });
  assert.equal(cloudLineart, "方法 云端");

  assert.equal(workbench.assetParamLine({ kind: "lineart", parameters: null }), "");
});

/* ------------------------------------------------------------------ 9. 云端候选生命周期 */

test("云端候选/修复资产有中文标签并落在正确工序", () => {
  assert.equal(formatModule.kindLabel("generated_basemap"), "云端底图");
  assert.equal(formatModule.kindLabel("placed_generated_layer"), "候选层定位图");
  assert.equal(formatModule.kindLabel("edit_candidate"), "修复全图候选");
  assert.equal(formatModule.stageForKind("composed_candidate"), 4);
  assert.equal(formatModule.stageForKind("placed_generated_layer"), 4);
  assert.equal(formatModule.stageForKind("edit_candidate"), 3);
  assert.equal(formatModule.stageForKind("repair_composite"), 3);
  assert.equal(formatModule.stageForKind("lineart"), 5);
  assert.equal(formatModule.stageForKind("svg"), 7);
  assert.equal(formatModule.stageForKind("tile_preview"), 8);
  assert.equal(formatModule.stageForJobKind("cloud-lineart"), 5);
  assert.equal(formatModule.stageForJobKind("decompose-layers"), 4);
  assert.equal(formatModule.stageForJobKind("repair-candidate"), 3);
  assert.equal(formatModule.stageForJobKind("vectorize"), 7);
  assert.equal(formatModule.jobKindLabel("cloud-lineart"), "云端线稿");
  assert.equal(formatModule.jobKindLabel("compose-layers"), "候选合成");

  store.resetSession();
  const groups = workbench.groupAssets([
    { asset_id: "layer-placement", kind: "placed_generated_layer", created_at: "2026-11-13T10:00:00+08:00" },
    { asset_id: "repair-full", kind: "edit_candidate", created_at: "2026-11-13T10:01:00+08:00" },
  ]);
  assert.deepEqual(groups.map((group) => group.stageNo), [3, 4]);
});

test("工序顺序：修复在线稿之前，蒙版在矢量化之前，平铺/导出最后", () => {
  assert.deepEqual(
    dataModule.STAGES.map((stage) => stage.key),
    ["source", "crop", "repair", "candidate", "process", "mask", "vector", "tile"]
  );
  const index = (key) => dataModule.STAGES.findIndex((stage) => stage.key === key);
  assert.ok(index("repair") < index("process"), "修复必须排在线稿提取之前");
  assert.ok(index("mask") < index("vector"), "蒙版修改后再矢量化");
  assert.equal(index("tile"), dataModule.STAGES.length - 1, "平铺/导出在最后");

  // 旧深链兼容：3 处理→5、5 蒙版→6、6 修复→3、7 平铺→8；v=2 的新链接不映射。
  assert.equal(dataModule.resolveStage("3", ""), 5);
  assert.equal(dataModule.resolveStage("5", ""), 6);
  assert.equal(dataModule.resolveStage("6", ""), 3);
  assert.equal(dataModule.resolveStage("7", ""), 8);
  assert.equal(dataModule.resolveStage("3", "2"), 3);
  assert.equal(dataModule.resolveStage("8", "2"), 8);
  assert.equal(dataModule.resolveStage("9", "2"), 0);
});

test("八道工序都能渲染，处理工序明确提供本地/云端线稿，修复可跳过", () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    clearTimeout() {},
    setTimeout() {
      return 0;
    },
  };
  try {
    store.session = {
      imageId: "image-render",
      image: {
        image_id: "image-render",
        meta: { source_name: "渲染样例" },
        normalized: { asset_id: "norm-render", kind: "normalized_input", width: 800, height: 800 },
        original: { asset_id: "orig-render", kind: "original", width: 800, height: 800 },
      },
      assets: [
        { asset_id: "orig-render", kind: "original", width: 800, height: 800 },
        { asset_id: "norm-render", kind: "normalized_input", width: 800, height: 800 },
      ],
      currentAssetId: "norm-render",
      jobs: [],
      busy: false,
      activeJob: null,
      error: "",
    };
    store.seedream = { enabled: false, blockers: [] };
    const state = (stage) => ({ stage, tile: "2x2", zoom: "fit", brush: 24, compare: false });
    const params = new URLSearchParams();
    const expected = ["source", "crop", "repair", "candidate", "process", "mask", "vector", "tile"];
    expected.forEach((key, index) => {
      const html = workbench.default.render(state(index + 1), { state: {} }, params);
      assert.match(html, new RegExp(`data-stage="${key}"`));
      assert.ok(html.includes("wb-step"), `${key} 工序轨应渲染`);
    });

    const process = workbench.default.render(state(5), { state: {} }, params);
    assert.match(process, /本地模型/);
    assert.match(process, /云端模型/);
    assert.match(process, /data-seg="processRoute" data-val="local"/);
    assert.match(process, /data-seg="processRoute" data-val="cloud"/);
    assert.match(process, /data-seg="processRoute" data-val="opencv"/);
    assert.match(process, /data-seg="processRoute" data-val="color"/);
    assert.match(process, /data-act="run-model-lineart"/);
    assert.match(process, /只生成线稿 PNG，不自动矢量化/);

    const repair = workbench.default.render(state(3), { state: {} }, params);
    assert.match(repair, /data-act="skip-repair"/);
    assert.match(repair, /完整，跳过修复/);

    const vector = workbench.default.render(state(7), { state: {} }, params);
    assert.match(vector, /data-act="run-vectorize"/);
    assert.match(vector, /未接受的修复候选不能作为输入/);

    // 云端就绪时，修复/候选/处理三个云端入口都能渲染，不抛异常。
    store.seedream = { enabled: true, model: "doubao-seedream-5-5-261028", blockers: [] };
    for (const stage of [3, 4, 5]) {
      assert.doesNotThrow(() => workbench.default.render(state(stage), { state: {} }, params));
    }
  } finally {
    globalThis.window = originalWindow;
  }
});

test("像素上限从 health 读取：本地模型 25MP、矢量颜色 250k，超限提供显式工作副本", () => {
  const originalWindow = globalThis.window;
  const originalSession = store.session;
  const originalHealth = store.health;
  const originalSeedream = store.seedream;
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    clearTimeout() {},
    setTimeout() {
      return 0;
    },
  };
  try {
    store.health = {
      limits: {
        working_pixels: 1_000_000,
        color_vector_pixels: 250_000,
        model_lineart_pixels: 25_000_000,
        threshold_pixels: 4_000_000,
        working_copy_pixels: 25_000_000,
        tile_pixels: 4_000_000,
      },
    };
    store.seedream = { enabled: false, blockers: [] };
    const normalized = { asset_id: "norm-pixels", kind: "normalized_input", width: 6000, height: 5000 };
    const lineart = { asset_id: "line-pixels", kind: "lineart", width: 6000, height: 5000 };
    store.session = {
      imageId: "image-pixels",
      image: { image_id: "image-pixels", meta: { source_name: "大图" } },
      assets: [normalized, lineart],
      currentAssetId: "norm-pixels",
      jobs: [],
      busy: false,
      activeJob: null,
      error: "",
    };
    const state = (stage) => ({ stage, tile: "2x2", zoom: "fit", brush: 24, compare: false });
    const params = new URLSearchParams();

    const process = workbench.default.render(state(5), { state: {} }, params);
    assert.match(process, /25,000,000/);
    assert.match(process, /本地模型上限 25,000,000 像素/);
    assert.match(process, /data-act="run-working-copy"[^>]*data-cap="25000000"/);

    store.session.currentAssetId = "line-pixels";
    const vector = workbench.default.render(state(7), { state: {} }, params);
    // 单图 /jobs/vectorize 仍按 working_pixels=1M；250k 只作为彩色组合建议提示。
    assert.match(vector, /彩色建议 ≤ 250,000 像素/);
    assert.match(vector, /此入口上限 1,000,000 像素/);
    assert.match(vector, /data-act="run-working-copy"[^>]*data-cap="1000000"/);

    assert.deepEqual(workbench.buildWorkingCopyPayload({ asset_id: "line-pixels" }, 1_000_000), {
      input_asset_id: "line-pixels",
      max_pixels: 1_000_000,
    });

    // health 缺字段时只显示“未知”，不猜上限也不显示假的创建副本按钮。
    store.health = { limits: {} };
    store.session.currentAssetId = "norm-pixels";
    const unknown = workbench.default.render(state(5), { state: {} }, params);
    assert.match(unknown, /本机服务没有报告本地模型上限/);
    assert.doesNotMatch(unknown, /data-act="run-working-copy"/);
  } finally {
    store.session = originalSession;
    store.health = originalHealth;
    store.seedream = originalSeedream;
    globalThis.window = originalWindow;
  }
});

test("LeftRefill 不可用时禁用本地路线并给出通俗原因，未知不当成不可用", () => {
  const originalWindow = globalThis.window;
  const originalSession = store.session;
  const originalSeedream = store.seedream;
  const originalLeft = store.leftrefillModel;
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    clearTimeout() {},
    setTimeout() {
      return 0;
    },
  };
  try {
    store.session = {
      imageId: "image-leftrefill",
      image: { image_id: "image-leftrefill", meta: { source_name: "本地修复样例" } },
      assets: [
        { asset_id: "crop-512", kind: "cropped", width: 512, height: 512 },
        { asset_id: "ref-512", kind: "cropped", width: 512, height: 512 },
      ],
      currentAssetId: "crop-512",
      jobs: [],
      busy: false,
      activeJob: null,
      error: "",
    };
    store.seedream = { enabled: false, blockers: [] };
    const state = { stage: 3, tile: "2x2", zoom: "fit", brush: 24, compare: false };
    const render = () => workbench.default.render(state, { state: {} }, new URLSearchParams());
    const localButton = (html) => html.match(/<button[^>]*data-val="leftrefill"[^>]*>/)[0];

    store.leftrefillModel = { available: false, reason: "base_model_missing", checked: "prerequisites_only" };
    const unavailable = render();
    assert.match(localButton(unavailable), /disabled/);
    assert.match(unavailable, /缺少基础模型权重/);
    // 解释“上传的小模型只是提示向量，需要匹配的基础网络”，且不暴露内部接口/字段名。
    assert.match(unavailable, /提示向量/);
    assert.match(unavailable, /SD2/);
    assert.doesNotMatch(unavailable, /\/health|capabilities\.leftrefill/);

    store.leftrefillModel = { available: null, reason: "", checked: "" };
    const unknown = render();
    assert.doesNotMatch(localButton(unknown), /disabled/);
    assert.match(unknown, /暂时无法确认本地修复模型/);
    assert.match(unknown, /不会自动改用云端/);
  } finally {
    store.session = originalSession;
    store.seedream = originalSeedream;
    store.leftrefillModel = originalLeft;
    globalThis.window = originalWindow;
  }
});

test("资产独立成列：缩略图排在文档/工序栏与画布之间，工序栏里不再有资产", () => {
  // 纹样列按原图分组：先清掉前面用例留下的分组索引，只验证当前会话这一组。
  batchModule.resetBatchState();
  const originalWindow = globalThis.window;
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    clearTimeout() {},
    setTimeout() {
      return 0;
    },
  };
  try {
    const asset = (id, kind, width = 800, height = 800) => ({ asset_id: id, kind, width, height });
    store.session = {
      imageId: "image-column",
      image: {
        image_id: "image-column",
        meta: { source_name: "列布局样例" },
        normalized: asset("norm-column", "normalized_input"),
        original: asset("orig-column", "original"),
      },
      assets: [asset("orig-column", "original"), asset("norm-column", "normalized_input")],
      currentAssetId: "norm-column",
      jobs: [],
      busy: false,
      activeJob: null,
      error: "",
    };
    store.seedream = { enabled: false, blockers: [] };
    const state = { stage: 1, tile: "2x2", zoom: "fit", brush: 24, compare: false };
    const html = workbench.default.render(state, { state: {} }, new URLSearchParams());

    const railAt = html.indexOf('class="wb-rail"');
    const assetsAt = html.indexOf('class="wb-assets wb-patterns"');
    const mainAt = html.indexOf('class="wb-main"');
    assert.ok(railAt >= 0, "文档与工序栏应保留");
    assert.ok(assetsAt > railAt, "资产列应接在文档/工序栏之后");
    assert.ok(mainAt > assetsAt, "资产列必须在画布之前，画布因此右移一列");

    // 缩略图只出现在资产列里；工序栏只留文档与八道工序。
    const thumbs = [...html.matchAll(/class="wb-thumb"/g)].map((match) => match.index);
    assert.equal(thumbs.length, 2);
    assert.ok(thumbs.every((index) => index > assetsAt && index < mainAt));
    assert.doesNotMatch(html.slice(railAt, assetsAt), /wb-group|wb-thumb/);
    assert.match(html.slice(assetsAt, mainAt), /aria-label="纹样"/);
    assert.match(html.slice(assetsAt, mainAt), /class="wb-groups bp-groups"/);

    // 空会话仍是同一条纹样列，只换成空态，不回到工序栏底部。
    store.session.assets = [];
    store.session.imageId = "";
    store.session.image = null;
    batchModule.resetBatchState();
    const empty = workbench.default.render(state, { state: {} }, new URLSearchParams());
    const emptyAssetsAt = empty.indexOf('class="wb-assets wb-patterns"');
    const emptyMainAt = empty.indexOf('class="wb-main"');
    assert.ok(emptyAssetsAt >= 0 && emptyAssetsAt < emptyMainAt);
    assert.match(empty.slice(emptyAssetsAt, emptyMainAt), /wb-assets-empty/);
    assert.doesNotMatch(empty.slice(0, emptyAssetsAt), /wb-assets-empty/);
  } finally {
    globalThis.window = originalWindow;
  }
});

/* 参数区在窄窗口下是底部抽屉：状态由 JS 判断，必须和 CSS 用同一段宽度区间。 */

/** 用一个最小 matchMedia 替身按视口宽度回答真实查询文本，不写死断点字符串。 */
function withViewport(width, run) {
  const originalWindow = globalThis.window;
  globalThis.window = {
    matchMedia(query) {
      const min = /min-width:\s*(\d+)px/.exec(query);
      const max = /max-width:\s*(\d+)px/.exec(query);
      const matches = (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
      return { matches, media: query };
    },
    clearTimeout() {},
    setTimeout() {
      return 0;
    },
  };
  try {
    return run();
  } finally {
    globalThis.window = originalWindow;
  }
}

/** 用最小替身跑一次 syncPanel（resize / 重绘后调用），返回面板的实际状态。 */
function syncPanelAt(width) {
  return withViewport(width, () => {
    const classes = new Set(["wb-panel", "is-collapsed"]);
    let expanded = "false";
    let label = "展开参数";
    const panel = {
      classList: {
        toggle(name, on) {
          if (on) classes.add(name);
          else classes.delete(name);
          return Boolean(on);
        },
      },
      querySelector(selector) {
        if (selector === "[data-act='panel-toggle']") {
          return { setAttribute: (name, value) => name === "aria-expanded" && (expanded = value) };
        }
        if (selector === "[data-live='panel-toggle-label']") {
          return { set textContent(value) { label = value; } };
        }
        return null;
      },
    };
    const root = { querySelector: (selector) => (selector === "[data-panel]" ? panel : null) };
    workbench.syncPanel(root);
    return { collapsed: classes.has("is-collapsed"), expanded, label };
  });
}

test("参数面板折叠态跟随抽屉断点：1280 收起、1301 展开、≤820 堆叠不收起", () => {
  // 边界两侧各取一点：1300 是抽屉最后一行，1301 已回到四栏桌面。
  const cases = [
    [1440, false],
    [1301, false],
    [1300, true],
    [1280, true],
    [1024, true],
    [900, true],
    [821, true],
    [820, false],
    [390, false],
  ];
  for (const [width, collapsed] of cases) {
    assert.equal(
      withViewport(width, () => workbench.panelCollapsed()),
      collapsed,
      `${width}px 下参数面板折叠态`
    );
  }
});

test("1280 窗口 resize / 重绘不会把已收起的参数抽屉又展开", () => {
  // resize 走 syncPanel：默认（未手动展开过）应保持收起，标签仍是「展开参数」。
  assert.deepEqual(syncPanelAt(1280), { collapsed: true, expanded: "false", label: "展开参数" });
  // 重绘走 render：开头就带 is-collapsed，头部按钮同步 aria-expanded=false。
  const originalWindow = globalThis.window;
  try {
    store.session = {
      imageId: "",
      image: null,
      assets: [],
      currentAssetId: "",
      jobs: [],
      busy: false,
      activeJob: null,
      error: "",
    };
    store.seedream = { enabled: false, blockers: [] };
    const state = { stage: 1, tile: "2x2", zoom: "fit", brush: 24, compare: false };
    const renderAt = (width) =>
      withViewport(width, () =>
        workbench.default.render(state, { state: {} }, new URLSearchParams())
      );

    const drawer = renderAt(1280);
    assert.match(drawer, /class="wb-panel is-collapsed"/);
    assert.match(drawer, /aria-expanded="false"/);
    assert.match(drawer, /展开参数/);

    // 桌面四栏：参数常驻右侧，同样的重绘不会带上收起态。
    const desktop = renderAt(1301);
    assert.match(desktop, /class="wb-panel"/);
    assert.doesNotMatch(desktop, /class="wb-panel is-collapsed"/);
    assert.match(desktop, /aria-expanded="true"/);
    assert.deepEqual(syncPanelAt(1301), { collapsed: false, expanded: "true", label: "收起" });

    // 单栏堆叠（≤820）：面板在页面流里，不套用抽屉收起态。
    assert.equal(withViewport(820, () => workbench.panelCollapsed()), false);
    assert.deepEqual(syncPanelAt(820), { collapsed: false, expanded: "true", label: "收起" });
  } finally {
    globalThis.window = originalWindow;
  }
});

test("URL 目标决策：纯 stage/compare/tile 变化不得重新 openAsset", () => {
  const target = (query) => appModule.loadTarget(new URLSearchParams(query));
  const current = target("image=image-1&asset=asset-1");

  // 同一 URL 目标只改工序/对比/平铺：不重建会话，用户新产物与已选层都保留。
  assert.equal(appModule.shouldLoadTarget(target("image=image-1&asset=asset-1&stage=2"), current), false);
  assert.equal(appModule.shouldLoadTarget(target("image=image-1&asset=asset-1&stage=4"), current), false);
  assert.equal(appModule.shouldLoadTarget(target("image=image-1&asset=asset-1&compare=1"), current), false);
  assert.equal(appModule.shouldLoadTarget(target("image=image-1&asset=asset-1&tile=3x3"), current), false);
  assert.deepEqual(target("stage=4&compare=1&tile=2x2"), { image: "", asset: "" });

  // 明确的新目标才加载：换资产、换图片。
  assert.equal(appModule.shouldLoadTarget(target("image=image-1&asset=asset-2"), current), true);
  assert.equal(appModule.shouldLoadTarget(target("image=image-2&asset=asset-1"), current), true);
  assert.equal(appModule.shouldLoadTarget(target("image=image-2"), current), true);

  // URL 只去掉 asset、图片未变：不重置会话。
  assert.equal(appModule.shouldLoadTarget(target("image=image-1"), current), false);
  // 没有 image/asset 的站内导航不加载。
  assert.equal(appModule.shouldLoadTarget(target(""), current), false);
  assert.equal(appModule.shouldLoadTarget(target("stage=3&compare=1"), current), false);

  // 首次带目标才加载；首次纯 stage 不加载。
  assert.equal(appModule.shouldLoadTarget(target("image=image-1&asset=asset-1"), null), true);
  assert.equal(appModule.shouldLoadTarget(target("stage=3"), null), false);
});

test("会话清空后同一个 URL 目标必须重新载入，清空工作台同时重置深链目标", () => {
  const target = (query) => appModule.loadTarget(new URLSearchParams(query));
  const same = target("image=image-1&asset=asset-1");
  const blank = { imageId: "", assets: [], currentAssetId: "" };
  const loaded = { imageId: "image-1", assets: [{ asset_id: "asset-1" }], currentAssetId: "asset-1" };

  assert.equal(appModule.shouldLoadTarget(same, same, blank), true);
  assert.equal(appModule.shouldLoadTarget(same, same, loaded), false);

  const originalWindow = globalThis.window;
  const originalSession = store.session;
  globalThis.window = { confirm: () => true };
  try {
    store.session = {
      ...blank,
      imageId: "image-1",
      assets: [{ asset_id: "asset-1", kind: "cropped", width: 10, height: 10 }],
      currentAssetId: "asset-1",
      jobs: [],
      busy: false,
      activeJob: null,
      error: "",
    };
    const calls = [];
    const api = {
      resetTarget: () => calls.push("reset-target"),
      set: () => calls.push("set"),
      go: () => calls.push("go"),
      toast: () => calls.push("toast"),
    };
    workbench.clearWorkbench(api);
    assert.deepEqual(calls.slice(0, 3), ["reset-target", "set", "go"]);
    assert.equal(store.session.imageId, "");
  } finally {
    store.session = originalSession;
    globalThis.window = originalWindow;
  }
});

test("云端输入不默默换回原图，未接受的修复候选不可作为后续输入", () => {
  const assets = [
    { asset_id: "norm", kind: "normalized_input", width: 800, height: 800 },
    { asset_id: "crop", kind: "cropped", width: 600, height: 600 },
    { asset_id: "accepted", kind: "accepted_repair", width: 600, height: 600 },
    { asset_id: "unaccepted", kind: "edit_candidate", width: 600, height: 600 },
    { asset_id: "line", kind: "lineart", width: 600, height: 600 },
  ];
  const original = { asset_id: "orig", kind: "original", width: 1000, height: 1000 };
  const rejected = workbench.resolveCloudInput(
    assets,
    original,
    new Set(["normalized_input", "cropped", "accepted_repair"])
  );
  assert.equal(rejected.asset, null);
  assert.equal(rejected.error, "unsupported");
  assert.deepEqual(rejected.candidates.map((asset) => asset.asset_id), ["norm", "crop", "accepted"]);

  const cropped = workbench.cloudEditInput(assets, assets[1], 1_048_576);
  assert.equal(cropped.asset.asset_id, "crop");
  assert.equal(cropped.error, "");

  const unaccepted = workbench.resolveCloudInput(
    assets,
    assets[3],
    new Set(["normalized_input", "cropped", "accepted_repair"])
  );
  assert.equal(unaccepted.asset, null);
  assert.ok(!unaccepted.candidates.some((asset) => asset.asset_id === "unaccepted"));

  const tooSmall = workbench.cloudLineartInput(
    [{ asset_id: "small", kind: "cropped", width: 100, height: 100 }],
    { asset_id: "small", kind: "cropped", width: 100, height: 100 }
  );
  assert.equal(tooSmall.error, "pixels");

  const tooWide = workbench.cloudLineartInput(
    [{ asset_id: "wide", kind: "cropped", width: 3000, height: 100 }],
    { asset_id: "wide", kind: "cropped", width: 3000, height: 100 }
  );
  assert.equal(tooWide.error, "aspect");

  const vectorRejected = workbench.vectorInput(assets, assets[3]);
  assert.equal(vectorRejected.asset, null);
  assert.deepEqual(vectorRejected.candidates.map((asset) => asset.asset_id), ["accepted", "line"]);
  assert.equal(workbench.vectorInput(assets, assets[4]).asset.asset_id, "line");

  // 长宽比限制只属于云端调用；矢量化不应因为窄长画布被拒绝。
  const tall = { asset_id: "tall", kind: "lineart", width: 100, height: 3000 };
  assert.equal(workbench.vectorInput([tall], tall).error, "");
  assert.equal(workbench.vectorInput([tall], tall).asset.asset_id, "tall");
});

test("按图恢复修复任务：优先当前会话输入，只恢复成功的 repair", () => {
  const jobs = [
    { job_id: "repair-new-other", kind: "repair", state: "succeeded", input_asset_id: "other" },
    { job_id: "repair-ours", kind: "repair", state: "succeeded", input_asset_id: "crop" },
    { job_id: "repair-failed", kind: "repair", state: "failed", input_asset_id: "crop" },
    { job_id: "crop-job", kind: "crop", state: "succeeded", input_asset_id: "crop" },
  ];
  assert.equal(workbench.pickRepairJob(jobs, new Set(["crop"])).job_id, "repair-ours");
  assert.equal(workbench.pickRepairJob([jobs[0]], new Set(["crop"])).job_id, "repair-new-other");
  assert.equal(workbench.pickRepairJob([jobs[2], jobs[3]], new Set(["crop"])), null);
});

test("刷新后按图 jobs 历史恢复修复候选与旧修复框，不提交新的修复或云端请求", async () => {
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  const originalWindow = globalThis.window;
  globalThis.location = { hash: "#/workbench" };
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [], activeElement: null };
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    clearTimeout() {},
    setTimeout() {
      return 0;
    },
  };
  const calls = [];
  setHandler((call) => {
    calls.push(`${call.method} ${call.path}`);
    if (call.path === "/api/v1/images/image-repair/history") {
      const collection = new URL(call.url, "http://local").searchParams.get("collection");
      if (collection === "jobs") {
        return json({
          items: [{ job_id: "repair-1", kind: "repair", state: "succeeded", input_asset_id: "crop-1" }],
          next_cursor: null,
        });
      }
      return json({ items: [], next_cursor: null });
    }
    if (call.path === "/api/v1/images/image-repair") return imageHandler("image-repair");
    if (call.path === "/api/v1/assets/crop-1") {
      return json({ asset_id: "crop-1", kind: "cropped", width: 100, height: 80 });
    }
    if (call.path === "/api/v1/repairs/repair-1") {
      return json({
        repair_job_id: "repair-1",
        input_asset_id: "crop-1",
        state: "waiting_user",
        revision: 1,
        candidate_asset: { asset_id: "candidate-1", kind: "repair_candidate", width: 100, height: 80 },
        composited_asset: { asset_id: "composite-1", kind: "repair_composite", width: 100, height: 80 },
        // get_repair 返回 parameters.bbox；坐标属于 input_asset（crop-1）。
        parameters: { bbox: { left: 10, top: 20, right: 60, bottom: 80 } },
        decision: null,
      });
    }
    throw new Error(`unexpected fetch: ${call.method} ${call.path}`);
  });
  try {
    store.resetSession();
    await store.ensureSession("image-repair");
    const apiStub = { state: { stage: 3 }, toast() {}, refresh() {}, patch() {} };
    // 真实页面顺序是 render → mount → restore；先 render 一次让 syncDrafts 记住当前图片，
    // 避免测试里 restore 先设置的修复记录被首次 syncDrafts 当成换图清掉。
    workbench.default.render(
      { stage: 3, tile: "2x2", zoom: "fit", brush: 24, compare: false },
      { state: {} },
      new URLSearchParams()
    );
    await workbench.restoreRepairState(apiStub);
    assert.ok(calls.includes("GET /api/v1/repairs/repair-1"));
    assert.ok(calls.includes("GET /api/v1/assets/crop-1"));
    assert.equal(calls.filter((entry) => entry === "POST /api/v1/jobs/repair").length, 0);
    assert.equal(calls.filter((entry) => entry === "POST /api/v1/jobs/cloud-lineart").length, 0);
    assert.equal(calls.filter((entry) => entry === "POST /api/v1/images").length, 0);
    // 修复任务输入资产是 crop-1，恢复时应读取并切到它，不能把 bbox 套到规范输入上。
    assert.equal(store.assetById("crop-1")?.kind, "cropped");
    assert.equal(store.session.currentAssetId, "crop-1");

    const html = workbench.default.render(
      { stage: 3, tile: "2x2", zoom: "fit", brush: 24, compare: false },
      { state: {} },
      new URLSearchParams()
    );
    assert.match(html, /修复框 50 × 60/);
    assert.match(html, /100 × 80/);
    assert.match(html, /来自输入资产/);
  } finally {
    globalThis.document = originalDocument;
    globalThis.location = originalLocation;
    globalThis.window = originalWindow;
  }
});

test("修复框换算只使用修复记录的 input_asset 尺寸", () => {
  const input = { asset_id: "crop-1", kind: "cropped", width: 100, height: 80 };
  const info = {
    input_asset_id: "crop-1",
    parameters: { bbox: { left: 10, top: 20, right: 60, bottom: 80 } },
  };
  assert.deepEqual(workbench.repairBoxFromJob(info, input), {
    left: 10,
    top: 20,
    width: 50,
    height: 60,
  });
  const text = workbench.repairRecordText(info, input);
  assert.match(text, /100 × 80/);
  assert.match(text, /50 × 60/);
  assert.match(text, /输入资产/);
  assert.equal(workbench.repairBoxFromJob(info, null), null);
  assert.equal(workbench.repairBoxFromJob({ parameters: {} }, input), null);

  const clipped = { parameters: { bbox: { left: 90, top: 70, right: 200, bottom: 200 } } };
  assert.deepEqual(workbench.repairBoxFromJob(clipped, input), {
    left: 90,
    top: 70,
    width: 10,
    height: 10,
  });

  const missing = workbench.repairRecordText(info, null);
  assert.match(missing, /不在当前会话/);
  assert.match(missing, /未套用/);
});

test("云端线稿只 POST /jobs/cloud-lineart，正文只有输入与两项同意", async () => {
  const calls = [];
  setHandler((call) => {
    calls.push(call);
    if (call.path === "/api/v1/jobs/cloud-lineart") {
      return json({ job_id: "cloud-1", state: "queued", kind: "cloud-lineart" }, 202);
    }
    throw new Error(`unexpected fetch: ${call.path}`);
  });
  const queued = await apiModule.api.cloudLineart(workbench.buildCloudLineartPayload("asset-cloud"));
  assert.equal(queued.job_id, "cloud-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    input_asset_id: "asset-cloud",
    consent_to_upload: true,
    consent_to_charge: true,
  });
});

test("云端线稿关闭时只提示，不提交请求，本地路线不受影响", async () => {
  store.patch({ seedream: { enabled: false, blockers: ["API_KEY_MISSING"] } });
  network.calls.length = 0;
  const toasts = [];
  await workbench.runCloudLineart({
    state: { stage: 5 },
    toast(message) {
      toasts.push(message);
    },
    refresh() {},
    patch() {},
  });
  assert.equal(countCalls("/api/v1/jobs/cloud-lineart", "POST"), 0);
  assert.match(toasts[0] || "", /本地模型/);
});

test("设置密钥存储文案如实区分 DPAPI / 私有文件 / 未保存，未知不冒充已验证", () => {
  assert.match(settingsModule.apiKeyStorageText({ api_key_storage: "windows_dpapi" }), /DPAPI/);
  const privateFile = settingsModule.apiKeyStorageText({
    api_key_storage: "private_file",
    api_key_configured: true,
  });
  assert.match(privateFile, /私有配置文件/);
  assert.match(privateFile, /明文/);
  assert.match(privateFile, /无需重新粘贴/);

  const notSaved = settingsModule.apiKeyStorageText({
    api_key_storage: "not_saved",
    api_key_configured: true,
  });
  assert.match(notSaved, /尚未写入本机配置文件/);
  assert.match(notSaved, /无需重新粘贴/);
  assert.doesNotMatch(notSaved, /环境变量|可能/);

  const notSavedEmpty = settingsModule.apiKeyStorageText({
    api_key_storage: "not_saved",
    api_key_configured: false,
  });
  assert.match(notSavedEmpty, /还没有保存密钥/);

  const unknown = settingsModule.apiKeyStorageText({ api_key_configured: true });
  assert.doesNotMatch(unknown, /DPAPI|加密|环境变量|可能|已验证/);
  assert.match(unknown, /没有说明/);
  for (const mode of ["windows_dpapi", "private_file", "not_saved", ""]) {
    assert.doesNotMatch(settingsModule.apiKeyStorageText({ api_key_storage: mode }), /已验证/);
  }
});

test("已配置密钥但存储为 not_saved/private_file 时，无需改动或重输密钥也可显式保存迁移", () => {
  const base = { revision: 7, api_key_configured: true, api_key_storage: "not_saved" };
  assert.equal(settingsModule.keyStorageNeedsRewrite(base), true);
  assert.equal(settingsModule.keyStorageNeedsRewrite({ ...base, api_key_storage: "private_file" }), true);
  assert.equal(settingsModule.keyStorageNeedsRewrite({ ...base, api_key_storage: "windows_dpapi" }), false);
  assert.equal(settingsModule.keyStorageNeedsRewrite({ ...base, api_key_configured: false }), false);
  assert.equal(settingsModule.keyStorageNeedsRewrite({ ...base, api_key_storage: "other" }), false);

  assert.deepEqual(settingsModule.keepOnlySettingsUpdate(base), {
    revision: 7,
    api_key_action: "keep",
  });
  assert.equal(settingsModule.keepOnlySettingsUpdate({ ...base, revision: "7" }), null);
  assert.equal(
    settingsModule.keepOnlySettingsUpdate({ ...base, api_key_storage: "windows_dpapi" }),
    null
  );

  const pending = settingsModule.settingsSaveState(base, 0);
  assert.equal(pending.enabled, true);
  assert.match(pending.note, /密钥存储待更新/);
  assert.equal(
    settingsModule.settingsSaveState({ ...base, api_key_storage: "private_file" }, 0).enabled,
    true
  );
  assert.equal(
    settingsModule.settingsSaveState({ ...base, api_key_storage: "windows_dpapi" }, 0).enabled,
    false
  );
  assert.equal(settingsModule.settingsSaveState(base, 0, { saving: true }).enabled, false);
  assert.equal(settingsModule.settingsSaveState(base, 0, { stale: true }).enabled, false);
  assert.equal(settingsModule.settingsSaveState(base, 0, { migrationDone: true }).enabled, false);
  assert.match(
    settingsModule.settingsSaveState(base, 0, { migrationDone: true, saved: true }).note,
    /已保存/
  );
  assert.equal(settingsModule.settingsSaveState(base, 1).enabled, true);
  assert.equal(settingsModule.settingsSaveState({ ...base, revision: "7" }, 0).enabled, false);
  assert.equal(settingsModule.settingsSaveState(null, 0).enabled, false);
  assert.equal(settingsModule.settingsSaveState(base, 0).migration, true);
});

test("候选流程请求构造：首次 continue、后续 rerun 与本地合成字段", () => {
  const candidate = workbench.buildCandidatePayload("normalized-1", {
    candSize: "1K",
    candColors: 4,
    candDetail: "low",
  });
  assert.deepEqual(Object.keys(candidate).sort(), [
    "consent_to_charge",
    "consent_to_upload",
    "input_asset_id",
    "size",
    "vector",
  ]);
  assert.equal(candidate.input_asset_id, "normalized-1");
  assert.equal(candidate.consent_to_charge, true);
  assert.deepEqual(candidate.vector, { mode: "color", max_colors: 4, detail: "low" });

  const compose = workbench.buildComposePayload("decomposition-1", ["layer-1", "layer-2"], {
    candColors: 8,
    candDetail: "high",
  });
  assert.deepEqual(Object.keys(compose).sort(), ["decomposition_job_id", "layer_ids", "vector"]);
  assert.deepEqual(compose.layer_ids, ["layer-1", "layer-2"]);
  assert.deepEqual(compose.vector, { mode: "color", max_colors: 8, detail: "high" });

  const flow = { pipeline_id: "flow-1", revision: 3 };
  const first = workbench.buildContinuePayload(flow, ["layer-1"], { candColors: 2, candDetail: "medium" });
  assert.deepEqual(Object.keys(first).sort(), ["action", "layer_ids", "revision", "vector"]);
  assert.equal(first.revision, 3);
  assert.equal(first.action, "select_layers");
  assert.equal("consent_to_charge" in first, false);

  const again = workbench.buildRerunComposePayload({ ...flow, revision: 4 }, ["layer-2"], {});
  assert.equal(again.revision, 4);
  assert.equal(again.action, "compose");
  assert.deepEqual(again.layer_ids, ["layer-2"]);
  assert.equal("decomposition_job_id" in again, false);
});

test("修复请求只含契约字段并把框裁到规范输入范围", () => {
  const payload = workbench.buildRepairPayload(
    "normalized-repair",
    { left: 2.4, top: 3.6, width: 500, height: 500 },
    { width: 100, height: 80 },
    { repairIntent: "reconnect_lines", repairFeather: 5.6, repairSize: "1K" }
  );
  assert.deepEqual(Object.keys(payload).sort(), [
    "bbox",
    "consent_to_charge",
    "consent_to_upload",
    "feather_px",
    "input_asset_id",
    "intent",
    "size",
  ]);
  assert.deepEqual(payload.bbox, { left: 2, top: 4, right: 100, bottom: 80 });
  assert.equal(payload.intent, "reconnect_lines");
  assert.equal(payload.feather_px, 6);
  assert.equal(payload.consent_to_upload, true);
  assert.equal(payload.consent_to_charge, true);
});

test("本地 LeftRefill 只接受 512×512 输入；参考图必须显式选择且不超过像素上限", () => {
  const assets = [
    { asset_id: "in-512", kind: "cropped", width: 512, height: 512 },
    { asset_id: "in-1024", kind: "cropped", width: 1024, height: 1024 },
    { asset_id: "mask-512", kind: "foreground_mask", width: 512, height: 512 },
    { asset_id: "orig-512", kind: "original", width: 512, height: 512 },
  ];
  const ok = workbench.leftRefillInput(assets, assets[0]);
  assert.equal(ok.asset.asset_id, "in-512");
  assert.equal(ok.error, "");
  assert.deepEqual(ok.candidates.map((asset) => asset.asset_id), ["in-512"]);

  const wrongSize = workbench.leftRefillInput(assets, assets[1]);
  assert.equal(wrongSize.asset, null);
  assert.equal(wrongSize.error, "size");
  assert.equal(wrongSize.width, 1024);
  assert.deepEqual(wrongSize.candidates.map((asset) => asset.asset_id), ["in-512"]);

  // 原件须先使用规范输入；前后端不能提供不同的可提交类型。
  assert.equal(workbench.leftRefillInput(assets, assets[3]).error, "unsupported");
  assert.equal(workbench.leftRefillInput(assets, assets[2]).error, "unsupported");
  assert.equal(workbench.leftRefillInput([], null).error, "missing");

  const references = workbench.leftRefillReferenceAssets([
    { asset_id: "orig", kind: "original", width: 512, height: 512 },
    { asset_id: "crop-limit", kind: "cropped", width: 1024, height: 1024 },
    { asset_id: "too-big", kind: "cropped", width: 1025, height: 1024 },
    { asset_id: "mask", kind: "foreground_mask", width: 512, height: 512 },
    { asset_id: "svg", kind: "svg" },
  ]);
  assert.deepEqual(references.map((asset) => asset.asset_id), ["crop-limit"]);
});

test("本地 LeftRefill 请求体只含本地字段，且不会静默改为云端", () => {
  const payload = workbench.buildLeftRefillPayload(
    "in-512",
    { left: 2.4, top: 3.6, width: 600, height: 600 },
    { width: 512, height: 512 },
    { repairReferenceId: "ref-1", repairFeather: 5.6, repairIntent: "reconnect_lines", repairSize: "2K" }
  );
  assert.deepEqual(Object.keys(payload).sort(), [
    "bbox",
    "feather_px",
    "input_asset_id",
    "method",
    "reference_asset_id",
  ]);
  assert.equal(payload.method, "leftrefill");
  assert.equal(payload.reference_asset_id, "ref-1");
  assert.equal(payload.feather_px, 6);
  assert.deepEqual(payload.bbox, { left: 2, top: 4, right: 512, bottom: 512 });
  assert.equal("consent_to_upload" in payload, false);
  assert.equal("consent_to_charge" in payload, false);
  assert.equal("provider_call_id" in payload, false);

  const input = { asset: { asset_id: "in-512" } };
  const box = { width: 20, height: 20 };
  assert.match(
    workbench.leftRefillBlockReason({
      capability: { available: false, reason: "base_model_missing" },
      input,
      referenceId: "ref-1",
      box,
    }),
    /缺少基础模型权重[\s\S]*不会自动改用云端/
  );
  assert.match(
    workbench.leftRefillBlockReason({
      capability: { available: true },
      input: { asset: null, error: "size", width: 1024, height: 1024 },
      referenceId: "ref-1",
      box,
    }),
    /512 × 512/
  );
  assert.match(
    workbench.leftRefillBlockReason({ capability: { available: true }, input, referenceId: "", box }),
    /参考图/
  );
  assert.equal(
    workbench.leftRefillBlockReason({ capability: { available: true }, input, referenceId: "ref-1", box }),
    ""
  );
});

test("本地 LeftRefill 面板要求 512×512 目标和显式参考图，不出现云端同意项", () => {
  const originalWindow = globalThis.window;
  const originalSession = store.session;
  const originalSeedream = store.seedream;
  const originalLeft = store.leftrefillModel;
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    clearTimeout() {},
    setTimeout() {
      return 0;
    },
  };
  try {
    store.session = {
      imageId: "image-panel",
      image: { image_id: "image-panel", meta: { source_name: "本地修复面板" } },
      assets: [
        { asset_id: "in-512", kind: "cropped", width: 512, height: 512 },
        { asset_id: "ref-512", kind: "cropped", width: 512, height: 512 },
        { asset_id: "in-1024", kind: "cropped", width: 1024, height: 1024 },
      ],
      currentAssetId: "in-512",
      jobs: [],
      busy: false,
      activeJob: null,
      error: "",
    };
    store.seedream = { enabled: false, blockers: [] };
    store.leftrefillModel = { available: true, reason: null, checked: "prerequisites_only" };
    const state = { stage: 3, tile: "2x2", zoom: "fit", brush: 24, compare: false };
    // render 先跑 syncDrafts，给修复框补上当前资产的尺寸（真实页面顺序）。
    workbench.default.render(state, { state: {} }, new URLSearchParams());
    const html = workbench.repairPanel(state, "leftrefill");
    assert.match(html, /目标输入/);
    assert.match(html, /512 × 512/);
    assert.match(html, /data-select="repairReference"/);
    assert.match(html, /请选择已保存的参考图/);
    assert.doesNotMatch(html, /同意把当前输入上传/);
    assert.doesNotMatch(html, /同意本次云端调用/);
    assert.match(html, /不上传 · 不计费/);
    assert.match(html, /不会自动改用云端/);

    store.session.currentAssetId = "in-1024";
    workbench.default.render(state, { state: {} }, new URLSearchParams());
    const wrongSize = workbench.repairPanel(state, "leftrefill");
    assert.match(wrongSize, /不会自动缩放/);
    assert.doesNotMatch(wrongSize, /目标输入/);
  } finally {
    store.session = originalSession;
    store.seedream = originalSeedream;
    store.leftrefillModel = originalLeft;
    globalThis.window = originalWindow;
  }
});

test("本地 LeftRefill 候选走原有接受/拒绝，不按全图候选处理", () => {
  const info = {
    revision: 3,
    candidate_asset: { asset_id: "cand-1", kind: "repair_candidate", width: 512, height: 512 },
    composited_asset: { asset_id: "composite-1", kind: "repair_composite", width: 512, height: 512 },
  };
  const localRows = workbench.repairCandidateRows(info, "leftrefill");
  assert.deepEqual(localRows.map((row) => row.label), ["本地局部合成", "LeftRefill 候选"]);
  assert.deepEqual(localRows.map((row) => row.full), [false, false]);

  const localHtml = workbench.repairCandidateList(info, "leftrefill");
  assert.match(localHtml, /LeftRefill 候选/);
  assert.doesNotMatch(localHtml, /全图 AI 候选/);
  assert.match(localHtml, /data-act="accept-repair"/);
  assert.match(localHtml, /data-act="reject-repair"/);

  const cloudRows = workbench.repairCandidateRows(info, "cloud");
  assert.equal(cloudRows[1].label, "全图 AI 候选");
  assert.equal(cloudRows[1].full, true);
  assert.match(workbench.repairCandidateList(info, "cloud"), /全图 AI 候选/);

  const decided = workbench.repairCandidateList(
    { ...info, decision: { action: "accept", accepted_asset_id: "cand-1" } },
    "leftrefill"
  );
  assert.doesNotMatch(decided, /data-act="accept-repair"/);
  assert.doesNotMatch(decided, /data-act="reject-repair"/);

  assert.deepEqual(workbench.buildRepairDecisionPayload(info, "accept", "cand-1", false, true), {
    revision: 3,
    action: "accept",
    selected_asset_id: "cand-1",
    accept_full_image_changes: false,
  });
  assert.deepEqual(workbench.buildRepairDecisionPayload(info, "accept", "cand-1", true, true), {
    revision: 3,
    action: "accept",
    selected_asset_id: "cand-1",
    accept_full_image_changes: true,
  });
  assert.deepEqual(workbench.buildRepairDecisionPayload(info, "reject"), { revision: 3, action: "reject" });
});

test("恢复时只选本会话规范输入的云端流程，并区分等待/已选层/未知结果", () => {
  const flows = [
    {
      kind: "ai_pipeline",
      pipeline_id: "flow-new",
      input_asset_id: "normalized-other",
      decomposition_job_id: "decomp-other",
      state: "waiting_user",
      recovery: { can_compose: true },
    },
    {
      kind: "ai_pipeline",
      pipeline_id: "flow-ours",
      input_asset_id: "normalized-ours",
      decomposition_job_id: "decomp-ours",
      state: "waiting_user",
      recovery: { can_compose: true },
    },
    { kind: "local", pipeline_id: "not-a-flow" },
  ];
  assert.equal(workbench.pickCandidateFlow(flows, new Set(["normalized-ours"])).pipeline_id, "flow-ours");
  assert.equal(workbench.pickCandidateFlow(flows, new Set(["missing"])), null);

  const rejectedNewest = [
    {
      kind: "ai_pipeline",
      pipeline_id: "flow-rejected",
      input_asset_id: "normalized-ours",
      decomposition_job_id: "decomp-rejected",
      state: "rejected",
      decision: { action: "reject" },
      recovery: { can_compose: false },
    },
    ...flows,
  ];
  assert.equal(
    workbench.pickCandidateFlow(rejectedNewest, new Set(["normalized-ours"])).pipeline_id,
    "flow-ours"
  );

  assert.equal(
    workbench.flowActiveJobId({ state: "queued", decomposition_job_id: "decomp", continuation_job_id: null }),
    "decomp"
  );
  assert.equal(
    workbench.flowActiveJobId({ state: "continuing", decomposition_job_id: "decomp", continuation_job_id: "compose" }),
    "compose"
  );
  assert.equal(
    workbench.flowActiveJobId({ state: "waiting_user", decomposition_job_id: "decomp", continuation_job_id: null }),
    ""
  );

  assert.equal(workbench.flowCanCompose({ decision: null, recovery: { can_compose: true } }), true);
  assert.equal(workbench.flowCanCompose({ decision: null, recovery: { can_compose: false } }), false);
  assert.equal(
    workbench.flowCanCompose({ decision: { action: "select_layers" }, recovery: { can_compose: false } }),
    false
  );
  assert.equal(
    workbench.flowCanCompose({ decision: { action: "select_layers" }, recovery: { can_compose: true } }),
    true
  );
  assert.equal(
    workbench.flowCanCompose({
      state: "failed",
      decision: { action: "select_layers" },
      recovery: { can_compose: true },
    }),
    true
  );
  assert.equal(
    workbench.flowCanCompose({ decision: { action: "use_local" }, recovery: { can_compose: true } }),
    false
  );
  assert.equal(
    workbench.flowCanCompose({ decision: { action: "reject" }, recovery: { can_compose: true } }),
    false
  );

  assert.deepEqual(
    workbench.candidateSelectionForFlow({
      selected_layer_ids: ["first"],
      branches: [
        { action: "compose", parameters: { layer_ids: ["branch-old"] } },
        { action: "vectorize", parameters: {} },
        { action: "compose", parameters: { layer_ids: ["branch-new"] } },
      ],
    }),
    ["branch-new"]
  );
  assert.deepEqual(
    workbench.candidateSelectionForFlow({ selected_layer_ids: ["first"], branches: [] }),
    ["first"]
  );
});

test("imageHistory 按 next_cursor 读完 flows 分页，超出上限时标记不完整", async () => {
  const seen = [];
  setHandler((call) => {
    if (call.path !== "/api/v1/images/image-history/history") throw new Error(`unexpected fetch: ${call.path}`);
    const query = new URL(call.url, "http://local").searchParams;
    seen.push(query.get("collection") + ":" + (query.get("cursor") || ""));
    if (query.get("cursor") === "2") {
      return json({ items: [{ pipeline_id: "flow-old" }], next_cursor: null });
    }
    return json({ items: [{ pipeline_id: "flow-new" }], next_cursor: "2" });
  });

  const all = await store.imageHistory("image-history", "flows", { limit: 1 });
  assert.equal(all.complete, true);
  assert.deepEqual(all.items.map((item) => item.pipeline_id), ["flow-new", "flow-old"]);
  assert.deepEqual(seen, ["flows:", "flows:2"]);

  network.calls.length = 0;
  seen.length = 0;
  const partial = await store.imageHistory("image-history", "flows", { limit: 1, maxPages: 1 });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.items.map((item) => item.pipeline_id), ["flow-new"]);
  assert.equal(countCalls("/api/v1/images/image-history/history"), 1);
});

test("付费关闭时恢复归档候选：首次 continue 关闭流程，后续 rerun 重合成，不发新云端请求", async () => {
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  globalThis.location = { hash: "#/workbench" };
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [], activeElement: null };

  let revision = 1;
  let decision = null;
  let selected = [];
  let continuation = null;
  let composeDone = false;
  const makeFlow = (state = "waiting_user") => ({
    pipeline_id: "flow-1",
    kind: "ai_pipeline",
    input_asset_id: "image-flow-normalized",
    state,
    revision,
    decomposition_job_id: "decomp-1",
    continuation_job_id: continuation,
    selected_layer_ids: selected,
    decision,
    recovery: { can_compose: true, needs_reconcile: false, vector_input_asset_ids: [] },
    vector: { mode: "color", max_colors: 4, detail: "low" },
    result: { assets: [], steps: [] },
  });
  const calls = [];
  setHandler((call) => {
      calls.push(`${call.method} ${call.path}`);
      if (call.method === "GET" && call.path === "/api/v1/images/image-flow") {
        return imageHandler("image-flow");
      }
      if (call.path === "/api/v1/images/image-flow/history") {
        return json({ items: [makeFlow()], next_cursor: null });
      }
      if (call.path === "/api/v1/pipelines/flow-1") {
        return json(makeFlow(continuation && composeDone ? "succeeded" : continuation ? "continuing" : "waiting_user"));
      }
      if (call.path === "/api/v1/jobs/decomp-1/layers") {
        return json({
          decomposition_job_id: "decomp-1",
          layers: [
            { layer_id: "layer-1", z_index: 1, placed_asset: { asset_id: "placed-1", kind: "placed_generated_layer" } },
            { layer_id: "layer-2", z_index: 2, placed_asset: { asset_id: "placed-2", kind: "placed_generated_layer" } },
          ],
        });
      }
      if (call.path === "/api/v1/pipelines/flow-1/continue") {
        assert.equal(call.body.action, "select_layers");
        assert.equal(call.body.revision, 1);
        assert.deepEqual(call.body.layer_ids, ["layer-1"]);
        revision = 2;
        decision = { action: "select_layers", revision: 2, layer_ids: ["layer-1"] };
        selected = ["layer-1"];
        continuation = "compose-1";
        composeDone = false;
        return json({ ...makeFlow("continuing"), continuation_job_id: "compose-1" }, 202);
      }
      if (call.path === "/api/v1/pipelines/flow-1/rerun") {
        assert.equal(call.body.action, "compose");
        assert.equal(call.body.revision, 2);
        assert.deepEqual(call.body.layer_ids, ["layer-1"]);
        revision = 3;
        continuation = "compose-2";
        composeDone = false;
        return json({ job_id: "compose-2", state: "queued", kind: "compose-layers" }, 202);
      }
      if (call.path === "/api/v1/jobs/compose-1") {
        composeDone = true;
        return json({
          job_id: "compose-1",
          state: "succeeded",
          kind: "compose-layers",
          result: { assets: [{ asset_id: "composed-1", kind: "composed_candidate" }] },
        });
      }
      if (call.path === "/api/v1/jobs/compose-2") {
        composeDone = true;
        return json({
          job_id: "compose-2",
          state: "succeeded",
          kind: "compose-layers",
          result: { assets: [{ asset_id: "composed-2", kind: "composed_candidate" }] },
        });
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.path}`);
  });

  try {
    store.resetSession();
    store.patch({ seedream: { enabled: false, blockers: ["API_KEY_MISSING"] } });
    await store.ensureSession("image-flow");
    const apiStub = { state: { stage: 4 }, toast() {}, refresh() {}, patch() {} };

    await workbench.restoreCandidateFlow(apiStub);
    assert.equal(calls.filter((entry) => entry === "POST /api/v1/pipelines/ai").length, 0);
    assert.equal(calls.filter((entry) => entry === "GET /api/v1/jobs/decomp-1/layers").length, 1);
    assert.deepEqual(workbench.toggleCandidateLayer("layer-1"), ["layer-1"]);

    await workbench.composeLayers(apiStub);
    assert.equal(calls.filter((entry) => entry === "POST /api/v1/pipelines/flow-1/continue").length, 1);
    assert.equal(calls.filter((entry) => entry === "POST /api/v1/jobs/compose-layers").length, 0);
    assert.ok(store.session.assets.some((asset) => asset.asset_id === "composed-1"));

    await workbench.composeLayers(apiStub);
    assert.equal(calls.filter((entry) => entry === "POST /api/v1/pipelines/flow-1/continue").length, 1);
    assert.equal(calls.filter((entry) => entry === "POST /api/v1/pipelines/flow-1/rerun").length, 1);
    assert.equal(calls.filter((entry) => entry === "POST /api/v1/pipelines/ai").length, 0);
    assert.ok(store.session.assets.some((asset) => asset.asset_id === "composed-2"));
  } finally {
    globalThis.document = originalDocument;
    globalThis.location = originalLocation;
  }
});

test("旧异步恢复不覆盖用户已改的候选勾选", () => {
  assert.deepEqual(
    workbench.selectionAfterFlowAdopt(["layer-1"], [], { selection: true, touched: true }),
    ["layer-1"]
  );
  assert.deepEqual(
    workbench.selectionAfterFlowAdopt([], ["layer-2"], { selection: true, touched: false }),
    ["layer-2"]
  );
  assert.deepEqual(
    workbench.selectionAfterFlowAdopt(["layer-1"], ["layer-2"], { selection: false, touched: false }),
    ["layer-1"]
  );
});

test("恢复流程后用户勾选过层，旧的流程快照再 adopt 也不会清空勾选", async () => {
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  globalThis.location = { hash: "#/workbench" };
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [], activeElement: null };

  const flow = {
    pipeline_id: "flow-race",
    kind: "ai_pipeline",
    input_asset_id: "image-race-normalized",
    state: "waiting_user",
    revision: 1,
    decomposition_job_id: "decomp-race",
    selected_layer_ids: [],
    decision: null,
    recovery: { can_compose: true, needs_reconcile: false },
    result: { assets: [], steps: [] },
    branches: [],
  };
  const continueBodies = [];
  setHandler((call) => {
    if (call.path === "/api/v1/images/image-race") return imageHandler("image-race");
    if (call.path === "/api/v1/images/image-race/history") {
      return json({ items: [flow], next_cursor: null });
    }
    if (call.path === "/api/v1/pipelines/flow-race") return json(flow);
    if (call.path === "/api/v1/jobs/decomp-race/layers") {
      return json({
        decomposition_job_id: "decomp-race",
        layers: [
          { layer_id: "layer-1", z_index: 1, placed_asset: { asset_id: "placed-1", kind: "placed_generated_layer" } },
          { layer_id: "layer-2", z_index: 2, placed_asset: { asset_id: "placed-2", kind: "placed_generated_layer" } },
        ],
      });
    }
    if (call.path === "/api/v1/pipelines/flow-race/continue") {
      continueBodies.push(call.body);
      return json(
        {
          ...flow,
          state: "continuing",
          continuation_job_id: "compose-race",
          selected_layer_ids: ["layer-1"],
        },
        202
      );
    }
    if (call.path === "/api/v1/jobs/compose-race") {
      return json({
        job_id: "compose-race",
        state: "succeeded",
        kind: "compose-layers",
        result: { assets: [{ asset_id: "composed-race", kind: "composed_candidate" }] },
      });
    }
    throw new Error(`unexpected fetch: ${call.method} ${call.path}`);
  });

  try {
    store.resetSession();
    store.patch({ seedream: { enabled: false, blockers: ["API_KEY_MISSING"] } });
    await store.ensureSession("image-race");
    const apiStub = { state: { stage: 4 }, toast() {}, refresh() {}, patch() {} };

    await workbench.restoreCandidateFlow(apiStub);
    assert.deepEqual(workbench.toggleCandidateLayer("layer-1"), ["layer-1"]);

    // 模拟较旧的恢复/续接在用户点击之后才返回：同流程快照不能把勾选清空。
    await workbench.adoptCandidateFlow(apiStub, flow, store.sessionToken(), { selection: true });

    await workbench.composeLayers(apiStub);
    assert.equal(continueBodies.length, 1);
    assert.deepEqual(continueBodies[0].layer_ids, ["layer-1"]);
  } finally {
    globalThis.document = originalDocument;
    globalThis.location = originalLocation;
  }
});

test("恢复流程的续接任务晚到时，用户已勾选的层不会被旧快照覆盖", async () => {
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  globalThis.location = { hash: "#/workbench" };
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [], activeElement: null };

  const gate = deferred();
  let composeBody = null;
  let flowState = "decomposing";
  const flow = {
    pipeline_id: "flow-resume",
    kind: "ai_pipeline",
    input_asset_id: "image-resume-normalized",
    state: flowState,
    revision: 1,
    decomposition_job_id: "decomp-resume",
    selected_layer_ids: [],
    decision: null,
    recovery: { can_compose: true, needs_reconcile: false },
    result: { assets: [], steps: [] },
    branches: [],
  };
  const currentFlow = () => ({ ...flow, state: flowState });
  setHandler((call) => {
    if (call.path === "/api/v1/images/image-resume") return imageHandler("image-resume");
    if (call.path === "/api/v1/images/image-resume/history") {
      return json({ items: [currentFlow()], next_cursor: null });
    }
    if (call.path === "/api/v1/pipelines/flow-resume") return json(currentFlow());
    if (call.path === "/api/v1/jobs/decomp-resume/layers") {
      return json({
        decomposition_job_id: "decomp-resume",
        layers: [
          { layer_id: "layer-1", z_index: 1, placed_asset: { asset_id: "placed-1", kind: "placed_generated_layer" } },
          { layer_id: "layer-2", z_index: 2, placed_asset: { asset_id: "placed-2", kind: "placed_generated_layer" } },
        ],
      });
    }
    if (call.path === "/api/v1/jobs/decomp-resume") return gate.promise;
    if (call.path === "/api/v1/pipelines/flow-resume/continue") {
      composeBody = call.body;
      return json({ ...flow, state: "continuing", continuation_job_id: "compose-resume" }, 202);
    }
    if (call.path === "/api/v1/jobs/compose-resume") {
      return json({
        job_id: "compose-resume",
        state: "succeeded",
        kind: "compose-layers",
        result: { assets: [{ asset_id: "composed-resume", kind: "composed_candidate" }] },
      });
    }
    throw new Error(`unexpected fetch: ${call.method} ${call.path}`);
  });

  try {
    store.resetSession();
    store.patch({ seedream: { enabled: false, blockers: ["API_KEY_MISSING"] } });
    await store.ensureSession("image-resume");
    const apiStub = { state: { stage: 4 }, toast() {}, refresh() {}, patch() {} };

    const restoring = workbench.restoreCandidateFlow(apiStub);
    await waitFor(
      () =>
        countCalls("/api/v1/jobs/decomp-resume", "GET") >= 1 &&
        countCalls("/api/v1/jobs/decomp-resume/layers", "GET") >= 1
    );
    assert.deepEqual(workbench.toggleCandidateLayer("layer-1"), ["layer-1"]);
    flowState = "waiting_user";
    gate.resolve(
      json({
        job_id: "decomp-resume",
        state: "succeeded",
        kind: "decompose-layers",
        result: { assets: [] },
      })
    );
    await restoring;

    await workbench.composeLayers(apiStub);
    assert.ok(composeBody);
    assert.deepEqual(composeBody.layer_ids, ["layer-1"]);
  } finally {
    globalThis.document = originalDocument;
    globalThis.location = originalLocation;
  }
});

test("切图后旧任务结束不会把 busy 留到新会话", async () => {
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  globalThis.location = { hash: "#/workbench" };
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [], activeElement: null };
  let polls = 0;
  setHandler((call) => {
    if (call.path.startsWith("/api/v1/images/")) return imageHandler(call.path.split("/").pop());
    if (call.path === "/api/v1/jobs/job-stale") {
      polls += 1;
      return json({ job_id: "job-stale", state: "running", kind: "crop" });
    }
    throw new Error(`unexpected fetch: ${call.path}`);
  });
  try {
    store.resetSession();
    await store.ensureSession("image-old");
    const apiStub = { state: { stage: 2 }, toast() {}, refresh() {}, patch() {} };
    const running = workbench.startJob(
      apiStub,
      () => Promise.resolve({ job_id: "job-stale", state: "queued" }),
      () => {}
    );
    await waitFor(() => polls >= 1);
    assert.equal(workbench.taskUiState().running, true);

    // 切图后旧会话任务被 abandon；它结束时必须清掉自己留下的 busy。
    await store.ensureSession("image-new");
    await running;
    assert.equal(workbench.taskUiState().running, false);
    assert.equal(workbench.taskUiState().jobStage, 0);
  } finally {
    globalThis.document = originalDocument;
    globalThis.location = originalLocation;
  }
});

test("付费关闭时新生成入口只提示，不提交任何云端请求", async () => {
  store.patch({ seedream: { enabled: false, blockers: ["API_KEY_MISSING"] } });
  network.calls.length = 0;
  const toasts = [];
  const apiStub = {
    state: { stage: 4 },
    toast(message) {
      toasts.push(message);
    },
    refresh() {},
    patch() {},
  };
  await workbench.runCandidate(apiStub);
  assert.equal(countCalls("/api/v1/pipelines/ai", "POST"), 0);
  assert.equal(countCalls("/api/v1/jobs/repair", "POST"), 0);
  assert.match(toasts[0] || "", /云端新生成已关闭/);
});

/* ------------------------------------------------------------------ 删除原图组 */

test("删除原图组：DELETE 成功后移出列表，并清空同一原图的会话", async () => {
  setHandler((call) => {
    if (call.method === "DELETE" && call.path === "/api/v1/patterns/image-del") {
      return json({ image_id: "image-del", deleted: true, assets: 4, jobs: 2 });
    }
    throw new Error(`unexpected fetch: ${call.method} ${call.path}`);
  });
  store.patterns.items = [
    { image_id: "image-del", assets: [{ asset_id: "asset-del" }] },
    { image_id: "image-keep", assets: [{ asset_id: "asset-keep" }] },
  ];
  store.session.imageId = "image-del";
  store.session.assets = [{ asset_id: "asset-del", kind: "original" }];
  try {
    const result = await store.deletePatternGroup("image-del");
    assert.equal(result.deleted, true);
    assert.deepEqual(store.patterns.items.map((item) => item.image_id), ["image-keep"]);
    assert.equal(store.session.imageId, "");
    assert.deepEqual(store.session.assets, []);
    assert.equal(countCalls("/api/v1/patterns/image-del", "DELETE"), 1);
  } finally {
    store.resetSession();
    store.patterns.items = [];
  }
});

test("删除原图组被拒绝时保留列表与会话，并给出中文原因", async () => {
  setHandler(() => json({ error: { code: "PATTERN_BUSY", message: "queued task" } }, 409));
  store.patterns.items = [{ image_id: "image-busy", assets: [] }];
  store.session.imageId = "image-busy";
  try {
    await assert.rejects(
      () => store.deletePatternGroup("image-busy"),
      (error) => {
        assert.equal(error.code, "PATTERN_BUSY");
        assert.match(error.message, /任务/);
        return true;
      }
    );
    assert.deepEqual(store.patterns.items.map((item) => item.image_id), ["image-busy"]);
    assert.equal(store.session.imageId, "image-busy");
  } finally {
    store.resetSession();
    store.patterns.items = [];
  }
});

test("工作台纹样列提供整组删除入口，删除后同步移出侧栏索引", async () => {
  store.resetSession();
  batchModule.resetBatchState();
  setHandler((call) => {
    if (call.path === "/api/v1/workbench/items") {
      return json({
        items: [
          { image_id: "img-a", name: "甲", assets: [{ asset_id: "asset-a", kind: "original", created_at: "2026-01-01T00:00:00Z" }] },
          { image_id: "img-b", name: "乙", assets: [] },
        ],
        next_cursor: null,
      });
    }
    throw new Error(`unexpected fetch: ${call.path}`);
  });
  try {
    await batchModule.loadWorkbenchPage({});
    assert.deepEqual(batchModule.batchSnapshot().groups.map((group) => group.imageId), ["img-a", "img-b"]);
    const html = batchModule.patternColumnHtml();
    assert.match(html, /data-act="delete-pattern"/);
    assert.match(html, /data-image="img-a"/);
    assert.equal(batchModule.forgetPatternGroup("img-a"), true);
    assert.deepEqual(batchModule.batchSnapshot().groups.map((group) => group.imageId), ["img-b"]);
    assert.doesNotMatch(batchModule.patternColumnHtml(), /data-image="img-a"/);
  } finally {
    batchModule.resetBatchState();
  }
});

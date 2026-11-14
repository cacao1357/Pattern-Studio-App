/* =============================================================================
   processing-batch.test.mjs — 流程预设 / 持久批次的定向回归。
   覆盖：步骤顺序（含自动准备蒙版与工作副本）、云端预计调用与双同意、输入选择、
   人工门候选、队列满与取消措辞、提交/续接/取消的请求体、刷新后的批次恢复。
   ============================================================================= */

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
      const record = await loadRecord(dependency, url);
      source = source
        .split(`from "${dependency}"`)
        .join(`from "${record.dataUrl}"`)
        .split(`from '${dependency}'`)
        .join(`from '${record.dataUrl}'`);
    }
    const dataUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
    return { dataUrl, module: await import(dataUrl) };
  })();
  moduleCache.set(key, pending);
  return pending;
}

const { module: processingModule } = await loadRecord("./processing.js");
const { module: storeModule } = await loadRecord("./store.js");
const processing = processingModule.processing;
const store = storeModule.store;

const HEALTH_LIMITS = {
  working_pixels: 1_000_000,
  color_vector_pixels: 250_000,
  model_lineart_pixels: 25_000_000,
  threshold_pixels: 4_000_000,
  working_copy_pixels: 25_000_000,
  tile_pixels: 4_000_000,
  decode_pixels: 25_000_000,
};

const realFetch = globalThis.fetch;
const network = { handler: null, calls: [] };

globalThis.fetch = async (input, init = {}) => {
  if (!network.handler) throw new Error("unexpected fetch in test");
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

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  network.calls.length = 0;
  network.handler = null;
  store.health = { limits: { ...HEALTH_LIMITS } };
  processing.presets = [];
  processing.batches = [];
  processing.selectedBatchId = "";
  processing.detail = null;
  processing.detailError = "";
  processing.listError = "";
  processing.patterns.clear();
  processing.busyKey = "";
});

const asset = (id, kind, extra = {}) => ({
  asset_id: id,
  kind,
  width: 100,
  height: 100,
  bytes: 1024,
  created_at: "2026-01-01T00:00:00Z",
  ...extra,
});

const group = (normalizedId, assets) => ({
  imageId: "image-a",
  name: "A 图",
  normalizedAssetId: normalizedId,
  assets,
});

const batchPayload = (overrides = {}) => ({
  batch_id: "batch-1",
  preset_id: "preset-1",
  state: "running",
  revision: 3,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:01Z",
  snapshot: {
    name: "云端线稿转 SVG",
    preset_revision: 1,
    options: processingModule.normalizePresetOptions({ recipe: "cloud_lineart" }),
    planned_provider_calls: 1,
    images_uploaded_to_provider: 1,
  },
  items: [
    {
      item_id: "item-1",
      image_id: "image-a",
      input_asset_id: "a-normalized",
      current_asset_id: "a-normalized",
      state: "waiting",
      waiting_for: "crop",
      cursor: 0,
      steps: [{ name: "crop", state: "waiting" }],
      results: [],
      job_id: null,
      error: null,
    },
  ],
  progress: { total: 1, counts: { waiting: 1, succeeded: 0, failed: 0, cancelled: 0, running: 0, queued: 0, cancelling: 0 }, completed: 0 },
  ...overrides,
});

/* ------------------------------------------------------------------ 纯逻辑 */

test("步骤顺序：人工门、工作副本、自动准备蒙版与输出与后端一致", () => {
  const options = processingModule.normalizePresetOptions({
    recipe: "cloud_lineart",
    crop: true,
    repair: true,
    candidates: true,
    mask: true,
    working_max_pixels: 500_000,
    vectorize: true,
    tile: true,
  });
  const steps = processingModule.presetSteps(options);
  assert.deepEqual(
    steps.map((step) => step.name),
    ["crop", "repair", "candidates", "working_copy", "cloud_lineart", "prepare_mask", "mask", "vectorize", "tile"]
  );
  assert.equal(steps.find((step) => step.name === "working_copy").label, "创建工作副本");
  assert.equal(steps.find((step) => step.name === "prepare_mask").label, "准备蒙版");
  assert.equal(steps.find((step) => step.name === "prepare_mask").manual, false);
  assert.deepEqual(
    steps.filter((step) => step.manual).map((step) => step.name),
    ["crop", "repair", "candidates", "mask"]
  );

  const color = processingModule.presetSteps(
    processingModule.normalizePresetOptions({ recipe: "color", mask: true, vectorize: true })
  );
  assert.deepEqual(color.map((step) => step.name), ["color", "mask", "vectorize"]);
});

test("预计云端调用只计云端线稿路线，人工门另计", () => {
  assert.equal(processingModule.estimateProviderCalls({ recipe: "cloud_lineart" }, 3), 3);
  assert.equal(processingModule.estimateProviderCalls({ recipe: "model_lineart" }, 3), 0);
  assert.equal(processingModule.estimateProviderCalls({ recipe: "color" }, 3), 0);
});

test("队列满显示等待空位，不误报失败；cancelling 不显示已撤回", () => {
  assert.equal(processingModule.stepStateLabel({ state: "queued", queue_blocked: true }, { state: "queued" }), "等待空位");
  assert.equal(processingModule.stepStateLabel({ state: "queued" }, { state: "queued" }), "排队");
  const cloudBatch = batchPayload();
  const runningCloud = {
    ...cloudBatch.items[0],
    state: "running",
    waiting_for: null,
    steps: [{ name: "cloud_lineart", state: "running" }],
  };
  assert.match(processingModule.cancelNote(cloudBatch, runningCloud), /无法撤回/);
  const cancelling = { ...runningCloud, state: "cancelling" };
  assert.match(processingModule.cancelNote(cloudBatch, cancelling), /无法撤回/);
  assert.match(processingModule.cancelNote(cloudBatch, cancelling), /停止后续/);
  assert.equal(
    processingModule.cancelNote(cloudBatch, { ...cloudBatch.items[0], state: "queued", waiting_for: null }),
    "尚未启动，可取消。"
  );
});

test("输入资产：优先当前兼容版本，其次规范输入，绝不使用原图 original", () => {
  const assets = [
    asset("a-original", "original"),
    asset("a-normalized", "normalized_input"),
    asset("a-lineart", "lineart", { created_at: "2026-01-03T00:00:00Z" }),
    asset("a-crop", "cropped", { created_at: "2026-01-02T00:00:00Z" }),
  ];
  const source = group("a-normalized", assets);
  assert.equal(processingModule.pickInputAsset(source, { recipe: "color" }, "").asset_id, "a-normalized");
  assert.equal(processingModule.pickInputAsset(source, { recipe: "color" }, "a-lineart").asset_id, "a-lineart");
  const model = processingModule.pickInputAsset(source, { recipe: "model_lineart" }, "a-lineart");
  assert.equal(model.asset_id, "a-normalized", "lineart 不是线稿模型输入，退回规范输入");
  assert.ok(
    processingModule.compatibleInputAssets(source, { recipe: "color" }).every((entry) => entry.kind !== "original")
  );
});

test("运行校验：至少一张图、云端双同意且不默认勾选", () => {
  const options = processingModule.normalizePresetOptions({ recipe: "cloud_lineart" });
  const groups = [group("a-normalized", [asset("a-original", "original"), asset("a-normalized", "normalized_input")])];
  const selected = new Set(["image-a"]);
  assert.match(
    processingModule.runValidation({
      presetId: "p1",
      groups,
      selectedImageIds: selected,
      options,
      consentToUpload: false,
      consentToCharge: false,
    }),
    /上传与可能费用/
  );
  assert.equal(
    processingModule.runValidation({
      presetId: "p1",
      groups,
      selectedImageIds: selected,
      options,
      consentToUpload: true,
      consentToCharge: true,
    }),
    ""
  );
  assert.match(
    processingModule.runValidation({ presetId: "p1", groups, selectedImageIds: new Set(), options }),
    /至少选择一张/
  );
  assert.match(
    processingModule.runValidation({
      presetId: "p1",
      groups: [group("missing", [asset("x", "original")])],
      selectedImageIds: new Set(["image-a"]),
      options: { recipe: "model_lineart" },
    }),
    /输入版本/
  );
});

test("提交/续接/取消的请求体沿用接口合同", () => {
  assert.deepEqual(
    processingModule.buildBatchPayload("preset-1", [{ asset: { asset_id: "a1" } }], {
      consentToUpload: true,
      consentToCharge: false,
    }),
    { preset_id: "preset-1", input_asset_ids: ["a1"], consent_to_upload: true, consent_to_charge: false }
  );
  assert.deepEqual(processingModule.buildResumePayload(4, "asset-9"), {
    revision: 4,
    input_asset_id: "asset-9",
  });
  const preset = processingModule.buildPresetPayload(" 预设 ", { recipe: "color" }, 2);
  assert.equal(preset.name, "预设");
  assert.equal(preset.revision, 2);
  assert.equal(preset.options.recipe, "color");
  assert.equal(preset.options.vectorize, true);
});

test("预设校验：PNG-only 合法，工作副本范围来自 health", () => {
  const base = processingModule.defaultPresetOptions();
  const health = processingModule.healthPixelLimits();
  assert.match(processingModule.presetValidation("", base), /不能为空/);
  // 只生成 PNG 也是有效流程，不再强制矢量化或平铺。
  assert.equal(
    processingModule.presetValidation("x", { ...base, vectorize: false, tile: false }, health),
    ""
  );
  assert.match(processingModule.presetValidation("x", { ...base, working_max_pixels: 9000 }, health), /10,000/);
  assert.match(
    processingModule.presetValidation("x", { ...base, working_max_pixels: 25_000_001 }, health),
    /25,000,000/
  );
  assert.equal(
    processingModule.presetValidation("x", { ...base, working_max_pixels: 25_000_000 }, health),
    ""
  );
});

test("像素上限从 health 动态读取，路线有效上限与后端 working_limit 一致", () => {
  const limits = processingModule.healthPixelLimits();
  assert.deepEqual(limits, {
    working: 1_000_000,
    colorVector: 250_000,
    modelLineart: 25_000_000,
    threshold: 4_000_000,
    workingCopy: 25_000_000,
    tile: 4_000_000,
    decode: 25_000_000,
  });

  const modelPngOnly = processingModule.effectiveWorkingLimit(
    { recipe: "model_lineart", vectorize: false, tile: false },
    limits
  );
  assert.equal(modelPngOnly.value, 25_000_000, "本地模型 PNG-only 可用 25MP");
  assert.equal(modelPngOnly.requested, null);

  const modelColorSvg = processingModule.effectiveWorkingLimit(
    { recipe: "model_lineart", vectorize: true, vector: { mode: "color" }, working_max_pixels: 25_000_000 },
    limits
  );
  assert.equal(modelColorSvg.value, 250_000, "矢量化颜色模式把整条路线压到 250k");
  assert.equal(modelColorSvg.copy, 250_000, "显式设置 25MP 也要取整条路线较小值");

  const otsuPngOnly = processingModule.effectiveWorkingLimit(
    { recipe: "color", vectorize: false, tile: false, extract: { mode: "otsu" } },
    limits
  );
  assert.equal(otsuPngOnly.value, 4_000_000, "Otsu 提取有独立 4MP 上限");

  const manualPngOnly = processingModule.effectiveWorkingLimit(
    { recipe: "color", vectorize: false, tile: false, extract: { mode: "manual" } },
    limits
  );
  assert.equal(manualPngOnly.value, 1_000_000, "其它提取模式仍按 working_pixels");

  const otsuColorSvg = processingModule.effectiveWorkingLimit(
    { recipe: "color", vectorize: true, vector: { mode: "color" }, extract: { mode: "otsu" } },
    limits
  );
  assert.equal(otsuColorSvg.value, 250_000, "Otsu 4MP 也会被颜色矢量上限压低");

  const cloudPngOnly = processingModule.effectiveWorkingLimit(
    { recipe: "cloud_lineart", vectorize: false, tile: false },
    limits
  );
  assert.equal(cloudPngOnly.value, 25_000_000, "云端路线按解码上限");

  assert.equal(processingModule.pixelLimitForProcessRoute("color", limits, "otsu"), 4_000_000);
  assert.equal(processingModule.pixelLimitForProcessRoute("color", limits, "manual"), 1_000_000);
  assert.equal(processingModule.pixelLimitForProcessRoute("opencv", limits), 1_000_000);
  assert.equal(processingModule.pixelLimitForProcessRoute("local", limits), 25_000_000);
  // 单图矢量入口仍按 working_pixels；彩色 250k 只是组合/批次建议。
  assert.equal(processingModule.pixelLimitForVectorMode("color", limits), 1_000_000);
  assert.equal(processingModule.pixelLimitForVectorMode("monochrome", limits), 1_000_000);
  assert.equal(processingModule.colorVectorRecommendation(limits), 250_000);

  const masked = processingModule.effectiveWorkingLimit(
    { recipe: "model_lineart", mask: true, vectorize: false, tile: false },
    limits
  );
  assert.equal(masked.value, 1_000_000);

  const tiled = processingModule.effectiveWorkingLimit(
    { recipe: "model_lineart", vectorize: false, tile: true },
    limits
  );
  assert.equal(tiled.value, 1_000_000, "2×2 平铺输出 4MP / 4");

  // health 缺字段时不猜数值。
  const incomplete = processingModule.effectiveWorkingLimit(
    { recipe: "model_lineart", vectorize: true, vector: { mode: "color" } },
    { ...limits, colorVector: null }
  );
  assert.equal(incomplete.value, null);
  assert.equal(incomplete.complete, false);
});

test("颜色批次输入白名单不包含未确认 AI 候选", () => {
  const source = group("a-normalized", [
    asset("a-normalized", "normalized_input"),
    asset("a-composed", "composed_candidate"),
    asset("a-accepted", "accepted_repair"),
    asset("a-edit", "edit_candidate"),
    asset("a-placed", "placed_generated_layer"),
    asset("a-basemap", "generated_basemap"),
    asset("a-layer", "generated_layer"),
  ]);
  const kinds = processingModule
    .compatibleInputAssets(source, { recipe: "color" })
    .map((entry) => entry.kind)
    .sort();
  assert.deepEqual(kinds, ["accepted_repair", "composed_candidate", "normalized_input"]);
  assert.equal(processingModule.pickInputAsset(source, { recipe: "color" }).kind, "normalized_input");
});

test("人工门候选只列同类型版本，按新到旧；是否后代由服务端校验", () => {
  const pattern = {
    image_id: "image-a",
    assets: [
      asset("old-crop", "cropped", { created_at: "2026-01-01T00:00:00Z" }),
      asset("new-crop", "cropped", { created_at: "2026-01-05T00:00:00Z" }),
      asset("a-svg", "svg"),
    ],
  };
  const crops = processingModule.manualCandidates("crop", pattern);
  assert.deepEqual(crops.map((entry) => entry.asset_id), ["new-crop", "old-crop"]);
  assert.deepEqual(processingModule.manualCandidates("repair", pattern), []);
  assert.equal(processingModule.manualStage("mask"), 6);
  assert.equal(processingModule.manualStepLabel("candidates"), "候选合成");
});

test("批次进度与状态统计", () => {
  const batch = batchPayload({
    progress: {
      total: 4,
      counts: { succeeded: 1, failed: 1, waiting: 1, running: 1, queued: 0, cancelled: 0, cancelling: 0 },
      completed: 2,
    },
  });
  const progress = processingModule.batchProgress(batch);
  assert.equal(progress.percent, 50);
  assert.equal(progress.waiting, 1);
  assert.equal(progress.failed, 1);
  assert.equal(processingModule.canCancelBatch(batch), true);
  assert.equal(processingModule.canCancelBatch({ ...batch, state: "completed" }), false);
});

/* ------------------------------------------------------------------ 数据与写操作 */

test("刷新后从服务端批次列表恢复并选中进行中的批次", async () => {
  const finished = batchPayload({ batch_id: "batch-old", state: "completed" });
  const active = batchPayload({ batch_id: "batch-active", state: "running" });
  network.handler = (call) => {
    assert.equal(call.path, "/api/v1/processing-batches");
    return json({ items: [finished, active], next_cursor: null });
  };
  const items = await processingModule.loadBatches();
  assert.equal(items.length, 2);
  assert.equal(processing.selectedBatchId, "batch-active");
  assert.equal(processingModule.activeBatchCount(), 1);
});

test("新建批次提交 preset/输入/双同意，并选中新批次", async () => {
  network.handler = (call) => {
    assert.equal(call.path, "/api/v1/processing-batches");
    assert.equal(call.method, "POST");
    assert.deepEqual(call.body, {
      preset_id: "preset-cloud",
      input_asset_ids: ["a-normalized"],
      consent_to_upload: true,
      consent_to_charge: true,
    });
    return json(batchPayload({ batch_id: "batch-new" }), 202);
  };
  const batch = await processingModule.createBatch({
    presetId: "preset-cloud",
    inputs: [{ asset: { asset_id: "a-normalized" } }],
    consentToUpload: true,
    consentToCharge: true,
  });
  assert.equal(batch.batch_id, "batch-new");
  assert.equal(processing.selectedBatchId, "batch-new");
  assert.equal(processing.detail.batch_id, "batch-new");
  assert.equal(processing.batches[0].batch_id, "batch-new");
});

test("人工续接提交当前批次修订与所选后代资产", async () => {
  processing.detail = batchPayload();
  processing.selectedBatchId = "batch-1";
  processing.batches = [batchPayload()];
  network.handler = (call) => {
    assert.equal(call.path, "/api/v1/processing-batches/batch-1/items/item-1/resume");
    assert.equal(call.method, "POST");
    assert.deepEqual(call.body, { revision: 3, input_asset_id: "a-cropped" });
    return json(batchPayload({ state: "running", revision: 4 }));
  };
  const batch = await processingModule.resumeItem("batch-1", "item-1", 3, "a-cropped");
  assert.equal(batch.revision, 4);
});

test("取消批次只提交修订号，由服务端返回准确状态", async () => {
  network.handler = (call) => {
    assert.equal(call.path, "/api/v1/processing-batches/batch-1/cancel");
    assert.deepEqual(call.body, { revision: 3 });
    return json(batchPayload({ state: "cancelling", revision: 4 }));
  };
  const batch = await processingModule.cancelBatch("batch-1", 3);
  assert.equal(batch.state, "cancelling");
  assert.equal(processing.detail.state, "cancelling");
});

test("结果导出只使用真实 /patterns 资产，不伪造转换", async () => {
  const batch = batchPayload({
    state: "completed",
    items: [
      {
        ...batchPayload().items[0],
        state: "succeeded",
        waiting_for: null,
        results: ["a-svg", "a-skip"],
      },
    ],
  });
  processing.detail = batch;
  network.handler = (call) => {
    assert.equal(call.path, "/api/v1/patterns/image-a");
    return json({
      image_id: "image-a",
      name: "A 图",
      normalized_asset_id: "a-normalized",
      assets: [asset("a-original", "original"), asset("a-normalized", "normalized_input"), asset("a-svg", "svg")],
      categories: [],
      category_ids: [],
      revision: 0,
    });
  };
  await processingModule.loadPattern("image-a", { force: true });
  const groups = processingModule.resultGroups(batch);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].assets.map((entry) => entry.kind), ["original", "normalized_input", "svg"]);
  assert.deepEqual(processingModule.resultAssetIds(batch), ["a-skip"]);
});

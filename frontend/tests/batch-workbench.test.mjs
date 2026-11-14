/* =============================================================================
   batch-workbench.test.mjs — 批量纹样管理：导入队列、原图分组、导出选择、
   纹样库分组/分类的定向回归。
   用与 next-v2-integration 相同的数据 URL 模块加载方式，驱动真实模块；
   网络用内存 fetch mock，不依赖浏览器、真实服务或计时器。
   ============================================================================= */

import test, { beforeEach, afterEach } from "node:test";
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

const { module: storeModule } = await loadRecord("./store.js");
const { module: apiModule } = await loadRecord("./api.js");
const { module: batch } = await loadRecord("./batch.js");
const { module: exportView } = await loadRecord("./views/batch-export.js");
const { module: libraryView } = await loadRecord("./views/library.js");
const { module: workbench } = await loadRecord("./views/workbench.js");
const store = storeModule.store;

/* ------------------------------------------------------------------ 网络 mock */

const realFetch = globalThis.fetch;
const network = { handler: null, calls: [] };

globalThis.fetch = async (input, init = {}) => {
  if (!network.handler) throw new Error("unexpected fetch in test");
  const url = String(typeof input === "string" ? input : input?.url || input);
  const method = String(init.method || "GET").toUpperCase();
  let body = init.body || null;
  const call = { url, path: url.split("?")[0], method, body, query: new URLSearchParams(url.split("?")[1] || "") };
  network.calls.push(call);
  return network.handler(call);
};

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  network.calls.length = 0;
  network.handler = null;
  batch.resetBatchState();
  store.patterns.items = [];
  store.patterns.categories = [];
  store.patterns.cursor = "";
  store.patterns.nextCursor = null;
  store.patterns.loading = false;
  store.patterns.error = "";
  store.patterns.q = "";
  store.patterns.kind = "";
  store.patterns.categoryId = "";
  store.patterns.grade = "全部";
  store.patterns.sort = "最新";
  store.patterns.view = "grid";
});

afterEach(() => {
  network.handler = null;
  batch.resetBatchState();
});

const plainFile = (name, size = 1024, type = "image/png", lastModified = 1) => ({
  name,
  size,
  type,
  lastModified,
});

function asset(id, kind, extra = {}) {
  return {
    asset_id: id,
    kind,
    width: 100,
    height: 100,
    bytes: 1024,
    grade: "A",
    license: "CC0",
    created_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

function pattern(imageId, name, assets, extra = {}) {
  return {
    image_id: imageId,
    original_asset_id: assets[0]?.asset_id || "",
    normalized_asset_id: assets[1]?.asset_id || "",
    name,
    created_at: "2026-01-01T00:00:00Z",
    assets,
    categories: [],
    category_ids: [],
    revision: 0,
    ...extra,
  };
}

/* ------------------------------------------------------------------ 批量导入 */

test("批量导入计划：类型/大小/批内重复先跳过，不提交", () => {
  const files = [
    plainFile("a.png"),
    plainFile("a.png"),
    plainFile("b.jpg", 2048, "image/jpeg", 2),
    plainFile("bad.gif", 20, "image/gif", 3),
    plainFile("big.png", 21 * 1024 * 1024, "image/png", 4),
  ];
  const plan = batch.planBatchImport(files);
  assert.deepEqual(plan.items.map((item) => item.file.name), ["a.png", "b.jpg"]);
  assert.deepEqual(
    plan.skipped.map((item) => [item.file.name, item.reason]),
    [
      ["a.png", "duplicate"],
      ["bad.gif", "unsupported"],
      ["big.png", "too_large"],
    ]
  );
});

test("批量上传顺序执行：单个失败不阻断，已成功的签名不重复提交", async () => {
  const uploaded = [];
  const events = [];
  const files = [plainFile("a.png"), plainFile("b.png"), plainFile("c.png")];
  await batch.runBatchImport({
    items: files.map((file, index) => ({ file, key: String(index), signature: file.name })),
    upload: async (file) => {
      uploaded.push(file.name);
      if (file.name === "b.png") throw new Error("单个失败");
      return { image_id: `image-${file.name}` };
    },
    onEvent: (event) => events.push([event.item.file.name, event.status]),
  });
  assert.deepEqual(uploaded, ["a.png", "b.png", "c.png"]);
  assert.deepEqual(events, [
    ["a.png", "uploading"],
    ["a.png", "done"],
    ["b.png", "uploading"],
    ["b.png", "error"],
    ["c.png", "uploading"],
    ["c.png", "done"],
  ]);

  const skipped = [];
  let attempts = 0;
  await batch.runBatchImport({
    items: [{ file: files[0], key: "again", signature: "a.png" }],
    upload: async () => {
      attempts += 1;
      return { image_id: "duplicate" };
    },
    succeeded: (signature) => signature === "a.png",
    onEvent: (event) => skipped.push(event.status),
  });
  assert.equal(attempts, 0);
  assert.deepEqual(skipped, ["skipped"]);
});

test("批量导入真实链路：逐文件成功/失败、汇总近似版本、再次导入不重复提交", async () => {
  network.handler = (call) => {
    if (call.path !== "/api/v1/images" || call.method !== "POST") throw new Error("unexpected " + call.path);
    const file = call.body.get("file");
    if (file.name === "b.png") return json({ error: { code: "SERVICE_ERROR", message: "worker down" } }, 500);
    return json(
      {
        image_id: `image-${file.name}`,
        created_at: "2026-02-01T00:00:00Z",
        original: asset(`orig-${file.name}`, "original"),
        normalized: asset(`norm-${file.name}`, "normalized_input"),
        meta: { source_name: file.name },
        duplicates: [{ image_id: "existing-image", ncc: 0.98, status: "suspect" }],
      },
      201
    );
  };
  const events = [];
  const fileA = new File(["a"], "a.png", { type: "image/png" });
  const fileB = new File(["b"], "b.png", { type: "image/png" });
  const summary = await batch.importFiles([fileA, fileB], {
    onChange: (event) => events.push(event.reason),
    toast: () => {},
  });
  assert.deepEqual(summary, { total: 2, done: 1, failed: 1, skipped: 0, duplicates: 1 });
  const snapshot = batch.batchSnapshot();
  assert.equal(snapshot.groups.length, 1);
  assert.equal(snapshot.groups[0].imageId, "image-a.png");
  assert.deepEqual(snapshot.groups[0].assetIds.sort(), ["norm-a.png", "orig-a.png"]);
  assert.equal(batch.duplicateSummary().count, 1);

  // 已成功的 a.png 再次选择时不会重新提交；重试只补失败的 b.png。
  const before = network.calls.length;
  await batch.importFiles([fileA], { onChange: () => {}, toast: () => {} });
  assert.equal(network.calls.length, before, "已成功文件不得重复提交");
  network.handler = (call) => {
    const file = call.body.get("file");
    return json(
      {
        image_id: `image-${file.name}`,
        original: asset(`orig-${file.name}`, "original"),
        normalized: asset(`norm-${file.name}`, "normalized_input"),
        meta: { source_name: file.name },
        duplicates: [],
      },
      201
    );
  };
  const retried = await batch.retryFailedImports({ onChange: () => {}, toast: () => {} });
  assert.deepEqual(retried, { done: 1, failed: 0 });
  assert.equal(batch.batchSnapshot().summary.failed, 0);
});

/* ------------------------------------------------------------------ 原图分组 */

test("侧栏按原图分区：当前组置顶，别的原图资产不并入 store.session", async () => {
  store.session = {
    imageId: "image-a",
    image: { image_id: "image-a", meta: { source_name: "A 图" }, created_at: "2026-01-02T00:00:00Z" },
    assets: [asset("a-orig", "original"), asset("a-svg", "svg")],
    currentAssetId: "a-svg",
    jobs: [],
    busy: false,
    activeJob: null,
    error: "",
  };
  network.handler = () =>
    json({
      items: [
        pattern("image-b", "B 图", [asset("b-orig", "original"), asset("b-png", "transparent_png")]),
        pattern("image-a", "A 图", [asset("a-orig", "original")]),
      ],
      next_cursor: null,
    });
  await batch.loadWorkbenchPage({});
  const groups = batch.batchGroups();
  assert.deepEqual(groups.map((group) => group.imageId), ["image-a", "image-b"]);
  assert.equal(groups[0].current, true);
  assert.deepEqual(groups[1].assets.map((item) => item.asset_id), ["b-orig", "b-png"]);
  // 关键隔离：索引里的 B 组不会写进当前会话。
  assert.deepEqual(store.session.assets.map((item) => item.asset_id).sort(), ["a-orig", "a-svg"]);
});

test("工作台纹样列：默认不镜像纹样库，加入/移出只改成员关系", async () => {
  store.resetSession();
  network.handler = (call) => {
    if (call.path === "/api/v1/workbench/items" && call.method === "GET") {
      return json({ items: [], next_cursor: null });
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  };
  await batch.loadWorkbenchPage({});
  assert.deepEqual(batch.batchSnapshot().groups, []);
  assert.deepEqual(batch.batchSnapshot().members, []);

  const item = pattern("image-a", "A 图", [asset("a-orig", "original")]);
  network.handler = (call) => {
    if (call.path === "/api/v1/workbench/items" && call.method === "POST") {
      return json({ added: ["image-a"], added_count: 1, existing_count: 0, missing: [] });
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  };
  await batch.addWorkbenchItems([item]);
  assert.deepEqual(batch.batchSnapshot().members, ["image-a"]);
  assert.equal(batch.batchSnapshot().groups[0].member, true);

  // 工作台当前组用 camelCase 结构传入（imageId/assets）也必须能加入。
  network.handler = (call) => {
    if (call.path === "/api/v1/workbench/items" && call.method === "POST") {
      const payload = JSON.parse(String(call.body || "{}"));
      return json({ added: payload.image_ids || [], added_count: 1, existing_count: 0, missing: [] });
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  };
  await batch.addWorkbenchItems([
    { imageId: "image-c", name: "C 图", assets: [asset("c-orig", "original")], member: false },
  ]);
  assert.ok(batch.batchSnapshot().members.includes("image-c"));

  network.handler = (call) => {
    if (call.path === "/api/v1/workbench/items" && call.method === "DELETE") {
      return json({ removed: 1, image_ids: ["image-a"] });
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  };
  await batch.removeWorkbenchMembers(["image-a", "image-c"]);
  assert.deepEqual(batch.batchSnapshot().members, []);
  assert.deepEqual(batch.batchSnapshot().groups, []);
});

test("工作台「全选」先读完全部分页，超过一页也不漏组", async () => {
  store.resetSession();
  network.handler = (call) => {
    const cursor = call.query.get("cursor");
    if (!cursor) {
      return json({
        items: [pattern("image-a", "A", [asset("a1", "original")])],
        next_cursor: "1",
      });
    }
    return json({
      items: [pattern("image-b", "B", [asset("b1", "original")])],
      next_cursor: null,
    });
  };
  await batch.loadWorkbenchPage({});
  assert.equal(batch.workbenchHasMore(), true);
  assert.equal(await batch.loadAllWorkbenchItems(), true);
  assert.equal(batch.workbenchHasMore(), false);
  assert.deepEqual(batch.batchSnapshot().groups.map((group) => group.imageId), ["image-a", "image-b"]);
});

test("工作台纹样列提供多选、全选、移出与批量删除入口", () => {
  store.session = {
    imageId: "image-current",
    image: { image_id: "image-current", meta: { source_name: "当前图" } },
    assets: [asset("cur-orig", "original")],
    currentAssetId: "cur-orig",
    jobs: [],
    busy: false,
    activeJob: null,
    error: "",
  };
  const html = batch.patternColumnHtml({ selected: new Set(["image-current"]) });
  assert.match(html, /data-act="workbench-picker"[^>]*>[\s\S]*?添加纹样/);
  assert.match(html, /data-pattern-select-all/);
  assert.match(html, /data-pattern-select[^>]*data-image="image-current"/);
  assert.match(html, /data-pattern-select[^>]*checked/);
  assert.match(html, /data-act="bp-remove-selected"/);
  assert.match(html, /data-act="bp-delete-selected"/);
  assert.match(html, /已选 1 \/ 1 个/);
  // 当前会话尚未加入成员表：提供显式「加入工作台」，不偷偷写入。
  assert.match(html, /data-act="pattern-add"[^>]*data-image="image-current"/);
  assert.match(html, /未加入工作台/);
});

test("工作台列按原图分组渲染，跨图缩略图走 openAsset 深链", async () => {
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
      imageId: "image-a",
      image: { image_id: "image-a", meta: { source_name: "A 图" } },
      assets: [asset("a-orig", "original"), asset("a-svg", "svg")],
      currentAssetId: "a-svg",
      jobs: [],
      busy: false,
      activeJob: null,
      error: "",
    };
    store.seedream = { enabled: false, blockers: [] };
    batch.syncSessionGroup();
    network.handler = () =>
      json({
        items: [
          pattern("image-b", "B 图", [asset("b-orig", "original"), asset("b-png", "transparent_png")]),
          // 当前原图组里有一个尚未载入本会话的历史版本。
          pattern("image-a", "A 图", [asset("a-orig", "original"), asset("a-historical", "cropped")]),
        ],
        next_cursor: null,
      });
    await batch.loadWorkbenchPage({});
    const state = { stage: 1, tile: "2x2", zoom: "fit", brush: 24, compare: false };
    const html = workbench.default.render(state, { state: {} }, new URLSearchParams());
    assert.match(html, /aria-label="纹样"/);
    assert.match(html, /<span class="label">纹样<\/span>/);
    assert.match(html, /data-act="batch-import"/);
    assert.match(html, /data-act="open-export"/);
    assert.match(html, /data-pattern="image-a"/);
    assert.match(html, /data-pattern="image-b"/);
    assert.match(html, /data-act="pattern-asset"[^>]*data-id="b-orig"/);
    assert.match(html, /data-act="asset"[^>]*data-id="a-svg"/);
    // 当前原图的历史版本不在会话里：必须走深链读取，不能只改 currentAssetId。
    assert.match(html, /data-act="pattern-asset"[^>]*data-id="a-historical"/);
    const aAt = html.indexOf('data-pattern="image-a"');
    const bAt = html.indexOf('data-pattern="image-b"');
    assert.ok(aAt >= 0 && bAt > aAt, "当前原图组应排在最前");
    // 索引里 B 组的缩略图只出现在列里，不能被塞进当前会话。
    assert.deepEqual(store.session.assets.map((item) => item.asset_id).sort(), ["a-orig", "a-svg"]);
    assert.equal(store.session.assets.length, 2);
  } finally {
    globalThis.window = originalWindow;
  }
});

/* ------------------------------------------------------------------ 导出选择 */

function exportGroups() {
  return [
    {
      imageId: "image-a",
      name: "A 图",
      current: true,
      assets: [
        asset("a-orig", "original"),
        asset("a-svg", "svg", { bytes: 2048, license: "未确认" }),
        asset("a-zip", "zip"),
      ],
    },
    {
      imageId: "image-b",
      name: "B 图",
      current: false,
      assets: [asset("b-orig", "original"), asset("b-png", "transparent_png", { grade: "B" })],
    },
  ];
}

test("导出只含真实文件：ZIP 不能嵌套，统计按已载入组计算", () => {
  const groups = exportGroups();
  const entries = exportView.exportableAssets(groups);
  assert.deepEqual(entries.map((entry) => entry.asset.asset_id), ["a-orig", "a-svg", "b-orig", "b-png"]);
  const stats = exportView.selectionStats(groups, new Set(["a-orig", "b-orig", "a-svg"]));
  assert.equal(stats.count, 3);
  assert.equal(stats.groups, 2);
  assert.equal(stats.bytes, 4096);
});

test("整组/类型/全选/反选只在传入的已载入组内生效", () => {
  const groups = exportGroups();
  let selected = new Set();
  selected = exportView.selectionForGroup(groups, "image-a", selected, true);
  assert.deepEqual([...selected].sort(), ["a-orig", "a-svg"]);
  selected = exportView.selectionForGroup(groups, "image-a", selected, false);
  assert.equal(selected.size, 0);

  selected = exportView.selectionForKind(groups, "original", selected, true);
  assert.deepEqual([...selected].sort(), ["a-orig", "b-orig"]);
  selected = exportView.selectionForKind(groups, "svg", selected, true);
  assert.deepEqual([...selected].sort(), ["a-orig", "a-svg", "b-orig"]);

  const inverted = exportView.invertSelection(groups, selected);
  assert.deepEqual([...inverted].sort(), ["b-png"]);
  assert.deepEqual([...exportView.allSelection(groups, true)].sort(), ["a-orig", "a-svg", "b-orig", "b-png"]);
  assert.equal(exportView.allSelection(groups, false).size, 0);
});

test("导出请求固定 by_image，保留许可与上限阻断", () => {
  const payload = exportView.buildExportPayload(["a", "b"], { licenseAcknowledged: true });
  assert.deepEqual(payload, { asset_ids: ["a", "b"], layout: "by_image", license_acknowledged: true });

  const tooMany = { count: 501, total: 600, groups: 3, bytes: 100, overCount: true, overBytes: false };
  assert.match(exportView.submitBlockReason(tooMany, true), /500/);
  const tooBig = { count: 2, total: 10, groups: 1, bytes: 129 * 1024 * 1024, overCount: false, overBytes: true };
  assert.match(exportView.submitBlockReason(tooBig, true), /128 MiB/);
  assert.match(exportView.submitBlockReason({ count: 2, overCount: false, overBytes: false }, false), /许可/);
  assert.equal(exportView.submitBlockReason({ count: 0, overCount: false, overBytes: false }, true), "至少勾选一个要导出的版本。");
});

test("默认只勾当前原图组的关键结果，其它原图需显式全选", () => {
  const selected = exportView.defaultExportSelection(exportGroups(), "image-a", "a-svg");
  assert.ok(selected.has("a-svg"));
  assert.ok(selected.has("a-orig"));
  assert.ok(!selected.has("b-orig"));
  assert.ok(!selected.has("b-png"));
});

test("导出浮窗明示范围、许可与逐图选择，不把未载入组说成全选", () => {
  const groups = exportGroups();
  const html = exportView.exportModalHtml({
    groups,
    selected: new Set(["a-orig"]),
    licenseAck: false,
    scopeNote: "本次已载入 2 个原图组",
    running: false,
    job: null,
    zip: null,
    error: "",
    zoomAsset: "",
  });
  assert.match(html, /范围：本次已载入 2 个原图组/);
  assert.match(html, /未载入的分组不会被选中/);
  assert.match(html, /images\/&lt;原图 ID&gt;/);
  assert.match(html, /data-bx-toggle="a-orig" aria-pressed="true"/);
  assert.match(html, /data-bx-toggle="b-orig" aria-pressed="false"/);
  assert.match(html, /data-bx-group="image-a"/);
  assert.match(html, /data-bx-kind="svg"/);
  assert.match(html, /data-bx-license/);
  assert.match(html, /128 MiB/);
  assert.match(html, /授权未登记/);
  assert.match(html, /已选 <b class="num">1<\/b> \/ 4 项/);
});

/* ------------------------------------------------------------------ 纹样库 */

test("纹样库按原图组展示：评级只筛组内版本，空组不留下", () => {
  const groups = [
    pattern("image-a", "A", [
      asset("a1", "original", { grade: "A" }),
      asset("a2", "svg", { grade: "C", created_at: "2026-01-03T00:00:00Z" }),
    ]),
    pattern("image-b", "B", [asset("b1", "original", { grade: "B" })]),
  ];
  const displayed = libraryView.displayedPatterns(groups, { grade: "A", sort: "最新" });
  assert.deepEqual(displayed.map((group) => group.image_id), ["image-a"]);
  assert.deepEqual(displayed[0].assets.map((item) => item.asset_id), ["a1"]);

  const sorted = libraryView.displayedPatterns(groups, { grade: "全部", sort: "最早" });
  assert.deepEqual(sorted[0].assets.map((item) => item.asset_id), ["a1", "a2"]);
  assert.equal(sorted[0].assets[0].asset_id, "a1");
});

test("纹样库分组卡片保留档案、分类、工作台与导出入口", () => {
  const group = pattern("image-a", "A 图", [asset("a1", "original"), asset("a2", "svg")], {
    categories: [{ category_id: "cat-1", name: "祥云", revision: 2 }],
    category_ids: ["cat-1"],
    revision: 3,
  });
  const html = libraryView.patternGroupHtml(group);
  assert.match(html, /data-open="a1"/);
  assert.match(html, /data-open="a2"/);
  assert.match(html, /data-act="pattern-workbench"/);
  assert.match(html, /data-act="pattern-export"/);
  assert.match(html, /data-act="pattern-delete"/);
  assert.match(html, /data-act="assign"/);
  assert.match(html, /祥云/);
});

test("纹样库批量选择：卡片显示勾选与全选入口，默认不显示", () => {
  const group = pattern("image-a", "A 图", [asset("a1", "original")]);
  const plain = libraryView.patternGroupHtml(group);
  assert.doesNotMatch(plain, /data-lb-select/);
  const selectedHtml = libraryView.patternGroupHtml(group, {
    select: true,
    chosen: new Set(["image-a"]),
  });
  assert.match(selectedHtml, /lb-pattern--select/);
  assert.match(selectedHtml, /is-selected/);
  assert.match(selectedHtml, /data-lb-select="image-a"[^>]*checked/);
  assert.match(libraryView.default.render(), /data-act="select-mode"/);
});

test("删除分类只解除归类，不删除原图组或版本", async () => {
  store.patterns.categories = [{ category_id: "cat-1", name: "祥云", revision: 2 }];
  store.patterns.items = [
    pattern("image-a", "A", [asset("a1", "original")], {
      categories: [{ category_id: "cat-1", name: "祥云", revision: 2 }],
      category_ids: ["cat-1"],
      revision: 5,
    }),
  ];
  const original = apiModule.api.deletePatternCategory;
  apiModule.api.deletePatternCategory = async () => ({ category_id: "cat-1", deleted: true });
  try {
    await store.deletePatternCategory("cat-1", 2);
  } finally {
    apiModule.api.deletePatternCategory = original;
  }
  assert.equal(store.patterns.categories.length, 0);
  assert.deepEqual(store.patterns.items[0].category_ids, []);
  assert.deepEqual(store.patterns.items[0].assets.map((item) => item.asset_id), ["a1"]);
  assert.equal(store.patterns.items.length, 1);
});

test("纹样库搜索：旧请求晚到也不会覆盖最新筛选", async () => {
  const pending = new Map();
  network.handler = (call) => {
    const q = call.query.get("q") || "";
    const deferred = pending.get(q);
    if (!deferred) throw new Error("missing deferred for " + q);
    return deferred.promise;
  };
  const deferredA = {};
  deferredA.promise = new Promise((resolve) => {
    deferredA.resolve = resolve;
  });
  pending.set("A", deferredA);
  const deferredB = {};
  deferredB.promise = new Promise((resolve) => {
    deferredB.resolve = resolve;
  });
  pending.set("B", deferredB);

  store.setPatternQuery({ q: "A" });
  const first = store.loadPatterns();
  store.setPatternQuery({ q: "B" });
  const second = store.loadPatterns();

  deferredB.resolve(json({ items: [pattern("image-b", "B", [asset("b1", "original")])], next_cursor: null }));
  await second;
  deferredA.resolve(json({ items: [pattern("image-a", "A", [asset("a1", "original")])], next_cursor: null }));
  await first;

  assert.deepEqual(store.patterns.items.map((item) => item.image_id), ["image-b"]);
  assert.equal(store.patterns.loading, false);
  assert.equal(store.patterns.error, "");
});

test("纹样库渲染保留统计、评级/排序/视图与分类管理入口", () => {
  store.patterns.categories = [{ category_id: "cat-1", name: "祥云", revision: 1 }];
  store.patterns.categoryId = "cat-1";
  const html = libraryView.default.render();
  assert.match(html, /data-lb-stats/);
  assert.match(html, /data-lb-sort/);
  assert.match(html, /data-act="view" data-val="grid"/);
  assert.match(html, /data-act="view" data-val="list"/);
  assert.match(html, /data-act="grade" data-val="A"/);
  assert.match(html, /data-act="cat-filter"/);
  assert.match(html, /data-act="cat-new"/);
  assert.match(html, /data-act="cat-manage"/);
  assert.match(html, /data-act="export-loaded"/);
  assert.match(html, /祥云/);
});

/* ------------------------------------------------------------------ 样式入口 */

test("index.html 在 workbench.css / library.css 之后引入 batch.css", async () => {
  const html = await readFile(new URL("../next-v2/index.html", import.meta.url), "utf8");
  const workbenchAt = html.indexOf("./css/workbench.css");
  const libraryAt = html.indexOf("./css/library.css");
  const batchAt = html.indexOf("./css/batch.css");
  assert.ok(workbenchAt >= 0 && libraryAt > workbenchAt && batchAt > libraryAt);
});

test("窄屏锁定整页高度，同时保留工作台与纹样列的内部滚动", async () => {
  const css = await readFile(new URL("../next-v2/css/batch.css", import.meta.url), "utf8");
  // 覆盖 workbench.css 窄屏的 height:auto / overflow:visible，页面本身不滚。
  assert.match(css, /\.view--flush\s*\{[^}]*calc\(100dvh - 94px\)/s);
  assert.match(css, /\.view--flush \.wb\s*\{[^}]*overflow-y:\s*auto/s);
  // 纹样列在窄屏仍有自己的滚动区，不能靠 overflow:hidden 把分组截掉。
  assert.match(css, /\.wb-patterns \.bp-groups\s*\{[^}]*max-height:\s*min\(64vh, 620px\)[^}]*overflow-y:\s*auto/s);
});

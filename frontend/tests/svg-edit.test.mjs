/* =============================================================================
   svg-edit.test.mjs — SVG 图形级编辑的纯行为回归（无浏览器、无真实网络）。
   覆盖契约里可确定的部分：空数组=合法空白 SVG、视觉独立图形的累计平移/删除、
   撤销重做、只提交变化元素、2000 上限、受控属性输出、按资产隔离与来源链补齐。
   ============================================================================= */

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  SVG_EDIT_MAX_CHANGES,
  adoptSvgPayload,
  applyDeleted,
  applyTranslation,
  buildEditSvgPayload,
  changeCount,
  clientPointToSvg,
  createSvgDraft,
  currentSvgDraft,
  deletedCount,
  discardAllSvgDrafts,
  draftFor,
  editsSignature,
  ensureAssetSourceChain,
  ensureSvgDraft,
  hitComponentMarkup,
  markSvgSaved,
  mergedDrawMarkup,
  parseSvgElements,
  redoDraft,
  sourcePathKey,
  svgActionsHtml,
  svgCaption,
  svgEditingLocked,
  svgElementMarkup,
  svgPanelHtml,
  svgPlate,
  svgStatus,
  svgSurfaceMarkup,
  setSvgEditingBusy,
  undoDraft,
  validateSvgSave,
} from "../next-v2/js/svg-edit.js";
import { api as http } from "../next-v2/js/api.js";
import { store } from "../next-v2/js/store.js";

const sha = "a".repeat(64);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function payload(overrides = {}) {
  return {
    asset_id: "svg-a",
    source_sha256: sha,
    version: "1",
    width: 200,
    height: 100,
    elements: [
      {
        id: "p0c0",
        d: "M0 0h20v10H0Z",
        fill: "#112233",
        fill_rule: "evenodd",
        transform: "translate(2,3)",
        bbox: [2, 3, 22, 13],
      },
      {
        id: "p0c1",
        d: "M40 10h10v10H40Z",
        fill: "#445566",
        fill_rule: "",
        transform: "",
        bbox: [40, 10, 50, 20],
      },
      { id: "p1c0", d: "M100 20h30v20H100Z", fill: "#778899", bbox: [100, 20, 130, 40] },
    ],
    ...overrides,
  };
}

function setSession({ imageId = "image-a", assets = [], currentAssetId = "" } = {}) {
  store.session = {
    imageId,
    image: null,
    assets,
    currentAssetId,
    jobs: [],
    activeJob: null,
    busy: false,
    error: "",
  };
}

beforeEach(() => {
  store.resetSession();
  discardAllSvgDrafts();
  setSession({ imageId: "", assets: [], currentAssetId: "" });
});

afterEach(() => {
  discardAllSvgDrafts();
  setSession({ imageId: "", assets: [], currentAssetId: "" });
});

test("parseSvgElements 保留独立图形字段；elements 空数组合法（空白 SVG）", () => {
  const parsed = parseSvgElements(payload(), { assetId: "svg-a" });
  assert.equal(parsed.width, 200);
  assert.equal(parsed.sourceSha256, sha);
  assert.deepEqual(parsed.elements.map((entry) => entry.id), ["p0c0", "p0c1", "p1c0"]);
  assert.equal(parsed.elements[0].fillRule, "evenodd");
  assert.deepEqual(parsed.elements[0].bbox, [2, 3, 22, 13]);
  assert.equal(parsed.elements[1].transform, "");

  const blank = parseSvgElements(payload({ asset_id: "svg-blank", elements: [] }), { assetId: "svg-blank" });
  assert.deepEqual(blank.elements, []);
  assert.equal(blank.width, 200);

  assert.throws(() => parseSvgElements(payload({ source_sha256: "" })), /来源校验信息/);
  assert.throws(() => parseSvgElements(payload({ elements: null })), /图形列表/);
  assert.throws(
    () => parseSvgElements(payload({ elements: [{ id: "", d: "" }] })),
    /都缺少可用的 id 或路径数据/
  );
  assert.throws(
    () => parseSvgElements(payload({ asset_id: "other" }), { assetId: "svg-a" }),
    /不属于当前资产/
  );
});

test("空白 SVG 可以渲染为空白画布，不被当作损坏", () => {
  const draft = adoptSvgPayload({ asset_id: "svg-blank" }, payload({ asset_id: "svg-blank", elements: [] }));
  assert.equal(draft.elements.length, 0);
  assert.equal(changeCount(draft), 0);
  assert.equal(validateSvgSave(draft), "还没有改动；先选择、移动或删除图形。");
  const surface = svgSurfaceMarkup(draft);
  assert.match(surface, /viewBox="0 0 200 100"/);
  assert.doesNotMatch(surface, /data-svg-element/);
  const plate = svgPlate({ asset_id: "svg-blank", kind: "svg", width: 200, height: 100 });
  assert.equal(plate.kind, "editor");
  assert.match(plate.inner, /wb-svg-edit__empty/);
  assert.match(plate.inner, /空白 SVG/);
  assert.match(svgCaption({ asset_id: "svg-blank", kind: "svg" }), /空白 SVG/);
  assert.match(svgStatus({ asset_id: "svg-blank", kind: "svg" }), /可从历史版本重开/);
  assert.match(svgPanelHtml({ asset_id: "svg-blank", kind: "svg" }), /空白是合法的已保存结果/);
});

test("按视觉独立图形累计平移/删除；只提交实际变化的元素", () => {
  const draft = adoptSvgPayload({ asset_id: "svg-a" }, payload());
  assert.equal(applyTranslation(draft, ["p0c0", "p0c1"], 5.4, -2.6), 2);
  assert.deepEqual(draft.edits.p0c0, { dx: 5, dy: -3, deleted: false });
  assert.deepEqual(draft.edits.p0c1, { dx: 5, dy: -3, deleted: false });
  assert.equal(draft.edits.p1c0, undefined);

  // 再次平移是相对该输入元素的累计值，而不是覆盖上一次。
  applyTranslation(draft, ["p0c0"], -2, 1);
  assert.deepEqual(draft.edits.p0c0, { dx: 3, dy: -2, deleted: false });

  applyDeleted(draft, ["p0c1"], true);
  const body = buildEditSvgPayload(draft);
  assert.deepEqual(body, {
    input_asset_id: "svg-a",
    source_sha256: sha,
    edits: [
      { element_id: "p0c0", dx: 3, dy: -2, deleted: false },
      { element_id: "p0c1", dx: 5, dy: -3, deleted: true },
    ],
  });
  assert.equal(body.edits.some((edit) => edit.element_id === "p1c0"), false);
  assert.equal(validateSvgSave(draft), "");
});

test("撤销/重做覆盖移动和删除；新改动会清空重做栈", () => {
  const draft = adoptSvgPayload({ asset_id: "svg-a" }, payload());
  applyTranslation(draft, ["p0c0"], 10, 0);
  applyDeleted(draft, ["p0c0"], true);
  assert.deepEqual(draft.edits.p0c0, { dx: 10, dy: 0, deleted: true });

  assert.equal(undoDraft(draft), true);
  assert.deepEqual(draft.edits.p0c0, { dx: 10, dy: 0, deleted: false });
  assert.equal(undoDraft(draft), true);
  assert.deepEqual(draft.edits, {});
  assert.equal(undoDraft(draft), false);

  assert.equal(redoDraft(draft), true);
  assert.deepEqual(draft.edits.p0c0, { dx: 10, dy: 0, deleted: false });
  assert.equal(redoDraft(draft), true);
  assert.equal(draft.edits.p0c0.deleted, true);

  assert.equal(undoDraft(draft), true);
  applyTranslation(draft, ["p0c1"], 4, 0);
  assert.equal(redoDraft(draft), false);
});

test("保存任务运行期间锁定编辑入口；保存成功只清空与提交快照一致的草稿", () => {
  const asset = { asset_id: "svg-a", kind: "svg", width: 200, height: 100 };
  const draft = adoptSvgPayload(asset, payload());
  applyTranslation(draft, ["p0c0"], 8, 0);
  const submitted = editsSignature(draft);

  // 提交后、activeJob 写入前也必须锁定，避免请求在途时继续改草稿。
  setSvgEditingBusy(true);
  assert.equal(svgEditingLocked(), true);
  setSvgEditingBusy(false);
  assert.equal(svgEditingLocked(), false);

  store.session.activeJob = { job_id: "job-1", kind: "edit-svg", state: "running" };
  assert.equal(svgEditingLocked(), true);
  assert.match(svgPlate(asset).inner, /is-locked/);
  assert.match(svgPlate(asset).inner, /编辑已锁定/);
  assert.match(svgActionsHtml(asset, { busy: true }), /data-svg-act="save" disabled/);
  assert.match(svgPanelHtml(asset), /保存中|disabled/);

  // 模拟锁定失效或外部并发：提交后草稿又变化，不能把新变化当成已保存而清空。
  applyTranslation(draft, ["p0c1"], 3, 0);
  const savedClean = markSvgSaved("svg-a", { asset_id: "svg-new" }, submitted);
  assert.equal(savedClean, false);
  assert.equal(draftFor("svg-a")?.edits.p0c0.dx, 8);
  assert.equal(draftFor("svg-a")?.edits.p0c1.dx, 3);
  assert.equal(draftFor("svg-new"), null);

  // 快照一致时才清空老草稿，并让新版本重新读取。
  const cleanSignature = editsSignature(draft);
  assert.equal(markSvgSaved("svg-a", { asset_id: "svg-new" }, cleanSignature), true);
  assert.deepEqual(draftFor("svg-a")?.edits, {});
  store.session.activeJob = null;
});

test("删除全部元素后仍可保存为空白版本；空数组响应可再次编辑", () => {
  const draft = adoptSvgPayload({ asset_id: "svg-a" }, payload());
  const ids = draft.elements.map((element) => element.id);
  applyDeleted(draft, ids, true);
  assert.equal(deletedCount(draft), 3);
  assert.equal(changeCount(draft), 3);
  assert.equal(validateSvgSave(draft), "");
  const body = buildEditSvgPayload(draft);
  assert.equal(body.edits.length, 3);
  assert.equal(body.edits.every((edit) => edit.deleted === true), true);

  const blank = adoptSvgPayload({ asset_id: "svg-b" }, payload({ asset_id: "svg-b", elements: [] }));
  assert.equal(blank.elements.length, 0);
  assert.equal(svgPlate({ asset_id: "svg-b", kind: "svg", width: 200, height: 100 }).kind, "editor");
});

test("单个元素最多 2000 个变化；超限时给出可读原因而不是删结构", () => {
  const elements = Array.from({ length: SVG_EDIT_MAX_CHANGES + 1 }, (_, index) => ({
    id: `p0c${index}`,
    d: "M0 0h1v1Z",
    fill: "#000000",
    bbox: [0, 0, 1, 1],
  }));
  const draft = createSvgDraft(parseSvgElements(payload({ elements })));
  for (const element of elements) draft.edits[element.id] = { dx: 1, dy: 0, deleted: false };
  const problem = validateSvgSave(draft);
  assert.match(problem, /2000/);
  assert.match(problem, /不会删除结构或降低质量/);
});

test("受控输出：只写白名单属性并转义，不插入原始 SVG；预览位移追加在累计变换后", () => {
  const element = {
    id: "p0c0",
    d: 'M0 0h10v10Z" onload="alert(1)',
    fill: '#fff" onmouseover="x',
    fillRule: "evenodd",
    transform: "translate(2,3)",
    bbox: [0, 0, 10, 10],
  };
  const markup = svgElementMarkup(element, { dx: 4, dy: -2, deleted: false }, true);
  assert.match(markup, /data-svg-element="p0c0"/);
  assert.match(markup, /class="wb-svg-edit__shape is-selected"/);
  assert.match(markup, /transform="translate\(6,1\)"/);
  assert.match(markup, /fill-rule="evenodd"/);
  assert.doesNotMatch(markup, /onload="/);
  assert.doesNotMatch(markup, /onmouseover="/);
  assert.equal(svgElementMarkup(element, { deleted: true }), "");
  const precise = svgElementMarkup({ ...element, transform: "translate(0.123456789123,3)" });
  assert.match(precise, /translate\(0\.123456789123,3\)/);
});

test("同一原始 path 且同变换的组件合并为一次填色；命中仍按组件独立", () => {
  const elements = [
    { id: "p0c0", d: "M0 0h10v10Z", fill: "#112233", fill_rule: "nonzero", transform: "translate(2,3)", bbox: [2, 3, 12, 13] },
    { id: "p0c1", d: "M20 0h10v10Z", fill: "#112233", fill_rule: "nonzero", transform: "translate(2,3)", bbox: [22, 3, 32, 13] },
    { id: "p1c0", d: "M40 0h10v10Z", fill: "#112233", fill_rule: "nonzero", transform: "translate(2,3)", bbox: [42, 3, 52, 13] },
  ];
  const draft = createSvgDraft(parseSvgElements(payload({ elements })));
  assert.equal(sourcePathKey(elements[0]), "p0");
  assert.equal(sourcePathKey(elements[2]), "p1");

  const draw = mergedDrawMarkup(draft);
  assert.equal((draw.match(/<path/g) || []).length, 2);
  assert.match(draw, /d="M0 0h10v10Z M20 0h10v10Z"/);
  assert.match(draw, /transform="translate\(2,3\)"/);

  const surface = svgSurfaceMarkup(draft);
  assert.equal((surface.match(/data-svg-draw/g) || []).length, 1);
  assert.equal((surface.match(/data-svg-element=/g) || []).length, 3);
  assert.equal((surface.match(/fill="transparent"/g) || []).length, 4);
  assert.match(surface, /wb-svg-edit__hit/);

  // 组件单独平移后必须从原组拆出，否则位置显示与实际保存不一致。
  applyTranslation(draft, ["p0c1"], 5, 0);
  const moved = mergedDrawMarkup(draft);
  assert.equal((moved.match(/<path/g) || []).length, 3);
  assert.match(moved, /transform="translate\(7,3\)"/);

  // 拖动预览用同一套合并逻辑：未提交也能准确显示拆分后的新位置。
  const preview = mergedDrawMarkup(draft, { p0c1: { dx: 8, dy: 0, deleted: false } });
  assert.equal((preview.match(/<path/g) || []).length, 3);
  assert.match(preview, /transform="translate\(10,3\)"/);
  assert.equal(hitComponentMarkup(elements[0], null, true).includes('data-svg-element="p0c0"'), true);
});

test("命中层保留 evenodd 填充语义：孔洞内部不会被当成可命中区域", () => {
  const hole = {
    id: "p2c0",
    d: "M0 0h20v20H0Z M5 5h10v10H5Z",
    fill: "#000000",
    fill_rule: "evenodd",
    transform: "translate(0,0)",
    bbox: [0, 0, 20, 20],
  };
  const parsed = parseSvgElements(payload({ elements: [hole] }));
  const hit = hitComponentMarkup(parsed.elements[0], null, false);
  assert.match(hit, /fill-rule="evenodd"/);
  assert.match(hit, /fill="transparent"/);
  assert.match(hit, /pointer-events="all"/);
  assert.match(hit, /data-svg-element="p2c0"/);

  const draft = createSvgDraft(parsed);
  const surface = svgSurfaceMarkup(draft);
  assert.match(surface, /data-svg-draw[^>]*pointer-events="none"/);
  assert.match(surface, /data-svg-hits/);
  assert.match(surface, /fill-rule="evenodd"/);
});

test("草稿按 SVG 资产隔离：编辑一张不会影响另一张", () => {
  const first = adoptSvgPayload({ asset_id: "svg-a" }, payload());
  const second = adoptSvgPayload({ asset_id: "svg-b" }, payload({ asset_id: "svg-b", elements: [] }));
  applyTranslation(first, ["p0c0"], 7, 0);
  assert.equal(changeCount(first), 1);
  assert.equal(changeCount(second), 0);
  assert.equal(draftFor("svg-b"), second);
  discardAllSvgDrafts();
  assert.equal(draftFor("svg-a"), null);
  assert.equal(currentSvgDraft(), null);
});

test("clientPointToSvg 使用 SVG 实际 CTM：200% 缩放与非正方形都准确", () => {
  const surface = {
    getScreenCTM: () => ({ inverse: () => ({ a: 0.5, b: 0, c: 0, d: 0.5, e: -50, f: -25 }) }),
    createSVGPoint: () => ({
      x: 0,
      y: 0,
      matrixTransform(matrix) {
        return { x: this.x * matrix.a + this.y * matrix.c + matrix.e, y: this.x * matrix.b + this.y * matrix.d + matrix.f };
      },
    }),
  };
  assert.deepEqual(clientPointToSvg(surface, 300, 225, 1000, 500), { x: 100, y: 87.5 });

  const fallback = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  // viewBox 1000×500 在 800×600 盒里按 meet 缩放 0.8，上下各留 100px。
  assert.deepEqual(clientPointToSvg(fallback, 400, 300, 1000, 500), { x: 500, y: 250 });
});

/* ------------------------------------------------------------------ 来源链与会话归属 */

test("来源链一次失败后可重试，不会被 sourceChecked 永久锁死", async () => {
  const current = { asset_id: "svg-current", kind: "svg", source_asset_id: "raster-1", width: 20, height: 10 };
  setSession({ imageId: "image-a", assets: [current], currentAssetId: current.asset_id });
  const originalAsset = http.asset;
  let calls = 0;
  http.asset = async (id) => {
    calls += 1;
    if (calls === 1) throw new Error("temporary");
    return { asset_id: id, kind: "lineart", width: 20, height: 10, coordinate_space_id: "space-a" };
  };
  try {
    await ensureAssetSourceChain(current);
    assert.equal(store.assetById("raster-1"), null);
    await ensureAssetSourceChain(current);
    assert.equal(store.assetById("raster-1")?.kind, "lineart");
    assert.equal(calls, 2);
  } finally {
    http.asset = originalAsset;
  }
});

test("来源链在切图后不把旧来源写进新会话", async () => {
  const current = { asset_id: "svg-old", kind: "svg", source_asset_id: "raster-old", width: 20, height: 10 };
  setSession({ imageId: "image-old", assets: [current], currentAssetId: current.asset_id });
  const originalAsset = http.asset;
  let resolveFetch;
  http.asset = () =>
    new Promise((resolve) => {
      resolveFetch = resolve;
    });
  try {
    const pending = ensureAssetSourceChain(current);
    await tick();
    store.resetSession();
    setSession({
      imageId: "image-new",
      assets: [{ asset_id: "svg-new", kind: "svg", width: 10, height: 10 }],
      currentAssetId: "svg-new",
    });
    resolveFetch({ asset_id: "raster-old", kind: "lineart", width: 20, height: 10 });
    await pending;
    assert.equal(store.assetById("raster-old"), null);
    assert.deepEqual(store.session.assets.map((asset) => asset.asset_id), ["svg-new"]);
  } finally {
    http.asset = originalAsset;
  }
});

test("同一资产在新会话会重新补齐来源链", async () => {
  const current = { asset_id: "svg-reopen", kind: "svg", source_asset_id: "raster-reopen", width: 20, height: 10 };
  setSession({ imageId: "image-a", assets: [current], currentAssetId: current.asset_id });
  const originalAsset = http.asset;
  let calls = 0;
  http.asset = async (id) => {
    calls += 1;
    return { asset_id: id, kind: "lineart", width: 20, height: 10 };
  };
  try {
    await ensureAssetSourceChain(current);
    assert.equal(calls, 1);
    store.resetSession();
    setSession({ imageId: "image-a", assets: [current], currentAssetId: current.asset_id });
    await ensureAssetSourceChain(current);
    assert.equal(calls, 2);
  } finally {
    http.asset = originalAsset;
  }
});

test("来源链不把别的原图资产并入当前会话", async () => {
  const current = { asset_id: "svg-cross", kind: "svg", source_asset_id: "raster-other", width: 20, height: 10 };
  setSession({ imageId: "image-a", assets: [current], currentAssetId: current.asset_id });
  const originalAsset = http.asset;
  http.asset = async (id) => ({
    asset_id: id,
    image_id: "image-b",
    kind: "lineart",
    width: 20,
    height: 10,
  });
  try {
    await ensureAssetSourceChain(current);
    assert.equal(store.assetById("raster-other"), null);
    assert.deepEqual(store.session.assets.map((asset) => asset.asset_id), ["svg-cross"]);
  } finally {
    http.asset = originalAsset;
  }
});

test("svg-elements 旧响应不会进新会话，也不会把旧图来源补进来", async () => {
  const oldAsset = { asset_id: "svg-old", kind: "svg", width: 20, height: 10, source_asset_id: "raster-old" };
  setSession({ imageId: "", assets: [oldAsset], currentAssetId: oldAsset.asset_id });
  const originalElements = http.svgElements;
  const originalAsset = http.asset;
  let resolveElements;
  http.svgElements = () =>
    new Promise((resolve) => {
      resolveElements = resolve;
    });
  http.asset = async () => {
    throw new Error("不应在旧响应中补来源");
  };
  try {
    ensureSvgDraft(oldAsset);
    await tick();
    store.resetSession();
    setSession({
      imageId: "image-new",
      assets: [{ asset_id: "svg-new", kind: "svg", width: 30, height: 10 }],
      currentAssetId: "svg-new",
    });
    resolveElements(payload({ asset_id: "svg-old" }));
    await tick();
    await tick();
    assert.equal(draftFor("svg-old"), null);
    assert.deepEqual(store.session.assets.map((asset) => asset.asset_id), ["svg-new"]);
  } finally {
    http.svgElements = originalElements;
    http.asset = originalAsset;
  }
});

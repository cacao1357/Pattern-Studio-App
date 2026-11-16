/* =============================================================================
   compare-overlay.test.mjs — 同坐标透明叠加的来源链行为。
   重点：保存后的 SVG 直接父级还是 SVG，必须继续沿 source_asset_id 找到最近光栅；
   裁切/缩放产生的新坐标空间不能拿原图铺满冒充对齐。
   ============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";

import { overlaySourceChain, pickOverlayReference, samePixelSize } from "../next-v2/js/compare.js";

const raster = (id, overrides = {}) => ({
  asset_id: id,
  kind: "lineart",
  width: 200,
  height: 100,
  coordinate_space_id: "space-a",
  ...overrides,
});

test("编辑后的 SVG 沿 source_asset_id 链找到最近光栅，而不是停在上一版 SVG", () => {
  const edited = {
    asset_id: "svg-v2",
    kind: "svg",
    width: 200,
    height: 100,
    coordinate_space_id: "space-a",
    source_asset_id: "svg-v1",
    parents: [{ asset_id: "svg-v1", role: "svg_edit_source" }],
  };
  const previous = {
    asset_id: "svg-v1",
    kind: "svg",
    width: 200,
    height: 100,
    coordinate_space_id: "space-a",
    source_asset_id: "png-base",
  };
  const base = raster("png-base");
  const pair = pickOverlayReference(edited, [edited, previous, base]);
  assert.equal(pair.ok, true);
  assert.equal(pair.reference.asset_id, "png-base");
  assert.equal(pair.depth, 2);
  assert.equal(pair.spaceUnverified, false);

  const chain = overlaySourceChain(edited, [edited, previous, base]);
  assert.deepEqual(chain.map((entry) => entry.id), ["svg-v1", "png-base"]);
});

test("直接 vector_input 光栅立即可叠加，优先于更早的原图", () => {
  const svg = {
    asset_id: "svg-1",
    kind: "svg",
    width: 200,
    height: 100,
    coordinate_space_id: "space-a",
    parents: [
      { asset_id: "png-1", role: "vector_input" },
      { asset_id: "original-1", role: "original" },
    ],
  };
  const png = raster("png-1");
  const original = { asset_id: "original-1", kind: "original", width: 200, height: 100, coordinate_space_id: "space-a" };
  const pair = pickOverlayReference(svg, [svg, png, original]);
  assert.equal(pair.ok, true);
  assert.equal(pair.reference.asset_id, "png-1");
  assert.equal(pair.depth, 1);
});

test("裁切后的新坐标空间拒绝叠加，并说明原因", () => {
  const cropped = {
    asset_id: "crop-1",
    kind: "cropped",
    width: 120,
    height: 80,
    coordinate_space_id: "space-crop",
    source_asset_id: "normalized-1",
  };
  const normalized = {
    asset_id: "normalized-1",
    kind: "normalized_input",
    width: 600,
    height: 400,
    coordinate_space_id: "space-source",
  };
  const pair = pickOverlayReference(cropped, [cropped, normalized]);
  assert.equal(pair.ok, false);
  assert.match(pair.reason, /尺寸不同|坐标空间不同/);
});

test("尺寸相同但坐标空间不同的来源也拒绝叠加", () => {
  const base = raster("png-base", { width: 200, height: 100 });
  const current = {
    asset_id: "png-shifted",
    kind: "working_copy",
    width: 200,
    height: 100,
    coordinate_space_id: "space-resized",
    source_asset_id: "png-base",
  };
  const pair = pickOverlayReference(current, [current, base]);
  assert.equal(pair.ok, false);
  assert.match(pair.reason, /坐标空间不同/);
});

test("来源链中断时明确提示，不退回其它坐标空间的原图", () => {
  const edited = {
    asset_id: "svg-v2",
    kind: "svg",
    width: 200,
    height: 100,
    coordinate_space_id: "space-a",
    source_asset_id: "svg-v1",
  };
  const original = { asset_id: "original-1", kind: "original", width: 200, height: 100, coordinate_space_id: "space-a" };
  const pair = pickOverlayReference(edited, [edited, original], { original });
  assert.equal(pair.ok, false);
  assert.match(pair.reason, /不在当前工作台/);
  assert.equal(pair.reference, null);
});

test("同尺寸判断只比较真实像素，不把缺失尺寸当成对齐", () => {
  assert.equal(samePixelSize({ width: 200, height: 100 }, { width: 200, height: 100 }), true);
  assert.equal(samePixelSize({ width: 200, height: 100 }, { width: 100, height: 200 }), false);
  assert.equal(samePixelSize({ width: 0, height: 0 }, { width: 0, height: 0 }), false);
  assert.equal(samePixelSize({ width: 512, height: 512 }, { width: 512 }), false);
});

test("坐标空间未记录时只按尺寸核对，并在结果里标记未核验", () => {
  const current = { asset_id: "current", kind: "transparent_png", width: 200, height: 100, source_asset_id: "base" };
  const base = { asset_id: "base", kind: "lineart", width: 200, height: 100 };
  const pair = pickOverlayReference(current, [current, base]);
  assert.equal(pair.ok, true);
  assert.equal(pair.spaceUnverified, true);
});

/* =============================================================================
   workbench-svg-guidance.test.mjs — 本地修复条件引导与轮廓模式提示的纯行为回归。
   只测用户能看到的原因文本与状态，不绑定具体 HTML 结构。
   ============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLeftRefillPayload,
  leftRefillConditions,
  matchingDamageMasks,
  repairConditionSummary,
  vectorModeCaveat,
} from "../next-v2/js/views/workbench.js";
import { jobKindLabel, stageForJobKind } from "../next-v2/js/format.js";

const target = {
  asset_id: "in-512",
  kind: "cropped",
  width: 512,
  height: 512,
  coordinate_space_id: "space-a",
  parents: [{ asset_id: "mask-parent", role: "damage_mask" }],
};
const reference = { asset_id: "ref-1", kind: "cropped", width: 512, height: 512 };
const box = { left: 10, top: 20, width: 100, height: 80 };

function conditions(overrides = {}) {
  return leftRefillConditions({
    capability: { available: true },
    input: { asset: target, error: "" },
    referenceId: "ref-1",
    references: [reference],
    box,
    inputAsset: target,
    assets: [target, reference],
    ...overrides,
  });
}

test("本地修复条件全部满足时给出明确通过项", () => {
  const rows = conditions();
  const states = Object.fromEntries(rows.map((row) => [row.key, row.state]));
  assert.equal(states.capability, "ok");
  assert.equal(states.target, "ok");
  assert.equal(states.reference, "ok");
  assert.equal(states.box, "ok");
  assert.equal(states.damage_mask, "info");
  assert.equal(repairConditionSummary(rows), "条件已满足；可以提交本地修复。");
  assert.match(rows.find((row) => row.key === "reference").detail, /1,048,576|512 × 512/);
});

test("目标尺寸不符时说明实际尺寸与不会自动缩放", () => {
  const rows = conditions({
    input: { asset: null, error: "size", width: 1024, height: 768 },
    inputAsset: null,
  });
  const targetRow = rows.find((row) => row.key === "target");
  assert.equal(targetRow.state, "blocked");
  assert.match(targetRow.detail, /1024 × 768/);
  assert.match(targetRow.detail, /不会自动缩放/);
  assert.match(repairConditionSummary(rows), /必要条件/);
});

test("参考图缺失或已失效时分别说明原因", () => {
  const missing = conditions({ referenceId: "" }).find((row) => row.key === "reference");
  assert.equal(missing.state, "blocked");
  assert.match(missing.detail, /必须显式选择/);

  const stale = conditions({ referenceId: "gone", references: [reference] }).find(
    (row) => row.key === "reference"
  );
  assert.equal(stale.state, "blocked");
  assert.match(stale.detail, /已不在当前工作台|超过/);
});

test("修复框越界只警告并说明会裁剪，不谎称条件全部满足", () => {
  const rows = conditions({ box: { left: 500, top: 500, width: 100, height: 100 } });
  const boxRow = rows.find((row) => row.key === "box");
  assert.equal(boxRow.state, "warn");
  assert.match(boxRow.detail, /裁剪/);
  assert.match(repairConditionSummary(rows), /需要留意/);
});

test("损伤蒙版提示与实际请求一致：有记录也不自动选用，仍按修复框推断", () => {
  const sameSpace = { asset_id: "mask-1", kind: "damage_mask", width: 512, height: 512, coordinate_space_id: "space-a" };
  const ok = conditions({ assets: [target, reference, sameSpace] }).find((row) => row.key === "damage_mask");
  assert.equal(ok.state, "info");
  assert.match(ok.detail, /不会自动选用/);
  assert.doesNotMatch(ok.detail, /优先使用.*蒙版/);
  const request = buildLeftRefillPayload(target.asset_id, box, { width: 512, height: 512 }, { repairReferenceId: reference.asset_id });
  assert.equal(Object.hasOwn(request, "damage_mask_asset_id"), false);

  const otherSpace = { asset_id: "mask-2", kind: "damage_mask", width: 512, height: 512, coordinate_space_id: "space-b" };
  const info = conditions({ assets: [target, reference, otherSpace] }).find((row) => row.key === "damage_mask");
  assert.equal(info.state, "info");
  assert.match(info.detail, /按修复框/);
});

test("matchingDamageMasks 同时识别 parent 登记与同坐标空间", () => {
  const parentMask = { asset_id: "mask-parent", kind: "damage_mask", coordinate_space_id: "space-x" };
  const sameSpace = { asset_id: "mask-space", kind: "damage_mask", coordinate_space_id: "space-a" };
  const other = { asset_id: "mask-other", kind: "damage_mask", coordinate_space_id: "space-b" };
  const matches = matchingDamageMasks([parentMask, sameSpace, other], target);
  assert.deepEqual(matches.map((asset) => asset.asset_id), ["mask-parent", "mask-space"]);
});

test("轮廓模式提示保留微小细节的可选操作", () => {
  const caveat = vectorModeCaveat("contour");
  assert.match(caveat, /微小孔洞|微小/);
  assert.match(caveat, /彩色模式/);
  assert.equal(vectorModeCaveat("color"), "");
  assert.equal(vectorModeCaveat("monochrome"), "");
});

test("edit-svg 任务归到 07 矢量化，不会落到其它工序分组", () => {
  assert.equal(stageForJobKind("edit-svg"), 7);
  assert.equal(jobKindLabel("edit-svg"), "SVG 图形编辑");
});

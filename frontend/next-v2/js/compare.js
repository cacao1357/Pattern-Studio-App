/* =============================================================================
   compare.js — 对照与透明叠加的来源选择。
   只做一件事：为当前资产找一张“直接同坐标”的光栅来源，供叠加核对。
   约定（docs/svg-editing-contract.md）：
   - 优先核对当前结果与直接同坐标的光栅来源，而不是把裁切/缩放后的原图铺满图版；
   - 尺寸不同或坐标空间不同时明确拒绝叠加，并在界面说明原因；
   - 这里只做纯数据判断，不读 DOM、不发请求，便于行为测试。
   ============================================================================= */

import { kindLabel } from "./format.js";

/** 可作为叠加底图的光栅资产类型；SVG / ZIP / 蒙版等不能直接作为像素底图。 */
const RASTER_KINDS = new Set([
  "original",
  "normalized_input",
  "cropped",
  "working_copy",
  "prepared",
  "enhanced",
  "transparent_png",
  "lineart",
  "contour_line_art",
  "composed_candidate",
  "accepted_repair",
  "repair_composite",
  "repair_candidate",
  "edit_candidate",
  "generated_basemap",
  "generated_layer",
  "placed_generated_layer",
  "ai_layer",
]);

/**
 * 直接来源角色优先级：先找生成当前资产的输入，再找同坐标参考。
 * 这些 role 来自现有后端资产登记（见 assets.parents）；未知 role 不参与。
 */
const SOURCE_ROLES = [
  "vector_input",
  "svg_edit_source",
  "lineart_rgb",
  "source_rgb",
  "accepted_repair_version",
  "local_composite",
  "full_ai_candidate",
  "basemap_coordinate_reference",
  "original_input_reference",
  "selected_version",
  "original",
];

const dims = (asset) => [Number(asset?.width) || 0, Number(asset?.height) || 0];
const sameDims = (a, b) => {
  const [aw, ah] = dims(a);
  const [bw, bh] = dims(b);
  return Boolean(aw && ah && bw && bh && aw === bw && ah === bh);
};
const spaceOf = (asset) => String(asset?.coordinate_space_id || "");
const shortId = (value) => {
  const text = String(value || "");
  return text.length > 8 ? text.slice(0, 8) : text;
};

/** 按优先顺序收集当前资产可能的光栅来源 id，去重且排除自身。 */
export function overlaySourceIds(current) {
  if (!current?.asset_id) return [];
  const ids = [];
  const push = (value) => {
    const id = String(value || "").trim();
    if (id && id !== current.asset_id && !ids.includes(id)) ids.push(id);
  };
  push(current.source_asset_id);
  const parents = Array.isArray(current.parents) ? current.parents : [];
  for (const role of SOURCE_ROLES) {
    for (const parent of parents) {
      if (parent && parent.role === role) push(parent.asset_id);
    }
  }
  push(current.source_rgb_asset_id);
  return ids;
}

/**
 * 沿同坐标来源链做广度优先遍历。保存的 SVG 新版本的 source_asset_id 指向前一 SVG，
 * 编辑链上可能连续多个 SVG；只有继续往前才能找到真正可叠加的光栅底图。
 * 只沿尺寸一致、坐标空间一致（或都未记录）的来源继续，避免跨裁切/缩放分支。
 */
export function overlaySourceChain(current, assets, image = null) {
  const pool = new Map();
  for (const asset of [...(Array.isArray(assets) ? assets : []), image?.original, image?.normalized]) {
    if (asset?.asset_id && !pool.has(asset.asset_id)) pool.set(asset.asset_id, asset);
  }
  const chain = [];
  if (!current?.asset_id) return chain;
  const seen = new Set([current.asset_id]);
  const queue = [{ asset: current, depth: 0 }];
  while (queue.length) {
    const { asset, depth } = queue.shift();
    if (depth >= 8) continue;
    for (const id of overlaySourceIds(asset)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const next = pool.get(id) || null;
      chain.push({ id, asset: next, depth: depth + 1 });
      if (!next) continue;
      // 只有同尺寸/同坐标的来源才继续沿链前进；否则就是另一条裁切或缩放分支。
      if (!sameDims(next, current)) continue;
      const currentSpace = spaceOf(current);
      const nextSpace = spaceOf(next);
      if (currentSpace && nextSpace && currentSpace !== nextSpace) continue;
      queue.push({ asset: next, depth: depth + 1 });
    }
  }
  return chain;
}

/**
 * 为当前资产挑选可叠加的直接光栅来源。
 * 会沿 svg_edit_source / source_asset_id 链找到最近的光栅图，而不是只看直接父级。
 * @param {object|null} current 当前资产
 * @param {object[]} assets 会话资产
 * @param {object|null} image 原图记录（含 original / normalized）
 * @returns {{ok:boolean, reference:object|null, reason:string, space:string, spaceUnverified:boolean, near:object|null, depth:number}}
 */
export function pickOverlayReference(current, assets, image = null) {
  const result = {
    ok: false,
    reference: null,
    reason: "",
    space: spaceOf(current),
    spaceUnverified: false,
    near: null,
    depth: 0,
  };
  if (!current?.asset_id) {
    result.reason = "还没有打开资产，无法叠加核对。";
    return result;
  }
  const chain = overlaySourceChain(current, assets, image);
  if (!chain.length) {
    result.reason = "当前资产没有登记直接来源；未找到可叠加的同坐标光栅图。";
    return result;
  }

  const problems = [];
  for (const entry of chain) {
    const reference = entry.asset;
    if (!reference) {
      problems.push(`来源链上的 #${shortId(entry.id)} 不在当前工作台，无法继续核对。`);
      continue;
    }
    if (!RASTER_KINDS.has(String(reference.kind || ""))) {
      // 编辑链上的上一版 SVG 不是底图，但它的来源会继续参与遍历；其它非光栅类型才记录原因。
      if (String(reference.kind || "") !== "svg") {
        problems.push(`直接来源「${kindLabel(reference.kind) || "未知类型"}」不是可叠加的光栅图。`);
      }
      result.near = result.near || reference;
      continue;
    }
    result.near = result.near || reference;
    if (!sameDims(reference, current)) {
      const [rw, rh] = dims(reference);
      const [cw, ch] = dims(current);
      problems.push(
        `同坐标链上的光栅来源 ${rw || "?"} × ${rh || "?"} 与当前资产 ${cw || "?"} × ${
          ch || "?"
        } 尺寸不同（可能经过裁切或缩放），不能按同坐标叠加。`
      );
      continue;
    }
    const currentSpace = spaceOf(current);
    const referenceSpace = spaceOf(reference);
    if (currentSpace && referenceSpace && currentSpace !== referenceSpace) {
      problems.push("同坐标链上的光栅来源与当前资产的坐标空间不同（裁切或工作副本会建立新坐标空间），不能按同坐标叠加。");
      continue;
    }
    result.ok = true;
    result.reference = reference;
    result.reason = "";
    result.space = currentSpace || referenceSpace;
    result.spaceUnverified = !currentSpace || !referenceSpace;
    result.depth = entry.depth;
    return result;
  }

  result.reason =
    problems[0] ||
    "沿同坐标来源链没有找到可叠加的光栅图（编辑前的 SVG 仍在链上，但没有可用的光栅底图）。";
  return result;
}

/** 两图是否同尺寸；供对照文案判断“仅预览、不代表同坐标对齐”。 */
export function samePixelSize(a, b) {
  return sameDims(a, b);
}

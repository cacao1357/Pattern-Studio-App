/* =============================================================================
   data.js — 静态工序定义（编号、名称、标题、说明）。
   页面数据全部来自本机服务 /api/v1（见 js/api.js 与 js/store.js），这里不再放演示数据。

   工序按实际处理依赖排列（2026-11-13）：
   来源 → 裁切 → 修复（可跳过）→ 候选 → 处理（本地/云端线稿）→ 蒙版 → 矢量化 → 平铺/导出。
   修复必须在生成线稿之前；蒙版修正之后再矢量化；矢量化不再和提取合并；平铺与导出留在最后。
   ============================================================================= */

export const STAGES = [
  {
    n: "01",
    key: "source",
    name: "来源",
    title: "放入纹样",
    note: "原图与规范输入各留一份",
    desc: "上传后另存一份规范输入；同时记录清晰度、评级与来源信息。",
  },
  {
    n: "02",
    key: "crop",
    name: "裁切",
    title: "框定纹样",
    note: "坐标使用输入资产真实像素",
    desc: "拖拽框选或直接填写像素坐标；超出像素上限时先创建工作副本。",
  },
  {
    n: "03",
    key: "repair",
    name: "修复",
    title: "局部修复",
    note: "可跳过；完整纹样直接下一步",
    desc: "圈出问题区域，确认后调用云端生成修复候选；纹样完整时可以明确跳过，不产生调用。",
  },
  {
    n: "04",
    key: "candidate",
    name: "候选",
    title: "选候选层",
    note: "按提示词拆分（可选）",
    desc: "云端按提示词拆分图层，勾选后合成一张候选；这一步不生成线稿。",
  },
  {
    n: "05",
    key: "process",
    name: "处理",
    title: "生成线稿",
    note: "本地模型 / 云端模型",
    desc: "明确选择本地模型或云端模型生成线稿 PNG；也可以改用 OpenCV 线稿或颜色提取。",
  },
  {
    n: "06",
    key: "mask",
    name: "蒙版",
    title: "修正前景",
    note: "只改透明 PNG",
    desc: "画笔补前景、擦除杂点；提交后生成新 PNG，修正完成后再进入矢量化。",
  },
  {
    n: "07",
    key: "vector",
    name: "矢量化",
    title: "转成矢量",
    note: "PNG → SVG",
    desc: "把线稿或透明 PNG 转成可编辑 SVG；颜色与细节参数在这一步调整。",
  },
  {
    n: "08",
    key: "tile",
    name: "平铺",
    title: "检查接缝",
    note: "2×2 / 3×3 与导出",
    desc: "选单元与规格生成平铺排列，接缝观察写入资产元数据，成果可打包成 ZIP。",
  },
];

/**
 * 旧深链（stage=1..7）到新工序号的兼容映射。
 * 3 处理 → 5 处理；5 蒙版 → 6 蒙版；6 修复 → 3 修复；7 平铺 → 8 平铺。
 * 新链接由 app.js 的 api.go 自动带上 v=2，因此不会再被当作旧编号。
 */
export const LEGACY_STAGE_ALIAS = { 3: 5, 5: 6, 6: 3, 7: 8 };

/** 解析 URL 里的 stage 参数；version 为 "2" 时按新编号，否则先按旧深链映射。 */
export function resolveStage(raw, version = "") {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 0;
  const mapped = version === "2" ? parsed : LEGACY_STAGE_ALIAS[parsed] || parsed;
  return mapped >= 1 && mapped <= STAGES.length ? mapped : 0;
}

/* =============================================================================
   samples.js — 八道工序的样例图。
   首页的工序卡与「八道工序导览」共用同一套样例（assets/demo 里的缠枝莲团花）：
   同一张纹样从原图一路走到无缝平铺，每一步都有一张能看懂的图。
   样例只是演示素材：不读用户数据、不发请求；纹样一律放在纸本图版上。
   ============================================================================= */

export const STAGE_SAMPLES = {
  source: {
    src: "assets/demo/lotus-original.svg",
    alt: "样例：一整幅团花原图",
  },
  crop: {
    src: "assets/demo/lotus-crop.svg",
    alt: "样例：框选后只留框内区域，原图仍然不动",
  },
  repair: {
    src: "assets/demo/lotus-repair.svg",
    alt: "样例：圈出局部做修复，框外不动；完整纹样可跳过",
  },
  candidate: {
    src: "assets/demo/lotus-candidate-3.svg",
    alt: "样例：按提示词拆出的候选层，不是线稿",
  },
  process: {
    src: "assets/demo/lotus-line.svg",
    alt: "样例：本地或云端模型生成线稿 PNG",
  },
  mask: {
    src: "assets/demo/lotus-mask.svg",
    alt: "样例：只留前景的透明蒙版",
  },
  vector: {
    src: "assets/demo/lotus-vector.svg",
    alt: "样例：蒙版修正后再矢量化得到的可编辑 SVG",
  },
  tile: {
    src: "assets/demo/lotus-seamless.svg",
    alt: "样例：平铺后检查接缝",
  },
};

/** 取一道工序的样例图；工序未知时回落到「来源」，卡片永远有图。 */
export function sampleFor(stage) {
  return STAGE_SAMPLES[stage?.key] || STAGE_SAMPLES.source;
}

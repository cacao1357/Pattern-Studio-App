/* =============================================================================
   motifs.js — 程序化生成的装饰纹样（纯 SVG，无外部资源）。
   这些不是真实素材，只用于新版前端的视觉演示；真实素材仍在 assets/demo/。
   ============================================================================= */

const TAU = Math.PI * 2;

/** 一片对称花瓣：从内半径到外半径，宽度控制张角 */
function petal(cx, cy, { inner, outer, width, waist = 0.55 }) {
  const tip = outer;
  const base = inner;
  const span = outer - inner;
  return [
    `M ${cx} ${cy - base}`,
    `C ${cx + width * waist} ${cy - (base + span * 0.28)}, ${cx + width} ${cy - (base + span * 0.62)}, ${cx} ${cy - tip}`,
    `C ${cx - width} ${cy - (base + span * 0.62)}, ${cx - width * waist} ${cy - (base + span * 0.28)}, ${cx} ${cy - base}`,
  ].join(" ");
}

/**
 * 团花线稿：刻度环 + 连续卷草 + 八瓣主花 + 十二瓣心花 + 八芒星。
 * @returns {string} 内联 SVG
 */
export function medallion() {
  const size = 600;
  const c = size / 2;
  const petals8 = Array.from({ length: 8 }, (_, i) => i * 45);
  const petals16 = Array.from({ length: 16 }, (_, i) => i * 22.5 + 11.25);
  const ticks = Array.from({ length: 72 }, (_, i) => i * 5);
  const rosette = Array.from({ length: 12 }, (_, i) => i * 30);
  const curls = Array.from({ length: 8 }, (_, i) => i * 45 + 22.5);

  const parts = [];
  parts.push(`
    <g class="medallion__frame">
      <circle cx="${c}" cy="${c}" r="286" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".55"/>
      <circle cx="${c}" cy="${c}" r="258" fill="none" stroke="currentColor" stroke-width="1" opacity=".38"/>
      <circle cx="${c}" cy="${c}" r="236" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <circle cx="${c}" cy="${c}" r="118" fill="none" stroke="currentColor" stroke-width="1.3"/>
      <circle cx="${c}" cy="${c}" r="70" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".7"/>
    </g>
  `);

  parts.push(
    ticks
      .map((a) => {
        const long = a % 15 === 0;
        const r1 = long ? 266 : 271;
        return `<line x1="${c}" y1="${c - r1}" x2="${c}" y2="${c - (r1 + (long ? 12 : 7))}" transform="rotate(${a} ${c} ${c})" stroke="currentColor" stroke-width="${long ? 1.2 : 0.8}" opacity="${long ? 0.75 : 0.35}"/>`;
      })
      .join("")
  );

  parts.push(
    petals8
      .map((a) => {
        const outer = `<path d="${petal(c, c, { inner: 96, outer: 246, width: 58 })}" transform="rotate(${a} ${c} ${c})" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
        const vein = `<path d="M ${c} ${c - 100} L ${c} ${c - 238}" transform="rotate(${a} ${c} ${c})" stroke="currentColor" stroke-width="0.8" opacity=".5"/>`;
        return outer + vein;
      })
      .join("")
  );

  parts.push(
    petals16
      .map(
        (a) =>
          `<path d="${petal(c, c, { inner: 122, outer: 222, width: 20 })}" transform="rotate(${a} ${c} ${c})" fill="none" stroke="currentColor" stroke-width="1" opacity=".65"/>`
      )
      .join("")
  );

  // 连续卷草：每个主瓣之间一段双钩弧线 + 小卷头
  parts.push(
    curls
      .map((a) => {
        const d = `M ${c} ${c - 236} A 60 60 0 0 1 ${c} ${c - 118}`;
        const curl = `M ${c} ${c - 236} c 26 6 40 22 34 40 c -5 16 -26 18 -34 6 c -7 -10 1 -22 12 -22`;
        return `<path d="${d}" transform="rotate(${a} ${c} ${c})" fill="none" stroke="currentColor" stroke-width="0.9" opacity=".4"/>
                <path d="${curl}" transform="rotate(${a} ${c} ${c})" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".8"/>`;
      })
      .join("")
  );

  // 心花：十二瓣 + 八芒星
  parts.push(
    rosette
      .map(
        (a) =>
          `<path d="${petal(c, c, { inner: 26, outer: 108, width: 16, waist: 0.5 })}" transform="rotate(${a} ${c} ${c})" fill="none" stroke="currentColor" stroke-width="1.2" class="medallion__accent"/>`
      )
      .join("")
  );

  parts.push(
    Array.from({ length: 8 }, (_, i) => i * 45)
      .map((a) => {
        const r = 62;
        return `<path d="M ${c} ${c - 18} L ${c + 9} ${c - 9} L ${c + 18} ${c} L ${c + 9} ${c + 9} L ${c} ${c + 18} L ${c - 9} ${c + 9} L ${c - 18} ${c} L ${c - 9} ${c - 9} Z" transform="rotate(${a + 22.5} ${c} ${c})" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".9"/>`;
      })
      .join("")
  );

  parts.push(`<circle cx="${c}" cy="${c}" r="20" fill="none" stroke="currentColor" stroke-width="1.4"/>
              <circle cx="${c}" cy="${c}" r="5" fill="currentColor" class="medallion__seal"/>`);

  return `<svg class="medallion" viewBox="0 0 ${size} ${size}" role="img" aria-label="缠枝团花线稿示意" fill="none">
    <g class="medallion__ink">${parts.join("")}</g>
  </svg>`;
}

/** 大号背景纹样：只保留外圈与主瓣，用作首屏背后的暗纹 */
export function medallionGhost() {
  const size = 900;
  const c = size / 2;
  const petals = Array.from({ length: 12 }, (_, i) => i * 30);
  return `<svg class="medallion-ghost" viewBox="0 0 ${size} ${size}" aria-hidden="true" fill="none">
    <circle cx="${c}" cy="${c}" r="430" stroke="currentColor" stroke-width="1"/>
    <circle cx="${c}" cy="${c}" r="380" stroke="currentColor" stroke-width="0.8" opacity=".6"/>
    ${petals
      .map(
        (a) =>
          `<path d="${petal(c, c, { inner: 120, outer: 372, width: 70 })}" transform="rotate(${a} ${c} ${c})" stroke="currentColor" stroke-width="0.9"/>`
      )
      .join("")}
    ${Array.from({ length: 36 }, (_, i) => i * 10)
      .map(
        (a) =>
          `<line x1="${c}" y1="${c - 392}" x2="${c}" y2="${c - 430}" transform="rotate(${a} ${c} ${c})" stroke="currentColor" stroke-width="0.7"/>`
      )
      .join("")}
  </svg>`;
}

/** 小尺寸回纹边饰（用于分隔条、装饰线） */
export function meanderStrip({ repeat = 12 } = {}) {
  const unit = 32;
  const width = repeat * unit;
  const path = Array.from({ length: repeat }, (_, i) => {
    const x = i * unit;
    return `M ${x + 4} 22 h 24 v -14 h -16 v 8 h 8`;
  }).join(" ");
  return `<svg class="meander-strip" viewBox="0 0 ${width} 28" preserveAspectRatio="none" aria-hidden="true" fill="none">
    <path d="${path}" stroke="currentColor" stroke-width="1.2"/>
  </svg>`;
}

const INKS = ["#1b2b54", "#33406b", "#4f587b", "#838aa6", "#bfc2ce"];

export interface ThumbProps {
  seed: number;
  big?: boolean;
}

/**
 * 抽象纹样占位缩略图：内联 SVG，不引用真实素材。
 * 与 prototype/index.html 中的 thumbSvg 保持一致。
 */
export default function Thumb({ seed, big = false }: ThumbProps) {
  const c1 = INKS[seed % INKS.length];
  const c2 = INKS[(seed + 2) % INKS.length];
  const r = 10 + ((seed * 7) % 14);
  const cx = 40 + ((seed * 13) % 40);
  const cy = 34 + ((seed * 11) % 36);
  const motifs = [
    <path key="m0" d="M80 24 L112 56 L80 88 L48 56 Z" fill="none" stroke={c1} strokeWidth="2.5" />,
    <circle key="m1" cx={cx + 20} cy={cy + 14} r={r} fill="none" stroke={c2} strokeWidth="2" />,
    <path key="m2" d={`M32 ${88 - seed * 3} Q 80 ${56 + seed * 4} 128 ${88 - seed * 3}`} fill="none" stroke={c2} strokeWidth="2" />,
    <path key="m3" d="M80 40 L96 56 L80 72 L64 56 Z" fill="none" stroke={c2} strokeWidth="1.6" />,
    <circle key="m4" cx={36 + seed * 6} cy={30 + seed * 4} r="3" fill={c1} />
  ];
  const count = big ? motifs.length : 2 + (seed % (motifs.length - 1));
  return (
    <svg viewBox="0 0 160 120" className="block w-full h-full" role="img" aria-label={`抽象纹样占位图 ${seed}`}>
      {motifs.slice(0, count)}
    </svg>
  );
}

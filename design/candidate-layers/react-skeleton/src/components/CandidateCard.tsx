import type { CandidateLayer } from "../types";
import { WARNING_LABELS } from "../data/mock";
import Icon from "./Icon";
import Thumb from "./Thumb";

export interface CandidateCardProps {
  candidate: CandidateLayer;
  selected: boolean;
  onToggle: (id: string) => void;
}

export default function CandidateCard({ candidate, selected, onToggle }: CandidateCardProps) {
  const c = candidate;
  const warn = c.warnings.length > 0;
  const warningText = c.warnings.map((w) => WARNING_LABELS[w] || w).join("；");
  return (
    <article
      className={`border transition-colors duration-[120ms] ${
        selected ? "border-ink border-l-[3px] bg-paper-2" : "border-ink-25 bg-paper-hi"
      }`}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${selected ? "取消选择" : "选择"}候选图层 ${c.zIndex}（${c.label}）`}
        onClick={() => onToggle(c.id)}
        className={`relative block w-full aspect-[4/3] checker border-b text-left ${selected ? "border-ink" : "border-ink-25"}`}
      >
        <Thumb seed={c.zIndex} />
        <span className="absolute left-0 bottom-0 px-[3px] bg-ink text-paper text-[10px] leading-[13px]">AI 候选</span>
        <span className="absolute right-0 bottom-0 px-[3px] bg-ink text-paper text-[10px] leading-[13px] tabular-nums">层级 {c.zIndex}</span>
        <span
          className={`absolute top-1 right-1 w-[15px] h-[15px] inline-flex items-center justify-center border ${
            selected ? "border-ink bg-ink text-paper" : "border-ink bg-paper-hi text-transparent"
          }`}
          aria-hidden="true"
        >
          <Icon name="check" className="w-3 h-3" />
        </span>
      </button>
      <div className="px-2 py-[6px]">
        <div className="flex items-baseline justify-between gap-1 min-w-0">
          <strong className="text-[13px] font-medium truncate">{c.zIndex} · {c.label}</strong>
        </div>
        <p className="text-[11px] text-ink-60 tabular-nums leading-[1.5]">
          {c.width} × {c.height} · 面积 {Math.round(c.areaRatio * 100)}% · 置信 {c.confidence.toFixed(2)}
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {c.aiInferred && (
            <span className="inline-flex items-center h-[17px] px-[5px] border border-ink text-[11px] text-ink">AI 生成</span>
          )}
          {!c.geometryVerified && (
            <span className="inline-flex items-center h-[17px] px-[5px] border border-dashed border-ink-40 text-[11px] text-ink-60">几何未核验</span>
          )}
          {warn && (
            <span className="inline-flex items-center h-[17px] px-[5px] border border-ink border-l-2 bg-paper-2 text-[11px] text-ink font-medium" title={warningText}>
              候选存疑
            </span>
          )}
        </div>
        {warn && <p className="mt-1 pl-[6px] border-l-[3px] border-ink text-[11px] leading-[1.5] text-ink">{warningText}</p>}
      </div>
    </article>
  );
}

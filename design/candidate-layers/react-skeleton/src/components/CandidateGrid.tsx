import type { CandidateLayer } from "../types";
import CandidateCard from "./CandidateCard";

export interface CandidateGridProps {
  candidates: CandidateLayer[];
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
}

export default function CandidateGrid({ candidates, selectedIds, onToggle }: CandidateGridProps) {
  if (candidates.length === 0) {
    return <p className="px-1 py-3 text-[12px] text-ink-60">当前筛选下没有候选图层。</p>;
  }
  return (
    <div className="grid grid-cols-1 wide:grid-cols-2 gap-2" role="group" aria-label="AI 候选图层">
      {candidates.map((c) => (
        <CandidateCard key={c.id} candidate={c} selected={selectedIds.has(c.id)} onToggle={onToggle} />
      ))}
    </div>
  );
}

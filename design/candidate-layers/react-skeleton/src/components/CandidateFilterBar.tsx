import type { FilterMode } from "../types";

export interface CandidateFilterBarProps {
  filter: FilterMode;
  counts: Record<FilterMode, number>;
  onChange: (filter: FilterMode) => void;
}

const ITEMS: Array<{ key: FilterMode; label: string }> = [
  { key: "all", label: "全部" },
  { key: "selected", label: "已选" },
  { key: "review", label: "待复核" }
];

export default function CandidateFilterBar({ filter, counts, onChange }: CandidateFilterBarProps) {
  return (
    <div className="flex border border-ink-25 bg-paper-hi" role="group" aria-label="筛选候选图层">
      {ITEMS.map((item, i) => {
        const active = filter === item.key;
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={active}
            aria-label={`筛选：${item.label}`}
            onClick={() => onChange(item.key)}
            className={`flex-1 min-h-[30px] px-1 text-[12px] tracking-wide transition-colors duration-[120ms] ${i > 0 ? "border-l border-ink-25" : ""} ${
              active ? "bg-ink text-paper" : "text-ink-60 hover:text-ink hover:bg-paper-2"
            }`}
          >
            {item.label} <span className="tabular-nums">{counts[item.key]}</span>
          </button>
        );
      })}
    </div>
  );
}

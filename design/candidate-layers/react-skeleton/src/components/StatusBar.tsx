import type { PageState } from "../types";
import { STATUS_META } from "../data/mock";

export interface StatusBarProps {
  state: PageState;
  selectedZ: number[];
}

export default function StatusBar({ state, selectedZ }: StatusBarProps) {
  const meta = STATUS_META[state];
  let line = meta.line;
  if (state === "ready" || state === "selected") {
    line = selectedZ.length ? `已选 ${selectedZ.length} 层（${selectedZ.join("、")}）· 可合成` : "5 个候选图层 · 尚未选择";
  }
  return (
    <footer className="h-[37px] flex-none flex items-center gap-[10px] px-4 border-t border-ink bg-paper-2" aria-label="当前任务状态">
      <span className="flex-none text-[12px] tracking-widest text-ink-60">任务</span>
      <span className={`inline-flex items-center h-[20px] px-[7px] border text-[12px] tracking-wider ${meta.pillCls}`} role="status" aria-live="polite">
        {meta.badge}
      </span>
      <p className="min-w-0 flex-1 truncate text-[13px] text-ink-60">{line}</p>
      <span className="flex-none text-[12px] text-ink-60 tabular-nums">阶段 04 / 07 · 候选</span>
    </footer>
  );
}

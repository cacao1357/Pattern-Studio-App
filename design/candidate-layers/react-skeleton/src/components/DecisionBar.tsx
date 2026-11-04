export interface DecisionBarProps {
  canCompose: boolean;
  onCompose: () => void;
  onReject: () => void;
  onUseLocal: () => void;
}

export const BTN = {
  solid:
    "inline-flex items-center justify-center gap-[5px] h-[28px] px-[10px] border border-ink bg-ink text-paper text-[12px] font-medium tracking-wide transition-colors duration-[120ms] hover:bg-ink-85 hover:border-ink-85 disabled:bg-transparent disabled:border-ink-25 disabled:text-ink-40 disabled:cursor-not-allowed",
  line:
    "inline-flex items-center justify-center gap-[5px] h-[28px] px-[10px] border border-ink text-ink text-[12px] font-medium tracking-wide transition-colors duration-[120ms] hover:bg-paper-2 disabled:border-ink-25 disabled:text-ink-40 disabled:cursor-not-allowed",
  quiet:
    "inline-flex items-center justify-center gap-[5px] h-[28px] px-[6px] border border-transparent text-ink-60 text-[12px] font-medium tracking-wide transition-colors duration-[120ms] hover:text-ink hover:bg-paper-2"
} as const;

export default function DecisionBar({ canCompose, onCompose, onReject, onUseLocal }: DecisionBarProps) {
  return (
    <div className="flex-none flex flex-wrap items-center justify-end gap-[6px] px-4 py-3 border-t border-ink">
      <button type="button" className={BTN.quiet} aria-label="改用本地流程" onClick={onUseLocal}>
        改用本地流程
      </button>
      <button type="button" className={BTN.line} aria-label="拒绝本批候选" onClick={onReject}>
        拒绝候选
      </button>
      <button
        type="button"
        className={BTN.solid}
        disabled={!canCompose}
        aria-label={`合成所选图层${canCompose ? "" : "（需先选择至少一层）"}`}
        onClick={onCompose}
      >
        合成所选图层
      </button>
    </div>
  );
}

export interface SelectionSummaryProps {
  total: number;
  selectedZ: number[];
}

export default function SelectionSummary({ total, selectedZ }: SelectionSummaryProps) {
  return (
    <div className="flex-none px-4 py-3 border-t border-ink-25 text-[12px] leading-[1.6]" aria-live="polite">
      <p>
        已选 <strong className="tabular-nums">{selectedZ.length}</strong> / {total} 层 ·{" "}
        {selectedZ.length ? `图层 ${selectedZ.join("、")}` : "尚未选择图层"}
      </p>
      <p className="text-ink-60">合成沿用当前矢量参数：彩色 · 8 色 · 中细节。</p>
    </div>
  );
}

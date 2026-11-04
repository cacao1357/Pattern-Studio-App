import type { InputAsset, PageState } from "../types";
import { STATUS_META } from "../data/mock";

export interface PageHeaderProps {
  input: InputAsset;
  state: PageState;
}

export default function PageHeader({ input, state }: PageHeaderProps) {
  const meta = STATUS_META[state];
  return (
    <div className="flex-none px-4 pt-4 pb-3 border-b-2 border-ink">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="font-display text-[28px] font-light leading-[1.1] tracking-wide">候选图层</h1>
        <span className={`inline-flex items-center h-[20px] px-[7px] border text-[12px] tracking-wider ${meta.pillCls}`} role="status">
          {meta.badge}
        </span>
      </div>
      <dl className="mt-2 space-y-[2px] text-[12px]">
        <div className="flex items-baseline gap-2 min-w-0">
          <dt className="flex-none text-ink-60">当前输入</dt>
          <dd className="min-w-0 truncate tabular-nums" title={input.name}>{input.name}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="flex-none text-ink-60">尺寸</dt>
          <dd className="tabular-nums">{input.width} × {input.height}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="flex-none text-ink-60">坐标空间</dt>
          <dd className="tabular-nums">{input.coordinateSpace}</dd>
        </div>
      </dl>
    </div>
  );
}

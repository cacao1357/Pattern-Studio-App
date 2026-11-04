import type { VersionEntry } from "../types";
import Icon from "./Icon";

export interface VersionRailProps {
  versions: VersionEntry[];
}

export default function VersionRail({ versions }: VersionRailProps) {
  return (
    <aside className="min-h-0 flex flex-col border-r border-ink-25 bg-paper" aria-labelledby="vr-title">
      <div className="flex items-baseline justify-between gap-2 px-3 py-[9px] border-b border-ink-25">
        <h2 className="font-display text-[15px] font-medium tracking-wider hidden wide:block" id="vr-title">版本</h2>
        <span className="font-display text-[13px] text-ink-60 tabular-nums hidden wide:inline">{versions.length}</span>
        <span className="wide:hidden mx-auto font-display text-[13px] text-ink-60" aria-hidden="true">版</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scroll-thin" role="list" aria-label="图像与成果版本">
        {versions.map((v) => (
          <div
            key={v.id}
            role="listitem"
            title={`${v.label}${v.current ? "（当前输入）" : ""}`}
            aria-label={`版本：${v.label}${v.current ? "，当前输入" : ""}`}
            className={`flex items-center gap-2 px-2 py-2 border-b border-ink-12 ${
              v.current ? "bg-paper-2 border-l-[3px] border-l-ink pl-[5px]" : ""
            }`}
          >
            <span className="w-[32px] h-[32px] flex-none inline-flex items-center justify-center border border-ink-25 bg-paper-hi text-ink-60">
              <Icon name={v.icon} />
            </span>
            <span className="min-w-0 hidden wide:block">
              <span className="flex items-center gap-1 flex-wrap">
                <span className="text-[13px] font-medium whitespace-nowrap">{v.label}</span>
                {v.current && (
                  <span className="inline-flex items-center h-[17px] px-[5px] border border-ink bg-paper-2 text-[11px] text-ink">当前输入</span>
                )}
              </span>
              <span className="block text-[11px] text-ink-60 tabular-nums whitespace-nowrap overflow-hidden text-ellipsis">{v.meta}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="flex-none px-3 py-2 border-t border-ink-25 bg-paper-2 text-[12px] text-ink-60 hidden wide:block">候选阶段 · 只读记录</div>
    </aside>
  );
}

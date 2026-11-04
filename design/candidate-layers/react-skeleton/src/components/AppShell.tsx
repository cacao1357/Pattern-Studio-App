import type { ReactNode } from "react";
import type { StageStep } from "../types";
import Icon from "./Icon";

export interface AppShellProps {
  stages: StageStep[];
  versionRail: ReactNode;
  canvas: ReactNode;
  workspace: ReactNode;
  statusBar: ReactNode;
}

const QUIET_BTN =
  "inline-flex items-center gap-[5px] h-[28px] px-2 text-[12px] text-ink-60 hover:text-ink hover:bg-paper-2 transition-colors duration-[120ms]";

export default function AppShell({ stages, versionRail, canvas, workspace, statusBar }: AppShellProps) {
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="h-[52px] flex-none flex items-center justify-between gap-4 px-6 border-b border-ink-12">
        <a href="#" className="flex items-baseline gap-2 text-ink no-underline" aria-label="回到工作台顶部">
          <Icon name="mark" className="w-[17px] h-[17px] self-center" />
          <span className="font-display text-[15.5px] font-medium tracking-wide">Pattern Studio</span>
          <span className="text-[12px] text-ink-60 tracking-wider hidden wide:inline">本地纹样工作台</span>
        </a>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-[7px] h-[26px] px-2 border border-ink-25 text-[12px] text-ink-60">
            <span className="w-[6px] h-[6px] bg-ink border border-ink" aria-hidden="true"></span>本机就绪
          </span>
          <button type="button" className={QUIET_BTN} aria-label="打开历史任务">
            <Icon name="history" />
            <span>历史</span>
          </button>
          <button type="button" className={QUIET_BTN} aria-label="打开设置">
            <Icon name="settings" />
            <span>设置</span>
          </button>
        </div>
      </header>

      <nav className="h-[46px] flex-none grid grid-cols-7 border-b-2 border-ink bg-paper-2" aria-label="工序导航">
        {stages.map((s) => {
          const active = s.n === "04";
          return (
            <button
              key={s.n}
              type="button"
              aria-current={active ? "step" : undefined}
              aria-label={`工序 ${s.n} ${s.label}${active ? "（当前）" : ""}`}
              className={`relative flex items-baseline gap-2 min-w-0 px-[14px] border-r last:border-r-0 border-ink-25 text-left transition-colors duration-[120ms] ${
                active ? "bg-ink text-paper" : "text-ink-60 hover:text-ink hover:bg-ink-12"
              }`}
            >
              <span className={`font-display text-[12px] tracking-widest tabular-nums ${active ? "" : "opacity-80"}`}>{s.n}</span>
              <span className="text-[14px] font-medium tracking-wider whitespace-nowrap overflow-hidden text-ellipsis">{s.label}</span>
            </button>
          );
        })}
      </nav>

      <main className="flex-1 min-h-0 grid grid-rows-[minmax(0,1fr)] grid-cols-[64px_minmax(0,1fr)_320px] wide:grid-cols-[248px_minmax(0,1fr)_380px]">
        {versionRail}
        {canvas}
        {workspace}
      </main>

      {statusBar}
    </div>
  );
}

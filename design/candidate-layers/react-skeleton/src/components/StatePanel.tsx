import { BTN } from "./DecisionBar";

export interface StatePanelProps {
  state: "empty" | "loading" | "error";
  onGenerate: () => void;
  onRetry: () => void;
}

function SkeletonCard() {
  return (
    <div className="border border-ink-25 bg-paper-hi">
      <div className="aspect-[4/3] bg-paper-2 border-b border-ink-25"></div>
      <div className="px-2 py-[6px] space-y-[6px]">
        <div className="h-[12px] w-2/3 bg-paper-2"></div>
        <div className="h-[10px] w-full bg-paper-2"></div>
      </div>
    </div>
  );
}

export default function StatePanel({ state, onGenerate, onRetry }: StatePanelProps) {
  if (state === "empty") {
    return (
      <div className="border border-ink-25 border-l-[3px] border-l-ink px-3 py-[11px] bg-paper-hi">
        <strong className="block text-[13px] font-medium">尚无候选图层</strong>
        <p className="mt-1 text-[12px] text-ink-60 leading-[1.65]">完成 AI 拆层后，候选图层会列在这里。候选不会自动合并，底图仅作坐标参考。</p>
        <button type="button" className={`${BTN.solid} mt-3`} aria-label="生成候选（占位）" onClick={onGenerate}>
          生成候选
        </button>
      </div>
    );
  }
  if (state === "loading") {
    return (
      <>
        <div className="flex items-center gap-[10px] px-1 py-2 text-[13px] text-ink-60" role="status">
          <span className="w-[12px] h-[12px] flex-none border border-ink bg-paper-2" aria-hidden="true"></span>
          <span>正在生成候选，请稍候…</span>
        </div>
        <div className="mt-2 grid grid-cols-1 wide:grid-cols-2 gap-2" aria-hidden="true">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </>
    );
  }
  return (
    <>
      <div className="border border-ink bg-ink text-paper px-3 py-[10px]" role="alert">
        <strong className="block text-[13px] font-semibold">候选生成失败</strong>
        <p className="mt-1 text-[12px] leading-[1.6]">云端请求超时，结果不确定。已发出的请求可能仍在计费，页面不会自动重发。</p>
      </div>
      <button type="button" className={`${BTN.line} mt-3`} aria-label="重试生成候选（占位）" onClick={onRetry}>
        重试生成
      </button>
      <p className="mt-2 text-[12px] text-ink-60 leading-[1.6]">重试前可先核对任务历史；也可用「改用本地流程」继续。</p>
    </>
  );
}

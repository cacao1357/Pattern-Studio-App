import type { InputAsset } from "../types";
import Icon from "./Icon";
import Thumb from "./Thumb";

export interface InputCanvasProps {
  input: InputAsset;
  zoom: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
}

const ZOOM_BTN =
  "w-[26px] h-[26px] inline-flex items-center justify-center border border-transparent text-ink-60 transition-colors duration-[120ms] hover:text-ink hover:border-ink-25 hover:bg-paper-2 disabled:opacity-40 disabled:hover:text-ink-60 disabled:hover:border-transparent disabled:hover:bg-transparent";

export default function InputCanvas({ input, zoom, canZoomIn, canZoomOut, onZoomIn, onZoomOut, onZoomFit }: InputCanvasProps) {
  const baseWidth = 300;
  return (
    <section className="min-w-0 min-h-0 flex flex-col bg-paper" aria-labelledby="cv-name">
      <div className="flex items-center justify-between gap-3 px-4 pt-[10px] pb-2">
        <h2 className="flex items-baseline gap-2 min-w-0 text-[14px] font-normal">
          <strong className="font-display text-[16px] font-medium truncate max-w-[38ch]" id="cv-name">{input.name}</strong>
          <span className="flex-none text-[12px] text-ink-60">规范输入</span>
        </h2>
        <div className="flex items-center gap-1 flex-none" role="group" aria-label="缩放控制">
          <button type="button" className={ZOOM_BTN} aria-label="缩小画布" onClick={onZoomOut} disabled={!canZoomOut}>
            <Icon name="minus" />
          </button>
          <span className="w-[44px] text-center text-[12px] tabular-nums text-ink-60" aria-live="polite">{zoom}%</span>
          <button type="button" className={ZOOM_BTN} aria-label="放大画布" onClick={onZoomIn} disabled={!canZoomIn}>
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className="h-[26px] px-2 inline-flex items-center gap-1 border border-transparent text-[12px] text-ink-60 transition-colors duration-[120ms] hover:text-ink hover:border-ink-25 hover:bg-paper-2"
            aria-label="适应窗口"
            onClick={onZoomFit}
          >
            <Icon name="fit" />适应
          </button>
        </div>
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 px-4 pb-2 border-b border-ink-12 text-[12px]">
        <div className="flex items-baseline gap-[6px]">
          <dt className="text-ink-60">尺寸</dt>
          <dd className="tabular-nums">{input.width} × {input.height}</dd>
        </div>
        <div className="flex items-baseline gap-[6px]">
          <dt className="text-ink-60">坐标空间</dt>
          <dd className="tabular-nums">{input.coordinateSpace}</dd>
        </div>
        <div className="flex items-baseline gap-[6px]">
          <dt className="text-ink-60">质量参考</dt>
          <dd><span className="inline-flex items-center h-[19px] px-[6px] border-2 border-ink text-[12px] font-semibold">{input.grade} 级</span></dd>
        </div>
      </dl>
      <div className="relative flex-1 min-h-0 grid place-items-center p-4 overflow-hidden">
        <div className="absolute z-10 top-4 left-4 flex items-center gap-2 px-[9px] py-[6px] border border-ink bg-paper-hi text-[12px] leading-[1.4]">
          <Icon name="eye" className="w-4 h-4 flex-none" />
          <span>只读预览 · 坐标为当前输入像素</span>
        </div>
        <div className="checker border border-ink-25 leading-[0] max-w-full max-h-full overflow-hidden">
          <div className="transition-[width] duration-[120ms]" style={{ width: Math.round(baseWidth * (zoom / 100)) }}>
            <div className="aspect-[542/666]">
              <Thumb seed={3} big />
            </div>
          </div>
        </div>
      </div>
      <p className="flex-none px-4 pt-[6px] pb-[9px] border-t border-ink-12 text-[12px] text-ink-60">候选阶段画布为只读；选择图层在右侧候选区完成。</p>
    </section>
  );
}

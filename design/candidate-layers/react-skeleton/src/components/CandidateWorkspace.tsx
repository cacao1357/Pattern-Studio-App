import type { BasemapInfo, CandidateLayer, FilterMode, PageState } from "../types";
import CandidateFilterBar from "./CandidateFilterBar";
import CandidateGrid from "./CandidateGrid";
import DecisionBar from "./DecisionBar";
import SelectionSummary from "./SelectionSummary";
import StatePanel from "./StatePanel";

export interface CandidateWorkspaceProps {
  state: PageState;
  basemap: BasemapInfo;
  candidates: CandidateLayer[];
  selectedIds: ReadonlySet<string>;
  filter: FilterMode;
  onFilterChange: (filter: FilterMode) => void;
  onToggle: (id: string) => void;
  onGenerate: () => void;
  onRetry: () => void;
  onCompose: () => void;
  onReject: () => void;
  onUseLocal: () => void;
}

function BasemapNote({ basemap }: { basemap: BasemapInfo }) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-[6px] border border-dashed border-ink-25 bg-paper-hi text-[12px] text-ink-60"
      aria-label={`底图：${basemap.note}`}
    >
      <span className="w-[28px] h-[22px] flex-none checker border border-ink-25" aria-hidden="true"></span>
      <span className="font-medium text-ink">底图</span>
      <span className="inline-flex items-center h-[17px] px-[5px] border border-dashed border-ink-40 text-[11px]">{basemap.note}</span>
    </div>
  );
}

export default function CandidateWorkspace(props: CandidateWorkspaceProps) {
  const { state, basemap, candidates, selectedIds, filter } = props;
  const hasGrid = state === "ready" || state === "selected";

  const visible =
    filter === "selected"
      ? candidates.filter((c) => selectedIds.has(c.id))
      : filter === "review"
        ? candidates.filter((c) => c.warnings.length > 0)
        : candidates;

  const counts: Record<FilterMode, number> = {
    all: candidates.length,
    selected: selectedIds.size,
    review: candidates.filter((c) => c.warnings.length > 0).length
  };

  const selectedZ = candidates.filter((c) => selectedIds.has(c.id)).map((c) => c.zIndex);

  if (!hasGrid) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-4 py-3">
          <StatePanel state={state as "empty" | "loading" | "error"} onGenerate={props.onGenerate} onRetry={props.onRetry} />
        </div>
        {(state === "empty" || state === "error") && (
          <DecisionBar canCompose={false} onCompose={props.onCompose} onReject={props.onReject} onUseLocal={props.onUseLocal} />
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scroll-thin px-4 py-3">
        <div className="mb-2">
          <CandidateFilterBar filter={filter} counts={counts} onChange={props.onFilterChange} />
        </div>
        <div className="mb-2">
          <BasemapNote basemap={basemap} />
        </div>
        <CandidateGrid candidates={visible} selectedIds={selectedIds} onToggle={props.onToggle} />
        <p className="mt-2 text-[12px] text-ink-60 leading-[1.6]">AI 生成内容仅供挑选，几何与保真尚未核验；合成后才写入新版本。</p>
      </div>
      <SelectionSummary total={candidates.length} selectedZ={selectedZ} />
      <DecisionBar
        canCompose={selectedIds.size > 0}
        onCompose={props.onCompose}
        onReject={props.onReject}
        onUseLocal={props.onUseLocal}
      />
    </div>
  );
}

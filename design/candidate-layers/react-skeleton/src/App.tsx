import { useMemo, useState } from "react";
import AppShell from "./components/AppShell";
import CandidateWorkspace from "./components/CandidateWorkspace";
import InputCanvas from "./components/InputCanvas";
import PageHeader from "./components/PageHeader";
import StatusBar from "./components/StatusBar";
import VersionRail from "./components/VersionRail";
import { BASEMAP, CANDIDATES, INPUT, STAGES, VERSIONS, ZOOM_LEVELS, parsePageState } from "./data/mock";
import type { FilterMode } from "./types";

export default function App() {
  // 页面状态只由 URL 查询参数决定：?state=empty|loading|ready|selected|error
  const pageState = useMemo(() => parsePageState(window.location.search), []);

  // 纯演示用本地 UI 状态：选中图层 / 筛选 / 缩放。不持久化、不请求。
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() =>
    pageState === "selected" ? new Set(["cand-1", "cand-2"]) : new Set()
  );
  const [filter, setFilter] = useState<FilterMode>("all");
  const [zoomIndex, setZoomIndex] = useState(2);

  const toggleCandidate = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedZ = CANDIDATES.filter((c) => selectedIds.has(c.id)).map((c) => c.zIndex);

  const handleGenerate = () => {
    // TODO(business): 提交 AI 拆层任务（POST /api/v1/pipelines/ai），需要上传与费用双确认。
  };
  const handleRetry = () => {
    // TODO(business): 用同一幂等键重试；结果不确定的提交不自动重发。
  };
  const handleCompose = () => {
    // TODO(business): 复用已归档图层合成（对应 workbench.js 的 #ai-compose 流程）。
  };
  const handleReject = () => {
    // TODO(business): 拒绝本批候选并记录（对应 workbench.js 的 #ai-reject 流程）。
  };
  const handleUseLocal = () => {
    // TODO(business): 回退到本地提取流程（对应 workbench.js 的 #ai-use-local 流程）。
  };

  return (
    <AppShell
      stages={STAGES}
      versionRail={<VersionRail versions={VERSIONS} />}
      canvas={
        <InputCanvas
          input={INPUT}
          zoom={ZOOM_LEVELS[zoomIndex]}
          canZoomOut={zoomIndex > 0}
          canZoomIn={zoomIndex < ZOOM_LEVELS.length - 1}
          onZoomOut={() => setZoomIndex((i) => Math.max(0, i - 1))}
          onZoomIn={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}
          onZoomFit={() => setZoomIndex(2)}
        />
      }
      workspace={
        <aside className="min-w-0 min-h-0 flex flex-col overflow-hidden border-l border-ink-25 bg-paper" aria-label="候选图层工作区">
          <PageHeader input={INPUT} state={pageState} />
          <CandidateWorkspace
            state={pageState}
            basemap={BASEMAP}
            candidates={CANDIDATES}
            selectedIds={selectedIds}
            filter={filter}
            onFilterChange={setFilter}
            onToggle={toggleCandidate}
            onGenerate={handleGenerate}
            onRetry={handleRetry}
            onCompose={handleCompose}
            onReject={handleReject}
            onUseLocal={handleUseLocal}
          />
        </aside>
      }
      statusBar={<StatusBar state={pageState} selectedZ={selectedZ} />}
    />
  );
}

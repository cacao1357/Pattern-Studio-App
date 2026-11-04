import type { BasemapInfo, CandidateLayer, InputAsset, PageState, StageStep, StatusMeta, VersionEntry } from "../types";

export const WARNING_LABELS: Record<string, string> = {
  CANDIDATE_MAY_BE_BACKGROUND: "覆盖范围偏大，可能选中背景",
  CANDIDATE_TOO_SMALL: "候选面积过小，可能只是噪点",
  CANDIDATE_TOUCHES_BORDER: "候选贴边较多，可能是画框或背景",
  CANDIDATE_IS_SOLID_REGION: "接近实心区域，可能不是纹样轮廓",
  CANDIDATE_TOO_ELONGATED: "过于狭长，可能是折痕或边线"
};

export const INPUT: InputAsset = {
  id: "input-demo",
  name: "real_02d686e2797d30619ddb1ea4de055056.png",
  width: 542,
  height: 666,
  coordinateSpace: "fb26af99-a50",
  grade: "B"
};

export const BASEMAP: BasemapInfo = { id: "basemap", note: "仅作坐标参考，不可选" };

export const CANDIDATES: CandidateLayer[] = [
  { id: "cand-1", zIndex: 1, label: "底层铺色", width: 542, height: 666, areaRatio: 0.38, confidence: 0.91, aiInferred: true, geometryVerified: false, warnings: [] },
  { id: "cand-2", zIndex: 2, label: "主体纹样", width: 542, height: 666, areaRatio: 0.22, confidence: 0.88, aiInferred: true, geometryVerified: false, warnings: [] },
  { id: "cand-3", zIndex: 3, label: "内部线条", width: 542, height: 666, areaRatio: 0.09, confidence: 0.74, aiInferred: true, geometryVerified: false, warnings: [] },
  { id: "cand-4", zIndex: 4, label: "点缀元素", width: 542, height: 666, areaRatio: 0.05, confidence: 0.66, aiInferred: true, geometryVerified: false, warnings: [] },
  { id: "cand-5", zIndex: 5, label: "外围区域", width: 542, height: 666, areaRatio: 0.61, confidence: 0.42, aiInferred: true, geometryVerified: false, warnings: ["CANDIDATE_MAY_BE_BACKGROUND"] }
];

export const VERSIONS: VersionEntry[] = [
  { id: "v-original", label: "原始文件", icon: "image", meta: "542 × 666", current: false },
  { id: "v-normalized", label: "规范输入", icon: "crop", meta: "542 × 666 · B 级", current: true },
  { id: "v-mask", label: "前景蒙版", icon: "brush", meta: "542 × 666 · 蒙版", current: false },
  { id: "v-png", label: "透明 PNG", icon: "grid", meta: "542 × 666 · 透明", current: false },
  { id: "v-composed", label: "候选合成", icon: "spark", meta: "待选择图层", current: false }
];

export const STAGES: StageStep[] = [
  { n: "01", label: "来源" },
  { n: "02", label: "裁切" },
  { n: "03", label: "处理" },
  { n: "04", label: "候选" },
  { n: "05", label: "蒙版" },
  { n: "06", label: "修复" },
  { n: "07", label: "平铺" }
];

export const ZOOM_LEVELS = [50, 75, 100, 125, 150] as const;

export const STATUS_META: Record<PageState, StatusMeta> = {
  empty: {
    badge: "未开始",
    pillCls: "border-ink-25 text-ink-60",
    line: "尚未生成候选"
  },
  loading: {
    badge: "生成中",
    pillCls: "border-ink text-ink bg-paper-2",
    line: "AI 拆层进行中 · 请稍候"
  },
  ready: {
    badge: "等待选择",
    pillCls: "border-ink border-l-[3px] text-ink bg-paper-2 font-medium",
    line: "5 个候选图层 · 尚未选择"
  },
  selected: {
    badge: "等待选择",
    pillCls: "border-ink border-l-[3px] text-ink bg-paper-2 font-medium",
    line: "已选图层可合成"
  },
  error: {
    badge: "失败",
    pillCls: "border-ink bg-ink text-paper",
    line: "候选生成失败 · 可重试"
  }
};

export function parsePageState(search: string): PageState {
  const value = new URLSearchParams(search).get("state");
  return value === "empty" || value === "loading" || value === "ready" || value === "selected" || value === "error"
    ? value
    : "ready";
}

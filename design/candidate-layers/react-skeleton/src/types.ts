export type PageState = "empty" | "loading" | "ready" | "selected" | "error";

export type FilterMode = "all" | "selected" | "review";

export type IconName =
  | "mark"
  | "history"
  | "settings"
  | "image"
  | "eye"
  | "check"
  | "alert"
  | "crop"
  | "brush"
  | "grid"
  | "spark"
  | "plus"
  | "minus"
  | "fit";

export interface InputAsset {
  id: string;
  name: string;
  width: number;
  height: number;
  coordinateSpace: string;
  grade: string;
}

export interface BasemapInfo {
  id: string;
  note: string;
}

export interface CandidateLayer {
  id: string;
  zIndex: number;
  label: string;
  width: number;
  height: number;
  areaRatio: number;
  confidence: number;
  aiInferred: boolean;
  geometryVerified: boolean;
  warnings: string[];
}

export interface VersionEntry {
  id: string;
  label: string;
  icon: IconName;
  meta: string;
  current: boolean;
}

export interface StageStep {
  n: string;
  label: string;
}

export interface StatusMeta {
  badge: string;
  pillCls: string;
  line: string;
}

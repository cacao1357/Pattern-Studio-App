"use strict";

/* Pattern Studio S3 local workbench.
 * No build step, no third-party runtime, no credential handling.
 * Reads are same-origin; every write declares X-Pattern-Studio: local and
 * carries an Idempotency-Key so an uncertain network result can be retried.
 */

import { createEditHistory } from "./edit-history.js";
import { createPreviewSession, PREVIEW_TTL_MS } from "./preview-session.js";
import { createBrushHistory } from "./brush-history.js";
import {
  EXTRACT_MODES,
  ENHANCE_LIMITS,
  DENOISE_LABELS,
  modeInfo,
  recommendExtractMode,
  validateExtractOptions,
  extractPayload,
  validateEnhanceOptions,
  enhancePayload,
  isNeutralEnhance,
  predictPreparedSize,
  extractSummary as describeExtractParams,
  enhanceSummary as describeEnhanceParams
} from "./params.js";
import {
  cancelEligibility,
  cancelConflictMessage,
  cancelTerminalOutcome,
  cancelledMessage,
  successRaceMessage
} from "./job-cancel.js";
import { buildGuidance } from "./guidance.js";
import {
  SETTINGS_API_KEY_ACTIONS,
  buildSettingsUpdate,
  centsToYuan,
  composeRerunPayload,
  createSettingsClient,
  normalizeWorkflowTrace,
  selectionPolicyLabel,
  settingsEffective,
  vectorizeRerunPayload,
  workflowPngCandidates
} from "./settings.js";

const API_BASE = "/api/v1";
const PROCESS_PIXEL_LIMIT = 1_000_000;
const WORKING_COPY_MIN = 10_000;
const WORKING_COPY_MAX = 1_000_000;
const POLL_BASE_MS = 1200;
const POLL_MAX_FAILURES = 5;
const REPAIR_PIXEL_LIMIT = 1_048_576;
const TILE_PIXEL_LIMIT = 4_000_000;
const SVG_NS = "http://www.w3.org/2000/svg";
const PREVIEW_REVISION_DELAY = 500;
const AUTO_PREVIEW_DELAY = 900;
const BRUSH_RADIUS_MIN = 1;
const BRUSH_RADIUS_MAX = 64;

const KIND_LABELS = {
  original: "原始文件",
  normalized: "规范输入",
  normalized_input: "规范输入",
  crop: "裁切",
  cropped: "裁切",
  prepared: "准备版本",
  prepare: "图像准备",
  working_copy: "工作副本",
  workingcopy: "工作副本",
  enhance: "轻增强",
  enhanced: "轻增强",
  foreground_mask: "前景蒙版",
  mask: "蒙版",
  foreground: "透明 PNG",
  transparent: "透明 PNG",
  transparent_png: "透明 PNG",
  contour: "轮廓线稿",
  contour_line_art: "轮廓线稿",
  outline: "轮廓线稿",
  svg: "SVG",
  monochrome_svg: "黑白 SVG",
  color_svg: "彩色 SVG",
  svg_monochrome: "黑白 SVG",
  svg_color: "彩色 SVG",
  vector: "SVG",
  export: "ZIP 包",
  archive: "ZIP 包",
  zip: "ZIP 包",
  ai_layer: "AI 候选层",
  layer: "AI 候选层",
  generated_basemap: "AI 底图",
  generated_layer: "AI 候选层",
  placed_generated_layer: "AI 候选层",
  composed_candidate: "AI 合成候选",
  edit_candidate: "编辑候选",
  repair_composite: "修复局部保护版",
  accepted_repair: "已接受修复",
  edit_mask: "编辑区域掩膜",
  damage_mask: "损伤标注",
  blend_weight: "羽化权重",
  difference_map: "修复差异图",
  tile_preview: "平铺预览",
  repair_candidate: "修复全图候选"
};

const JOB_LABELS = {
  crop: "裁切",
  prepare: "图像准备",
  working_copy: "工作副本",
  workingcopy: "工作副本",
  enhance: "轻增强",
  extract: "提取",
  vectorize: "矢量化",
  recolor_svg: "SVG 颜色替换",
  pipeline: "本地一键",
  export: "ZIP 导出",
  refine_mask: "修正前景蒙版",
  refine_mask_job: "修正前景蒙版",
  compose_layers: "合成候选图层",
  repair: "局部修复",
  repair_job: "局部修复",
  tile_preview: "生成平铺预览",
  tile: "生成平铺预览",
  decompose: "AI 拆层",
  decompose_layers: "AI 拆层",
  decomposition: "AI 拆层",
  decomposition_job: "AI 拆层",
  ai_decompose: "AI 拆层",
  ai_pipeline: "AI 候选",
  select_layers: "合成所选图层",
  use_local: "本地回退"
};

const STATE_LABELS = {
  queued: "排队中",
  running: "处理中",
  waiting_user: "等待选择",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  accepted: "已接受",
  rejected: "已拒绝"
};

const REPAIR_STATE_LABELS = {
  queued: "准备中",
  running: "生成中",
  waiting_user: "等待确认",
  failed: "失败",
  cancelled: "已取消",
  accepted: "已接受",
  rejected: "已拒绝"
};

const REPAIR_INTENTS = {
  restore_small_gap: "补齐小面积缺口",
  reconnect_lines: "接续断裂线条"
};

const SEAM_LABELS = {
  not_reviewed: "接缝尚未检查",
  visible: "肉眼可见接缝",
  not_obvious: "暂未看到明显接缝"
};

const REPAIR_WARNING_LABELS = {
  CANDIDATE_SPACE_MISMATCH: "候选尺寸或坐标空间与输入不一致。仅保留完整候选预览，未生成局部保护版；没有强制缩放。",
  PARTIAL_DAMAGE_COVERAGE: "部分损伤标注不在本次编辑矩形内，本次只评价覆盖部分。"
};

const STEP_LABELS = {
  crop: "裁切",
  working_copy: "缩小工作副本",
  workingcopy: "缩小工作副本",
  enhance: "轻增强",
  extract: "提取蒙版与透明图",
  vectorize: "矢量化",
  recolor_svg: "SVG 颜色替换",
  pipeline: "本地链路",
  export: "打包 ZIP",
  prepare: "准备输入",
  decompose: "生成 AI 候选",
  decompose_layers: "生成 AI 候选",
  decomposition: "生成 AI 候选",
  decomposition_job: "生成 AI 候选",
  compose: "合成候选图层",
  compose_layers: "合成候选图层",
  refine_mask: "修正前景蒙版",
  use_local: "改用本地流程",
  select_layers: "合成所选图层",
  repair: "生成修复候选",
  repair_job: "生成修复候选",
  repair_candidate: "生成修复候选",
  protect_region: "局部保护合成",
  tile_preview: "生成平铺预览",
  tile: "生成平铺预览"
};

const AI_STATE_LABELS = {
  queued: "准备中",
  running: "生成中",
  waiting_user: "等待选择",
  succeeded: "已完成",
  failed: "失败",
  rejected: "已拒绝"
};

const RECOVERY_STATE_LABELS = {
  needs_reconcile: "需要核对云端结果",
  uncertain: "云端结果不确定",
  unknown: "云端结果未知",
  result_unknown: "云端结果未知"
};

const ISSUE_LABELS = {
  edges: "边缘",
  details: "细节",
  color: "色彩",
  speed: "速度",
  stability: "稳定性",
  other: "其他"
};

const QUALITY_HEADLINES = {
  A: "尺寸与清晰度适合本地处理",
  B: "可用；细节一般，建议先预览",
  C: "建议换更清晰的素材或先放大",
  U: "质量指标未能计算，不影响继续处理"
};

const QUALITY_GRADE_HINTS = {
  A: "短边达到 512，清晰度与对比度均达标。",
  B: "未达到 A 级门槛，但仍可作为本地处理起点。",
  C: "短边、清晰度或对比度偏低；仍可继续，但预览结果会更依赖人工检查。"
};

const PATTERN_WARNING_LABELS = {
  CANDIDATE_MAY_BE_BACKGROUND: "覆盖范围偏大，可能选中背景",
  CANDIDATE_TOO_SMALL: "候选面积过小，可能只是噪点",
  CANDIDATE_TOUCHES_BORDER: "候选贴边较多，可能是画框或背景",
  CANDIDATE_IS_SOLID_REGION: "接近实心区域，可能不是纹样轮廓",
  CANDIDATE_TOO_ELONGATED: "过于狭长，可能是折痕或边线"
};

const $ = (id) => document.getElementById(id);

const dom = {
  appView: $("app-view"),
  healthChip: $("health-chip"),
  healthLabel: $("health-label"),
  openHistory: $("open-history"),
  openSettings: $("open-settings"),
  settingsDialog: $("settings-dialog"),
  settingsForm: $("settings-form"),
  settingsClose: $("settings-close"),
  settingsReload: $("settings-reload"),
  settingsSave: $("settings-save"),
  settingsState: $("settings-state"),
  settingsRevision: $("settings-revision"),
  settingsEffectiveChip: $("settings-effective"),
  settingsEffectiveNote: $("settings-effective-note"),
  settingsKeyState: $("settings-key-state"),
  settingsKeyAction: $("settings-key-action"),
  settingsKeyField: $("settings-key-field"),
  settingsKeyInput: $("settings-key-input"),
  settingsKeyNote: $("settings-key-note"),
  settingsModel: $("settings-model"),
  settingsBaseUrl: $("settings-base-url"),
  settingsPaid: $("settings-paid"),
  settingsPricing: $("settings-pricing"),
  settingsBudget: $("settings-budget"),
  settingsReservation: $("settings-reservation"),
  settingsMaxCalls: $("settings-max-calls"),
  settingsBlockers: $("settings-blockers"),
  settingsError: $("settings-error"),
  settingsMessage: $("settings-message"),
  connectionBanner: $("connection-banner"),
  connectionMessage: $("connection-message"),
  retryConnection: $("retry-connection"),
  pendingBanner: $("pending-banner"),
  pendingMessage: $("pending-message"),
  pendingRetry: $("pending-retry"),
  pendingDiscard: $("pending-discard"),
  workspace: $("workspace-main"),
  dropzone: $("dropzone"),
  chooseFile: $("choose-file"),
  imageFile: $("image-file"),
  fileSummary: $("file-summary"),
  fileName: $("file-name"),
  fileMeta: $("file-meta"),
  clearFile: $("clear-file"),
  sourceNote: $("source-note"),
  sourceType: $("source-type"),
  sourceName: $("source-name"),
  sourceUrl: $("source-url"),
  license: $("license"),
  collectedAt: $("collected-at"),
  batchId: $("batch-id"),
  qualitySummary: $("quality-summary"),
  qualityGrade: $("quality-grade"),
  qualityHeadline: $("quality-headline"),
  qualityMetrics: $("quality-metrics"),
  duplicateBanner: $("duplicate-banner"),
  duplicateTitle: $("duplicate-title"),
  duplicateMessage: $("duplicate-message"),
  duplicateList: $("duplicate-list"),
  duplicateUse: $("duplicate-use"),
  duplicateDismiss: $("duplicate-dismiss"),
  gradeChip: $("grade-chip"),
  qualityNote: $("quality-note"),
  uploadError: $("upload-error"),
  uploadSubmit: $("upload-submit"),
  versionCount: $("version-count"),
  versionEmpty: $("version-empty"),
  versionList: $("version-list"),
  selectionCount: $("selection-count"),
  clearSelection: $("clear-selection"),
  exportButton: $("export-button"),
  exportError: $("export-error"),
  sourceState: $("source-state"),
  workingMax: $("working-max"),
  workingProjection: $("working-projection"),
  workingError: $("working-error"),
  workingCopyButton: $("working-copy-button"),
  previewModeBadge: $("preview-mode-badge"),
  pendingPreviewBadge: $("pending-preview-badge"),
  undoButton: $("undo-button"),
  redoButton: $("redo-button"),
  previewBar: $("preview-bar"),
  previewBarTag: $("preview-bar-tag"),
  previewBarTitle: $("preview-bar-title"),
  previewBarDetail: $("preview-bar-detail"),
  previewApply: $("preview-apply"),
  previewDiscard: $("preview-discard"),
  previewWatermarkLabel: $("preview-watermark-label"),
  guidePanel: $("guide-panel"),
  guideTone: $("guide-tone"),
  guideNext: $("guide-next"),
  guideDetail: $("guide-detail"),
  guideSteps: $("guide-steps"),
  guideLocation: $("guide-location"),
  guideBlocked: $("guide-blocked"),
  guideFailure: $("guide-failure"),
  guideFailureTitle: $("guide-failure-title"),
  guideFailureLines: $("guide-failure-lines"),
  compareButton: $("compare-button"),
  currentName: $("current-name"),
  currentKind: $("current-kind"),
  originalDims: $("original-dims"),
  workingDims: $("working-dims"),
  coordinateId: $("coordinate-id"),
  sourceNoteDisplay: $("source-note-display"),
  largeWarning: $("large-warning"),
  largeWarningText: $("large-warning-text"),
  largeGotoWorking: $("large-goto-working"),
  canvasStage: $("canvas-stage"),
  canvasEmpty: $("canvas-empty"),
  canvasLoading: $("canvas-loading"),
  canvasError: $("canvas-error"),
  canvasErrorText: $("canvas-error-text"),
  retryPreview: $("retry-preview"),
  canvasFrame: $("canvas-frame"),
  previewImage: $("preview-image"),
  selectionLayer: $("selection-layer"),
  selectionBox: $("selection-box"),
  selectionLabel: $("selection-label"),
  previewWatermark: $("preview-watermark"),
  backToCurrent: $("back-to-current"),
  canvasHint: $("canvas-hint"),
  bboxFieldset: $("bbox-fieldset"),
  bboxLeft: $("bbox-left"),
  bboxTop: $("bbox-top"),
  bboxRight: $("bbox-right"),
  bboxBottom: $("bbox-bottom"),
  bboxError: $("bbox-error"),
  bboxStateDot: $("bbox-state-dot"),
  bboxStatus: $("bbox-status"),
  bboxFull: $("bbox-full"),
  bboxCancel: $("bbox-cancel"),
  cropButton: $("crop-button"),
  prepareRotation: $("prepare-rotation"),
  straightenRange: $("straighten-range"),
  straightenValue: $("straighten-value"),
  straightenReadout: $("straighten-readout"),
  prepareButton: $("prepare-button"),
  prepareProjection: $("prepare-projection"),
  prepareLimit: $("prepare-limit"),
  prepareError: $("prepare-error"),
  taskStatus: $("task-status"),
  taskEmpty: $("task-empty"),
  taskBody: $("task-body"),
  taskKind: $("task-kind"),
  taskId: $("task-id"),
  taskTime: $("task-time"),
  taskSteps: $("task-steps"),
  taskError: $("task-error"),
  taskPollError: $("task-poll-error"),
  taskRetry: $("task-retry"),
  taskCancel: $("task-cancel"),
  taskCancelNote: $("task-cancel-note"),
  taskPoll: $("task-poll"),
  taskEvaluate: $("task-evaluate"),
  taskResults: $("task-results"),
  feedbackJobChip: $("feedback-job-chip"),
  feedbackEmpty: $("feedback-empty"),
  feedbackForm: $("feedback-form"),
  ratingStars: $("rating-stars"),
  ratingReadout: $("rating-readout"),
  feedbackComment: $("feedback-comment"),
  allowDisplay: $("allow-display"),
  allowTraining: $("allow-training"),
  feedbackError: $("feedback-error"),
  feedbackSubmit: $("feedback-submit"),
  feedbackSuccess: $("feedback-success"),
  feedbackSuccessText: $("feedback-success-text"),
  oneclickButton: $("oneclick-button"),
  includeEnhance: $("include-enhance"),
  oneClickRecipe: $("one-click-recipe"),
  oneclickBlock: $("oneclick-block"),
  previewBlockHint: $("preview-block-hint"),
  composeError: $("compose-error"),
  extractButton: $("extract-button"),
  extractHint: $("extract-hint"),
  extractTransparencyNote: $("extract-transparency-note"),
  iterations: $("iterations"),
  iterationsField: $("iterations-field"),
  thresholdField: $("threshold-field"),
  thresholdRange: $("threshold-range"),
  thresholdValue: $("threshold-value"),
  thresholdReadout: $("threshold-readout"),
  extractAdvanced: $("extract-advanced"),
  windowField: $("window-field"),
  offsetField: $("offset-field"),
  claheField: $("clahe-field"),
  cleanupFields: $("cleanup-fields"),
  windowRange: $("window-range"),
  windowSize: $("window-size"),
  windowReadout: $("window-readout"),
  offsetRange: $("offset-range"),
  offsetValue: $("offset-value"),
  offsetReadout: $("offset-readout"),
  extractClahe: $("extract-clahe"),
  minComponentArea: $("min-component-area"),
  maxHoleArea: $("max-hole-area"),
  previewMode: $("preview-mode"),
  autoPreviewEnhance: $("auto-preview-enhance"),
  vectorButton: $("vector-button"),
  vectorLength: $("vector-length"),
  vectorCorner: $("vector-corner"),
  vectorSplice: $("vector-splice"),
  recolorGroup: $("recolor-group"),
  recolorSvgSelect: $("recolor-svg-select"),
  recolorNote: $("recolor-note"),
  recolorList: $("recolor-list"),
  recolorError: $("recolor-error"),
  recolorReset: $("recolor-reset"),
  recolorButton: $("recolor-button"),
  brightnessRange: $("brightness-range"),
  brightnessValue: $("brightness-value"),
  brightnessReadout: $("brightness-readout"),
  contrastRange: $("contrast-range"),
  contrastValue: $("contrast-value"),
  contrastReadout: $("contrast-readout"),
  denoise: $("denoise"),
  sharpenRange: $("sharpen-range"),
  sharpenValue: $("sharpen-value"),
  sharpenReadout: $("sharpen-readout"),
  enhanceButton: $("enhance-button"),
  historyScrim: $("history-scrim"),
  historyDrawer: $("history-drawer"),
  closeHistory: $("close-history"),
  historySummary: $("history-summary"),
  refreshHistory: $("refresh-history"),
  historyList: $("history-list"),
  historyMore: $("history-more"),
  confirmDialog: $("confirm-dialog"),
  confirmTitle: $("confirm-title"),
  confirmMessage: $("confirm-message"),
  confirmCancel: $("confirm-cancel"),
  confirmAccept: $("confirm-accept"),
  compareDialog: $("compare-dialog"),
  closeCompare: $("close-compare"),
  compareGrid: $("compare-grid"),
  aiPanel: $("ai-panel"),
  aiStateBadge: $("ai-state-badge"),
  refreshAiStatus: $("refresh-ai-status"),
  aiService: $("ai-service"),
  aiServiceDot: $("ai-service-dot"),
  aiServiceLabel: $("ai-service-label"),
  aiServiceNote: $("ai-service-note"),
  aiVectorSummary: $("ai-vector-summary"),
  aiStart: $("ai-start"),
  aiCallId: $("ai-call-id"),
  aiConsents: $("ai-consents"),
  aiConsentUpload: $("ai-consent-upload"),
  aiConsentCharge: $("ai-consent-charge"),
  aiStartButton: $("ai-start-button"),
  aiStartNote: $("ai-start-note"),
  aiError: $("ai-error"),
  aiEmpty: $("ai-empty"),
  aiPipeline: $("ai-pipeline"),
  aiPipelineTitle: $("ai-pipeline-title"),
  aiPipelineMeta: $("ai-pipeline-meta"),
  aiPipelineState: $("ai-pipeline-state"),
  aiRefreshPipeline: $("ai-refresh-pipeline"),
  aiTrace: $("ai-trace"),
  aiTraceChip: $("ai-trace-chip"),
  aiWorkflowId: $("ai-workflow-id"),
  aiWorkflowVersion: $("ai-workflow-version"),
  aiWorkflowPrompt: $("ai-workflow-prompt"),
  aiWorkflowModel: $("ai-workflow-model"),
  aiWorkflowSelection: $("ai-workflow-selection"),
  aiWorkflowInput: $("ai-workflow-input"),
  aiWorkflowNote: $("ai-workflow-note"),
  aiWorkflowSnapshot: $("ai-workflow-snapshot"),
  aiWorkflowPromptText: $("ai-workflow-prompt-text"),
  aiRecovery: $("ai-recovery"),
  aiBranches: $("ai-branches"),
  aiRerun: $("ai-rerun"),
  aiRerunInput: $("ai-rerun-input"),
  aiRerunCompose: $("ai-rerun-compose"),
  aiRerunVectorize: $("ai-rerun-vectorize"),
  aiRerunNote: $("ai-rerun-note"),
  aiRerunError: $("ai-rerun-error"),
  aiSteps: $("ai-steps"),
  aiPipelineError: $("ai-pipeline-error"),
  aiDecision: $("ai-decision"),
  aiSelectionNote: $("ai-selection-note"),
  aiUseLocal: $("ai-use-local"),
  aiReject: $("ai-reject"),
  aiCompose: $("ai-compose"),
  aiResult: $("ai-result"),
  aiResultList: $("ai-result-list"),
  aiCandidates: $("ai-candidates"),
  aiReferenceList: $("ai-reference-list"),
  aiLayerList: $("ai-layer-list"),
  aiFilter: $("ai-filter"),
  aiCandidateCount: $("ai-candidate-count"),
  aiCountAll: $("ai-count-all"),
  aiCountSelected: $("ai-count-selected"),
  aiCountReview: $("ai-count-review"),
  aiCandidateEmpty: $("ai-candidate-empty"),
  maskEmpty: $("mask-empty"),
  maskSetup: $("mask-setup"),
  maskPair: $("mask-pair"),
  maskPairNote: $("mask-pair-note"),
  maskOpen: $("mask-open"),
  repairPanel: $("repair-panel"),
  repairStateBadge: $("repair-state-badge"),
  repairRefresh: $("repair-refresh"),
  repairBboxSummary: $("repair-bbox-summary"),
  repairBboxText: $("repair-bbox-text"),
  repairFeather: $("repair-feather"),
  repairSize: $("repair-size"),
  repairCallId: $("repair-call-id"),
  repairDamageMask: $("repair-damage-mask"),
  repairDamageNote: $("repair-damage-note"),
  repairConsents: $("repair-consents"),
  repairConsentUpload: $("repair-consent-upload"),
  repairConsentCharge: $("repair-consent-charge"),
  repairStart: $("repair-start"),
  repairStartNote: $("repair-start-note"),
  repairError: $("repair-error"),
  repairEmpty: $("repair-empty"),
  repairRecord: $("repair-record"),
  repairRecordTitle: $("repair-record-title"),
  repairRecordMeta: $("repair-record-meta"),
  repairRevision: $("repair-revision"),
  repairStatus: $("repair-status"),
  repairWarnings: $("repair-warnings"),
  repairAssets: $("repair-assets"),
  repairCompare: $("repair-compare"),
  repairEditView: $("repair-edit-view"),
  repairDiffView: $("repair-diff-view"),
  repairMetrics: $("repair-metrics"),
  repairDecision: $("repair-decision"),
  repairDecisionNote: $("repair-decision-note"),
  repairFullWarning: $("repair-full-warning"),
  repairAcceptFull: $("repair-accept-full"),
  repairReject: $("repair-reject"),
  repairAccept: $("repair-accept"),
  repairDecisionResult: $("repair-decision-result"),
  repairNext: $("repair-next"),
  repairCompareDialog: $("repair-compare-dialog"),
  repairCompareSubtitle: $("repair-compare-subtitle"),
  repairCompareError: $("repair-compare-error"),
  repairCompareBody: $("repair-compare-body"),
  repairCompareNote: $("repair-compare-note"),
  closeRepairCompare: $("close-repair-compare"),
  tilePanel: $("tile-panel"),
  tileUnit: $("tile-unit"),
  tileCrop: $("tile-crop"),
  tileUnitDownload: $("tile-unit-download"),
  tileUnitPreview: $("tile-unit-preview"),
  tileUnitImage: $("tile-unit-image"),
  tileUnitName: $("tile-unit-name"),
  tileUnitMeta: $("tile-unit-meta"),
  tileSeam: $("tile-seam"),
  tileNote: $("tile-note"),
  tileError: $("tile-error"),
  tileGenerate: $("tile-generate"),
  tileResult: $("tile-result"),
  tileResultImage: $("tile-result-image"),
  tileResultMeta: $("tile-result-meta"),
  tileResultSeam: $("tile-result-seam"),
  tileDownload: $("tile-download"),
  tileZip: $("tile-zip"),
  assetPreviewDialog: $("asset-preview-dialog"),
  assetPreviewKicker: $("asset-preview-kicker"),
  assetPreviewTitle: $("asset-preview-title"),
  assetPreviewMeta: $("asset-preview-meta"),
  assetPreviewBadges: $("asset-preview-badges"),
  assetPreviewBody: $("asset-preview-body"),
  assetPreviewDownload: $("asset-preview-download"),
  closeAssetPreview: $("close-asset-preview"),
  brushDialog: $("brush-dialog"),
  brushTitle: $("brush-title"),
  brushSubtitle: $("brush-subtitle"),
  brushClose: $("brush-close"),
  brushViewport: $("brush-viewport"),
  brushCanvas: $("brush-canvas"),
  brushCursor: $("brush-cursor"),
  brushLoading: $("brush-loading"),
  brushLoadingText: $("brush-loading-text"),
  brushPairMeta: $("brush-pair-meta"),
  brushInvert: $("brush-invert"),
  brushDenoise: $("brush-denoise"),
  brushOverlay: $("brush-overlay"),
  brushCounts: $("brush-counts"),
  brushStatus: $("brush-status"),
  brushRadiusRange: $("brush-radius-range"),
  brushRadiusValue: $("brush-radius-value"),
  brushRadiusReadout: $("brush-radius-readout"),
  brushUndo: $("brush-undo"),
  brushRedo: $("brush-redo"),
  brushIterations: $("brush-iterations"),
  brushIterationsField: $("brush-iterations-field"),
  brushAlgorithmNote: $("brush-algorithm-note"),
  brushError: $("brush-error"),
  brushCancel: $("brush-cancel"),
  brushSave: $("brush-save"),
  toastRegion: $("toast-region")
};

const state = {
  health: null,
  healthError: "",
  healthBusy: false,
  healthTimer: null,
  assets: new Map(),
  versionIds: [],
  currentInputId: null,
  previewId: null,
  previewSeq: 0,
  previewLoading: false,
  previewError: "",
  previewUrls: new Map(),
  previewRequests: new Map(),
  selectedAssetIds: new Set(),
  sourceOriginal: null,
  sourceLabel: "",
  sourceNote: "",
  imageId: null,
  uploadFile: null,
  uploadMeta: null,
  uploadDuplicates: [],
  bbox: null,
  bboxDirty: false,
  bboxInputSuppressed: false,
  drag: null,
  tasks: new Map(),
  activeJobId: null,
  taskRunning: false,
  completedJobs: new Set(),
  pollTimers: new Map(),
  pollFailures: new Map(),
  pollErrors: new Map(),
  pollStopped: new Set(),
  feedbackJobId: null,
  feedbackResponses: new Map(),
  pendingSubmission: null,
  requestInFlight: false,
  duplicateSwitching: false,
  duplicateSwitchToken: 0,
  paramsRevision: 0,
  currentHasTransparency: false,
  extractModeTouched: false,
  extractModeAutoSet: false,
  workspaceHistory: createEditHistory({ limit: 80 }),
  previewSession: createPreviewSession({ ttlMs: PREVIEW_TTL_MS }),
  previewJobIds: new Set(),
  submissionSnapshots: new Map(),
  lastCommittedSnapshot: null,
  suppressHistory: false,
  paramsCommitTimer: null,
  autoPreviewTimer: null,
  previewExpiryTimer: null,
  cancelBusy: false,
  cancelError: "",
  cancelNote: "",
  cancelIntent: null,
  assetPreviewId: null,
  historyOpen: false,
  historyCloseSeq: 0,
  historyLastFocus: null,
  history: {
    items: [],
    nextCursor: null,
    loading: false,
    error: "",
    seq: 0
  },
  confirmResolver: null,
  settings: {
    loaded: false,
    loading: false,
    saving: false,
    value: null,
    revision: null,
    keyAction: "keep",
    error: "",
    message: ""
  },
  ai: {
    status: null,
    statusLoading: false,
    statusError: "",
    pipeline: null,
    layers: null,
    layerKey: "",
    selectedLayerIds: new Set(),
    filter: "all",
    layersLoading: false,
    pollTimer: null,
    pollFailures: 0,
    pollError: "",
    error: "",
    processingKey: "",
    branchJobs: new Map(),
    rerunAssetId: "",
    traceError: ""
  },
  brush: {
    pairs: [],
    selectedPairKey: "",
    open: false,
    source: null,
    mask: null,
    sourceImage: null,
    maskImage: null,
    width: 0,
    height: 0,
    baseMask: null,
    processed: null,
    invert: false,
    denoise: 0,
    overlay: true,
    mode: "add",
    algorithm: "brush",
    iterations: 5,
    radius: 6,
    history: createBrushHistory(),
    strokes: [],
    activeStroke: null,
    dirty: false,
    loading: false,
    saving: false,
    displayScale: 1,
    renderQueued: false,
    lastPointer: null
  },
  repair: {
    record: null,
    jobId: null,
    loading: false,
    error: "",
    loadSeq: 0,
    selectedAssetId: "",
    acceptFull: false,
    decisionBusy: false,
    compareView: "three",
    compareSeq: 0,
    damageSignature: "",
    damageIds: [],
    damageId: ""
  },
  tile: {
    unitId: "",
    unitSignature: "",
    rows: 2,
    cols: 2,
    seamObservation: "not_reviewed",
    jobId: null,
    job: null,
    resultAssetId: "",
    loading: false,
    error: "",
    pendingCrop: false,
    pendingCropJobId: null
  },
  recolor: {
    assetId: "",
    signature: "",
    colors: []
  }
};

function init() {
  setDefaultControls();
  wireEvents();
  renderAll();
  refreshHealth(false);
  refreshAiStatus(false);
  startHealthPolling();
}

function setDefaultControls() {
  const otsu = document.querySelector('input[name="extract-mode"][value="otsu"]');
  if (otsu) otsu.checked = true;
  const color = document.querySelector('input[name="max-colors"][value="8"]');
  if (color) color.checked = true;
  const polarity = document.querySelector('input[name="polarity"][value="dark"]');
  if (polarity) polarity.checked = true;
  const vectorMode = document.querySelector('input[name="vector-mode"][value="color"]');
  if (vectorMode) vectorMode.checked = true;
  const detail = document.querySelector('input[name="vector-detail"][value="medium"]');
  if (detail) detail.checked = true;
  syncPairedControl(dom.thresholdRange, dom.thresholdValue, false, false);
  syncPairedControl(dom.brightnessRange, dom.brightnessValue, true, true);
  syncPairedControl(dom.contrastRange, dom.contrastValue, true, true);
  syncPairedControl(dom.sharpenRange, dom.sharpenValue, true, true);
  syncPairedControl(dom.windowRange, dom.windowSize, false, false);
  syncPairedControl(dom.offsetRange, dom.offsetValue, false, false);
  syncPairedControl(dom.straightenRange, dom.straightenValue, true, false);
  updateComposeSummary();
}

/* -------------------------------------------------------------------------- */
/* Small DOM helpers                                                          */
/* -------------------------------------------------------------------------- */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function icon(name, className) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className || "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

function setText(node, value) {
  if (node) node.textContent = value === undefined || value === null ? "" : String(value);
}

function setHidden(node, hidden) {
  if (node) node.hidden = Boolean(hidden);
}

function setError(node, message) {
  if (!node) return;
  if (message) {
    node.textContent = message;
    node.hidden = false;
  } else {
    node.textContent = "";
    node.hidden = true;
  }
}

function setButtonLabel(button, label) {
  if (!button) return;
  button.textContent = label;
}

function setDisabled(button, disabled) {
  if (button) button.disabled = Boolean(disabled);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function numberValue(node, fallback) {
  if (!node) return fallback;
  const value = Number(node.value);
  return Number.isFinite(value) ? value : fallback;
}

function integerValue(node) {
  if (!node || node.value.trim() === "") return null;
  const value = Number(node.value);
  return Number.isInteger(value) ? value : null;
}

function checkedValue(name) {
  const node = document.querySelector('input[name="' + name + '"]:checked');
  return node ? node.value : "";
}

function setRadio(name, value) {
  const node = document.querySelector(
    'input[name="' + name + '"][value="' + String(value).replace(/"/g, '\\"') + '"]'
  );
  if (node) node.checked = true;
}

function normalizeKind(kind) {
  return String(kind || "asset").trim().toLowerCase().replace(/-/g, "_").replace(/\s+/g, "_");
}

function shortId(id) {
  const text = String(id || "");
  return text ? text.slice(0, 8) : "—";
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

function formatDimensions(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return "—";
  return w + " × " + h;
}

function formatPixels(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return "—";
  const pixels = w * h;
  return pixels >= 1_000_000 ? (pixels / 1_000_000).toFixed(2) + " MP" : Math.round(pixels / 1000) + "K px";
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  } catch (_) {
    return date.toLocaleString();
  }
}

function friendlyError(error) {
  if (!error) return "操作未完成，请重试。";
  if (error.code === "LICENSE_REVIEW_REQUIRED") {
    return "导出前需要确认来源授权：所选版本有未登记或“未确认”的授权。请回到版本区检查后再次导出。";
  }
  let message = error.message || String(error);
  message = message.replace(/\s+/g, " ").trim();
  if (!message) message = "操作未完成，请重试。";
  return message.length > 320 ? message.slice(0, 317) + "…" : message;
}

function newIdempotencyKey() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return "wb_" + window.crypto.randomUUID().replace(/-/g, "");
  }
  const bytes = new Uint8Array(24);
  if (window.crypto && typeof window.crypto.getRandomValues === "function") {
    window.crypto.getRandomValues(bytes);
    return "wb_" + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("当前浏览器无法生成安全提交标识。");
}

/* -------------------------------------------------------------------------- */
/* Connection health                                                         */
/* -------------------------------------------------------------------------- */

function positiveStatus(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    if (typeof value.alive === "boolean") return value.alive && !value.error;
    if (typeof value.ok === "boolean") return value.ok;
    return positiveStatus(value.status || value.state || value.health);
  }
  const word = String(value).toLowerCase();
  if (!word) return null;
  if (["false", "offline", "down", "error", "failed", "missing", "unavailable", "locked"].some((item) => word.includes(item))) {
    return false;
  }
  return ["ok", "ready", "healthy", "up", "alive", "connected", "writable", "running", "idle"].some((item) => word.includes(item));
}

function healthSummary(data) {
  if (!data) return "本机服务尚未返回状态。";
  const parts = [];
  const db = data.database ?? data.db;
  const storage = data.storage;
  const worker = data.worker;
  if (db !== undefined) parts.push(positiveStatus(db) === false ? "数据读写异常" : "数据读写正常");
  if (storage !== undefined) parts.push(positiveStatus(storage) === false ? "存储不可写" : "存储可写");
  if (worker !== undefined) parts.push(positiveStatus(worker) === false ? "处理队列未就绪" : "处理队列正常");
  if (!parts.length) return "本机服务已响应。";
  return parts.join(" · ");
}

function healthIsReady(data) {
  if (!data) return false;
  if (positiveStatus(data.status) === false) return false;
  const states = [data.database ?? data.db, data.storage, data.worker].map(positiveStatus);
  return !states.includes(false);
}

function renderHealth() {
  const chip = dom.healthChip;
  chip.classList.remove("is-ok", "is-warn", "is-danger");
  const dot = chip.querySelector(".status-dot");
  const ready = healthIsReady(state.health) && !state.healthError;

  if (state.healthError || !state.health) {
    chip.classList.add("is-danger");
    if (dot) dot.className = "status-dot is-danger";
    setText(dom.healthLabel, "连接异常");
    const message = state.healthError || "未能读取本机服务状态。";
    chip.setAttribute("aria-label", message);
    chip.title = message;
    dom.connectionMessage.textContent = message;
    setHidden(dom.connectionBanner, false);
    return;
  }

  const summary = healthSummary(state.health);
  if (!ready) {
    chip.classList.add("is-warn");
    if (dot) dot.className = "status-dot is-warn";
    setText(dom.healthLabel, "需要检查");
    chip.setAttribute("aria-label", "本机服务需要检查：" + summary);
    chip.title = "本机服务需要检查：" + summary;
    dom.connectionMessage.textContent = summary + "。你可以重试连接，本地页面不会丢失。";
    setHidden(dom.connectionBanner, false);
    return;
  }

  chip.classList.add("is-ok");
  if (dot) dot.className = "status-dot is-ok";
  setText(dom.healthLabel, "本机就绪");
  chip.setAttribute("aria-label", "本机服务已就绪：" + summary);
  chip.title = "本机服务已就绪：" + summary;
  setHidden(dom.connectionBanner, true);
}

function startHealthPolling() {
  stopHealthPolling();
  state.healthTimer = window.setInterval(() => refreshHealth(true), 30000);
}

function stopHealthPolling() {
  if (state.healthTimer) {
    window.clearInterval(state.healthTimer);
    state.healthTimer = null;
  }
}

async function refreshHealth(silent) {
  if (state.healthBusy) return;
  state.healthBusy = true;
  if (!silent) {
    dom.healthChip.classList.remove("is-ok", "is-warn", "is-danger");
    dom.healthChip.classList.add("is-warn");
    setText(dom.healthLabel, "检查中");
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(API_BASE + "/health", {
      method: "GET",
      headers: { "Accept": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal
    });
    let data = null;
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = null;
      }
    }
    if (response.status === 401 || response.status === 403) {
      throw new ApiError("本机服务仍在要求旧访问条件，请更新并重启本机服务后重试。", {
        status: response.status
      });
    }
    if (!data || typeof data !== "object") {
      throw new ApiError("本机服务没有返回可识别的状态。", { status: response.status });
    }
    state.health = data;
    state.healthError = "";
    renderHealth();
  } catch (error) {
    if (error instanceof ApiError) {
      state.healthError = friendlyError(error);
    } else if (error && error.name === "AbortError") {
      state.healthError = "连接本机服务超时，请确认服务正在运行。";
    } else {
      state.healthError = "无法连接本机服务，请确认本机工作台正在运行。";
    }
    state.health = null;
    renderHealth();
  } finally {
    window.clearTimeout(timer);
    state.healthBusy = false;
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP and write helpers                                                     */
/* -------------------------------------------------------------------------- */

class ApiError extends Error {
  constructor(message, options) {
    super(message);
    const opts = options || {};
    this.name = "ApiError";
    this.status = opts.status || 0;
    this.code = opts.code || "";
    this.network = Boolean(opts.network);
    this.unknown = Boolean(opts.unknown);
  }
}

async function fetchLocal(path, options) {
  const opts = options || {};
  const method = String(opts.method || "GET").toUpperCase();
  const headers = new Headers(opts.headers || {});
  const isWrite = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (isWrite) headers.set("X-Pattern-Studio", "local");
  let response;
  try {
    response = await fetch(API_BASE + path, {
      method,
      headers,
      body: opts.body,
      signal: opts.signal,
      credentials: "same-origin",
      cache: "no-store"
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new ApiError("请求已取消。", { network: true });
    }
    throw new ApiError("无法连接本机服务，请确认本机工作台正在运行。", { network: true });
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError("本机服务仍在要求旧访问条件。请更新并重启本机服务后重试。", {
      status: response.status
    });
  }
  return response;
}

function apiErrorFromPayload(data, status) {
  const error = data && typeof data === "object" ? data.error : null;
  const code = error && error.code ? String(error.code) : "";
  let message = error && error.message ? String(error.message) : "";
  if (!message) {
    message = status >= 500
      ? "本机服务未能完成请求。请稍后重试。"
      : "请求未被接受，请检查参数与当前状态。";
  }
  return new ApiError(message, { status: status, code: code });
}

async function requestJson(path, options) {
  const opts = options || {};
  const headers = new Headers(opts.headers || {});
  headers.set("Accept", opts.accept || "application/json");
  let body = opts.body;
  if (opts.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(opts.json);
  } else if (body !== undefined && body !== null && !(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (opts.idempotencyKey) headers.set("Idempotency-Key", opts.idempotencyKey);

  const response = await fetchLocal(path, {
    method: opts.method || "GET",
    headers: headers,
    body: body,
    signal: opts.signal
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = null;
    }
  }
  if (!response.ok) {
    throw apiErrorFromPayload(data, response.status);
  }
  return { data: data, status: response.status, headers: response.headers };
}

function startSubmission(config) {
  if (state.pendingSubmission) {
    showToast("请先处理结果未知的上一次提交。", "warning");
    return false;
  }
  if (state.requestInFlight) return false;
  if (state.duplicateSwitching) {
    showToast("正在切换已有版本，请稍候。", "warning");
    return false;
  }
  const submission = {
    path: config.path,
    method: config.method || "POST",
    key: newIdempotencyKey(),
    bodyFactory: config.bodyFactory || null,
    label: config.label || "请求",
    markBboxClean: Boolean(config.markBboxClean),
    onSuccess: config.onSuccess,
    onError: config.onError || null,
    onUnknown: config.onUnknown || null
  };
  void sendSubmission(submission);
  return true;
}

async function sendSubmission(submission) {
  if (state.requestInFlight) return;
  state.requestInFlight = true;
  renderPendingBanner();
  updateActionState();

  let result;
  try {
    const body = submission.bodyFactory ? submission.bodyFactory() : undefined;
    result = await requestJson(submission.path, {
      method: submission.method,
      body: body,
      idempotencyKey: submission.key
    });
  } catch (error) {
    state.requestInFlight = false;
    const uncertain = error instanceof ApiError &&
      (error.network || [500, 502, 504].includes(error.status));
    if (uncertain) {
      state.pendingSubmission = submission;
      renderPendingBanner();
      if (submission.onUnknown) submission.onUnknown(error);
      showToast("提交结果未知。页面不会自动重发，请用同一请求重试。", "warning", 7000);
    } else {
      if (state.pendingSubmission === submission) state.pendingSubmission = null;
      if (submission.onError) {
        submission.onError(error);
      } else {
        showToast(friendlyError(error), "error");
      }
      renderPendingBanner();
    }
    updateActionState();
    return;
  }

  state.pendingSubmission = null;
  if (submission.markBboxClean) markBboxCommitted();
  renderPendingBanner();

  try {
    if (submission.onSuccess) await submission.onSuccess(result.data, result.status, result.headers);
  } catch (error) {
    if (submission.onError) submission.onError(error);
    else showToast(friendlyError(error), "error");
  } finally {
    state.requestInFlight = false;
    updateActionState();
    renderPendingBanner();
  }
}

function retryPendingSubmission() {
  if (!state.pendingSubmission) return;
  if (state.requestInFlight) return;
  const submission = state.pendingSubmission;
  setDisabled(dom.pendingRetry, true);
  void sendSubmission(submission);
}

async function discardPendingSubmission() {
  if (!state.pendingSubmission) return;
  const ok = await confirmAction({
    title: "放弃结果未知的提交？",
    message: "服务器可能已经创建了图像或任务。放弃后，本页不会自动重试，也不会复用原提交。请先在历史抽屉中核对，再决定是否重新操作。",
    confirmLabel: "放弃并继续",
    cancelLabel: "保留重试机会",
    tone: "danger"
  });
  if (!ok) return;
  state.pendingSubmission = null;
  renderPendingBanner();
  updateActionState();
  showToast("已放弃本页的重试记录。服务器端成果请以历史记录为准。", "warning", 6000);
}

function renderPendingBanner() {
  const pending = state.pendingSubmission;
  setHidden(dom.pendingBanner, !pending);
  if (!pending) return;
  dom.pendingMessage.textContent =
    "上一次「" + pending.label + "」提交没有得到确定响应。为避免重复创建，请在恢复连接后用同一提交重试；页面不会自动重新提交。";
  dom.pendingRetry.title = "复用原请求与相同的提交标识";
  setDisabled(dom.pendingRetry, state.requestInFlight);
  setDisabled(dom.pendingDiscard, state.requestInFlight);
}

/* -------------------------------------------------------------------------- */
/* Workspace lifecycle                                                       */
/* -------------------------------------------------------------------------- */

function resetWorkspace(options) {
  const opts = options || {};
  for (const timer of state.pollTimers.values()) window.clearTimeout(timer);
  state.pollTimers.clear();
  state.pollFailures.clear();
  state.pollErrors.clear();
  state.pollStopped.clear();
  state.assets.clear();
  state.versionIds = [];
  state.currentInputId = null;
  state.previewId = null;
  state.previewSeq += 1;
  state.previewLoading = false;
  state.previewError = "";
  state.selectedAssetIds.clear();
  clearPreviewUrls();
  state.sourceOriginal = null;
  state.sourceLabel = "";
  state.sourceNote = "";
  state.imageId = null;
  state.uploadMeta = null;
  state.uploadDuplicates = [];
  setHidden(dom.qualitySummary, true);
  setHidden(dom.duplicateBanner, true);
  setHidden(dom.gradeChip, true);
  setHidden(dom.qualityNote, true);
  dom.duplicateList.replaceChildren();
  state.bbox = null;
  state.bboxDirty = false;
  state.drag = null;
  state.paramsRevision = 0;
  state.currentHasTransparency = false;
  if (state.paramsCommitTimer) {
    window.clearTimeout(state.paramsCommitTimer);
    state.paramsCommitTimer = null;
  }
  if (state.autoPreviewTimer) {
    window.clearTimeout(state.autoPreviewTimer);
    state.autoPreviewTimer = null;
  }
  clearPreviewExpiry();
  state.previewSession.clear();
  state.previewJobIds.clear();
  state.submissionSnapshots.clear();
  state.workspaceHistory.reset(null);
  state.lastCommittedSnapshot = null;
  state.suppressHistory = false;
  state.cancelBusy = false;
  state.cancelError = "";
  state.cancelNote = "";
  state.cancelIntent = null;
  state.tasks.clear();
  state.activeJobId = null;
  state.taskRunning = false;
  state.completedJobs.clear();
  state.feedbackJobId = null;
  state.feedbackResponses.clear();
  if (dom.brushDialog.open) closeBrushEditor(true);
  if (dom.repairCompareDialog.open) dom.repairCompareDialog.close();
  resetAiState();
  resetRepairState();
  resetTileState();
  state.recolor.assetId = "";
  state.recolor.signature = "";
  state.recolor.colors = [];
  if (opts.clearUpload !== false) {
    state.uploadFile = null;
    dom.imageFile.value = "";
    dom.sourceNote.value = "";
  }
  dom.previewImage.removeAttribute("src");
  setError(dom.uploadError, "");
  setError(dom.workingError, "");
  setError(dom.bboxError, "");
  setError(dom.composeError, "");
  setError(dom.exportError, "");
  setError(dom.feedbackError, "");
  dom.feedbackForm.reset();
  resetCanvas();
  closeCompareIfOpen();
  renderAll();
}

function resetHistoryState() {
  state.history.items = [];
  state.history.nextCursor = null;
  state.history.loading = false;
  state.history.error = "";
  state.history.seq += 1;
  renderHistory();
}

function resumeJobPolling() {
  if (!state.activeJobId) return;
  const job = state.tasks.get(state.activeJobId);
  if (!job || !isJobActive(job)) return;
  if (state.pollTimers.has(job.job_id) || state.pollStopped.has(job.job_id)) return;
  scheduleJobPoll(job.job_id, 900);
}

/* -------------------------------------------------------------------------- */
/* Asset registry and version list                                           */
/* -------------------------------------------------------------------------- */

function assetIdOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value.asset_id || value.id || "");
}

function assetWidth(asset) {
  const value = Number(asset && asset.width);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function assetHeight(asset) {
  const value = Number(asset && asset.height);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function assetPixels(asset) {
  const width = assetWidth(asset);
  const height = assetHeight(asset);
  return width && height ? width * height : 0;
}

function assetMime(asset) {
  return String((asset && (asset.mime_type || asset.media_type || asset.content_type || asset.mime)) || "").toLowerCase();
}

function assetIsSvg(asset) {
  const kind = normalizeKind(asset && asset.kind);
  return kind.includes("svg") || assetMime(asset).includes("svg");
}

function assetIsArchive(asset) {
  const kind = normalizeKind(asset && asset.kind);
  return kind.includes("export") || kind.includes("archive") || kind.includes("zip") || assetMime(asset).includes("zip");
}

function assetIsMask(asset) {
  return normalizeKind(asset && asset.kind).includes("mask");
}

function assetIsForegroundMask(asset) {
  return normalizeKind(asset && asset.kind) === "foreground_mask";
}

function assetIsPreviewable(asset) {
  return Boolean(asset) && !assetIsArchive(asset);
}

function assetIsInputCapable(asset) {
  if (!asset || assetIsArchive(asset) || assetIsSvg(asset) || assetIsMask(asset)) return false;
  const context = assetContext(asset);
  const repairRole = context.repairRole;
  if (repairRole && repairRole !== "accepted") return false;
  if (context.jobKind === "repair" && normalizeKind(asset.kind) === "edit_candidate") return false;
  const allowed = ["normalized_input", "cropped", "working_copy", "prepared", "enhanced", "transparent_png",
    "edit_candidate", "placed_generated_layer", "generated_basemap", "generated_layer", "composed_candidate",
    "accepted_repair"];
  if (!allowed.includes(normalizeKind(asset.kind))) return false;
  const mime = assetMime(asset);
  if (mime && !["image/png", "image/jpeg", "image/jpg"].includes(mime)) return false;
  return Boolean(assetWidth(asset) && assetHeight(asset)) || !mime;
}

function assetContext(asset) {
  return (asset && asset._context) || {};
}

function assetIsAi(asset) {
  if (!asset) return false;
  const kind = normalizeKind(asset.kind);
  return Boolean(asset.ai_inferred || assetContext(asset).aiCandidate || assetContext(asset).acceptedRepair ||
    kind === "composed_candidate" || kind === "accepted_repair" || kind === "repair_composite" ||
    kind.includes("ai_layer"));
}

function assetGeometryVerified(asset) {
  return Boolean(asset && asset.geometry_verified);
}

function assetDisplayName(asset) {
  if (!asset) return "未命名版本";
  const context = assetContext(asset);
  if (context.aiReferenceOnly) return "AI 底图（仅参考）";
  if (context.aiLayer) return "AI 候选层";
  if (context.repairRole === "full") return "修复全图候选";
  if (context.repairRole === "local") return "修复局部保护版";
  if (context.repairRole === "editMask") return "修复编辑区域";
  if (context.repairRole === "difference") return "修复差异图";
  if (context.repairRole === "blendWeight") return "羽化权重";
  if (context.repairRole === "accepted") return "已接受修复";
  if (context.tilePreview) return "平铺预览";
  const kind = normalizeKind(asset.kind);
  let label = KIND_LABELS[kind];
  if (!label && kind.includes("svg")) {
    label = kind.includes("mono") || kind.includes("black") ? "黑白 SVG" : kind.includes("color") ? "彩色 SVG" : "SVG";
  }
  if (!label) label = "成果";
  if (kind === "svg" || kind.includes("svg") || kind === "vector") {
    const mode = (asset.parameters && asset.parameters.mode) ||
      (context.jobParameters && context.jobParameters.vector && context.jobParameters.vector.mode) ||
      (context.jobKind === "vectorize" && context.jobParameters && context.jobParameters.mode);
    if (mode === "monochrome") label = "黑白 SVG";
    if (mode === "color") label = "彩色 SVG";
  }
  return label;
}

function jobIdOf(job) {
  return String((job && (job.job_id || job.pipeline_id || job.id)) || "");
}

function normalizeJob(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = jobIdOf(raw);
  if (!id) return null;
  return Object.assign({}, raw, { job_id: id });
}

async function fetchAssetMetadata(assetId) {
  const result = await requestJson("/assets/" + encodeURIComponent(assetId));
  if (!result.data || typeof result.data !== "object") {
    throw new ApiError("资产元数据为空。", { status: result.status });
  }
  return result.data.asset && typeof result.data.asset === "object" ? result.data.asset : result.data;
}

async function hydrateAsset(raw, context) {
  const initial = typeof raw === "string" ? { asset_id: raw } : Object.assign({}, raw || {});
  const id = assetIdOf(initial);
  if (!id) return null;
  const cached = state.assets.get(id);
  let asset = Object.assign({}, cached || {}, initial, { asset_id: id });
  const needsMetadata = !cached || !asset.kind || asset.width === undefined || asset.height === undefined;
  if (needsMetadata) {
    try {
      const metadata = await fetchAssetMetadata(id);
      asset = Object.assign({}, asset, metadata, { asset_id: id });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw error;
      asset._metaError = friendlyError(error);
    }
  }
  asset._context = Object.assign({}, cached ? cached._context : null, context || {});
  return asset;
}

async function registerAssets(rawAssets, options) {
  const opts = options || {};
  const raws = (rawAssets || []).filter(Boolean);
  if (!raws.length) return [];
  const context = Object.assign({}, opts.context || {}, { addedAt: Date.now() });
  const hydrated = await Promise.all(raws.map((raw) => hydrateAsset(raw, context)));
  const fresh = [];
  const freshIds = [];
  for (const asset of hydrated) {
    if (!asset) continue;
    const id = asset.asset_id;
    const existing = state.assets.get(id);
    if (!existing) {
      asset._isNewUntil = Date.now() + 45000;
      fresh.push(asset);
      freshIds.push(id);
    } else {
      state.assets.set(id, Object.assign({}, existing, asset));
    }
  }
  for (const asset of fresh) state.assets.set(asset.asset_id, asset);
  if (opts.includeInVersions === false) {
    // Preview-only registration: metadata is available for the canvas and task
    // results, but the version filmstrip changes only when the preview is applied.
  } else if (freshIds.length) {
    if (opts.prepend === false) {
      for (const id of freshIds) {
        if (!state.versionIds.includes(id)) state.versionIds.push(id);
      }
    } else {
      state.versionIds = freshIds.concat(state.versionIds.filter((id) => !freshIds.includes(id)));
    }
  }
  const unique = [];
  for (const id of state.versionIds) {
    if (state.assets.has(id) && !unique.includes(id)) unique.push(id);
  }
  state.versionIds = unique;
  return hydrated.filter(Boolean);
}

function currentAsset() {
  return state.currentInputId ? state.assets.get(state.currentInputId) || null : null;
}

function previewAsset() {
  return state.previewId ? state.assets.get(state.previewId) || null : null;
}

function isPreviewCurrent() {
  return Boolean(state.currentInputId && state.previewId && state.currentInputId === state.previewId);
}

function jobContext(job) {
  const parameters = job && job.parameters && typeof job.parameters === "object" ? job.parameters : {};
  return {
    origin: "job",
    jobId: jobIdOf(job),
    jobKind: String(job.kind || ""),
    jobParameters: parameters,
    jobState: job.state || "",
    aiPipelineId: String(job.ai_pipeline_id || parameters.ai_pipeline_id || "")
  };
}

function renderVersions() {
  const ids = state.versionIds.filter((id) => state.assets.has(id));
  state.versionIds = ids;
  setText(dom.versionCount, ids.length);
  setHidden(dom.versionEmpty, ids.length > 0);
  dom.versionList.replaceChildren();
  if (!ids.length) {
    updateSelectionBar();
    return;
  }

  for (const id of ids) {
    const asset = state.assets.get(id);
    const item = element("article", "version-item");
    item.setAttribute("role", "listitem");
    const isCurrent = id === state.currentInputId;
    const isPreview = id === state.previewId;
    if (isCurrent) item.classList.add("is-current");
    if (isPreview) item.classList.add("is-preview");
    if (state.selectedAssetIds.has(id)) item.classList.add("is-selected");

    const label = element("label", "version-select");
    label.title = "选择此版本用于 ZIP";
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedAssetIds.has(id);
    checkbox.dataset.assetId = id;
    checkbox.className = "version-checkbox";
    checkbox.setAttribute("aria-label", "选择" + assetDisplayName(asset) + "用于打包 ZIP");
    label.append(checkbox);

    const copy = element("div", "version-copy");
    const titleRow = element("div", "version-title");
    titleRow.append(element("span", "version-kind", assetDisplayName(asset)));
    const badges = element("span", "version-badges");
    if (isCurrent) badges.append(element("span", "mini-badge is-current", "当前输入"));
    if (isPreview && !isCurrent) badges.append(element("span", "mini-badge is-preview", "预览中"));
    if (assetIsAi(asset)) {
      badges.append(element("span", "mini-badge is-ai", "AI 候选"));
      if (!assetGeometryVerified(asset)) badges.append(element("span", "mini-badge is-unverified", "几何未核验"));
    }
    const assetGrade = String(asset.grade || "").toUpperCase();
    if (["original", "normalized_input"].includes(asset.kind) && ["A", "B", "C"].includes(assetGrade)) {
      const gradeBadge = element("span", "mini-badge", assetGrade + " 级");
      gradeBadge.title = "质量分级在 512 参考画布上测量；仅供参考";
      badges.append(gradeBadge);
    }
    if (["original", "normalized_input"].includes(asset.kind)) {
      const licenseName = String(asset.license || "未确认").trim() || "未确认";
      if (licenseName === "未确认") {
        badges.append(element("span", "mini-badge is-unverified", "授权未确认"));
      }
    }
    const patternQuality = asset.quality_metrics && typeof asset.quality_metrics === "object"
      ? asset.quality_metrics
      : null;
    if (patternQuality && Array.isArray(patternQuality.warnings) && patternQuality.warnings.length) {
      const warningBadge = element("span", "mini-badge is-unverified", "候选存疑");
      warningBadge.title = patternQuality.warnings
        .map((code) => PATTERN_WARNING_LABELS[code] || code)
        .join("；");
      badges.append(warningBadge);
    }
    if (asset._isNewUntil && Date.now() < asset._isNewUntil) badges.append(element("span", "mini-badge", "新"));
    if (badges.childNodes.length) titleRow.append(badges);
    copy.append(titleRow);

    const metaParts = [];
    if (assetWidth(asset) && assetHeight(asset)) metaParts.push(formatDimensions(assetWidth(asset), assetHeight(asset)));
    if (assetIsArchive(asset)) metaParts.push("压缩包");
    else if (assetIsMask(asset)) metaParts.push("蒙版");
    else if (assetIsSvg(asset)) metaParts.push("矢量");
    if (patternQuality && patternQuality.pattern_score != null) {
      metaParts.push("纹样性 " + Number(patternQuality.pattern_score).toFixed(2));
    }
    metaParts.push("#" + shortId(id));
    copy.append(element("div", "version-meta", metaParts.join(" · ")));
    if (asset._metaError) {
      const error = element("div", "version-meta", "元数据读取失败");
      error.title = asset._metaError;
      copy.append(error);
    }

    const actions = element("div", "version-actions");
    const previewButton = element("button", "icon-button");
    previewButton.type = "button";
    previewButton.dataset.versionAction = "preview";
    previewButton.dataset.assetId = id;
    previewButton.title = assetIsPreviewable(asset) ? "预览此版本" : "此压缩包不支持预览";
    previewButton.setAttribute("aria-label", "预览" + assetDisplayName(asset));
    previewButton.append(icon("image"));
    previewButton.disabled = !assetIsPreviewable(asset);
    actions.append(previewButton);

    const inputButton = element("button", "icon-button");
    inputButton.type = "button";
    inputButton.dataset.versionAction = "input";
    inputButton.dataset.assetId = id;
    inputButton.title = assetIsInputCapable(asset) ? "设为当前输入" : "此版本不能作为图像输入";
    inputButton.setAttribute("aria-label", "将" + assetDisplayName(asset) + "设为当前输入");
    inputButton.append(icon("arrow"));
    inputButton.disabled = !assetIsInputCapable(asset);
    actions.append(inputButton);

    const downloadButton = element("button", "icon-button");
    downloadButton.type = "button";
    downloadButton.dataset.versionAction = "download";
    downloadButton.dataset.assetId = id;
    downloadButton.title = "下载此版本";
    downloadButton.setAttribute("aria-label", "下载" + assetDisplayName(asset));
    downloadButton.append(icon("download"));
    actions.append(downloadButton);

    item.append(label, copy, actions);
    dom.versionList.append(item);
  }
  updateSelectionBar();
}

function renderSelectionClasses() {
  const items = dom.versionList.querySelectorAll(".version-item");
  items.forEach((item) => {
    const checkbox = item.querySelector(".version-checkbox");
    const id = checkbox ? checkbox.dataset.assetId : "";
    item.classList.toggle("is-selected", Boolean(id && state.selectedAssetIds.has(id)));
  });
}

function updateSelectionBar() {
  const count = state.selectedAssetIds.size;
  setText(dom.selectionCount, count ? "已选 " + count + " 个版本" : "未选择版本");
  setText(dom.exportButton, count ? "打包 ZIP（" + count + "）" : "打包 ZIP");
  setDisabled(dom.clearSelection, count === 0);
}

function toggleVersionSelection(assetId, checked) {
  if (checked) state.selectedAssetIds.add(assetId);
  else state.selectedAssetIds.delete(assetId);
  setError(dom.exportError, "");
  renderSelectionClasses();
  updateSelectionBar();
  updateActionState();
}

function clearSelection() {
  state.selectedAssetIds.clear();
  renderSelectionClasses();
  updateSelectionBar();
  updateActionState();
  setError(dom.exportError, "");
}

/* -------------------------------------------------------------------------- */
/* Current input, working copy and preview                                    */
/* -------------------------------------------------------------------------- */

function renderCurrentInfo() {
  const asset = currentAsset();
  setHidden(dom.sourceState, !asset);
  if (!asset) {
    setText(dom.currentName, "尚未载入图像");
    setText(dom.currentKind, "等待上传");
    setText(dom.originalDims, "—");
    setText(dom.workingDims, "—");
    setText(dom.coordinateId, "—");
    dom.sourceNoteDisplay.hidden = true;
    dom.sourceNoteDisplay.textContent = "";
    setHidden(dom.largeWarning, true);
    setHidden(dom.previewModeBadge, true);
    setHidden(dom.previewWatermark, true);
    setHidden(dom.gradeChip, true);
    setHidden(dom.qualityNote, true);
    dom.selectionLayer.classList.add("is-disabled");
    dom.canvasHint.textContent = "上传后可拖拽框选；数值坐标始终使用当前输入的真实像素。";
    return;
  }

  setText(dom.currentName, assetIsAi(asset) ? assetDisplayName(asset) : (state.sourceLabel || assetDisplayName(asset)));
  let kindText = assetDisplayName(asset) + " · #" + shortId(asset.asset_id);
  if (assetIsAi(asset)) {
    kindText += " · AI 候选" + (assetGeometryVerified(asset) ? "" : " · 几何未核验");
  }
  setText(dom.currentKind, kindText);

  const currentGrade = String(asset.grade || "").toUpperCase();
  const hasGrade = ["A", "B", "C"].includes(currentGrade);
  setHidden(dom.gradeChip, !hasGrade);
  if (hasGrade) {
    setText(dom.gradeChip, currentGrade + " 级");
    dom.gradeChip.className = "chip grade-chip is-" + currentGrade.toLowerCase();
    dom.gradeChip.title = QUALITY_GRADE_HINTS[currentGrade] || "质量参考";
  }
  renderQualityNote(asset);

  if (state.sourceOriginal && state.sourceOriginal.width && state.sourceOriginal.height) {
    setText(dom.originalDims, formatDimensions(state.sourceOriginal.width, state.sourceOriginal.height));
  } else {
    setText(dom.originalDims, "—");
  }
  const width = assetWidth(asset);
  const height = assetHeight(asset);
  setText(dom.workingDims, width && height ? formatDimensions(width, height) + " · " + formatPixels(width, height) : "—");
  const coordinate = asset.coordinate_space_id || asset.coordinate_space || "";
  setText(dom.coordinateId, coordinate ? String(coordinate).slice(0, 12) : "—");
  dom.coordinateId.title = coordinate ? String(coordinate) : "";

  if (state.sourceNote) {
    dom.sourceNoteDisplay.textContent = "来源备注：" + state.sourceNote;
    dom.sourceNoteDisplay.hidden = false;
  } else {
    dom.sourceNoteDisplay.textContent = "";
    dom.sourceNoteDisplay.hidden = true;
  }

  const pixels = width * height;
  const tooLarge = pixels > PROCESS_PIXEL_LIMIT;
  setHidden(dom.largeWarning, !tooLarge);
  if (tooLarge) {
    dom.largeWarningText.textContent =
      "当前输入为 " + formatDimensions(width, height) + "（" + formatPixels(width, height) +
      "），超过本地处理上限 " + PROCESS_PIXEL_LIMIT.toLocaleString("zh-CN") + " 像素。不会自动缩小，请明确创建工作副本。";
  }

  const previewingOther = Boolean(state.previewId && state.currentInputId && state.previewId !== state.currentInputId);
  const pendingPreview = Boolean(state.previewSession.current());
  setHidden(dom.previewModeBadge, !previewingOther || pendingPreview);
  setHidden(dom.previewWatermark, !previewingOther);
  dom.selectionLayer.classList.toggle("is-disabled", !isPreviewCurrent());
  dom.canvasHint.textContent = pendingPreview
    ? "画布显示的是未应用预览；应用或放弃后才会改变当前输入与版本。"
    : previewingOther
      ? "正在预览其他成果。框选只作用于当前输入；回到当前输入或用版本区的“设为输入”后才能继续处理。"
      : tooLarge
        ? "大图不会自动缩小。请先在工作副本中明确设置像素上限，再执行本地处理。"
        : "在图像上拖拽可框选；数值坐标始终使用当前输入的真实像素。";

  renderWorkingProjection();
}

function renderWorkingProjection() {
  const asset = currentAsset();
  const maxPixels = integerValue(dom.workingMax);
  if (!asset) {
    dom.workingProjection.textContent = "上传后可估算处理尺寸。";
    return;
  }
  const width = assetWidth(asset);
  const height = assetHeight(asset);
  const pixels = width * height;
  if (maxPixels === null || maxPixels < WORKING_COPY_MIN || maxPixels > WORKING_COPY_MAX) {
    dom.workingProjection.textContent = "请输入 10,000–1,000,000 之间的整数像素上限。";
    return;
  }
  if (!width || !height) {
    dom.workingProjection.textContent = "当前版本尺寸尚未读取。";
    return;
  }
  if (maxPixels >= pixels) {
    dom.workingProjection.textContent = "目标上限不小于当前 " + formatPixels(width, height) + "，不会缩小；如需副本请降低上限。";
    return;
  }
  const scale = Math.sqrt(maxPixels / pixels);
  const targetWidth = Math.max(1, Math.floor(width * scale));
  const targetHeight = Math.max(1, Math.floor(height * scale));
  dom.workingProjection.textContent =
    "预计约 " + formatDimensions(targetWidth, targetHeight) + "，保持比例；实际尺寸以任务结果为准。";
}

async function setPreview(assetId, options) {
  const opts = options || {};
  const asset = state.assets.get(assetId);
  if (!asset) return false;
  if (!opts.skipGuard && (state.requestInFlight || state.taskRunning || state.pendingSubmission || state.duplicateSwitching)) {
    showToast("当前有提交或任务正在处理，完成后才能切换画布。", "warning");
    return false;
  }
  if (!opts.skipGuard && !(await guardUnsavedBrush("切换到「" + assetDisplayName(asset) + "」"))) {
    return false;
  }
  if (opts.makeCurrent && !assetIsInputCapable(asset)) {
    showToast("此版本不能作为图像输入。", "warning");
    return false;
  }
  const previewChanged = state.previewId !== assetId;
  const currentChanged = opts.makeCurrent && state.currentInputId !== assetId;
  if (!previewChanged && !currentChanged) return true;
  if (!opts.skipGuard && state.previewSession.current()) {
    if (!(await guardPendingPreview("切换到「" + assetDisplayName(asset) + "」"))) return false;
  }

  if (!opts.skipGuard && state.bboxDirty) {
    const ok = await guardUnsavedBBox("切换到「" + assetDisplayName(asset) + "」");
    if (!ok) return false;
    clearBBox();
  }

  if (currentChanged) {
    state.currentInputId = assetId;
    state.currentHasTransparency = Boolean(
      asset.normalization && asset.normalization.has_transparency === true
    );
    clearBBox();
    if (state.autoPreviewTimer) {
      window.clearTimeout(state.autoPreviewTimer);
      state.autoPreviewTimer = null;
    }
    const session = state.previewSession.current();
    if (session) {
      clearPreviewExpiry();
      releasePreviewAssets(session);
      state.previewSession.clear();
    }
    state.paramsRevision += 1;
  }
  if (previewChanged) state.previewId = assetId;
  renderAll();
  await loadPreview();
  if (currentChanged) {
    commitWorkspace({ label: "切换当前输入" });
  }
  return true;
}

async function backToCurrentInput() {
  if (!state.currentInputId) return;
  await setPreview(state.currentInputId, {});
}

async function loadPreview() {
  const assetId = state.previewId;
  if (!assetId) {
    resetCanvas();
    return;
  }
  const asset = state.assets.get(assetId);
  const seq = ++state.previewSeq;
  state.previewLoading = true;
  state.previewError = "";
  showCanvasLoading();
  try {
    const url = await getPreviewUrl(assetId);
    if (seq !== state.previewSeq || state.previewId !== assetId) return;
    await loadImageUrl(url, asset, seq);
  } catch (error) {
    if (seq !== state.previewSeq) return;
    state.previewLoading = false;
    state.previewError = friendlyError(error);
    dom.canvasErrorText.textContent = state.previewError;
    setHidden(dom.canvasLoading, true);
    setHidden(dom.canvasFrame, true);
    setHidden(dom.canvasEmpty, true);
    setHidden(dom.canvasError, false);
    dom.canvasStage.classList.remove("is-ready");
  }
}

function loadImageUrl(url, asset, seq) {
  return new Promise((resolve, reject) => {
    const image = dom.previewImage;
    image.onload = null;
    image.onerror = null;
    const finish = () => {
      image.onload = null;
      image.onerror = null;
      if (seq !== state.previewSeq) {
        resolve();
        return;
      }
      state.previewLoading = false;
      state.previewError = "";
      image.alt = (asset ? assetDisplayName(asset) : "版本") + " 预览";
      setHidden(dom.canvasEmpty, true);
      setHidden(dom.canvasLoading, true);
      setHidden(dom.canvasError, true);
      setHidden(dom.canvasFrame, false);
      dom.canvasStage.classList.add("is-ready");
      fitPreview();
      renderBboxOverlay();
      resolve();
    };
    image.onload = finish;
    image.onerror = () => {
      image.onload = null;
      image.onerror = null;
      reject(new ApiError("预览图像无法解码。", { status: 0 }));
    };
    image.src = url;
    if (image.complete && image.naturalWidth > 0) {
      window.requestAnimationFrame(finish);
    }
  });
}

function fitPreview() {
  const image = dom.previewImage;
  if (!image.naturalWidth || !image.naturalHeight || dom.canvasFrame.hidden) return;
  const width = Math.max(1, dom.canvasStage.clientWidth - 32);
  const height = Math.max(1, Math.min(dom.canvasStage.clientHeight - 40, window.innerHeight * 0.82));
  const scale = Math.min(4, width / image.naturalWidth, height / image.naturalHeight);
  dom.canvasFrame.style.width = Math.max(1, image.naturalWidth * scale) + "px";
  image.style.width = "100%";
  renderBboxOverlay();
}

window.addEventListener("resize", fitPreview);

function showCanvasLoading() {
  setHidden(dom.canvasEmpty, true);
  setHidden(dom.canvasError, true);
  setHidden(dom.canvasFrame, true);
  setHidden(dom.canvasLoading, false);
  dom.canvasStage.classList.remove("is-ready");
}

function resetCanvas() {
  dom.previewImage.onload = null;
  dom.previewImage.onerror = null;
  dom.previewImage.removeAttribute("src");
  dom.previewImage.alt = "";
  setHidden(dom.canvasEmpty, false);
  setHidden(dom.canvasLoading, true);
  setHidden(dom.canvasError, true);
  setHidden(dom.canvasFrame, true);
  setHidden(dom.selectionBox, true);
  dom.canvasStage.classList.remove("is-ready");
}

async function getPreviewUrl(assetId) {
  if (state.previewUrls.has(assetId)) return state.previewUrls.get(assetId).url;
  if (state.previewRequests.has(assetId)) return state.previewRequests.get(assetId);
  const request = (async () => {
    const response = await fetchLocal("/assets/" + encodeURIComponent(assetId) + "/preview", {
      headers: { "Accept": "image/*,image/svg+xml" }
    });
    if (!response.ok) {
      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }
      throw apiErrorFromPayload(data, response.status);
    }
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.startsWith("image/") && !contentType.startsWith("application/svg")) {
      throw new ApiError("预览响应不是受支持的图像类型。", { status: response.status });
    }
    const blob = await response.blob();
    if (!blob.size) throw new ApiError("预览响应为空。", { status: response.status });
    const url = URL.createObjectURL(blob);
    state.previewUrls.set(assetId, { url: url, type: blob.type || contentType });
    return url;
  })();
  state.previewRequests.set(assetId, request);
  try {
    return await request;
  } finally {
    state.previewRequests.delete(assetId);
  }
}

function clearPreviewUrls() {
  for (const item of state.previewUrls.values()) {
    if (item && item.url) URL.revokeObjectURL(item.url);
  }
  state.previewUrls.clear();
  state.previewRequests.clear();
}

/* -------------------------------------------------------------------------- */
/* Bounding box and canvas interaction                                       */
/* -------------------------------------------------------------------------- */

function validBboxForAsset(bbox, asset) {
  if (!bbox || !asset) return false;
  const width = assetWidth(asset);
  const height = assetHeight(asset);
  const left = Number(bbox.left);
  const top = Number(bbox.top);
  const right = Number(bbox.right);
  const bottom = Number(bbox.bottom);
  return (
    Number.isInteger(left) && Number.isInteger(top) && Number.isInteger(right) && Number.isInteger(bottom) &&
    left >= 0 && top >= 0 && right > left && bottom > top && right <= width && bottom <= height
  );
}

function readBboxInputs() {
  const asset = currentAsset();
  const left = integerValue(dom.bboxLeft);
  const top = integerValue(dom.bboxTop);
  const right = integerValue(dom.bboxRight);
  const bottom = integerValue(dom.bboxBottom);
  if (left === null || top === null || right === null || bottom === null) {
    return { ok: false, error: "请填写四个整数坐标。" };
  }
  if (!asset) return { ok: false, error: "尚未载入当前输入。" };
  const bbox = { left: left, top: top, right: right, bottom: bottom };
  if (!validBboxForAsset(bbox, asset)) {
    const width = assetWidth(asset);
    const height = assetHeight(asset);
    return {
      ok: false,
      error: "矩形需满足 0 ≤ 左 < 右 ≤ " + width + "，0 ≤ 上 < 下 ≤ " + height + "。"
    };
  }
  return { ok: true, bbox: bbox };
}

function updateBboxOverlay(bboxOverride) {
  const bbox = bboxOverride || state.bbox;
  const asset = currentAsset();
  if (!bbox || !asset || !isPreviewCurrent() || !validBboxForAsset(bbox, asset)) {
    setHidden(dom.selectionBox, true);
    return;
  }
  const width = assetWidth(asset);
  const height = assetHeight(asset);
  const left = (bbox.left / width) * 100;
  const top = (bbox.top / height) * 100;
  const boxWidth = ((bbox.right - bbox.left) / width) * 100;
  const boxHeight = ((bbox.bottom - bbox.top) / height) * 100;
  dom.selectionBox.style.left = left + "%";
  dom.selectionBox.style.top = top + "%";
  dom.selectionBox.style.width = boxWidth + "%";
  dom.selectionBox.style.height = boxHeight + "%";
  dom.selectionLabel.textContent =
    bbox.right - bbox.left + " × " + (bbox.bottom - bbox.top) + " px";
  setHidden(dom.selectionBox, false);
}

function fillBboxInputs(bbox) {
  state.bboxInputSuppressed = true;
  dom.bboxLeft.value = bbox ? bbox.left : "";
  dom.bboxTop.value = bbox ? bbox.top : "";
  dom.bboxRight.value = bbox ? bbox.right : "";
  dom.bboxBottom.value = bbox ? bbox.bottom : "";
  state.bboxInputSuppressed = false;
}

function setBbox(bbox, dirty) {
  state.bbox = bbox;
  state.bboxDirty = Boolean(dirty);
  fillBboxInputs(bbox);
  setError(dom.bboxError, "");
  renderBboxOverlay();
  renderBboxControls();
  updateActionState();
}

function clearBBox() {
  state.bbox = null;
  state.bboxDirty = false;
  fillBboxInputs(null);
  setError(dom.bboxError, "");
  setHidden(dom.selectionBox, true);
  renderBboxControls();
  updateActionState();
}

function markBboxCommitted() {
  if (!state.bbox) return;
  state.bboxDirty = false;
  renderBboxControls();
  updateActionState();
}

function renderBboxOverlay() {
  const asset = currentAsset();
  if (asset) {
    dom.bboxLeft.max = String(Math.max(0, assetWidth(asset) - 1));
    dom.bboxRight.max = String(assetWidth(asset));
    dom.bboxTop.max = String(Math.max(0, assetHeight(asset) - 1));
    dom.bboxBottom.max = String(assetHeight(asset));
  }
  dom.selectionLayer.classList.toggle("is-disabled", !canDrawBbox());
  updateBboxOverlay();
}

function renderBboxControls() {
  const editable = canEditBbox();
  dom.bboxFieldset.disabled = !editable;
  const statusParent = dom.bboxStatus.parentElement;
  statusParent.classList.toggle("is-dirty", state.bboxDirty);
  if (!state.bbox) {
    dom.bboxStateDot.className = "status-dot " + (state.bboxDirty ? "is-warn" : "");
    setText(dom.bboxStatus, state.bboxDirty ? "坐标无效 · 未提交" : "未框选");
  } else {
    const width = state.bbox.right - state.bbox.left;
    const height = state.bbox.bottom - state.bbox.top;
    dom.bboxStateDot.className = "status-dot " + (state.bboxDirty ? "is-warn" : "is-ok");
    setText(dom.bboxStatus, (state.bboxDirty ? "未提交框选 · " : "已提交 · ") + width + " × " + height + " px");
  }
  setDisabled(dom.bboxFull, !editable);
  setDisabled(dom.bboxCancel, !editable || (!state.bbox && !state.bboxDirty));
}

function canEditBbox() {
  return Boolean(currentAsset() && isPreviewCurrent() && !state.requestInFlight && !state.taskRunning &&
    !state.pendingSubmission && !state.duplicateSwitching);
}

function canDrawBbox() {
  return canEditBbox();
}

function handleBboxFieldInput() {
  if (state.bboxInputSuppressed) return;
  const parsed = readBboxInputs();
  if (!parsed.ok) {
    state.bbox = null;
    state.bboxDirty = true;
    setHidden(dom.selectionBox, true);
    setError(dom.bboxError, parsed.error);
    renderBboxControls();
    updateActionState();
    handleBboxChanged();
    return;
  }
  state.bbox = parsed.bbox;
  state.bboxDirty = true;
  setError(dom.bboxError, "");
  updateBboxOverlay();
  renderBboxControls();
  updateActionState();
  handleBboxChanged();
}

function bboxFromClientPoints(drag, clientX, clientY) {
  const rect = drag.rect;
  const asset = currentAsset();
  const width = assetWidth(asset);
  const height = assetHeight(asset);
  const x1 = clamp(clientX - rect.left, 0, rect.width);
  const y1 = clamp(clientY - rect.top, 0, rect.height);
  const x2 = clamp(drag.startClientX - rect.left, 0, rect.width);
  const y2 = clamp(drag.startClientY - rect.top, 0, rect.height);
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  let left = Math.floor((minX / rect.width) * width);
  let right = Math.ceil((maxX / rect.width) * width);
  let top = Math.floor((minY / rect.height) * height);
  let bottom = Math.ceil((maxY / rect.height) * height);
  left = clamp(left, 0, Math.max(0, width - 1));
  top = clamp(top, 0, Math.max(0, height - 1));
  right = clamp(right, left + 1, width);
  bottom = clamp(bottom, top + 1, height);
  return { left: left, top: top, right: right, bottom: bottom };
}

function onSelectionPointerDown(event) {
  if (!canDrawBbox()) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  /* Use the overlay that receives the pointer, not the img, so the
   * client-to-image transform shares exactly one box even when the
   * responsive frame has fractional CSS sizes. */
  const rect = dom.selectionLayer.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  event.preventDefault();
  state.drag = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    moved: false
  };
  try {
    dom.selectionLayer.setPointerCapture(event.pointerId);
  } catch (_) {
    /* Pointer capture is an enhancement. */
  }
  dom.selectionLayer.classList.add("is-dragging");
}

function onSelectionPointerMove(event) {
  const drag = state.drag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const distance = Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY);
  if (distance >= 2) drag.moved = true;
  if (!drag.moved) return;
  event.preventDefault();
  const bbox = bboxFromClientPoints(drag, event.clientX, event.clientY);
  updateBboxOverlay(bbox);
}

function finishSelection(event, cancelled) {
  const drag = state.drag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  state.drag = null;
  dom.selectionLayer.classList.remove("is-dragging");
  try {
    dom.selectionLayer.releasePointerCapture(event.pointerId);
  } catch (_) {
    /* ignore */
  }
  if (cancelled || !drag.moved) {
    updateBboxOverlay();
    if (!cancelled && !drag.moved) showToast("请在图像上拖出一个矩形。", "info", 3000);
    return;
  }
  const bbox = bboxFromClientPoints(drag, event.clientX, event.clientY);
  if (bbox.right - bbox.left < 1 || bbox.bottom - bbox.top < 1) {
    updateBboxOverlay();
    return;
  }
  setBbox(bbox, true);
  handleBboxChanged();
}

function setFullBbox() {
  const asset = currentAsset();
  if (!asset) return;
  setBbox({ left: 0, top: 0, right: assetWidth(asset), bottom: assetHeight(asset) }, true);
  handleBboxChanged();
}

async function cancelBboxWithPrompt() {
  if (!state.bbox && !state.bboxDirty) return;
  const ok = await guardUnsavedBBox("取消框选");
  if (!ok) return;
  clearBBox();
  showToast("框选已取消。", "info", 2500);
}

function guardUnsavedBBox(actionLabel) {
  if (!state.bboxDirty) return Promise.resolve(true);
  return confirmAction({
    title: "取消未保存的框选？",
    message: "当前矩形还没有被任何任务使用。" + actionLabel + "会丢弃它，并清空数字坐标。",
    confirmLabel: "丢弃框选并继续",
    cancelLabel: "保留框选",
    tone: "danger"
  });
}

async function guardUnsavedBrush(actionLabel) {
  if (!state.brush.open || !state.brush.dirty) return true;
  const ok = await confirmAction({
    title: "放弃未保存的蒙版修改？",
    message: "当前前景蒙版画笔还有未保存的笔画、反相或去噪。" + actionLabel + "会关闭画笔并丢弃这些修改。",
    confirmLabel: "放弃并继续",
    cancelLabel: "继续编辑",
    tone: "danger"
  });
  if (!ok) return false;
  closeBrushEditor(true);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                     */
/* -------------------------------------------------------------------------- */

function setUploadFile(file) {
  if (!file) {
    state.uploadFile = null;
    dom.imageFile.value = "";
    renderFileSummary();
    updateActionState();
    return;
  }
  state.uploadDuplicates = [];
  renderDuplicateBanner();
  const name = String(file.name || "image");
  const extension = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const type = String(file.type || "").toLowerCase();
  const extensionOk = ["png", "jpg", "jpeg"].includes(extension);
  const typeOk = !type || type === "image/png" || type === "image/jpeg";
  if (!extensionOk || !typeOk) {
    setError(dom.uploadError, "请选择 PNG 或 JPEG 文件。");
    state.uploadFile = null;
    dom.imageFile.value = "";
    renderFileSummary();
    updateActionState();
    return;
  }
  if (!file.size) {
    setError(dom.uploadError, "所选文件为空。");
    state.uploadFile = null;
    dom.imageFile.value = "";
    renderFileSummary();
    updateActionState();
    return;
  }
  state.uploadFile = file;
  setError(dom.uploadError, "");
  renderFileSummary();
  updateActionState();
}

function renderFileSummary() {
  const file = state.uploadFile;
  setHidden(dom.fileSummary, !file);
  if (!file) {
    setText(dom.fileName, "—");
    setText(dom.fileMeta, "—");
    return;
  }
  setText(dom.fileName, file.name);
  setText(dom.fileMeta, formatBytes(file.size) + (file.type ? " · " + file.type : ""));
}

function readProvenanceForm() {
  const value = (node) => (node && typeof node.value === "string" ? node.value.trim() : "");
  return {
    source_type: value(dom.sourceType),
    source_name: value(dom.sourceName),
    source_url: value(dom.sourceUrl),
    license: value(dom.license),
    collected_at: value(dom.collectedAt),
    batch_id: value(dom.batchId)
  };
}

async function handleUploadSubmit() {
  if (state.requestInFlight || state.pendingSubmission || state.taskRunning || state.duplicateSwitching) {
    updateActionState();
    return;
  }
  const file = state.uploadFile;
  if (!file) {
    setError(dom.uploadError, "请先选择一张 PNG 或 JPEG。");
    return;
  }
  const note = dom.sourceNote.value.trim();
  const provenance = readProvenanceForm();
  const fileName = file.name || "image";
  if (state.currentInputId) {
    const proceed = await confirmAction({
      title: "开始新的工作区？",
      message: "新图片上传成功后，当前画布与版本区会切换到这个新工作区。既有成果仍保留在本机历史中，可稍后恢复。",
      confirmLabel: "继续选择上传",
      cancelLabel: "留在当前工作区",
      tone: "primary"
    });
    if (!proceed) return;
  }
  if (!(await guardPendingPreview("上传新图片"))) return;
  if (!(await guardUnsavedBrush("上传新图片"))) return;
  if (!(await guardUnsavedBBox("上传新图片"))) return;

  setError(dom.uploadError, "");
  const submissionLabel = "上传图像";
  startSubmission({
    path: "/images",
    method: "POST",
    label: submissionLabel,
    bodyFactory: () => {
      const form = new FormData();
      form.append("file", file, fileName);
      if (note) form.append("source_note", note);
      for (const [key, value] of Object.entries(provenance)) {
        if (value) form.append(key, value);
      }
      return form;
    },
    onSuccess: (data) => handleUploadSuccess(data, fileName, note),
    onError: (error) => {
      setError(dom.uploadError, friendlyError(error));
      showToast("上传未完成：" + friendlyError(error), "error", 6000);
    },
    onUnknown: () => {
      setError(dom.uploadError, "上传提交结果未知。请用顶部提示中的同一请求重试，页面不会自动重发。");
    }
  });
}

async function handleUploadSuccess(data, fileName, note) {
  const duplicates = Array.isArray(data && data.duplicates) ? data.duplicates : [];
  await adoptImageRecord(data, { label: fileName, note, duplicates });
}

function renderQuality() {
  const meta = state.uploadMeta;
  const grade = meta && ["A", "B", "C", "U"].includes(String(meta.grade || "").toUpperCase())
    ? String(meta.grade).toUpperCase()
    : "";
  setHidden(dom.qualitySummary, !grade);
  if (!grade) return;
  dom.qualityGrade.textContent = grade;
  dom.qualityGrade.className = "grade-chip grade-large is-" + grade.toLowerCase();
  setText(dom.qualityHeadline, QUALITY_HEADLINES[grade] || "质量参考");
  const parts = [];
  if (Number.isFinite(Number(meta.short_side))) parts.push("短边 " + meta.short_side + " px");
  if (Number.isFinite(Number(meta.sharpness))) parts.push("清晰度 " + Number(meta.sharpness).toFixed(1));
  if (Number.isFinite(Number(meta.contrast))) parts.push("对比度 " + Number(meta.contrast).toFixed(1));
  parts.push("参考画布 " + (meta.ref_size || 512) + " px");
  setText(dom.qualityMetrics, parts.join(" · "));
}

function renderDuplicateBanner() {
  const list = Array.isArray(state.uploadDuplicates) ? state.uploadDuplicates : [];
  setHidden(dom.duplicateBanner, list.length === 0);
  dom.duplicateList.replaceChildren();
  if (!list.length) return;
  const confirmed = list.filter((item) => item.status === "confirmed").length;
  setText(dom.duplicateTitle, confirmed ? "发现重复或高度相似版本" : "发现疑似重复版本");
  setText(dom.duplicateMessage, "与 " + list.length + " 个已有样本相似；新上传已保留，可切换到已有版本继续。");
  for (const item of list) {
    const suffix = item.status === "confirmed" ? "确认重复" : "疑似";
    const grade = item.grade ? " · " + item.grade + " 级" : "";
    dom.duplicateList.append(element("li", "",
      "#" + shortId(item.image_id) + " · NCC " + Number(item.ncc || 0).toFixed(3) + " · " + suffix + grade));
  }
  setDisabled(dom.duplicateUse, Boolean(duplicateSwitchBlockReason()));
}

function renderQualityNote(asset) {
  const notes = [];
  const grade = asset && String(asset.grade || "").toUpperCase();
  if (grade && ["A", "B", "C"].includes(grade)) {
    const parts = ["质量参考：" + grade + " 级"];
    if (Number.isFinite(Number(asset.short_side))) parts.push("短边 " + asset.short_side + " px");
    if (Number.isFinite(Number(asset.sharpness))) parts.push("清晰度 " + Number(asset.sharpness).toFixed(1));
    if (Number.isFinite(Number(asset.contrast))) parts.push("对比度 " + Number(asset.contrast).toFixed(1));
    notes.push(parts.join(" · "));
  }
  const metrics = asset && asset.quality_metrics && typeof asset.quality_metrics === "object"
    ? asset.quality_metrics
    : null;
  if (metrics) {
    if (metrics.pattern_score != null) {
      notes.push("纹样性 " + Number(metrics.pattern_score).toFixed(2) +
        "（面积 " + Math.round(Number(metrics.area_ratio || 0) * 100) + "%）");
    }
    if (Array.isArray(metrics.warnings) && metrics.warnings.length) {
      notes.push("候选提示：" + metrics.warnings.map((code) => PATTERN_WARNING_LABELS[code] || code).join("；"));
    }
  }
  setHidden(dom.qualityNote, notes.length === 0);
  setText(dom.qualityNote, notes.join(" · "));
}

async function adoptImageRecord(data, options) {
  const opts = options || {};
  if (!data || typeof data !== "object") {
    throw new ApiError("上传响应缺少图像信息。", { status: 200 });
  }
  const normalizedRaw = data.normalized || data.original;
  if (!normalizedRaw) {
    throw new ApiError("上传响应缺少可用资产。", { status: 200 });
  }
  const imageId = String(data.image_id || data.imageId || "");
  const originalRaw = data.original || null;
  const serverNote = typeof data.source_note === "string" ? data.source_note : (opts.note || "");
  const label = String(opts.label || data.original?.orig_name || data.source_note || "已载入图像");

  resetWorkspace({ clearUpload: true });
  state.imageId = imageId || null;
  state.sourceLabel = label;
  state.sourceNote = serverNote || "";
  state.feedbackJobId = null;
  state.uploadMeta = data.meta && typeof data.meta === "object" ? data.meta : null;
  state.uploadDuplicates = Array.isArray(opts.duplicates) ? opts.duplicates : [];

  const raws = originalRaw ? [normalizedRaw, originalRaw] : [normalizedRaw];
  const assets = await registerAssets(raws, {
    context: { origin: "upload", imageId: imageId },
    prepend: true
  });
  const normalized = assets.find((asset) => asset === state.assets.get(assetIdOf(normalizedRaw))) ||
    assets.find((asset) => !assetIsArchive(asset) && !assetIsSvg(asset) && !assetIsMask(asset));
  const original = originalRaw ? state.assets.get(assetIdOf(originalRaw)) : null;
  if (!normalized) throw new ApiError("上传成功，但没有找到可用的图像资产。", { status: 200 });

  const normalization = (normalized && normalized.normalization) ||
    (normalizedRaw && normalizedRaw.normalization) || {};
  // Only the explicit backend flag recommends Alpha; missing fields are never
  // guessed from pixels or filenames (old records do not carry this field).
  const hasTransparency = normalization.has_transparency === true;
  state.currentHasTransparency = hasTransparency;
  const recommendedMode = recommendExtractMode({ hasTransparency });
  if (recommendedMode && !state.extractModeTouched) {
    setRadio("extract-mode", recommendedMode);
    state.extractModeAutoSet = true;
    showToast("检测到透明输入，已优先选择“既有 Alpha”；处理前后接近是正常保真。可随时改选其他方式。", "info", 7000);
  } else if (!hasTransparency && state.extractModeAutoSet && !state.extractModeTouched) {
    // Only undo an automatic Alpha choice; never override a user choice.
    setRadio("extract-mode", "otsu");
    state.extractModeAutoSet = false;
  }

  state.currentInputId = normalized.asset_id;
  state.previewId = normalized.asset_id;
  if (original && assetWidth(original) && assetHeight(original)) {
    state.sourceOriginal = { width: assetWidth(original), height: assetHeight(original), assetId: original.asset_id };
  } else {
    state.sourceOriginal = {
      width: assetWidth(normalized),
      height: assetHeight(normalized),
      assetId: normalized.asset_id
    };
  }

  dom.sourceNote.value = "";
  dom.imageFile.value = "";
  state.uploadFile = null;
  renderFileSummary();
  state.paramsRevision = 1;
  resetEditHistory();
  renderAll();
  await loadPreview();
  setError(dom.uploadError, "");
  showToast(opts.toast || "图像已载入。原尺寸与当前处理尺寸分别显示。", "success", 4500);
}

// Work that owns the current workspace and must finish before a switch.
function workspaceBusyReason() {
  if (state.requestInFlight) return "正在提交，请稍候。";
  if (state.cancelBusy) return "正在请求取消，等待服务端终态。";
  if (state.pendingSubmission) return "请先处理结果未知的提交。";
  if (state.taskRunning) return "任务处理中，完成后再继续。";
  return "";
}

function duplicateSwitchBlockReason() {
  if (state.duplicateSwitching) return "正在切换已有版本，请稍候。";
  return workspaceBusyReason();
}

async function useExistingDuplicate() {
  const best = Array.isArray(state.uploadDuplicates) && state.uploadDuplicates.length
    ? state.uploadDuplicates[0]
    : null;
  if (!best || !best.image_id) return;
  const blocked = duplicateSwitchBlockReason();
  if (blocked) {
    showToast(blocked, "warning");
    return;
  }
  const switchToken = state.duplicateSwitchToken + 1;
  const initialInputId = state.currentInputId;
  // The token makes late async results harmless if this switch loses the race.
  state.duplicateSwitchToken = switchToken;
  state.duplicateSwitching = true;
  try {
    updateActionState();
    if (state.currentInputId) {
      const proceed = await confirmAction({
        title: "切换到已有版本？",
        message: "当前画布与版本区会切换到这个已有版本；现有成果仍保留在本机历史中，本次新上传也会保留。",
        confirmLabel: "切换工作区",
        cancelLabel: "留在当前工作区",
        tone: "primary"
      });
      if (!proceed) return;
    }
    const result = await requestJson("/images/" + encodeURIComponent(best.image_id));
    if (state.duplicateSwitchToken !== switchToken) return;
    const busy = workspaceBusyReason();
    if (busy) {
      showToast(busy, "warning");
      return;
    }
    if (state.currentInputId !== initialInputId) {
      showToast("工作区已变化，已取消切换到已有版本。", "warning");
      return;
    }
    if (!Array.isArray(state.uploadDuplicates) || !state.uploadDuplicates.includes(best)) {
      showToast("重复提示已更新，已取消切换到已有版本。", "warning");
      return;
    }
    if (!(await guardPendingPreview("切换到已有版本"))) return;
    if (!(await guardUnsavedBrush("切换到已有版本"))) return;
    if (!(await guardUnsavedBBox("切换到已有版本"))) return;
    if (state.duplicateSwitchToken !== switchToken) return;
    const lateBusy = workspaceBusyReason();
    if (lateBusy) {
      showToast(lateBusy, "warning");
      return;
    }
    if (state.currentInputId !== initialInputId) {
      showToast("工作区已变化，已取消切换到已有版本。", "warning");
      return;
    }
    const data = result && result.data ? result.data : null;
    await adoptImageRecord(data, {
      label: data?.original?.source_note || data?.source_note || "已有版本",
      note: data?.source_note || "",
      duplicates: [],
      toast: "已切换到已有版本；本次新上传仍保留在历史中。"
    });
  } catch (error) {
    showToast("读取已有版本失败：" + friendlyError(error), "error", 6000);
  } finally {
    if (state.duplicateSwitchToken === switchToken) {
      state.duplicateSwitching = false;
      updateActionState();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Parameter reading                                                          */
/* -------------------------------------------------------------------------- */

function syncPairedControl(range, number, decimals, autoEnhance) {
  if (!range || !number) return;
  range.addEventListener("input", () => {
    number.value = range.value;
    handleParamsChanged({ autoEnhance: Boolean(autoEnhance) });
  });
  number.addEventListener("input", () => {
    const value = Number(number.value);
    if (Number.isFinite(value)) {
      const min = Number(range.min);
      const max = Number(range.max);
      if (value >= min && value <= max) range.value = String(value);
    }
    handleParamsChanged({ autoEnhance: Boolean(autoEnhance) });
  });
  number.addEventListener("blur", () => {
    if (number.value.trim() === "") return;
    const value = Number(number.value);
    if (!Number.isFinite(value)) return;
    const min = Number(range.min);
    const max = Number(range.max);
    const bounded = clamp(value, min, max);
    number.value = decimals ? bounded.toFixed(2) : String(Math.round(bounded));
    range.value = String(bounded);
    handleParamsChanged({ autoEnhance: Boolean(autoEnhance) });
  });
}

function readExtractDraft() {
  const mode = checkedValue("extract-mode") || "otsu";
  const info = modeInfo(mode);
  return {
    mode,
    polarity: checkedValue("polarity") || "dark",
    // Hidden controls keep their DOM values for when the mode changes back,
    // but they must not leak into the current method or block Alpha.
    threshold: info.threshold ? integerValue(dom.thresholdValue) : 127,
    iterations: info.iterations ? integerValue(dom.iterations) : 5,
    window_size: info.window ? integerValue(dom.windowSize) : 31,
    offset: info.offset ? numberValue(dom.offsetValue, null) : 10,
    clahe: info.clahe ? Boolean(dom.extractClahe && dom.extractClahe.checked) : false,
    min_component_area: info.cleanup ? integerValue(dom.minComponentArea) : 0,
    max_hole_area: info.cleanup ? integerValue(dom.maxHoleArea) : 0
  };
}

function readEnhanceDraft() {
  return {
    brightness: numberValue(dom.brightnessValue, null),
    contrast: numberValue(dom.contrastValue, null),
    denoise: Number(dom.denoise.value),
    sharpen: numberValue(dom.sharpenValue, null)
  };
}

function updateExtractParamVisibility() {
  const mode = checkedValue("extract-mode") || "otsu";
  const info = modeInfo(mode);
  setHidden(dom.thresholdField, !info.threshold);
  setHidden(dom.iterationsField, !info.iterations);
  setHidden(dom.windowField, !info.window);
  setHidden(dom.offsetField, !info.offset);
  setHidden(dom.claheField, !info.clahe);
  setHidden(dom.cleanupFields, !info.cleanup);
  setHidden(dom.extractAdvanced, !(info.threshold || info.window || info.clahe || info.cleanup || info.iterations));
  const transparent = state.currentHasTransparency === true;
  setHidden(dom.extractTransparencyNote, !transparent);
  if (transparent) {
    setText(dom.extractTransparencyNote, mode === "alpha"
      ? "检测到透明输入：当前使用“既有 Alpha”保留源透明通道。前后接近是正常保真；若确有需要可改选阈值方式，但可能丢失现有透明图形。"
      : "检测到透明输入：建议优先使用“既有 Alpha”。阈值方式可能丢失可见图形，尤其大面积色块会被掏空。");
  }
}

function updateComposeSummary() {
  const draft = readExtractDraft();
  const info = modeInfo(draft.mode);
  const vectorMode = checkedValue("vector-mode") || "color";
  const maxColors = checkedValue("max-colors") || "8";
  const detail = checkedValue("vector-detail") || "medium";
  const vectorLabels = { monochrome: "黑白", color: "彩色" };
  const detailLabels = { low: "低细节", medium: "中细节", high: "高细节" };
  if (draft.threshold !== null) setText(dom.thresholdReadout, draft.threshold);
  if (draft.window_size !== null) setText(dom.windowReadout, draft.window_size);
  if (draft.offset !== null) setText(dom.offsetReadout, draft.offset);
  const enhanceDraft = readEnhanceDraft();
  setText(dom.brightnessReadout, Number.isFinite(enhanceDraft.brightness) ? enhanceDraft.brightness.toFixed(2) : "—");
  setText(dom.contrastReadout, Number.isFinite(enhanceDraft.contrast) ? enhanceDraft.contrast.toFixed(2) : "—");
  setText(dom.sharpenReadout, Number.isFinite(enhanceDraft.sharpen) ? enhanceDraft.sharpen.toFixed(2) : "—");
  const straighten = numberValue(dom.straightenValue, NaN);
  setText(dom.straightenReadout, Number.isFinite(straighten) ? straighten.toFixed(1) : "0.0");
  updatePrepareProjection();

  const extractPart = describeExtractParams(draft);
  const vectorPart =
    (vectorLabels[vectorMode] || vectorMode) + " · " + maxColors + " 色 · " + (detailLabels[detail] || detail);
  const enhancePart = dom.includeEnhance.checked
    ? (isNeutralEnhance(enhanceDraft) ? " + 轻增强（中性）" : " + " + describeEnhanceParams(enhanceDraft))
    : "";
  setText(dom.oneClickRecipe, extractPart + " → " + vectorPart + enhancePart);
  setText(dom.extractHint, info.hint);
  updateExtractParamVisibility();
  renderAiVectorSummary();
}

function readExtractParams(requireBbox) {
  const draft = readExtractDraft();
  if (!EXTRACT_MODES.includes(draft.mode)) {
    return { ok: false, error: "请选择有效的提取方式。" };
  }
  const asset = currentAsset();
  const bbox = state.bbox && validBboxForAsset(state.bbox, asset) ? Object.assign({}, state.bbox) : null;
  if (draft.mode === "grabcut" && !bbox) {
    return { ok: false, error: "GrabCut 需要有效框选。请拖拽或填写四个坐标。" };
  }
  if (requireBbox && !bbox) {
    return { ok: false, error: "此操作需要有效框选。" };
  }
  const result = extractPayload(Object.assign({}, draft, { bbox }));
  if (!result.ok) return result;
  return Object.assign({}, result.value, {
    ok: true,
    payload: result.payload,
    bbox: result.payload.bbox || null
  });
}

function readOptionalNumberField(node, min, max, label, integer) {
  if (!node || node.value.trim() === "") return { ok: true, value: null };
  const value = Number(node.value);
  if (!Number.isFinite(value) || value < min || value > max) {
    return { ok: false, error: label + "必须在 " + min + "–" + max + " 之间。" };
  }
  if (integer && !Number.isInteger(value)) {
    return { ok: false, error: label + "必须是整数。" };
  }
  return { ok: true, value: value };
}

function readVectorParams() {
  const mode = checkedValue("vector-mode");
  const maxColors = Number(checkedValue("max-colors"));
  const detail = checkedValue("vector-detail");
  if (!["monochrome", "color"].includes(mode)) {
    return { ok: false, error: "请选择黑白或彩色 SVG。" };
  }
  if (![2, 4, 8, 16].includes(maxColors)) {
    return { ok: false, error: "颜色上限必须是 2、4、8 或 16。" };
  }
  if (!["low", "medium", "high"].includes(detail)) {
    return { ok: false, error: "请选择有效的细节等级。" };
  }
  const length = readOptionalNumberField(dom.vectorLength, 0.5, 10, "长度阈值", false);
  if (!length.ok) return length;
  const corner = readOptionalNumberField(dom.vectorCorner, 0, 180, "角点阈值", true);
  if (!corner.ok) return corner;
  const splice = readOptionalNumberField(dom.vectorSplice, 0, 180, "拼接阈值", true);
  if (!splice.ok) return splice;
  return {
    ok: true,
    mode: mode,
    max_colors: maxColors,
    detail: detail,
    length_threshold: length.value,
    corner_threshold: corner.value,
    splice_threshold: splice.value
  };
}

function vectorPayloadFrom(params) {
  const payload = {
    mode: params.mode,
    max_colors: params.max_colors,
    detail: params.detail
  };
  if (params.length_threshold !== null) payload.length_threshold = params.length_threshold;
  if (params.corner_threshold !== null) payload.corner_threshold = params.corner_threshold;
  if (params.splice_threshold !== null) payload.splice_threshold = params.splice_threshold;
  return payload;
}

function readEnhanceParams() {
  const result = validateEnhanceOptions(readEnhanceDraft());
  if (!result.ok) return result;
  return Object.assign({ ok: true }, result.value, { payload: enhancePayload(result.value).payload });
}

function currentProcessBlock() {
  if (state.requestInFlight) return "正在提交，请稍候。";
  if (state.duplicateSwitching) return "正在切换已有版本，请稍候。";
  if (state.cancelBusy) return "正在请求取消，等待服务端终态。";
  if (state.pendingSubmission) return "请先处理结果未知的提交。";
  if (state.taskRunning) return "任务处理中，完成后再继续。";
  const asset = currentAsset();
  if (!asset) return "请先上传并选择当前输入。";
  if (!isPreviewCurrent() && !state.previewSession.isActive()) {
    return "画布正在预览其他版本，请先回到当前输入。";
  }
  if (assetPixels(asset) > PROCESS_PIXEL_LIMIT) return "大图需要先创建工作副本。";
  return "";
}

function requireProcessReady() {
  const reason = currentProcessBlock();
  if (reason) {
    setError(dom.composeError, reason);
    showToast(reason, "warning");
    return false;
  }
  return true;
}

function previewBindingId(session) {
  if (!session) return state.currentInputId;
  if (session.kind === "recolor-svg") return state.recolor.assetId;
  if (session.kind === "refine_mask") {
    const pair = selectedMaskPair();
    return pair ? pair.sourceId : "";
  }
  // Local workflow reruns preview a specific archived layer/PNG, which is not
  // necessarily the workspace's current input.
  if (session.kind === "compose_layers" || session.kind === "vectorize") {
    return session.inputAssetId;
  }
  return state.currentInputId;
}

function currentRefineMaskId(session) {
  if (!session || session.kind !== "refine_mask") return "";
  const pair = selectedMaskPair();
  return pair ? pair.maskId : "";
}

function previewBindingMatches(session) {
  if (!session) return false;
  if (String(session.inputAssetId) !== String(previewBindingId(session) || "")) return false;
  if (session.baseAssetId) {
    return String(session.baseAssetId) === String(currentRefineMaskId(session) || "");
  }
  return true;
}

function operationBlockReason(request) {
  if (state.requestInFlight) return "正在提交，请稍候。";
  if (state.duplicateSwitching) return "正在切换已有版本，请稍候。";
  if (state.cancelBusy) return "正在请求取消，等待服务端终态。";
  if (state.pendingSubmission) return "请先处理结果未知的提交。";
  if (state.taskRunning) return "任务处理中，完成后再继续。";
  const targetId = request && request.targetAssetId ? request.targetAssetId : state.currentInputId;
  const target = targetId ? state.assets.get(targetId) : null;
  if (!target) return "请先选择要处理的版本。";
  if (!request || !request.targetAssetId) {
    if (!isPreviewCurrent() && !state.previewSession.isActive()) {
      return "画布正在预览其他版本，请先回到当前输入。";
    }
    if (assetPixels(target) > PROCESS_PIXEL_LIMIT) return "大图需要先创建工作副本。";
  }
  return "";
}

function requireOperationReady(request) {
  const reason = operationBlockReason(request);
  if (!reason) return true;
  const node = request && request.kind === "recolor-svg" ? dom.recolorError : dom.composeError;
  setError(node, reason);
  showToast(reason, "warning");
  return false;
}

/* -------------------------------------------------------------------------- */
/* Submitting jobs                                                            */
/* -------------------------------------------------------------------------- */

function submitJob(path, payload, label, options) {
  const opts = options || {};
  const errorNode = opts.errorNode || dom.composeError;
  if (!opts.skipReady && !requireProcessReady()) return false;
  setError(errorNode, "");
  const bodyText = JSON.stringify(payload);
  return startSubmission({
    path: path,
    method: "POST",
    label: label,
    bodyFactory: () => bodyText,
    markBboxClean: Boolean(opts.markBboxClean),
    onSuccess: async (data) => {
      const job = extractJobFromResponse(data);
      if (!job) throw new ApiError("任务响应缺少 job_id。", { status: 202 });
      state.submissionSnapshots.set(job.job_id, state.lastCommittedSnapshot || captureWorkspace());
      if (opts.onJob) {
        try {
          opts.onJob(job);
        } catch (_) {
          /* 提交外的界面回调失败不应影响任务本身。 */
        }
      }
      await adoptJob(job, { announce: true });
    },
    onError: (error) => {
      setError(errorNode, label + "未创建：" + friendlyError(error));
      showToast(label + "未创建：" + friendlyError(error), "error", 6500);
    },
    onUnknown: () => {
      setError(errorNode, label + "提交结果未知。请用页面顶部的同一请求重试，不会自动重发。");
    }
  });
}

function extractJobFromResponse(data) {
  if (!data || typeof data !== "object") return null;
  return normalizeJob(data.job || data);
}

/* -------------------------------------------------------------------------- */
/* Local requests, preview lifecycle and workspace history                    */
/* -------------------------------------------------------------------------- */

function buildEnhanceRequest() {
  if (!requireProcessReady()) return { ok: false, handled: true };
  const asset = currentAsset();
  if (!asset) return { ok: false, error: "请先选择当前输入。" };
  const enhance = readEnhanceParams();
  if (!enhance.ok) return enhance;
  return {
    ok: true,
    path: "/jobs/enhance",
    label: "轻增强",
    kind: "enhance",
    guardBbox: true,
    payload: {
      input_asset_id: asset.asset_id,
      brightness: enhance.brightness,
      contrast: enhance.contrast,
      denoise: enhance.denoise,
      sharpen: enhance.sharpen
    }
  };
}

function readPrepareParams() {
  const rotation = Number(dom.prepareRotation.value);
  const straighten = numberValue(dom.straightenValue, NaN);
  if (![0, 90, 180, 270].includes(rotation)) {
    return { ok: false, error: "旋转必须是 0、90、180 或 270 度。" };
  }
  if (!Number.isFinite(straighten) || straighten < -15 || straighten > 15) {
    return { ok: false, error: "纠偏角度必须在 -15–15 度之间。" };
  }
  return {
    ok: true,
    rotation: rotation,
    straighten: Math.round(straighten * 100) / 100
  };
}

function preparePrediction() {
  const asset = currentAsset();
  if (!asset) return null;
  const rotation = Number(dom.prepareRotation.value);
  const straighten = numberValue(dom.straightenValue, NaN);
  if (!Number.isFinite(straighten)) return null;
  return predictPreparedSize(
    assetWidth(asset),
    assetHeight(asset),
    rotation,
    straighten,
    PROCESS_PIXEL_LIMIT
  );
}

function updatePrepareProjection() {
  const asset = currentAsset();
  const prediction = preparePrediction();
  if (!asset) {
    setText(dom.prepareProjection, "上传后可预估准备输出尺寸。");
    setHidden(dom.prepareLimit, true);
    dom.prepareButton.title = "";
    return;
  }
  if (!prediction) {
    setText(dom.prepareProjection, "输入尺寸或角度无效，暂时无法预估准备输出。");
    setHidden(dom.prepareLimit, true);
    dom.prepareButton.title = "当前无法预估准备输出";
    return;
  }
  const inputPixels = assetPixels(asset);
  if (prediction.overLimit) {
    setText(dom.prepareProjection,
      "预计输出 " + formatDimensions(prediction.width, prediction.height) +
      "（" + formatPixels(prediction.width, prediction.height) + "）。" +
      (prediction.expanded ? "纠偏会按旋转后四角外扩画布，因此像素高于输入。" : ""));
    dom.prepareLimit.hidden = false;
    dom.prepareLimit.textContent =
      "超过本地 1,000,000 像素上限：输入 " + formatPixels(assetWidth(asset), assetHeight(asset)) +
      "，扩边后 " + formatPixels(prediction.width, prediction.height) +
      "。请先创建工作副本或减小纠偏角度；后端仍会最终校验，不会提高上限。";
    dom.prepareButton.title = "准备输出超过本地像素上限，请先创建工作副本或减小纠偏角度";
    return;
  }
  const expansion = prediction.expanded
    ? "纠偏会按旋转后四角外扩画布，像素可能高于输入。"
    : Number(dom.prepareRotation.value)
      ? "仅直角旋转，输出像素与输入相同。"
      : "不旋转、不纠偏，输出与输入相同。";
  setText(dom.prepareProjection,
    "预计输出 " + formatDimensions(prediction.width, prediction.height) +
    "（" + formatPixels(prediction.width, prediction.height) + "）。" + expansion);
  setHidden(dom.prepareLimit, true);
  dom.prepareButton.title = "";
}

function buildPrepareRequest() {
  if (!requireProcessReady()) return { ok: false, handled: true };
  const asset = currentAsset();
  if (!asset) return { ok: false, error: "请先选择当前输入。" };
  const prepare = readPrepareParams();
  if (!prepare.ok) return prepare;
  const prediction = preparePrediction();
  if (!prediction) {
    return { ok: false, error: "当前输入或角度无效，无法预估准备输出。" };
  }
  if (prediction.overLimit) {
    return {
      ok: false,
      error: "准备输出预计 " + formatDimensions(prediction.width, prediction.height) +
        "（" + formatPixels(prediction.width, prediction.height) +
        "），超过本地 1,000,000 像素上限。请先创建工作副本或减小纠偏角度。"
    };
  }
  return {
    ok: true,
    path: "/jobs/prepare",
    label: "图像准备",
    kind: "prepare",
    guardBbox: true,
    payload: {
      input_asset_id: asset.asset_id,
      rotation: prepare.rotation,
      straighten: prepare.straighten
    }
  };
}

function buildExtractRequest() {
  if (!requireProcessReady()) return { ok: false, handled: true };
  const asset = currentAsset();
  if (!asset) return { ok: false, error: "请先选择当前输入。" };
  const extract = readExtractParams(false);
  if (!extract.ok) return extract;
  return {
    ok: true,
    path: "/jobs/extract",
    label: "提取",
    kind: "extract",
    markBboxClean: Boolean(extract.payload.bbox),
    payload: Object.assign({ input_asset_id: asset.asset_id }, extract.payload)
  };
}

function buildVectorRequest() {
  if (!requireProcessReady()) return { ok: false, handled: true };
  const asset = currentAsset();
  if (!asset) return { ok: false, error: "请先选择当前输入。" };
  const vector = readVectorParams();
  if (!vector.ok) return vector;
  return {
    ok: true,
    path: "/jobs/vectorize",
    label: "矢量化",
    kind: "vectorize",
    payload: Object.assign({ input_asset_id: asset.asset_id }, vectorPayloadFrom(vector))
  };
}

function buildOneClickRequest() {
  if (!requireProcessReady()) return { ok: false, handled: true };
  const asset = currentAsset();
  if (!asset) return { ok: false, error: "请先选择当前输入。" };
  const extract = readExtractParams(false);
  if (!extract.ok) return extract;
  const vector = readVectorParams();
  if (!vector.ok) return vector;
  let enhance = null;
  if (dom.includeEnhance.checked) {
    enhance = readEnhanceParams();
    if (!enhance.ok) return enhance;
  }
  return {
    ok: true,
    path: "/pipelines",
    label: "本地一键",
    kind: "pipeline",
    markBboxClean: Boolean(extract.payload.bbox),
    payload: {
      input_asset_id: asset.asset_id,
      extract: extract.payload,
      vector: vectorPayloadFrom(vector),
      enhance: enhance ? enhance.payload : null,
      working_max_pixels: null
    }
  };
}

function handleRecolorError(message) {
  setError(dom.recolorError, message);
}

function svgVersionAssets() {
  return state.versionIds
    .map((id) => state.assets.get(id))
    .filter((asset) => asset && assetIsSvg(asset));
}

function svgFillColors(asset) {
  const parameters = asset && asset.parameters && typeof asset.parameters === "object" ? asset.parameters : {};
  const raw = Array.isArray(parameters.svg_fill_colors)
    ? parameters.svg_fill_colors
    : Array.isArray(asset && asset.svg_fill_colors) ? asset.svg_fill_colors : [];
  const colors = [];
  for (const value of raw) {
    const color = String(value || "").toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(color) || colors.includes(color)) continue;
    colors.push(color);
  }
  return colors;
}

function selectedRecolorAsset() {
  return state.recolor.assetId ? state.assets.get(state.recolor.assetId) || null : null;
}

function markRecolorParamsChanged() {
  state.paramsRevision += 1;
  invalidatePreviewForParams();
  renderPreviewUi();
  updateRecolorActions();
}

function renderRecolorPanel(force) {
  const svgs = svgVersionAssets();
  const previous = state.recolor.assetId;
  const chosen = svgs.find((asset) => asset.asset_id === previous) ||
    svgs.find((asset) => asset.asset_id === state.previewId) ||
    svgs[0] || null;
  const colors = chosen ? svgFillColors(chosen) : [];
  const signature = svgs.map((asset) => asset.asset_id).join(",") + "|" +
    (chosen ? chosen.asset_id : "") + "|" + colors.join(",");
  if (!force && signature === state.recolor.signature) {
    updateRecolorActions();
    return;
  }
  state.recolor.signature = signature;
  state.recolor.assetId = chosen ? chosen.asset_id : "";
  state.recolor.colors = colors;
  dom.recolorSvgSelect.replaceChildren();
  for (const asset of svgs) {
    const option = element("option", "", assetDisplayName(asset) + " · #" + shortId(asset.asset_id));
    option.value = asset.asset_id;
    dom.recolorSvgSelect.append(option);
  }
  dom.recolorSvgSelect.value = state.recolor.assetId;
  dom.recolorList.replaceChildren();
  handleRecolorError("");
  if (!chosen) {
    setText(dom.recolorNote, "尚未生成 SVG。先完成矢量化，再选择颜色替换。");
    updateRecolorActions();
    return;
  }
  if (!colors.length) {
    setText(dom.recolorNote, "此 SVG 没有记录可替换的实色；请重新矢量化后再试。");
    updateRecolorActions();
    return;
  }
  setText(dom.recolorNote, "勾选要替换的颜色并选择目标色；多个原色可用同一目标色合并。");
  for (const color of colors) {
    const row = element("div", "recolor-row");
    row.dataset.source = color;
    const enable = element("input");
    enable.type = "checkbox";
    enable.className = "recolor-enable";
    enable.setAttribute("aria-label", "替换颜色 " + color);
    const swatch = element("span", "recolor-swatch");
    swatch.style.backgroundColor = color;
    const code = element("code", "recolor-source", color);
    const target = element("input");
    target.type = "color";
    target.className = "recolor-target";
    target.value = color;
    target.disabled = true;
    target.setAttribute("aria-label", color + " 的目标颜色");
    enable.addEventListener("change", () => {
      target.disabled = !enable.checked;
      markRecolorParamsChanged();
    });
    target.addEventListener("input", markRecolorParamsChanged);
    row.append(enable, swatch, code, target);
    dom.recolorList.append(row);
  }
  updateRecolorActions();
}

function updateRecolorActions() {
  const rows = dom.recolorList.querySelectorAll(".recolor-row");
  let changed = 0;
  for (const row of rows) {
    const enable = row.querySelector(".recolor-enable");
    const target = row.querySelector(".recolor-target");
    if (!enable || !target || !enable.checked) continue;
    if (String(target.value).toUpperCase() !== String(row.dataset.source).toUpperCase()) changed += 1;
  }
  const asset = selectedRecolorAsset();
  const tooMany = changed > 16;
  setDisabled(dom.recolorButton, !asset || changed === 0 || tooMany);
  setDisabled(dom.recolorReset, !asset || rows.length === 0);
  setButtonLabel(dom.recolorButton, dom.previewMode.checked ? "预览颜色替换" : "应用颜色替换");
  if (tooMany) handleRecolorError("一次最多替换 16 个颜色。");
}

function buildRecolorRequest() {
  const asset = selectedRecolorAsset();
  if (!asset) return { ok: false, error: "请先选择一个已生成的 SVG。" };
  const mapping = {};
  let count = 0;
  for (const row of dom.recolorList.querySelectorAll(".recolor-row")) {
    const enable = row.querySelector(".recolor-enable");
    const target = row.querySelector(".recolor-target");
    if (!enable || !target || !enable.checked) continue;
    const source = String(row.dataset.source || "").toUpperCase();
    const color = String(target.value || "").toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(source) || !/^#[0-9A-F]{6}$/.test(color)) {
      return { ok: false, error: "颜色必须是六位十六进制实色。" };
    }
    if (source === color) continue;
    mapping[source] = color;
    count += 1;
  }
  if (!count) return { ok: false, error: "请至少选择一个与原色不同的目标色。" };
  if (count > 16) return { ok: false, error: "一次最多替换 16 个颜色。" };
  return {
    ok: true,
    path: "/jobs/recolor-svg",
    label: "SVG 颜色替换",
    kind: "recolor-svg",
    targetAssetId: asset.asset_id,
    payload: { input_asset_id: asset.asset_id, mapping: mapping }
  };
}

function handleRecolor() {
  handleRecolorError("");
  const request = buildRecolorRequest();
  if (!request.ok) {
    handleRecolorError(request.error);
    return;
  }
  void runLocalRequest(request, {});
}

function readRecolorSnapshot() {
  const mapping = {};
  for (const row of dom.recolorList.querySelectorAll(".recolor-row")) {
    const enable = row.querySelector(".recolor-enable");
    const target = row.querySelector(".recolor-target");
    if (!enable || !target || !enable.checked) continue;
    const source = String(row.dataset.source || "").toUpperCase();
    const color = String(target.value || "").toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(source) && /^#[0-9A-F]{6}$/.test(color) && source !== color) {
      mapping[source] = color;
    }
  }
  return { assetId: state.recolor.assetId || "", mapping };
}

function applyRecolorSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  const assetId = String(snapshot.assetId || "");
  if (!assetId || state.recolor.assetId !== assetId) return;
  const mapping = snapshot.mapping && typeof snapshot.mapping === "object" ? snapshot.mapping : {};
  for (const row of dom.recolorList.querySelectorAll(".recolor-row")) {
    const source = String(row.dataset.source || "").toUpperCase();
    const target = mapping[source] || mapping[source.toLowerCase()];
    if (!target) continue;
    const enable = row.querySelector(".recolor-enable");
    const input = row.querySelector(".recolor-target");
    if (enable) enable.checked = true;
    if (input) {
      input.disabled = false;
      input.value = String(target).toUpperCase();
    }
  }
  updateRecolorActions();
}

function resetRecolorColors() {
  for (const row of dom.recolorList.querySelectorAll(".recolor-row")) {
    const enable = row.querySelector(".recolor-enable");
    const target = row.querySelector(".recolor-target");
    if (enable) enable.checked = false;
    if (target) {
      target.value = row.dataset.source;
      target.disabled = true;
    }
  }
  handleRecolorError("");
  markRecolorParamsChanged();
}

async function runLocalRequest(request, options) {
  const opts = options || {};
  if (!request || request.handled) return false;
  const errorNode = request.errorNode ||
    (request.kind === "recolor-svg" ? dom.recolorError : dom.composeError);
  if (!request.ok) {
    setError(errorNode, request.error || "参数无效。");
    showToast(request.error || "参数无效，请检查输入。", "warning", 5500);
    return false;
  }
  const willPreview = dom.previewMode.checked || opts.forcePreview;
  if (opts.guardBbox && !willPreview &&
      !(await guardUnsavedBBox("执行「" + request.label + "」并切换当前输入"))) {
    return false;
  }
  if (!requireOperationReady(request)) return false;
  if (willPreview) {
    return startPreviewRequest(request);
  }
  if (state.previewSession.current()) {
    await discardPreview({ silent: true });
    if (!requireOperationReady(request)) return false;
  }
  return submitJob(request.path, request.payload, request.label, {
    markBboxClean: Boolean(request.markBboxClean),
    skipReady: Boolean(request.targetAssetId),
    errorNode: errorNode,
    onJob: request.onJob || null
  });
}

async function startPreviewRequest(request) {
  if (state.requestInFlight || state.pendingSubmission || state.taskRunning || state.cancelBusy ||
      state.duplicateSwitching) {
    showToast("当前有提交或任务正在处理，完成后再预览。", "warning");
    return false;
  }
  if (!request || !request.ok) return false;
  if (!requireOperationReady(request)) return false;
  const errorNode = request.errorNode || dom.composeError;
  const subjectId = request.targetAssetId || state.currentInputId;
  const subject = subjectId ? state.assets.get(subjectId) : null;
  if (!subject) return false;
  if (request.baseAssetId && !state.assets.get(request.baseAssetId)) return false;
  if (state.previewSession.current()) {
    await discardPreview({ silent: true, reason: "replace" });
  }
  const revision = state.paramsRevision;
  state.previewSession.begin({
    inputAssetId: subjectId,
    baseAssetId: request.baseAssetId || "",
    revision: revision,
    params: readParamsSnapshot(),
    label: request.label,
    kind: request.kind,
    scale: 1,
    processingSize: { width: assetWidth(subject), height: assetHeight(subject) }
  });
  renderPreviewUi();
  updateActionState();
  const bodyText = JSON.stringify(request.payload);
  const started = startSubmission({
    path: request.path,
    method: "POST",
    label: "预览" + request.label,
    bodyFactory: () => bodyText,
    markBboxClean: Boolean(request.markBboxClean),
    onSuccess: async (data) => {
      const job = extractJobFromResponse(data);
      if (!job) throw new ApiError("预览任务响应缺少 job_id。", { status: 202 });
      if (request.onJob) {
        try {
          request.onJob(job);
        } catch (_) {
          /* 界面回调失败不应影响预览任务。 */
        }
      }
      state.previewSession.attachJob(job.job_id);
      state.previewJobIds.add(job.job_id);
      state.submissionSnapshots.set(job.job_id, state.lastCommittedSnapshot || captureWorkspace());
      await adoptJob(job, { announce: false, preview: true });
    },
    onError: (error) => {
      state.previewSession.fail(friendlyError(error));
      setError(errorNode, "预览未创建：" + friendlyError(error));
      renderPreviewUi();
      updateActionState();
      showToast("预览未创建：" + friendlyError(error), "error", 6500);
    },
    onUnknown: () => {
      state.previewSession.fail("预览提交结果未知；页面不会自动重发。");
      setError(errorNode, "预览提交结果未知。请用页面顶部的同一请求重试；不会自动应用。");
      renderPreviewUi();
      updateActionState();
    }
  });
  if (!started) {
    state.previewSession.fail("预览提交未开始。");
    renderPreviewUi();
    updateActionState();
  }
  return started;
}

function selectTargetForJob(job, assets) {
  const kind = normalizeKind(job && job.kind);
  let target = null;
  let makeCurrent = false;
  if (["crop", "prepare", "working_copy", "workingcopy", "enhance", "enhanced"].includes(kind)) {
    target = findInputAssetForJob(assets, kind);
    makeCurrent = Boolean(target);
  } else if (kind === "export") {
    target = null;
  } else if (kind === "vectorize") {
    target = findSvgAsset(assets, job);
  } else if (kind === "extract" || kind === "refine_mask") {
    target = findTransparentAsset(assets) || assets.find((asset) => assetIsInputCapable(asset)) || null;
  } else if (kind === "pipeline") {
    target = findSvgAsset(assets, job) || findTransparentAsset(assets) ||
      assets.find((asset) => assetIsInputCapable(asset)) || null;
  } else {
    target = findSvgAsset(assets, job) || assets.find((asset) => assetIsInputCapable(asset)) || null;
  }
  return { target, makeCurrent };
}

async function completePreviewJob(job) {
  const session = state.previewSession.current();
  const owns = Boolean(session && String(session.jobId) === String(job.job_id));
  const jobState = String(job.state || "").toLowerCase();

  if (jobState === "cancelled") {
    if (owns) {
      clearPreviewExpiry();
      if (state.previewId !== state.currentInputId) state.previewId = state.currentInputId;
      releasePreviewAssets(session);
      state.previewSession.clear();
      renderAll();
      if (state.previewId) await loadPreview();
      else resetCanvas();
      showToast(cancelledMessage(), "info", 7000);
    }
    state.previewJobIds.delete(job.job_id);
    state.submissionSnapshots.delete(job.job_id);
    return;
  }

  if (jobState === "failed") {
    if (owns) {
      state.previewSession.fail(
        job.error && (job.error.message || job.error.code)
          ? (job.error.message || "预览任务失败。")
          : "预览任务失败。"
      );
      renderPreviewUi();
      updateActionState();
      showToast("预览失败，工作区未改变。可调整参数后重新预览。", "error", 6500);
    }
    state.previewJobIds.delete(job.job_id);
    state.submissionSnapshots.delete(job.job_id);
    return;
  }

  if (jobState !== "succeeded") return;

  if (!owns) {
    state.previewJobIds.delete(job.job_id);
    state.submissionSnapshots.delete(job.job_id);
    if (state.previewId !== state.currentInputId) state.previewId = state.currentInputId;
    renderAll();
    if (state.previewId) await loadPreview();
    showToast("预览任务已完成，但本次预览已经放弃，结果没有自动应用。", "info", 6000);
    return;
  }

  const result = job.result && typeof job.result === "object" ? job.result : {};
  const raws = Array.isArray(result.assets) ? result.assets : [];
  const assets = raws.length
    ? await registerAssets(raws, { context: jobContext(job), includeInVersions: false, prepend: true })
    : [];
  if (isCancelIntent(job)) {
    await keepCompletedAfterCancel(job);
    return;
  }
  const { target } = selectTargetForJob(job, assets);
  const resolution = state.previewSession.resolve({
    jobId: job.job_id,
    revision: state.paramsRevision,
    inputAssetId: previewBindingId(session),
    baseAssetId: currentRefineMaskId(session),
    assetIds: assets.map((asset) => asset.asset_id),
    targetId: target ? target.asset_id : "",
    resultAssets: raws,
    processingSize: target ? { width: assetWidth(target), height: assetHeight(target) } : null
  });

  if (resolution.status !== "ready") {
    state.previewJobIds.delete(job.job_id);
    state.submissionSnapshots.delete(job.job_id);
    if (state.previewId !== state.currentInputId) state.previewId = state.currentInputId;
    releasePreviewAssets(session);
    renderAll();
    if (state.previewId) await loadPreview();
    if (resolution.status === "stale") {
      showToast("预览对应的参数或图片已经变化，本次结果未采用，也没有写入版本。", "warning", 7000);
    } else if (resolution.status === "expired") {
      showToast("预览已过期，结果未采用，也没有自动应用。", "warning", 7000);
    } else if (resolution.status === "cancelled") {
      showToast(cancelledMessage(), "info", 7000);
    } else {
      showToast("本次预览已不再有效，结果未应用。", "info", 6000);
    }
    return;
  }

  if (target) state.previewId = target.asset_id;
  renderAll();
  await loadPreview();
  armPreviewExpiry(resolution.session);
  state.previewJobIds.delete(job.job_id);
  state.submissionSnapshots.delete(job.job_id);
  renderPreviewUi();
  updateActionState();
  showToast("预览已生成，尚未应用。检查后可应用或放弃。", "success", 5000);
}

async function applyPreview() {
  if (state.requestInFlight || state.pendingSubmission || state.taskRunning || state.cancelBusy || state.duplicateSwitching) {
    showToast("当前有提交或任务正在处理，稍后再应用预览。", "warning");
    return false;
  }
  const activePreview = state.previewSession.current();
  const check = state.previewSession.canApply({
    revision: state.paramsRevision,
    inputAssetId: previewBindingId(activePreview),
    baseAssetId: currentRefineMaskId(activePreview)
  });
  if (!check.ok) {
    const reason = {
      none: "当前没有可应用的预览。",
      pending: "预览仍在生成，完成后才能应用。",
      stale: "参数或图片已经变化，此预览不能应用。请重新预览。",
      expired: "预览已过期，不能应用。请重新预览。",
      failed: "预览失败，没有可应用的成果。",
      cancelled: "预览已取消，不能应用。",
      input_changed: "当前输入已经变化，此预览不能应用。"
    }[check.reason] || "此预览当前不能应用。";
    showToast(reason, "warning", 6000);
    renderPreviewUi();
    return false;
  }
  const session = check.session;
  const job = state.tasks.get(session.jobId);
  if (!job || String(job.state || "").toLowerCase() !== "succeeded") {
    state.previewSession.fail("预览任务状态不完整，请重新预览。");
    renderPreviewUi();
    showToast("预览任务状态不完整，无法应用。", "warning");
    return false;
  }
  const assets = session.assetIds
    .map((id) => state.assets.get(id))
    .filter(Boolean);
  if (!assets.length) {
    state.previewSession.fail("预览成果元数据缺失，请重新预览。");
    renderPreviewUi();
    return false;
  }
  const { target, makeCurrent } = selectTargetForJob(job, assets);
  if (makeCurrent && state.bboxDirty && !(await guardUnsavedBBox("应用该预览并切换当前输入"))) {
    return false;
  }
  promoteAssetsToVersions(session.assetIds);
  if (makeCurrent && target && assetIsInputCapable(target)) {
    state.currentInputId = target.asset_id;
    state.currentHasTransparency = Boolean(
      target.normalization && target.normalization.has_transparency === true
    );
    state.previewId = target.asset_id;
    clearBBox();
  } else if (target) {
    state.previewId = target.asset_id;
  }
  if (normalizeKind(job.kind) === "recolor_svg" && target) {
    state.recolor.assetId = target.asset_id;
    state.recolor.signature = "";
  }
  const previewModeEnabled = dom.previewMode.checked;
  const autoPreviewEnhance = dom.autoPreviewEnhance.checked;
  applyParamsSnapshot(session.params);
  // Preview mode is a UI preference, not part of the applied algorithm result.
  dom.previewMode.checked = previewModeEnabled;
  dom.autoPreviewEnhance.checked = autoPreviewEnhance;
  state.paramsRevision = session.revision;
  clearPreviewExpiry();
  if (state.autoPreviewTimer) {
    window.clearTimeout(state.autoPreviewTimer);
    state.autoPreviewTimer = null;
  }
  state.previewSession.clear();
  state.previewJobIds.delete(job.job_id);
  state.submissionSnapshots.delete(job.job_id);
  renderAll();
  commitWorkspace({ label: "应用「" + session.label + "」" });
  await loadPreview();
  showToast("已应用预览「" + session.label + "」。可用撤销回到处理前。", "success", 6500);
  return true;
}

async function discardPreview(options) {
  const opts = options || {};
  const session = state.previewSession.current();
  if (!session) return true;
  if (opts.confirm) {
    const ok = await confirmAction({
      title: "放弃未应用的预览？",
      message: "「" + session.label + "」尚未应用。放弃后画布回到当前输入；已生成的任务与文件仍保留在历史中，不会自动应用。",
      confirmLabel: "放弃预览",
      cancelLabel: "保留预览",
      tone: "danger"
    });
    if (!ok) return false;
  }
  const job = session.jobId ? state.tasks.get(session.jobId) : null;
  let cancelFailed = false;
  if (job && isJobActive(job) && !opts.skipCancel) {
    const cancelled = await sendCancelQuiet(job.job_id);
    cancelFailed = !cancelled;
  }
  clearPreviewExpiry();
  if (state.previewId !== state.currentInputId) state.previewId = state.currentInputId;
  releasePreviewAssets(session);
  state.previewSession.clear();
  renderAll();
  if (state.previewId) await loadPreview();
  else resetCanvas();
  if (!opts.silent) {
    showToast(
      cancelFailed
        ? "已放弃本页预览；后台任务可能仍在运行，可在历史中查看，结果不会自动应用。"
        : "已放弃预览，没有写入版本。",
      cancelFailed ? "warning" : "info",
      6000
    );
  }
  return true;
}

async function guardPendingPreview(actionLabel) {
  const session = state.previewSession.current();
  if (!session) return true;
  const ok = await confirmAction({
    title: "有未应用的预览",
    message: "「" + session.label + "」尚未应用。" + actionLabel + "会放弃它；已生成的任务与文件仍保留在历史中，不会自动应用或切换当前输入。",
    confirmLabel: "放弃预览并继续",
    cancelLabel: "留在预览",
    tone: "danger"
  });
  if (!ok) return false;
  return discardPreview({ silent: true });
}

function clearPreviewExpiry() {
  if (state.previewExpiryTimer) {
    window.clearTimeout(state.previewExpiryTimer);
    state.previewExpiryTimer = null;
  }
}

function armPreviewExpiry(session) {
  clearPreviewExpiry();
  if (!session) return;
  const remaining = Math.max(0, Number(session.expiresAt) - Date.now());
  state.previewExpiryTimer = window.setTimeout(() => {
    state.previewExpiryTimer = null;
    const current = state.previewSession.current();
    if (!current || String(current.id) !== String(session.id)) return;
    if (!state.previewSession.expire()) return;
    renderPreviewUi();
    updateActionState();
    showToast("预览已过期，不会自动应用。请重新预览或放弃。", "warning", 6500);
  }, Math.min(remaining + 50, 2_147_483_647));
}

function releasePreviewAssets(session) {
  if (!session) return;
  for (const id of session.assetIds || []) {
    if (!id) continue;
    if (state.versionIds.includes(id)) continue;
    if (id === state.currentInputId || id === state.previewId) continue;
    const cached = state.previewUrls.get(id);
    if (cached && cached.url) {
      try {
        URL.revokeObjectURL(cached.url);
      } catch (_) {
        /* Blob URL cleanup is best effort. */
      }
    }
    state.previewUrls.delete(id);
  }
}

function promoteAssetsToVersions(assetIds) {
  const ordered = [];
  for (const id of assetIds || []) {
    if (!id || !state.assets.has(id) || ordered.includes(id)) continue;
    ordered.push(id);
    const asset = state.assets.get(id);
    if (asset) asset._isNewUntil = Date.now() + 45_000;
  }
  if (!ordered.length) return;
  state.versionIds = ordered.concat(state.versionIds.filter((id) => !ordered.includes(id)));
}

function renderPreviewUi() {
  const session = state.previewSession.current();
  setHidden(dom.previewBar, !session);
  setHidden(dom.pendingPreviewBadge, !session);
  if (!session) {
    if (dom.previewWatermarkLabel) dom.previewWatermarkLabel.textContent = "成果预览 · 非当前输入";
    return;
  }
  const stateName = String(session.state || "pending");
  if (dom.previewWatermarkLabel) dom.previewWatermarkLabel.textContent = "预览 · 未应用";
  const revisionText = "参数修订 #" + session.revision;
  const sizeText = session.processingSize
    ? formatDimensions(session.processingSize.width, session.processingSize.height)
    : "原尺寸";
  const labels = {
    pending: "生成中",
    ready: "待应用",
    stale: "已过期",
    expired: "已过期",
    failed: "失败",
    cancelled: "已取消",
    applied: "已应用"
  };
  setText(dom.previewBarTag, labels[stateName] || "预览");
  setText(dom.pendingPreviewBadge, stateName === "pending" ? "预览生成中" : stateName === "ready" ? "预览未应用" : "预览" + (labels[stateName] || ""));
  if (stateName === "pending") {
    setText(dom.previewBarTitle, "正在生成「" + session.label + "」预览…");
    setText(dom.previewBarDetail, revisionText + " · " + sizeText + " · 完成后不会自动应用");
  } else if (stateName === "ready") {
    setText(dom.previewBarTitle, "「" + session.label + "」预览已生成");
    setText(dom.previewBarDetail, revisionText + " · " + sizeText + " · 应用后写入版本；放弃不删除任务");
  } else if (stateName === "stale") {
    setText(dom.previewBarTitle, "「" + session.label + "」预览已失效");
    setText(dom.previewBarDetail, "生成于参数修订 #" + session.revision + "，当前为 #" + state.paramsRevision + "；此结果不可应用，请重新预览或放弃。");
  } else if (stateName === "expired") {
    setText(dom.previewBarTitle, "「" + session.label + "」预览已过期");
    setText(dom.previewBarDetail, "超过有效期，结果不会自动应用。请重新预览或放弃。");
  } else if (stateName === "failed") {
    setText(dom.previewBarTitle, "「" + session.label + "」预览失败");
    setText(dom.previewBarDetail, session.error || "工作区未改变；可调整参数后重新预览。");
  } else if (stateName === "cancelled") {
    setText(dom.previewBarTitle, "「" + session.label + "」预览已取消");
    setText(dom.previewBarDetail, "没有应用到工作区；已生成的中间成果留在历史中。");
  } else {
    setText(dom.previewBarTitle, "「" + session.label + "」预览");
    setText(dom.previewBarDetail, revisionText);
  }

  const busy = state.requestInFlight || state.pendingSubmission || state.taskRunning || state.cancelBusy ||
    state.duplicateSwitching;
  const revisionMatch = session.revision === state.paramsRevision;
  const inputMatch = previewBindingMatches(session);
  const canApply = stateName === "ready" && !busy && revisionMatch && inputMatch;
  setDisabled(dom.previewApply, !canApply);
  setDisabled(dom.previewDiscard, state.requestInFlight || state.cancelBusy || state.duplicateSwitching);
  let applyTitle = "应用此预览并写入版本";
  if (stateName === "pending") applyTitle = "预览仍在生成";
  else if (stateName === "stale") applyTitle = "参数或图片已变化，请重新预览";
  else if (stateName === "expired") applyTitle = "预览已过期，请重新预览";
  else if (stateName === "failed") applyTitle = "预览失败，没有可应用成果";
  else if (stateName === "cancelled") applyTitle = "预览已取消";
  else if (!revisionMatch) applyTitle = "参数已更新，请重新预览";
  else if (!inputMatch) applyTitle = "当前输入已变化，请重新预览";
  dom.previewApply.title = applyTitle;
}

function readParamsSnapshot() {
  return {
    extract: readExtractDraft(),
    vector: {
      mode: checkedValue("vector-mode") || "color",
      maxColors: Number(checkedValue("max-colors")),
      detail: checkedValue("vector-detail") || "medium",
      length: dom.vectorLength.value.trim() === "" ? null : Number(dom.vectorLength.value),
      corner: dom.vectorCorner.value.trim() === "" ? null : Number(dom.vectorCorner.value),
      splice: dom.vectorSplice.value.trim() === "" ? null : Number(dom.vectorSplice.value)
    },
    enhance: readEnhanceDraft(),
    prepare: {
      rotation: Number(dom.prepareRotation.value),
      straighten: numberValue(dom.straightenValue, 0)
    },
    includeEnhance: Boolean(dom.includeEnhance.checked),
    workingMax: integerValue(dom.workingMax),
    previewMode: Boolean(dom.previewMode.checked),
    autoPreviewEnhance: Boolean(dom.autoPreviewEnhance.checked)
  };
}

function applyParamsSnapshot(snapshot) {
  const params = snapshot && typeof snapshot === "object" ? snapshot : {};
  const extract = params.extract && typeof params.extract === "object" ? params.extract : {};
  if (EXTRACT_MODES.includes(extract.mode)) setRadio("extract-mode", extract.mode);
  if (["dark", "light"].includes(extract.polarity)) setRadio("polarity", extract.polarity);
  if (Number.isInteger(extract.threshold)) dom.thresholdValue.value = String(extract.threshold);
  if (Number.isInteger(extract.iterations)) dom.iterations.value = String(extract.iterations);
  if (Number.isInteger(extract.window_size)) dom.windowSize.value = String(extract.window_size);
  if (Number.isFinite(extract.offset)) dom.offsetValue.value = String(extract.offset);
  if (dom.extractClahe) dom.extractClahe.checked = Boolean(extract.clahe);
  if (Number.isInteger(extract.min_component_area)) dom.minComponentArea.value = String(extract.min_component_area);
  if (Number.isInteger(extract.max_hole_area)) dom.maxHoleArea.value = String(extract.max_hole_area);

  const vector = params.vector && typeof params.vector === "object" ? params.vector : {};
  if (["monochrome", "color"].includes(vector.mode)) setRadio("vector-mode", vector.mode);
  if ([2, 4, 8, 16].includes(Number(vector.maxColors))) setRadio("max-colors", String(vector.maxColors));
  if (["low", "medium", "high"].includes(vector.detail)) setRadio("vector-detail", vector.detail);
  dom.vectorLength.value = Number.isFinite(vector.length) ? String(vector.length) : "";
  dom.vectorCorner.value = Number.isFinite(vector.corner) ? String(vector.corner) : "";
  dom.vectorSplice.value = Number.isFinite(vector.splice) ? String(vector.splice) : "";

  const enhance = params.enhance && typeof params.enhance === "object" ? params.enhance : {};
  if (Number.isFinite(enhance.brightness)) dom.brightnessValue.value = String(enhance.brightness);
  if (Number.isFinite(enhance.contrast)) dom.contrastValue.value = String(enhance.contrast);
  if ([0, 1, 2].includes(Number(enhance.denoise))) dom.denoise.value = String(enhance.denoise);
  if (Number.isFinite(enhance.sharpen)) dom.sharpenValue.value = String(enhance.sharpen);

  const prepare = params.prepare && typeof params.prepare === "object" ? params.prepare : {};
  if ([0, 90, 180, 270].includes(Number(prepare.rotation))) {
    dom.prepareRotation.value = String(prepare.rotation);
  }
  if (Number.isFinite(prepare.straighten)) {
    dom.straightenValue.value = String(prepare.straighten);
  }

  if (dom.includeEnhance) dom.includeEnhance.checked = Boolean(params.includeEnhance);
  dom.previewMode.checked = params.previewMode !== false;
  dom.autoPreviewEnhance.checked = Boolean(params.autoPreviewEnhance);
  if (Number.isInteger(params.workingMax)) {
    dom.workingMax.value = String(clamp(params.workingMax, WORKING_COPY_MIN, WORKING_COPY_MAX));
  }
  syncPairedControlValues();
  updateComposeSummary();
}

function captureWorkspace() {
  const session = state.previewSession.current();
  return {
    currentInputId: state.currentInputId,
    // A preview is transient and is never part of an applied workspace state.
    previewId: session ? (session.inputAssetId || state.currentInputId) : state.previewId,
    bbox: state.bbox ? Object.assign({}, state.bbox) : null,
    params: readParamsSnapshot(),
    recolor: readRecolorSnapshot(),
    preview: null,
    paramsRevision: state.paramsRevision
  };
}

function snapshotsEqual(left, right) {
  if (!left || !right) return left === right;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch (_) {
    return false;
  }
}

function resetEditHistory() {
  const snapshot = captureWorkspace();
  state.workspaceHistory.reset(snapshot, { label: "当前状态" });
  state.lastCommittedSnapshot = snapshot;
  renderUndoRedo();
}

function commitWorkspace(options) {
  const opts = options || {};
  if (state.suppressHistory) return;
  if (!currentAsset()) return;
  const next = captureWorkspace();
  if (state.lastCommittedSnapshot && snapshotsEqual(state.lastCommittedSnapshot, next)) {
    state.lastCommittedSnapshot = next;
    return;
  }
  if (!state.workspaceHistory.size()) {
    state.workspaceHistory.reset(next, { label: "当前状态" });
  } else {
    state.workspaceHistory.push(next, {
      label: opts.label || "编辑",
      mergeKey: opts.mergeKey || ""
    });
  }
  state.lastCommittedSnapshot = next;
  renderUndoRedo();
}

async function restoreWorkspaceSnapshot(snapshot, options) {
  const opts = options || {};
  if (!snapshot) return false;
  state.suppressHistory = true;
  const recolorSnapshot = snapshot.recolor && typeof snapshot.recolor === "object"
    ? snapshot.recolor
    : null;
  try {
    state.currentInputId = snapshot.currentInputId || null;
    const inputAsset = state.currentInputId ? state.assets.get(state.currentInputId) : null;
    state.currentHasTransparency = Boolean(
      inputAsset && inputAsset.normalization && inputAsset.normalization.has_transparency === true
    );
    state.previewId = snapshot.previewId || snapshot.currentInputId || null;
    state.bbox = snapshot.bbox ? Object.assign({}, snapshot.bbox) : null;
    state.bboxDirty = false;
    fillBboxInputs(state.bbox);
    applyParamsSnapshot(snapshot.params || {});
    if (recolorSnapshot && recolorSnapshot.assetId && state.assets.get(recolorSnapshot.assetId)) {
      state.recolor.assetId = recolorSnapshot.assetId;
      state.recolor.signature = "";
    }
    state.previewSession.restore(snapshot.preview);
    state.paramsRevision = Number.isFinite(snapshot.paramsRevision)
      ? snapshot.paramsRevision
      : state.paramsRevision;
  } finally {
    state.suppressHistory = false;
  }
  renderAll();
  if (recolorSnapshot) applyRecolorSnapshot(recolorSnapshot);
  state.lastCommittedSnapshot = captureWorkspace();
  renderUndoRedo();
  renderPreviewUi();
  if (state.previewId) await loadPreview();
  else resetCanvas();
  if (!opts.silent) {
    showToast(opts.message || "已恢复工作区状态。", "info", 4000);
  }
  return true;
}

async function undoWorkspace() {
  if (state.requestInFlight || state.pendingSubmission || state.taskRunning || state.cancelBusy || state.duplicateSwitching) {
    showToast("当前有提交或任务正在处理，完成后再撤销。", "warning");
    return;
  }
  if (state.brush.open) {
    undoBrushAction();
    return;
  }
  const entry = state.workspaceHistory.undo();
  if (!entry) {
    showToast("当前图片没有可撤销的编辑。", "info", 3500);
    return;
  }
  await restoreWorkspaceSnapshot(entry.state, {
    message: "已撤销：" + entry.label + "。"
  });
  renderUndoRedo();
}

async function redoWorkspace() {
  if (state.requestInFlight || state.pendingSubmission || state.taskRunning || state.cancelBusy || state.duplicateSwitching) {
    showToast("当前有提交或任务正在处理，完成后再重做。", "warning");
    return;
  }
  if (state.brush.open) {
    redoBrushAction();
    return;
  }
  const entry = state.workspaceHistory.redo();
  if (!entry) {
    showToast("当前图片没有可重做的编辑。", "info", 3500);
    return;
  }
  await restoreWorkspaceSnapshot(entry.state, {
    message: "已重做：" + entry.label + "。"
  });
  renderUndoRedo();
}

function renderUndoRedo() {
  const busy = state.requestInFlight || state.pendingSubmission || state.taskRunning || state.cancelBusy ||
    state.duplicateSwitching;
  const canUndo = !busy && state.workspaceHistory.canUndo();
  const canRedo = !busy && state.workspaceHistory.canRedo();
  setDisabled(dom.undoButton, !canUndo);
  setDisabled(dom.redoButton, !canRedo);
  dom.undoButton.title = canUndo
    ? "撤销：" + state.workspaceHistory.undoLabel() + "（Ctrl+Z）"
    : "当前图片暂无可撤销的编辑";
  dom.redoButton.title = canRedo
    ? "重做：" + state.workspaceHistory.redoLabel() + "（Ctrl+Y）"
    : "当前图片暂无可重做的编辑";
}

function scheduleParamsCommit() {
  if (state.suppressHistory) return;
  if (state.paramsCommitTimer) window.clearTimeout(state.paramsCommitTimer);
  state.paramsCommitTimer = window.setTimeout(() => {
    state.paramsCommitTimer = null;
    commitWorkspace({ label: "调整参数", mergeKey: "params" });
  }, PREVIEW_REVISION_DELAY);
}

function invalidatePreviewForParams() {
  const session = state.previewSession.current();
  if (!session) return;
  if (session.revision !== state.paramsRevision) {
    state.previewSession.invalidate("stale");
    clearPreviewExpiry();
  }
}

function handleParamsChanged(options) {
  const opts = options || {};
  state.paramsRevision += 1;
  invalidatePreviewForParams();
  updateComposeSummary();
  updateActionState();
  renderPreviewUi();
  if (opts.autoEnhance) scheduleAutoPreview();
  scheduleParamsCommit();
}

function handleBboxChanged() {
  state.paramsRevision += 1;
  invalidatePreviewForParams();
  renderPreviewUi();
  updateActionState();
  commitWorkspace({ label: "调整框选", mergeKey: "bbox" });
}

function scheduleAutoPreview() {
  if (state.autoPreviewTimer) {
    window.clearTimeout(state.autoPreviewTimer);
    state.autoPreviewTimer = null;
  }
  if (!dom.autoPreviewEnhance.checked || !dom.previewMode.checked) return;
  if (!currentAsset()) return;
  if (state.requestInFlight || state.pendingSubmission || state.taskRunning || state.duplicateSwitching) return;
  if (!isPreviewCurrent() && !state.previewSession.isActive()) return;
  if (isNeutralEnhance(readEnhanceDraft())) return;
  state.autoPreviewTimer = window.setTimeout(() => {
    state.autoPreviewTimer = null;
    if (state.requestInFlight || state.pendingSubmission || state.taskRunning || state.duplicateSwitching) return;
    if (!dom.autoPreviewEnhance.checked || !dom.previewMode.checked) return;
    const request = buildEnhanceRequest();
    if (request.ok) void startPreviewRequest(request);
  }, AUTO_PREVIEW_DELAY);
}

function syncActionLabels() {
  const previewFirst = Boolean(dom.previewMode.checked);
  setButtonLabel(dom.oneclickButton, previewFirst ? "预览本地一键" : "开始本地一键");
  setButtonLabel(dom.extractButton, previewFirst ? "预览提取" : "仅执行提取");
  setButtonLabel(dom.vectorButton, previewFirst ? "预览矢量化" : "仅重新矢量化");
  setButtonLabel(dom.enhanceButton, previewFirst ? "预览轻增强" : "仅执行轻增强");
  setButtonLabel(dom.prepareButton, previewFirst ? "预览准备版本" : "生成准备版本");
}

function versionHas(kindTest) {
  for (const id of state.versionIds) {
    const asset = state.assets.get(id);
    if (asset && kindTest(asset)) return true;
  }
  return false;
}

function activeTaskRecord() {
  let job = state.activeJobId ? state.tasks.get(state.activeJobId) : null;
  if (!job) {
    const session = state.previewSession.current();
    if (session && session.jobId) job = state.tasks.get(session.jobId) || null;
  }
  return job || null;
}

const GUIDE_TONES = {
  idle: "等待开始",
  ready: "可继续",
  working: "处理中",
  warning: "需要处理",
  done: "可导出"
};

function renderGuide() {
  const job = activeTaskRecord();
  const eligibility = cancelEligibility(job);
  const asset = currentAsset();
  const blocked = [];
  if (state.pendingSubmission) {
    blocked.push({ label: "提交", reason: "上一次提交结果未知，请先用同一请求重试或放弃。" });
  }
  if (state.requestInFlight) {
    blocked.push({ label: "写入", reason: "正在提交，请稍候。" });
  }
  if (state.taskRunning) {
    blocked.push({ label: "处理", reason: "任务处理中；本地任务可在状态条请求取消。" });
  }
  if (!asset) {
    blocked.push({ label: "处理", reason: "请先上传并选择当前输入。" });
  } else if (!isPreviewCurrent() && !state.previewSession.isActive()) {
    blocked.push({ label: "处理", reason: "画布正在预览其他版本，先回到当前输入或设为输入。" });
  } else if (assetPixels(asset) > PROCESS_PIXEL_LIMIT) {
    blocked.push({ label: "处理", reason: "大图需要先创建工作副本。" });
  }
  if (asset && checkedValue("extract-mode") === "grabcut" && !state.bbox) {
    blocked.push({ label: "GrabCut", reason: "需要有效框选。" });
  }

  const session = state.previewSession.current();
  const guidance = buildGuidance({
    hasInput: Boolean(asset),
    tooLarge: Boolean(asset && assetPixels(asset) > PROCESS_PIXEL_LIMIT),
    hasTransparency: state.currentHasTransparency === true,
    extractMode: checkedValue("extract-mode") || "otsu",
    preview: session
      ? { state: session.state, label: session.label }
      : { state: "none" },
    task: job
      ? {
          state: job.state,
          label: jobLabel(job.kind),
          cancelSupported: eligibility.supported,
          cancelReason: eligibility.reason,
          cancelBusy: state.cancelBusy
        }
      : { state: "" },
    hasMaskPairs: state.brush.pairs.length > 0,
    hasTransparent: versionHas((item) => normalizeKind(item.kind).includes("transparent")),
    hasSvg: versionHas((item) => assetIsSvg(item)),
    hasResult: state.versionIds.length > 0,
    versionCount: state.versionIds.length,
    canUndo: state.workspaceHistory.canUndo(),
    canRedo: state.workspaceHistory.canRedo(),
    blocked: blocked
  });

  setText(dom.guideTone, GUIDE_TONES[guidance.tone] || "当前状态");
  dom.guidePanel.dataset.tone = guidance.tone;
  setText(dom.guideNext, guidance.headline);
  setText(dom.guideDetail, guidance.detail);
  dom.guideSteps.replaceChildren();
  for (const item of guidance.steps) {
    const li = element("li", "guide-step is-" + item.state);
    li.append(element("span", "guide-step-dot"));
    const copy = element("div", "guide-step-copy");
    copy.append(element("span", "guide-step-label", item.label));
    if (item.detail) copy.append(element("small", "", item.detail));
    li.append(copy);
    dom.guideSteps.append(li);
  }
  setText(dom.guideLocation, guidance.locations);
  if (blocked.length) {
    dom.guideBlocked.hidden = false;
    dom.guideBlocked.textContent = blocked
      .slice(0, 3)
      .map((item) => item.label + "：" + item.reason)
      .join("　");
  } else {
    dom.guideBlocked.hidden = true;
    dom.guideBlocked.textContent = "";
  }
  setHidden(dom.guideFailure, !guidance.failure);
  if (guidance.failure) {
    setText(dom.guideFailureTitle, guidance.failure.title);
    dom.guideFailureLines.replaceChildren();
    for (const line of guidance.failure.lines) {
      dom.guideFailureLines.append(element("li", "", line));
    }
  }
}

async function sendCancelRequest(jobId) {
  const result = await requestJson("/jobs/" + encodeURIComponent(jobId) + "/cancel", {
    method: "POST",
    idempotencyKey: newIdempotencyKey()
  });
  const job = normalizeJob(result.data && result.data.job ? result.data.job : result.data);
  if (!job) throw new ApiError("取消响应缺少任务状态。", { status: result.status });
  return job;
}

async function sendCancelQuiet(jobId) {
  try {
    const job = await sendCancelRequest(jobId);
    state.tasks.set(job.job_id, Object.assign({}, state.tasks.get(job.job_id) || {}, job));
    return true;
  } catch (_) {
    return false;
  }
}

function stopJobPolling(jobId) {
  const timer = state.pollTimers.get(jobId);
  if (timer) {
    window.clearTimeout(timer);
    state.pollTimers.delete(jobId);
  }
}

function isCancelIntent(job) {
  return Boolean(job && state.cancelIntent &&
    String(state.cancelIntent.jobId) === String(job.job_id));
}

/**
 * A confirmed cancel intent suppresses automatic application even when the
 * task won the race and reached a truthful succeeded state. The result stays
 * available in history/task results, and the workspace returns to the
 * pre-submission snapshot.
 */
async function keepCompletedAfterCancel(job) {
  const snapshot = state.submissionSnapshots.get(job.job_id);
  const partial = job.result && Array.isArray(job.result.assets) ? job.result.assets : [];
  if (partial.length) {
    try {
      await registerAssets(partial, {
        context: jobContext(job),
        includeInVersions: false,
        prepend: true
      });
      job._registeredAssets = partial.map(assetIdOf);
    } catch (_) {
      showToast("取消竞态下的成果暂时无法读取；任务记录仍保留在历史中。", "warning");
    }
  }
  const session = state.previewSession.current();
  if (session && String(session.jobId) === String(job.job_id)) {
    state.previewSession.cancel();
    clearPreviewExpiry();
  }
  state.previewJobIds.delete(job.job_id);
  state.submissionSnapshots.delete(job.job_id);
  stopJobPolling(job.job_id);
  state.taskRunning = false;
  if (snapshot) {
    await restoreWorkspaceSnapshot(snapshot, { silent: true });
  } else {
    if (state.previewId !== state.currentInputId) state.previewId = state.currentInputId;
    renderAll();
    if (state.previewId) await loadPreview();
  }
  if (session) releasePreviewAssets(session);
  state.previewSession.clear();
  state.cancelNote = "取消意图已生效：任务在取消请求前完成，结果只保留在历史与任务结果中，没有自动应用；处理起点已恢复。";
  if (isCancelIntent(job)) state.cancelIntent = null;
  renderTask();
  renderFeedback();
  updateActionState();
  showToast("任务在取消请求前已完成；结果只保留在历史中，未自动应用。", "warning", 8000);
}

async function handleCancelTask() {
  const job = activeTaskRecord();
  if (!job) return;
  const eligibility = cancelEligibility(job);
  if (!eligibility.supported) {
    state.cancelNote = eligibility.reason;
    renderTask();
    showToast(eligibility.reason, "warning", 7000);
    return;
  }
  if (state.cancelBusy) return;
  if (state.requestInFlight || state.pendingSubmission) {
    showToast("当前有提交正在处理，稍后再请求取消。", "warning");
    return;
  }
  // Local cancellation is cheap and recoverable: no extra confirmation dialog
  // that would leave a window for a success result to auto-apply first.
  state.cancelIntent = {
    jobId: job.job_id,
    token: (state.cancelIntent ? state.cancelIntent.token : 0) + 1,
    at: Date.now()
  };
  const session = state.previewSession.current();
  if (session && String(session.jobId) === String(job.job_id)) {
    state.previewSession.cancel();
    clearPreviewExpiry();
  }
  state.cancelBusy = true;
  state.cancelError = "";
  state.cancelNote = "已确认取消意图，正在请求停止…";
  renderTask();
  updateActionState();
  try {
    const updated = await sendCancelRequest(job.job_id);
    const merged = Object.assign({}, job, updated);
    state.tasks.set(job.job_id, merged);
    if (updated.state === "cancelled") {
      state.cancelNote = cancelledMessage();
      await finishJobOnce(merged);
    } else if (updated.state === "succeeded") {
      await finishJobOnce(merged);
      if (!state.cancelNote || state.cancelNote === "已确认取消意图，正在请求停止…") {
        state.cancelNote = successRaceMessage();
        showToast(successRaceMessage(), "warning", 8000);
      }
    } else if (updated.state === "failed") {
      state.cancelNote = "任务在取消请求前失败；失败记录与已有成果仍保留。";
      await finishJobOnce(merged);
    } else {
      state.cancelNote = "取消请求已提交，等待服务端给出真实终态。";
      scheduleJobPoll(job.job_id, 900);
      showToast("取消请求已提交，等待真实终态；页面不会自动重发。", "info", 5500);
    }
  } catch (error) {
    state.cancelError = cancelConflictMessage(error);
    state.cancelNote = state.cancelError;
    showToast(state.cancelError, "error", 8500);
    try {
      const refreshed = await requestJson("/jobs/" + encodeURIComponent(job.job_id));
      const latest = normalizeJob(refreshed.data && refreshed.data.job ? refreshed.data.job : refreshed.data);
      if (latest) {
        state.tasks.set(latest.job_id, Object.assign({}, job, latest));
        if (!isJobActive(latest)) await finishJobOnce(latest);
      }
    } catch (_) {
      /* Keep the explanatory message; never resend cancel automatically. */
    }
  } finally {
    state.cancelBusy = false;
    renderTask();
    renderFeedback();
    updateActionState();
  }
}

function handlePrepare() {
  setError(dom.prepareError, "");
  const request = buildPrepareRequest();
  if (!request || request.handled) return;
  if (!request.ok) {
    setError(dom.prepareError, request.error);
    return;
  }
  void runLocalRequest(request, { guardBbox: true });
}

async function handleCrop() {
  if (state.previewSession.current()) {
    if (!(await discardPreview({ silent: true }))) return;
  }
  if (!requireProcessReady()) return;
  const asset = currentAsset();
  if (!asset) return;
  if (!state.bbox || !validBboxForAsset(state.bbox, asset)) {
    setError(dom.bboxError, "请先框选一个有效矩形。");
    return;
  }
  const payload = {
    input_asset_id: asset.asset_id,
    bbox: Object.assign({}, state.bbox)
  };
  submitJob("/jobs/crop", payload, "裁切", { markBboxClean: true });
}

async function handleWorkingCopy() {
  if (state.pendingSubmission || state.requestInFlight || state.taskRunning || state.duplicateSwitching) return;
  if (state.previewSession.current()) {
    if (!(await discardPreview({ silent: true }))) return;
  }
  const asset = currentAsset();
  if (!asset) return;
  if (!isPreviewCurrent()) {
    showToast("请先回到当前输入，再创建工作副本。", "warning");
    return;
  }
  const maxPixels = integerValue(dom.workingMax);
  if (maxPixels === null || maxPixels < WORKING_COPY_MIN || maxPixels > WORKING_COPY_MAX) {
    setError(dom.workingError, "请输入 10,000–1,000,000 之间的整数像素上限。");
    return;
  }
  if (maxPixels >= assetPixels(asset)) {
    setError(dom.workingError, "目标上限不小于当前尺寸，不会缩小。请降低上限。");
    return;
  }
  guardUnsavedBBox("创建工作副本").then((ok) => {
    if (!ok) return;
    setError(dom.workingError, "");
    setError(dom.composeError, "");
    const payload = { input_asset_id: asset.asset_id, max_pixels: maxPixels };
    const bodyText = JSON.stringify(payload);
    startSubmission({
      path: "/jobs/working-copy",
      method: "POST",
      label: "创建工作副本",
      bodyFactory: () => bodyText,
      onSuccess: async (data) => {
        const job = extractJobFromResponse(data);
        if (!job) throw new ApiError("任务响应缺少 job_id。", { status: 202 });
        state.submissionSnapshots.set(job.job_id, state.lastCommittedSnapshot || captureWorkspace());
        await adoptJob(job, { announce: true });
      },
      onError: (error) => {
        setError(dom.workingError, friendlyError(error));
        showToast("工作副本未创建：" + friendlyError(error), "error");
      },
      onUnknown: () => setError(dom.workingError, "提交结果未知，请用页面顶部提示重试。")
    });
  });
}

function handleEnhance() {
  void runLocalRequest(buildEnhanceRequest(), { guardBbox: true });
}

function handleExtract() {
  void runLocalRequest(buildExtractRequest(), {});
}

function handleVectorize() {
  void runLocalRequest(buildVectorRequest(), {});
}

function handleOneClick() {
  void runLocalRequest(buildOneClickRequest(), {});
}

function unconfirmedLicenseIds(ids) {
  return (ids || []).filter((id) => {
    const asset = state.assets.get(id);
    const licenseName = String((asset && asset.license) || "").trim();
    return !licenseName || licenseName === "未确认";
  });
}

async function confirmExportLicense(unconfirmedCount) {
  if (!unconfirmedCount) return { proceed: true, acknowledged: false };
  const proceed = await confirmAction({
    title: "导出前确认来源授权",
    message: "所选版本中有 " + unconfirmedCount + " 个未登记授权或标记为“未确认”。ZIP 只在本机生成与使用；请确认你已核对来源和授权范围，导出不会改变授权状态。",
    confirmLabel: "我确认，继续导出",
    cancelLabel: "返回检查",
    tone: "primary"
  });
  return { proceed: proceed, acknowledged: proceed };
}

async function handleExport() {
  if (state.requestInFlight || state.pendingSubmission || state.taskRunning || state.duplicateSwitching) return;
  const ids = state.versionIds.filter((id) => state.selectedAssetIds.has(id));
  if (!ids.length) {
    setError(dom.exportError, "请先勾选至少一个版本。");
    return;
  }
  setError(dom.exportError, "");
  const unconfirmed = unconfirmedLicenseIds(ids);
  const license = await confirmExportLicense(unconfirmed.length);
  if (!license.proceed) return;
  const bodyText = JSON.stringify({ asset_ids: ids, license_acknowledged: license.acknowledged });
  startSubmission({
    path: "/exports",
    method: "POST",
    label: "打包 ZIP",
    bodyFactory: () => bodyText,
    onSuccess: async (data) => {
      const job = extractJobFromResponse(data);
      if (!job) throw new ApiError("导出任务响应缺少 job_id。", { status: 202 });
      await adoptJob(job, { announce: true });
      showToast("已提交 ZIP 打包，仅包含选中的 " + ids.length + " 个版本。", "info");
    },
    onError: (error) => {
      setError(dom.exportError, "打包未创建：" + friendlyError(error));
      showToast("打包未创建：" + friendlyError(error), "error");
    },
    onUnknown: () => setError(dom.exportError, "打包提交结果未知，请用页面顶部提示重试。")
  });
}

/* -------------------------------------------------------------------------- */
/* Jobs, polling and task panel                                              */
/* -------------------------------------------------------------------------- */

function isJobActive(job) {
  const jobState = String((job && job.state) || "").toLowerCase();
  return jobState === "queued" || jobState === "running";
}

function isJobEnded(job) {
  const jobState = String((job && job.state) || "").toLowerCase();
  return jobState === "succeeded" || jobState === "failed" || jobState === "cancelled";
}

function jobLabel(kind) {
  const key = normalizeKind(kind);
  return JOB_LABELS[key] || kind || "任务";
}

function stateLabel(value) {
  return STATE_LABELS[String(value || "").toLowerCase()] || value || "未知";
}

function stepLabel(name) {
  const key = normalizeKind(name);
  return STEP_LABELS[key] || name || "步骤";
}

async function adoptJob(rawJob, options) {
  const opts = options || {};
  const job = normalizeJob(rawJob);
  if (!job) throw new ApiError("任务响应缺少 job_id。", { status: 202 });
  const previous = state.tasks.get(job.job_id);
  const merged = Object.assign({}, previous || {}, job);
  state.tasks.set(job.job_id, merged);
  state.activeJobId = job.job_id;
  state.completedJobs.delete(job.job_id);
  state.cancelNote = "";
  state.cancelError = "";

  if (isJobActive(merged)) {
    state.taskRunning = true;
    renderTask();
    updateActionState();
    scheduleJobPoll(job.job_id, 1000);
    if (opts.announce) showToast(jobLabel(merged.kind) + "已提交，等待处理。", "info", 4000);
  } else {
    state.taskRunning = false;
    assignFeedbackJob(job.job_id);
    renderTask();
    updateActionState();
    await finishJobOnce(merged);
  }
}

function scheduleJobPoll(jobId, delay) {
  const existing = state.pollTimers.get(jobId);
  if (existing) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    state.pollTimers.delete(jobId);
    void pollJob(jobId);
  }, Math.max(300, delay || POLL_BASE_MS));
  state.pollTimers.set(jobId, timer);
}

async function pollJob(jobId) {
  try {
    const result = await requestJson("/jobs/" + encodeURIComponent(jobId));
    const job = normalizeJob(result.data && result.data.job ? result.data.job : result.data);
    if (!job) throw new ApiError("任务状态响应缺少 job_id。", { status: 200 });
    const previous = state.tasks.get(jobId);
    const merged = Object.assign({}, previous || {}, job);
    state.tasks.set(jobId, merged);
    state.pollFailures.delete(jobId);
    state.pollErrors.delete(jobId);
    state.pollStopped.delete(jobId);
    if (state.activeJobId === jobId) {
      if (isJobActive(merged)) {
        state.taskRunning = true;
        renderTask();
        updateActionState();
        scheduleJobPoll(jobId, 1800);
      } else {
        state.taskRunning = false;
        assignFeedbackJob(jobId);
        renderTask();
        updateActionState();
        await finishJobOnce(merged);
      }
    }
  } catch (error) {
    const failures = (state.pollFailures.get(jobId) || 0) + 1;
    state.pollFailures.set(jobId, failures);
    const message = "状态查询失败：" + friendlyError(error) + "。页面只重试查询，不会重新提交任务。";
    state.pollErrors.set(jobId, message);
    if (state.activeJobId === jobId) {
      renderTask();
      if (failures <= POLL_MAX_FAILURES) {
        scheduleJobPoll(jobId, Math.min(2500 * failures, 10000));
      } else {
        state.pollStopped.add(jobId);
        renderTask();
        updateActionState();
      }
    }
  }
}

async function finishJobOnce(job) {
  if (!job || !job.job_id) return;
  const marker = job.job_id + ":" + String(job.state || "");
  if (state.completedJobs.has(marker)) return;
  state.completedJobs.add(marker);
  const branchPipelineId = state.ai.branchJobs.get(job.job_id);
  if (branchPipelineId) {
    state.ai.branchJobs.delete(job.job_id);
    window.setTimeout(() => {
      if (state.ai.pipeline && aiPipelineId(state.ai.pipeline) === branchPipelineId) {
        void refreshAiTraceNow();
      }
    }, 700);
  }
  stopJobPolling(job.job_id);
  state.pollErrors.delete(job.job_id);
  state.pollStopped.delete(job.job_id);
  state.taskRunning = false;
  assignFeedbackJob(job.job_id);
  if (isJobActive(job)) return;

  if (cancelTerminalOutcome(job, state.cancelIntent).action === "history-only") {
    await keepCompletedAfterCancel(job);
    return;
  }

  if (state.previewJobIds.has(job.job_id)) {
    try {
      await completePreviewJob(job);
    } catch (error) {
      showToast("预览已完成，但成果读取失败：" + friendlyError(error), "error", 7000);
    }
    if (isCancelIntent(job)) state.cancelIntent = null;
    renderTask();
    renderFeedback();
    updateActionState();
    return;
  }

  if (job.state === "cancelled") {
    const snapshot = state.submissionSnapshots.get(job.job_id);
    const partial = job.result && Array.isArray(job.result.assets) ? job.result.assets : [];
    if (partial.length) {
      try {
        await registerAssets(partial, { context: jobContext(job), includeInVersions: false, prepend: true });
        job._registeredAssets = partial.map(assetIdOf);
      } catch (_) {
        showToast("取消前已发布的中间成果暂时无法读取，可从历史重新打开。", "warning");
      }
    }
    state.submissionSnapshots.delete(job.job_id);
    if (state.tile.pendingCropJobId === job.job_id) {
      state.tile.pendingCrop = false;
      state.tile.pendingCropJobId = null;
    }
    if (snapshot) {
      await restoreWorkspaceSnapshot(snapshot, { silent: true });
    } else {
      renderAll();
      if (state.previewId) await loadPreview();
    }
    state.cancelNote = cancelledMessage();
    if (isCancelIntent(job)) state.cancelIntent = null;
    renderTask();
    renderFeedback();
    updateActionState();
    showToast(cancelledMessage(), "info", 7500);
    return;
  }

  if (job.state === "failed") {
    const partial = job.result && Array.isArray(job.result.assets) ? job.result.assets : [];
    if (partial.length) {
      try {
        await registerAssets(partial, { context: jobContext(job), prepend: true });
        job._registeredAssets = partial.map(assetIdOf);
        renderVersions();
      } catch (_) {
        showToast("已完成步骤的成果暂时无法读取，可从历史重新打开。", "warning");
      }
    }
    if (state.tile.pendingCropJobId === job.job_id) {
      state.tile.pendingCrop = false;
      state.tile.pendingCropJobId = null;
    }
    if (isRepairJobKind(job.kind)) {
      state.repair.jobId = job.job_id;
      await loadRepairRecord(job.job_id, { preserveSelection: false, switchAccepted: false });
    }
    if (isTileJobKind(job.kind)) {
      state.tile.jobId = job.job_id;
      state.tile.job = job;
      state.tile.resultAssetId = "";
      state.tile.error = job.error && (job.error.message || job.error.code)
        ? (job.error.message || "平铺任务失败。")
        : "平铺任务失败。可明确重试本地平铺，不会产生模型费用。";
      renderTilePanel();
    }
    state.submissionSnapshots.delete(job.job_id);
    if (isCancelIntent(job)) state.cancelIntent = null;
    renderTask();
    renderFeedback();
    updateActionState();
    showToast(jobLabel(job.kind) + "失败。原因已显示在任务卡中。", "error", 6500);
    return;
  }

  if (job.state !== "succeeded") return;
  try {
    await processSuccessfulJob(job);
  } catch (error) {
    showToast("任务已完成，但成果读取失败：" + friendlyError(error), "error", 7000);
  }
  state.submissionSnapshots.delete(job.job_id);
  renderTask();
  renderFeedback();
  updateActionState();
}

async function processSuccessfulJob(job) {
  if (cancelTerminalOutcome(job, state.cancelIntent).action === "history-only") {
    await keepCompletedAfterCancel(job);
    return;
  }
  const result = job.result && typeof job.result === "object" ? job.result : {};
  const raws = Array.isArray(result.assets) ? result.assets : [];
  const context = jobContext(job);
  const assets = raws.length
    ? await registerAssets(raws, { context: context, prepend: true })
    : [];
  job._registeredAssets = assets.map((asset) => asset.asset_id);

  if (isCancelIntent(job)) {
    await keepCompletedAfterCancel(job);
    return;
  }

  const kind = normalizeKind(job.kind);
  if (isRepairJobKind(kind)) {
    await completeRepairJob(job);
    return;
  }
  if (isTileJobKind(kind)) {
    await completeTileJob(job);
    return;
  }

  const { target, makeCurrent } = selectTargetForJob(job, assets);
  if (target && makeCurrent && assetIsInputCapable(target)) {
    state.currentInputId = target.asset_id;
    state.currentHasTransparency = Boolean(
      target.normalization && target.normalization.has_transparency === true
    );
    state.previewId = target.asset_id;
    clearBBox();
  } else if (target) {
    state.previewId = target.asset_id;
  }
  if (normalizeKind(job.kind) === "recolor_svg" && target) {
    state.recolor.assetId = target.asset_id;
    state.recolor.signature = "";
  }

  const pendingTileCrop = state.tile.pendingCrop && state.tile.pendingCropJobId === job.job_id;
  if (pendingTileCrop) {
    state.tile.pendingCrop = false;
    state.tile.pendingCropJobId = null;
    if (target && assetIsInputCapable(target)) {
      state.tile.unitId = target.asset_id;
      state.tile.error = "";
      showToast("裁切已保存，并已选中为平铺单元。", "success", 4500);
    } else {
      state.tile.error = "裁切完成，但没有找到可用的裁切单元资产。";
    }
  }

  renderAll();
  if (kind !== "export" && target) {
    commitWorkspace({ label: "应用「" + jobLabel(job.kind) + "」" });
  }
  if (target && assetIsPreviewable(target)) {
    await loadPreview();
  }

  if (kind === "export") {
    showToast("ZIP 已生成。请在任务结果或版本中下载，包内只含选中资产。", "success", 6500);
  } else if (pendingTileCrop && target) {
    // The crop message above already names the tile unit.
  } else if (target && makeCurrent) {
    showToast(jobLabel(job.kind) + "完成，已切换至新版本。可用撤销回到处理前。", "success", 5000);
  } else if (target) {
    showToast("任务完成，已显示成果预览。可继续设为输入或下载。", "success", 4500);
  } else {
    showToast("任务完成，可在版本区选择成果。", "success", 4500);
  }
}

function findInputAssetForJob(assets, kind) {
  const aliases = {
    crop: ["crop", "cropped"],
    prepare: ["prepared"],
    prepare_job: ["prepared"],
    enhance: ["enhance", "enhanced"],
    enhanced: ["enhance", "enhanced"],
    working_copy: ["working_copy"],
    workingcopy: ["working_copy"]
  };
  const wanted = aliases[kind] || [kind];
  const exact = assets.find((asset) => {
    if (!assetIsInputCapable(asset)) return false;
    return wanted.includes(normalizeKind(asset.kind));
  });
  if (exact) return exact;
  return assets.find((asset) => assetIsInputCapable(asset) && !assetIsSvg(asset)) || null;
}

function findSvgAsset(assets, job) {
  const svgs = assets.filter((asset) => assetIsSvg(asset));
  if (!svgs.length) return null;
  const params = job && job.parameters && typeof job.parameters === "object" ? job.parameters : {};
  const mode = (params.vector && params.vector.mode) || params.mode;
  if (mode === "monochrome") {
    return svgs.find((asset) => normalizeKind(asset.kind).includes("mono")) || svgs[0];
  }
  if (mode === "color") {
    return svgs.find((asset) => normalizeKind(asset.kind).includes("color")) || svgs[0];
  }
  return svgs[0];
}

function findTransparentAsset(assets) {
  return assets.find((asset) => {
    if (!assetIsInputCapable(asset)) return false;
    const kind = normalizeKind(asset.kind);
    return kind.includes("transparent") || kind === "foreground";
  }) || null;
}

async function retryJob(jobId) {
  if (!jobId) return;
  const candidate = state.tasks.get(jobId) || findHistoryJob(jobId);
  if (!candidate || !jobAllowsRetry(candidate)) {
    showToast(isRepairJobKind(candidate && candidate.kind)
      ? "没有归档编辑调用的收费修复不能通用重试；请从修复面板显式复用归档或重新发起。"
      : "AI 相关任务不能通过通用重试再次执行。请恢复历史后在对应面板中处理。", "warning", 6500);
    return;
  }
  if (state.requestInFlight || state.pendingSubmission || state.taskRunning) {
    showToast("当前有提交或任务正在处理，完成后再重试。", "warning");
    return;
  }
  setError(dom.composeError, "");
  startSubmission({
    path: "/jobs/" + encodeURIComponent(jobId) + "/retry",
    method: "POST",
    label: "重试任务",
    bodyFactory: null,
    onSuccess: async (data) => {
      const job = extractJobFromResponse(data);
      if (!job) throw new ApiError("重试响应缺少 job_id。", { status: 202 });
      closeHistory({ restoreFocus: false, immediate: true });
      await adoptJob(job, { announce: true });
    },
    onError: (error) => {
      setError(dom.composeError, "重试未创建：" + friendlyError(error));
      showToast("重试未创建：" + friendlyError(error), "error");
    },
    onUnknown: () => {
      setError(dom.composeError, "重试提交结果未知，请用页面顶部提示重试。");
      closeHistory({ restoreFocus: false, immediate: true });
    }
  });
}

function renderTask() {
  const job = state.activeJobId ? state.tasks.get(state.activeJobId) : null;
  setHidden(dom.taskEmpty, Boolean(job));
  setHidden(dom.taskBody, !job);
  if (!job) {
    setHidden(dom.taskStatus, true);
    dom.taskSteps.replaceChildren();
    dom.taskResults.replaceChildren();
    setError(dom.taskError, "");
    setText(dom.taskPollError, "");
    setHidden(dom.taskPollError, true);
    setHidden(dom.taskRetry, true);
    setHidden(dom.taskCancel, true);
    setHidden(dom.taskPoll, true);
    setHidden(dom.taskEvaluate, true);
    setHidden(dom.taskCancelNote, true);
    return;
  }

  setHidden(dom.taskStatus, false);
  const jobState = String(job.state || "").toLowerCase();
  dom.taskStatus.className = "status-pill is-" + (jobState || "queued");
  setText(dom.taskStatus, stateLabel(job.state));
  setText(dom.taskKind, jobLabel(job.kind));
  setText(dom.taskId, "#" + shortId(job.job_id) + (job.retry_of ? " · 重试自 #" + shortId(job.retry_of) : ""));
  setText(dom.taskTime, formatTime(job.finished_at || job.updated_at || job.created_at));

  const steps = (job.result && Array.isArray(job.result.steps) ? job.result.steps : null) ||
    (Array.isArray(job.steps) ? job.steps : []);
  dom.taskSteps.replaceChildren();
  for (const step of steps) {
    const li = element("li", "task-step is-" + String(step.state || "").toLowerCase());
    li.append(element("span", "step-dot"));
    li.append(element("span", "step-name", stepLabel(step.name)));
    li.append(element("span", "step-state", stateLabel(step.state)));
    dom.taskSteps.append(li);
  }

  const jobError = job.error && (job.error.message || job.error.code)
    ? (job.error.message || "任务失败，可查看历史后重试。")
    : "";
  setError(dom.taskError, jobError);
  dom.taskError.classList.toggle("is-notice", jobState === "cancelled");
  setHidden(dom.taskCancelNote, !state.cancelNote);
  setText(dom.taskCancelNote, state.cancelNote);

  const pollError = state.pollErrors.get(job.job_id) || "";
  if (pollError) {
    dom.taskPollError.textContent = pollError;
    dom.taskPollError.hidden = false;
  } else {
    dom.taskPollError.textContent = "";
    dom.taskPollError.hidden = true;
  }

  setHidden(dom.taskRetry, job.state !== "failed" || !jobAllowsRetry(job));
  setDisabled(dom.taskRetry, state.requestInFlight || Boolean(state.pendingSubmission));
  const showPoll = state.pollStopped.has(job.job_id) || Boolean(pollError);
  setHidden(dom.taskPoll, !showPoll);
  setDisabled(dom.taskPoll, state.requestInFlight);
  setHidden(dom.taskEvaluate, !isJobEnded(job));

  renderTaskResults(job);
}

function renderTaskResults(job) {
  dom.taskResults.replaceChildren();
  const result = job.result && typeof job.result === "object" ? job.result : {};
  const rawAssets = Array.isArray(result.assets) ? result.assets : [];
  const ids = [];
  for (const raw of rawAssets) {
    const id = assetIdOf(raw);
    if (id && !ids.includes(id)) ids.push(id);
  }
  const registered = Array.isArray(job._registeredAssets) ? job._registeredAssets : [];
  for (const id of registered) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length) {
    if (job.state === "failed") {
      dom.taskResults.append(element("p", "hint", "失败不会生成成果；旧记录与成果保持不变。"));
    } else if (job.state === "cancelled") {
      dom.taskResults.append(element("p", "hint", "任务已取消，没有应用到工作区；处理起点已恢复。"));
    } else if (job.state === "succeeded") {
      dom.taskResults.append(element("p", "hint", "任务已完成，但未返回可展示的资产。"));
    }
    return;
  }
  if (job.state === "cancelled") {
    dom.taskResults.append(element("p", "hint", "已取消：以下为取消前已发布的中间成果，保留在历史中，未应用到工作区。"));
  }

  for (const id of ids) {
    const asset = state.assets.get(id);
    const row = element("div", "task-result-item");
    const copy = element("div", "task-result-copy");
    copy.append(element("strong", "", asset ? assetDisplayName(asset) : "成果 #" + shortId(id)));
    copy.append(element("small", "", asset && assetIsArchive(asset) ? "ZIP 下载" : "可预览或下载"));
    row.append(copy);

    if (asset && assetIsPreviewable(asset)) {
      const preview = element("button", "icon-button");
      preview.type = "button";
      preview.title = "预览成果";
      preview.setAttribute("aria-label", "预览" + (assetDisplayName(asset)));
      preview.append(icon("image"));
      preview.addEventListener("click", () => {
        void setPreview(id, {});
      });
      row.append(preview);
    }

    const download = element("button", "icon-button");
    download.type = "button";
    download.title = "下载成果";
    download.setAttribute("aria-label", "下载" + (asset ? assetDisplayName(asset) : "成果"));
    download.append(icon("download"));
    download.addEventListener("click", () => {
      if (asset) void downloadAsset(asset, download);
      else showToast("成果元数据尚未读取，暂不能下载。", "warning");
    });
    row.append(download);
    dom.taskResults.append(row);
  }
}

/* -------------------------------------------------------------------------- */
/* Feedback                                                                   */
/* -------------------------------------------------------------------------- */

function resetFeedbackForm() {
  dom.feedbackForm.reset();
  dom.feedbackError.hidden = true;
  dom.feedbackError.textContent = "";
  setText(dom.ratingReadout, "未评分");
  for (const label of dom.ratingStars.querySelectorAll("label")) label.classList.remove("is-filled");
  updateActionState();
}

function setFeedbackJob(jobId, options) {
  const opts = options || {};
  const job = state.tasks.get(jobId);
  if (!job || !isJobEnded(job)) {
    showToast("只有已结束的任务可以评价。", "warning");
    return;
  }
  assignFeedbackJob(jobId);
  renderFeedback();
  if (opts.focus) {
    const first = dom.feedbackForm.querySelector('input[name="rating"]');
    revealStageFor(dom.feedbackForm);
    dom.feedbackForm.scrollIntoView({ behavior: "smooth", block: "center" });
    if (first) first.focus({ preventScroll: true });
  }
}

function renderFeedback() {
  const job = state.feedbackJobId ? state.tasks.get(state.feedbackJobId) : null;
  const ended = Boolean(job && isJobEnded(job));
  const response = job ? state.feedbackResponses.get(job.job_id) : null;
  setText(dom.feedbackJobChip, job ? "#" + shortId(job.job_id) : "未选择");
  setHidden(dom.feedbackEmpty, Boolean(job && ended));
  setHidden(dom.feedbackForm, !(job && ended) || Boolean(response));
  setHidden(dom.feedbackSuccess, !response);
  if (!job || !ended) {
    dom.feedbackEmpty.textContent = job
      ? "任务尚未结束。完成或真实失败后可评价。"
      : "已完成或失败的任务可评价。授权项分别保存，且默认关闭。";
    return;
  }
  if (response) {
    const feedbackId = response.feedback_id || response.feedbackId || "";
    dom.feedbackSuccessText.textContent = feedbackId
      ? "记录编号 " + feedbackId + "。展示与训练授权按本次勾选分别保存。"
      : "展示与训练授权按本次勾选分别保存。";
    return;
  }
  updateActionState();
}

async function handleFeedbackSubmit() {
  if (state.requestInFlight || state.pendingSubmission) return;
  const job = state.feedbackJobId ? state.tasks.get(state.feedbackJobId) : null;
  if (!job || !isJobEnded(job)) {
    setError(dom.feedbackError, "请选择一个已结束的任务。");
    return;
  }
  const ratingNode = dom.feedbackForm.querySelector('input[name="rating"]:checked');
  const rating = ratingNode ? Number(ratingNode.value) : 0;
  if (![1, 2, 3, 4, 5].includes(rating)) {
    setError(dom.feedbackError, "请先选择 1–5 分评分。");
    return;
  }
  const issues = Array.from(dom.feedbackForm.querySelectorAll('input[name="feedback-issue"]:checked'))
    .map((node) => node.value)
    .filter((value) => Object.prototype.hasOwnProperty.call(ISSUE_LABELS, value));
  const payload = {
    job_id: job.job_id,
    rating: rating,
    issues: issues,
    comment: dom.feedbackComment.value.trim(),
    allow_training: Boolean(dom.allowTraining.checked),
    allow_display: Boolean(dom.allowDisplay.checked)
  };
  setError(dom.feedbackError, "");
  const bodyText = JSON.stringify(payload);
  startSubmission({
    path: "/feedback",
    method: "POST",
    label: "提交评价",
    bodyFactory: () => bodyText,
    onSuccess: async (data) => {
      state.feedbackResponses.set(job.job_id, data && typeof data === "object" ? data : {});
      renderFeedback();
      showToast("评价已保存；两项授权按本次选择分别记录。", "success", 5000);
    },
    onError: (error) => {
      setError(dom.feedbackError, friendlyError(error));
      showToast("评价未保存：" + friendlyError(error), "error");
    },
    onUnknown: () => setError(dom.feedbackError, "评价提交结果未知，请用页面顶部提示重试。")
  });
}

function updateRatingUI() {
  const selected = dom.feedbackForm.querySelector('input[name="rating"]:checked');
  const value = selected ? Number(selected.value) : 0;
  const labels = Array.from(dom.ratingStars.querySelectorAll("label"));
  labels.forEach((label, index) => label.classList.toggle("is-filled", index < value));
  setText(dom.ratingReadout, value ? value + " / 5" : "未评分");
  setError(dom.feedbackError, "");
  updateActionState();
}

/* -------------------------------------------------------------------------- */
/* AI candidate workflow                                                      */
/* -------------------------------------------------------------------------- */

function aiPipelineId(pipeline) {
  return String((pipeline && (pipeline.pipeline_id || pipeline.id)) || "");
}

function normalizeAiPipeline(raw) {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw.pipeline && typeof raw.pipeline === "object" ? raw.pipeline : raw;
  const id = aiPipelineId(candidate);
  if (!id) return null;
  return Object.assign({}, candidate, { pipeline_id: id });
}

function isAiActive(pipeline) {
  const pipelineState = String((pipeline && pipeline.state) || "").toLowerCase();
  return pipelineState === "queued" || pipelineState === "running";
}

function isAiWaiting(pipeline) {
  return String((pipeline && pipeline.state) || "").toLowerCase() === "waiting_user";
}

function aiLayerSelectionAvailable(pipeline) {
  const pipelineState = String((pipeline && pipeline.state) || "").toLowerCase();
  return pipelineState === "waiting_user" || pipelineState === "succeeded" || pipelineState === "failed";
}

function aiStateClass(stateName) {
  const value = String(stateName || "").toLowerCase();
  return "status-pill is-" + (value || "queued");
}

async function refreshAiStatus(announce) {
  if (state.ai.statusLoading) return;
  state.ai.statusLoading = true;
  state.ai.statusError = "";
  renderAiPanel();
  try {
    const result = await requestJson("/seedream/status");
    state.ai.status = result.data && typeof result.data === "object" ? result.data : {};
  } catch (error) {
    state.ai.statusError = friendlyError(error);
    if (announce) showToast("无法读取 AI 状态：" + friendlyError(error), "error");
  } finally {
    state.ai.statusLoading = false;
    renderAiPanel();
    renderRepairPanel();
    updateActionState();
  }
}

function aiNewGenerationAvailable() {
  return Boolean(state.ai.status && state.ai.status.enabled === true && state.ai.status.disabled !== true);
}

function renderAiService() {
  const service = dom.aiService;
  service.classList.remove("is-ok", "is-warn", "is-error");
  dom.aiServiceDot.className = "status-dot";

  if (state.ai.statusLoading) {
    service.classList.add("is-warn");
    dom.aiServiceDot.classList.add("is-warn");
    setText(dom.aiServiceLabel, "正在读取 AI 能力…");
    setText(dom.aiServiceNote, "读取过程中仍可使用本地处理。");
    return;
  }
  if (state.ai.statusError) {
    service.classList.add("is-error");
    dom.aiServiceDot.classList.add("is-danger");
    setText(dom.aiServiceLabel, "无法读取 AI 状态");
    setText(dom.aiServiceNote, "本地处理不受影响；也可以填写归档编号只读复用。");
    return;
  }
  if (aiNewGenerationAvailable()) {
    service.classList.add("is-ok");
    dom.aiServiceDot.classList.add("is-ok");
    setText(dom.aiServiceLabel, "AI 新生成可用");
    setText(dom.aiServiceNote, "每次生成都需要分别确认上传与费用；不会自动重试，也不会自动合并。");
  } else {
    service.classList.add("is-warn");
    dom.aiServiceDot.classList.add("is-warn");
    setText(dom.aiServiceLabel, "AI 新生成暂不可用");
    setText(dom.aiServiceNote, "服务端尚未开放新生成。可在“设置”中检查 API Key、付费开关与预算，或复用归档候选。");
  }
}

function aiStartBlockReason() {
  if (state.requestInFlight) return "正在提交，请稍候。";
  if (state.duplicateSwitching) return "正在切换已有版本，请稍候。";
  if (state.pendingSubmission) return "请先重试或放弃上一次没有确定结果的提交。";
  if (state.taskRunning) return "本地任务处理中，完成后再开始新的 AI 尝试。";
  if (state.ai.layersLoading) return "正在读取候选图层…";
  const pipeline = state.ai.pipeline;
  if (pipeline && (isAiActive(pipeline) || isAiWaiting(pipeline))) return "请先完成或拒绝当前候选。";
  const asset = currentAsset();
  if (!asset) return "先上传一张纹样，再发起 AI 拆层。";
  if (!isPreviewCurrent()) return "画布正在预览其他版本，请先回到当前输入。";
  if (normalizeKind(asset.kind) !== "normalized_input") {
    return "AI 拆层需要规范输入版本；请在版本区将规范输入设为当前输入。";
  }
  const callId = dom.aiCallId.value.trim();
  if (callId) return "";
  if (state.ai.statusLoading) return "正在读取 AI 状态…";
  if (state.ai.statusError) return "AI 状态不可用，可改用归档编号或本地处理。";
  if (!aiNewGenerationAvailable()) return "AI 新生成暂不可用，可继续本地处理。";
  if (!dom.aiConsentUpload.checked || !dom.aiConsentCharge.checked) {
    return "请分别确认上传与可能产生的费用。";
  }
  return "";
}

function renderAiStart() {
  const reuse = Boolean(dom.aiCallId.value.trim());
  dom.aiConsentUpload.disabled = reuse;
  dom.aiConsentCharge.disabled = reuse;
  dom.aiConsents.classList.toggle("is-disabled", reuse);
  setButtonLabel(dom.aiStartButton, reuse ? "读取归档候选" : "生成 AI 候选");
  const reason = aiStartBlockReason();
  setDisabled(dom.aiStartButton, Boolean(reason));
  setText(dom.aiStartNote, reason || (reuse
    ? "将只读取已归档结果，不生成、不产生新费用。"
    : "生成完成后不会自动合并，所有图层默认不选。"));
}

function renderAiVectorSummary() {
  const mode = checkedValue("vector-mode");
  const colors = checkedValue("max-colors");
  const detail = checkedValue("vector-detail");
  const modeLabels = { monochrome: "黑白", color: "彩色" };
  const detailLabels = { low: "低细节", medium: "中细节", high: "高细节" };
  if (dom.aiVectorSummary) {
    setText(dom.aiVectorSummary,
      (modeLabels[mode] || "彩色") + " · " + (colors || "8") + " 色 · " + (detailLabels[detail] || "中细节"));
  }
}

function setAiError(message) {
  state.ai.error = message || "";
  setError(dom.aiError, state.ai.error);
}

function renderAiPanel() {
  renderAiService();
  renderAiStart();
  renderAiVectorSummary();
  renderAiPipeline();
  renderAiWorkflowTrace();
  renderAiRerun();
  renderAiCandidates();
  setError(dom.aiError, state.ai.error || "");
}

function renderAiPipeline() {
  const pipeline = state.ai.pipeline;
  const hasPipeline = Boolean(pipeline);
  setHidden(dom.aiEmpty, hasPipeline);
  setHidden(dom.aiPipeline, !hasPipeline);
  setText(dom.aiStateBadge, pipeline ? (AI_STATE_LABELS[pipeline.state] || "处理中") : "未开始");
  setHidden(dom.aiResult, true);
  dom.aiResultList.replaceChildren();

  if (!pipeline) {
    dom.aiSteps.replaceChildren();
    setError(dom.aiPipelineError, "");
    setHidden(dom.aiDecision, true);
    return;
  }

  setText(dom.aiPipelineTitle, "AI 拆层流程");
  let meta = "输入 #" + shortId(pipeline.input_asset_id) + " · 更新 " +
    formatTime(pipeline.finished_at || pipeline.updated_at || pipeline.created_at);
  if (state.ai.layersLoading) meta += " · 正在读取候选图层…";
  if (state.ai.pollError) meta += " · 状态查询暂时失败";
  setText(dom.aiPipelineMeta, meta);
  dom.aiPipelineState.className = aiStateClass(pipeline.state);
  setText(dom.aiPipelineState, AI_STATE_LABELS[pipeline.state] || "处理中");

  const steps = (pipeline.result && Array.isArray(pipeline.result.steps) ? pipeline.result.steps : null) ||
    (Array.isArray(pipeline.steps) ? pipeline.steps : []);
  dom.aiSteps.replaceChildren();
  for (const step of steps) {
    const item = element("li", "task-step is-" + String(step.state || "").toLowerCase());
    item.append(element("span", "step-dot"));
    item.append(element("span", "step-name", stepLabel(step.name)));
    item.append(element("span", "step-state", stateLabel(step.state)));
    dom.aiSteps.append(item);
  }

  const pipelineError = pipeline.error && (pipeline.error.message || pipeline.error.code)
    ? (pipeline.error.message || "AI 流程失败。")
    : "";
  setError(dom.aiPipelineError, pipelineError);
  setHidden(dom.aiRefreshPipeline, false);

  const stateName = String(pipeline.state || "").toLowerCase();
  const waiting = stateName === "waiting_user";
  const failed = stateName === "failed";
  const showDecision = waiting || (failed && !pipeline.decision);
  setHidden(dom.aiDecision, !showDecision);
  if (showDecision) {
    const count = state.ai.selectedLayerIds.size;
    setText(dom.aiSelectionNote, waiting
      ? aiSelectionSummaryText(aiCandidateLayers())
      : "AI 流程失败，可使用本地处理继续");
    setHidden(dom.aiCompose, failed);
    setText(dom.aiCompose, count ? "合成所选图层（" + count + "）" : "合成所选图层");
    setHidden(dom.aiUseLocal, false);
    setHidden(dom.aiReject, failed);
  }

  const resultAssets = pipeline.result && Array.isArray(pipeline.result.assets)
    ? pipeline.result.assets
    : [];
  if (["succeeded", "failed"].includes(stateName) && resultAssets.length) {
    setHidden(dom.aiResult, false);
    renderAssetActionList(dom.aiResultList, resultAssets);
  } else if (stateName === "rejected") {
    setHidden(dom.aiResult, false);
    dom.aiResultList.replaceChildren(element("p", "hint", "候选已拒绝，没有创建成果或新费用。你仍可继续使用本地处理。"));
    const jump = element("button", "btn btn-outline btn-sm", "返回本地处理");
    jump.type = "button";
    jump.addEventListener("click", () => {
      const heading = document.getElementById("controls-heading");
      if (heading) {
        revealStageFor(heading);
        heading.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
    dom.aiResultList.append(jump);
  }
}

function renderAiWorkflowTrace() {
  const pipeline = state.ai.pipeline;
  setHidden(dom.aiTrace, !pipeline);
  if (!pipeline) {
    dom.aiRecovery.replaceChildren();
    dom.aiBranches.replaceChildren();
    dom.aiWorkflowPromptText.textContent = "";
    setHidden(dom.aiWorkflowSnapshot, true);
    return;
  }
  const trace = normalizeWorkflowTrace(pipeline);
  setText(dom.aiTraceChip, trace.available ? "服务端记录" : "未提供");
  setText(dom.aiWorkflowId, trace.workflow.id || "—");
  setText(dom.aiWorkflowVersion, trace.workflow.version || "—");
  const prompt = [trace.workflow.promptId, trace.workflow.promptVersion].filter(Boolean).join(" · ");
  setText(dom.aiWorkflowPrompt, prompt || "—");
  setText(dom.aiWorkflowModel, trace.workflow.model || "—");
  setText(dom.aiWorkflowSelection, selectionPolicyLabel(trace.workflow.selectionPolicy) || "—");
  setText(dom.aiWorkflowInput, trace.workflow.inputAssetId ? "#" + shortId(trace.workflow.inputAssetId) : "—");

  if (trace.workflow.promptText) {
    dom.aiWorkflowPromptText.textContent = trace.workflow.promptText;
    setHidden(dom.aiWorkflowSnapshot, false);
  } else {
    dom.aiWorkflowPromptText.textContent = "";
    setHidden(dom.aiWorkflowSnapshot, true);
  }

  const notes = [];
  if (!trace.available) notes.push("服务端尚未返回 workflow 记录；现有流程仍可继续。");
  if (trace.workflow.snapshotAvailable && !trace.workflow.promptText) {
    notes.push("已记录运行快照，但未提供可展示的提示词文本。");
  }
  if (state.ai.traceError) notes.push(state.ai.traceError);
  setHidden(dom.aiWorkflowNote, notes.length === 0);
  setText(dom.aiWorkflowNote, notes.join(" "));

  renderAiRecovery(trace);
  renderAiBranches(trace);
}

function renderAiRecovery(trace) {
  dom.aiRecovery.replaceChildren();
  const recovery = trace.recovery;
  if (!recovery) {
    dom.aiRecovery.append(element("p", "ai-recovery-note",
      "未提供恢复信息；失败时只可重跑本地步骤，页面不会自动重试云端请求。"));
    return;
  }
  const bits = [];
  if (recovery.state) {
    bits.push("状态 " + (RECOVERY_STATE_LABELS[String(recovery.state).toLowerCase()] || recovery.state));
  }
  if (recovery.step) bits.push("步骤 " + recovery.step);
  bits.push(recovery.retryable ? "服务端标记为可重试" : "不自动重试");
  dom.aiRecovery.append(element("p", "ai-recovery-note", bits.join(" · ")));
  if (recovery.uncertain) {
    dom.aiRecovery.append(element("p", "ai-recovery-note",
      "云端结果不确定：不能视为未计费，也不会自动重发。"));
  }
  if (recovery.needsReconcile) {
    dom.aiRecovery.append(element("p", "ai-recovery-note",
      "需要核对云端请求状态；页面不会自动重试，请先重新查询。"));
  }
  if (recovery.canCompose === true) {
    dom.aiRecovery.append(element("p", "ai-recovery-note", "可复用已归档候选图层重跑本地合成。"));
  } else if (recovery.canCompose === false) {
    dom.aiRecovery.append(element("p", "ai-recovery-note", "当前没有可复用的已归档候选图层。"));
  }
  if (recovery.vectorInputAssetIds.length) {
    dom.aiRecovery.append(element("p", "ai-recovery-note",
      "可重跑矢量化的本流程 PNG：" + recovery.vectorInputAssetIds.length + " 个。"));
  }
  if (recovery.providerCallId) {
    dom.aiRecovery.append(element("p", "ai-recovery-note",
      "云端请求 #" + shortId(recovery.providerCallId) + "。"));
  }
  if (recovery.message) dom.aiRecovery.append(element("p", "ai-recovery-note", recovery.message));
  if (recovery.action) {
    const list = element("ul", "ai-recovery-list");
    list.append(element("li", "", "建议下一步：" + recovery.action));
    dom.aiRecovery.append(list);
  }
}

function aiBranchLabel(branch) {
  const action = String((branch && branch.action) || "").toLowerCase();
  if (action === "compose") return "重跑合成";
  if (action === "vectorize") return "重跑矢量化";
  return jobLabel((branch && (branch.kind || branch.action)) || "局部重跑");
}

function renderAiBranches(trace) {
  dom.aiBranches.replaceChildren();
  if (!trace.branches.length) {
    dom.aiBranches.append(element("p", "ai-recovery-note", "尚无局部重跑分支。"));
    return;
  }
  for (const branch of trace.branches) {
    const row = element("div", "ai-branch");
    const copy = element("div", "ai-branch-copy");
    copy.append(element("strong", "", aiBranchLabel(branch)));
    const meta = [];
    if (branch.jobId) meta.push("#" + shortId(branch.jobId));
    if (branch.parentJobId) meta.push("父 #" + shortId(branch.parentJobId));
    if (branch.state) meta.push(stateLabel(branch.state));
    if (branch.createdAt) meta.push(formatTime(branch.createdAt));
    copy.append(element("small", "", meta.filter(Boolean).join(" · ")));
    row.append(copy);

    const actions = element("div", "ai-branch-actions");
    const restore = element("button", "btn btn-quiet btn-xs", "恢复");
    restore.type = "button";
    restore.title = "恢复此分支的输入、参数与成果";
    restore.addEventListener("click", () => void restoreJob(branch.jobId));
    actions.append(restore);
    row.append(actions);
    dom.aiBranches.append(row);
  }
}

function setAiRerunError(message) {
  setError(dom.aiRerunError, message || "");
}

function aiVectorCandidates(pipeline) {
  if (!pipeline) return [];
  // workflowPngCandidates treats recovery.vector_input_asset_ids as authoritative
  // whenever the server provides recovery, so original cloud layers and repair
  // candidates are never offered as vectorization inputs.
  return workflowPngCandidates(pipeline, state.assets);
}

async function ensureRecoveryAssets(pipeline) {
  const trace = normalizeWorkflowTrace(pipeline);
  const ids = trace.recovery ? trace.recovery.vectorInputAssetIds : [];
  if (!ids.length) return;
  const missing = ids.filter((id) => !state.assets.has(String(id))).slice(0, 32);
  if (!missing.length) return;
  const pipelineId = aiPipelineId(pipeline);
  try {
    if (!state.ai.pipeline || aiPipelineId(state.ai.pipeline) !== pipelineId) return;
    const assets = await registerAssets(missing.map((id) => ({ asset_id: id })), {
      context: { origin: "workflow_recovery", aiPipelineId: pipelineId },
      prepend: false
    });
    if (assets.length) {
      renderVersions();
      renderAiRerun();
      updateActionState();
    }
  } catch (_) {
    /* Recovery metadata is optional; rerun stays unavailable if it cannot be read. */
  }
}

function renderAiRerun() {
  const pipeline = state.ai.pipeline;
  setHidden(dom.aiRerun, !pipeline);
  if (!pipeline) {
    dom.aiRerunInput.replaceChildren();
    dom.aiRerunInput.dataset.signature = "";
    setAiRerunError("");
    return;
  }

  const trace = normalizeWorkflowTrace(pipeline);
  const candidates = aiVectorCandidates(pipeline);
  const signature = candidates.map((asset) => assetIdOf(asset)).join("|");
  if (dom.aiRerunInput.dataset.signature !== signature) {
    dom.aiRerunInput.replaceChildren();
    dom.aiRerunInput.dataset.signature = signature;
    if (!candidates.length) {
      const option = element("option", "", "没有本流程产生的 PNG");
      option.value = "";
      dom.aiRerunInput.append(option);
    } else {
      for (const asset of candidates) {
        const id = assetIdOf(asset);
        const option = element("option", "", assetDisplayName(asset) + " · #" + shortId(id));
        option.value = id;
        dom.aiRerunInput.append(option);
      }
    }
  }
  const available = new Set(candidates.map((asset) => assetIdOf(asset)));
  if (!available.has(state.ai.rerunAssetId)) {
    state.ai.rerunAssetId = candidates.length ? assetIdOf(candidates[0]) : "";
  }
  if (state.ai.rerunAssetId && dom.aiRerunInput.value !== state.ai.rerunAssetId) {
    dom.aiRerunInput.value = state.ai.rerunAssetId;
  }

  const layers = state.ai.layers && Array.isArray(state.ai.layers.layers) ? state.ai.layers.layers : [];
  const selectedCount = state.ai.selectedLayerIds.size;
  const canCompose = !trace.recovery || trace.recovery.canCompose !== false;
  const notes = [];
  if (!canCompose) notes.push("服务端没有可复用的已归档图层；合成重跑暂不可用。");
  else if (!layers.length) notes.push("尚无已归档候选图层；合成重跑暂不可用。");
  else if (!selectedCount) notes.push("请先在候选图层中勾选要保留的图层。");
  if (!candidates.length) notes.push("尚未找到本流程产生的 PNG；矢量化重跑暂不可用。");
  if (state.ai.traceError) notes.push(state.ai.traceError);
  setText(dom.aiRerunNote, notes.length
    ? notes.join(" ")
    : "可在候选图层中调整勾选后重跑合成；重跑会创建新的本地任务，旧结果保留。");
  setButtonLabel(dom.aiRerunCompose, selectedCount
    ? "用所选图层重跑合成（" + selectedCount + "）"
    : "用所选图层重跑合成");
  setDisabled(dom.aiRerunCompose, !(canCompose && layers.length && selectedCount));
  setDisabled(dom.aiRerunVectorize, !state.ai.rerunAssetId);
}

async function refreshAiTraceNow() {
  const pipeline = state.ai.pipeline;
  if (!pipeline) return false;
  const id = aiPipelineId(pipeline);
  try {
    const result = await requestJson("/pipelines/" + encodeURIComponent(id));
    if (!state.ai.pipeline || aiPipelineId(state.ai.pipeline) !== id) return false;
    const next = normalizeAiPipeline(result.data && result.data.pipeline ? result.data.pipeline : result.data);
    if (!next) return false;
    state.ai.pipeline = next;
    state.ai.traceError = "";
    void ensureRecoveryAssets(next);
    renderAiPanel();
    updateActionState();
    return true;
  } catch (error) {
    state.ai.traceError = "刷新流程记录失败：" + friendlyError(error);
    renderAiWorkflowTrace();
    updateActionState();
    return false;
  }
}

async function handleAiRerun(action) {
  const pipeline = state.ai.pipeline;
  if (!pipeline) return;
  if (isAiActive(pipeline)) {
    setAiRerunError("流程仍在生成中，完成后再局部重跑。");
    return;
  }
  const revision = Number(pipeline.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    setAiRerunError("流程修订号无效，请先刷新流程。");
    return;
  }
  const vector = readVectorParams();
  if (!vector.ok) {
    setAiRerunError(vector.error);
    return;
  }
  const path = "/pipelines/" + encodeURIComponent(aiPipelineId(pipeline)) + "/rerun";
  const trace = normalizeWorkflowTrace(pipeline);
  let built;
  let label;
  let kind;
  let targetAssetId;
  if (action === "compose") {
    if (trace.recovery && trace.recovery.canCompose === false) {
      setAiRerunError("服务端没有可复用的已归档图层；合成重跑暂不可用。");
      return;
    }
    const layerIds = Array.from(state.ai.selectedLayerIds);
    built = composeRerunPayload({ revision, layerIds, vector: vectorPayloadFrom(vector) });
    label = "局部重跑合成";
    kind = "compose_layers";
    const pipelineInput = pipeline.input_asset_id ? String(pipeline.input_asset_id) : "";
    targetAssetId = pipelineInput && state.assets.has(pipelineInput) ? pipelineInput : state.currentInputId;
  } else {
    const allowedInputs = new Set(aiVectorCandidates(pipeline).map((asset) => assetIdOf(asset)));
    if (!allowedInputs.has(dom.aiRerunInput.value)) {
      setAiRerunError("请选择本流程产生的 PNG；可刷新流程后重试。");
      return;
    }
    built = vectorizeRerunPayload({
      revision,
      inputAssetId: dom.aiRerunInput.value,
      vector: vectorPayloadFrom(vector)
    });
    label = "局部重跑矢量化";
    kind = "vectorize";
    targetAssetId = dom.aiRerunInput.value;
  }
  if (!built.ok) {
    setAiRerunError(built.error);
    return;
  }
  setAiRerunError("");
  const pipelineId = aiPipelineId(pipeline);
  const started = await runLocalRequest({
    ok: true,
    path: path,
    label: label,
    kind: kind,
    targetAssetId: targetAssetId,
    errorNode: dom.aiRerunError,
    payload: built.payload,
    onJob: (job) => {
      job.ai_pipeline_id = pipelineId;
      state.ai.branchJobs.set(job.job_id, pipelineId);
      if (state.ai.pipeline && aiPipelineId(state.ai.pipeline) === pipelineId) {
        state.ai.pipeline = Object.assign({}, state.ai.pipeline, { revision: revision + 1 });
      }
      window.setTimeout(() => {
        if (state.ai.pipeline && aiPipelineId(state.ai.pipeline) === pipelineId) {
          void refreshAiTraceNow();
        }
      }, 350);
      showToast(label + "已提交，只执行本地步骤，不产生云端费用。", "info", 4500);
    }
  });
  if (!started && !state.requestInFlight) {
    setAiRerunError("局部重跑未创建；请检查当前任务状态后重试。");
  }
}

function aiLayerAsset(layer) {
  const placed = layer.placed_asset || layer.asset || null;
  return placed ? state.assets.get(assetIdOf(placed)) || null : null;
}

function aiLayerWarnings(layer, asset) {
  const source = layer && layer.asset && typeof layer.asset === "object" ? layer.asset : null;
  const metrics = (source && source.quality_metrics && typeof source.quality_metrics === "object")
    ? source.quality_metrics
    : (asset && asset.quality_metrics && typeof asset.quality_metrics === "object" ? asset.quality_metrics : null);
  return metrics && Array.isArray(metrics.warnings) ? metrics.warnings.slice() : [];
}

function aiCandidateLayers() {
  const layers = state.ai.layers && Array.isArray(state.ai.layers.layers)
    ? state.ai.layers.layers.slice()
    : [];
  layers.sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0));
  return layers;
}

function aiFilterCounts(layers) {
  return {
    all: layers.length,
    selected: layers.filter((layer) => state.ai.selectedLayerIds.has(String(layer.layer_id || ""))).length,
    review: layers.filter((layer) => aiLayerWarnings(layer, aiLayerAsset(layer)).length > 0).length
  };
}

function aiSelectionSummaryText(layers) {
  const count = state.ai.selectedLayerIds.size;
  if (!count) return "尚未选择图层；底图不参与合成";
  const selectedZ = layers
    .filter((layer) => state.ai.selectedLayerIds.has(String(layer.layer_id || "")))
    .map((layer) => Number(layer.z_index || 0));
  return "已选 " + count + " / " + layers.length + " 层 · 图层 " + selectedZ.join("、");
}

function updateAiFilterCounts(layers) {
  const counts = aiFilterCounts(layers);
  setText(dom.aiCountAll, counts.all);
  setText(dom.aiCountSelected, counts.selected);
  setText(dom.aiCountReview, counts.review);
  setText(dom.aiCandidateCount, counts.all + " 个");
  for (const button of dom.aiFilter.querySelectorAll("[data-ai-filter]")) {
    const active = button.dataset.aiFilter === state.ai.filter;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function renderAiCandidates() {
  const pipeline = state.ai.pipeline;
  const data = state.ai.layers;
  const stateName = String((pipeline && pipeline.state) || "").toLowerCase();
  const visible = Boolean(pipeline && data && ["waiting_user", "succeeded", "failed"].includes(stateName));
  setHidden(dom.aiCandidates, !visible);
  if (!visible) {
    dom.aiReferenceList.replaceChildren();
    dom.aiLayerList.replaceChildren();
    setHidden(dom.aiCandidateEmpty, true);
    return;
  }

  const layers = aiCandidateLayers();
  if (!["all", "selected", "review"].includes(state.ai.filter)) state.ai.filter = "all";
  updateAiFilterCounts(layers);

  dom.aiReferenceList.replaceChildren();
  const inputAsset = pipeline.input_asset_id ? state.assets.get(String(pipeline.input_asset_id)) : null;
  dom.aiReferenceList.append(buildAiReferenceCard("原输入", "用于本次拆层 · 规范输入", inputAsset));
  const basemapRaw = data.basemap || null;
  const basemap = basemapRaw ? state.assets.get(assetIdOf(basemapRaw)) || null : null;
  dom.aiReferenceList.append(buildAiReferenceCard("底图", "仅参考，不参与合成", basemap, true));

  const filtered = layers.filter((layer) => {
    if (state.ai.filter === "selected") return state.ai.selectedLayerIds.has(String(layer.layer_id || ""));
    if (state.ai.filter === "review") return aiLayerWarnings(layer, aiLayerAsset(layer)).length > 0;
    return true;
  });

  dom.aiLayerList.replaceChildren();
  setHidden(dom.aiCandidateEmpty, filtered.length > 0);
  if (!filtered.length) {
    setText(dom.aiCandidateEmpty, layers.length
      ? "当前筛选下没有候选图层。"
      : "这次拆层没有返回可选图层。可以拒绝候选或改用本地流程。");
  }
  for (const layer of filtered) {
    const asset = aiLayerAsset(layer);
    if (asset) dom.aiLayerList.append(buildAiLayerCard(layer, asset));
  }
}

function buildAiReferenceCard(label, description, asset, reference) {
  const card = element("article", "ai-reference");
  if (!asset) {
    card.append(element("p", "hint", label + "：暂不可用"));
    return card;
  }
  const thumb = element("div", "ai-reference-thumb");
  const image = element("img");
  image.alt = label + "预览";
  thumb.append(image);
  loadThumb(image, asset);
  card.append(thumb);

  const copy = element("div", "ai-reference-copy");
  copy.append(element("strong", "", label));
  copy.append(element("small", "", description));
  if (assetIsAi(asset)) copy.append(element("small", "ai-inline-note", "AI 生成 · 几何未核验"));
  card.append(copy);

  const actions = element("div", "ai-reference-actions");
  const view = element("button", "icon-button");
  view.type = "button";
  view.title = "查看" + label;
  view.setAttribute("aria-label", "查看" + label);
  view.append(icon("eye"));
  view.addEventListener("click", () => openAssetPreview(asset, reference ? "参考底图" : "原输入"));
  actions.append(view);

  const download = element("button", "icon-button");
  download.type = "button";
  download.title = "下载" + label;
  download.setAttribute("aria-label", "下载" + label);
  download.append(icon("download"));
  download.addEventListener("click", () => void downloadAsset(asset, download));
  actions.append(download);
  card.append(actions);
  return card;
}

function buildAiLayerCard(layer, asset) {
  const layerId = String(layer.layer_id || asset.asset_id);
  const selected = state.ai.selectedLayerIds.has(layerId);
  const pipeline = state.ai.pipeline;
  const selectable = aiLayerSelectionAvailable(pipeline);
  const zIndex = Number(layer.z_index || 0);
  const warnings = aiLayerWarnings(layer, asset);
  const warningText = warnings.map((code) => PATTERN_WARNING_LABELS[code] || code).join("；");
  const card = element("article", "ai-layer-card" + (selected ? " is-selected" : ""));

  const visual = element("div", "ai-layer-visual");
  const image = element("img");
  image.alt = "候选图层 " + zIndex;
  loadThumb(image, asset);
  visual.append(image);
  visual.append(element("span", "ai-layer-badge", "AI 候选"));
  visual.append(element("span", "ai-layer-index", "层级 " + zIndex));

  const selectLabel = element("label", "ai-layer-select");
  const checkbox = element("input");
  checkbox.type = "checkbox";
  checkbox.checked = selected;
  checkbox.disabled = !selectable;
  checkbox.dataset.aiLayerId = layerId;
  checkbox.setAttribute("aria-label", "选择候选图层 " + zIndex);
  const check = element("span", "ai-layer-check");
  check.append(icon("check"));
  selectLabel.append(checkbox, check);
  visual.append(selectLabel);
  visual.addEventListener("click", (event) => {
    if (!selectable || event.target.closest(".ai-layer-select")) return;
    checkbox.click();
  });
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.ai.selectedLayerIds.add(layerId);
    else state.ai.selectedLayerIds.delete(layerId);
    card.classList.toggle("is-selected", checkbox.checked);
    updateAiSelectionActions();
    if (state.ai.filter === "selected" && !checkbox.checked) renderAiCandidates();
  });
  card.append(visual);

  const copy = element("div", "ai-layer-copy");
  copy.append(element("strong", "ai-layer-title", "候选图层 " + zIndex));
  const meta = [];
  if (assetWidth(asset) && assetHeight(asset)) meta.push(formatDimensions(assetWidth(asset), assetHeight(asset)));
  copy.append(element("small", "", meta.length ? meta.join(" · ") : "尺寸待读取"));

  const badges = element("div", "ai-layer-badges");
  if (!assetGeometryVerified(asset)) {
    badges.append(element("span", "ai-layer-tag is-muted", "几何未核验"));
  }
  if (warnings.length) {
    const warning = element("span", "ai-layer-tag is-warn", "候选存疑");
    warning.title = warningText;
    badges.append(warning);
  }
  if (badges.childNodes.length) copy.append(badges);
  if (warnings.length) copy.append(element("p", "ai-layer-warning", warningText));

  const actions = element("div", "ai-layer-actions");
  const view = element("button", "icon-button");
  view.type = "button";
  view.title = "查看候选图层";
  view.setAttribute("aria-label", "查看候选图层 " + zIndex);
  view.append(icon("eye"));
  view.addEventListener("click", () => openAssetPreview(asset, "AI 候选层"));
  actions.append(view);
  const download = element("button", "icon-button");
  download.type = "button";
  download.title = "下载候选图层";
  download.setAttribute("aria-label", "下载候选图层 " + zIndex);
  download.append(icon("download"));
  download.addEventListener("click", () => void downloadAsset(asset, download));
  actions.append(download);
  copy.append(actions);
  card.append(copy);
  return card;
}

function loadThumb(image, asset) {
  if (!image || !asset) return;
  image.removeAttribute("src");
  getPreviewUrl(asset.asset_id).then((url) => {
    if (!image.isConnected) return;
    image.src = url;
  }).catch(() => {
    if (!image.isConnected) return;
    image.alt = "预览不可用";
  });
}

function updateAiSelectionActions() {
  const pipeline = state.ai.pipeline;
  const selectable = aiLayerSelectionAvailable(pipeline);
  const layers = aiCandidateLayers();
  const count = state.ai.selectedLayerIds.size;
  setText(dom.aiSelectionNote, selectable
    ? aiSelectionSummaryText(layers)
    : "当前候选不可选择");
  updateAiFilterCounts(layers);
  setButtonLabel(dom.aiCompose, count ? "合成所选图层（" + count + "）" : "合成所选图层");
  renderAiRerun();
  updateActionState();
}

function renderAssetActionList(container, rawAssets) {
  container.replaceChildren();
  const ids = [];
  for (const raw of rawAssets) {
    const id = assetIdOf(raw);
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length) {
    container.append(element("p", "hint", "没有可展示的成果。"));
    return;
  }
  for (const id of ids) {
    const asset = state.assets.get(id) || null;
    const row = element("div", "task-result-item");
    const copy = element("div", "task-result-copy");
    copy.append(element("strong", "", asset ? assetDisplayName(asset) : "成果 #" + shortId(id)));
    copy.append(element("small", "", assetIsAi(asset) ? "AI 候选 · 几何未核验" : "可预览或下载"));
    row.append(copy);
    if (asset && assetIsPreviewable(asset)) {
      const view = element("button", "icon-button");
      view.type = "button";
      view.title = "预览成果";
      view.setAttribute("aria-label", "预览" + assetDisplayName(asset));
      view.append(icon("image"));
      view.addEventListener("click", () => openAssetPreview(asset, "流程成果"));
      row.append(view);
    }
    const download = element("button", "icon-button");
    download.type = "button";
    download.title = "下载成果";
    download.setAttribute("aria-label", "下载" + (asset ? assetDisplayName(asset) : "成果"));
    download.append(icon("download"));
    download.addEventListener("click", () => {
      if (asset) void downloadAsset(asset, download);
    });
    row.append(download);
    container.append(row);
  }
}

function scheduleAiPoll(delay) {
  if (state.ai.pollTimer) window.clearTimeout(state.ai.pollTimer);
  const pipeline = state.ai.pipeline;
  if (!pipeline) return;
  const id = aiPipelineId(pipeline);
  state.ai.pollTimer = window.setTimeout(() => {
    state.ai.pollTimer = null;
    void pollAiPipeline(id);
  }, Math.max(500, delay || 1600));
}

async function pollAiPipeline(id) {
  if (!state.ai.pipeline || aiPipelineId(state.ai.pipeline) !== id) return;
  try {
    const result = await requestJson("/pipelines/" + encodeURIComponent(id));
    if (!state.ai.pipeline || aiPipelineId(state.ai.pipeline) !== id) return;
    const next = normalizeAiPipeline(result.data && result.data.pipeline ? result.data.pipeline : result.data);
    if (!next) throw new ApiError("AI 流程状态无法识别。", { status: result.status });
    state.ai.pipeline = next;
    state.ai.pollFailures = 0;
    state.ai.pollError = "";
    void ensureRecoveryAssets(next);
    renderAiPanel();
    updateActionState();
    if (isAiActive(next)) {
      scheduleAiPoll(2000);
    } else if (isAiWaiting(next)) {
      await loadAiLayers(false);
    } else if (["succeeded", "failed"].includes(String(next.state || "").toLowerCase())) {
      if (next.decomposition_job_id && !state.ai.layers &&
          (!next.recovery || next.recovery.can_compose !== false)) {
        await loadAiLayers(false);
      }
      syncAiSelectedLayers(next);
      await processAiResult(next);
    }
  } catch (error) {
    state.ai.pollFailures += 1;
    state.ai.pollError = "状态查询暂时失败，页面只会重试查询，不会重新提交。";
    renderAiPanel();
    updateActionState();
    if (state.ai.pollFailures <= POLL_MAX_FAILURES) {
      scheduleAiPoll(Math.min(3000 * state.ai.pollFailures, 12000));
    } else {
      showToast("AI 状态查询暂时中断，可点击“重新查询”继续。", "warning", 6000);
    }
  }
}

async function adoptAiPipeline(raw, options) {
  const opts = options || {};
  const pipeline = normalizeAiPipeline(raw);
  if (!pipeline) throw new ApiError("AI 流程响应缺少编号。", { status: 202 });
  if (state.ai.pollTimer) {
    window.clearTimeout(state.ai.pollTimer);
    state.ai.pollTimer = null;
  }
  const previousId = aiPipelineId(state.ai.pipeline);
  const nextId = aiPipelineId(pipeline);
  if (previousId && previousId !== nextId) {
    state.ai.layers = null;
    state.ai.layerKey = "";
    state.ai.selectedLayerIds.clear();
  }
  state.ai.pipeline = pipeline;
  state.ai.pollFailures = 0;
  state.ai.pollError = "";
  state.ai.error = "";
  void ensureRecoveryAssets(pipeline);
  renderAiPanel();
  updateActionState();

  if (isAiActive(pipeline)) {
    scheduleAiPoll(1000);
  } else if (isAiWaiting(pipeline)) {
    await loadAiLayers(false);
  } else if (["succeeded", "failed"].includes(String(pipeline.state || "").toLowerCase())) {
    if (pipeline.decomposition_job_id && !state.ai.layers &&
        (!pipeline.recovery || pipeline.recovery.can_compose !== false)) {
      await loadAiLayers(false);
    }
    syncAiSelectedLayers(pipeline);
    await processAiResult(pipeline);
  }
  if (opts.announce) {
    showToast(isAiWaiting(pipeline) ? "AI 候选已就绪，请选择要保留的图层。" : "AI 流程状态已更新。", "info", 4500);
  }
}

async function loadAiLayers(force) {
  const pipeline = state.ai.pipeline;
  if (!pipeline || !pipeline.decomposition_job_id) return;
  const decompositionId = String(pipeline.decomposition_job_id);
  const targetPipelineId = aiPipelineId(pipeline);
  const key = targetPipelineId + ":" + decompositionId;
  if (!force && state.ai.layerKey === key && state.ai.layers) return;
  if (state.ai.layersLoading) return;

  state.ai.layersLoading = true;
  renderAiPanel();
  try {
    const result = await requestJson("/jobs/" + encodeURIComponent(decompositionId) + "/layers");
    if (!state.ai.pipeline || aiPipelineId(state.ai.pipeline) !== targetPipelineId ||
        String(state.ai.pipeline.decomposition_job_id || "") !== decompositionId) {
      return;
    }
    const data = result.data && typeof result.data === "object" ? result.data : null;
    if (!data || !Array.isArray(data.layers)) {
      throw new ApiError("候选图层响应不完整。", { status: result.status });
    }
    const raws = [];
    if (data.basemap) raws.push(data.basemap);
    for (const layer of data.layers) {
      if (layer.asset) raws.push(layer.asset);
      if (layer.placed_asset) raws.push(layer.placed_asset);
    }
    await registerAssets(raws, {
      context: {
        origin: "ai_pipeline",
        aiCandidate: true,
        aiPipelineId: aiPipelineId(pipeline),
        jobKind: "decompose"
      },
      prepend: true
    });
    const basemapId = data.basemap ? assetIdOf(data.basemap) : "";
    const unplacedIds = new Set();
    for (const layer of data.layers) {
      if (layer.asset && layer.placed_asset && assetIdOf(layer.asset) !== assetIdOf(layer.placed_asset)) {
        unplacedIds.add(assetIdOf(layer.asset));
      }
      const placedId = layer.placed_asset ? assetIdOf(layer.placed_asset) : "";
      const placed = placedId ? state.assets.get(placedId) : null;
      if (placed) {
        placed._context = Object.assign({}, placed._context, {
          aiCandidate: true,
          aiLayer: true,
          aiPipelineId: aiPipelineId(pipeline),
          jobKind: "decompose"
        });
      }
    }
    if (basemapId) {
      const basemap = state.assets.get(basemapId);
      if (basemap) {
        basemap._context = Object.assign({}, basemap._context, {
          aiCandidate: true,
          aiReferenceOnly: true,
          role: "basemap",
          aiPipelineId: aiPipelineId(pipeline),
          jobKind: "decompose"
        });
      }
    }
    state.versionIds = state.versionIds.filter((id) => id !== basemapId && !unplacedIds.has(id));
    state.ai.layers = data;
    state.ai.layerKey = key;
    state.ai.selectedLayerIds.clear();
    renderVersions();
    renderAiPanel();
    updateActionState();
  } catch (error) {
    state.ai.error = "无法读取候选图层：" + friendlyError(error);
    showToast(state.ai.error, "error", 6500);
  } finally {
    state.ai.layersLoading = false;
    renderAiPanel();
    updateActionState();
  }
}

function syncAiSelectedLayers(pipeline) {
  if (!pipeline || !Array.isArray(pipeline.selected_layer_ids)) return;
  state.ai.selectedLayerIds = new Set(pipeline.selected_layer_ids.map((id) => String(id)));
  renderAiCandidates();
  renderAiRerun();
  updateActionState();
}

async function processAiResult(pipeline) {
  const id = aiPipelineId(pipeline);
  const result = pipeline.result && typeof pipeline.result === "object" ? pipeline.result : {};
  const raws = Array.isArray(result.assets) ? result.assets : [];
  const processingKey = id + ":" + String(pipeline.updated_at || "") + ":" + String(pipeline.revision || "");
  if (!raws.length || state.ai.processingKey === processingKey) return;
  const localFallback = pipeline.decision && pipeline.decision.action === "use_local";
  const assets = await registerAssets(raws, {
    context: {
      origin: "ai_pipeline",
      aiCandidate: !localFallback,
      aiPipelineId: id,
      jobKind: "pipeline",
      jobParameters: { vector: pipeline.vector || null }
    },
    prepend: true
  });
  state.ai.processingKey = processingKey;
  const preferred = localFallback
    ? (findSvgAsset(assets, { parameters: pipeline.vector || {} }) ||
      findTransparentAsset(assets) ||
      assets.find((asset) => assetIsInputCapable(asset)) || null)
    : (assets.find((asset) => normalizeKind(asset.kind) === "composed_candidate") ||
      findSvgAsset(assets, { parameters: pipeline.vector || {} }) ||
      assets.find((asset) => assetIsInputCapable(asset)) || null);
  if (preferred && assetIsPreviewable(preferred)) {
    state.previewId = preferred.asset_id;
    renderAll();
    await loadPreview();
  } else {
    renderAll();
  }
  const failed = pipeline.state === "failed";
  showToast(failed ? "流程未完成，已完成步骤的成果保留在版本区。" : localFallback
    ? "本地回退完成，结果已加入版本区。"
    : "AI 候选合成完成，结果已加入版本区。", failed ? "warning" : "success", 5500);
}

function resetAiState() {
  if (state.ai.pollTimer) window.clearTimeout(state.ai.pollTimer);
  state.ai.pipeline = null;
  state.ai.layers = null;
  state.ai.layerKey = "";
  state.ai.selectedLayerIds.clear();
  state.ai.filter = "all";
  state.ai.layersLoading = false;
  state.ai.pollTimer = null;
  state.ai.pollFailures = 0;
  state.ai.pollError = "";
  state.ai.error = "";
  state.ai.processingKey = "";
  state.ai.branchJobs.clear();
  state.ai.rerunAssetId = "";
  state.ai.traceError = "";
  dom.aiRerunInput.replaceChildren();
  dom.aiRerunInput.dataset.signature = "";
  setError(dom.aiRerunError, "");
}

async function startAiPipeline() {
  const reason = aiStartBlockReason();
  if (reason) {
    setAiError(reason);
    return;
  }
  const asset = currentAsset();
  const vector = readVectorParams();
  if (!asset || !vector.ok) {
    setAiError(vector.ok ? "请先选择当前输入。" : vector.error);
    return;
  }
  const callId = dom.aiCallId.value.trim();
  if (!callId && (!dom.aiConsentUpload.checked || !dom.aiConsentCharge.checked)) {
    setAiError("新生成需要分别确认上传与可能产生的费用。");
    return;
  }
  setAiError("");
  const payload = {
    input_asset_id: asset.asset_id,
    provider_call_id: callId || null,
    consent_to_upload: callId ? false : Boolean(dom.aiConsentUpload.checked),
    consent_to_charge: callId ? false : Boolean(dom.aiConsentCharge.checked),
    size: "1K",
    vector: vectorPayloadFrom(vector)
  };
  const bodyText = JSON.stringify(payload);
  const label = callId ? "读取归档候选" : "发起 AI 拆层";
  startSubmission({
    path: "/pipelines/ai",
    method: "POST",
    label: label,
    bodyFactory: () => bodyText,
    onSuccess: async (data) => {
      const pipeline = normalizeAiPipeline(data && data.pipeline ? data.pipeline : data);
      if (!pipeline) throw new ApiError("AI 流程响应缺少编号。", { status: 202 });
      state.ai.layers = null;
      state.ai.layerKey = "";
      state.ai.selectedLayerIds.clear();
      dom.aiConsentUpload.checked = false;
      dom.aiConsentCharge.checked = false;
      await adoptAiPipeline(pipeline, { announce: true });
      showToast(callId ? "已读取归档候选。" : "AI 拆层已开始，等待候选生成。", "success", 5000);
    },
    onError: (error) => {
      setAiError(error.status === 409 ? "当前候选状态已变化，请刷新后再试。" : friendlyError(error));
      showToast("AI 请求未创建：" + friendlyError(error), "error", 6500);
    },
    onUnknown: () => {
      setAiError("AI 请求结果未知。请用页面顶部的相同请求重试；页面不会自动重发。");
    }
  });
}

async function refreshAiPipelineNow(forceLayers) {
  const pipeline = state.ai.pipeline;
  if (!pipeline) return;
  const id = aiPipelineId(pipeline);
  try {
    const result = await requestJson("/pipelines/" + encodeURIComponent(id));
    if (!state.ai.pipeline || aiPipelineId(state.ai.pipeline) !== id) return;
    const next = normalizeAiPipeline(result.data && result.data.pipeline ? result.data.pipeline : result.data);
    if (!next) throw new ApiError("AI 流程状态无法识别。", { status: result.status });
    state.ai.pipeline = next;
    state.ai.pollFailures = 0;
    state.ai.pollError = "";
    void ensureRecoveryAssets(next);
    renderAiPanel();
    updateActionState();
    if (isAiActive(next)) {
      scheduleAiPoll(1000);
    } else if (isAiWaiting(next)) {
      await loadAiLayers(Boolean(forceLayers));
    } else if (["succeeded", "failed"].includes(String(next.state || "").toLowerCase())) {
      if (next.decomposition_job_id && !state.ai.layers &&
          (!next.recovery || next.recovery.can_compose !== false)) {
        await loadAiLayers(Boolean(forceLayers));
      }
      syncAiSelectedLayers(next);
      await processAiResult(next);
    }
    return true;
  } catch (error) {
    state.ai.error = "无法刷新候选状态：" + friendlyError(error);
    state.ai.pollError = "读取候选状态失败，可手动重试。";
    renderAiPanel();
    showToast(state.ai.error, "error");
    return false;
  }
}

async function continueAi(action) {
  const pipeline = state.ai.pipeline;
  if (!pipeline) return;
  if (state.requestInFlight || state.pendingSubmission || state.duplicateSwitching) return;
  const stateName = String(pipeline.state || "").toLowerCase();
  if (action === "select_layers" && stateName !== "waiting_user") return;
  if (action === "use_local" && !["waiting_user", "failed"].includes(stateName)) return;
  if (action === "reject" && stateName !== "waiting_user") return;
  const selected = state.ai.selectedLayerIds.size
    ? Array.from(state.ai.selectedLayerIds)
    : [];
  if (action === "select_layers" && !selected.length) {
    setAiError("请至少选择一个候选图层；底图不能作为图层。");
    return;
  }
  const vector = readVectorParams();
  if (!vector.ok) {
    setAiError(vector.error);
    return;
  }
  let extractPayload = { mode: "otsu" };
  if (action === "use_local") {
    const localExtract = readExtractParams(false);
    if (!localExtract.ok) {
      setAiError(localExtract.error);
      return;
    }
    const sameInput = state.currentInputId && state.currentInputId === String(pipeline.input_asset_id);
    if (localExtract.mode === "grabcut" && !sameInput) {
      setAiError("本地回退使用 GrabCut 时需要当前输入上的有效框选；请回到对应输入框选或换一种提取方式。");
      return;
    }
    extractPayload = Object.assign({}, localExtract.payload);
    if (!sameInput) delete extractPayload.bbox;
  }

  const copy = action === "select_layers"
    ? {
        title: "合成所选图层？",
        message: "将按候选前后关系合成 " + selected.length + " 个图层。底图只作参考，不会进入成果。",
        confirmLabel: "确认合成",
        tone: "primary"
      }
    : action === "use_local"
      ? {
          title: "改用本地流程？",
          message: "候选不会被合并，当前输入将按本地提取与矢量参数继续处理。",
          confirmLabel: "使用本地流程",
          tone: "primary"
        }
      : {
          title: "拒绝这些候选？",
          message: "拒绝后不会创建成果，也不会发起新的生成或费用。你仍可继续使用本地处理。",
          confirmLabel: "拒绝候选",
          tone: "danger"
        };
  if (!(await confirmAction(copy))) return;

  const revision = Number(pipeline.revision);
  if (!Number.isInteger(revision)) {
    setAiError("当前候选状态不完整，请重新读取。");
    return;
  }
  const payload = {
    revision: revision,
    action: action,
    layer_ids: action === "select_layers" ? selected : [],
    extract: extractPayload,
    vector: vectorPayloadFrom(vector)
  };
  const bodyText = JSON.stringify(payload);
  const labels = {
    select_layers: "合成所选图层",
    use_local: "改用本地流程",
    reject: "拒绝候选"
  };
  setAiError("");
  startSubmission({
    path: "/pipelines/" + encodeURIComponent(aiPipelineId(pipeline)) + "/continue",
    method: "POST",
    label: labels[action],
    bodyFactory: () => bodyText,
    onSuccess: async (data) => {
      const next = normalizeAiPipeline(data && data.pipeline ? data.pipeline : data);
      if (!next) throw new ApiError("确认响应缺少 AI 流程状态。", { status: 200 });
      await adoptAiPipeline(next, { announce: true });
    },
    onError: async (error) => {
      if (error.status === 409) {
        state.ai.selectedLayerIds.clear();
        const refreshed = await refreshAiPipelineNow(true);
        setAiError(refreshed
          ? "候选的确认状态已在别处更新。已重新读取；本次没有重复提交，请确认后重新决定。"
          : "候选的确认状态已在别处更新，但重新读取失败。请点击“重新查询”，不要重复提交本次决定。");
        showToast(refreshed ? "候选状态已更新，请重新查看后再决定。" : "候选状态已更新，但读取失败，请重新查询。",
          "warning", 6500);
      } else {
        setAiError("决定未提交：" + friendlyError(error));
        showToast("决定未提交：" + friendlyError(error), "error", 6500);
      }
    },
    onUnknown: () => {
      setAiError("决定提交结果未知。请用页面顶部的相同请求重试；页面不会自动重发。");
    }
  });
}

function isRepairJobKind(kind) {
  const value = normalizeKind(kind);
  return value === "repair" || value === "repair_job";
}

function isTileJobKind(kind) {
  const value = normalizeKind(kind);
  return value === "tile_preview" || value === "tile" || value === "tile_preview_job";
}

function resetRepairState() {
  state.repair.record = null;
  state.repair.jobId = null;
  state.repair.loading = false;
  state.repair.error = "";
  state.repair.loadSeq += 1;
  state.repair.selectedAssetId = "";
  state.repair.acceptFull = false;
  state.repair.decisionBusy = false;
  state.repair.compareView = "three";
  state.repair.compareSeq += 1;
  state.repair.damageSignature = "";
  state.repair.damageIds = [];
  state.repair.damageId = "";
  dom.repairFeather.value = "0";
  dom.repairSize.value = "1K";
  dom.repairCallId.value = "";
  dom.repairDamageMask.value = "";
  dom.repairConsentUpload.checked = false;
  dom.repairConsentCharge.checked = false;
  dom.repairAcceptFull.checked = false;
  setRadio("repair-intent", "restore_small_gap");
  setError(dom.repairError, "");
  setText(dom.repairStartNote, "先选择规范输入并框选缺损区域。");
  if (dom.repairCompareDialog.open) dom.repairCompareDialog.close();
  dom.repairCompareBody.replaceChildren();
}

function resetTileState() {
  state.tile.unitId = "";
  state.tile.unitSignature = "";
  state.tile.rows = 2;
  state.tile.cols = 2;
  state.tile.seamObservation = "not_reviewed";
  state.tile.jobId = null;
  state.tile.job = null;
  state.tile.resultAssetId = "";
  state.tile.loading = false;
  state.tile.error = "";
  state.tile.pendingCrop = false;
  state.tile.pendingCropJobId = null;
  dom.tileSeam.value = "not_reviewed";
  setRadio("tile-preset", "2");
  setError(dom.tileError, "");
  dom.tileResultImage.removeAttribute("src");
}

function normalizeRepairRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw.repair && typeof raw.repair === "object"
    ? raw.repair
    : raw.record && typeof raw.record === "object" ? raw.record : raw;
  const id = String(candidate.repair_job_id || candidate.job_id || "");
  if (!id) return null;
  return Object.assign({}, candidate, { repair_job_id: id });
}

function repairAssetId(record, field) {
  return assetIdOf(record && record[field]);
}

function repairAsset(record, field) {
  const id = repairAssetId(record, field);
  return id ? state.assets.get(id) || null : null;
}

function repairWarningTexts(record) {
  const warnings = record && Array.isArray(record.warnings) ? record.warnings : [];
  const texts = [];
  for (const warning of warnings) {
    const code = typeof warning === "string"
      ? warning
      : String((warning && (warning.code || warning.warning)) || "");
    const message = warning && typeof warning === "object" && warning.message
      ? String(warning.message)
      : REPAIR_WARNING_LABELS[code] || code || "修复记录返回了未命名警告。";
    if (!texts.includes(message)) texts.push(message);
  }
  if (!repairAssetId(record, "composited_asset") && repairAssetId(record, "candidate_asset") &&
      !texts.some((text) => text.includes("局部保护版"))) {
    texts.push("未生成局部保护版。只保留全图候选预览；请人工检查尺寸与坐标，系统没有强制缩放。");
  }
  return texts;
}

function markRepairContext(asset, role, extra) {
  if (!asset) return;
  asset._context = Object.assign({}, asset._context, {
    origin: "repair",
    repairJobId: state.repair.jobId || "",
    repairRole: role
  }, extra || {});
}

async function registerRepairAssets(record) {
  const raws = [];
  const ids = [];
  function add(value) {
    const id = assetIdOf(value);
    if (id && !ids.includes(id)) {
      ids.push(id);
      raws.push(value);
    }
  }
  add(record.input_asset_id);
  add(record.candidate_asset);
  add(record.composited_asset);
  add(record.edit_mask);
  add(record.blend_weight);
  add(record.difference_map);
  add(record.damage_mask_asset_id);
  const acceptedId = record.decision && record.decision.accepted_asset_id
    ? String(record.decision.accepted_asset_id) : "";
  add(acceptedId);
  const assets = raws.length
    ? await registerAssets(raws, {
        context: { origin: "repair", jobKind: "repair", repairJobId: record.repair_job_id, aiCandidate: false },
        prepend: true
      })
    : [];
  markRepairContext(state.assets.get(repairAssetId(record, "candidate_asset")), "full", {
    aiCandidate: true,
    geometryVerified: false
  });
  markRepairContext(state.assets.get(repairAssetId(record, "composited_asset")), "local", {
    aiCandidate: true,
    geometryVerified: false
  });
  markRepairContext(state.assets.get(repairAssetId(record, "edit_mask")), "editMask");
  markRepairContext(state.assets.get(repairAssetId(record, "blend_weight")), "blendWeight");
  markRepairContext(state.assets.get(repairAssetId(record, "difference_map")), "difference", {
    visualizationOnly: true
  });
  markRepairContext(state.assets.get(String(record.damage_mask_asset_id || "")), "damageMask");
  if (acceptedId) {
    markRepairContext(state.assets.get(acceptedId), "accepted", {
      aiCandidate: true,
      acceptedRepair: true,
      geometryVerified: false
    });
  }
  return assets;
}

function applyRepairRecord(record, options) {
  const opts = options || {};
  const repairState = String(record.state || "").toLowerCase();
  const fullId = repairAssetId(record, "candidate_asset");
  const localId = repairAssetId(record, "composited_asset");
  const acceptedId = record.decision && record.decision.accepted_asset_id
    ? String(record.decision.accepted_asset_id) : "";
  const pending = repairState === "waiting_user";
  let selected = state.repair.selectedAssetId;
  const allowed = [fullId, localId].filter(Boolean);
  if (!opts.preserveSelection || !pending || !allowed.includes(selected)) {
    selected = pending ? (localId || "") : (acceptedId || selected || "");
  }
  state.repair.selectedAssetId = selected;
  if (!pending || selected !== fullId) {
    state.repair.acceptFull = false;
    dom.repairAcceptFull.checked = false;
  }
  renderVersions();
  renderRepairPanel();
  updateActionState();
}

async function loadRepairRecord(jobId, options) {
  const opts = options || {};
  const id = String(jobId || state.repair.jobId || "");
  if (!id) return null;
  const seq = ++state.repair.loadSeq;
  state.repair.loading = true;
  state.repair.error = "";
  state.repair.jobId = id;
  renderRepairPanel();
  updateActionState();
  try {
    const result = await requestJson("/repairs/" + encodeURIComponent(id));
    if (seq !== state.repair.loadSeq) return null;
    const record = normalizeRepairRecord(result.data);
    if (!record) throw new ApiError("修复记录响应不完整。", { status: result.status });
    state.repair.jobId = record.repair_job_id;
    await registerRepairAssets(record);
    if (seq !== state.repair.loadSeq) return null;
    state.repair.record = record;
    state.repair.error = "";
    applyRepairRecord(record, { preserveSelection: Boolean(opts.preserveSelection) });
    if (String(record.state || "").toLowerCase() === "accepted" && opts.switchAccepted !== false) {
      await switchToAcceptedRepair(record, { announce: Boolean(opts.announce) });
    }
    if (opts.announce && String(record.state || "").toLowerCase() === "rejected") {
      showToast("已恢复拒绝记录；原输入没有改变。", "info", 4500);
    }
    return record;
  } catch (error) {
    if (seq !== state.repair.loadSeq) return null;
    state.repair.error = "无法读取修复记录：" + friendlyError(error);
    showToast(state.repair.error, "error", 6500);
    return null;
  } finally {
    if (seq === state.repair.loadSeq) {
      state.repair.loading = false;
      renderRepairPanel();
      updateActionState();
    }
  }
}

async function switchToAcceptedRepair(record, options) {
  const opts = options || {};
  if (state.duplicateSwitching) {
    showToast("正在切换已有版本，完成后再切换修复分支。", "warning");
    return false;
  }
  const acceptedId = record && record.decision && record.decision.accepted_asset_id
    ? String(record.decision.accepted_asset_id) : "";
  if (!acceptedId) return false;
  let asset = state.assets.get(acceptedId);
  if (!asset) {
    try {
      await registerRepairAssets(record);
      asset = state.assets.get(acceptedId);
    } catch (error) {
      showToast("已接受资产暂时无法读取：" + friendlyError(error), "warning", 6000);
      return false;
    }
  }
  if (!asset || !assetIsInputCapable(asset)) {
    showToast("已接受修复资产未就绪，无法切换输入。", "warning", 6000);
    return false;
  }
  const changed = state.currentInputId !== acceptedId;
  state.currentInputId = acceptedId;
  state.previewId = acceptedId;
  state.sourceNote = asset.source_note || "";
  const originalWidth = Number(asset.original_width || asset.source_width || 0);
  const originalHeight = Number(asset.original_height || asset.source_height || 0);
  state.sourceOriginal = originalWidth > 0 && originalHeight > 0
    ? { width: originalWidth, height: originalHeight, assetId: acceptedId }
    : null;
  state.sourceLabel = "已接受修复 " + shortId(acceptedId);
  clearBBox();
  renderAll();
  await loadPreview();
  if (changed && opts.announce !== false) {
    showToast("已接受修复并切换到新分支；可继续使用现有提取、SVG 与 ZIP。", "success", 5500);
  }
  return true;
}

function readRepairParams(showError) {
  const intent = checkedValue("repair-intent");
  if (!Object.prototype.hasOwnProperty.call(REPAIR_INTENTS, intent)) {
    if (showError) setError(dom.repairError, "请选择有效的修复意图。");
    return { ok: false, error: "请选择有效的修复意图。" };
  }
  const feather = integerValue(dom.repairFeather);
  if (feather === null || feather < 0 || feather > 64) {
    const message = "羽化必须是 0–64 之间的整数原图像素。";
    if (showError) setError(dom.repairError, message);
    return { ok: false, error: message };
  }
  const size = dom.repairSize.value;
  if (!["1K", "1.5K", "2K"].includes(size)) {
    const message = "请选择 1K、1.5K 或 2K 输出尺寸。";
    if (showError) setError(dom.repairError, message);
    return { ok: false, error: message };
  }
  const asset = currentAsset();
  const bbox = state.bbox && validBboxForAsset(state.bbox, asset) ? Object.assign({}, state.bbox) : null;
  if (!bbox) {
    const message = "请先在当前输入上框选有效的真实像素矩形。";
    if (showError) setError(dom.repairError, message);
    return { ok: false, error: message };
  }
  const damageId = dom.repairDamageMask.value.trim();
  if (damageId && !state.repair.damageIds.includes(damageId)) {
    const message = "所选损伤标注与当前输入不匹配，请重新选择。";
    if (showError) setError(dom.repairError, message);
    return { ok: false, error: message };
  }
  return {
    ok: true,
    intent: intent,
    feather_px: feather,
    size: size,
    bbox: bbox,
    damage_mask_asset_id: damageId || null,
    provider_call_id: dom.repairCallId.value.trim() || null
  };
}

function repairInputBlockReason() {
  const asset = currentAsset();
  if (!asset) return "请先上传并选择当前输入。";
  if (!isPreviewCurrent()) return "画布正在预览其他版本，请先回到当前输入。";
  if (normalizeKind(asset.kind) !== "normalized_input") {
    return "局部修复要求规范输入版本；请在版本区将规范输入设为当前输入。";
  }
  if (assetPixels(asset) > REPAIR_PIXEL_LIMIT) {
    return "修复输入最多 1,048,576 像素，且只接受规范输入；请换用不超过上限的图片，工作副本不作为修复输入。";
  }
  return "";
}

function repairStartBlockReason() {
  if (state.requestInFlight) return "正在提交，请稍候。";
  if (state.duplicateSwitching) return "正在切换已有版本，请稍候。";
  if (state.pendingSubmission) return "请先处理结果未知的上一次提交。";
  if (state.taskRunning) return "已有任务处理中，完成后再发起修复。";
  if (state.repair.loading) return "正在读取修复记录…";
  const record = state.repair.record;
  const recordState = String((record && record.state) || "").toLowerCase();
  if (record && ["queued", "running", "waiting_user"].includes(recordState)) {
    return recordState === "waiting_user"
      ? "当前修复等待接受或拒绝，完成后再发起新的修复。"
      : "当前修复仍在处理中。";
  }
  const inputReason = repairInputBlockReason();
  if (inputReason) return inputReason;
  const params = readRepairParams(false);
  if (!params.ok) return params.error;
  const reuse = Boolean(params.provider_call_id);
  if (reuse) return "";
  if (state.ai.statusLoading) return "正在读取 AI 能力状态…";
  if (state.ai.statusError) return "AI 状态不可用；可填写已归档编辑调用只读复用，或继续本地处理。";
  if (!aiNewGenerationAvailable()) return "AI 新生成暂不可用；填写已归档编辑调用仍可复用。";
  if (!dom.repairConsentUpload.checked || !dom.repairConsentCharge.checked) {
    return "新修复需要分别确认上传与可能产生的费用。";
  }
  return "";
}

function renderRepairStart() {
  const reuse = Boolean(dom.repairCallId.value.trim());
  dom.repairConsentUpload.disabled = reuse;
  dom.repairConsentCharge.disabled = reuse;
  dom.repairConsents.classList.toggle("is-disabled", reuse);
  setButtonLabel(dom.repairStart, reuse ? "复用归档编辑" : "提交修复任务");
  const reason = repairStartBlockReason();
  setDisabled(dom.repairStart, Boolean(reason));
  if (reason) {
    setText(dom.repairStartNote, reason);
  } else if (reuse) {
    setText(dom.repairStartNote,
      aiNewGenerationAvailable()
        ? "只读取已归档的同输入、同矩形、同意图、同尺寸编辑调用；不上传、不产生新费用。"
        : "AI 新生成当前不可用，但已归档编辑复用仍可用；不上传、不产生新费用。");
  } else {
    setText(dom.repairStartNote, "将上传当前规范输入并可能产生费用；页面不会自动重发收费请求。");
  }
}

function availableDamageMasks() {
  const asset = currentAsset();
  if (!asset) return [];
  const sourceId = asset.asset_id;
  const width = assetWidth(asset);
  const height = assetHeight(asset);
  const space = asset.coordinate_space_id || asset.coordinate_space;
  const result = [];
  for (const id of state.versionIds) {
    const candidate = state.assets.get(id);
    if (!candidate || normalizeKind(candidate.kind) !== "damage_mask") continue;
    if (String(candidate.source_asset_id || "") !== sourceId) continue;
    if (assetWidth(candidate) !== width || assetHeight(candidate) !== height) continue;
    const candidateSpace = candidate.coordinate_space_id || candidate.coordinate_space;
    if (space && candidateSpace && String(space) !== String(candidateSpace)) continue;
    if (!["synthetic", "annotated"].includes(String(candidate.damage_source || ""))) continue;
    result.push(candidate);
  }
  return result;
}

function renderRepairDamageOptions() {
  const asset = currentAsset();
  const masks = availableDamageMasks();
  const signature = [
    asset ? asset.asset_id : "",
    masks.map((item) => item.asset_id + ":" + String(item.damage_source || "")).join(",")
  ].join("|");
  state.repair.damageIds = masks.map((item) => item.asset_id);
  if (state.repair.damageSignature !== signature) {
    state.repair.damageSignature = signature;
    const current = state.repair.damageId || dom.repairDamageMask.value;
    dom.repairDamageMask.replaceChildren();
    const empty = element("option", "", "不提供损伤标注");
    empty.value = "";
    dom.repairDamageMask.append(empty);
    for (const mask of masks) {
      const source = mask.damage_source === "annotated" ? "人工标注" : "合成构造";
      const option = element("option", "",
        source + " · #" + shortId(mask.asset_id) + " · " + formatDimensions(assetWidth(mask), assetHeight(mask)));
      option.value = mask.asset_id;
      dom.repairDamageMask.append(option);
    }
    const validCurrent = masks.some((mask) => mask.asset_id === current) ? current : "";
    dom.repairDamageMask.value = validCurrent;
  }
  const validSelected = state.repair.damageIds.includes(state.repair.damageId) ? state.repair.damageId : "";
  dom.repairDamageMask.value = validSelected;
  setText(dom.repairDamageNote, masks.length
    ? "只列出与当前输入同源、同尺寸、同坐标空间的二值损伤标注；矩形选区不会被当作损伤真值。"
    : "当前输入没有可用的已登记损伤标注；这不是把框选当成损伤真值。");
}

function renderRepairInput() {
  const asset = currentAsset();
  let text = "尚未选择当前输入与框选区域。";
  let tone = "";
  const inputReason = repairInputBlockReason();
  if (!asset) {
    text = "尚未选择当前输入；修复只作用于规范输入。";
  } else if (inputReason) {
    text = inputReason;
    tone = "is-warning";
  } else {
    const bbox = state.bbox && validBboxForAsset(state.bbox, asset) ? state.bbox : null;
    if (!bbox) {
      text = "当前输入 " + formatDimensions(assetWidth(asset), assetHeight(asset)) +
        " · 尚未框选；请拖拽或填写真实像素矩形。";
      tone = "is-warning";
    } else {
      text = "当前输入 #" + shortId(asset.asset_id) + " · " + formatDimensions(assetWidth(asset), assetHeight(asset)) +
        " · 框选 " + formatBbox(bbox) + " · " + formatPixels(bbox.right - bbox.left, bbox.bottom - bbox.top);
      tone = "is-ready";
    }
  }
  dom.repairBboxSummary.classList.remove("is-ready", "is-warning");
  if (tone) dom.repairBboxSummary.classList.add(tone);
  setText(dom.repairBboxText, text);
}

function setRepairError(message) {
  state.repair.error = message || "";
  setError(dom.repairError, state.repair.error);
}

function buildRepairAssetCard(label, asset, note, options) {
  const opts = options || {};
  const card = element("article", "repair-asset" + (opts.selected ? " is-selected" : ""));
  const visual = element("div", "repair-asset-visual");
  if (asset) {
    const image = element("img");
    image.alt = label + "预览";
    visual.append(image);
    loadThumb(image, asset);
  } else {
    visual.append(element("span", "repair-asset-missing", "暂无此版本"));
  }
  if (opts.ai) visual.append(element("span", "repair-asset-badge", "AI 推测"));
  card.append(visual);

  const copy = element("div", "repair-asset-copy");
  copy.append(element("strong", "", label));
  copy.append(element("small", "", note));
  if (asset) {
    const meta = [];
    if (assetWidth(asset) && assetHeight(asset)) meta.push(formatDimensions(assetWidth(asset), assetHeight(asset)));
    meta.push("#" + shortId(asset.asset_id));
    copy.append(element("small", "repair-asset-meta", meta.join(" · ")));
  }

  if (opts.choice && asset) {
    const choice = element("label", "repair-choice");
    const radio = element("input");
    radio.type = "radio";
    radio.name = "repair-candidate";
    radio.value = asset.asset_id;
    radio.checked = Boolean(opts.selected);
    radio.disabled = !opts.choiceEnabled;
    radio.addEventListener("change", () => {
      if (radio.checked) selectRepairCandidate(asset.asset_id);
    });
    choice.append(radio, element("span", "", opts.choiceLabel || "选择此版本"));
    copy.append(choice);
  }

  const actions = element("div", "repair-asset-actions");
  if (asset && assetIsPreviewable(asset)) {
    const view = element("button", "icon-button");
    view.type = "button";
    view.title = "查看" + label;
    view.setAttribute("aria-label", "查看" + label);
    view.append(icon("eye"));
    view.addEventListener("click", () => openAssetPreview(asset, opts.kicker || label));
    actions.append(view);
  }
  if (asset) {
    const download = element("button", "icon-button");
    download.type = "button";
    download.title = "下载" + label;
    download.setAttribute("aria-label", "下载" + label);
    download.append(icon("download"));
    download.addEventListener("click", () => void downloadAsset(asset, download));
    actions.append(download);
  }
  if (actions.childNodes.length) copy.append(actions);
  card.append(copy);
  return card;
}

function renderRepairMetrics(record) {
  const metrics = record && record.metrics && typeof record.metrics === "object" && !Array.isArray(record.metrics)
    ? record.metrics : {};
  const rows = [];
  const fields = [
    ["outside_changed_pixels", "框外变化像素"],
    ["outside_max_error", "框外最大误差"],
    ["feather_px", "羽化"],
    ["damage_source", "损伤来源"],
    ["damage_pixels", "损伤像素"],
    ["damage_pixels_in_edit", "矩形内损伤像素"],
    ["damage_coverage", "损伤覆盖率"]
  ];
  for (const [key, label] of fields) {
    if (metrics[key] === undefined || metrics[key] === null) continue;
    let value = metrics[key];
    if (key === "damage_source") value = value === "annotated" ? "人工标注" : value === "synthetic" ? "合成构造" : value;
    else if (key === "damage_coverage" && Number.isFinite(Number(value))) value = (Number(value) * 100).toFixed(1) + "%";
    rows.push(element("span", "", label + "：" + value));
  }
  dom.repairMetrics.replaceChildren();
  if (!rows.length) {
    setHidden(dom.repairMetrics, true);
    return;
  }
  rows.unshift(element("strong", "", "合成指标"));
  dom.repairMetrics.append(...rows);
  setHidden(dom.repairMetrics, false);
}

function renderRepairRecord() {
  const record = state.repair.record;
  const hasRecord = Boolean(record);
  setHidden(dom.repairEmpty, hasRecord || state.repair.loading);
  setHidden(dom.repairRecord, !hasRecord);
  setHidden(dom.repairRefresh, !hasRecord && !state.repair.jobId);
  setDisabled(dom.repairRefresh, state.repair.loading);
  if (!hasRecord) {
    setText(dom.repairStateBadge, state.repair.loading ? "读取中" : "未开始");
    dom.repairAssets.replaceChildren();
    setHidden(dom.repairWarnings, true);
    setHidden(dom.repairMetrics, true);
    setHidden(dom.repairDecisionResult, true);
    setHidden(dom.repairNext, true);
    setHidden(dom.repairDecision, true);
    setDisabled(dom.repairCompare, true);
    setDisabled(dom.repairEditView, true);
    setDisabled(dom.repairDiffView, true);
    return;
  }

  const stateName = String(record.state || "").toLowerCase();
  const pending = stateName === "waiting_user";
  const fullId = repairAssetId(record, "candidate_asset");
  const localId = repairAssetId(record, "composited_asset");
  const full = state.assets.get(fullId) || null;
  const local = state.assets.get(localId) || null;
  const input = state.assets.get(String(record.input_asset_id || "")) || null;
  const acceptedId = record.decision && record.decision.accepted_asset_id
    ? String(record.decision.accepted_asset_id) : "";
  const accepted = acceptedId ? state.assets.get(acceptedId) || null : null;
  const selectedId = state.repair.selectedAssetId;
  const selectedFull = selectedId && selectedId === fullId;

  setText(dom.repairStateBadge, REPAIR_STATE_LABELS[stateName] || stateLabel(stateName));
  dom.repairStateBadge.className = "tag is-" + (stateName || "queued");
  setText(dom.repairRecordTitle, "修复 #" + shortId(record.repair_job_id));
  const params = record.parameters && typeof record.parameters === "object" ? record.parameters : {};
  const meta = [
    "输入 #" + shortId(record.input_asset_id),
    REPAIR_INTENTS[params.intent] || REPAIR_INTENTS.restore_small_gap,
    "羽化 " + Number(params.feather_px !== undefined ? params.feather_px : 0) + " px",
    "尺寸 " + (params.size || "1K"),
    params.provider_call_id ? "归档复用" : "新生成"
  ];
  if (record.updated_at || record.created_at) meta.push(formatTime(record.updated_at || record.created_at));
  setText(dom.repairRecordMeta, meta.join(" · "));
  dom.repairStatus.className = "status-pill is-" + (stateName || "queued");
  setText(dom.repairStatus, REPAIR_STATE_LABELS[stateName] || stateLabel(stateName));
  setText(dom.repairRevision, "revision " + (record.revision !== undefined ? record.revision : "—"));

  const warnings = repairWarningTexts(record);
  dom.repairWarnings.replaceChildren();
  if (warnings.length) {
    for (const warning of warnings) {
      const item = element("div", "repair-warning");
      item.append(icon("alert"));
      item.append(element("span", "", warning));
      dom.repairWarnings.append(item);
    }
    setHidden(dom.repairWarnings, false);
  } else {
    setHidden(dom.repairWarnings, true);
  }

  dom.repairAssets.replaceChildren();
  dom.repairAssets.append(buildRepairAssetCard(
    "原输入",
    input,
    "修复前输入；只读保留",
    { kicker: "修复原输入" }
  ));
  if (full) {
    dom.repairAssets.append(buildRepairAssetCard(
      "全图候选",
      full,
      "整图候选，可能改变框外像素；不作为默认接受对象",
      {
        ai: true,
        choice: pending,
        choiceEnabled: pending && !state.repair.decisionBusy,
        selected: pending && selectedFull,
        choiceLabel: "选择全图候选（需另行确认）",
        kicker: "修复全图候选"
      }
    ));
  }
  if (local) {
    dom.repairAssets.append(buildRepairAssetCard(
      "局部保护版",
      local,
      "框外使用原输入；默认接受对象",
      {
        ai: true,
        choice: pending,
        choiceEnabled: pending && !state.repair.decisionBusy,
        selected: pending && selectedId === localId,
        choiceLabel: "选择局部保护版（默认）",
        kicker: "修复局部保护版"
      }
    ));
  }
  if (accepted) {
    dom.repairAssets.append(buildRepairAssetCard(
      "已接受修复",
      accepted,
      "后续提取 / SVG 的当前分支来源",
      { selected: !pending, kicker: "已接受修复" }
    ));
  }
  if (!full && !local) {
    const empty = element("div", "repair-assets-empty",
      stateName === "failed" ? "修复未生成候选；旧输入与版本保持不变。" : "候选仍在生成，暂无可比较版本。");
    dom.repairAssets.append(empty);
  }

  setDisabled(dom.repairCompare, !(input && (full || local)));
  setDisabled(dom.repairEditView, !repairAssetId(record, "edit_mask"));
  setDisabled(dom.repairDiffView, !repairAssetId(record, "difference_map"));
  renderRepairMetrics(record);

  setHidden(dom.repairDecision, !pending);
  if (pending) {
    const fullSelected = Boolean(fullId && selectedId === fullId);
    const localSelected = Boolean(localId && selectedId === localId);
    const noLocal = !local;
    setText(dom.repairDecisionNote, noLocal
      ? "本次未生成局部保护版。全图候选不是局部保护版，接受前必须单独确认整图可能变化。"
      : fullSelected
        ? "已选择全图候选；它可能改变框外像素，必须勾选醒目确认后才能接受。"
        : "默认接受局部保护版；拒绝不会改变当前输入，也不会再次调用模型。");
    setHidden(dom.repairFullWarning, !fullSelected);
    dom.repairAcceptFull.checked = Boolean(state.repair.acceptFull);
    setButtonLabel(dom.repairAccept, fullSelected ? "接受整图候选" : "接受局部保护版");
    setDisabled(dom.repairAccept,
      state.repair.decisionBusy || state.requestInFlight || Boolean(state.pendingSubmission) || state.taskRunning ||
      state.duplicateSwitching || (!fullSelected && !localSelected) || (fullSelected && !state.repair.acceptFull));
    setDisabled(dom.repairReject,
      state.repair.decisionBusy || state.requestInFlight || Boolean(state.pendingSubmission) || state.taskRunning ||
      state.duplicateSwitching);
    setText(dom.repairDecisionNote,
      (!full && !local)
        ? "当前记录没有可接受候选，请等待任务完成或重新读取。"
        : (noLocal ? "仅有全图候选；" : "") +
          (fullSelected && !state.repair.acceptFull
            ? "请先勾选“我已知晓并接受整图可能变化”。"
            : fullSelected
              ? "接受后将创建全图候选分支。"
              : "接受后将创建局部保护版分支。"));
  }

  dom.repairDecisionResult.replaceChildren();
  if (record.decision) {
    const acceptedChoice = record.decision.action === "accept";
    dom.repairDecisionResult.append(element("strong", "",
      acceptedChoice ? "已接受修复" : "已拒绝修复"));
    dom.repairDecisionResult.append(element("p", "",
      acceptedChoice
        ? "新的已接受修复资产已登记；后续提取、SVG 与 ZIP 会保留来源链。"
        : "拒绝没有改变输入，也没有创建后续任务或新收费。"));
    if (accepted) {
      const row = element("div", "task-result-item");
      const copy = element("div", "task-result-copy");
      copy.append(element("strong", "", "已接受修复 #" + shortId(accepted.asset_id)));
      copy.append(element("small", "", accepted.asset_id === state.currentInputId ? "当前输入" : "可设为当前输入"));
      row.append(copy);
      if (accepted.asset_id !== state.currentInputId && assetIsInputCapable(accepted)) {
        const use = element("button", "btn btn-outline btn-sm", "设为当前输入");
        use.type = "button";
        use.addEventListener("click", () => void switchToAcceptedRepair(record, { announce: true }));
        row.append(use);
      }
      dom.repairDecisionResult.append(row);
    }
    setHidden(dom.repairDecisionResult, false);
  } else if (stateName === "failed") {
    const message = record.error && (record.error.message || record.error.code)
      ? (record.error.message || "修复任务失败。")
      : "修复任务失败，未生成可接受候选。";
    dom.repairDecisionResult.append(element("strong", "", "修复未完成"));
    dom.repairDecisionResult.append(element("p", "", message));
    dom.repairDecisionResult.append(element("p", "hint",
      "如使用归档编辑调用，可显式重新提交同一归档复用；通用重试不会生成新的收费候选。"));
    setHidden(dom.repairDecisionResult, false);
  } else if (["queued", "running"].includes(stateName)) {
    dom.repairDecisionResult.append(element("p", "hint", "标准任务仍在处理中；页面只轮询状态，不会重复提交。"));
    setHidden(dom.repairDecisionResult, false);
  } else {
    setHidden(dom.repairDecisionResult, true);
  }

  const canContinue = Boolean(accepted && accepted.asset_id === state.currentInputId);
  setHidden(dom.repairNext, !canContinue);
  setDisabled(dom.repairNext, Boolean(state.requestInFlight || state.pendingSubmission || state.duplicateSwitching));
  setText(dom.repairNext, canContinue ? "用已接受版本继续提取 / SVG" : "用已接受版本继续");
}

function renderRepairPanel() {
  renderRepairInput();
  renderRepairDamageOptions();
  renderRepairStart();
  renderRepairRecord();
  setError(dom.repairError, state.repair.error || "");
}

function updateRepairActions() {
  setDisabled(dom.repairRefresh, Boolean(state.requestInFlight || state.repair.loading));
  renderRepairInput();
  renderRepairStart();
  const record = state.repair.record;
  const pending = Boolean(record && String(record.state || "").toLowerCase() === "waiting_user");
  const busy = Boolean(state.requestInFlight || state.pendingSubmission || state.repair.decisionBusy ||
    state.taskRunning || state.duplicateSwitching);
  const fullId = repairAssetId(record, "candidate_asset");
  const localId = repairAssetId(record, "composited_asset");
  const selectedId = state.repair.selectedAssetId;
  const selectedFull = Boolean(fullId && selectedId === fullId);
  const selectedLocal = Boolean(localId && selectedId === localId);
  const canAccept = pending && !busy && (selectedLocal || (selectedFull && state.repair.acceptFull));
  setDisabled(dom.repairCompare,
    !record || !(fullId || localId));
  setDisabled(dom.repairEditView, !record || !repairAssetId(record, "edit_mask"));
  setDisabled(dom.repairDiffView, !record || !repairAssetId(record, "difference_map"));
  setDisabled(dom.repairAccept, !canAccept);
  setDisabled(dom.repairReject, !pending || busy);
  setDisabled(dom.repairAcceptFull, !pending || busy || !selectedFull);
  setDisabled(dom.repairNext, Boolean(busy));
  setDisabled(dom.repairFeather, Boolean(state.requestInFlight || state.pendingSubmission));
  setDisabled(dom.repairSize, Boolean(state.requestInFlight || state.pendingSubmission));
  document.querySelectorAll('input[name="repair-intent"]').forEach((node) => {
    node.disabled = Boolean(state.requestInFlight || state.pendingSubmission);
  });
  setDisabled(dom.repairCallId, Boolean(state.requestInFlight || state.pendingSubmission));
  setDisabled(dom.repairDamageMask, Boolean(state.requestInFlight || state.pendingSubmission));
  setDisabled(dom.repairConsentUpload, Boolean(state.requestInFlight || state.pendingSubmission) || Boolean(dom.repairCallId.value.trim()));
  setDisabled(dom.repairConsentCharge, Boolean(state.requestInFlight || state.pendingSubmission) || Boolean(dom.repairCallId.value.trim()));
}

function selectRepairCandidate(assetId) {
  const record = state.repair.record;
  if (!record || String(record.state || "").toLowerCase() !== "waiting_user") return;
  const allowed = [repairAssetId(record, "candidate_asset"), repairAssetId(record, "composited_asset")].filter(Boolean);
  if (!allowed.includes(assetId)) return;
  state.repair.selectedAssetId = assetId;
  if (assetId !== repairAssetId(record, "candidate_asset")) {
    state.repair.acceptFull = false;
    dom.repairAcceptFull.checked = false;
  }
  setRepairError("");
  renderRepairPanel();
  updateActionState();
}

async function startRepair() {
  const reason = repairStartBlockReason();
  if (reason) {
    setRepairError(reason);
    showToast(reason, "warning");
    return;
  }
  const asset = currentAsset();
  const params = readRepairParams(true);
  if (!asset || !params.ok) {
    if (!params.ok) setRepairError(params.error);
    return;
  }
  const reuse = Boolean(params.provider_call_id);
  const ok = await confirmAction({
    title: reuse ? "复用已归档编辑调用？" : "提交新的局部修复？",
    message: reuse
      ? "将只读取同一输入、矩形、意图与尺寸的成功归档编辑，不上传当前图像，也不会产生新费用。"
      : "将上传当前规范输入并可能产生费用。已分别确认上传与收费；页面不会自动重发此收费请求。",
    confirmLabel: reuse ? "复用归档" : "提交并可能收费",
    cancelLabel: "取消",
    tone: reuse ? "primary" : "danger"
  });
  if (!ok) return;
  if (state.requestInFlight || state.pendingSubmission || state.taskRunning || state.duplicateSwitching) {
    setRepairError("当前有提交或任务尚未完成，请稍后再发起修复。");
    return;
  }

  const payload = {
    input_asset_id: asset.asset_id,
    bbox: params.bbox,
    intent: params.intent,
    feather_px: params.feather_px,
    size: params.size,
    consent_to_upload: reuse ? false : Boolean(dom.repairConsentUpload.checked),
    consent_to_charge: reuse ? false : Boolean(dom.repairConsentCharge.checked)
  };
  if (params.provider_call_id) payload.provider_call_id = params.provider_call_id;
  if (params.damage_mask_asset_id) payload.damage_mask_asset_id = params.damage_mask_asset_id;
  const bodyText = JSON.stringify(payload);
  const copy = reuse ? "复用归档编辑" : "提交局部修复";
  setRepairError("");
  state.repair.record = null;
  state.repair.jobId = null;
  state.repair.selectedAssetId = "";
  state.repair.acceptFull = false;
  dom.repairAcceptFull.checked = false;
  startSubmission({
    path: "/jobs/repair",
    method: "POST",
    label: copy,
    bodyFactory: () => bodyText,
    markBboxClean: true,
    onSuccess: async (data) => {
      const job = extractJobFromResponse(data);
      if (!job) throw new ApiError("修复任务响应缺少编号。", { status: 202 });
      state.repair.jobId = job.job_id;
      state.repair.error = "";
      dom.repairConsentUpload.checked = false;
      dom.repairConsentCharge.checked = false;
      await adoptJob(job, { announce: true });
      const latest = state.tasks.get(job.job_id);
      if (isJobActive(latest)) {
        showToast(reuse
          ? "已提交归档编辑复用；不会产生新费用。"
          : "修复任务已提交；完成后需要你明确接受或拒绝。", "info", 5000);
      }
      renderRepairPanel();
    },
    onError: (error) => {
      setRepairError("修复未创建：" + friendlyError(error));
      showToast("修复未创建：" + friendlyError(error), "error", 6500);
    },
    onUnknown: () => {
      setRepairError("修复提交结果未知。请用页面顶部的相同请求重试；页面不会自动重发。");
    }
  });
}

async function decideRepair(action) {
  const record = state.repair.record;
  if (!record || state.repair.decisionBusy || state.requestInFlight || state.pendingSubmission || state.taskRunning) return;
  if (String(record.state || "").toLowerCase() !== "waiting_user") return;
  const revision = Number(record.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    setRepairError("修复记录缺少有效 revision，请刷新后再决定。");
    return;
  }
  const fullId = repairAssetId(record, "candidate_asset");
  const localId = repairAssetId(record, "composited_asset");
  let selectedId = null;
  if (action === "accept") {
    selectedId = state.repair.selectedAssetId;
    if (![fullId, localId].filter(Boolean).includes(selectedId)) {
      setRepairError("请选择本次修复的局部保护版或全图候选。");
      return;
    }
    if (selectedId === fullId && !state.repair.acceptFull) {
      setRepairError("接受全图候选前必须勾选“我已知晓并接受整图可能变化”。");
      return;
    }
  }
  const fullSelected = action === "accept" && selectedId === fullId;
  const ok = await confirmAction({
    title: action === "reject" ? "拒绝本次修复？" : fullSelected ? "接受整图候选？" : "接受局部保护版？",
    message: action === "reject"
      ? "拒绝只记录决定，不改变当前输入，也不会创建后续任务或新收费。"
      : fullSelected
        ? "全图候选可能改变框外像素。接受后会创建新分支并切换输入；请确认这是你人工检查后的选择。"
        : "接受局部保护版会创建新的已接受修复资产并切换输入；框外应保持原输入。",
    confirmLabel: action === "reject" ? "拒绝" : fullSelected ? "接受整图候选" : "接受局部保护版",
    cancelLabel: "取消",
    tone: action === "reject" ? "danger" : fullSelected ? "danger" : "primary"
  });
  if (!ok) return;
  if (state.requestInFlight || state.pendingSubmission || state.duplicateSwitching) {
    setRepairError("当前还有提交尚未完成，请稍后再做修复决定。");
    return;
  }

  const payload = {
    revision: revision,
    action: action,
    accept_full_image_changes: action === "accept" ? fullSelected : false
  };
  if (action === "accept") payload.selected_asset_id = selectedId;
  const bodyText = JSON.stringify(payload);
  state.repair.decisionBusy = true;
  setRepairError("");
  renderRepairPanel();
  updateActionState();
  startSubmission({
    path: "/repairs/" + encodeURIComponent(record.repair_job_id) + "/decision",
    method: "POST",
    label: action === "accept" ? "接受修复" : "拒绝修复",
    bodyFactory: () => bodyText,
    onSuccess: async (data) => {
      state.repair.decisionBusy = false;
      const next = normalizeRepairRecord(data);
      if (!next) throw new ApiError("修复决定响应缺少记录。", { status: 200 });
      await registerRepairAssets(next);
      state.repair.record = next;
      state.repair.jobId = next.repair_job_id;
      state.repair.acceptFull = false;
      dom.repairAcceptFull.checked = false;
      applyRepairRecord(next, { preserveSelection: false });
      if (String(next.state || "").toLowerCase() === "accepted") {
        await switchToAcceptedRepair(next, { announce: true });
      } else {
        showToast("已拒绝修复；当前输入与后续流程保持不变。", "info", 5000);
      }
      renderRepairPanel();
      updateActionState();
    },
    onError: async (error) => {
      state.repair.decisionBusy = false;
      if (error.status === 409) {
        state.repair.selectedAssetId = "";
        state.repair.acceptFull = false;
        dom.repairAcceptFull.checked = false;
        const refreshed = await loadRepairRecord(record.repair_job_id, {
          preserveSelection: false,
          switchAccepted: true
        });
        setRepairError(refreshed
          ? "修复决定已在别处更新或 revision 过期。已重新读取，本次没有重复提交；请查看新状态后再决定。"
          : "修复决定已过期，但重新读取失败。请点击刷新，不要重复提交本次决定。");
        showToast(refreshed ? "修复状态已更新，请重新查看。" : "修复状态已更新，但读取失败。", "warning", 6500);
      } else {
        setRepairError("修复决定未提交：" + friendlyError(error));
        showToast("修复决定未提交：" + friendlyError(error), "error", 6500);
      }
      renderRepairPanel();
      updateActionState();
    },
    onUnknown: () => {
      state.repair.decisionBusy = false;
      setRepairError("修复决定结果未知。请用页面顶部的相同请求重试；页面不会自动重复决定。");
      renderRepairPanel();
      updateActionState();
    }
  });
}

function updateRepairCompareToolbar() {
  const record = state.repair.record;
  const hasThree = Boolean(record && (repairAssetId(record, "candidate_asset") || repairAssetId(record, "composited_asset")));
  const hasEdit = Boolean(record && repairAssetId(record, "edit_mask"));
  const hasDiff = Boolean(record && repairAssetId(record, "difference_map"));
  for (const button of dom.repairCompareDialog.querySelectorAll("[data-repair-view]")) {
    const view = button.dataset.repairView;
    button.disabled = view === "three" ? !hasThree : view === "edit" ? !hasEdit : !hasDiff;
    button.classList.toggle("is-active", view === state.repair.compareView);
    button.classList.toggle("btn-outline", view === state.repair.compareView);
    button.classList.toggle("btn-ghost", view !== state.repair.compareView);
  }
}

function openRepairCompare(view) {
  const record = state.repair.record;
  if (!record) return;
  state.repair.compareView = ["three", "edit", "difference"].includes(view) ? view : "three";
  setError(dom.repairCompareError, "");
  if (!dom.repairCompareDialog.open) dom.repairCompareDialog.showModal();
  updateRepairCompareToolbar();
  void renderRepairCompare();
}

function closeRepairCompare() {
  state.repair.compareSeq += 1;
  if (dom.repairCompareDialog.open) dom.repairCompareDialog.close();
  dom.repairCompareBody.replaceChildren();
  setError(dom.repairCompareError, "");
}

async function renderRepairCompare() {
  const record = state.repair.record;
  if (!record) return;
  const view = state.repair.compareView;
  const seq = ++state.repair.compareSeq;
  updateRepairCompareToolbar();
  setError(dom.repairCompareError, "");
  const spinner = element("span", "spinner");
  spinner.setAttribute("aria-label", "正在读取修复比较图");
  dom.repairCompareBody.replaceChildren(spinner);
  setText(dom.repairCompareSubtitle, "AI 推测，几何未核验；差异图只表示数值变化。");
  try {
    if (view === "three") {
      const definitions = [
        ["原输入", "修复前输入", state.assets.get(String(record.input_asset_id || "")) || null, false],
        ["全图候选", "整图可能变化；不是默认接受对象", repairAsset(record, "candidate_asset"), true],
        ["局部保护版", "框外使用原输入；默认接受对象", repairAsset(record, "composited_asset"), true]
      ];
      const grid = element("div", "repair-compare-grid");
      for (const [title, note, asset, ai] of definitions) {
        const pane = element("article", "repair-compare-pane");
        const head = element("div", "repair-compare-pane-head");
        const copy = element("div");
        copy.append(element("strong", "", title));
        copy.append(element("small", "", note));
        head.append(copy);
        if (ai) head.append(element("span", "mini-badge is-ai", "AI 推测"));
        pane.append(head);
        const visual = element("div", "repair-compare-visual");
        if (asset) {
          const image = element("img");
          image.alt = title + "预览";
          visual.append(image);
          pane.append(visual);
          grid.append(pane);
          const url = await getPreviewUrl(asset.asset_id);
          if (seq !== state.repair.compareSeq) return;
          image.src = url;
        } else {
          visual.append(element("p", "repair-compare-empty", title === "局部保护版"
            ? "本次未生成局部保护版；候选尺寸或坐标空间不一致时不会强制缩放。"
            : "此版本暂不可用。"));
          pane.append(visual);
          grid.append(pane);
        }
      }
      if (seq !== state.repair.compareSeq) return;
      dom.repairCompareBody.replaceChildren(grid);
      setText(dom.repairCompareNote, "局部保护版的框外像素应与原输入一致；全图候选可能改变整图。差异图不表示质量改善。");
    } else if (view === "edit") {
      await renderRepairEditView(record, seq);
    } else {
      const asset = repairAsset(record, "difference_map");
      if (!asset) throw new ApiError("本次没有差异图。", { status: 404 });
      const layout = element("div", "repair-difference-view");
      const image = element("img");
      image.alt = "修复差异图";
      layout.append(image);
      layout.append(element("p", "hint", "显示合成相对输入的绝对差异；它只说明数值变化，不表示修复质量改善。"));
      const url = await getPreviewUrl(asset.asset_id);
      if (seq !== state.repair.compareSeq) return;
      image.src = url;
      dom.repairCompareBody.replaceChildren(layout);
      setText(dom.repairCompareNote, "差异图不烧入成果，也不代表质量判定；请人工检查结构和边缘。");
    }
  } catch (error) {
    if (seq !== state.repair.compareSeq) return;
    setError(dom.repairCompareError, "无法读取比较图：" + friendlyError(error));
  }
}

async function renderRepairEditView(record, seq) {
  const input = state.assets.get(String(record.input_asset_id || "")) || null;
  const mask = repairAsset(record, "edit_mask");
  if (!input || !mask) throw new ApiError("缺少原输入或编辑区域掩膜。", { status: 404 });
  const [inputUrl, maskUrl] = await Promise.all([
    getPreviewUrl(input.asset_id),
    getPreviewUrl(mask.asset_id)
  ]);
  if (seq !== state.repair.compareSeq) return;
  const [inputImage, maskImage] = await Promise.all([
    loadImageElement(inputUrl),
    loadImageElement(maskUrl)
  ]);
  if (seq !== state.repair.compareSeq) return;
  const width = inputImage.naturalWidth;
  const height = inputImage.naturalHeight;
  if (!width || !height) throw new ApiError("编辑区域底图尺寸无效。", { status: 422 });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.className = "repair-edit-canvas";
  canvas.setAttribute("aria-label", "原输入与编辑区域叠加");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(inputImage, 0, 0, width, height);
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
  maskContext.drawImage(maskImage, 0, 0, width, height);
  const source = maskContext.getImageData(0, 0, width, height).data;
  const overlay = maskContext.createImageData(width, height);
  for (let index = 0; index < source.length; index += 4) {
    const alpha = source[index + 3];
    const luminance = (source[index] + source[index + 1] + source[index + 2]) / 3;
    if (alpha > 10 && luminance > 127) {
      overlay.data[index] = 183;
      overlay.data[index + 1] = 74;
      overlay.data[index + 2] = 50;
      overlay.data[index + 3] = 112;
    }
  }
  maskContext.putImageData(overlay, 0, 0);
  context.drawImage(maskCanvas, 0, 0);
  const layout = element("div", "repair-edit-view");
  layout.append(canvas);
  const legend = element("p", "repair-edit-legend");
  legend.append(element("span", "repair-edit-swatch"));
  legend.append(document.createTextNode("红色为 edit_mask 允许修改的矩形范围；只做预览，不烧入成果。"));
  layout.append(legend);
  dom.repairCompareBody.replaceChildren(layout);
  setText(dom.repairCompareNote, "编辑区域是矩形二值掩膜；实际羽化权重单独保存，框外必须保持原输入。");
}

function croppedUnitAssets() {
  const units = [];
  for (const id of state.versionIds) {
    const asset = state.assets.get(id);
    if (!asset) continue;
    if (!["cropped", "crop"].includes(normalizeKind(asset.kind))) continue;
    units.push(asset);
  }
  return units;
}

function selectedTileUnit() {
  return state.tile.unitId ? state.assets.get(state.tile.unitId) || null : null;
}

function renderTilePreset() {
  setRadio("tile-preset", String(state.tile.rows === 3 ? 3 : 2));
  if (dom.tileSeam.value !== state.tile.seamObservation) {
    dom.tileSeam.value = state.tile.seamObservation;
  }
}

function renderTileUnits() {
  const units = croppedUnitAssets();
  const signature = units.map((asset) => asset.asset_id).join("|");
  if (!units.some((asset) => asset.asset_id === state.tile.unitId)) state.tile.unitId = "";
  if (signature !== state.tile.unitSignature) {
    state.tile.unitSignature = signature;
    dom.tileUnit.replaceChildren();
    const placeholder = element("option", "", units.length ? "请选择已保存的裁切单元" : "尚无裁切单元，请先裁切");
    placeholder.value = "";
    dom.tileUnit.append(placeholder);
    for (const unit of units) {
      const option = element("option", "",
        "#" + shortId(unit.asset_id) + " · " + formatDimensions(assetWidth(unit), assetHeight(unit)));
      option.value = unit.asset_id;
      dom.tileUnit.append(option);
    }
  }
  dom.tileUnit.value = state.tile.unitId;
  const unit = selectedTileUnit();
  setHidden(dom.tileUnitPreview, !unit);
  if (unit) {
    setText(dom.tileUnitName, "裁切单元 #" + shortId(unit.asset_id));
    const bbox = unit.bbox || (unit.parameters && unit.parameters.bbox) ||
      (unit.transform && unit.transform.bbox) || null;
    setText(dom.tileUnitMeta,
      formatDimensions(assetWidth(unit), assetHeight(unit)) + " · " +
      formatPixels(assetWidth(unit), assetHeight(unit)) + (bbox ? " · bbox " + formatBbox(bbox) : ""));
    if (dom.tileUnitImage.dataset.assetId !== unit.asset_id) {
      dom.tileUnitImage.dataset.assetId = unit.asset_id;
      loadThumb(dom.tileUnitImage, unit);
    }
  } else {
    dom.tileUnitImage.removeAttribute("src");
    dom.tileUnitImage.dataset.assetId = "";
  }
}

function tileOutputSize() {
  const unit = selectedTileUnit();
  const width = assetWidth(unit) * state.tile.cols;
  const height = assetHeight(unit) * state.tile.rows;
  return { width: width, height: height, pixels: width * height };
}

function tileBlockReason() {
  if (state.duplicateSwitching) return "正在切换已有版本，请稍候。";
  if (state.requestInFlight) return "正在提交，请稍候。";
  if (state.pendingSubmission) return "请先处理结果未知的上一次提交。";
  if (state.taskRunning) return "已有任务处理中，完成后再生成平铺。";
  const unit = selectedTileUnit();
  if (!unit) return "请先选择一个已保存的裁切单元。";
  if (!["cropped", "crop"].includes(normalizeKind(unit.kind))) return "平铺只接受 cropped 裁切资产。";
  if (![2, 3].includes(state.tile.rows) || state.tile.rows !== state.tile.cols) {
    return "请选择 2×2 或 3×3 预设。";
  }
  const size = tileOutputSize();
  if (size.pixels > TILE_PIXEL_LIMIT) {
    return "输出 " + formatDimensions(size.width, size.height) + "（" + formatPixels(size.width, size.height) +
      "）超过 4 MP；请选择较小单元，不会隐式缩放。";
  }
  return "";
}

function renderTileResult() {
  const asset = state.tile.resultAssetId ? state.assets.get(state.tile.resultAssetId) || null : null;
  setHidden(dom.tileResult, !asset);
  if (!asset) {
    dom.tileResultImage.removeAttribute("src");
    return;
  }
  if (dom.tileResultImage.dataset.assetId !== asset.asset_id) {
    dom.tileResultImage.dataset.assetId = asset.asset_id;
    loadThumb(dom.tileResultImage, asset);
  }
  const params = state.tile.job && state.tile.job.parameters && typeof state.tile.job.parameters === "object"
    ? state.tile.job.parameters : {};
  const seam = String(asset.seam_observation || params.seam_observation || state.tile.seamObservation);
  setText(dom.tileResultSeam, SEAM_LABELS[seam] || "接缝未检查");
  const unit = selectedTileUnit();
  const meta = [];
  if (assetWidth(asset) && assetHeight(asset)) meta.push("输出 " + formatDimensions(assetWidth(asset), assetHeight(asset)));
  if (unit) meta.push("单元 " + formatDimensions(assetWidth(unit), assetHeight(unit)));
  meta.push((params.rows || state.tile.rows) + " × " + (params.cols || state.tile.cols));
  meta.push("RGBA 整数复制 · 不缩放");
  setText(dom.tileResultMeta, meta.join(" · "));
}

function renderTilePanel() {
  renderTileUnits();
  renderTilePreset();
  renderTileResult();
  const unit = selectedTileUnit();
  const size = unit ? tileOutputSize() : null;
  const reason = tileBlockReason();
  if (!unit) {
    setText(dom.tileNote, "选择单元后显示输出尺寸与 4 MP 上限检查。");
  } else if (size.pixels > TILE_PIXEL_LIMIT) {
    setText(dom.tileNote,
      "输出 " + formatDimensions(size.width, size.height) + "（" + formatPixels(size.width, size.height) +
      "）超过 4,000,000 px；请换较小单元，服务端会拒绝，前端不会缩放。");
  } else {
    setText(dom.tileNote,
      "输出 " + formatDimensions(size.width, size.height) + "（" + formatPixels(size.width, size.height) +
      "）· 上限 4 MP · 接缝仅记录你的目测，不提供自动消缝或无缝判定。");
  }
  setError(dom.tileError, state.tile.error || "");
  updateTileActions();
}

function updateTileActions() {
  const unit = selectedTileUnit();
  const busy = Boolean(state.requestInFlight || state.pendingSubmission || state.taskRunning || state.duplicateSwitching);
  const reason = tileBlockReason();
  setDisabled(dom.tileGenerate, Boolean(reason));
  setDisabled(dom.tileCrop, busy || !currentAsset() || !isPreviewCurrent() ||
    !state.bbox || !validBboxForAsset(state.bbox, currentAsset()));
  setDisabled(dom.tileUnit, busy || state.tile.loading);
  setDisabled(dom.tileUnitDownload, Boolean(busy || !unit));
  const result = state.tile.resultAssetId ? state.assets.get(state.tile.resultAssetId) : null;
  setDisabled(dom.tileDownload, Boolean(busy || !result));
  setDisabled(dom.tileZip, Boolean(busy || !unit || !result));
  if (reason && unit) setText(dom.tileGenerate, "生成平铺预览");
}

async function handleTileCrop() {
  if (state.requestInFlight || state.pendingSubmission || state.taskRunning) return;
  const asset = currentAsset();
  if (!asset || !isPreviewCurrent()) {
    setError(dom.tileError, "请先回到当前输入。");
    return;
  }
  if (!state.bbox || !validBboxForAsset(state.bbox, asset)) {
    setError(dom.tileError, "请先在当前输入上框选有效矩形。");
    showToast("平铺需要先用现有画布框选一个有效单元。", "warning");
    return;
  }
  setError(dom.tileError, "");
  state.tile.error = "";
  const bodyText = JSON.stringify({ input_asset_id: asset.asset_id, bbox: Object.assign({}, state.bbox) });
  startSubmission({
    path: "/jobs/crop",
    method: "POST",
    label: "保存平铺裁切单元",
    bodyFactory: () => bodyText,
    markBboxClean: true,
    onSuccess: async (data) => {
      const job = extractJobFromResponse(data);
      if (!job) throw new ApiError("裁切任务响应缺少编号。", { status: 202 });
      state.tile.pendingCrop = true;
      state.tile.pendingCropJobId = job.job_id;
      await adoptJob(job, { announce: true });
      if (!state.tile.unitId) {
        showToast("正在保存裁切单元；完成后会自动选中。", "info", 4500);
      }
    },
    onError: (error) => {
      state.tile.pendingCrop = false;
      state.tile.pendingCropJobId = null;
      setError(dom.tileError, "裁切单元未创建：" + friendlyError(error));
      showToast("裁切单元未创建：" + friendlyError(error), "error", 6500);
    },
    onUnknown: () => {
      state.tile.pendingCrop = false;
      state.tile.pendingCropJobId = null;
      setError(dom.tileError, "裁切提交结果未知。请用页面顶部的相同请求重试；不会自动重发。");
    }
  });
}

async function startTilePreview() {
  const reason = tileBlockReason();
  if (reason) {
    setError(dom.tileError, reason);
    showToast(reason, "warning");
    return;
  }
  const unit = selectedTileUnit();
  if (!unit) return;
  const payload = {
    unit_asset_id: unit.asset_id,
    rows: state.tile.rows,
    cols: state.tile.cols,
    seam_observation: state.tile.seamObservation
  };
  const bodyText = JSON.stringify(payload);
  state.tile.error = "";
  state.tile.resultAssetId = "";
  state.tile.job = null;
  setError(dom.tileError, "");
  startSubmission({
    path: "/jobs/tile-preview",
    method: "POST",
    label: "生成平铺预览",
    bodyFactory: () => bodyText,
    onSuccess: async (data) => {
      const job = extractJobFromResponse(data);
      if (!job) throw new ApiError("平铺任务响应缺少编号。", { status: 202 });
      state.tile.jobId = job.job_id;
      await adoptJob(job, { announce: true });
      const latest = state.tasks.get(job.job_id);
      if (isJobActive(latest)) {
        showToast("平铺任务已提交；完成后可下载单元与平铺，预览不代表无缝。", "info", 5500);
      }
      renderTilePanel();
    },
    onError: (error) => {
      state.tile.error = "平铺未创建：" + friendlyError(error);
      setError(dom.tileError, state.tile.error);
      showToast(state.tile.error, "error", 6500);
    },
    onUnknown: () => {
      state.tile.error = "平铺提交结果未知。请用页面顶部的相同请求重试；不会自动重发。";
      setError(dom.tileError, state.tile.error);
    }
  });
}

async function handleTileZip() {
  if (state.requestInFlight || state.pendingSubmission || state.taskRunning || state.duplicateSwitching) return;
  const unit = selectedTileUnit();
  const preview = state.tile.resultAssetId ? state.assets.get(state.tile.resultAssetId) : null;
  if (!unit || !preview) {
    setError(dom.tileError, "请先生成平铺预览，再打包单元与平铺。");
    return;
  }
  const ids = [unit.asset_id, preview.asset_id];
  setError(dom.tileError, "");
  const unconfirmed = unconfirmedLicenseIds(ids);
  const license = await confirmExportLicense(unconfirmed.length);
  if (!license.proceed) return;
  if (state.requestInFlight || state.pendingSubmission || state.taskRunning || state.duplicateSwitching) {
    setError(dom.tileError, "当前有提交或任务正在处理，完成后再打包。");
    return;
  }
  const currentUnit = selectedTileUnit();
  if (state.tile.resultAssetId !== preview.asset_id || !currentUnit || currentUnit.asset_id !== unit.asset_id) {
    setError(dom.tileError, "平铺预览或裁切单元已变化，请重新确认后再打包。");
    return;
  }
  const bodyText = JSON.stringify({ asset_ids: ids, license_acknowledged: license.acknowledged });
  startSubmission({
    path: "/exports",
    method: "POST",
    label: "打包平铺单元",
    bodyFactory: () => bodyText,
    onSuccess: async (data) => {
      const job = extractJobFromResponse(data);
      if (!job) throw new ApiError("平铺 ZIP 响应缺少编号。", { status: 202 });
      await adoptJob(job, { announce: true });
      showToast("已提交平铺单元 ZIP；包内仅含单元与平铺预览。", "info", 5000);
    },
    onError: (error) => {
      setError(dom.tileError, "平铺 ZIP 未创建：" + friendlyError(error));
      showToast("平铺 ZIP 未创建：" + friendlyError(error), "error", 6500);
    },
    onUnknown: () => {
      setError(dom.tileError, "平铺 ZIP 提交结果未知，请用页面顶部提示重试。");
    }
  });
}

async function completeRepairJob(job) {
  state.repair.jobId = job.job_id;
  const record = await loadRepairRecord(job.job_id, {
    preserveSelection: false,
    switchAccepted: true
  });
  if (!record) {
    state.repair.error = "修复任务已完成，但修复记录读取失败。请点击修复面板的刷新，不要重复提交收费请求。";
    renderRepairPanel();
    return;
  }
  const repairState = String(record.state || "").toLowerCase();
  if (repairState === "waiting_user") {
    showToast(record.composited_asset
      ? "修复候选已就绪；默认接受局部保护版，请先比较后确认。"
      : "修复候选已就绪，但未生成局部保护版；接受全图候选需额外确认。", "success", 6500);
  } else if (repairState === "failed") {
    showToast("修复任务失败；没有自动重试或收费。可在归档复用路径下重新提交。", "warning", 6500);
  }
}

async function completeTileJob(job) {
  const assets = job.result && Array.isArray(job.result.assets) ? job.result.assets : [];
  let asset = null;
  for (const raw of assets) {
    const id = assetIdOf(raw);
    const candidate = id ? state.assets.get(id) : null;
    if (candidate && normalizeKind(candidate.kind).includes("tile")) {
      asset = candidate;
      break;
    }
  }
  if (!asset) {
    const generated = assets.map((raw) => state.assets.get(assetIdOf(raw))).find((item) =>
      item && normalizeKind(item.kind).includes("tile"));
    asset = generated || null;
  }
  state.tile.jobId = job.job_id;
  state.tile.job = job;
  const params = job.parameters && typeof job.parameters === "object" ? job.parameters : {};
  if (job.input_asset_id) {
    state.tile.unitId = String(job.input_asset_id);
    if (!state.assets.has(state.tile.unitId)) {
      try {
        await registerAssets([state.tile.unitId], { context: jobContext(job), prepend: false });
      } catch (_) {
        // The unit may still be registered by the crop history; keep the ID for retry.
      }
    }
  }
  if ([2, 3].includes(Number(params.rows))) state.tile.rows = Number(params.rows);
  if ([2, 3].includes(Number(params.cols))) state.tile.cols = Number(params.cols);
  if (SEAM_LABELS[params.seam_observation]) state.tile.seamObservation = params.seam_observation;
  if (!asset) {
    state.tile.error = "平铺任务已完成，但没有返回 tile_preview 资产。可刷新历史后重试。";
    renderTilePanel();
    renderVersions();
    return;
  }
  state.tile.resultAssetId = asset.asset_id;
  asset._context = Object.assign({}, asset._context, {
    origin: "tile_preview",
    tilePreview: true,
    unitAssetId: state.tile.unitId,
    jobKind: "tile-preview"
  });
  state.tile.error = "";
  renderTilePanel();
  renderVersions();
  showToast("平铺预览已生成。请目测接缝；这仅证明整数复制，不代表自动无缝。", "success", 6500);
}

async function restoreRepairForJob(jobId) {
  const record = await loadRepairRecord(jobId, {
    preserveSelection: false,
    switchAccepted: true,
    announce: false
  });
  if (record) {
    showToast("已恢复修复记录与待确认状态。", "info", 4500);
  }
}

async function restoreTileFromJob(job) {
  const params = job && job.parameters && typeof job.parameters === "object" ? job.parameters : {};
  state.tile.jobId = job.job_id;
  state.tile.job = job;
  state.tile.unitId = String(job.input_asset_id || "");
  if ([2, 3].includes(Number(params.rows))) state.tile.rows = Number(params.rows);
  if ([2, 3].includes(Number(params.cols))) state.tile.cols = Number(params.cols);
  if (SEAM_LABELS[params.seam_observation]) state.tile.seamObservation = params.seam_observation;
  if (state.tile.unitId && !state.assets.has(state.tile.unitId)) {
    try {
      await registerAssets([state.tile.unitId], { context: jobContext(job), prepend: false });
    } catch (_) {
      state.tile.error = "历史平铺单元无法读取，仍可查看已有平铺预览。";
    }
  }
  const raws = job.result && Array.isArray(job.result.assets) ? job.result.assets : [];
  let preview = null;
  for (const raw of raws) {
    const asset = state.assets.get(assetIdOf(raw));
    if (asset && normalizeKind(asset.kind).includes("tile")) {
      preview = asset;
      break;
    }
  }
  state.tile.resultAssetId = preview ? preview.asset_id : "";
  renderVersions();
  renderTilePanel();
  updateActionState();
}

function openAssetPreview(asset, kicker) {
  if (!asset) return;
  state.assetPreviewId = asset.asset_id;
  setText(dom.assetPreviewKicker, kicker || "候选预览");
  setText(dom.assetPreviewTitle, assetDisplayName(asset));
  setText(dom.assetPreviewMeta,
    "#" + shortId(asset.asset_id) +
    (assetWidth(asset) && assetHeight(asset) ? " · " + formatDimensions(assetWidth(asset), assetHeight(asset)) : ""));
  dom.assetPreviewBadges.replaceChildren();
  if (assetIsAi(asset)) {
    dom.assetPreviewBadges.append(element("span", "mini-badge is-ai", "AI 候选"));
    if (!assetGeometryVerified(asset)) {
      dom.assetPreviewBadges.append(element("span", "mini-badge is-unverified", "几何未核验"));
    }
  }
  const spinner = element("span", "spinner");
  spinner.setAttribute("aria-label", "正在读取预览");
  dom.assetPreviewBody.replaceChildren(spinner);
  if (dom.assetPreviewDialog.open) dom.assetPreviewDialog.close();
  dom.assetPreviewDialog.showModal();
  dom.assetPreviewDownload.disabled = false;
  fillAssetPreview(asset);
}

async function fillAssetPreview(asset) {
  try {
    const url = await getPreviewUrl(asset.asset_id);
    if (!dom.assetPreviewDialog.open || state.assetPreviewId !== asset.asset_id) return;
    const image = element("img");
    image.alt = assetDisplayName(asset) + " 预览";
    image.src = url;
    dom.assetPreviewBody.replaceChildren(image);
  } catch (error) {
    if (!dom.assetPreviewDialog.open) return;
    dom.assetPreviewBody.replaceChildren(element("p", "compare-error", friendlyError(error)));
  }
}

/* -------------------------------------------------------------------------- */
/* Foreground mask brush                                                      */
/* -------------------------------------------------------------------------- */

function buildMaskPairs() {
  const candidates = new Map();
  function addCandidate(maskId, sourceId) {
    if (!maskId || !sourceId) return;
    if (!candidates.has(maskId)) candidates.set(maskId, new Set());
    candidates.get(maskId).add(sourceId);
  }

  for (const id of state.versionIds) {
    const asset = state.assets.get(id);
    if (!asset) continue;
    const kind = normalizeKind(asset.kind);
    if (kind === "transparent_png") {
      addCandidate(asset.source_mask_asset_id, asset.source_rgb_asset_id);
    } else if (kind === "foreground_mask") {
      addCandidate(asset.asset_id, asset.source_rgb_asset_id || asset.source_asset_id);
    }
  }

  const pairs = [];
  for (const [maskId, sources] of candidates.entries()) {
    if (sources.size !== 1) continue;
    const sourceId = Array.from(sources)[0];
    const mask = state.assets.get(maskId);
    const source = state.assets.get(sourceId);
    if (!mask || !source) continue;
    if (!assetIsForegroundMask(mask) || !assetIsInputCapable(source)) continue;
    const width = assetWidth(mask);
    const height = assetHeight(mask);
    if (!width || !height || width !== assetWidth(source) || height !== assetHeight(source)) continue;
    const maskSpace = mask.coordinate_space_id || mask.coordinate_space;
    const sourceSpace = source.coordinate_space_id || source.coordinate_space;
    if (maskSpace && sourceSpace && String(maskSpace) !== String(sourceSpace)) continue;
    const key = maskId + "|" + sourceId;
    pairs.push({
      key: key,
      maskId: maskId,
      sourceId: sourceId,
      mask: mask,
      source: source,
      label: "蒙版 " + shortId(maskId) + " · 源图 " + shortId(sourceId),
      detail: formatDimensions(width, height) + " · 同一坐标与来源"
    });
  }
  return pairs;
}

function selectedMaskPair() {
  return state.brush.pairs.find((pair) => pair.key === state.brush.selectedPairKey) || null;
}

function renderMaskPanel() {
  state.brush.pairs = buildMaskPairs();
  const pairs = state.brush.pairs;
  const hasPairs = pairs.length > 0;
  setHidden(dom.maskEmpty, hasPairs);
  setHidden(dom.maskSetup, !hasPairs);
  dom.maskOpen.disabled = !hasPairs;

  if (!hasPairs) {
    dom.maskPair.replaceChildren();
    state.brush.selectedPairKey = "";
    setText(dom.maskPairNote, "只能编辑同一来源、同一尺寸的蒙版。");
    return;
  }

  const currentKey = state.brush.selectedPairKey;
  const validCurrent = pairs.some((pair) => pair.key === currentKey) ? currentKey : pairs[0].key;
  state.brush.selectedPairKey = validCurrent;
  dom.maskPair.replaceChildren();
  for (const pair of pairs) {
    const option = element("option", "", pair.label);
    option.value = pair.key;
    dom.maskPair.append(option);
  }
  dom.maskPair.value = validCurrent;
  const pair = selectedMaskPair();
  setText(dom.maskPairNote, pair ? pair.detail : "只能编辑同一来源、同一尺寸的蒙版。");
}

function readMaskPixelData(image, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4;
    if (data[offset + 3] < 10) {
      mask[index] = 0;
    } else {
      mask[index] = data[offset] >= 128 ? 255 : 0;
    }
  }
  return mask;
}

function filterMask(base, width, height, invert, denoise) {
  let source = new Uint8Array(base.length);
  for (let index = 0; index < base.length; index += 1) {
    const value = base[index] >= 128 ? 1 : 0;
    source[index] = invert ? 1 - value : value;
  }
  if (!denoise) {
    for (let index = 0; index < source.length; index += 1) source[index] = source[index] ? 255 : 0;
    return source;
  }

  const radius = denoise === 2 ? 2 : 1;
  const stride = width + 1;
  const integral = new Int32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let row = 0;
    for (let x = 0; x < width; x += 1) {
      row += source[y * width + x] ? 1 : 0;
      integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + row;
    }
  }
  const result = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      const sum =
        integral[y1 * stride + x1] -
        integral[y0 * stride + x1] -
        integral[y1 * stride + x0] +
        integral[y0 * stride + x0];
      const total = (x1 - x0) * (y1 - y0);
      result[y * width + x] = sum * 2 >= total ? 255 : 0;
    }
  }
  return result;
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new ApiError("图像读取失败。", { status: 0 }));
    image.src = url;
  });
}

async function openMaskBrush() {
  if (state.requestInFlight || state.pendingSubmission || state.taskRunning) {
    showToast("当前有提交或任务正在处理，完成后再编辑蒙版。", "warning");
    return;
  }
  const pair = selectedMaskPair();
  if (!pair) {
    showToast("没有可编辑的源图与蒙版组合。", "warning");
    return;
  }
  if (assetPixels(pair.source) > PROCESS_PIXEL_LIMIT) {
    showToast("这组源图超过本地修正上限，请先创建工作副本并重新提取。", "warning", 6000);
    return;
  }
  if (dom.brushDialog.open) return;

  const brush = state.brush;
  brush.open = true;
  brush.loading = true;
  brush.saving = false;
  brush.source = pair.source;
  brush.mask = pair.mask;
  brush.width = assetWidth(pair.source);
  brush.height = assetHeight(pair.source);
  brush.baseMask = null;
  brush.processed = null;
  brush.history.reset({ invert: false, denoise: 0 });
  brush.strokes = [];
  brush.activeStroke = null;
  brush.dirty = false;
  brush.invert = false;
  brush.denoise = 0;
  brush.overlay = true;
  brush.mode = "add";
  brush.algorithm = "brush";
  brush.iterations = 5;
  brush.radius = 6;
  brush.pointsWarned = false;
  brush.lastPointer = null;
  brush.loadToken = (brush.loadToken || 0) + 1;

  dom.brushInvert.checked = false;
  dom.brushDenoise.value = "0";
  dom.brushOverlay.checked = true;
  dom.brushIterations.value = "5";
  const addMode = document.querySelector('input[name="brush-mode"][value="add"]');
  const brushAlgorithm = document.querySelector('input[name="brush-algorithm"][value="brush"]');
  if (addMode) addMode.checked = true;
  if (brushAlgorithm) brushAlgorithm.checked = true;
  setBrushRadius(6, { silent: true });
  updateBrushAlgorithmUi();
  setError(dom.brushError, "");
  setText(dom.brushPairMeta, pair.label + " · " + pair.detail);
  setText(dom.brushSubtitle, "源图 " + formatDimensions(brush.width, brush.height) + "；笔画按原图像素保存。");
  setHidden(dom.brushLoading, false);
  setText(dom.brushLoadingText, "正在读取源图与蒙版…");
  setHidden(dom.brushCursor, true);
  updateBrushControls();
  dom.brushDialog.showModal();
  dom.brushClose.focus();

  const token = brush.loadToken;
  try {
    const [sourceUrl, maskUrl] = await Promise.all([
      getPreviewUrl(pair.sourceId),
      getPreviewUrl(pair.maskId)
    ]);
    const [sourceImage, maskImage] = await Promise.all([
      loadImageElement(sourceUrl),
      loadImageElement(maskUrl)
    ]);
    if (!brush.open || token !== brush.loadToken) return;
    brush.sourceImage = sourceImage;
    brush.maskImage = maskImage;
    brush.baseMask = readMaskPixelData(maskImage, brush.width, brush.height);
    brush.loading = false;
    setHidden(dom.brushLoading, true);
    rebuildBrushMask();
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    sizeBrushCanvas();
    scheduleBrushRender();
    updateBrushControls();
    dom.brushCanvas.focus();
  } catch (error) {
    if (!brush.open || token !== brush.loadToken) return;
    brush.loading = false;
    setHidden(dom.brushLoading, true);
    setError(dom.brushError, "无法打开蒙版画笔：" + friendlyError(error));
  }
}

function closeBrushEditor(force) {
  const brush = state.brush;
  if (!brush.open) return;
  if (brush.saving && !force) return;
  if (dom.brushDialog.open) dom.brushDialog.close();
  brush.open = false;
  brush.loading = false;
  brush.saving = false;
  brush.dirty = false;
  brush.history.clear();
  brush.strokes = [];
  brush.activeStroke = null;
  brush.baseMask = null;
  brush.processed = null;
  brush.maskCanvas = null;
  brush.sourceImage = null;
  brush.maskImage = null;
  brush.lastPointer = null;
  brush.cssWidth = 0;
  brush.cssHeight = 0;
  brush.pointsWarned = false;
  setHidden(dom.brushCursor, true);
  dom.brushCanvas.classList.remove("is-seeds");
  setError(dom.brushError, "");
  updateBrushControls();
  if (dom.maskOpen) dom.maskOpen.focus();
}

async function requestCloseBrushEditor() {
  const brush = state.brush;
  if (!brush.open || brush.saving) return;
  if (!brush.dirty) {
    closeBrushEditor(true);
    return;
  }
  const ok = await confirmAction({
    title: "放弃本次蒙版修改？",
    message: "当前的笔画、反相与去噪还没有保存。关闭后不会生成新版本，原蒙版保持不变。",
    confirmLabel: "放弃修改",
    cancelLabel: "继续编辑",
    tone: "danger"
  });
  if (ok) closeBrushEditor(true);
}

function sizeBrushCanvas() {
  const brush = state.brush;
  if (!brush.open || !brush.width || !brush.height) return;
  const viewportWidth = Math.max(280, dom.brushViewport.clientWidth - 24);
  const viewportHeight = Math.max(250, Math.min(window.innerHeight * 0.64, 700));
  const scale = Math.min(viewportWidth / brush.width, viewportHeight / brush.height, 2.5);
  const cssWidth = Math.max(1, Math.round(brush.width * scale));
  const cssHeight = Math.max(1, Math.round(brush.height * scale));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  dom.brushCanvas.width = Math.round(cssWidth * dpr);
  dom.brushCanvas.height = Math.round(cssHeight * dpr);
  dom.brushCanvas.style.width = cssWidth + "px";
  dom.brushCanvas.style.height = cssHeight + "px";
  brush.displayScale = cssWidth / brush.width;
  brush.cssWidth = cssWidth;
  brush.cssHeight = cssHeight;
  brush.dpr = dpr;
  scheduleBrushRender();
}

function drawBrushDot(context, point, radius, mode) {
  context.save();
  context.globalCompositeOperation = mode === "erase" ? "destination-out" : "source-over";
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawBrushSegment(context, from, to, radius, mode) {
  context.save();
  context.globalCompositeOperation = mode === "erase" ? "destination-out" : "source-over";
  context.strokeStyle = "#ffffff";
  context.lineWidth = radius * 2 + 1;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
  context.restore();
}

function drawStrokeToMask(context, stroke) {
  const points = stroke.points;
  if (!points.length) return;
  if (points.length === 1) {
    drawBrushDot(context, points[0], stroke.radius, stroke.mode);
    return;
  }
  context.save();
  context.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
  context.strokeStyle = "#ffffff";
  context.lineWidth = stroke.radius * 2 + 1;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index].x, points[index].y);
  }
  context.stroke();
  for (const point of points) {
    context.beginPath();
    context.arc(point.x, point.y, stroke.radius, 0, Math.PI * 2);
    context.fillStyle = "#ffffff";
    context.fill();
  }
  context.restore();
}

function applyBrushHistoryState() {
  const brush = state.brush;
  const derived = brush.history.state();
  brush.strokes = derived.strokes;
  brush.invert = derived.invert;
  brush.denoise = derived.denoise;
  if (dom.brushInvert) dom.brushInvert.checked = derived.invert;
  if (dom.brushDenoise) dom.brushDenoise.value = String(derived.denoise);
  return derived;
}

function rebuildBrushMask() {
  const brush = state.brush;
  if (!brush.baseMask || !brush.open) return;
  const derived = applyBrushHistoryState();
  const processed = filterMask(brush.baseMask, brush.width, brush.height, derived.invert, derived.denoise);
  brush.processed = processed;
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = brush.width;
  maskCanvas.height = brush.height;
  const context = maskCanvas.getContext("2d");
  const imageData = context.createImageData(brush.width, brush.height);
  for (let index = 0; index < processed.length; index += 1) {
    const value = processed[index];
    if (!value) continue;
    const offset = index * 4;
    imageData.data[offset] = 255;
    imageData.data[offset + 1] = 255;
    imageData.data[offset + 2] = 255;
    imageData.data[offset + 3] = 255;
  }
  context.putImageData(imageData, 0, 0);
  for (const stroke of derived.strokes) drawStrokeToMask(context, stroke);
  brush.maskCanvas = maskCanvas;
  scheduleBrushRender();
  updateBrushControls();
}

function scheduleBrushRender() {
  const brush = state.brush;
  if (!brush.open || brush.renderQueued) return;
  brush.renderQueued = true;
  window.requestAnimationFrame(() => {
    brush.renderQueued = false;
    drawBrushDisplay();
  });
}

function drawBrushDisplay() {
  const brush = state.brush;
  if (!brush.open || !brush.sourceImage || !brush.maskCanvas || !brush.cssWidth) return;
  const canvas = dom.brushCanvas;
  const context = canvas.getContext("2d");
  const dpr = brush.dpr || 1;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, brush.cssWidth, brush.cssHeight);
  context.imageSmoothingEnabled = true;
  context.drawImage(brush.sourceImage, 0, 0, brush.cssWidth, brush.cssHeight);
  if (brush.overlay) {
    const tint = brush.tintCanvas || (brush.tintCanvas = document.createElement("canvas"));
    if (tint.width !== brush.cssWidth || tint.height !== brush.cssHeight) {
      tint.width = brush.cssWidth;
      tint.height = brush.cssHeight;
    }
    const tintContext = tint.getContext("2d");
    tintContext.setTransform(1, 0, 0, 1, 0, 0);
    tintContext.clearRect(0, 0, tint.width, tint.height);
    tintContext.globalCompositeOperation = "source-over";
    tintContext.imageSmoothingEnabled = false;
    tintContext.drawImage(brush.maskCanvas, 0, 0, brush.cssWidth, brush.cssHeight);
    tintContext.globalCompositeOperation = "source-in";
    tintContext.fillStyle = brush.algorithm === "grabcut"
      ? "rgba(27, 43, 84, 0.28)"
      : "rgba(22, 112, 94, 0.52)";
    tintContext.fillRect(0, 0, brush.cssWidth, brush.cssHeight);
    context.drawImage(tint, 0, 0);
  }
}

function canvasPoint(event) {
  const brush = state.brush;
  const rect = dom.brushCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const maxX = Math.max(0, brush.width - 0.01);
  const maxY = Math.max(0, brush.height - 0.01);
  const x = clamp(((event.clientX - rect.left) / rect.width) * brush.width, 0, maxX);
  const y = clamp(((event.clientY - rect.top) / rect.height) * brush.height, 0, maxY);
  return { x: x, y: y };
}

function updateBrushCursor(event) {
  const brush = state.brush;
  if (!brush.open || brush.loading || !event) {
    setHidden(dom.brushCursor, true);
    return;
  }
  const viewportRect = dom.brushViewport.getBoundingClientRect();
  const rect = dom.brushCanvas.getBoundingClientRect();
  if (
    event.clientX < rect.left || event.clientX > rect.right ||
    event.clientY < rect.top || event.clientY > rect.bottom
  ) {
    setHidden(dom.brushCursor, true);
    return;
  }
  const size = Math.max(8, brush.radius * 2 * brush.displayScale);
  dom.brushCursor.style.width = size + "px";
  dom.brushCursor.style.height = size + "px";
  dom.brushCursor.style.left = (event.clientX - viewportRect.left) + "px";
  dom.brushCursor.style.top = (event.clientY - viewportRect.top) + "px";
  dom.brushCursor.classList.toggle("is-erase", brush.mode === "erase");
  setHidden(dom.brushCursor, false);
}

function brushPointCount() {
  return state.brush.strokes.reduce((total, stroke) => total + stroke.points.length, 0) +
    (state.brush.activeStroke ? state.brush.activeStroke.points.length : 0);
}

function setBrushRadius(value, options) {
  const opts = options || {};
  const brush = state.brush;
  const number = Number(value);
  if (!Number.isFinite(number)) return;
  const radius = clamp(Math.round(number), BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX);
  brush.radius = radius;
  if (dom.brushRadiusRange) dom.brushRadiusRange.value = String(radius);
  if (dom.brushRadiusValue && String(dom.brushRadiusValue.value) !== String(radius)) {
    dom.brushRadiusValue.value = String(radius);
  }
  setText(dom.brushRadiusReadout, radius);
  if (!opts.silent && brush.lastPointer) updateBrushCursor(brush.lastPointer);
}

function currentBrushAlgorithm() {
  return checkedValue("brush-algorithm") || "brush";
}

function updateBrushAlgorithmUi() {
  const brush = state.brush;
  const algorithm = brush.open ? currentBrushAlgorithm() : (brush.algorithm || "brush");
  if (brush.open) brush.algorithm = algorithm;
  setHidden(dom.brushIterationsField, algorithm !== "grabcut");
  setText(dom.brushAlgorithmNote, algorithm === "grabcut"
    ? "GrabCut 细化：保留／擦除笔画只是硬约束种子，画布叠加不是最终分割。提交后先生成蒙版预览，检查后再应用。"
    : "逐笔直接：画布叠加接近最终蒙版，保存后创建新版本。");
  setButtonLabel(dom.brushSave, algorithm === "grabcut" ? "提交并预览" : "保存新蒙版");
  dom.brushCanvas.classList.toggle("is-seeds", algorithm === "grabcut");
}

function updateBrushControls() {
  const brush = state.brush;
  const derived = brush.history.state();
  brush.strokes = derived.strokes;
  const algorithm = brush.open ? currentBrushAlgorithm() : (brush.algorithm || "brush");
  const count = derived.strokeCount + (brush.activeStroke ? 1 : 0);
  const hasChanges = Boolean(
    derived.invert || derived.denoise > 0 || derived.strokeCount || brush.activeStroke ||
    (brush.open && algorithm === "grabcut")
  );
  if (brush.open && !brush.loading) brush.dirty = hasChanges;
  setText(dom.brushCounts, count + " 笔 · " + (derived.pointCount +
    (brush.activeStroke ? brush.activeStroke.points.length : 0)) + " 点");
  setText(dom.brushStatus, brush.saving ? "正在提交…" : hasChanges ? "未保存" : "未修改");
  setDisabled(dom.brushSave,
    !brush.open || brush.loading || brush.saving || state.duplicateSwitching || !hasChanges || !brush.baseMask);
  setDisabled(dom.brushCancel, brush.saving || state.duplicateSwitching);
  setDisabled(dom.brushClose, brush.saving || state.duplicateSwitching);
  const canUndo = brush.open && !brush.loading && !brush.saving && !state.duplicateSwitching && brush.history.canUndo();
  const canRedo = brush.open && !brush.loading && !brush.saving && !state.duplicateSwitching && brush.history.canRedo();
  setDisabled(dom.brushUndo, !canUndo);
  setDisabled(dom.brushRedo, !canRedo);
  dom.brushUndo.title = canUndo
    ? brush.history.undoLabel() + "（Ctrl+Z）"
    : "没有可撤销的笔画或参数切换";
  dom.brushRedo.title = canRedo
    ? brush.history.redoLabel() + "（Ctrl+Shift+Z）"
    : "没有可重做的笔画";
  updateBrushAlgorithmUi();
}

function undoBrushAction() {
  const brush = state.brush;
  if (!brush.open || brush.loading || brush.saving) return;
  if (!brush.history.undo()) {
    showToast("没有可撤销的笔画或参数切换。", "info", 3200);
    return;
  }
  setError(dom.brushError, "");
  rebuildBrushMask();
  updateBrushControls();
}

function redoBrushAction() {
  const brush = state.brush;
  if (!brush.open || brush.loading || brush.saving) return;
  if (!brush.history.redo()) {
    showToast("没有可重做的笔画。", "info", 3200);
    return;
  }
  setError(dom.brushError, "");
  rebuildBrushMask();
  updateBrushControls();
}

function brushPointerDown(event) {
  const brush = state.brush;
  if (!brush.open || brush.loading || brush.saving || !brush.maskCanvas) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (brush.strokes.length >= 64) {
    showToast("最多 64 笔；请保存或取消本次修改后再继续。", "warning");
    return;
  }
  if (brushPointCount() >= 2048) {
    showToast("本轮已达到 2048 个点，请保存后继续。", "warning");
    return;
  }
  const point = canvasPoint(event);
  if (!point) return;
  event.preventDefault();
  brush.lastPointer = event;
  try {
    dom.brushCanvas.setPointerCapture(event.pointerId);
  } catch (_) {
    /* Pointer capture is an enhancement. */
  }
  brush.activeStroke = {
    pointerId: event.pointerId,
    mode: brush.mode,
    radius: brush.radius,
    points: [point]
  };
  const context = brush.maskCanvas.getContext("2d");
  drawBrushDot(context, point, brush.radius, brush.mode);
  brush.dirty = true;
  setError(dom.brushError, "");
  updateBrushCursor(event);
  scheduleBrushRender();
  updateBrushControls();
}

function brushPointerMove(event) {
  const brush = state.brush;
  if (!brush.open) return;
  brush.lastPointer = event;
  updateBrushCursor(event);
  const stroke = brush.activeStroke;
  if (!stroke || stroke.pointerId !== event.pointerId) return;
  const point = canvasPoint(event);
  if (!point) return;
  const previous = stroke.points[stroke.points.length - 1];
  if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.6) return;
  if (brushPointCount() >= 2048) {
    if (!brush.pointsWarned) {
      brush.pointsWarned = true;
      showToast("本轮已达到 2048 个点，请保存后继续。", "warning");
    }
    return;
  }
  event.preventDefault();
  stroke.points.push(point);
  const context = brush.maskCanvas.getContext("2d");
  drawBrushSegment(context, previous, point, stroke.radius, stroke.mode);
  scheduleBrushRender();
  updateBrushControls();
}

function finishBrushPointer(event, cancelled) {
  const brush = state.brush;
  const stroke = brush.activeStroke;
  if (!stroke || stroke.pointerId !== event.pointerId) return;
  brush.activeStroke = null;
  try {
    dom.brushCanvas.releasePointerCapture(event.pointerId);
  } catch (_) {
    /* ignore */
  }
  if (cancelled) {
    rebuildBrushMask();
    return;
  }
  if (!stroke.points.length) return;
  const pushed = brush.history.pushStroke({
    mode: stroke.mode,
    radius: stroke.radius,
    points: stroke.points
  });
  if (!pushed) {
    rebuildBrushMask();
    showToast("这一笔未能加入撤销历史，请重试。", "warning");
    return;
  }
  brush.strokes = brush.history.state().strokes;
  brush.dirty = true;
  brush.pointsWarned = false;
  updateBrushControls();
  if (brush.lastPointer) updateBrushCursor(brush.lastPointer);
}

function updateBrushMaskOption() {
  const brush = state.brush;
  if (!brush.open || !brush.baseMask) return;
  brush.history.pushOption({ invert: brush.invert, denoise: Number(brush.denoise) || 0 });
  brush.dirty = true;
  setError(dom.brushError, "");
  rebuildBrushMask();
}

function collectBrushPayload() {
  const brush = state.brush;
  if (!brush.source || !brush.mask) throw new ApiError("源图或蒙版已失效。", { status: 400 });
  const derived = brush.history.state();
  const strokes = derived.strokes.map((stroke) => ({
    mode: stroke.mode,
    radius: stroke.radius,
    points: stroke.points.map((point) => ({
      x: Math.round(point.x * 100) / 100,
      y: Math.round(point.y * 100) / 100
    }))
  }));
  return {
    source_rgb_asset_id: brush.source.asset_id,
    base_mask_asset_id: brush.mask.asset_id,
    algorithm: currentBrushAlgorithm(),
    iterations: clamp(integerValue(dom.brushIterations) || 5, 1, 10),
    invert: Boolean(derived.invert),
    denoise: Number(derived.denoise) || 0,
    strokes: strokes
  };
}

async function saveBrushMask() {
  const brush = state.brush;
  if (state.duplicateSwitching) {
    showToast("正在切换已有版本，请稍候。", "warning");
    return;
  }
  if (!brush.open || brush.saving || brush.loading || !brush.dirty || !brush.baseMask) return;
  if (brush.activeStroke) {
    showToast("请先松开画笔，再保存。", "warning");
    return;
  }
  if (brush.strokes.length > 64 || brushPointCount() > 2048) {
    setError(dom.brushError, "笔画或点数超过限制，请取消本次修改后重试。");
    return;
  }
  let payload;
  try {
    payload = collectBrushPayload();
  } catch (error) {
    setError(dom.brushError, friendlyError(error));
    return;
  }
  if (payload.algorithm === "grabcut") {
    // GrabCut treats strokes as hard seeds; never present the local stroke
    // overlay as the final segmentation. The generated mask is a preview that
    // the user must inspect and apply explicitly.
    brush.saving = true;
    setError(dom.brushError, "");
    updateBrushControls();
    const started = await startPreviewRequest({
      ok: true,
      path: "/jobs/refine-mask",
      label: "蒙版细化",
      kind: "refine_mask",
      targetAssetId: payload.source_rgb_asset_id,
      baseAssetId: payload.base_mask_asset_id,
      payload: payload
    });
    brush.saving = false;
    if (started) {
      brush.dirty = false;
      closeBrushEditor(true);
    } else {
      updateBrushControls();
    }
    return;
  }
  if (state.previewSession.current()) {
    // A new mask revision supersedes any unapplied preview bound to an older one.
    await discardPreview({ silent: true });
  }
  const bodyText = JSON.stringify(payload);
  brush.saving = true;
  setError(dom.brushError, "");
  updateBrushControls();
  const started = startSubmission({
    path: "/jobs/refine-mask",
    method: "POST",
    label: "保存前景蒙版",
    bodyFactory: () => bodyText,
    onSuccess: async (data) => {
      const job = extractJobFromResponse(data);
      if (!job) throw new ApiError("蒙版任务响应缺少编号。", { status: 202 });
      state.submissionSnapshots.set(job.job_id, state.lastCommittedSnapshot || captureWorkspace());
      brush.saving = false;
      brush.dirty = false;
      closeBrushEditor(true);
      await adoptJob(job, { announce: false });
      showToast("蒙版修正已提交，完成后会生成新的蒙版与透明图。", "success", 5500);
    },
    onError: (error) => {
      brush.saving = false;
      setError(dom.brushError, "蒙版未提交：" + friendlyError(error));
      updateBrushControls();
      showToast("蒙版未提交：" + friendlyError(error), "error", 6000);
    },
    onUnknown: () => {
      brush.saving = false;
      closeBrushEditor(true);
      showToast("蒙版提交结果未知。请用页面顶部的相同请求重试。", "warning", 7000);
    }
  });
  if (!started) {
    brush.saving = false;
    updateBrushControls();
  }
}

/* -------------------------------------------------------------------------- */
/* Downloads and comparison                                                   */
/* -------------------------------------------------------------------------- */

function filenameFromDisposition(header) {
  if (!header) return "";
  const value = String(header);
  const encoded = value.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  if (encoded && encoded[1]) {
    try {
      return sanitizeFilename(decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, "")));
    } catch (_) {
      return sanitizeFilename(encoded[1].trim().replace(/^"|"$/g, ""));
    }
  }
  const simple = value.match(/filename\s*=\s*"([^"]+)"/i) || value.match(/filename\s*=\s*([^;]+)/i);
  return simple && simple[1] ? sanitizeFilename(simple[1].trim()) : "";
}

function sanitizeFilename(name) {
  const cleaned = String(name || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.slice(0, 140) || "";
}

function fallbackFilename(asset) {
  const label = assetDisplayName(asset).replace(/[\\/:*?"<>|\s]+/g, "_");
  const id = shortId(asset && asset.asset_id);
  let extension = "bin";
  if (assetIsArchive(asset)) extension = "zip";
  else if (assetIsSvg(asset)) extension = "svg";
  else if (assetMime(asset).includes("jpeg")) extension = "jpg";
  else if (assetMime(asset).includes("png") || !assetMime(asset)) extension = "png";
  return (label || "pattern") + "_" + id + "." + extension;
}

async function downloadAsset(asset, trigger) {
  if (!asset) return;
  const button = trigger || null;
  const previousDisabled = button ? button.disabled : false;
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  }
  try {
    const response = await fetchLocal("/assets/" + encodeURIComponent(asset.asset_id) + "/download", {
      headers: { "Accept": "application/octet-stream" }
    });
    if (!response.ok) {
      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }
      throw apiErrorFromPayload(data, response.status);
    }
    const blob = await response.blob();
    if (!blob.size) throw new ApiError("下载内容为空。", { status: response.status });
    const filename = filenameFromDisposition(response.headers.get("content-disposition")) || fallbackFilename(asset);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast("已开始下载 " + filename, "success", 3500);
  } catch (error) {
    showToast("下载失败：" + friendlyError(error), "error", 6000);
  } finally {
    if (button) {
      button.disabled = previousDisabled;
      button.removeAttribute("aria-busy");
    }
  }
}

function closeCompareIfOpen() {
  if (dom.compareDialog.open) dom.compareDialog.close();
}

async function openCompare() {
  const current = currentAsset();
  const target = previewAsset();
  if (!current || !target) {
    showToast("需要当前输入和一个成果版本才能对比。", "warning");
    return;
  }
  if (current.asset_id === target.asset_id) {
    showToast("画布就是当前输入，无需对比。", "info");
    return;
  }
  dom.compareGrid.replaceChildren();
  dom.compareDialog.showModal();
  dom.closeCompare.focus();
  const left = buildComparePane("当前输入", current, true);
  const right = buildComparePane("选中版本", target, false);
  dom.compareGrid.append(left.pane, right.pane);
  await Promise.all([
    fillComparePane(left, current),
    fillComparePane(right, target)
  ]);
}

function buildComparePane(title, asset, isCurrent) {
  const pane = element("section", "compare-pane");
  const head = element("div", "compare-pane-head");
  const strong = element("strong", "", title);
  const meta = element("span", "", assetDisplayName(asset) + " · #" + shortId(asset.asset_id));
  head.append(strong, meta);
  const wrap = element("div", "compare-image-wrap");
  const spinner = element("span", "spinner");
  spinner.setAttribute("aria-label", "正在加载预览");
  wrap.append(spinner);
  const foot = element("div", "compare-pane-foot");
  const download = element("button", "btn btn-outline btn-xs");
  download.type = "button";
  download.append(icon("download"));
  download.append(document.createTextNode("下载"));
  download.addEventListener("click", () => void downloadAsset(asset, download));
  foot.append(download);
  pane.append(head, wrap, foot);
  return { pane: pane, wrap: wrap, asset: asset, isCurrent: isCurrent };
}

async function fillComparePane(pane, asset) {
  try {
    const url = await getPreviewUrl(asset.asset_id);
    if (!dom.compareDialog.open) return;
    const image = element("img");
    image.alt = (pane.isCurrent ? "当前输入 " : "选中版本 ") + assetDisplayName(asset);
    image.src = url;
    pane.wrap.replaceChildren(image);
  } catch (error) {
    if (!dom.compareDialog.open) return;
    const errorNode = element("div", "compare-error", "预览加载失败：" + friendlyError(error));
    pane.wrap.replaceChildren(errorNode);
  }
}

/* -------------------------------------------------------------------------- */
/* History drawer                                                             */
/* -------------------------------------------------------------------------- */

function openHistory() {
  if (state.historyOpen) return;
  state.historyOpen = true;
  state.historyLastFocus = document.activeElement;
  state.historyCloseSeq += 1;
  dom.historyScrim.hidden = false;
  dom.historyDrawer.hidden = false;
  dom.appView.inert = true;
  document.body.classList.add("drawer-open");
  window.requestAnimationFrame(() => {
    if (!state.historyOpen) return;
    dom.historyScrim.classList.add("is-open");
    dom.historyDrawer.classList.add("is-open");
  });
  dom.closeHistory.focus();
  loadHistory(true);
}

function closeHistory(options) {
  const opts = options || {};
  if (!state.historyOpen && dom.historyDrawer.hidden) return;
  state.historyOpen = false;
  state.historyCloseSeq += 1;
  const seq = state.historyCloseSeq;
  dom.historyScrim.classList.remove("is-open");
  dom.historyDrawer.classList.remove("is-open");
  dom.appView.inert = false;
  document.body.classList.remove("drawer-open");
  if (opts.restoreFocus !== false && state.historyLastFocus && typeof state.historyLastFocus.focus === "function") {
    try {
      state.historyLastFocus.focus();
    } catch (_) {
      /* ignore */
    }
  }
  if (opts.immediate) {
    dom.historyScrim.hidden = true;
    dom.historyDrawer.hidden = true;
  } else {
    window.setTimeout(() => {
      if (seq !== state.historyCloseSeq || state.historyOpen) return;
      dom.historyScrim.hidden = true;
      dom.historyDrawer.hidden = true;
    }, 210);
  }
}

async function loadHistory(reset) {
  if (state.history.loading) return;
  const loadReset = Boolean(reset);
  const sequence = state.history.seq + 1;
  state.history.seq = sequence;
  state.history.loading = true;
  state.history.error = "";
  if (loadReset) {
    state.history.items = [];
    state.history.nextCursor = null;
  }
  renderHistory();

  const params = new URLSearchParams();
  params.set("limit", "20");
  if (!loadReset && state.history.nextCursor) params.set("cursor", state.history.nextCursor);
  try {
    const result = await requestJson("/jobs?" + params.toString());
    if (sequence !== state.history.seq) return;
    const data = result.data || {};
    const items = Array.isArray(data.items) ? data.items : [];
    const existing = loadReset ? [] : state.history.items;
    const byId = new Map(existing.map((job) => [jobIdOf(job), job]));
    for (const item of items) {
      const normalized = normalizeJob(item);
      if (normalized) byId.set(normalized.job_id, normalized);
    }
    state.history.items = Array.from(byId.values());
    state.history.nextCursor = data.next_cursor || null;
    state.history.error = "";
  } catch (error) {
    if (sequence !== state.history.seq) return;
    state.history.error = friendlyError(error);
  } finally {
    if (sequence === state.history.seq) {
      state.history.loading = false;
      renderHistory();
    }
  }
}

function renderHistory() {
  const history = state.history;
  setText(
    dom.historySummary,
    history.loading
      ? "正在读取本机历史…"
      : history.items.length
        ? "已载入 " + history.items.length + " 条任务"
        : "尚无任务"
  );
  setDisabled(dom.refreshHistory, history.loading);
  dom.historyList.replaceChildren();

  if (history.loading && !history.items.length) {
    const loading = element("div", "history-loading");
    const stack = element("div", "skeleton-stack");
    stack.append(element("div", "skeleton"), element("div", "skeleton"), element("div", "skeleton"));
    loading.append(stack);
    dom.historyList.append(loading);
    setHidden(dom.historyMore, true);
    return;
  }

  if (history.error && !history.items.length) {
    const errorBox = element("div", "history-empty");
    errorBox.append(icon("alert", "empty-mark"));
    errorBox.append(element("h3", "", "历史读取失败"));
    errorBox.append(element("p", "", history.error));
    const retry = element("button", "btn btn-outline btn-sm", "重新读取");
    retry.type = "button";
    retry.addEventListener("click", () => void loadHistory(true));
    errorBox.append(retry);
    dom.historyList.append(errorBox);
    setHidden(dom.historyMore, true);
    return;
  }

  if (!history.items.length) {
    const empty = element("div", "history-empty");
    empty.append(icon("history", "empty-mark"));
    empty.append(element("h3", "", "还没有历史任务"));
    empty.append(element("p", "", "上传图片并运行本地操作后，任务会持久化在这里。失败与中断也会如实保留。"));
    dom.historyList.append(empty);
    setHidden(dom.historyMore, true);
    return;
  }

  if (history.error) {
    const warning = element("p", "history-error", "本次刷新失败：" + history.error);
    dom.historyList.append(warning);
  }

  for (const job of history.items) {
    dom.historyList.append(buildHistoryItem(job));
  }
  setHidden(dom.historyMore, !history.nextCursor);
  setDisabled(dom.historyMore, history.loading);
  setText(dom.historyMore, history.loading ? "读取中…" : "加载更多");
}

function buildHistoryItem(job) {
  const item = element("article", "history-item");
  const top = element("div", "history-item-top");
  const titleWrap = element("div", "history-item-title");
  const kindRow = element("div", "history-kind");
  kindRow.append(element("span", "", jobLabel(job.kind)));
  if (job.ai_pipeline_id) kindRow.append(element("span", "mini-badge is-ai", "AI 流程"));
  if (isRepairJobKind(job.kind)) kindRow.append(element("span", "mini-badge is-ai", "AI 修复"));
  if (isTileJobKind(job.kind)) kindRow.append(element("span", "mini-badge", "手动平铺"));
  const jobState = String(job.state || "").toLowerCase();
  const status = element("span", "status-pill is-" + jobState, stateLabel(job.state));
  kindRow.append(status);
  titleWrap.append(kindRow);
  titleWrap.append(element("div", "history-item-meta",
    "#" + shortId(job.job_id) + " · " + formatTime(job.finished_at || job.updated_at || job.created_at) +
    (job.retry_of ? " · 重试自 #" + shortId(job.retry_of) : "")));
  const summary = summarizeJob(job);
  if (summary) titleWrap.append(element("div", "history-summary", summary));
  if (job.error && (job.error.message || job.error.code)) {
    titleWrap.append(element("div", "history-error", job.error.message || "任务失败，可重试。"));
  }
  top.append(titleWrap);
  item.append(top);

  const actions = element("div", "history-actions");
  const blocked = state.taskRunning || state.requestInFlight || Boolean(state.pendingSubmission);
  const restore = element("button", "btn btn-outline", "恢复");
  restore.type = "button";
  restore.dataset.historyAction = "restore";
  restore.dataset.jobId = job.job_id;
  restore.disabled = blocked;
  restore.title = blocked ? "当前有任务或提交处理中，完成后再恢复。" : "恢复此任务的工作区";
  actions.append(restore);

  if (job.state === "failed" && jobAllowsRetry(job)) {
    const retry = element("button", "btn btn-quiet", "重试");
    retry.type = "button";
    retry.dataset.historyAction = "retry";
    retry.dataset.jobId = job.job_id;
    retry.disabled = blocked;
    retry.title = blocked ? "当前有任务或提交处理中，完成后再重试。" : "创建新的重试任务，旧记录不变";
    actions.append(retry);
  }
  if (isJobEnded(job)) {
    const evaluate = element("button", "btn btn-ghost", "评价");
    evaluate.type = "button";
    evaluate.dataset.historyAction = "evaluate";
    evaluate.dataset.jobId = job.job_id;
    evaluate.disabled = state.requestInFlight || Boolean(state.pendingSubmission);
    actions.append(evaluate);
  }
  item.append(actions);
  return item;
}

function summarizeJob(job) {
  const params = job && job.parameters && typeof job.parameters === "object" ? job.parameters : {};
  const kind = normalizeKind(job && job.kind);
  const pieces = [];
  if (kind === "crop" && params.bbox) {
    pieces.push("框选 " + formatBbox(params.bbox));
  } else if (kind === "prepare") {
    pieces.push("逆时针 " + Number(params.rotation || 0) + "°");
    pieces.push("纠偏 " + Number(params.straighten || 0).toFixed(1) + "°");
    pieces.push("新坐标系 · 旧框选失效");
  } else if (kind === "working_copy") {
    if (params.max_pixels) pieces.push("上限 " + Number(params.max_pixels).toLocaleString("zh-CN") + " px");
  } else if (kind === "enhance") {
    pieces.push(describeEnhanceParams(params));
  } else if (kind === "extract") {
    pieces.push(describeExtractParams(params));
  } else if (kind === "vectorize") {
    pieces.push(vectorSummary(params));
  } else if (kind === "recolor_svg") {
    const count = params.mapping && typeof params.mapping === "object" ? Object.keys(params.mapping).length : 0;
    pieces.push("颜色替换 " + count + " 项");
  } else if (kind === "pipeline") {
    if (params.extract) pieces.push(describeExtractParams(params.extract));
    if (params.vector) pieces.push(vectorSummary(params.vector));
    if (params.enhance) pieces.push(describeEnhanceParams(params.enhance));
    else pieces.push("跳过轻增强");
    pieces.push("不隐式缩小");
  } else if (kind === "export") {
    const count = Array.isArray(params.asset_ids) ? params.asset_ids.length : null;
    if (count !== null) pieces.push("选中 " + count + " 个版本");
  } else if (kind === "refine_mask") {
    if (params.algorithm === "grabcut") {
      pieces.push("GrabCut 细化 · 迭代 " + Number(params.iterations || 5));
    } else {
      pieces.push("逐笔直接");
    }
    if (Array.isArray(params.strokes)) pieces.push(params.strokes.length + " 笔");
    if (params.invert) pieces.push("反相");
    if (params.denoise) pieces.push(params.denoise === 1 ? "3×3 去噪" : "5×5 去噪");
  } else if (isRepairJobKind(kind)) {
    pieces.push(REPAIR_INTENTS[params.intent] || REPAIR_INTENTS.restore_small_gap);
    if (params.bbox) pieces.push("框选 " + formatBbox(params.bbox));
    pieces.push("羽化 " + Number(params.feather_px || 0) + " px");
    pieces.push(String(params.size || "1K"));
    pieces.push(params.provider_call_id ? "归档复用" : "新生成");
  } else if (isTileJobKind(kind)) {
    pieces.push(Number(params.rows || 2) + " × " + Number(params.cols || 2));
    pieces.push(SEAM_LABELS[params.seam_observation] || SEAM_LABELS.not_reviewed);
    pieces.push("整数复制 · 不自动消缝");
  }
  if (job.ai_pipeline_id) pieces.push("AI 候选确认");
  if (job.result && Array.isArray(job.result.assets)) pieces.push(job.result.assets.length + " 个成果");
  return pieces.filter(Boolean).join(" · ");
}

function formatBbox(bbox) {
  if (!bbox) return "—";
  return "[" + bbox.left + ", " + bbox.top + ", " + bbox.right + ", " + bbox.bottom + ")";
}

function vectorSummary(params) {
  const modeLabels = { monochrome: "黑白", color: "彩色" };
  const detailLabels = { low: "低", medium: "中", high: "高" };
  const bits = [
    modeLabels[params.mode] || params.mode || "SVG",
    params.max_colors !== undefined ? params.max_colors + " 色" : "",
    params.detail ? detailLabels[params.detail] || params.detail : ""
  ];
  if (Number.isFinite(params.length_threshold)) bits.push("长度 " + params.length_threshold);
  if (Number.isFinite(params.corner_threshold)) bits.push("角点 " + params.corner_threshold);
  if (Number.isFinite(params.splice_threshold)) bits.push("拼接 " + params.splice_threshold);
  return bits.filter(Boolean).join(" · ");
}

function findHistoryJob(jobId) {
  return state.history.items.find((job) => jobIdOf(job) === jobId) || null;
}

async function restoreJob(jobId) {
  if (!jobId) return;
  if (state.duplicateSwitching) {
    showToast("正在切换已有版本，完成后再恢复历史。", "warning");
    return;
  }
  if (state.taskRunning) {
    showToast("当前有任务正在处理，完成后再恢复历史。", "warning");
    return;
  }
  if (state.pendingSubmission || state.requestInFlight) {
    showToast("请先处理当前提交，再恢复历史。", "warning");
    return;
  }
  if (!(await guardPendingPreview("恢复历史任务"))) return;
  if (!(await guardUnsavedBrush("恢复历史任务"))) return;
  if (!(await guardUnsavedBBox("恢复历史任务"))) return;

  let latest;
  try {
    const result = await requestJson("/jobs/" + encodeURIComponent(jobId));
    latest = normalizeJob(result.data && result.data.job ? result.data.job : result.data);
    if (!latest) throw new ApiError("历史任务响应缺少 job_id。", { status: 200 });
  } catch (error) {
    showToast("无法恢复历史：" + friendlyError(error), "error");
    return;
  }

  closeHistory({ restoreFocus: false, immediate: true });
  clearBBox();
  resetWorkspace({ clearUpload: true });
  state.sourceLabel = "历史任务 #" + shortId(latest.job_id);
  state.sourceNote = "";

  const context = jobContext(latest);
  let inputAsset = null;
  if (latest.input_asset_id) {
    try {
      const hydrated = await hydrateAsset(latest.input_asset_id, Object.assign({}, context, { origin: "history_input" }));
      if (hydrated) {
        inputAsset = hydrated;
        await registerAssets([hydrated], { context: Object.assign({}, context, { origin: "history_input" }), prepend: false });
      }
    } catch (error) {
      showToast("历史输入资产读取失败：" + friendlyError(error), "warning");
    }
  }

  const result = latest.result && typeof latest.result === "object" ? latest.result : {};
  const rawResults = Array.isArray(result.assets) ? result.assets : [];
  let resultAssets = [];
  if (rawResults.length) {
    try {
      resultAssets = await registerAssets(rawResults, { context: context, prepend: true });
    } catch (error) {
      showToast("历史成果读取失败：" + friendlyError(error), "warning");
    }
  }

  if (inputAsset && assetIsInputCapable(inputAsset)) {
    state.currentInputId = inputAsset.asset_id;
    state.sourceNote = inputAsset.source_note || "";
    state.currentHasTransparency = Boolean(
      inputAsset.normalization && inputAsset.normalization.has_transparency === true
    );
    const originalWidth = Number(inputAsset.original_width || inputAsset.source_width || 0);
    const originalHeight = Number(inputAsset.original_height || inputAsset.source_height || 0);
    state.sourceOriginal = originalWidth > 0 && originalHeight > 0
      ? { width: originalWidth, height: originalHeight, assetId: inputAsset.asset_id }
      : null;
  }

  let target = findSvgAsset(resultAssets, latest) || findTransparentAsset(resultAssets) ||
    resultAssets.find((asset) => assetIsInputCapable(asset)) || null;
  if (isRepairJobKind(latest.kind) && inputAsset) target = inputAsset;
  if (isTileJobKind(latest.kind) && inputAsset) target = inputAsset;
  if (!target && inputAsset) target = inputAsset;
  if (target && assetIsPreviewable(target)) state.previewId = target.asset_id;
  if (!state.currentInputId && target && assetIsInputCapable(target)) state.currentInputId = target.asset_id;
  if (!state.previewId && state.currentInputId) state.previewId = state.currentInputId;

  state.activeJobId = latest.job_id;
  state.tasks.set(latest.job_id, Object.assign({}, latest, {
    _registeredAssets: resultAssets.map((asset) => asset.asset_id)
  }));
  assignFeedbackJob(isJobEnded(latest) ? latest.job_id : null);
  state.taskRunning = isJobActive(latest);
  restoreParameters(latest);
  state.extractModeAutoSet = false;
  state.paramsRevision = 1;
  resetEditHistory();
  renderAll();
  renderFeedback();
  if (state.previewId) await loadPreview();
  if (isJobActive(latest)) {
    state.submissionSnapshots.set(latest.job_id, captureWorkspace());
    scheduleJobPoll(latest.job_id, 900);
  }
  if (latest.ai_pipeline_id) {
    await restoreAiPipelineById(latest.ai_pipeline_id);
  }
  if (isRepairJobKind(latest.kind)) {
    await restoreRepairForJob(latest.job_id);
  }
  if (isTileJobKind(latest.kind)) {
    await restoreTileFromJob(latest);
  }
  showToast("已恢复历史任务 #" + shortId(latest.job_id) + " 的输入、参数与可见成果。", "success", 5500);
}

async function restoreAiPipelineById(pipelineId) {
  try {
    const result = await requestJson("/pipelines/" + encodeURIComponent(pipelineId));
    const pipeline = normalizeAiPipeline(result.data && result.data.pipeline ? result.data.pipeline : result.data);
    if (!pipeline) throw new ApiError("AI 流程状态无法识别。", { status: result.status });
    await adoptAiPipeline(pipeline, { announce: false });
    showToast("已恢复 AI 候选的确认状态。", "info", 4500);
  } catch (error) {
    showToast("历史中的 AI 候选状态读取失败：" + friendlyError(error), "warning", 6000);
  }
}

function jobAllowsRetry(job) {
  if (!job) return false;
  if (String(job.state || "").toLowerCase() === "cancelled") return false;
  if (job.ai_pipeline_id) return false;
  const kind = normalizeKind(job.kind);
  if (isRepairJobKind(kind)) {
    const params = job.parameters && typeof job.parameters === "object" ? job.parameters : {};
    return Boolean(params.provider_call_id);
  }
  return !(kind.includes("decompos") || kind.includes("compose") || kind.startsWith("ai_"));
}

function restoreParameters(job) {
  const params = job && job.parameters && typeof job.parameters === "object" ? job.parameters : {};
  const kind = normalizeKind(job.kind);
  let extract = null;
  let vector = null;
  let enhance = null;
  if (kind === "pipeline") {
    extract = params.extract || null;
    vector = params.vector || null;
    enhance = params.enhance || null;
    dom.includeEnhance.checked = Boolean(params.enhance);
  } else if (kind === "extract") {
    extract = params;
  } else if (kind === "vectorize") {
    vector = params;
  } else if (kind === "enhance" || kind === "enhanced") {
    enhance = params;
  } else if (kind === "prepare") {
    if ([0, 90, 180, 270].includes(Number(params.rotation))) {
      dom.prepareRotation.value = String(params.rotation);
    }
    if (Number.isFinite(params.straighten)) {
      dom.straightenValue.value = String(params.straighten);
    }
  } else if (kind === "recolor_svg") {
    state.recolor.assetId = String(job.input_asset_id || "");
    state.recolor.signature = "";
    renderRecolorPanel(true);
    const mapping = params.mapping && typeof params.mapping === "object" ? params.mapping : {};
    for (const row of dom.recolorList.querySelectorAll(".recolor-row")) {
      const source = String(row.dataset.source || "").toUpperCase();
      const target = mapping[source] || mapping[source.toLowerCase()];
      if (!target) continue;
      const enable = row.querySelector(".recolor-enable");
      const input = row.querySelector(".recolor-target");
      if (enable) enable.checked = true;
      if (input) {
        input.disabled = false;
        input.value = String(target).toUpperCase();
      }
    }
    updateRecolorActions();
  }

  if (extract) {
    if (EXTRACT_MODES.includes(extract.mode)) setRadio("extract-mode", extract.mode);
    if (["dark", "light"].includes(extract.polarity)) setRadio("polarity", extract.polarity);
    if (Number.isInteger(extract.threshold)) dom.thresholdValue.value = String(extract.threshold);
    if (Number.isInteger(extract.iterations)) dom.iterations.value = String(extract.iterations);
    if (Number.isInteger(extract.window_size)) dom.windowSize.value = String(extract.window_size);
    if (Number.isFinite(extract.offset)) dom.offsetValue.value = String(extract.offset);
    if (dom.extractClahe) dom.extractClahe.checked = Boolean(extract.clahe);
    if (Number.isInteger(extract.min_component_area)) dom.minComponentArea.value = String(extract.min_component_area);
    if (Number.isInteger(extract.max_hole_area)) dom.maxHoleArea.value = String(extract.max_hole_area);
  }
  if (vector) {
    if (["monochrome", "color"].includes(vector.mode)) setRadio("vector-mode", vector.mode);
    if ([2, 4, 8, 16].includes(Number(vector.max_colors))) setRadio("max-colors", String(vector.max_colors));
    if (["low", "medium", "high"].includes(vector.detail)) setRadio("vector-detail", vector.detail);
    dom.vectorLength.value = Number.isFinite(vector.length_threshold) ? String(vector.length_threshold) : "";
    dom.vectorCorner.value = Number.isFinite(vector.corner_threshold) ? String(vector.corner_threshold) : "";
    dom.vectorSplice.value = Number.isFinite(vector.splice_threshold) ? String(vector.splice_threshold) : "";
  }
  if (enhance) {
    if (Number.isFinite(enhance.brightness)) dom.brightnessValue.value = String(enhance.brightness);
    if (Number.isFinite(enhance.contrast)) dom.contrastValue.value = String(enhance.contrast);
    if ([0, 1, 2].includes(Number(enhance.denoise))) dom.denoise.value = String(enhance.denoise);
    if (Number.isFinite(enhance.sharpen)) dom.sharpenValue.value = String(enhance.sharpen);
  }

  if (isRepairJobKind(kind)) {
    if (Object.prototype.hasOwnProperty.call(REPAIR_INTENTS, params.intent)) {
      setRadio("repair-intent", params.intent);
    }
    if (Number.isInteger(params.feather_px) && params.feather_px >= 0 && params.feather_px <= 64) {
      dom.repairFeather.value = String(params.feather_px);
    }
    if (["1K", "1.5K", "2K"].includes(params.size)) dom.repairSize.value = params.size;
    dom.repairCallId.value = params.provider_call_id ? String(params.provider_call_id) : "";
    state.repair.damageId = params.damage_mask_asset_id ? String(params.damage_mask_asset_id) : "";
    if (params.damage_mask_asset_id) {
      const exists = Array.from(dom.repairDamageMask.options).some((option) => option.value === params.damage_mask_asset_id);
      dom.repairDamageMask.value = exists ? String(params.damage_mask_asset_id) : "";
    }
  }
  if (isTileJobKind(kind)) {
    if ([2, 3].includes(Number(params.rows))) state.tile.rows = Number(params.rows);
    if ([2, 3].includes(Number(params.cols))) state.tile.cols = Number(params.cols);
    if (SEAM_LABELS[params.seam_observation]) state.tile.seamObservation = params.seam_observation;
  }

  const bbox = (params.bbox || (extract && extract.bbox)) || null;
  if (bbox && validBboxForAsset(bbox, currentAsset())) {
    state.bbox = {
      left: Number(bbox.left),
      top: Number(bbox.top),
      right: Number(bbox.right),
      bottom: Number(bbox.bottom)
    };
    state.bboxDirty = false;
    fillBboxInputs(state.bbox);
  } else {
    state.bbox = null;
    state.bboxDirty = false;
    fillBboxInputs(null);
  }
  if (kind === "working_copy" && Number.isInteger(params.max_pixels)) {
    dom.workingMax.value = String(clamp(params.max_pixels, WORKING_COPY_MIN, WORKING_COPY_MAX));
  }
  syncPairedControlValues();
  updateComposeSummary();
  renderBboxOverlay();
  renderBboxControls();
}

function syncPairedControlValues() {
  const threshold = integerValue(dom.thresholdValue);
  if (threshold !== null && threshold >= 0 && threshold <= 255) dom.thresholdRange.value = String(threshold);
  const brightness = numberValue(dom.brightnessValue, NaN);
  if (Number.isFinite(brightness)) {
    dom.brightnessRange.value = String(clamp(brightness, ENHANCE_LIMITS.brightness.min, ENHANCE_LIMITS.brightness.max));
  }
  const contrast = numberValue(dom.contrastValue, NaN);
  if (Number.isFinite(contrast)) {
    dom.contrastRange.value = String(clamp(contrast, ENHANCE_LIMITS.contrast.min, ENHANCE_LIMITS.contrast.max));
  }
  const sharpen = numberValue(dom.sharpenValue, NaN);
  if (Number.isFinite(sharpen)) dom.sharpenRange.value = String(clamp(sharpen, 0, 1));
  const windowSize = integerValue(dom.windowSize);
  if (windowSize !== null && windowSize >= 3 && windowSize <= 255) dom.windowRange.value = String(windowSize);
  const offset = numberValue(dom.offsetValue, NaN);
  if (Number.isFinite(offset)) dom.offsetRange.value = String(clamp(offset, -50, 50));
  const straighten = numberValue(dom.straightenValue, NaN);
  if (Number.isFinite(straighten)) dom.straightenRange.value = String(clamp(straighten, -15, 15));
}

/* -------------------------------------------------------------------------- */
/* Render orchestration and availability                                      */
/* -------------------------------------------------------------------------- */

function renderAll() {
  renderFileSummary();
  renderQuality();
  renderDuplicateBanner();
  renderVersions();
  renderCurrentInfo();
  renderBboxOverlay();
  renderBboxControls();
  renderTask();
  renderFeedback();
  renderAiPanel();
  renderMaskPanel();
  renderRepairPanel();
  renderTilePanel();
  renderWorkingProjection();
  renderPendingBanner();
  updateComposeSummary();
  updateActionState();
}

function assignFeedbackJob(jobId) {
  if (state.feedbackJobId === jobId) return;
  state.feedbackJobId = jobId || null;
  if (jobId) resetFeedbackForm();
}

function updateActionState() {
  const writeReason = state.duplicateSwitching
    ? "正在切换已有版本，请稍候。"
    : state.requestInFlight
      ? "正在提交，请稍候。"
      : state.cancelBusy
        ? "正在请求取消，等待服务端终态。"
        : state.pendingSubmission
          ? "请先处理结果未知的提交。"
          : state.taskRunning
            ? "任务处理中，完成后再继续。"
            : "";
  const processReason = currentProcessBlock();
  const asset = currentAsset();
  const previewCurrent = isPreviewCurrent();
  const tooLarge = Boolean(asset && assetPixels(asset) > PROCESS_PIXEL_LIMIT);
  const hasBbox = Boolean(state.bbox && validBboxForAsset(state.bbox, asset));
  const extractMode = checkedValue("extract-mode");

  setDisabled(dom.uploadSubmit, !state.uploadFile || Boolean(writeReason));
  setDisabled(dom.duplicateUse, Boolean(duplicateSwitchBlockReason()));

  const oneClickGrabcutMissing = extractMode === "grabcut" && !hasBbox;
  setDisabled(dom.oneclickButton, Boolean(processReason) || oneClickGrabcutMissing);
  setDisabled(dom.extractButton, Boolean(processReason) || oneClickGrabcutMissing);
  setDisabled(dom.vectorButton, Boolean(processReason));
  setDisabled(dom.enhanceButton, Boolean(processReason));
  const prepareOutput = preparePrediction();
  const prepareBlocked = Boolean(asset) && (!prepareOutput || prepareOutput.overLimit);
  setDisabled(dom.prepareButton, Boolean(processReason) || prepareBlocked);
  if (prepareBlocked) {
    dom.prepareButton.title = !prepareOutput
      ? "当前角度或输入无效，无法预估准备输出"
      : "准备输出超过本地 1,000,000 像素上限，请先创建工作副本或减小纠偏角度";
  }
  setDisabled(dom.cropButton, Boolean(processReason) || !hasBbox);
  setDisabled(dom.bboxFull, Boolean(writeReason) || !asset || !previewCurrent);
  setDisabled(dom.bboxCancel, Boolean(writeReason) || !asset || !previewCurrent || (!state.bbox && !state.bboxDirty));
  setDisabled(dom.exportButton, Boolean(writeReason) || state.selectedAssetIds.size === 0);
  setDisabled(dom.clearSelection, state.selectedAssetIds.size === 0);
  setDisabled(dom.compareButton, !asset || !previewAsset() || asset.asset_id === previewAsset().asset_id);
  const activeTask = state.activeJobId ? state.tasks.get(state.activeJobId) : null;
  const cancelState = cancelEligibility(activeTask);
  setDisabled(dom.taskRetry, state.requestInFlight || Boolean(state.pendingSubmission) || !activeTask ||
    String(activeTask.state || "").toLowerCase() !== "failed" || !jobAllowsRetry(activeTask));
  setHidden(dom.taskCancel, !activeTask || !isJobActive(activeTask));
  setDisabled(dom.taskCancel, state.cancelBusy || state.requestInFlight || !cancelState.supported);
  setText(dom.taskCancel, state.cancelBusy ? "正在取消…" : "取消任务");
  dom.taskCancel.title = cancelState.supported
    ? "请求停止这次本地处理；取消后恢复处理起点"
    : cancelState.reason;
  setHidden(dom.taskCancelNote, !state.cancelNote);
  setText(dom.taskCancelNote, state.cancelNote);
  setDisabled(dom.taskPoll, state.requestInFlight);
  setDisabled(dom.feedbackSubmit, !feedbackCanSubmit());

  const working = validateWorkingCopyTarget(false);
  setDisabled(dom.workingCopyButton, Boolean(writeReason) || !asset || !previewCurrent || !working.ok);

  const aiPipeline = state.ai.pipeline;
  const aiStateName = String((aiPipeline && aiPipeline.state) || "").toLowerCase();
  const aiWaiting = aiStateName === "waiting_user";
  const aiFailed = aiStateName === "failed";
  const aiSelectable = aiWaiting || aiFailed || aiStateName === "succeeded";
  setDisabled(dom.refreshAiStatus, state.ai.statusLoading);
  setDisabled(dom.aiRefreshPipeline, Boolean(writeReason));
  setDisabled(dom.aiCompose, Boolean(writeReason) || !aiWaiting || state.ai.selectedLayerIds.size === 0);
  setDisabled(dom.aiUseLocal, Boolean(writeReason) || !(aiWaiting || aiFailed));
  setDisabled(dom.aiReject, Boolean(writeReason) || !aiWaiting);
  const aiRevision = Number(aiPipeline && aiPipeline.revision);
  const aiRerunBlocked = Boolean(writeReason) || !aiPipeline || isAiActive(aiPipeline) ||
    !Number.isInteger(aiRevision) || aiRevision < 1;
  const aiTrace = aiPipeline ? normalizeWorkflowTrace(aiPipeline) : null;
  const aiCanCompose = !aiTrace || !aiTrace.recovery || aiTrace.recovery.canCompose !== false;
  const aiRerunCandidates = aiPipeline ? aiVectorCandidates(aiPipeline) : [];
  const aiRerunAssetReady = aiRerunCandidates.some((asset) => assetIdOf(asset) === dom.aiRerunInput.value);
  const aiLayerCount = state.ai.layers && Array.isArray(state.ai.layers.layers) ? state.ai.layers.layers.length : 0;
  const aiSelectedCount = state.ai.selectedLayerIds.size;
  setDisabled(dom.aiRerunCompose, aiRerunBlocked || !(aiCanCompose && aiLayerCount && aiSelectedCount));
  setDisabled(dom.aiRerunVectorize, aiRerunBlocked || !aiRerunAssetReady);
  setDisabled(dom.aiRerunInput, Boolean(writeReason) || !aiPipeline);
  const layerCheckboxes = dom.aiLayerList.querySelectorAll("input[data-ai-layer-id]");
  layerCheckboxes.forEach((node) => {
    node.disabled = Boolean(writeReason) || !aiSelectable;
  });
  setDisabled(dom.maskOpen,
    state.brush.pairs.length === 0 || state.brush.open || Boolean(writeReason));
  setDisabled(dom.maskPair, state.brush.open || Boolean(writeReason));
  renderAiStart();
  updateBrushControls();
  updateRepairActions();
  updateTileActions();

  const previewSessionActive = state.previewSession.isActive();
  dom.previewBlockHint.hidden = !(asset && !previewCurrent && !previewSessionActive);
  dom.oneclickBlock.classList.toggle("is-warning", Boolean(processReason || oneClickGrabcutMissing));
  if (writeReason) {
    setText(dom.oneclickBlock, writeReason);
  } else if (!asset) {
    setText(dom.oneclickBlock, "上传后可开始。");
  } else if (previewSessionActive) {
    setText(dom.oneclickBlock, "当前有未应用预览；开始新处理会先放弃旧预览。");
  } else if (!previewCurrent) {
    setText(dom.oneclickBlock, "画布正在预览成果，请先回到当前输入。");
  } else if (tooLarge) {
    setText(dom.oneclickBlock, "大图需先创建工作副本。");
  } else if (oneClickGrabcutMissing) {
    setText(dom.oneclickBlock, "GrabCut 需要有效框选。");
  } else {
    setText(dom.oneclickBlock, dom.previewMode.checked
      ? "先生成预览；满意后应用，放弃不会写入版本。"
      : "提交后显示真实任务状态，不会自动重试。");
  }
  syncActionLabels();
  updateExtractParamVisibility();
  renderRecolorPanel();
  renderPreviewUi();
  renderUndoRedo();
  renderGuide();
  renderBboxOverlay();
  renderBboxControls();
  if (state.requestInFlight) dom.appView.setAttribute("aria-busy", "true");
  else dom.appView.removeAttribute("aria-busy");
}

function validateWorkingCopyTarget(showError) {
  const asset = currentAsset();
  if (!asset) return { ok: false, error: "请先选择当前输入。" };
  const maxPixels = integerValue(dom.workingMax);
  if (maxPixels === null || maxPixels < WORKING_COPY_MIN || maxPixels > WORKING_COPY_MAX) {
    const message = "像素上限必须是 10,000–1,000,000 之间的整数。";
    if (showError) setError(dom.workingError, message);
    return { ok: false, error: message };
  }
  if (maxPixels >= assetPixels(asset)) {
    const message = "目标上限不小于当前尺寸，不会缩小。";
    if (showError) setError(dom.workingError, message);
    return { ok: false, error: message };
  }
  return { ok: true, maxPixels: maxPixels };
}

function feedbackCanSubmit() {
  if (state.requestInFlight || state.pendingSubmission) return false;
  if (!state.feedbackJobId) return false;
  const job = state.tasks.get(state.feedbackJobId);
  if (!job || !isJobEnded(job)) return false;
  if (state.feedbackResponses.has(job.job_id)) return false;
  const rating = dom.feedbackForm.querySelector('input[name="rating"]:checked');
  return Boolean(rating);
}

/* -------------------------------------------------------------------------- */
/* Settings dialog                                                           */
/* -------------------------------------------------------------------------- */

let settingsClientInstance = null;

function getSettingsClient() {
  if (!settingsClientInstance) {
    settingsClientInstance = createSettingsClient({ request: requestJson });
  }
  return settingsClientInstance;
}

function clearSettingsKeyInput() {
  dom.settingsKeyInput.value = "";
}

function updateSettingsKeyUi() {
  const action = SETTINGS_API_KEY_ACTIONS.includes(dom.settingsKeyAction.value)
    ? dom.settingsKeyAction.value
    : "keep";
  state.settings.keyAction = action;
  setHidden(dom.settingsKeyField, action !== "replace");
  dom.settingsKeyInput.disabled = action !== "replace" || state.settings.saving;
  if (action !== "replace") clearSettingsKeyInput();
  setText(dom.settingsKeyNote, action === "replace"
    ? "密钥只随本次保存发送；提交后立即清空，服务端不会回显。"
    : action === "clear"
      ? "清除后新的云端请求会因缺少密钥被阻止；本地处理与已开始请求不受影响。"
      : "保留当前密钥；请求中不会携带密钥字段。");
}

function fillSettingsForm(settings) {
  if (!settings) return;
  dom.settingsModel.value = settings.model;
  dom.settingsBaseUrl.value = settings.baseUrl;
  dom.settingsPaid.checked = settings.paidCallsEnabled;
  dom.settingsPricing.checked = settings.pricingConfirmed;
  dom.settingsBudget.value = centsToYuan(settings.budgetCents);
  dom.settingsReservation.value = centsToYuan(settings.reservationCents);
  dom.settingsMaxCalls.value = String(settings.maxCalls);
  dom.settingsKeyAction.value = "keep";
  clearSettingsKeyInput();
}

function renderSettings() {
  const settings = state.settings;
  const value = settings.value;
  setText(dom.settingsState, settings.saving
    ? "保存中…"
    : settings.loading ? "读取中…" : settings.loaded ? "已读取" : "尚未读取");
  setText(dom.settingsRevision, "revision " + (value ? value.revision : "—"));

  if (value) {
    const effective = settingsEffective(value);
    setText(dom.settingsEffectiveChip, effective.ready ? "云端可用" : "云端不可用");
    dom.settingsEffectiveChip.className = "chip " + (effective.ready ? "chip-fill" : "chip-mark");
    setText(dom.settingsEffectiveNote, effective.effectiveText);
    dom.settingsBlockers.replaceChildren();
    setHidden(dom.settingsBlockers, effective.labels.length === 0);
    for (const label of effective.labels) dom.settingsBlockers.append(element("li", "", label));
    setText(dom.settingsKeyState, value.apiKeyConfigured
      ? "已配置 API Key（不会回显）。"
      : "尚未配置 API Key。");
  } else {
    setText(dom.settingsEffectiveChip, "—");
    dom.settingsEffectiveChip.className = "chip";
    setText(dom.settingsEffectiveNote, "保存后对新任务生效；正在执行的云端请求保持提交时配置。");
    dom.settingsBlockers.replaceChildren();
    setHidden(dom.settingsBlockers, true);
    setText(dom.settingsKeyState, "尚未读取。");
  }

  setDisabled(dom.settingsSave, settings.loading || settings.saving || !value);
  setDisabled(dom.settingsReload, settings.loading || settings.saving);
  setDisabled(dom.settingsKeyAction, settings.loading || settings.saving || !value);
  setDisabled(dom.settingsModel, settings.loading || settings.saving || !value);
  setDisabled(dom.settingsBaseUrl, settings.loading || settings.saving || !value);
  setDisabled(dom.settingsPaid, settings.loading || settings.saving || !value);
  setDisabled(dom.settingsPricing, settings.loading || settings.saving || !value);
  setDisabled(dom.settingsBudget, settings.loading || settings.saving || !value);
  setDisabled(dom.settingsReservation, settings.loading || settings.saving || !value);
  setDisabled(dom.settingsMaxCalls, settings.loading || settings.saving || !value);
  setError(dom.settingsError, settings.error);
  setHidden(dom.settingsMessage, !settings.message);
  setText(dom.settingsMessage, settings.message);
  updateSettingsKeyUi();
}

async function loadSettings(options) {
  const opts = options || {};
  if (state.settings.loading || state.settings.saving) return false;
  state.settings.loading = true;
  if (!opts.keepError) state.settings.error = "";
  if (!opts.keepMessage) state.settings.message = "";
  renderSettings();
  try {
    const settings = await getSettingsClient().load();
    state.settings.value = settings;
    state.settings.revision = settings.revision;
    state.settings.loaded = true;
    state.settings.keyAction = "keep";
    dom.settingsKeyAction.value = "keep";
    clearSettingsKeyInput();
    fillSettingsForm(settings);
    return true;
  } catch (error) {
    state.settings.error = "无法读取设置：" + friendlyError(error);
    return false;
  } finally {
    state.settings.loading = false;
    renderSettings();
  }
}

function openSettingsDialog() {
  if (!dom.settingsDialog) return;
  if (dom.settingsDialog.open) return;
  try {
    dom.settingsDialog.showModal();
  } catch (_) {
    showToast("当前浏览器无法打开设置面板。", "error");
    return;
  }
  clearSettingsKeyInput();
  dom.settingsKeyAction.value = "keep";
  state.settings.keyAction = "keep";
  state.settings.error = "";
  state.settings.message = "";
  renderSettings();
  void loadSettings({ keepMessage: true });
}

function closeSettingsDialog() {
  clearSettingsKeyInput();
  dom.settingsKeyAction.value = "keep";
  state.settings.keyAction = "keep";
  if (dom.settingsDialog.open) dom.settingsDialog.close();
}

async function handleSettingsSave(event) {
  if (event) event.preventDefault();
  const current = state.settings.value;
  if (!current || state.settings.loading || state.settings.saving) return;
  state.settings.error = "";
  state.settings.message = "";
  const action = SETTINGS_API_KEY_ACTIONS.includes(dom.settingsKeyAction.value)
    ? dom.settingsKeyAction.value
    : "keep";
  if (action === "clear") {
    const ok = await confirmAction({
      title: "清除 API Key？",
      message: "清除后新的云端请求会因缺少密钥被阻止；本地处理与已经开始的请求不受影响。",
      confirmLabel: "清除密钥",
      cancelLabel: "保留密钥",
      tone: "danger"
    });
    if (!ok) return;
  }
  const built = buildSettingsUpdate({
    revision: current.revision,
    apiKeyAction: action,
    apiKey: dom.settingsKeyInput.value,
    model: dom.settingsModel.value,
    baseUrl: dom.settingsBaseUrl.value,
    paidCallsEnabled: dom.settingsPaid.checked,
    pricingConfirmed: dom.settingsPricing.checked,
    budgetYuan: dom.settingsBudget.value,
    reservationYuan: dom.settingsReservation.value,
    maxCalls: dom.settingsMaxCalls.value
  });
  if (!built.ok) {
    state.settings.error = built.error;
    renderSettings();
    return;
  }

  state.settings.saving = true;
  state.settings.message = "正在保存…";
  // The one-shot payload already holds the replacement key; clear the visible
  // field before waiting for the server so a submitted secret is not retained.
  clearSettingsKeyInput();
  dom.settingsKeyAction.value = "keep";
  state.settings.keyAction = "keep";
  renderSettings();
  try {
    const next = await getSettingsClient().save(built.payload);
    state.settings.value = next;
    state.settings.revision = next.revision;
    state.settings.loaded = true;
    state.settings.message = "设置已保存；新任务使用新配置，进行中的云端请求保持提交时配置。保存没有发起云端测试。";
    fillSettingsForm(next);
    void refreshAiStatus(false);
    showToast("设置已保存；未发起任何云端测试。", "success", 5000);
  } catch (error) {
    state.settings.saving = false;
    state.settings.message = "";
    clearSettingsKeyInput();
    dom.settingsKeyAction.value = "keep";
    state.settings.keyAction = "keep";
    if (error.status === 409) {
      const loaded = await loadSettings({ keepMessage: true, keepError: true });
      state.settings.error = loaded
        ? "设置已在其他页面更新（修订冲突），本次未保存。已重新读取最新设置，请复核后再次保存。"
        : "设置已在其他页面更新（修订冲突），本次未保存；重新读取也失败，请稍后再试。";
    } else if (error.network || (error.status && error.status >= 500)) {
      state.settings.error = "保存结果未知。请点击“重新读取”确认当前配置后再决定是否重试；页面不会自动重发。";
    } else {
      state.settings.error = "设置未保存：" + friendlyError(error);
    }
  } finally {
    state.settings.saving = false;
    if (built.payload && typeof built.payload === "object") {
      delete built.payload.api_key;
    }
    clearSettingsKeyInput();
    dom.settingsKeyAction.value = "keep";
    state.settings.keyAction = "keep";
    renderSettings();
  }
}

/* -------------------------------------------------------------------------- */
/* Dialogs                                                                   */
/* -------------------------------------------------------------------------- */

function confirmAction(options) {
  const opts = options || {};
  if (dom.confirmDialog.open) return Promise.resolve(false);
  return new Promise((resolve) => {
    state.confirmResolver = resolve;
    setText(dom.confirmTitle, opts.title || "确认操作");
    setText(dom.confirmMessage, opts.message || "");
    setText(dom.confirmCancel, opts.cancelLabel || "保留");
    setText(dom.confirmAccept, opts.confirmLabel || "继续");
    dom.confirmAccept.className = "btn " + (opts.tone === "primary" ? "btn-primary" : "btn-danger");
    dom.confirmDialog.returnValue = "cancel";
    const onClose = () => {
      dom.confirmDialog.removeEventListener("close", onClose);
      const confirmed = dom.confirmDialog.returnValue === "confirm";
      state.confirmResolver = null;
      resolve(confirmed);
    };
    dom.confirmDialog.addEventListener("close", onClose);
    try {
      dom.confirmDialog.showModal();
      dom.confirmCancel.focus();
    } catch (_) {
      dom.confirmDialog.removeEventListener("close", onClose);
      state.confirmResolver = null;
      resolve(false);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Toasts                                                                    */
/* -------------------------------------------------------------------------- */

function showToast(message, tone, duration) {
  const text = String(message || "").trim();
  if (!text) return;
  const toast = element("div", "toast" + (tone ? " is-" + tone : ""));
  const iconName = tone === "success" ? "check" : tone === "warning" || tone === "error" ? "alert" : "spark";
  toast.append(icon(iconName));
  toast.append(element("span", "", text));
  dom.toastRegion.append(toast);
  while (dom.toastRegion.childElementCount > 2) {
    dom.toastRegion.firstElementChild.remove();
  }
  window.setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(4px)";
    window.setTimeout(() => toast.remove(), 180);
  }, duration || 4800);
}

/* -------------------------------------------------------------------------- */
/* Event wiring                                                               */
/* -------------------------------------------------------------------------- */

function wireEvents() {
  dom.healthChip.addEventListener("click", () => void refreshHealth(false));
  dom.duplicateUse.addEventListener("click", () => void useExistingDuplicate());
  dom.duplicateDismiss.addEventListener("click", () => {
    state.uploadDuplicates = [];
    renderDuplicateBanner();
  });
  dom.retryConnection.addEventListener("click", () => {
    void refreshHealth(false);
    if (state.ai.statusError) void refreshAiStatus(false);
  });
  dom.openHistory.addEventListener("click", openHistory);
  dom.closeHistory.addEventListener("click", () => closeHistory({}));
  dom.historyScrim.addEventListener("click", () => closeHistory({}));
  dom.openSettings.addEventListener("click", openSettingsDialog);
  dom.settingsClose.addEventListener("click", closeSettingsDialog);
  dom.settingsReload.addEventListener("click", () => void loadSettings({}));
  dom.settingsForm.addEventListener("submit", (event) => void handleSettingsSave(event));
  dom.settingsKeyAction.addEventListener("change", () => {
    updateSettingsKeyUi();
    updateActionState();
    if (state.settings.keyAction === "replace") dom.settingsKeyInput.focus();
  });
  dom.settingsDialog.addEventListener("close", () => {
    clearSettingsKeyInput();
    dom.settingsKeyAction.value = "keep";
    state.settings.keyAction = "keep";
  });
  dom.refreshHistory.addEventListener("click", () => void loadHistory(true));
  dom.historyMore.addEventListener("click", () => void loadHistory(false));
  dom.historyList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-history-action]");
    if (!button) return;
    const jobId = button.dataset.jobId || "";
    const action = button.dataset.historyAction;
    if (action === "restore") {
      await restoreJob(jobId);
    } else if (action === "retry") {
      await retryJob(jobId);
    } else if (action === "evaluate") {
      const job = findHistoryJob(jobId);
      if (!job) return;
      state.tasks.set(job.job_id, Object.assign({}, state.tasks.get(job.job_id) || {}, job));
      closeHistory({ restoreFocus: false });
      setFeedbackJob(job.job_id, { focus: true });
    }
  });

  dom.chooseFile.addEventListener("click", () => dom.imageFile.click());
  dom.imageFile.addEventListener("change", () => {
    const file = dom.imageFile.files && dom.imageFile.files[0];
    if (file) setUploadFile(file);
  });
  dom.clearFile.addEventListener("click", () => setUploadFile(null));
  dom.uploadSubmit.addEventListener("click", () => void handleUploadSubmit());
  dom.dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dom.dropzone.classList.add("is-dragging");
  });
  dom.dropzone.addEventListener("dragleave", (event) => {
    if (!dom.dropzone.contains(event.relatedTarget)) dom.dropzone.classList.remove("is-dragging");
  });
  dom.dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dom.dropzone.classList.remove("is-dragging");
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) {
      if (files.length > 1) showToast("一次只上传一张图片；已选择第一张。", "info");
      setUploadFile(files[0]);
    }
  });

  dom.versionList.addEventListener("change", (event) => {
    const checkbox = event.target.closest(".version-checkbox");
    if (!checkbox) return;
    toggleVersionSelection(checkbox.dataset.assetId, checkbox.checked);
  });
  dom.versionList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-version-action]");
    if (!button) return;
    const assetId = button.dataset.assetId;
    const action = button.dataset.versionAction;
    if (!assetId) return;
    if (action === "preview") {
      await setPreview(assetId, {});
    } else if (action === "input") {
      await setPreview(assetId, { makeCurrent: true });
    } else if (action === "download") {
      const asset = state.assets.get(assetId);
      if (asset) await downloadAsset(asset, button);
    }
  });
  dom.clearSelection.addEventListener("click", clearSelection);
  dom.exportButton.addEventListener("click", handleExport);

  dom.workingMax.addEventListener("input", () => {
    setError(dom.workingError, "");
    renderWorkingProjection();
    updateActionState();
  });
  dom.workingMax.addEventListener("blur", () => {
    const value = integerValue(dom.workingMax);
    if (value !== null && value >= WORKING_COPY_MIN && value <= WORKING_COPY_MAX) {
      dom.workingMax.value = String(value);
      renderWorkingProjection();
    }
  });
  dom.workingCopyButton.addEventListener("click", handleWorkingCopy);
  dom.largeGotoWorking.addEventListener("click", () => {
    revealStageFor(dom.workingMax);
    dom.workingMax.scrollIntoView({ behavior: "smooth", block: "center" });
    dom.workingMax.focus();
    dom.workingMax.select();
  });

  dom.bboxLeft.addEventListener("input", handleBboxFieldInput);
  dom.bboxTop.addEventListener("input", handleBboxFieldInput);
  dom.bboxRight.addEventListener("input", handleBboxFieldInput);
  dom.bboxBottom.addEventListener("input", handleBboxFieldInput);
  dom.bboxLeft.addEventListener("blur", normalizeBboxField);
  dom.bboxTop.addEventListener("blur", normalizeBboxField);
  dom.bboxRight.addEventListener("blur", normalizeBboxField);
  dom.bboxBottom.addEventListener("blur", normalizeBboxField);
  dom.bboxFull.addEventListener("click", setFullBbox);
  dom.bboxCancel.addEventListener("click", () => void cancelBboxWithPrompt());
  dom.cropButton.addEventListener("click", handleCrop);
  dom.prepareButton.addEventListener("click", handlePrepare);
  dom.prepareRotation.addEventListener("change", handleParamsChanged);

  dom.selectionLayer.addEventListener("pointerdown", onSelectionPointerDown);
  dom.selectionLayer.addEventListener("pointermove", onSelectionPointerMove);
  dom.selectionLayer.addEventListener("pointerup", (event) => finishSelection(event, false));
  dom.selectionLayer.addEventListener("pointercancel", (event) => finishSelection(event, true));
  dom.retryPreview.addEventListener("click", () => void loadPreview());
  dom.backToCurrent.addEventListener("click", () => void backToCurrentInput());
  dom.compareButton.addEventListener("click", () => void openCompare());
  dom.closeCompare.addEventListener("click", () => dom.compareDialog.close());
  dom.compareDialog.addEventListener("close", () => dom.compareGrid.replaceChildren());

  dom.oneclickButton.addEventListener("click", handleOneClick);
  dom.extractButton.addEventListener("click", handleExtract);
  dom.vectorButton.addEventListener("click", handleVectorize);
  dom.enhanceButton.addEventListener("click", handleEnhance);
  dom.includeEnhance.addEventListener("change", () => handleParamsChanged({ autoEnhance: true }));
  dom.iterations.addEventListener("input", handleParamsChanged);
  dom.denoise.addEventListener("change", () => handleParamsChanged({ autoEnhance: true }));
  dom.extractClahe.addEventListener("change", handleParamsChanged);
  dom.minComponentArea.addEventListener("input", handleParamsChanged);
  dom.maxHoleArea.addEventListener("input", handleParamsChanged);
  dom.previewMode.addEventListener("change", () => {
    updateComposeSummary();
    updateActionState();
  });
  dom.autoPreviewEnhance.addEventListener("change", () => {
    updateActionState();
    scheduleAutoPreview();
  });
  document.querySelectorAll('input[name="extract-mode"], input[name="polarity"], input[name="vector-mode"], input[name="max-colors"], input[name="vector-detail"]')
    .forEach((node) => {
      node.addEventListener("change", () => {
        if (node.name === "extract-mode") {
          state.extractModeTouched = true;
          state.extractModeAutoSet = false;
        }
        handleParamsChanged();
      });
    });
  dom.vectorLength.addEventListener("input", handleParamsChanged);
  dom.vectorCorner.addEventListener("input", handleParamsChanged);
  dom.vectorSplice.addEventListener("input", handleParamsChanged);
  dom.recolorSvgSelect.addEventListener("change", () => {
    state.recolor.assetId = dom.recolorSvgSelect.value;
    state.recolor.signature = "";
    state.paramsRevision += 1;
    state.previewSession.invalidate("stale");
    clearPreviewExpiry();
    renderRecolorPanel(true);
    renderPreviewUi();
    updateActionState();
  });
  dom.recolorReset.addEventListener("click", resetRecolorColors);
  dom.recolorButton.addEventListener("click", handleRecolor);

  dom.undoButton.addEventListener("click", () => void undoWorkspace());
  dom.redoButton.addEventListener("click", () => void redoWorkspace());
  dom.previewApply.addEventListener("click", () => void applyPreview());
  dom.previewDiscard.addEventListener("click", () => void discardPreview({ confirm: true }));

  dom.taskCancel.addEventListener("click", () => void handleCancelTask());
  dom.taskRetry.addEventListener("click", () => {
    if (state.activeJobId) void retryJob(state.activeJobId);
  });
  dom.taskPoll.addEventListener("click", () => {
    if (!state.activeJobId) return;
    const timer = state.pollTimers.get(state.activeJobId);
    if (timer) {
      window.clearTimeout(timer);
      state.pollTimers.delete(state.activeJobId);
    }
    state.pollStopped.delete(state.activeJobId);
    state.pollFailures.delete(state.activeJobId);
    state.pollErrors.delete(state.activeJobId);
    renderTask();
    void pollJob(state.activeJobId);
  });
  dom.taskEvaluate.addEventListener("click", () => {
    if (state.activeJobId) setFeedbackJob(state.activeJobId, { focus: true });
  });

  dom.ratingStars.addEventListener("change", updateRatingUI);
  dom.feedbackSubmit.addEventListener("click", () => void handleFeedbackSubmit());
  dom.allowDisplay.addEventListener("change", updateActionState);
  dom.allowTraining.addEventListener("change", updateActionState);

  dom.refreshAiStatus.addEventListener("click", () => {
    void refreshAiStatus(true);
    if (state.ai.pipeline) void refreshAiPipelineNow(false);
  });
  dom.aiCallId.addEventListener("input", () => {
    setAiError("");
    renderAiStart();
    updateActionState();
  });
  dom.aiConsentUpload.addEventListener("change", () => {
    setAiError("");
    renderAiStart();
    updateActionState();
  });
  dom.aiConsentCharge.addEventListener("change", () => {
    setAiError("");
    renderAiStart();
    updateActionState();
  });
  dom.aiStartButton.addEventListener("click", () => void startAiPipeline());
  dom.aiCompose.addEventListener("click", () => void continueAi("select_layers"));
  dom.aiUseLocal.addEventListener("click", () => void continueAi("use_local"));
  dom.aiReject.addEventListener("click", () => void continueAi("reject"));
  dom.aiFilter.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ai-filter]");
    if (!button) return;
    const next = button.dataset.aiFilter;
    if (!["all", "selected", "review"].includes(next) || next === state.ai.filter) return;
    state.ai.filter = next;
    renderAiCandidates();
  });
  dom.aiRefreshPipeline.addEventListener("click", () => void refreshAiPipelineNow(false));
  dom.aiRerunInput.addEventListener("change", () => {
    state.ai.rerunAssetId = dom.aiRerunInput.value;
    setAiRerunError("");
    updateActionState();
  });
  dom.aiRerunCompose.addEventListener("click", () => void handleAiRerun("compose"));
  dom.aiRerunVectorize.addEventListener("click", () => void handleAiRerun("vectorize"));

  dom.repairCallId.addEventListener("input", () => {
    if (dom.repairCallId.value.trim()) {
      dom.repairConsentUpload.checked = false;
      dom.repairConsentCharge.checked = false;
    }
    setRepairError("");
    renderRepairStart();
    updateActionState();
  });
  dom.repairFeather.addEventListener("input", () => {
    setRepairError("");
    renderRepairStart();
  });
  dom.repairSize.addEventListener("change", () => {
    setRepairError("");
    renderRepairStart();
  });
  dom.repairDamageMask.addEventListener("change", () => {
    state.repair.damageId = dom.repairDamageMask.value;
    setRepairError("");
    renderRepairStart();
  });
  dom.repairConsentUpload.addEventListener("change", () => {
    setRepairError("");
    renderRepairStart();
    updateActionState();
  });
  dom.repairConsentCharge.addEventListener("change", () => {
    setRepairError("");
    renderRepairStart();
    updateActionState();
  });
  document.querySelectorAll('input[name="repair-intent"]').forEach((node) => {
    node.addEventListener("change", () => {
      setRepairError("");
      renderRepairStart();
    });
  });
  dom.repairStart.addEventListener("click", () => void startRepair());
  dom.repairRefresh.addEventListener("click", () => {
    if (state.repair.jobId) {
      void loadRepairRecord(state.repair.jobId, { preserveSelection: true, switchAccepted: true });
    }
  });
  dom.repairAccept.addEventListener("click", () => void decideRepair("accept"));
  dom.repairReject.addEventListener("click", () => void decideRepair("reject"));
  dom.repairAcceptFull.addEventListener("change", () => {
    state.repair.acceptFull = dom.repairAcceptFull.checked;
    setRepairError("");
    renderRepairPanel();
    updateActionState();
  });
  dom.repairCompare.addEventListener("click", () => openRepairCompare("three"));
  dom.repairEditView.addEventListener("click", () => openRepairCompare("edit"));
  dom.repairDiffView.addEventListener("click", () => openRepairCompare("difference"));
  dom.closeRepairCompare.addEventListener("click", closeRepairCompare);
  dom.repairCompareDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeRepairCompare();
  });
  dom.repairCompareDialog.addEventListener("close", () => {
    state.repair.compareSeq += 1;
    dom.repairCompareBody.replaceChildren();
    setError(dom.repairCompareError, "");
  });
  dom.repairCompareDialog.querySelectorAll("[data-repair-view]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      state.repair.compareView = button.dataset.repairView;
      updateRepairCompareToolbar();
      void renderRepairCompare();
    });
  });
  dom.repairNext.addEventListener("click", () => {
    const heading = document.getElementById("controls-heading");
    if (heading) heading.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  dom.tileUnit.addEventListener("change", () => {
    state.tile.unitId = dom.tileUnit.value;
    state.tile.error = "";
    state.tile.resultAssetId = "";
    renderTilePanel();
    updateActionState();
  });
  document.querySelectorAll('input[name="tile-preset"]').forEach((node) => {
    node.addEventListener("change", () => {
      if (!node.checked) return;
      const size = Number(node.value);
      if ([2, 3].includes(size)) {
        state.tile.rows = size;
        state.tile.cols = size;
        state.tile.resultAssetId = "";
        state.tile.error = "";
        renderTilePanel();
        updateActionState();
      }
    });
  });
  dom.tileSeam.addEventListener("change", () => {
    const value = dom.tileSeam.value;
    if (SEAM_LABELS[value]) {
      state.tile.seamObservation = value;
      updateActionState();
    }
  });
  dom.tileCrop.addEventListener("click", () => void handleTileCrop());
  dom.tileGenerate.addEventListener("click", () => void startTilePreview());
  dom.tileUnitDownload.addEventListener("click", () => {
    const unit = selectedTileUnit();
    if (unit) void downloadAsset(unit, dom.tileUnitDownload);
  });
  dom.tileDownload.addEventListener("click", () => {
    const asset = state.tile.resultAssetId ? state.assets.get(state.tile.resultAssetId) : null;
    if (asset) void downloadAsset(asset, dom.tileDownload);
  });
  dom.tileZip.addEventListener("click", () => void handleTileZip());

  dom.assetPreviewDownload.addEventListener("click", () => {
    const asset = state.assetPreviewId ? state.assets.get(state.assetPreviewId) : null;
    if (asset) void downloadAsset(asset, dom.assetPreviewDownload);
  });
  dom.closeAssetPreview.addEventListener("click", () => dom.assetPreviewDialog.close());
  dom.assetPreviewDialog.addEventListener("close", () => {
    state.assetPreviewId = null;
    dom.assetPreviewBody.replaceChildren();
  });

  dom.maskPair.addEventListener("change", () => {
    state.brush.selectedPairKey = dom.maskPair.value;
    const pair = selectedMaskPair();
    setText(dom.maskPairNote, pair ? pair.detail : "只能编辑同一来源、同一尺寸的蒙版。");
    updateActionState();
  });
  dom.maskOpen.addEventListener("click", () => void openMaskBrush());
  dom.brushClose.addEventListener("click", () => void requestCloseBrushEditor());
  dom.brushCancel.addEventListener("click", () => void requestCloseBrushEditor());
  dom.brushSave.addEventListener("click", () => void saveBrushMask());
  dom.brushDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    void requestCloseBrushEditor();
  });
  document.querySelectorAll('input[name="brush-mode"]').forEach((node) => {
    node.addEventListener("change", () => {
      if (node.checked) {
        state.brush.mode = node.value;
        scheduleBrushRender();
        if (state.brush.lastPointer) updateBrushCursor(state.brush.lastPointer);
      }
    });
  });
  document.querySelectorAll('input[name="brush-algorithm"]').forEach((node) => {
    node.addEventListener("change", () => {
      if (!node.checked) return;
      state.brush.algorithm = node.value;
      updateBrushAlgorithmUi();
      updateBrushControls();
    });
  });
  dom.brushIterations.addEventListener("input", () => {
    state.brush.iterations = clamp(integerValue(dom.brushIterations) || 5, 1, 10);
  });
  dom.brushRadiusRange.addEventListener("input", () => setBrushRadius(dom.brushRadiusRange.value));
  dom.brushRadiusValue.addEventListener("input", () => {
    if (dom.brushRadiusValue.value.trim() !== "") setBrushRadius(dom.brushRadiusValue.value);
  });
  dom.brushRadiusValue.addEventListener("blur", () => {
    const value = Number(dom.brushRadiusValue.value);
    setBrushRadius(Number.isFinite(value) ? value : state.brush.radius);
  });
  document.querySelectorAll("[data-brush-radius]").forEach((button) => {
    button.addEventListener("click", () => {
      setBrushRadius(Number(button.dataset.brushRadius));
      dom.brushRadiusValue.focus();
    });
  });
  dom.brushUndo.addEventListener("click", undoBrushAction);
  dom.brushRedo.addEventListener("click", redoBrushAction);
  dom.brushInvert.addEventListener("change", () => {
    state.brush.invert = dom.brushInvert.checked;
    updateBrushMaskOption();
  });
  dom.brushDenoise.addEventListener("change", () => {
    state.brush.denoise = Number(dom.brushDenoise.value) || 0;
    updateBrushMaskOption();
  });
  dom.brushOverlay.addEventListener("change", () => {
    state.brush.overlay = dom.brushOverlay.checked;
    scheduleBrushRender();
  });
  dom.brushDialog.addEventListener("keydown", (event) => {
    if (!state.brush.open) return;
    const key = String(event.key || "").toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redoBrushAction();
      else undoBrushAction();
    } else if ((event.ctrlKey || event.metaKey) && key === "y") {
      event.preventDefault();
      redoBrushAction();
    }
  });
  dom.brushCanvas.addEventListener("pointerdown", brushPointerDown);
  dom.brushCanvas.addEventListener("pointermove", brushPointerMove);
  dom.brushCanvas.addEventListener("pointerup", (event) => finishBrushPointer(event, false));
  dom.brushCanvas.addEventListener("pointercancel", (event) => finishBrushPointer(event, true));
  dom.brushCanvas.addEventListener("pointerleave", () => {
    if (!state.brush.activeStroke) setHidden(dom.brushCursor, true);
  });
  dom.brushCanvas.addEventListener("pointerenter", (event) => {
    state.brush.lastPointer = event;
    updateBrushCursor(event);
  });

  dom.pendingRetry.addEventListener("click", retryPendingSubmission);
  dom.pendingDiscard.addEventListener("click", () => void discardPendingSubmission());

  dom.confirmDialog.addEventListener("cancel", () => {
    dom.confirmDialog.returnValue = "cancel";
  });

  window.addEventListener("resize", () => {
    if (state.brush.open) {
      sizeBrushCanvas();
      scheduleBrushRender();
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (!state.bboxDirty && !(state.brush.open && state.brush.dirty) && !state.previewSession.current()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (state.activeJobId && state.taskRunning && !state.pollTimers.has(state.activeJobId) && !state.pollStopped.has(state.activeJobId)) {
      void pollJob(state.activeJobId);
    }
    refreshHealth(true);
    if (state.ai.pipeline && isAiActive(state.ai.pipeline)) scheduleAiPoll(700);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.historyOpen && !document.querySelector("dialog[open]")) {
      event.preventDefault();
      closeHistory({});
      return;
    }
    if (event.key === "Tab" && state.historyOpen) {
      const focusables = Array.from(
        dom.historyDrawer.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    if (document.querySelector("dialog[open]")) return;
    const target = event.target;
    const typing = target && typeof target.closest === "function" &&
      target.closest("input, textarea, select, [contenteditable='true']");
    if (typing) return;
    const key = String(event.key || "").toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) void redoWorkspace();
        else void undoWorkspace();
      } else if (key === "y") {
        event.preventDefault();
        void redoWorkspace();
      }
    }
  });
}

function normalizeBboxField() {
  if (!state.bbox) return;
  fillBboxInputs(state.bbox);
}

init();

/* =============================================================================
   工序外壳（追加模块）
   -----------------------------------------------------------------------------
   只读写 DOM 与 <html data-stage>：切换右栏工序、展开被折叠的容器、同步阶段条。
   不参与任何业务状态，不修改上面任何既有函数。
   ============================================================================= */

function revealStageFor(element) {
  try {
    __psShell.reveal(element);
  } catch (error) {
    /* 外壳不可用时静默跳过，业务流程保持不变 */
  }
}

const __psShell = (function createStageShell() {
  const doc = document;
  const html = doc.documentElement;

  function statusBar() {
    return doc.getElementById("status-bar");
  }

  function statusToggle() {
    const bar = statusBar();
    return bar ? bar.querySelector(".status-toggle") : null;
  }

  function openStatus() {
    const bar = statusBar();
    if (!bar) return;
    bar.classList.add("is-open");
    const toggle = statusToggle();
    if (toggle) toggle.setAttribute("aria-expanded", "true");
  }

  function closeStatus() {
    const bar = statusBar();
    if (!bar) return;
    bar.classList.remove("is-open");
    const toggle = statusToggle();
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }

  function scrollToolsToTop() {
    const scroller = doc.querySelector(".tools-scroll");
    if (scroller) scroller.scrollTop = 0;
  }

  function syncRail(current) {
    const steps = doc.querySelectorAll(".rail-step");
    for (const step of steps) {
      if (step.dataset.stage === current) step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    }
  }

  function setStage(value, resetScroll) {
    const next = String(value);
    if (!/^[1-7]$/.test(next)) return;
    if (html.getAttribute("data-stage") !== next) {
      html.setAttribute("data-stage", next);
      syncRail(next);
    }
    if (resetScroll) scrollToolsToTop();
  }

  function expandAncestors(element) {
    let node = element.parentElement;
    while (node) {
      if (node.tagName === "DETAILS" && !node.open) node.open = true;
      node = node.parentElement;
    }
  }

  function reveal(element) {
    if (!element || typeof element.closest !== "function") return;
    expandAncestors(element);
    const panel = element.closest(".stage-panel[data-stage]");
    if (panel) setStage(panel.dataset.stage, false);
    const bar = statusBar();
    if (bar && bar.contains(element)) openStatus();
  }

  function init() {
    const rail = doc.querySelector(".rail");
    const started = html.getAttribute("data-stage") || "1";
    html.setAttribute("data-stage", started);
    if (rail) {
      syncRail(started);
      rail.addEventListener("click", (event) => {
        const step = event.target && event.target.closest ? event.target.closest(".rail-step") : null;
        if (!step) return;
        setStage(step.dataset.stage, true);
      });
    }

    const toggle = statusToggle();
    if (toggle) {
      toggle.addEventListener("click", () => {
        const bar = statusBar();
        if (!bar) return;
        if (bar.classList.contains("is-open")) closeStatus();
        else openStatus();
      });
    }

    doc.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const bar = statusBar();
      if (!bar || !bar.classList.contains("is-open")) return;
      if (doc.querySelector("dialog[open]")) return;
      if (doc.body.classList.contains("drawer-open")) return;
      closeStatus();
      const back = statusToggle();
      if (back) back.focus();
    });
  }

  init();

  return { reveal, setStage, openStatus, closeStatus };
})();

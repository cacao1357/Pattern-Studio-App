/* =============================================================================
   batch.js — 工作台「纹样」列：用户自行挑选的原图组、批量导入队列与跨图切换。
   边界：
   - 工作台列不是纹样库的镜像：只有用户通过「添加纹样」或上传/导入加入的原图
     才会出现在这里；加入与移出只改工作台成员表，不删除纹样库记录。
   - 当前会话原图即使尚未加入，也会临时显示在列首，并提供「加入工作台」。
   - 批量索引只服务于侧栏与导出选择，**不把别的原图资产塞进 store.session**；
     跨原图切换一律走 store 既有的会话隔离（api.go → ensureSession/openAsset）。
   - 当前原图组优先读取 store.session 的实时资产；其它组读取 /workbench/items
     分页结果（只读，不提交任务、不改写会话）。
   - 上传逐个提交：每个文件单独成功/失败；已成功的文件不会因为重试或再次勾选而
     重复提交。批量近似版本只汇总提示，不自动删除或合并。
   - 本模块不碰 DOM 树结构以外的东西：视图负责事件绑定，这里只提供纯逻辑与片段。
   ============================================================================= */

import { ApiError, api, idempotencyKey } from "./api.js";
import { store } from "./store.js";
import { icon } from "./icons.js";
import {
  dimsOf,
  escapeHtml as esc,
  formatBytes,
  formatTime,
  kindLabel,
  shortId,
} from "./format.js";

/** 侧栏每页原图组数；与后端 workbench/items 上限（1..50）一致，留出滚动余量。 */
export const BATCH_PAGE_SIZE = 20;
/** 单张图片上传上限，与后端默认限制一致；本地先拦一次，避免白跑请求。 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_BATCH_SELECTION = 500;
/** 加入/移出工作台单次上限；与后端 workbench/items 的 200 一致。 */
export const MAX_WORKBENCH_SELECTION = 200;
export const MAX_EXPORT_BYTES = 128 * 1024 * 1024;

const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg"]);
const ACCEPTED_SUFFIXES = [".png", ".jpg", ".jpeg"];
const NO_PREVIEW_KINDS = new Set(["zip", "export", "archive"]);
const SESSION_BASE_KINDS = new Set(["original", "normalized", "normalized_input"]);

/** 组内顺序：输入 → 裁切/准备 → 修复 → 候选 → 线稿/透明 → 矢量 → 平铺。 */
const ASSET_RANK = {
  original: 0,
  normalized_input: 1,
  working_copy: 2,
  cropped: 3,
  prepared: 4,
  enhanced: 5,
  edit_candidate: 10,
  repair_candidate: 11,
  repair_composite: 12,
  edit_mask: 13,
  blend_weight: 14,
  difference_map: 15,
  damage_mask: 16,
  accepted_repair: 17,
  generated_basemap: 20,
  generated_layer: 21,
  placed_generated_layer: 22,
  ai_layer: 23,
  composed_candidate: 24,
  foreground_mask: 30,
  transparent_png: 31,
  lineart: 32,
  contour_line_art: 33,
  svg: 40,
  monochrome_svg: 41,
  color_svg: 42,
  tile_preview: 50,
  zip: 60,
  export: 61,
  archive: 62,
};

const UPLOAD_ERROR_TEXT = {
  UPLOAD_TOO_LARGE: "图片超过 20 MB，请先压缩或裁切。",
  UNSUPPORTED_FORMAT: "不支持这种图片格式，请使用 PNG 或 JPEG。",
  FORMAT_MISMATCH: "文件内容与扩展名不一致。",
  PIXEL_LIMIT: "图片像素超过上限，请先创建工作副本。",
  LOCAL_ACCESS_ONLY: "本机服务只接受同源访问，请从工作台地址打开页面。",
  LOCAL_REQUEST_HEADER_REQUIRED: "请求缺少本机写标记，请刷新页面后重试。",
  INVALID_IMAGE_NOTE: "文件名或来源说明过长。",
  SERVICE_ERROR: "本机服务没有完成上传，请稍后重试。",
};

/** 已经成功上传过的文件签名；重试或再次导入时据此避免重复提交。 */
const succeededSignatures = new Set();
/** 每次导入一个递增序号，保证失败项与重新选择的同名文件不会共用 DOM key。 */
let importRun = 0;

const state = {
  /** imageId -> 组；组只保存索引与元数据，不改变 store.session。 */
  groups: new Map(),
  /** 服务端工作台成员；只有这些 id 会跨刷新保留。 */
  members: new Set(),
  /** 列表顺序：当前会话置顶显示，其余按载入/导入顺序。 */
  order: [],
  cursor: "",
  nextCursor: null,
  loading: false,
  loaded: false,
  error: "",
  collapsed: new Set(),
  /** 批量导入行：{ key, name, size, status, progress, message, imageId, file } */
  uploads: [],
  uploadBusy: false,
  uploadPanel: false,
  /** 批量近似版本：只汇总提示，不删除、不合并。 */
  duplicates: [],
  lastImport: null,
};

/* ------------------------------------------------------------------ 纯逻辑 */

export function fileSignature(file) {
  if (!file) return "";
  return [String(file.name || ""), Number(file.size) || 0, Number(file.lastModified) || 0].join(":");
}

/** 本地预检：空/类型/大小；返回空字符串表示可以上传。 */
export function classifyUploadFile(file, { maxBytes = MAX_FILE_BYTES } = {}) {
  if (!file) return "unsupported";
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  const suffixOk = ACCEPTED_SUFFIXES.some((suffix) => name.endsWith(suffix));
  if (!ACCEPTED_TYPES.has(type) && !suffixOk) return "unsupported";
  if (!Number(file.size)) return "empty";
  if (Number(file.size) > maxBytes) return "too_large";
  return "";
}

/**
 * 把一批文件整理成可上传项与跳过项。
 * - 同一批里重复的文件只提交一次；
 * - 已经上传成功过的签名（succeeded）不再提交；
 * - 类型/大小不合格的文件不提交，但仍保留在 skipped 里给用户看原因。
 * @returns {{items: Array, skipped: Array}}
 */
export function planBatchImport(files, { succeeded = new Set(), maxBytes = MAX_FILE_BYTES } = {}) {
  const items = [];
  const skipped = [];
  const seen = new Set();
  [...(files || [])].forEach((file, index) => {
    const signature = fileSignature(file);
    const key = `${index}:${signature}`;
    const reason = classifyUploadFile(file, { maxBytes });
    if (reason) {
      skipped.push({ key, index, file, signature, reason });
      return;
    }
    if (succeeded.has(signature) || seen.has(signature)) {
      skipped.push({ key, index, file, signature, reason: "duplicate" });
      return;
    }
    seen.add(signature);
    items.push({ key, index, file, signature });
  });
  return { items, skipped };
}

/**
 * 顺序执行批量上传。单个失败只记录该文件，继续后面的文件。
 * upload / onEvent 由调用方注入，便于在没有 DOM/网络的测试里验证顺序与去重。
 */
export async function runBatchImport({ items, upload, onEvent, succeeded } = {}) {
  const done = new Set();
  const already = typeof succeeded === "function" ? succeeded : () => false;
  for (const item of items || []) {
    const signature = item.signature || fileSignature(item.file);
    if (done.has(signature) || already(signature)) {
      onEvent?.({ item, status: "skipped", reason: "duplicate" });
      continue;
    }
    onEvent?.({ item, status: "uploading" });
    try {
      const result = await upload(item.file, item);
      done.add(signature);
      onEvent?.({ item, status: "done", result, signature });
    } catch (error) {
      onEvent?.({ item, status: "error", error });
    }
  }
  return done;
}

export function uploadSkipText(reason) {
  const map = {
    duplicate: "已在本次导入中成功上传，未重复提交",
    unsupported: "不是 PNG / JPEG，已跳过",
    too_large: "超过 20 MB，已跳过",
    empty: "文件为空，已跳过",
  };
  return map[reason] || "已跳过";
}

function uploadFailure(data, status) {
  const code = String(data?.error?.code || "");
  const detail = String(data?.error?.message || "").trim();
  const message =
    UPLOAD_ERROR_TEXT[code] ||
    (detail && /[\u4e00-\u9fa5]/.test(detail) ? detail : "") ||
    (status === 413 ? UPLOAD_ERROR_TEXT.UPLOAD_TOO_LARGE : "") ||
    "上传失败，请稍后重试。";
  return new ApiError(message, { status, code, detail });
}

/** 浏览器里用 XHR 拿到真实上传进度；Node/测试环境退回 fetch 客户端。 */
function uploadOne(file, { onProgress } = {}) {
  const provenance = { source_name: String(file?.name || "").slice(0, 200) };
  if (typeof XMLHttpRequest !== "function") {
    return api.uploadImage(file, provenance, { onProgress: () => onProgress?.(0.6) });
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/v1/images?filename=${encodeURIComponent(file.name || "upload.png")}`);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("X-Pattern-Studio", "local");
    xhr.setRequestHeader("Idempotency-Key", idempotencyKey());
    xhr.timeout = 180000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(0.99, event.loaded / event.total));
      }
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText || "null");
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.image_id) {
        onProgress?.(1);
        resolve(data);
      } else {
        reject(uploadFailure(data, xhr.status));
      }
    };
    xhr.onerror = () => reject(new ApiError("无法连接本机服务，请确认工作台服务正在运行。", { network: true }));
    xhr.ontimeout = () => reject(new ApiError("上传超时，请稍后重试。", { network: true }));
    const form = new FormData();
    form.set("file", file, file.name || "upload.png");
    form.set("source_name", provenance.source_name);
    xhr.send(form);
  });
}

/* ------------------------------------------------------------------ 分组索引 */

function uniqueAssets(list) {
  const seen = new Set();
  const out = [];
  for (const asset of list || []) {
    if (!asset?.asset_id || seen.has(asset.asset_id)) continue;
    seen.add(asset.asset_id);
    out.push(asset);
  }
  return out;
}

function mergeAssets(current, incoming) {
  const byId = new Map();
  for (const asset of current || []) if (asset?.asset_id) byId.set(asset.asset_id, asset);
  for (const asset of incoming || []) {
    if (!asset?.asset_id) continue;
    // 会话里的版本更新（如参数被改写）优先覆盖索引里的旧快照。
    byId.set(asset.asset_id, { ...(byId.get(asset.asset_id) || {}), ...asset });
  }
  return [...byId.values()];
}

export function sortGroupAssets(assets) {
  const created = (asset) => {
    const ms = Date.parse(String(asset?.created_at || ""));
    return Number.isNaN(ms) ? 0 : ms;
  };
  return [...(assets || [])].sort(
    (a, b) =>
      (ASSET_RANK[a?.kind] ?? 90) - (ASSET_RANK[b?.kind] ?? 90) ||
      created(a) - created(b) ||
      String(a?.asset_id || "").localeCompare(String(b?.asset_id || ""))
  );
}

function groupNameFromImage(image) {
  const meta = image?.meta || {};
  return (
    String(meta.source_name || "").trim() ||
    String(image?.original?.source_name || "").trim() ||
    String(image?.source_note || "").trim() ||
    "未命名纹样"
  );
}

function groupFromPattern(item) {
  return {
    imageId: item.image_id || item.imageId,
    name: String(item.name || "").trim() || "未命名纹样",
    createdAt: item.created_at || item.createdAt || "",
    assets: uniqueAssets(item.assets || []),
    categories: Array.isArray(item.categories) ? item.categories.map((entry) => ({ ...entry })) : [],
    categoryIds: Array.isArray(item.category_ids) ? [...item.category_ids] : [],
    revision: Number(item.revision) || 0,
    loading: false,
    error: "",
    source: "index",
    member: true,
  };
}

function groupFromUpload(result, file) {
  const imageId = result?.image_id;
  if (!imageId) return null;
  const assets = uniqueAssets([result.normalized, result.original]);
  return {
    imageId,
    name: String(result?.meta?.source_name || result?.original?.source_name || file?.name || "").trim() || "未命名纹样",
    createdAt: result.created_at || "",
    assets,
    categories: [],
    categoryIds: [],
    revision: 0,
    loading: false,
    error: "",
    source: "import",
    member: true,
  };
}

function addToOrder(imageId) {
  if (!imageId) return;
  if (!state.order.includes(imageId)) state.order.push(imageId);
}

/** 把当前会话的资产并入索引中的当前原图组；不移动别的组的资产。 */
export function syncSessionGroup() {
  const imageId = store.session.imageId;
  if (!imageId) return null;
  const assets = store.session.assets || [];
  const name = groupNameFromImage(store.session.image);
  const existing = state.groups.get(imageId);
  if (!existing) {
    const group = {
      imageId,
      name,
      createdAt: store.session.image?.created_at || "",
      assets: uniqueAssets(assets),
      categories: [],
      categoryIds: [],
      revision: 0,
      loading: false,
      error: "",
      source: "session",
      member: false,
    };
    state.groups.set(imageId, group);
    addToOrder(imageId);
    return group;
  }
  existing.assets = mergeAssets(existing.assets, assets);
  if (name && name !== "未命名纹样") existing.name = name;
  if (!existing.createdAt && store.session.image?.created_at) existing.createdAt = store.session.image.created_at;
  return existing;
}

/** 侧栏显示顺序：当前原图组置顶，其余按载入/导入顺序；不会出现重复组。 */
export function batchGroups() {
  const currentId = store.session.imageId || "";
  const ids = [...state.order];
  if (currentId && !ids.includes(currentId)) ids.unshift(currentId);
  const ordered = currentId
    ? [currentId, ...ids.filter((id) => id !== currentId)]
    : ids;
  return ordered
    .map((id) => state.groups.get(id))
    .filter(Boolean)
    .map((group) => ({
      ...group,
      member: state.members.has(group.imageId),
      assets: sortGroupAssets(group.assets),
      current: group.imageId === currentId,
    }));
}

export function batchSummary() {
  const rows = state.uploads || [];
  return {
    total: rows.length,
    done: rows.filter((row) => row.status === "done").length,
    failed: rows.filter((row) => row.status === "error").length,
    skipped: rows.filter((row) => row.status === "skipped").length,
    uploading: rows.filter((row) => row.status === "uploading").length,
    queued: rows.filter((row) => row.status === "queued").length,
    busy: state.uploadBusy,
  };
}

export function duplicateSummary() {
  return { count: state.duplicates.length, items: state.duplicates.map((entry) => ({ ...entry })) };
}

export function resetBatchState() {
  succeededSignatures.clear();
  state.groups = new Map();
  state.members = new Set();
  state.order = [];
  state.cursor = "";
  state.nextCursor = null;
  state.loading = false;
  state.loaded = false;
  state.error = "";
  state.collapsed = new Set();
  state.uploads = [];
  state.uploadBusy = false;
  state.uploadPanel = false;
  state.duplicates = [];
  state.lastImport = null;
}

/** 从 /workbench/items 读一页用户选入工作台的原图组；只做索引，不改变当前会话。 */
export async function loadWorkbenchPage({ append = false, onChange } = {}) {
  if (state.loading) return null;
  state.loading = true;
  state.error = "";
  try {
    const page = await api.workbenchItems({
      limit: BATCH_PAGE_SIZE,
      cursor: append ? state.cursor : "",
    });
    const items = (page?.items || []).filter((item) => item?.image_id);
    if (!append) {
      // 第一页是权威集合：另一窗口移出的组不能继续留在本地。
      state.groups = new Map();
      state.order = [];
      state.members = new Set();
    }
    for (const item of items) {
      const next = groupFromPattern(item);
      const existing = state.groups.get(item.image_id);
      if (existing) {
        // 索引页比会话旧：保留会话里的实时资产，只补上分类/创建时间。
        existing.assets = mergeAssets(next.assets, existing.assets);
        existing.name = existing.name || next.name;
        existing.createdAt = existing.createdAt || next.createdAt;
        existing.categories = next.categories;
        existing.categoryIds = next.categoryIds;
        existing.revision = next.revision;
        existing.member = true;
      } else {
        state.groups.set(item.image_id, next);
      }
      state.members.add(item.image_id);
      addToOrder(item.image_id);
    }
    state.cursor = page?.next_cursor || "";
    state.nextCursor = page?.next_cursor || null;
    state.loaded = true;
    syncSessionGroup();
    onChange?.({ reason: "loaded" });
    return page;
  } catch (error) {
    state.error = error?.message || "工作台纹样读取失败。";
    onChange?.({ reason: "error", error });
    return null;
  } finally {
    state.loading = false;
  }
}

/** 首次进入工作台时载入用户选入的纹样；已有索引时只补当前会话。 */
export function ensureBatchIndex({ onChange } = {}) {
  syncSessionGroup();
  if (state.loaded || state.loading) return Promise.resolve(null);
  return loadWorkbenchPage({ append: false, onChange });
}

/** 把已经从 /patterns 读到的组直接并入工作台索引（不写会话）。 */
export function adoptWorkbenchGroups(items) {
  let adopted = 0;
  for (const item of items || []) {
    const imageId = item?.image_id || item?.imageId;
    if (!imageId) continue;
    const group = groupFromPattern(item);
    state.groups.set(group.imageId, mergeGroup(group));
    state.members.add(group.imageId);
    addToOrder(group.imageId);
    adopted += 1;
  }
  return adopted;
}

/** 加入工作台：先写服务端成员表，成功后再更新本地索引。 */
export async function addWorkbenchItems(items) {
  const list = (items || []).filter((item) => item?.image_id || item?.imageId);
  if (!list.length) return null;
  const ids = list.map((item) => item.image_id || item.imageId);
  const result = await api.addWorkbenchItems(ids);
  adoptWorkbenchGroups(list);
  return result;
}

/** 移出工作台：只删成员关系，纹样与资产仍然保留在纹样库。 */
export async function removeWorkbenchMembers(imageIds) {
  const ids = [...new Set((imageIds || []).filter(Boolean))];
  if (!ids.length) return null;
  let removed = 0;
  for (let index = 0; index < ids.length; index += MAX_WORKBENCH_SELECTION) {
    const chunk = ids.slice(index, index + MAX_WORKBENCH_SELECTION);
    const result = await api.removeWorkbenchItems(chunk);
    removed += Number(result?.removed) || 0;
  }
  const currentId = store.session.imageId || "";
  for (const imageId of ids) {
    state.members.delete(imageId);
    const group = state.groups.get(imageId);
    if (!group) continue;
    if (imageId === currentId) {
      // 当前会话继续可见，只是不再跨刷新保留。
      group.member = false;
      continue;
    }
    state.groups.delete(imageId);
    state.order = state.order.filter((id) => id !== imageId);
    state.collapsed.delete(imageId);
  }
  return { removed };
}

export function isWorkbenchMember(imageId) {
  return Boolean(imageId) && state.members.has(imageId);
}

/** 「全选」需要知道是否还有未载入的工作台分页。 */
export function workbenchHasMore() {
  return Boolean(state.nextCursor);
}

/** 读完全部分页，供工作台「全选」使用；返回是否完整读完。 */
export async function loadAllWorkbenchItems() {
  let guard = 0;
  while (state.nextCursor && guard < 25) {
    const page = await loadWorkbenchPage({ append: true });
    if (!page) return false;
    guard += 1;
  }
  return !state.nextCursor;
}

/** 服务端已确认加入后同步本地成员标记，避免刚上传/从纹样库打开时误显示“未加入”。 */
export function rememberWorkbenchMember(imageId) {
  if (!imageId) return;
  state.members.add(imageId);
  const group = state.groups.get(imageId);
  if (group) group.member = true;
}

/* ------------------------------------------------------------------ 批量导入 */

function rowFor(uploads, key) {
  return uploads.find((row) => row.key === key) || null;
}

function paintUploadRow(key) {
  if (typeof document === "undefined") return;
  const row = rowFor(state.uploads, key);
  if (!row) return;
  const el = document.querySelector(`[data-batch-row="${key}"]`);
  if (!el) return;
  el.dataset.state = row.status;
  const status = el.querySelector("[data-batch-status]");
  if (status) status.textContent = row.statusText || "";
  const bar = el.querySelector("[data-batch-bar]");
  if (bar) bar.style.width = `${Math.round(Math.max(0, Math.min(1, row.progress || 0)) * 100)}%`;
  const percent = el.querySelector("[data-batch-percent]");
  if (percent) percent.textContent = row.status === "uploading" ? `${Math.round((row.progress || 0) * 100)}%` : "";
}

function setRowStatus(row, patch) {
  Object.assign(row, patch);
  row.statusText =
    row.status === "queued"
      ? "等待上传"
      : row.status === "uploading"
      ? "上传中…"
      : row.status === "done"
      ? "已上传"
      : row.status === "error"
      ? row.message || "上传失败"
      : row.status === "skipped"
      ? row.message || "已跳过"
      : "";
  paintUploadRow(row.key);
}

/**
 * 批量导入入口：预检 → 顺序上传（逐个状态/进度）→ 汇总结果与近似版本。
 * 已成功文件在 retry 或再次导入时不会重复提交。
 */
export async function importFiles(files, { onChange, toast } = {}) {
  if (state.uploadBusy) {
    toast?.("正在批量导入，请等这一批完成后再选文件。", "warn");
    return null;
  }
  const list = [...(files || [])];
  if (!list.length) return null;
  const plan = planBatchImport(list, { succeeded: succeededSignatures });
  state.uploadBusy = true;
  state.uploadPanel = true;
  state.duplicates = [];
  state.lastImport = null;
  const rows = [];
  const rowByKey = new Map();
  const runId = ++importRun;
  for (const item of plan.items) {
    const row = { key: `${runId}-${item.key}`, planKey: item.key, name: item.file.name, size: item.file.size, status: "queued", statusText: "等待上传", progress: 0, message: "", imageId: "", signature: item.signature, file: item.file };
    rows.push(row);
    rowByKey.set(item.key, row);
  }
  for (const item of plan.skipped) {
    const row = { key: `${runId}-${item.key}`, planKey: item.key, name: item.file.name, size: item.file.size, status: "skipped", statusText: uploadSkipText(item.reason), progress: 0, message: uploadSkipText(item.reason), imageId: "", signature: item.signature, reason: item.reason, file: item.file };
    rows.push(row);
    rowByKey.set(item.key, row);
  }
  // 保持用户选择的文件顺序：跳过项也出现在队列里，失败/跳过都看得见。
  // 上一批的失败项继续留在列表里，便于「重试失败项」；已成功项不重复列出。
  rows.sort((a, b) => String(a.key).localeCompare(String(b.key), undefined, { numeric: true }));
  state.uploads = [...state.uploads.filter((row) => row.status === "error"), ...rows];
  onChange?.({ reason: "import-start" });

  await runBatchImport({
    items: plan.items,
    upload: (file, item) => uploadOne(file, { onProgress: (value) => {
      const row = rowByKey.get(item.key);
      if (row) {
        row.progress = value;
        paintUploadRow(row.key);
      }
    } }),
    onEvent: (event) => {
      const row = rowByKey.get(event.item.key);
      if (!row) return;
      if (event.status === "uploading") setRowStatus(row, { status: "uploading", progress: 0 });
      if (event.status === "done") {
        const group = groupFromUpload(event.result, event.item.file);
        if (group) {
          state.groups.set(group.imageId, mergeGroup(group));
          state.members.add(group.imageId);
          addToOrder(group.imageId);
          // 工作台上传即视为用户选择；写成员表失败时保留本地组并显示「加入」。
          api.addWorkbenchItems([group.imageId]).catch(() => state.members.delete(group.imageId));
          row.imageId = group.imageId;
          for (const duplicate of event.result?.duplicates || []) {
            if (!duplicate?.image_id) continue;
            state.duplicates.push({
              name: event.item.file.name,
              imageId: duplicate.image_id,
              ncc: Number(duplicate.ncc),
              status: duplicate.status || "suspect",
            });
          }
        }
        succeededSignatures.add(event.item.signature);
        setRowStatus(row, { status: "done", progress: 1 });
      }
      if (event.status === "error") {
        setRowStatus(row, { status: "error", message: event.error?.message || "上传失败" });
      }
    },
  });

  state.uploadBusy = false;
  const done = rows.filter((row) => row.status === "done").length;
  const failed = rows.filter((row) => row.status === "error").length;
  const skipped = rows.filter((row) => row.status === "skipped").length;
  state.lastImport = { total: rows.length, done, failed, skipped, duplicates: state.duplicates.length };
  onChange?.({ reason: "import-end" });

  if (done && failed) toast?.(`批量导入完成：${done} 张成功，${failed} 张失败。`, "warn");
  else if (done) toast?.(`批量导入完成：${done} 张已上传。${skipped ? `另有 ${skipped} 张已跳过。` : ""}`, "done");
  else if (failed) toast?.("批量导入没有成功上传任何图片，请查看每个文件的失败原因。", "warn");
  else if (skipped && plan.skipped.every((item) => item.reason === "duplicate")) {
    toast?.("这些文件已经上传成功过，没有重复提交。", "info");
  } else toast?.("没有可上传的文件：只支持 PNG / JPEG，单张不超过 20 MB。", "warn");
  return state.lastImport;
}

function mergeGroup(group) {
  const existing = state.groups.get(group.imageId);
  if (!existing) return group;
  return {
    ...existing,
    ...group,
    assets: mergeAssets(existing.assets, group.assets),
    categories: existing.categories || [],
    categoryIds: existing.categoryIds || [],
    revision: existing.revision ?? 0,
  };
}

/** 只重试失败的队列项；已成功项不会被再次提交。 */
export async function retryFailedImports({ onChange, toast } = {}) {
  const failed = state.uploads.filter((row) => row.status === "error" && row.file);
  if (!failed.length) {
    toast?.("没有失败的导入项需要重试。", "info");
    return null;
  }
  if (state.uploadBusy) {
    toast?.("正在批量导入，请稍等。", "warn");
    return null;
  }
  const items = failed.map((row) => ({ key: row.key, file: row.file, signature: row.signature }));
  state.uploadBusy = true;
  onChange?.({ reason: "retry-start" });
  await runBatchImport({
    items,
    upload: (file, item) => uploadOne(file, { onProgress: (value) => {
      const row = rowFor(state.uploads, item.key);
      if (row) {
        row.progress = value;
        paintUploadRow(row.key);
      }
    } }),
    onEvent: (event) => {
      const row = rowFor(state.uploads, event.item.key);
      if (!row) return;
      if (event.status === "uploading") setRowStatus(row, { status: "uploading", progress: 0 });
      if (event.status === "done") {
        const group = groupFromUpload(event.result, event.item.file);
        if (group) {
          state.groups.set(group.imageId, mergeGroup(group));
          state.members.add(group.imageId);
          addToOrder(group.imageId);
          // 工作台上传即视为用户选择；写成员表失败时保留本地组并显示「加入」。
          api.addWorkbenchItems([group.imageId]).catch(() => state.members.delete(group.imageId));
          row.imageId = group.imageId;
        }
        succeededSignatures.add(event.item.signature);
        setRowStatus(row, { status: "done", progress: 1 });
      }
      if (event.status === "error") setRowStatus(row, { status: "error", message: event.error?.message || "上传失败" });
      if (event.status === "skipped") setRowStatus(row, { status: "skipped", message: uploadSkipText(event.reason) });
    },
    succeeded: (signature) => succeededSignatures.has(signature),
  });
  state.uploadBusy = false;
  const done = state.uploads.filter((row) => row.status === "done").length;
  const failedLeft = state.uploads.filter((row) => row.status === "error").length;
  state.lastImport = { ...(state.lastImport || {}), done, failed: failedLeft };
  onChange?.({ reason: "retry-end" });
  toast?.(failedLeft ? `重试后仍有 ${failedLeft} 张失败。` : `重试完成：${done} 张已上传。`, failedLeft ? "warn" : "done");
  return { done, failed: failedLeft };
}

export function dismissUploadPanel() {
  state.uploadPanel = false;
}

/** 只从侧栏索引移除一个版本（工作台移除）；纹样库记录不动。 */
export function forgetGroupAsset(imageId, assetId) {
  const group = state.groups.get(imageId);
  if (!group || !assetId) return;
  group.assets = (group.assets || []).filter((asset) => asset.asset_id !== assetId);
}

/** 整组已从服务端删除：同时移出侧栏索引、成员表与折叠状态。 */
export function forgetPatternGroup(imageId) {
  if (!imageId) return false;
  const existed = state.groups.delete(imageId);
  state.members.delete(imageId);
  state.order = state.order.filter((id) => id !== imageId);
  state.collapsed.delete(imageId);
  return existed;
}

/**
 * 删除后已载入列表可能为空，但服务端还有后面几页：重读第一页，
 * 避免侧栏停在“还没有纹样”。当前会话组由 syncSessionGroup 重新补入。
 */
export function reloadBatchIndex({ onChange } = {}) {
  state.groups = new Map();
  state.members = new Set();
  state.order = [];
  state.cursor = "";
  state.nextCursor = null;
  state.loading = false;
  state.loaded = false;
  state.error = "";
  return loadWorkbenchPage({ append: false, onChange });
}

export function togglePatternGroup(imageId) {
  if (!imageId) return false;
  if (state.collapsed.has(imageId)) {
    state.collapsed.delete(imageId);
    return false;
  }
  state.collapsed.add(imageId);
  return true;
}

export function isPatternCollapsed(imageId) {
  return state.collapsed.has(imageId);
}

/* ------------------------------------------------------------------ 跨图切换 */

/**
 * 打开另一张原图：交给路由的 image 参数，由 app.applyParams → ensureSession
 * 建立新会话；不把两个原图的资产混在同一会话里。
 */
export function openPattern(imageId, api, stage = 1) {
  if (!imageId) return false;
  if (imageId === store.session.imageId) return false;
  api.go("workbench", { query: { image: imageId, stage: stage || 1 } });
  return true;
}

/** 打开某个原图组里的具体版本；当前图内直接切换，跨图走 openAsset 深链。 */
export function openPatternAsset(imageId, assetId, api, stage = 1) {
  if (!assetId) return false;
  if (imageId && imageId !== store.session.imageId) {
    api.go("workbench", { query: { image: imageId, asset: assetId, stage: stage || 1 } });
    return true;
  }
  if (store.assetById(assetId)) {
    store.setCurrentAsset(assetId);
    api.refresh();
    api.syncUrl?.();
    return true;
  }
  api.go("workbench", { query: { image: imageId || store.session.imageId, asset: assetId, stage: stage || 1 } });
  return true;
}

/* ------------------------------------------------------------------ 侧栏片段 */

const assetPreview = (asset) =>
  asset?.asset_id && !NO_PREVIEW_KINDS.has(asset.kind) ? api.assetPreviewUrl(asset.asset_id) : "";

function versionMap(assets) {
  const counts = new Map();
  for (const asset of assets) counts.set(asset.kind, (counts.get(asset.kind) || 0) + 1);
  return counts;
}

function thumbHtml(asset, { current, currentId, imageId, version, versions, inSession }) {
  const on = asset.asset_id === currentId;
  const url = assetPreview(asset);
  const label = kindLabel(asset.kind);
  const versionText = versions > 1 ? ` · v${version}` : "";
  // 当前原图组里也可能有未载入本会话的历史版本：那种缩略图必须走 openAsset
  // 深链把它重新读进会话，不能只改 currentAssetId 指向一个会话里不存在的资产。
  const useSessionAction = current && inSession;
  const removable = useSessionAction && !SESSION_BASE_KINDS.has(asset.kind);
  return `
  <li class="wb-thumb-item">
    <button class="wb-thumb" type="button" data-act="${useSessionAction ? "asset" : "pattern-asset"}"
      data-id="${esc(asset.asset_id)}" data-image="${esc(imageId)}"
      aria-current="${on ? "true" : "false"}"
      aria-label="${esc(`${label}${versionText} · ${dimsOf(asset)}${on ? " · 当前" : ""}`)}"
      title="${esc(`${label}${versionText} · ${dimsOf(asset)} · ${formatTime(asset.created_at, { withDate: true })} · ${shortId(asset.asset_id)}`)}">
      <span class="wb-thumb__plate plate plate--grain">
        ${url ? `<img class="plate__img" src="${url}" alt="" loading="lazy" decoding="async" />` : `<span class="wb-thumb__file" aria-hidden="true">${icon("file")}</span>`}
        ${versions > 1 ? `<span class="wb-thumb__ver mono">v${version}</span>` : ""}
        ${on ? `<span class="wb-thumb__now">当前</span>` : ""}
      </span>
      <span class="wb-thumb__cap">${esc(label)}</span>
    </button>
    ${removable ? `<button class="wb-thumb__del" type="button" data-act="remove-asset" data-id="${esc(asset.asset_id)}"
      aria-label="${esc(`从工作台移除 ${label}`)}" title="从工作台移除（纹样库记录保留）">${icon("close")}</button>` : ""}
  </li>`;
}

function groupThumbs(group) {
  const current = group.imageId === store.session.imageId;
  const assets = sortGroupAssets(group.assets);
  const counts = versionMap(assets);
  const seen = new Map();
  const currentId = store.session.currentAssetId;
  const sessionIds = new Set((store.session.assets || []).map((asset) => asset.asset_id));
  return assets
    .map((asset) => {
      const version = (seen.get(asset.kind) || 0) + 1;
      seen.set(asset.kind, version);
      return thumbHtml(asset, {
        current,
        currentId,
        imageId: group.imageId,
        version,
        versions: counts.get(asset.kind) || 1,
        inSession: sessionIds.has(asset.asset_id),
      });
    })
    .join("");
}

function groupBody(group) {
  if (group.loading) {
    return `<p class="bp-group__state" role="status">正在读取这张原图的处理结果…</p>`;
  }
  if (group.error) {
    return `<p class="bp-group__state bp-group__state--error" role="alert">${esc(group.error)}</p>`;
  }
  if (!group.assets.length) {
    return `<p class="bp-group__state">还没有处理结果。</p>`;
  }
  return `<ul class="wb-group__grid bp-group__grid">${groupThumbs(group)}</ul>`;
}

function groupMeta(group) {
  const bits = [`#${shortId(group.imageId)}`];
  if (group.createdAt) bits.push(formatTime(group.createdAt, { withDate: true }));
  bits.push(`${group.assets.length} 项`);
  if (group.categories?.length) bits.push(group.categories.map((entry) => entry.name).join("、"));
  return bits.join(" · ");
}

function groupHtml(group, index, selected = new Set()) {
  const collapsed = isPatternCollapsed(group.imageId);
  const current = group.imageId === store.session.imageId;
  const checked = selected.has(group.imageId);
  return `
  <section class="wb-group bp-group${current ? " is-current" : ""}${checked ? " is-selected" : ""}"
    data-pattern="${esc(group.imageId)}">
    <div class="bp-group__head">
      <label class="bp-check bp-check--group" title="选择这张纹样">
        <input type="checkbox" data-pattern-select data-image="${esc(group.imageId)}"
          aria-label="${esc(`选择 ${group.name}`)}" ${checked ? "checked" : ""} />
        <span class="bp-check__box" aria-hidden="true">${icon("check")}</span>
      </label>
      <button class="wb-group__head" type="button" data-act="pattern-toggle" data-image="${esc(group.imageId)}"
        aria-expanded="${collapsed ? "false" : "true"}"
        title="${esc(`${group.name} · ${groupMeta(group)}`)}">
        <span class="wb-group__no mono">${String(index + 1).padStart(2, "0")}</span>
        <span class="wb-group__name">${esc(group.name)}</span>
        <span class="wb-group__count mono">${group.assets.length ? `${group.assets.length} 项` : ""}</span>
        <span class="wb-group__chev" aria-hidden="true">${icon("chevron")}</span>
      </button>
      ${
        group.member
          ? ""
          : `<button class="icon-btn bp-group__add" type="button" data-act="pattern-add" data-image="${esc(group.imageId)}"
              aria-label="${esc(`把 ${group.name} 加入工作台`)}" title="加入工作台（跨刷新保留）">${icon("plus")}</button>`
      }
      <button class="icon-btn bp-group__open" type="button" data-act="pattern-open" data-image="${esc(group.imageId)}"
        aria-label="${esc(`打开原图 ${group.name}`)}" title="${current ? "当前原图" : "切换到这张原图"}">${icon("arrow")}</button>
      <button class="icon-btn bp-group__del" type="button" data-act="delete-pattern" data-image="${esc(group.imageId)}"
        data-name="${esc(group.name)}" aria-label="${esc(`删除纹样 ${group.name}`)}"
        title="删除整张纹样（含全部版本，不可恢复）">${icon("trash")}</button>
    </div>
    <p class="bp-group__meta mono">${esc(groupMeta(group))}${group.member ? "" : " · 未加入工作台"}</p>
    <div class="bp-group__body"${collapsed ? " hidden" : ""}>${groupBody(group)}</div>
  </section>`;
}

function uploadRowHtml(row) {
  return `
  <li class="bp-import__row" data-batch-row="${esc(row.key)}" data-state="${esc(row.status)}">
    <span class="bp-import__name" title="${esc(row.name)}">${esc(row.name)}</span>
    <span class="bp-import__size mono">${esc(formatBytes(row.size))}</span>
    <span class="bp-import__status" data-batch-status>${esc(row.statusText || "")}</span>
    <span class="bp-import__track" aria-hidden="true"><span class="bp-import__bar" data-batch-bar style="width:${Math.round((row.progress || 0) * 100)}%"></span></span>
    <span class="bp-import__percent mono" data-batch-percent></span>
  </li>`;
}

function uploadPanelHtml() {
  if (!state.uploadPanel) return "";
  const summary = batchSummary();
  const duplicate = duplicateSummary();
  const failed = summary.failed > 0;
  if (!state.uploads.length) return "";
  return `
  <section class="bp-import" aria-label="批量导入" data-batch-panel>
    <header class="bp-import__head">
      <span class="label">批量导入</span>
      <span class="mono">${summary.done}/${summary.total} 张完成${failed ? ` · ${summary.failed} 张失败` : ""}</span>
      <button class="icon-btn" type="button" data-act="batch-dismiss" aria-label="收起批量导入">${icon("close")}</button>
    </header>
    <ul class="bp-import__list">${state.uploads.map(uploadRowHtml).join("")}</ul>
    <div class="bp-import__acts">
      ${failed ? `<button class="btn btn--ghost btn--sm" type="button" data-act="batch-retry">重试失败项</button>` : ""}
      <button class="btn btn--primary btn--sm" type="button" data-act="batch-import"${summary.busy ? " disabled" : ""}>${icon("plus")}继续导入</button>
    </div>
    ${
      duplicate.count
        ? `<div class="bp-dupes" data-batch-dupes>
            <p class="bp-dupes__head">${icon("alert")}有 ${duplicate.count} 个上传结果与已有版本接近。已全部保留，未自动删除或合并；需要时到纹样库比对。</p>
            <ul class="bp-dupes__list">
              ${duplicate.items
                .slice(0, 6)
                .map(
                  (entry) => `<li><span class="mono">${esc(entry.name)}</span><span>已有 #${esc(shortId(entry.imageId))}</span><span class="mono">${Number.isFinite(entry.ncc) ? `${(entry.ncc * 100).toFixed(1)}%` : "—"}</span></li>`
                )
                .join("")}
              ${duplicate.count > 6 ? `<li class="mono">还有 ${duplicate.count - 6} 个未列出</li>` : ""}
            </ul>
          </div>`
        : ""
    }
  </section>`;
}

/** 工作台「纹样」列：用户选入的原图组 + 批量导入/导出入口。 */
export function patternColumnHtml({ selected = new Set() } = {}) {
  syncSessionGroup();
  const groups = batchGroups();
  const chosen = new Set((selected instanceof Set ? [...selected] : selected || []).filter(Boolean));
  const selectable = groups.map((group) => group.imageId);
  const selectedCount = selectable.filter((imageId) => chosen.has(imageId)).length;
  const allSelected = selectable.length > 0 && selectedCount === selectable.length;
  const totalAssets = groups.reduce((sum, group) => sum + group.assets.length, 0);
  return `
  <aside class="wb-assets wb-patterns" aria-label="纹样">
    <header class="wb-rail__head bp-head">
      <span class="bp-head__title">
        <span class="label">纹样</span>
        <span class="mono">${groups.length} 个原图 · ${totalAssets} 项${state.nextCursor ? "+" : ""}</span>
      </span>
      <span class="bp-head__acts">
        <button class="btn btn--ghost btn--sm" type="button" data-act="workbench-picker">${icon("plus")}添加纹样</button>
        <button class="btn btn--ghost btn--sm" type="button" data-act="process-batch"${groups.length ? "" : " disabled"}>${icon("play")}一键处理</button>
        <button class="btn btn--ghost btn--sm" type="button" data-act="batch-import"${state.uploadBusy ? " disabled" : ""}>${icon("upload")}批量导入</button>
        <button class="btn btn--ghost btn--sm" type="button" data-act="open-export"${totalAssets ? "" : " disabled"}>${icon("download")}批量导出</button>
      </span>
    </header>
    ${uploadPanelHtml()}
    ${
      groups.length
        ? `<div class="bp-selectbar" data-bp-selectbar>
            <label class="bp-check bp-check--all" title="选择工作台里的全部纹样；会先读完剩余分页">
              <input type="checkbox" data-pattern-select-all ${allSelected ? "checked" : ""}
                ${selectable.length ? "" : "disabled"} aria-label="全选工作台纹样" />
              <span class="bp-check__box" aria-hidden="true">${icon("check")}</span>
              <span class="bp-selectbar__label">全选</span>
            </label>
            <span class="bp-selectbar__count mono" data-pattern-selected-count>已选 ${selectedCount} / ${selectable.length} 个</span>
            <span class="bp-selectbar__acts">
              <button class="btn btn--quiet btn--sm" type="button" data-act="bp-remove-selected"
                ${selectedCount ? "" : "disabled"} title="只移出工作台，纹样库与文件保留">移出工作台</button>
              <button class="btn btn--quiet btn--sm bp-selectbar__del" type="button" data-act="bp-delete-selected"
                ${selectedCount ? "" : "disabled"} title="永久删除选中的原图组及全部版本">删除选中</button>
            </span>
          </div>`
        : ""
    }
    ${
      groups.length
        ? `<div class="wb-groups bp-groups">
            ${state.error ? `<p class="bp-groups__error" role="alert">${esc(state.error)}</p>` : ""}
            ${groups.map((group, index) => groupHtml(group, index, chosen)).join("")}
            ${
              state.nextCursor
                ? `<button class="btn btn--quiet btn--sm btn--block bp-groups__more" type="button" data-act="batch-more"${state.loading ? " disabled" : ""}>${state.loading ? "载入中…" : "载入更多原图"}</button>`
                : ""
            }
          </div>`
        : `<div class="wb-assets-empty bp-empty">
             <p>工作台还没有选入纹样。这里不是纹样库的镜像：挑几张进来，或直接批量导入。</p>
             <button class="btn btn--ghost btn--sm btn--block" type="button" data-act="workbench-picker">${icon("plus")}从纹样库添加</button>
             <button class="btn btn--quiet btn--sm btn--block" type="button" data-act="batch-import">${icon("upload")}批量导入</button>
           </div>`
    }
    <input class="bp-file" type="file" accept="image/png,image/jpeg" multiple data-batch-files tabindex="-1" aria-hidden="true" />
  </aside>`;
}

/* 供测试检查：不暴露可变内部对象。 */
export function batchSnapshot() {
  return {
    order: [...state.order],
    members: [...state.members],
    groups: batchGroups().map((group) => ({
      imageId: group.imageId,
      name: group.name,
      assetIds: group.assets.map((asset) => asset.asset_id),
      current: group.current,
      member: group.member,
    })),
    nextCursor: state.nextCursor,
    loading: state.loading,
    error: state.error,
    collapsed: [...state.collapsed],
    summary: batchSummary(),
    duplicates: duplicateSummary(),
  };
}

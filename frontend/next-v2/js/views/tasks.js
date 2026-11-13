/* =============================================================================
   views/tasks.js — 任务中心：本机任务索引 + 详情 + 重试/取消/打开工作台。

   数据来自 /api/v1/jobs 分页；只在视图内做筛选与排序，不另存服务端副本。
   详情与操作都使用现有接口，不自动重试云端调用；执行中的任务每 3 秒刷新。
   ============================================================================= */

import { api as http } from "../api.js";
import { icon } from "../icons.js";
import {
  dimsOf,
  escapeHtml as esc,
  formatBytes,
  formatTime,
  jobKindLabel,
  jobStateLabel,
  kindLabel,
  relativeTime,
  shortId,
  stageForJob,
} from "../format.js";

const PAGE_SIZE = 50;
const POLL_MS = 3000;
const ACTIVE = new Set(["queued", "running"]);
const ARCHIVE_KINDS = new Set(["export", "archive", "zip"]);
const STATUS_FILTERS = [
  ["all", "全部"],
  ["active", "进行中"],
  ["failed", "失败"],
  ["succeeded", "已完成"],
  ["cancelled", "已取消"],
];

let ctx = null;
let items = [];
let cursor = "";
let loading = false;
let error = "";
let selectedId = "";
let query = "";
let status = "all";
let seq = 0;
let pollTimer = null;
let searchTimer = null;
let hasLoaded = false;

/* ------------------------------------------------------------------ 纯逻辑 */

export function statusGroup(state) {
  if (state === "queued" || state === "running") return "active";
  return state === "failed" || state === "succeeded" || state === "cancelled" ? state : "other";
}

/** 任务和工作台之间的跳转目标：优先已发布产物，其次输入资产。 */
export function taskTarget(job) {
  if (!job) return null;
  const assets = Array.isArray(job.result?.assets) ? job.result.assets : [];
  const usable = assets.filter((asset) => asset?.asset_id && !ARCHIVE_KINDS.has(asset.kind));
  const asset = usable[usable.length - 1] || null;
  const assetId = asset?.asset_id || job.input_asset_id || "";
  const imageId = asset?.image_id || assets.find((entry) => entry?.image_id)?.image_id || "";
  if (!assetId && !imageId) return null;
  return {
    assetId,
    imageId,
    stage: Math.min(8, Math.max(1, Number(stageForJob(job)) || 1)),
  };
}

export function taskMatches(job, text, filter) {
  const group = statusGroup(job?.state);
  if (filter && filter !== "all" && group !== filter) return false;
  const q = String(text || "").trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    jobKindLabel(job?.kind),
    jobStateLabel(job?.state),
    job?.job_id || "",
    job?.error?.code || "",
    job?.error?.message || "",
    job?.input_asset_id || "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function taskStatusText(job) {
  return jobStateLabel(job?.state);
}

/* ------------------------------------------------------------------ 视图内状态 */

const toolIsCurrent = () => Boolean(ctx && ctx.page && ctx.page.isConnected);

function visibleJobs() {
  return items.filter((job) => taskMatches(job, query, status));
}

function selectedJob() {
  return items.find((job) => job.job_id === selectedId) || null;
}

function ensureSelection() {
  if (selectedJob()) return;
  const visible = visibleJobs();
  selectedId = visible[0]?.job_id || "";
}

function countText() {
  const visible = visibleJobs().length;
  if (!hasLoaded) return "正在读取任务…";
  if (loading && !items.length) return "正在读取任务…";
  if (error && !items.length) return "读取失败";
  if (!items.length) return "暂无任务";
  return visible === items.length ? `共 ${items.length} 条` : `筛选 ${visible} / ${items.length} 条`;
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  if (!toolIsCurrent() || !items.some((job) => ACTIVE.has(job.state))) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    if (toolIsCurrent() && !document.hidden) void loadTasks(true);
  }, POLL_MS);
}

async function loadTasks(reset) {
  if (!toolIsCurrent() || loading) return;
  const sequence = ++seq;
  loading = true;
  error = "";
  if (reset) cursor = "";
  paintSummary();
  paintList();
  try {
    const result = await http.jobs({ limit: PAGE_SIZE, cursor: reset ? "" : cursor });
    if (sequence !== seq) return;
    const incoming = Array.isArray(result?.items) ? result.items.filter((job) => job?.job_id) : [];
    if (reset) {
      items = incoming;
    } else {
      const byId = new Map(items.map((job) => [job.job_id, job]));
      for (const job of incoming) byId.set(job.job_id, job);
      items = [...byId.values()];
    }
    cursor = result?.next_cursor || "";
    error = "";
    hasLoaded = true;
    ensureSelection();
  } catch (failure) {
    if (sequence !== seq) return;
    error = failure?.message || "任务读取失败。";
    if (reset) items = [];
  } finally {
    if (sequence !== seq) return;
    loading = false;
    paintSummary();
    paintList();
    paintDetail();
    schedulePoll();
  }
}

/* ------------------------------------------------------------------ 渲染片段 */

function statusDot(state) {
  return `<span class="tk-dot tk-dot--${esc(statusGroup(state))}" aria-hidden="true"></span>`;
}

function statusChip(state) {
  return `<span class="chip tk-state tk-state--${esc(statusGroup(state))}">${esc(jobStateLabel(state))}</span>`;
}

function rowHtml(job) {
  const active = job.job_id === selectedId;
  return `<button class="tk-row${active ? " is-selected" : ""}" type="button" data-tk-job="${esc(job.job_id)}"
    role="option" aria-selected="${active}">
    ${statusDot(job.state)}
    <span class="tk-row__body">
      <span class="tk-row__kind">${esc(jobKindLabel(job.kind))}</span>
      <span class="tk-row__meta mono">#${esc(shortId(job.job_id))} · ${esc(relativeTime(job.updated_at || job.created_at))}</span>
    </span>
    <span class="tk-row__state">${esc(jobStateLabel(job.state))}</span>
  </button>`;
}

function emptyHtml() {
  if (error) {
    return `<div class="tk-empty" role="alert">
      ${icon("alert")}
      <p class="tk-empty__title">任务读取失败</p>
      <p class="tk-empty__copy">${esc(error)}</p>
      <button class="btn btn--ghost btn--sm" type="button" data-tk-act="retry-load">${icon("history")}重新读取</button>
    </div>`;
  }
  if (!items.length) {
    return `<div class="tk-empty">
      ${icon("history")}
      <p class="tk-empty__title">还没有任务</p>
      <p class="tk-empty__copy">上传纹样或运行一道工序后，处理与云端记录会出现在这里。</p>
      <button class="btn btn--primary btn--sm" type="button" data-tk-act="upload">${icon("upload")}上传纹样</button>
    </div>`;
  }
  return `<div class="tk-empty">${icon("search")}
    <p class="tk-empty__title">没有匹配的任务</p>
    <p class="tk-empty__copy">换个关键词或状态试试。</p></div>`;
}

function paintList() {
  if (!toolIsCurrent()) return;
  const list = ctx.page.querySelector("[data-tk-list]");
  if (!list) return;
  const visible = visibleJobs();
  if (loading && !hasLoaded && !items.length) {
    list.innerHTML = `<div class="tk-empty" role="status">
      <span class="tk-spinner" aria-hidden="true"></span>
      <p class="tk-empty__title">正在读取任务…</p>
      <p class="tk-empty__copy">任务记录来自本机服务 /api/v1/jobs。</p>
    </div>`;
  } else {
    list.innerHTML =
      (error && items.length
        ? `<p class="tk-error tk-error--inline" role="alert">本次刷新失败：${esc(error)}</p>`
        : "") + (visible.length ? visible.map(rowHtml).join("") : emptyHtml());
  }
  const more = ctx.page.querySelector("[data-tk-more]");
  if (more) {
    more.hidden = !cursor;
    more.disabled = loading;
    more.textContent = loading ? "读取中…" : "加载更多";
  }
  const refresh = ctx.page.querySelector("[data-tk-refresh]");
  if (refresh) refresh.disabled = loading;
}

function paintSummary() {
  if (!toolIsCurrent()) return;
  const count = ctx.page.querySelector("[data-tk-count]");
  if (count) count.textContent = countText();
}

function assetThumbs(job) {
  const assets = Array.isArray(job.result?.assets) ? job.result.assets.filter((asset) => asset?.asset_id) : [];
  if (!assets.length) return "";
  return `<div class="tk-assets">
    <p class="label tk-assets__label">产物 ${assets.length} 个</p>
    <ul class="tk-assets__list">
      ${assets
        .slice(0, 8)
        .map((asset) => {
          const previewable = !ARCHIVE_KINDS.has(asset.kind);
          return `<li class="tk-asset">
            ${previewable
              ? `<img class="tk-asset__img" src="${http.assetPreviewUrl(asset.asset_id)}" alt="" loading="lazy" />`
              : `<span class="tk-asset__img tk-asset__img--file" aria-hidden="true">${icon("file")}</span>`}
            <span class="tk-asset__copy">
              <strong>${esc(kindLabel(asset.kind))}</strong>
              <small class="mono">${esc(dimsOf(asset))}${asset.bytes ? ` · ${esc(formatBytes(asset.bytes))}` : ""}</small>
            </span>
          </li>`;
        })
        .join("")}
    </ul>
  </div>`;
}

function detailHtml(job) {
  if (!job) {
    return `<div class="tk-detail__empty">
      ${icon("history")}
      <p>在左侧选一条任务，查看详情与可执行操作。</p>
    </div>`;
  }
  const target = taskTarget(job);
  const active = ACTIVE.has(job.state);
  const failed = job.state === "failed";
  const errorCode = job.error?.code ? String(job.error.code) : "";
  const errorMessage = job.error?.message ? String(job.error.message) : "";
  return `<article class="tk-detail__body">
    <header class="tk-detail__head">
      <div class="tk-detail__title">
        <p class="eyebrow">${esc(jobKindLabel(job.kind))}</p>
        <h2>#${esc(shortId(job.job_id))}</h2>
      </div>
      ${statusChip(job.state)}
    </header>

    <dl class="kv tk-kv">
      <div class="kv__row"><dt>任务编号</dt><dd class="mono">${esc(job.job_id)}</dd></div>
      <div class="kv__row"><dt>状态</dt><dd>${esc(jobStateLabel(job.state))} · ${esc(job.state || "—")}</dd></div>
      <div class="kv__row"><dt>创建时间</dt><dd class="mono">${esc(formatTime(job.created_at, { withDate: true }))}</dd></div>
      <div class="kv__row"><dt>完成时间</dt><dd class="mono">${esc(formatTime(job.finished_at, { withDate: true }))}</dd></div>
      <div class="kv__row"><dt>尝试次数</dt><dd>第 ${Number(job.attempt || 1)} 次</dd></div>
      <div class="kv__row"><dt>输入资产</dt><dd class="mono">${job.input_asset_id ? esc("#" + shortId(job.input_asset_id)) : "—"}</dd></div>
      ${
        job.retry_of
          ? `<div class="kv__row"><dt>重试自</dt><dd class="mono">#${esc(shortId(job.retry_of))}</dd></div>`
          : ""
      }
    </dl>

    ${
      errorMessage || errorCode
        ? `<div class="tk-error" role="alert">
            <strong class="mono">${esc(errorCode || "任务失败")}</strong>
            <p>${esc(errorMessage || "任务失败，可重试。")}</p>
          </div>`
        : ""
    }

    ${assetThumbs(job)}

    <div class="tk-actions">
      ${
        target
          ? `<button class="btn btn--primary btn--sm" type="button" data-tk-act="open" data-tk-job="${esc(job.job_id)}">${icon("grid")}打开工作台</button>`
          : ""
      }
      ${
        failed
          ? `<button class="btn btn--ghost btn--sm" type="button" data-tk-act="retry" data-tk-job="${esc(job.job_id)}">${icon("history")}重试</button>`
          : ""
      }
      ${
        active
          ? `<button class="btn btn--ghost btn--sm" type="button" data-tk-act="cancel" data-tk-job="${esc(job.job_id)}">${icon("close")}取消</button>`
          : ""
      }
      <button class="btn btn--quiet btn--sm" type="button" data-tk-act="copy" data-tk-job="${esc(job.job_id)}">${icon("file")}复制编号</button>
    </div>
    <p class="tk-hint">任务记录来自本机服务；重试会新建一条任务，云端调用需重新确认费用。</p>
  </article>`;
}

function paintDetail() {
  if (!toolIsCurrent()) return;
  const detail = ctx.page.querySelector("[data-tk-detail]");
  if (!detail) return;
  detail.innerHTML = detailHtml(selectedJob());
}

/* ------------------------------------------------------------------ 操作 */

function openJob(job, api) {
  const target = taskTarget(job);
  if (!target) {
    api.toast("这个任务没有可在工作台打开的目标。", "warn");
    return;
  }
  const params = { stage: target.stage };
  if (target.assetId) params.asset = target.assetId;
  if (target.imageId) params.image = target.imageId;
  api.go("workbench", { query: params });
}

async function retryJob(job, api, button) {
  if (button) button.disabled = true;
  try {
    const result = await http.retryJob(job.job_id);
    const created = result?.job || result;
    api.toast(created?.job_id ? `已创建重试任务 #${shortId(created.job_id)}` : "已创建重试任务。", "done");
    await loadTasks(true);
    if (created?.job_id && items.some((item) => item.job_id === created.job_id)) {
      selectedId = created.job_id;
      paintList();
      paintDetail();
    }
  } catch (failure) {
    api.toast(failure?.message || "重试失败。", "warn");
    if (button) button.disabled = false;
  }
}

async function cancelJob(job, api, button) {
  if (button) button.disabled = true;
  try {
    await http.cancelJob(job.job_id);
    api.toast("已请求取消任务。", "info");
    await loadTasks(true);
  } catch (failure) {
    api.toast(failure?.message || "取消失败。", "warn");
    if (button) button.disabled = false;
  }
}

async function copyId(job, api) {
  try {
    await navigator.clipboard.writeText(job.job_id);
    api.toast("任务编号已复制。", "done");
  } catch {
    api.toast("无法写入剪贴板，请手动选择编号。", "warn");
  }
}

/* ------------------------------------------------------------------ 视图模块 */

export default {
  id: "tasks",
  title: "任务",

  render() {
    return `<div class="tk-page">
      <div class="wrap">
        <header class="tk-head">
          <div class="tk-head__text">
            <p class="eyebrow">任务 · 本机记录</p>
            <h1 class="title tk-title">任务</h1>
            <p class="lead">本机处理与云端调用记录；失败任务可重试，运行中的任务可取消。</p>
          </div>
          <div class="tk-head__acts">
            <span class="mono tk-count" data-tk-count>正在读取任务…</span>
            <button class="btn btn--ghost btn--sm" type="button" data-tk-refresh>${icon("history")}刷新</button>
          </div>
        </header>

        <div class="tk-layout">
          <aside class="tk-panel tk-index" aria-label="任务索引">
            <div class="tk-filter">
              <label class="tk-search">
                ${icon("search")}
                <input class="input" type="search" placeholder="搜索类型、编号或错误…" aria-label="搜索任务" data-tk-q
                  value="${esc(query)}" autocomplete="off" spellcheck="false" />
              </label>
              <div class="tk-chips" role="group" aria-label="按状态筛选">
                ${STATUS_FILTERS.map(
                  ([key, label]) =>
                    `<button class="chip tk-chip${status === key ? " chip--accent" : ""}" type="button"
                      data-tk-status="${key}" aria-pressed="${status === key}">${label}</button>`
                ).join("")}
              </div>
            </div>
            <div class="tk-list" data-tk-list role="listbox" aria-label="任务列表"></div>
            <div class="tk-more">
              <button class="btn btn--ghost btn--sm" type="button" data-tk-more hidden>加载更多</button>
            </div>
          </aside>
          <section class="tk-panel tk-detail" data-tk-detail aria-live="polite"></section>
        </div>
      </div>
    </div>`;
  },

  mount(root, state, api, params) {
    const page = root.querySelector(".tk-page");
    if (!page) return;
    ctx = { page, api };
    hasLoaded = false;
    error = "";
    query = "";
    status = "all";
    items = [];
    cursor = "";
    selectedId = "";
    const wanted = params?.get?.("job") || "";
    if (wanted) selectedId = wanted;

    page.addEventListener("click", (event) => {
      const jobRow = event.target.closest("[data-tk-job]");
      if (jobRow) {
        const act = event.target.closest("[data-tk-act]")?.dataset.tkAct || "";
        const job = items.find((item) => item.job_id === jobRow.dataset.tkJob);
        if (!act && job) {
          selectedId = job.job_id;
          // 只改选中态，不重绘列表，键盘焦点留在刚点的行上。
          page.querySelectorAll(".tk-row[data-tk-job]").forEach((row) => {
            const on = row.dataset.tkJob === selectedId;
            row.classList.toggle("is-selected", on);
            row.setAttribute("aria-selected", String(on));
          });
          paintDetail();
          return;
        }
      }
      const action = event.target.closest("[data-tk-act]");
      if (!action) return;
      const act = action.dataset.tkAct;
      if (act === "retry-load") {
        void loadTasks(true);
        return;
      }
      if (act === "upload") {
        api.closeDrawer();
        document.querySelector('[data-action="upload"]')?.click();
        return;
      }
      const job = items.find((item) => item.job_id === action.dataset.tkJob);
      if (!job) return;
      if (act === "open") openJob(job, api);
      else if (act === "retry") void retryJob(job, api, action);
      else if (act === "cancel") void cancelJob(job, api, action);
      else if (act === "copy") void copyId(job, api);
    });

    page.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-tk-status]");
      if (!chip) return;
      status = chip.dataset.tkStatus || "all";
      ensureSelection();
      page.querySelectorAll("[data-tk-status]").forEach((button) => {
        const on = button.dataset.tkStatus === status;
        button.classList.toggle("chip--accent", on);
        button.setAttribute("aria-pressed", String(on));
      });
      paintSummary();
      paintList();
      paintDetail();
    });

    page.querySelector("[data-tk-refresh]")?.addEventListener("click", () => void loadTasks(true));
    page.querySelector("[data-tk-more]")?.addEventListener("click", () => void loadTasks(false));
    const search = page.querySelector("[data-tk-q]");
    if (search) {
      search.addEventListener("input", () => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          searchTimer = null;
          if (!toolIsCurrent()) return;
          query = search.value;
          ensureSelection();
          paintSummary();
          paintList();
          paintDetail();
        }, 220);
      });
      search.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !search.value) return;
        event.stopPropagation();
        search.value = "";
        query = "";
        ensureSelection();
        paintSummary();
        paintList();
        paintDetail();
      });
    }

    document.addEventListener("visibilitychange", onVisibility);
    paintList();
    paintDetail();
    void loadTasks(true);
  },

  unmount() {
    if (pollTimer) clearTimeout(pollTimer);
    if (searchTimer) clearTimeout(searchTimer);
    pollTimer = null;
    searchTimer = null;
    document.removeEventListener("visibilitychange", onVisibility);
    ctx = null;
    seq += 1;
    loading = false;
  },
};

function onVisibility() {
  if (!toolIsCurrent() || document.hidden) return;
  if (items.some((job) => ACTIVE.has(job.state))) void loadTasks(true);
}

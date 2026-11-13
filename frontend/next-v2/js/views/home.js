/* =============================================================================
   views/home.js — 首页：真实成果图版、七道工序导览、最近成果、本地/云端边界。
   数据来自 store（/api/v1），没有演示数据；工序卡与导览的配图是 assets/demo 的样例。
   ============================================================================= */

import { STAGES } from "../data.js";
import { icon } from "../icons.js";
import { sampleFor } from "../samples.js";
import { medallionGhost } from "../motifs.js";
import { drawLineArt, whenVisible } from "../motion.js";
import { store } from "../store.js";
import {
  dimsOf,
  formatTime,
  gradeLabel,
  jobKindLabel,
  jobStateLabel,
  kindLabel,
  relativeTime,
  shortId,
  escapeHtml,
  stageForJob,
  stageForKind,
} from "../format.js";

const FLOW_ICONS = ["image", "crop", "flask", "layers", "mask", "brush", "tile"];

/* ------------------------------------------------------------------ 当前进度

   首页的高亮跟着真实进度走，不写死在某一工序：
   - 「已完成」看这张图已经产出的资产与成功的任务；
   - 「最近一步」先看正在跑的任务，再看用户刚停下的工序（store.lastStage），
     最后才回落到当前资产与任务类型。
   会话只在内存里：刷新后没有会话，自动退到最近成果/最近任务的数据。 */

/** 正在处理的那张图的资产：会话里的资产，加上最近成果里同一张图的其它版本。 */
function workAssets() {
  const session = store.session;
  const recent = store.recentAssets || [];
  const imageId = session?.imageId || recent[0]?.image_id || "";
  const sameImage = imageId ? recent.filter((asset) => asset.image_id === imageId) : [];
  const seen = new Set();
  const merged = [];
  for (const asset of [...(session?.assets || []), ...sameImage]) {
    if (!asset?.asset_id || seen.has(asset.asset_id)) continue;
    seen.add(asset.asset_id);
    merged.push(asset);
  }
  return merged.length ? merged : recent.slice(0, 1);
}

function currentStageNo(assets) {
  const session = store.session;
  const running = stageForJob(session?.activeJob);
  if (running) return running;
  if (store.lastStage) return store.lastStage;
  const current = assets.find((asset) => asset.asset_id === session?.currentAssetId);
  if (current) return stageForKind(current.kind);
  const reached = Math.max(0, ...assets.map((asset) => stageForKind(asset.kind)));
  return Math.max(stageForJob(store.recentJobs[0]), reached);
}

/** 这张图走过哪些工序，以及最近一步停在哪一道。 */
function progress() {
  const assets = workAssets();
  const done = new Set(assets.map((asset) => stageForKind(asset.kind)));
  // 只有会话里的任务确定属于这张图；全局的最近任务可能来自别的纹样，不计入完成度。
  for (const job of store.session?.jobs || []) {
    if (job?.state !== "succeeded") continue;
    const reached = stageForJob(job);
    if (reached) done.add(reached);
  }
  return { current: currentStageNo(assets), done };
}

/** 进度指纹：只有它变了才值得整页重绘，避免同一页里无谓地闪一下。 */
function progressKey() {
  const { current, done } = progress();
  const job = store.recentJobs[0];
  return [current, [...done].sort((a, b) => a - b).join(","), job?.job_id || "", job?.state || ""].join("|");
}

function hasPreview(asset) {
  return Boolean(asset) && !["export", "archive", "zip"].includes(asset.kind);
}

function previewOf(asset) {
  return hasPreview(asset) ? `/api/v1/assets/${encodeURIComponent(asset.asset_id)}/preview` : "";
}

function thumbMarkup(asset, { eager = false } = {}) {
  const src = previewOf(asset);
  if (src) {
    return `<img class="plate__img" src="${src}" alt="${escapeHtml(kindLabel(asset.kind))}预览" ${
      eager ? "" : 'loading="lazy"'
    } />`;
  }
  return `<span class="recent__placeholder" aria-hidden="true">${icon("file")}</span>`;
}

function kv(rows) {
  return `<dl class="kv">${rows
    .map(([key, value]) => `<div class="kv__row"><dt>${key}</dt><dd>${value}</dd></div>`)
    .join("")}</dl>`;
}

/* ------------------------------------------------------------------ 接着上次 */

function renderResume(api) {
  const job = store.recentJobs[0];
  const asset = store.recentAssets.find((item) => hasPreview(item)) || null;
  if (!job && !asset) {
    return `
      <div class="resume card" data-reveal data-spotlight>
        <div class="resume__thumb">
          <div class="plate plate--grain resume__plate-empty">
            <span class="mono">为空</span>
          </div>
        </div>
        <div class="resume__main">
          <div class="resume__top">
            <p class="label">开始</p>
            <span class="resume__time">还没有处理记录</span>
          </div>
          <h2 class="resume__name">从一张原图开始</h2>
          <p class="resume__note">上传 PNG 或 JPEG，保留原件后即可裁切、提取与矢量化。</p>
          <div class="resume__actions">
            <button class="btn btn--primary" type="button" data-upload>上传纹样 ${icon("upload")}</button>
            <a class="btn btn--ghost btn--sm" href="#/library">去纹样库挑一件</a>
          </div>
        </div>
      </div>
    `;
  }
  const { current } = progress();
  const stageNo = current || 1;
  const stageInfo = STAGES[stageNo - 1] || STAGES[0];
  const running = store.session?.activeJob;
  const note =
    running && running.kind
      ? `正在跑「${escapeHtml(jobKindLabel(running.kind))}」，停在第 ${stageNo} 道工序「${escapeHtml(stageInfo.name)}」。`
      : job
        ? `最近任务「${escapeHtml(jobKindLabel(job.kind))}」${escapeHtml(jobStateLabel(job.state))}；当前在第 ${stageNo} 道工序「${escapeHtml(stageInfo.name)}」。`
        : `当前在第 ${stageNo} 道工序「${escapeHtml(stageInfo.name)}」。`;
  return `
    <div class="resume card" data-reveal data-spotlight>
      <div class="resume__thumb">
        <div class="plate plate--grain">
          ${asset ? thumbMarkup(asset, { eager: true }) : ""}
        </div>
      </div>
      <div class="resume__main">
        <div class="resume__top">
          <p class="label">接着上次</p>
          <span class="resume__time">最近 ${job ? relativeTime(job.updated_at) : relativeTime(asset?.created_at)}</span>
        </div>
        <h2 class="resume__name">${
          asset ? escapeHtml(kindLabel(asset.kind)) : escapeHtml(jobKindLabel(job.kind))
        }${asset ? ` <span class="mono">${shortId(asset.asset_id)}</span>` : ""}</h2>
        <p class="resume__note">${note}</p>
        <ol class="resume__steps" aria-label="七道工序进度">
          ${STAGES.map(
            (s, i) => `<li class="resume__step ${i + 1 < stageNo ? "is-done" : ""} ${i + 1 === stageNo ? "is-current" : ""}">
              <span class="resume__step-dot"></span>
              <span class="resume__step-label">${s.name}</span>
            </li>`
          ).join("")}
        </ol>
      </div>
      <div class="resume__side">
        <button class="btn btn--primary" type="button" data-resume ${asset ? `data-asset="${asset.asset_id}"` : ""} data-magnetic>
          继续处理 ${icon("arrow")}
        </button>
        <button class="btn btn--ghost btn--sm" type="button" data-recent-jobs>最近任务</button>
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ 七道工序 */

function renderFlow() {
  const { current, done } = progress();
  return `
    <div class="flow">
      ${STAGES.map((s, i) => {
        const n = i + 1;
        const sample = sampleFor(s);
        const status = n === current ? "最近一步" : done.has(n) ? "已完成" : "待开始";
        return `
        <button class="flow__card card card--hover ${n === current ? "is-current" : ""}"
          type="button" data-stage="${n}" data-spotlight data-reveal style="--i:${i}"
          aria-label="第 ${n} 道工序：${s.name} · ${s.title}，${status}">
          <span class="flow__top">
            <span class="flow__no">${s.n}</span>
            ${icon(FLOW_ICONS[i])}
          </span>
          <span class="flow__plate plate plate--grain">
            <img class="plate__img" src="${sample.src}" alt="${escapeHtml(sample.alt)}" loading="lazy" decoding="async" />
          </span>
          <span class="flow__name">${s.name}</span>
          <span class="flow__title">${s.title}</span>
          <span class="flow__note">${s.note}</span>
          <span class="flow__state">
            <span class="dot ${n === current ? "dot--cinnabar" : done.has(n) ? "" : "dot--idle"}"></span>${status}
          </span>
        </button>`;
      }).join("")}
      <div class="flow__summary card" data-reveal style="--i:7">
        <p class="label">云端调用</p>
        <p class="flow__summary-num">${store.seedream?.budget?.call_count ?? 0} <span class="flow__summary-unit">次</span></p>
        <p class="flow__summary-copy">只有 04 候选层与 06 局部修复会调用云端。</p>
        <p class="flow__summary-foot">调用次数只作记录。</p>
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ 最近成果 */

function specimenCard(asset, index) {
  return `
    <button class="recent__item" type="button" data-asset="${asset.asset_id}" data-reveal style="--i:${index}" data-spotlight>
      <span class="recent__plate plate">
        ${thumbMarkup(asset)}
        <span class="recent__grade"><span class="stamp stamp--${(asset.grade || "U").toLowerCase()}">${asset.grade || "—"}</span></span>
        <span class="recent__hover">
          <span class="recent__hover-row">${escapeHtml(kindLabel(asset.kind))} · ${escapeHtml(gradeLabel(asset.grade))}</span>
          <span class="recent__hover-row mono">${escapeHtml(dimsOf(asset))} · ${escapeHtml(relativeTime(asset.created_at))}</span>
          <span class="recent__hover-cta">查看档案 ${icon("arrow")}</span>
        </span>
      </span>
      <span class="recent__meta">
        <span class="recent__name">${escapeHtml(kindLabel(asset.kind))}</span>
        <span class="recent__sub">${shortId(asset.asset_id)} · ${escapeHtml(dimsOf(asset))} · ${escapeHtml(formatTime(asset.created_at))}</span>
      </span>
    </button>
  `;
}

function renderRecent() {
  const assets = store.recentAssets || [];
  if (!assets.length) {
    return `<p class="recent__empty">还没有成果。处理一张图后，结果会按时间出现在这里，也会收进纹样库。</p>`;
  }
  return `<div class="recent">${assets.map(specimenCard).join("")}</div>`;
}

/* ------------------------------------------------------------------ 本地与云端 */

function renderGate() {
  const seedream = store.seedream;
  const blockers = seedream?.blockers || [];
  const budget = seedream?.budget;
  const enabled = Boolean(seedream?.enabled);
  const total = store.dataset?.total_images ?? "—";
  return `
    <div class="gate">
      <article class="gate__card card" data-reveal data-spotlight>
        <div class="gate__head">
          <span class="gate__icon">${icon("cpu")}</span>
          <div>
            <h3 class="h3">本机流程</h3>
            <p class="gate__kicker">01–03、05、07 在本机完成</p>
          </div>
        </div>
        <ul class="gate__list">
          <li>${icon("check")} 可导出 SVG、PNG 或整包 ZIP</li>
          <li>${icon("check")} 每一步的产物都能作为下一步的输入</li>
        </ul>
        <div class="gate__stats">
          <div><strong class="num">${total}</strong><span>张图片</span></div>
          <div><strong class="num">${store.recentAssets.length}</strong><span>项已完成</span></div>
          <div><strong class="num">${budget?.call_count ?? 0}</strong><span>次云端调用</span></div>
        </div>
        <div class="gate__pipe" aria-hidden="true">
          <span class="gate__node">原图</span>
          <span class="gate__link"></span>
          <span class="gate__node">透明 PNG</span>
          <span class="gate__link"></span>
          <span class="gate__node">矢量</span>
          <span class="gate__link"></span>
          <span class="gate__node gate__node--accent">SVG</span>
        </div>
      </article>

      <article class="gate__card gate__card--cloud card" data-reveal data-spotlight>
        <div class="gate__head">
          <span class="gate__icon gate__icon--accent">${icon("cloud")}</span>
          <div>
            <h3 class="h3">云端生成</h3>
            <p class="gate__kicker">用于 04 候选层与 06 局部修复</p>
          </div>
          <span class="chip ${enabled ? "chip--jade" : "chip--gold"} gate__chip">${enabled ? "已开通" : "未开通"}</span>
        </div>
        <div class="gate__budget">
          <p class="gate__budget-note">已调用 ${budget?.call_count ?? 0} 次</p>
        </div>
        ${
          blockers.length
            ? `<ul class="gate__list gate__list--small"><li>${icon("alert")} 云端尚未就绪，到设置里完成配置即可调用。</li></ul>`
            : `<ul class="gate__list gate__list--small">
                 <li>${icon("flask")} 每次调用前勾选上传与调用确认</li>
               </ul>`
        }
        <a class="btn btn--paper btn--sm gate__cta" href="#/settings">配置云端 ${icon("arrow")}</a>
      </article>
    </div>
  `;
}

/* ------------------------------------------------------------------ 视图 */

export default {
  id: "home",
  title: "首页",

  render(state, api) {
    const latest = store.recentAssets.find((asset) => hasPreview(asset)) || null;
    const job = store.recentJobs[0];
    const dataset = store.dataset;

    return `
      <div class="home">
        <section class="hero" data-pointer-glow>
          <div class="hero__ghost" aria-hidden="true" data-parallax="0.05">${medallionGhost()}</div>
          <div class="wrap hero__inner">
            <div class="hero__copy">
              <p class="eyebrow" data-reveal style="--i:0">纹样提取 · 矢量化 · 平铺检查</p>
              <h1 class="display hero__title" data-reveal style="--i:1">
                上传纹样，<br />导出<em>可编辑 SVG</em>。
              </h1>
              <p class="lead hero__lead" data-reveal style="--i:2">
                自动去底、提线稿、生成矢量、检查平铺接缝；<br />参数可调，每步产物独立。
              </p>
              <div class="hero__actions" data-reveal style="--i:3">
                <a class="btn btn--primary" href="#/workbench" data-magnetic>
                  打开工作台 ${icon("arrow")}
                </a>
                <button class="btn btn--ghost" type="button" data-open-tour>
                  ${icon("play")} 看七道工序
                </button>
              </div>
            </div>

            <div class="hero__stage" data-reveal style="--i:2">
              <div class="specimen">
                <div class="specimen__mat">
                  ${
                    latest
                      ? `<div class="specimen__single plate plate--grain">
                           ${thumbMarkup(latest, { eager: true })}
                           <span class="specimen__seal" aria-hidden="true">样</span>
                         </div>`
                      : `<div class="specimen__single specimen__single--empty" role="img" aria-label="还没有可展示的成果">
                           <span class="mono">还没有成果</span>
                         </div>`
                  }
                </div>
                <div class="specimen__caption">
                  <div class="specimen__caption-main">
                    <p class="specimen__name">${latest ? escapeHtml(kindLabel(latest.kind)) : "纹样工作台"}</p>
                    <p class="mono">${
                      latest
                        ? `${shortId(latest.asset_id)} · ${escapeHtml(dimsOf(latest))} · ${escapeHtml(formatTime(latest.created_at, { withDate: true }))}`
                        : "上传后，最近的成果会显示在这里"
                    }</p>
                  </div>
                  <div class="specimen__caption-side">
                    ${latest ? `<span class="stamp stamp--${(latest.grade || "U").toLowerCase()}">${latest.grade || "—"}</span>` : ""}
                    <span class="mono">${latest ? escapeHtml(kindLabel(latest.kind)) : "—"}</span>
                  </div>
                </div>
              </div>

              ${
                job
                  ? `<p class="hero__drag-hint">最近任务：${escapeHtml(jobKindLabel(job.kind))} · ${escapeHtml(jobStateLabel(job.state))} · ${escapeHtml(relativeTime(job.updated_at))}</p>`
                  : `<p class="hero__drag-hint">上传或打开纹样后，可从任意一道工序继续</p>`
              }
            </div>
          </div>
        </section>

        <div class="ticker" aria-hidden="true">
          <div class="ticker__track">
            ${Array.from({ length: 2 }, () =>
              STAGES.map(
                (s) => `<span class="ticker__item"><span class="ticker__no">${s.n}</span>${s.title}<span class="ticker__dot">·</span></span>`
              ).join("")
            ).join("")}
            <span class="ticker__item ticker__item--accent">可编辑 SVG<span class="ticker__dot">·</span></span>
            <span class="ticker__item ticker__item--accent">每步独立产物<span class="ticker__dot">·</span></span>
          </div>
        </div>

        <section class="section section--tight">
          <div class="wrap">
            ${renderResume(api)}
          </div>
        </section>

        <section class="section" id="flow">
          <div class="wrap">
            <header class="sec-head">
              <div class="sec-head__main">
                <span class="sec-head__no">二 · 七道工序</span>
                <h2 class="section-title">七步，从原图到矢量</h2>
              </div>
              <p class="sec-head__aside">每一步都能单独重跑。</p>
            </header>
            ${renderFlow()}
          </div>
        </section>

        <section class="section">
          <div class="wrap">
            <header class="sec-head">
              <div class="sec-head__main">
                <span class="sec-head__no">三 · 成果</span>
                <h2 class="section-title">最近成果</h2>
              </div>
              <p class="sec-head__aside">
                ${dataset ? `共 ${dataset.total_images} 张图片 · A 级 ${dataset.grades?.A ?? 0} · 重复内容 ${dataset.duplicate_content_ids ?? 0}` : "正在读取数据"}
                <a class="sec-head__link" href="#/library">去纹样库看全部 ${icon("arrow")}</a>
              </p>
            </header>
            ${renderRecent()}
          </div>
        </section>

        <section class="section">
          <div class="wrap">
            <header class="sec-head">
              <div class="sec-head__main">
                <span class="sec-head__no">四 · 云端</span>
                <h2 class="section-title">云端生成</h2>
              </div>
              <p class="sec-head__aside">只在 04 与 06 使用云端。</p>
            </header>
            ${renderGate()}
          </div>
        </section>

        <section class="section section--closing">
          <div class="wrap wrap--tight">
            <div class="closing" data-reveal>
              <p class="eyebrow">工作方式</p>
              <h2 class="title closing__title">每一步都出独立产物。</h2>
              <p class="copy">每道工序的结果是一个新资产；换参数重跑会生成新版本，旧版本仍留在会话与纹样库里。云端生成（04 / 06）每次调用前都要勾选确认。</p>
              <div class="closing__actions">
                <button class="btn btn--primary" type="button" data-upload data-magnetic>
                  从上传纹样开始 ${icon("arrow")}
                </button>
                <a class="btn btn--ghost" href="#/notes">使用说明</a>
                <span class="closing__meta">导出 SVG / PNG / ZIP</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    `;
  },

  mount(root, state, api, params) {
    const ghost = root.querySelector(".medallion-ghost");
    whenVisible(ghost, () => drawLineArt(ghost, { delay: 220 }), { threshold: 0.2 });

    const stale = (at) => !at || Date.now() - at > 15000;
    if (stale(store.recentLoadedAt)) store.loadRecent().then(() => api.refresh());
    if (stale(store.datasetLoadedAt)) store.loadDataset().then(() => api.refresh());

    // 会话、任务或最近成果一变就重算高亮；进度没变不重绘，避免同一页里闪一下。
    // 导览浮层打开时不重绘：整页重绘会把浮层换掉，打断阅读。
    let painted = progressKey();
    homeUnsubscribe = store.subscribe((reason) => {
      if (reason === "settings") {
        api.refresh();
        return;
      }
      if (!LIVE_REASONS.has(reason)) return;
      if (tourEl && !tourEl.hidden) return;
      const next = progressKey();
      if (next === painted) return;
      painted = next;
      scheduleRefresh(api);
    });

    root.querySelectorAll("[data-stage]").forEach((card) => {
      card.addEventListener("click", () => {
        api.go("workbench", { query: { stage: card.dataset.stage } });
      });
    });

    root.querySelectorAll("[data-upload]").forEach((button) => {
      button.addEventListener("click", () => document.querySelector('[data-action="upload"]')?.click());
    });

    root.querySelectorAll("[data-asset]").forEach((card) => {
      card.addEventListener("click", () => openAsset(card.dataset.asset, api));
    });

    root.querySelector("[data-resume]")?.addEventListener("click", async (event) => {
      const assetId = event.currentTarget.dataset.asset;
      if (!assetId) {
        api.go("workbench", { query: { stage: 1 } });
        return;
      }
      try {
        const opened = await store.openAsset(assetId);
        if (!opened) return;
        const { asset, stage } = opened;
        api.go("workbench", { query: { image: asset.image_id, asset: asset.asset_id, stage } });
      } catch (error) {
        api.toast(error?.message || "打开资产失败", "warn");
      }
    });

    root.querySelector("[data-recent-jobs]")?.addEventListener("click", () => openJobs(api));

    root.querySelectorAll("[data-open-tour]").forEach((button) => {
      button.addEventListener("click", () => openTour(api, Math.max(0, progress().current - 1)));
    });
    initTour(api);

    if (params && params.get("tour")) {
      history.replaceState(null, "", "#/home");
      openTour(api, Math.max(0, progress().current - 1));
    }
  },

  unmount() {
    homeUnsubscribe?.();
    homeUnsubscribe = null;
    clearRefreshTimer();
    closeTour();
    tourEl?.remove();
    tourEl = null;
  },
};

let homeUnsubscribe = null;

/* 会改变首页高亮的 store 事件；设置变化单独整页重绘（云端卡要更新）。 */
const LIVE_REASONS = new Set(["session", "job-start", "job-end", "recent"]);

let refreshTimer = null;

/** 合并同一轮里连续到来的事件，最多晚 120ms 重绘一次。 */
function scheduleRefresh(api) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    api.refresh();
  }, 120);
}

function clearRefreshTimer() {
  if (!refreshTimer) return;
  clearTimeout(refreshTimer);
  refreshTimer = null;
}

/* ------------------------------------------------------------------ 工序导览浮层 */

let tourEl = null;
let tourIndex = 0;
let tourKeyHandler = null;
let tourReturnFocus = null;

function tourMarkup() {
  return `
    <div class="tour" id="flow-tour" role="dialog" aria-modal="true" aria-labelledby="tour-title" hidden>
      <div class="tour__scrim" data-tour-close></div>
      <div class="tour__panel" tabindex="-1">
        <header class="tour__head">
          <div>
            <p class="eyebrow">七道工序导览</p>
            <h2 class="tour__title" id="tour-title">七步，从原图到可编辑 SVG</h2>
          </div>
          <button class="icon-btn tour__close" type="button" data-tour-close aria-label="关闭导览">${icon("close")}</button>
        </header>
        <div class="tour__body">
          <ol class="tour__steps" aria-label="七道工序">
            ${STAGES.map(
              (s, i) => `
              <li>
                <button class="tour__step" type="button" data-tour-step="${i}">
                  <span class="tour__step-no">${s.n}</span>
                  <span class="tour__step-name">${s.name}</span>
                  <span class="tour__step-title">${s.title}</span>
                </button>
              </li>`
            ).join("")}
          </ol>
          <div class="tour__stage">
            <div class="plate plate--grain tour__plate">
              <img class="plate__img" id="tour-img" src="${sampleFor(STAGES[0]).src}" alt="${escapeHtml(
                sampleFor(STAGES[0]).alt
              )}" decoding="async" />
            </div>
            <div class="tour__meta">
              <p class="tour__no" id="tour-no">第 1 道工序</p>
              <h3 class="tour__name" id="tour-name">来源 · 放入纹样</h3>
              <p class="tour__desc" id="tour-desc"></p>
              <p class="tour__state" id="tour-state"></p>
            </div>
          </div>
        </div>
        <footer class="tour__foot">
          <p class="tour__progress"><span id="tour-count">1</span> / 7</p>
          <div class="tour__actions">
            <button class="btn btn--ghost btn--sm" type="button" data-tour-prev>上一道</button>
            <button class="btn btn--ghost btn--sm" type="button" data-tour-next>下一道</button>
            <button class="btn btn--primary btn--sm" type="button" data-tour-jump>去工作台做这一步 ${icon("arrow")}</button>
          </div>
        </footer>
      </div>
    </div>
  `;
}

function initTour(api) {
  closeTour();
  tourEl?.remove();
  const host = document.createElement("div");
  host.innerHTML = tourMarkup();
  tourEl = host.firstElementChild;
  document.querySelector(".app")?.append(tourEl);

  tourEl.querySelectorAll("[data-tour-close]").forEach((btn) => btn.addEventListener("click", closeTour));
  tourEl.querySelectorAll("[data-tour-step]").forEach((btn) => {
    btn.addEventListener("click", () => paintTour(Number(btn.dataset.tourStep)));
  });
  tourEl.querySelector("[data-tour-prev]")?.addEventListener("click", () => paintTour(tourIndex - 1));
  tourEl.querySelector("[data-tour-next]")?.addEventListener("click", () => paintTour(tourIndex + 1));
  tourEl.querySelector("[data-tour-jump]")?.addEventListener("click", () => {
    const stage = STAGES[tourIndex];
    const stageNo = tourIndex + 1;
    closeTour();
    api.go("workbench", { query: { stage: stageNo } });
    api.toast(`已切到第 ${stageNo} 道工序：${stage.name} · ${stage.title}`, "done");
  });
}

function openTour(api, index = 0) {
  if (!tourEl) initTour(api);
  tourIndex = Math.max(0, Math.min(STAGES.length - 1, index));
  paintTour(tourIndex);
  tourReturnFocus = document.activeElement;
  tourEl.hidden = false;
  requestAnimationFrame(() => {
    tourEl.classList.add("is-open");
    scrollActiveStep();
  });
  tourEl.querySelector(".tour__panel")?.focus({ preventScroll: true });
  document.documentElement.style.overflow = "hidden";
  tourKeyHandler = (event) => {
    if (event.key === "Escape") {
      closeTour();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      paintTour(tourIndex - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      paintTour(tourIndex + 1);
    } else if (event.key === "Tab") {
      const focusables = [...tourEl.querySelectorAll("button, [href]")].filter((node) => node.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === tourEl.querySelector(".tour__panel"))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener("keydown", tourKeyHandler);
}

function paintTour(index) {
  tourIndex = (index + STAGES.length) % STAGES.length;
  const stage = STAGES[tourIndex];
  tourEl.querySelectorAll("[data-tour-step]").forEach((btn) => {
    const active = Number(btn.dataset.tourStep) === tourIndex;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-current", active ? "step" : "false");
    if (active) btn.scrollIntoView({ block: "nearest", inline: "center" });
  });
  tourEl.querySelector("#tour-no").textContent = `第 ${tourIndex + 1} 道工序`;
  tourEl.querySelector("#tour-name").textContent = `${stage.name} · ${stage.title}`;
  tourEl.querySelector("#tour-desc").textContent = stage.desc;
  tourEl.querySelector("#tour-state").textContent = `状态：${stage.note}`;
  const sample = sampleFor(stage);
  const image = tourEl.querySelector("#tour-img");
  if (image) {
    image.src = sample.src;
    image.alt = sample.alt;
  }
  tourEl.querySelector("#tour-count").textContent = String(tourIndex + 1);
  tourEl.querySelector("[data-tour-prev]").disabled = tourIndex === 0;
  tourEl.querySelector("[data-tour-next]").disabled = tourIndex === STAGES.length - 1;
}

function scrollActiveStep() {
  const active = tourEl?.querySelector(".tour__step.is-active");
  if (active) active.scrollIntoView({ block: "nearest", inline: "center" });
}

function closeTour() {
  if (tourEl) {
    tourEl.classList.remove("is-open");
    tourEl.hidden = true;
  }
  if (tourKeyHandler) document.removeEventListener("keydown", tourKeyHandler);
  tourKeyHandler = null;
  document.documentElement.style.overflow = "";
  if (tourReturnFocus && tourReturnFocus.isConnected) tourReturnFocus.focus({ preventScroll: true });
  tourReturnFocus = null;
}

/* ------------------------------------------------------------------ 抽屉 */

async function openAsset(assetId, api) {
  let asset = store.assetById(assetId);
  try {
    if (!asset) asset = await api.http.asset(assetId);
  } catch (error) {
    api.toast(error?.message || "读取资产失败", "warn");
    return;
  }
  const preview = hasPreview(asset)
    ? `<div class="drawer-plate plate plate--grain"><img class="plate__img" src="${api.http.assetPreviewUrl(asset.asset_id)}" alt="${escapeHtml(kindLabel(asset.kind))}预览" /></div>`
    : "";
  api.drawer({
    title: kindLabel(asset.kind),
    meta: `${shortId(asset.asset_id)} · ${formatTime(asset.created_at, { withDate: true })}`,
    body: `
      ${preview}
      ${kv([
        ["尺寸", `${escapeHtml(dimsOf(asset))} px`],
        ["等级", escapeHtml(gradeLabel(asset.grade))],
        ["许可证", escapeHtml(asset.license || "未登记")],
        ["来源", escapeHtml(asset.source_name || asset.source_type || "未登记")],
        ["内容 ID", `<span class="mono">${escapeHtml(asset.content_id || "—")}</span>`],
        ["任务", `<span class="mono">${escapeHtml(shortId(asset.generated_by_job_id || "—"))}</span>`],
      ])}
      <div class="drawer-actions">
        <button class="btn btn--primary btn--sm" type="button" data-drawer-open>在工作台打开</button>
        <a class="btn btn--ghost btn--sm" href="${api.http.assetDownloadUrl(asset.asset_id)}" download>下载原文件</a>
        <a class="btn btn--ghost btn--sm" href="#/library">去纹样库</a>
      </div>
      <p class="drawer-foot">字段来自本机资产记录；下载直接读取 storage/api 里的文件。</p>
    `,
  });
  document.querySelector("[data-drawer-open]")?.addEventListener("click", async () => {
    api.closeDrawer();
    try {
      const opened = await store.openAsset(asset.asset_id);
      if (!opened) return;
      api.go("workbench", { query: { image: opened.asset.image_id, asset: opened.asset.asset_id, stage: opened.stage } });
    } catch (error) {
      api.toast(error?.message || "打开工作台失败", "warn");
    }
  });
}

async function openJobs(api) {
  let jobs = store.recentJobs;
  if (!jobs.length) {
    try {
      jobs = (await api.http.jobs({ limit: 20 })).items || [];
    } catch (error) {
      api.toast(error?.message || "读取任务失败", "warn");
      return;
    }
  }
  const rows = jobs
    .map(
      (job) => `
      <div class="job-row">
        <span class="job-row__kind">${escapeHtml(jobKindLabel(job.kind))}</span>
        <span class="job-row__state">${escapeHtml(jobStateLabel(job.state))}</span>
        <span class="job-row__time mono">${escapeHtml(relativeTime(job.updated_at))}</span>
        <span class="job-row__id mono">${shortId(job.job_id)}</span>
      </div>`
    )
    .join("");
  api.drawer({
    title: "最近任务",
    meta: `${jobs.length} 条 · 本机任务队列与历史`,
    body: `<div class="job-list">${rows || "<p class='drawer-lead'>还没有任务记录。</p>"}</div>
      <p class="drawer-foot">失败或取消的任务保留错误信息。</p>`,
  });
}

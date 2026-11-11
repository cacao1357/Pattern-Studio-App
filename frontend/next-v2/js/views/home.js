/* =============================================================================
   views/home.js — 首页：真实成果图版、七道工序导览、最近成果、本地/云端边界。
   数据来自 store（/api/v1），没有演示数据；导览只作流程说明，不假装有图。
   ============================================================================= */

import { STAGES } from "../data.js";
import { icon } from "../icons.js";
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
  blockerLabel,
  escapeHtml,
} from "../format.js";

const FLOW_ICONS = ["image", "crop", "flask", "layers", "mask", "brush", "tile"];

const JOB_STAGE = {
  crop: 2,
  "working-copy": 2,
  prepare: 2,
  enhance: 2,
  pipeline: 3,
  lineart: 3,
  vectorize: 3,
  "ai-pipeline": 4,
  compose: 4,
  "refine-mask": 5,
  repair: 6,
  "tile-preview": 7,
  export: 7,
};

function lastStage() {
  const job = store.recentJobs[0];
  return job ? JOB_STAGE[job.kind] || 1 : 0;
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `¥${number.toFixed(2)}` : "—";
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
            <span class="resume__time">本机还没有处理记录</span>
          </div>
          <h2 class="resume__name">从一张原图开始</h2>
          <p class="resume__note">上传 PNG 或 JPEG，系统会先保留原件、生成规范输入，再让你裁切和提取。</p>
          <div class="resume__actions">
            <button class="btn btn--primary" type="button" data-upload>上传纹样 ${icon("upload")}</button>
            <a class="btn btn--ghost btn--sm" href="#/library">去纹样库挑一件</a>
          </div>
        </div>
      </div>
    `;
  }
  const stage = lastStage();
  const stageInfo = STAGES[Math.max(0, stage - 1)] || STAGES[0];
  const stageNo = stage || 1;
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
        <p class="resume__note">${
          job
            ? `最近任务「${escapeHtml(jobKindLabel(job.kind))}」${escapeHtml(jobStateLabel(job.state))}，对应第 ${stageNo} 道工序「${escapeHtml(stageInfo.name)}」。`
            : `最近产出的资产在第 ${stageNo} 道工序。`
        }</p>
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
  const current = lastStage();
  return `
    <div class="flow">
      ${STAGES.map((s, i) => {
        const n = i + 1;
        const state = current === 0 ? "待开始" : n < current ? "已完成" : n === current ? "最近一步" : "待开始";
        return `
        <button class="flow__card card card--hover ${n < current ? "is-done" : ""} ${n === current ? "is-current" : ""}"
          type="button" data-stage="${n}" data-spotlight data-reveal style="--i:${i}">
          <span class="flow__top">
            <span class="flow__no">${s.n}</span>
            ${icon(FLOW_ICONS[i])}
          </span>
          <span class="flow__name">${s.name}</span>
          <span class="flow__title">${s.title}</span>
          <span class="flow__note">${s.note}</span>
          <span class="flow__state">
            <span class="dot ${n === current ? "dot--cinnabar" : n < current ? "" : "dot--idle"}"></span>${state}
          </span>
        </button>`;
      }).join("")}
      <div class="flow__summary card" data-reveal style="--i:7">
        <p class="label">全流程</p>
        <p class="flow__summary-num">${store.seedream?.budget?.call_count ?? 0} <span class="flow__summary-unit">次</span></p>
        <p class="flow__summary-copy">这是本机记录到的云端调用次数。其余步骤全部在本机完成；原图、结果与来源记录都留在本机 <span class="mono">storage/api</span>。</p>
        <p class="flow__summary-foot">云端关闭时，本地提取、矢量化、蒙版、平铺与导出照常可用。</p>
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
  const usedPct = budget && Number(budget.limit_cny) > 0
    ? Math.min(100, Math.round((Number(budget.committed_cny) / Number(budget.limit_cny)) * 100))
    : 0;
  const version = store.health?.versions?.extraction || "—";
  return `
    <div class="gate">
      <article class="gate__card card" data-reveal data-spotlight>
        <div class="gate__head">
          <span class="gate__icon">${icon("cpu")}</span>
          <div>
            <h3 class="h3">本机优先</h3>
            <p class="gate__kicker">除云端候选外，全部在本机完成</p>
          </div>
        </div>
        <ul class="gate__list">
          <li>${icon("check")} 提取、线稿、矢量化、蒙版与平铺都在本机执行（提取版本 <span class="mono">${escapeHtml(version)}</span>）</li>
          <li>${icon("check")} 原图、工作副本与结果保存在本机 <span class="mono">storage/api</span></li>
          <li>${icon("check")} 页面不加载第三方脚本与字体；云端关闭时本地功能不受影响</li>
        </ul>
        <div class="gate__stats">
          <div><strong class="num">${total}</strong><span>张图片</span></div>
          <div><strong class="num">${store.recentAssets.length}</strong><span>项近期成果</span></div>
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
            <h3 class="h3">云端是一道闸门</h3>
            <p class="gate__kicker">${enabled ? "配置完整，逐次确认后才会调用" : "当前不可用，本地流程不受影响"}</p>
          </div>
          <span class="chip ${enabled ? "chip--jade" : "chip--gold"} gate__chip">${enabled ? "已就绪" : "未就绪"}</span>
        </div>
        <div class="gate__budget">
          <div class="gate__budget-row">
            <span>预算使用</span>
            <span class="num">${money(budget?.committed_cny)} / ${money(budget?.limit_cny)}</span>
          </div>
          <div class="gate__meter" role="progressbar" aria-label="云端费用预算使用比例" aria-valuenow="${usedPct}" aria-valuemin="0" aria-valuemax="100">
            <span style="width:${Math.max(4, usedPct)}%"></span>
          </div>
          <p class="gate__budget-note">调用 ${budget?.call_count ?? 0} / ${budget?.max_calls ?? "—"} 次 · 单次请求先做预算预留 · 失败不自动重试</p>
        </div>
        ${
          blockers.length
            ? `<ul class="gate__list gate__list--small">${blockers
                .map((code) => `<li>${icon("alert")} ${escapeHtml(blockerLabel(code))}</li>`)
                .join("")}</ul>`
            : `<ul class="gate__list gate__list--small">
                 <li>${icon("lock")} 密钥只保存在本机服务，不写入浏览器</li>
                 <li>${icon("flask")} 候选生成前展示参数与费用闸门，确认后才请求</li>
               </ul>`
        }
        <a class="btn btn--paper btn--sm gate__cta" href="#/settings">查看费用与云端设置 ${icon("arrow")}</a>
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
    const budget = store.seedream?.budget;
    const job = store.recentJobs[0];
    const dataset = store.dataset;

    return `
      <div class="home">
        <section class="hero" data-pointer-glow>
          <div class="hero__ghost" aria-hidden="true" data-parallax="0.05">${medallionGhost()}</div>
          <div class="wrap hero__inner">
            <div class="hero__copy">
              <p class="eyebrow" data-reveal style="--i:0">本地优先 · 纹样提取与矢量化</p>
              <h1 class="display hero__title" data-reveal style="--i:1">
                把一片纹样，<br />做成<em>可编辑</em>的矢量。
              </h1>
              <p class="lead hero__lead" data-reveal style="--i:2">
                放进来、框住它、提线稿、矢量化、查接缝。全部先在本机跑；
                只有你确认后，才会带着明确的预算去调用云端。
              </p>
              <div class="hero__actions" data-reveal style="--i:3">
                <a class="btn btn--primary" href="#/workbench" data-magnetic>
                  打开工作台 ${icon("arrow")}
                </a>
                <button class="btn btn--ghost" type="button" data-open-tour>
                  ${icon("play")} 看七道工序
                </button>
              </div>
              <dl class="hero__meta" data-reveal style="--i:4">
                <div>
                  <dt>处理</dt>
                  <dd>本机 · ${escapeHtml(store.health?.versions?.extraction || "服务未连接")}</dd>
                </div>
                <div>
                  <dt>云端</dt>
                  <dd>${store.seedream?.enabled ? "已配置，逐次确认" : "未配置，本地可用"}</dd>
                </div>
                <div>
                  <dt>费用门禁</dt>
                  <dd><span class="num">${money(budget?.committed_cny)}</span> / <span class="num">${money(budget?.limit_cny)}</span></dd>
                </div>
              </dl>
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
                    <p class="specimen__name">${latest ? escapeHtml(kindLabel(latest.kind)) : "本机纹样工作台"}</p>
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

              <div class="hero__float hero__float--paths">
                <span class="hero__float-label">本机资产</span>
                <strong>${store.dataset?.total_images ?? store.recentAssets.length} 张图片</strong>
                <span class="hero__float-sub">${store.recentAssets.length} 项近期成果</span>
              </div>
              ${
                job
                  ? `<p class="hero__drag-hint">最近任务：${escapeHtml(jobKindLabel(job.kind))} · ${escapeHtml(jobStateLabel(job.state))} · ${escapeHtml(relativeTime(job.updated_at))}</p>`
                  : `<p class="hero__drag-hint">数据保存在本机 storage/api，不上传第三方</p>`
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
            <span class="ticker__item ticker__item--accent">本机优先<span class="ticker__dot">·</span></span>
            <span class="ticker__item ticker__item--accent">云端按需<span class="ticker__dot">·</span></span>
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
                <h2 class="section-title">一条可回溯的路</h2>
              </div>
              <p class="sec-head__aside">每步都留下资产；改参数可以复用已有结果，云端结果不确定就不自动重发。</p>
            </header>
            ${renderFlow()}
          </div>
        </section>

        <section class="section">
          <div class="wrap">
            <header class="sec-head">
              <div class="sec-head__main">
                <span class="sec-head__no">三 · 最近成果</span>
                <h2 class="section-title">最近成果</h2>
              </div>
              <p class="sec-head__aside">
                ${dataset ? `共 ${dataset.total_images} 张图片 · A 级 ${dataset.grades?.A ?? 0} · 重复内容 ${dataset.duplicate_content_ids ?? 0}` : "正在读取本机数据"}
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
                <span class="sec-head__no">四 · 本地与云端</span>
                <h2 class="section-title">本机跑完，云端才是一道闸门</h2>
              </div>
              <p class="sec-head__aside">云端模型只做候选生成；价格、预算与调用次数在你确认前都看得见。</p>
            </header>
            ${renderGate()}
          </div>
        </section>

        <section class="section section--closing">
          <div class="wrap wrap--tight">
            <div class="closing" data-reveal>
              <p class="eyebrow">本机工具 · 数据留在本机</p>
              <h2 class="title closing__title">这是一件干活的工具。</h2>
              <p class="copy">原件、中间结果和导出都保存在本机 storage/api；云端只在生成候选或局部修复时使用，且每次都需要明确确认。页面不写浏览器存储，刷新后按 URL 或纹样库重新进入。</p>
              <div class="closing__actions">
                <button class="btn btn--primary" type="button" data-upload data-magnetic>
                  从放图开始 ${icon("arrow")}
                </button>
                <a class="btn btn--ghost" href="#/notes">使用说明</a>
                <span class="closing__meta">本机运行 · 云端正按需 · 数据不出本机</span>
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
    homeUnsubscribe = store.subscribe((reason) => {
      if (reason === "settings") api.refresh();
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
      button.addEventListener("click", () => openTour(api, Math.max(0, lastStage() - 1)));
    });
    initTour(api);

    if (params && params.get("tour")) {
      history.replaceState(null, "", "#/home");
      openTour(api, Math.max(0, lastStage() - 1));
    }
  },

  unmount() {
    homeUnsubscribe?.();
    homeUnsubscribe = null;
    closeTour();
    tourEl?.remove();
    tourEl = null;
  },
};

let homeUnsubscribe = null;

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
            <h2 class="tour__title" id="tour-title">从一张原图，到一套能用的矢量纹样</h2>
          </div>
          <button class="icon-btn tour__close" type="button" data-tour-close aria-label="关闭导览">${icon("close")}</button>
        </header>
        <div class="tour__body tour__body--text">
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
          <div class="tour__stage tour__stage--text">
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
      <p class="drawer-foot">资产保存在本机 storage/api；打开抽屉不会发出写请求。</p>
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
      <p class="drawer-foot">失败或取消的任务会保留错误信息；云端调用不会自动重试。</p>`,
  });
}

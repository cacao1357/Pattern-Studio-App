/* =============================================================================
   概览
   ============================================================================= */
(function () {
  "use strict";
  const PS = window.PS;
  const U = PS.ui;
  const { icon, plate, stamp, stateChip, money, esc, stageChip } = U;

  PS.views = PS.views || {};

  PS.views.home = function () {
    const state = PS.state;
    const p = PS.patternById(state.activePattern);
    const counts = PS.counts();
    const cur = p.stage;
    const curVersion = Object.values(PS.baseVersions(p)).flat().slice(-1)[0] || { label: "原图", size: p.size };
    const cloudBlocked = PS.settingsBlockers(state.settings);

    const flow = PS.STAGES.map((s) => {
      const done = s.n < cur;
      const cls = done ? "is-done" : s.n === cur ? "is-current" : "";
      const mark = done ? icon("check", "ic--sm") : s.n === cur ? icon("play", "ic--sm") : "";
      return `
        <article class="flow-card ${cls}" data-act="open-stage" data-arg="${s.n}" role="button" tabindex="0">
          ${s.cloud ? `<span class="chip chip--ochre flow-card__cloud">${icon("cloud", "ic--sm")}云端</span>` : ""}
          ${plate(s.img, "flow-card__img")}
          <div class="flow-card__n"><span>0${s.n} · ${s.name}</span><span class="flow-card__state">${mark}</span></div>
          <h4>${s.title}</h4>
          <p>${s.desc}</p>
        </article>`;
    }).join("");

    const recent = PS.patterns
      .filter((x) => x.id !== p.id)
      .slice(0, 4)
      .map(
        (x) => `
        <a class="work" data-act="open-pattern" data-arg="${x.id}">
          <div class="plate work__img">
            <img src="${PS.ASSETS}${x.orig}" alt="" />
            <div class="hover-line"><img src="${PS.ASSETS}${x.line}" alt="" /></div>
            ${stamp(x.grade)}
          </div>
          <div class="work__meta"><h4>${esc(x.name)}</h4><small>${esc(x.era)}</small></div>
          <small>${esc(x.kind)} · ${esc(x.size)} px</small>
        </a>`
      )
      .join("");

    const feed = PS.jobs
      .slice(0, 4)
      .map((j) => {
        const meta = PS.jobKinds[j.kind] || { icon: "spark" };
        return `<li>
          <span class="feed__ic">${icon(meta.icon, "ic--sm")}</span>
          <div><b>${esc(j.title)}</b><small>${esc(PS.patternLabel(j.pattern))} · ${esc(j.created)}</small></div>
          ${stateChip(j.state)}
        </li>`;
      })
      .join("");

    const health = state.health;
    const model = health.capabilities.lineart_model;
    const leftrefill = health.capabilities.leftrefill_model;

    return `
    <div class="page">
      <section class="hero">
        <div>
          <span class="eyebrow">文物纹样提取与线稿数字化</span>
          <h1 class="hero__title">从一件旧纹样，<br />到一份<em>可编辑</em>的矢量。</h1>
          <p class="hero__lead">裁切、修复、拆层、提线稿、修蒙版、转 SVG、查接缝——八道工序走完，原图、每一版结果、云端调用与来源记录都留在纹样库里，随时回到任一步重做。</p>
          <div class="hero__cta">
            <button class="btn btn--primary btn--lg" data-act="upload">${icon("upload")}上传纹样</button>
            <a class="btn btn--lg" href="#/workbench">继续「${esc(p.name)}」${icon("arrow", "ic--sm")}</a>
          </div>
          <div class="hero__stats">
            <div><b class="num">${counts.patterns}</b><span>原图组</span></div>
            <div><b class="num">${counts.gradeA}</b><span>A 级成果</span></div>
            <div><b class="num">${counts.versions}</b><span>可回溯版本</span></div>
            <div><b class="num">${money(PS.callTotal())}</b><span>本月云端花费</span></div>
          </div>
        </div>
        <figure class="specimen" style="margin:0">
          <span class="specimen__tag specimen__tag--l">原图</span>
          <span class="specimen__tag specimen__tag--r">线稿</span>
          <div class="plate specimen__img">${U.compareBlock(p.orig, p.line, "specimen__img")}</div>
          <figcaption class="specimen__cap">
            <div><h3>${esc(p.name)}</h3><p>${esc(p.era)} · ${esc(p.src)} · <span class="mono">${esc(p.code)}</span></p></div>
            ${stamp(p.grade)}
          </figcaption>
        </figure>
      </section>

      <div class="health-strip" aria-label="系统状态">
        <div class="health"><b><span class="dot"></span>本机服务</b><span>${health.database && health.storage ? "数据库与存储正常" : "检查存储目录"}</span></div>
        <div class="health"><b><span class="dot ${health.worker.alive ? "" : "dot--error"}"></span>任务进程</b><span>${health.worker.alive ? `心跳 ${health.worker.heartbeat_age_seconds}s · 并发 1` : "进程未响应"}</span></div>
        <div class="health"><b><span class="dot ${model.available ? "" : "dot--warn"}"></span>线稿模型</b><span>${model.available ? "前置检查通过 · CUDA" : "不可用 · 原因 " + (model.reason || "unknown")}</span></div>
        <div class="health"><b><span class="dot ${leftrefill.available ? "" : "dot--warn"}"></span>LeftRefill</b><span>${leftrefill.available ? "本地修复可用" : "不可用 · 云端修复仍可试"}</span></div>
        <div class="health"><b><span class="dot ${cloudBlocked.length ? "dot--warn" : ""}"></span>云端服务</b><span>${cloudBlocked.length ? cloudBlocked.map((b) => PS.blockerLabels[b]).join(" / ") : "已配置 · 按次确认"}</span></div>
        <div class="health"><b><span class="dot"></span>队列</b><span>${PS.jobs.filter((j) => j.state === "running" || j.state === "queued").length} 个任务 · 上限 20</span></div>
      </div>

      <section class="card resume">
        ${plate(p.orig, "resume__thumb")}
        <div>
          <h3>接着上次 · ${esc(p.name)}</h3>
          <p>停在「0${cur} ${PS.stageOf(cur).title}」，当前版本：${esc(curVersion.label)} · ${esc(curVersion.size)}</p>
          <div class="steps-mini">${PS.STAGES.map((s) => `<span class="${s.n < cur ? "is-done" : s.n === cur ? "is-current" : ""}">${s.name}</span>`).join("")}</div>
        </div>
        <div class="resume__actions">
          <a class="btn" href="#/tasks">最近任务</a>
          <a class="btn btn--primary" href="#/workbench">继续处理 ${icon("arrow", "ic--sm")}</a>
        </div>
      </section>

      <section class="scroll">
        <div class="sec-head">
          <div><span class="eyebrow">八道工序</span><h2 class="sec-title">同一张纹样，从原图走到无缝平铺</h2></div>
          <span class="muted" style="font-size:13px">点击卡片直接进入对应工序</span>
        </div>
        <div class="scroll__track">${flow}</div>
      </section>

      <section class="home-grid">
        <div>
          <div class="sec-head">
            <div><span class="eyebrow">最近成果</span><h2 class="sec-title">悬停查看线稿</h2></div>
            <a class="link-more" href="#/library">去纹样库 ${icon("arrow", "ic--sm")}</a>
          </div>
          <div class="recent">${recent}</div>
        </div>
        <div class="side-stack">
          <div class="card panel">
            <div class="panel__head"><h3>任务动态</h3><a class="link-more" href="#/tasks">全部 ${icon("arrow", "ic--sm")}</a></div>
            <ul class="feed">${feed}</ul>
          </div>
          <div class="card panel panel--ink">
            <div class="panel__head"><h3>云端按次确认</h3>${icon("cloud")}</div>
            <div class="meter">
              <div class="meter__big"><b class="num">${money(PS.callTotal())}</b><span>本月 · ${PS.calls.length} 次调用</span></div>
              <p style="margin:0;font-size:13px;line-height:1.7">修复、选层、云端线稿与云端自检都逐次确认上传与费用；结果未知时先核对台账，不自动重发。本机流程不需要密钥。</p>
              <a class="btn btn--sm" href="#/settings" style="justify-self:start">云端设置</a>
            </div>
          </div>
          <div class="card panel">
            <div class="panel__head"><h3>快捷入口</h3></div>
            <div class="quick-grid" style="padding:0 16px 16px">
              <button class="quick" data-act="upload">${icon("upload")}<span><b>上传纹样</b><small>带来源与许可</small></span></button>
              <button class="quick" data-act="nav" data-arg="batch">${icon("batch")}<span><b>批量处理</b><small>预设与续跑</small></span></button>
              <a class="quick" href="#/library">${icon("library")}<span><b>纹样库</b><small>分类与档案</small></span></a>
              <button class="quick" data-act="manifest">${icon("database")}<span><b>数据集清单</b><small>manifest.csv</small></span></button>
            </div>
          </div>
        </div>
      </section>

      <section class="card panel home-wide">
        <div class="panel__head"><h3>数据集概览</h3><a class="link-more" href="#/settings" data-act="nav" data-arg="settings">审计与导出 ${icon("arrow", "ic--sm")}</a></div>
        <div style="padding:0 18px 18px">
          <div class="audit-line">
            <span><b class="num">${PS.audit.total_images}</b>原图</span>
            <span><b class="num">${PS.audit.images_with_meta}</b>有元数据</span>
            <span><b class="num">${PS.audit.missing_meta}</b>缺元数据</span>
            <span><b class="num">${PS.audit.usable_ab}</b>A/B 可用</span>
            <span><b class="num">${Math.round(PS.audit.license_coverage * 100)}%</b>许可覆盖</span>
            <span><b class="num">${PS.audit.duplicate_images}</b>重复内容</span>
            <span class="spacer"></span>
            <span class="note">清单字段共 21 列，包含 sha256、来源、标签状态与缺失项；导出不修改任何纹样。</span>
          </div>
        </div>
      </section>
    </div>`;
  };
})();

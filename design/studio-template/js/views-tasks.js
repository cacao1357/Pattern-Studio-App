/* =============================================================================
   任务：本机任务索引、详情、取消 / 重试与反馈
   ============================================================================= */
(function () {
  "use strict";
  const PS = window.PS;
  const U = PS.ui;
  const { icon, plate, esc, stateChip, money, openModal, openDrawer } = U;

  PS.views = PS.views || {};

  const TABS = [
    ["all", "全部"],
    ["running", "进行中"],
    ["failed", "失败"],
    ["succeeded", "已完成"],
    ["cancelled", "已取消"],
  ];

  const count = (key) => (key === "all" ? PS.jobs.length : PS.jobs.filter((j) => j.state === key).length);

  function taskRow(j) {
    const p = PS.patternById(j.pattern);
    const meta = PS.jobKinds[j.kind] || { icon: "spark", stage: j.stage };
    const right =
      j.state === "running"
        ? `<div class="task__prog"><span>${esc(j.step || "处理中")} · ${j.progress}%</span><div class="progress progress--striped"><i style="width:${j.progress}%"></i></div></div>`
        : j.state === "failed"
          ? `<div class="task__prog"><span class="mono">${esc(j.error ? j.error.code : "FAILED")}</span><span>${j.cloud ? "云端" : "本机"}</span></div>`
          : `<div class="task__prog"><span>${j.duration ? "耗时 " + esc(j.duration) : "—"}</span>${j.cloud ? `<span>云端 ${money(j.costCents)}</span>` : `<span>本机</span>`}</div>`;
    const act =
      j.state === "running"
        ? `<button class="icon-btn" data-act="job-cancel" data-arg="${j.id}" title="取消">${icon("x")}</button>`
        : j.state === "failed"
          ? `<button class="icon-btn" data-act="job-retry" data-arg="${j.id}" title="重试">${icon("refresh")}</button>`
          : `<button class="icon-btn" data-act="job-detail" data-arg="${j.id}" title="详情">${icon("arrow")}</button>`;
    return `<div class="task">
      ${plate(p.orig, "task__img")}
      <button style="border:0;background:none;text-align:left;padding:0" data-act="job-detail" data-arg="${j.id}">
        <h4>${icon(meta.icon, "ic--sm")} ${esc(j.title)}</h4>
        <small>${esc(p.name)} · 0${j.stage} ${PS.stageOf(j.stage).name} · <span class="mono">${esc(j.id)}</span>${j.attempt ? ` · 第 ${j.attempt} 次` : ""}</small>
        ${j.error ? `<div class="task__err">${icon("alert", "ic--sm")} ${esc(j.error.message)}</div>` : ""}
      </button>
      ${right}
      <div>${stateChip(j.state)}</div>
      <small>${esc(j.created)}</small>
      <div class="row" style="gap:2px">
        ${j.state === "succeeded" ? `<button class="icon-btn ${j.feedback ? "is-feedback" : ""}" data-act="feedback-open" data-arg="${j.id}" title="${j.feedback ? "已反馈" : "质量反馈"}">${icon("star", "ic--sm")}</button>` : ""}
        ${act}
      </div>
    </div>`;
  }

  PS.views.tasks = function () {
    const state = PS.state;
    const list = PS.jobs.filter((j) => state.taskTab === "all" || j.state === state.taskTab);
    const cloudSpend = PS.calls.reduce((n, c) => n + (c.costCents || 0), 0);
    return `
    <div class="page">
      <div class="page-head">
        <div><span class="eyebrow">任务</span><h1>本机与云端任务</h1><p>失败任务保留错误信息，可重试；运行中的任务可以取消。云端任务若结果未知，只能核对，不能直接取消。</p></div>
        <div class="row"><a class="btn" href="#/settings" data-act="nav" data-arg="settings">${icon("ledger", "ic--sm")}调用台账</a><button class="btn" data-act="jobs-refresh">${icon("refresh", "ic--sm")}刷新</button></div>
      </div>
      <div class="card stat-strip">
        <div><b class="num">${PS.jobs.filter((j) => j.state === "running").length}</b><span>运行中</span></div>
        <div><b class="num">${PS.jobs.filter((j) => j.state === "queued").length}</b><span>排队</span></div>
        <div><b class="num">${PS.jobs.filter((j) => j.state === "failed").length}</b><span>失败</span></div>
        <div><b class="num">${PS.calls.length}</b><span>云端调用</span></div>
        <div><b class="num">${money(cloudSpend)}</b><span>本月云端花费</span></div>
      </div>
      <div class="tabs">${TABS.map(([k, l]) => `<button class="tab ${state.taskTab === k ? "is-on" : ""}" data-act="task-tab" data-arg="${k}">${l}<span class="num">${count(k)}</span></button>`).join("")}</div>
      <div class="task-list">${list.length ? list.map(taskRow).join("") : U.empty("没有这一类任务", "切换状态页签看看", "tasks")}</div>
    </div>`;
  };

  /* ---------------------------------------------------------------- 任务详情 */
  PS.openJobDrawer = function (id) {
    const j = PS.jobById(id);
    if (!j) return;
    const p = PS.patternById(j.pattern);
    const call = j.callId ? PS.callById(j.callId) : null;
    openDrawer(
      `<div class="drawer__head">
        <div><span class="eyebrow">${esc(p.name)} · 0${j.stage}</span><h2>${esc(j.title)}</h2><p class="mono">${esc(j.id)} · ${esc(j.kind)}</p></div>
        <button class="icon-btn" data-act="close-drawer" aria-label="关闭">${icon("x")}</button>
      </div>
      <div class="drawer__body">
        <div class="row" style="justify-content:space-between">${stateChip(j.state)}<span class="note">${j.cloud ? "云端任务" : "本机任务"}</span></div>
        ${j.state === "running" ? `<div class="run-state"><div class="run-state__row"><span>${esc(j.step || "处理中")}</span><span class="num">${j.progress}%</span></div><div class="progress progress--striped"><i style="width:${j.progress}%"></i></div></div>` : ""}
        ${j.error ? U.callout("danger", `<b>${esc(j.error.code)}</b><br />${esc(j.error.message)}`, "alert") : ""}
        <div class="job-section">
          <div class="isec__title">概要</div>
          <dl class="kv">
            <dt>原图组</dt><dd>${esc(p.name)}</dd>
            <dt>工序</dt><dd>${U.stageChip(j.stage)}</dd>
            <dt>输入资产</dt><dd class="mono">${esc(j.params.input_asset_id || "—")}</dd>
            <dt>创建</dt><dd>${esc(j.created)}</dd>
            <dt>开始</dt><dd>${esc(j.started || "—")}</dd>
            <dt>结束</dt><dd>${esc(j.finished || "—")}</dd>
            <dt>耗时</dt><dd>${esc(j.duration || "—")}</dd>
            <dt>云端费用</dt><dd>${j.cloud ? money(j.costCents) : "本机 · 0"}</dd>
            <dt>反馈</dt><dd>${j.feedback ? "已提交" : "未提交"}</dd>
          </dl>
        </div>
        <div class="job-section">
          <div class="isec__title">步骤</div>
          <div class="job-steps">${j.steps.map(U.jobStep).join("")}</div>
        </div>
        <div class="job-section">
          <div class="isec__title">参数</div>
          <pre class="code-block">${esc(JSON.stringify(j.params, null, 2))}</pre>
        </div>
        <div class="job-section">
          <div class="isec__title">结果</div>
          ${(j.result.assets || []).length
            ? `<ul class="layer-list">${j.result.assets
                .map((a) => `<li>${icon("image", "ic--sm")}<span class="sw" style="background:var(--jade);width:14px;height:14px;border-radius:3px"></span><span>${esc(U.kindLabel(a.kind))}</span><small class="mono">${esc(a.asset_id.slice(0, 18))}</small></li>`)
                .join("")}</ul>`
            : `<span class="note">没有产物；失败或取消的任务保留早期步骤的版本。</span>`}
        </div>
        ${
          call
            ? `<div class="job-section">
                <div class="isec__title">云端调用</div>
                <div class="row" style="justify-content:space-between"><span class="mono">${esc(call.id)}</span>${stateChip(call.state)}</div>
                <dl class="kv"><dt>操作</dt><dd>${esc(PS.operationLabel(call.operation))}</dd><dt>结算</dt><dd>${money(call.costCents)}</dd><dt>账单引用</dt><dd class="mono">${esc(call.reference || "—")}</dd></dl>
                <button class="btn btn--sm" data-act="call-open" data-arg="${call.id}">查看台账条目</button>
              </div>`
            : ""
        }
      </div>
      <div class="drawer__foot">
        ${j.state === "running" ? `<button class="btn" data-act="job-cancel" data-arg="${j.id}">取消任务</button>` : ""}
        ${j.state === "failed" ? `<button class="btn" data-act="job-retry" data-arg="${j.id}">${icon("refresh", "ic--sm")}重试</button>` : ""}
        ${j.state === "succeeded" ? `<button class="btn" data-act="feedback-open" data-arg="${j.id}">${icon("star", "ic--sm")}质量反馈</button>` : ""}
        <button class="btn btn--primary" data-act="job-open-bench" data-arg="${j.id}">在工作台打开 ${icon("arrow", "ic--sm")}</button>
      </div>`,
      { wide: true }
    );
  };

  /* ---------------------------------------------------------------- 反馈 */
  PS.openFeedback = function (id) {
    const j = PS.jobById(id);
    if (!j) return;
    PS.state.feedback = PS.state.feedback && PS.state.feedback.job === id ? PS.state.feedback : { job: id, rating: 4, issues: new Set(), comment: "", training: false, display: false };
    const f = PS.state.feedback;
    const issues = ["线条断裂", "颜色偏差", "噪点多", "蒙版残留", "接缝明显", "细节丢失"];
    openModal(
      `<div class="modal__head"><div><h2>质量反馈</h2><p>${esc(j.title)} · <span class="mono">${esc(j.id)}</span></p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
      <div class="modal__body">
        <div class="row" style="justify-content:space-between"><b>这次结果如何？</b>${U.stars(f.rating)}</div>
        <div>
          <div class="isec__title" style="margin-bottom:8px">问题标签 <span class="mono">${f.issues.size}</span></div>
          <div class="cat-chips">${issues.map((t) => `<button class="cat-chip cat-chip--btn ${f.issues.has(t) ? "is-on" : ""}" data-act="feedback-issue" data-arg="${t}">${t}</button>`).join("")}</div>
        </div>
        <label class="field"><span class="field__label">补充说明</span><textarea class="textarea" data-feedback-comment placeholder="例如：右下角缠枝接不上，蒙版把花心擦掉了一角。">${esc(f.comment)}</textarea></label>
        <div class="checks">
          ${U.toggleRow("允许用于模型训练", "默认关闭；只在你明确同意时生效", "feedback.training")}
          ${U.toggleRow("允许公开展示", "默认关闭；与训练授权分开记录", "feedback.display")}
        </div>
        ${U.callout("warn", "反馈会记录同意版本与时间；模板只模拟写入，不会上传任何内容。", "shield")}
      </div>
      <div class="modal__foot"><span class="note">1–5 分必填</span><span class="spacer"></span><button class="btn" data-act="close-modal">取消</button><button class="btn btn--primary" data-act="feedback-save">提交反馈</button></div>`,
      { kind: "feedback" }
    );
  };
})();

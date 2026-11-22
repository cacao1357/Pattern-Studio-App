/* =============================================================================
   设置：云端服务、调用台账、本机能力、数据集与外观
   ============================================================================= */
(function () {
  "use strict";
  const PS = window.PS;
  const U = PS.ui;
  const { icon, esc, stateChip, money, get, openModal } = U;

  PS.views = PS.views || {};

  const anchors = [
    ["set-cloud", "云端服务"],
    ["set-billing", "云端调用"],
    ["set-ledger", "调用台账"],
    ["set-local", "本机处理"],
    ["set-dataset", "数据集"],
    ["set-look", "外观"],
    ["set-about", "关于"],
  ];

  const themeOpt = (k, name, sub, sw) => `
    <button class="theme-opt ${PS.state.theme === k ? "is-on" : ""}" data-theme-pick="${k}">
      <span class="theme-opt__sw">${sw.map((c) => `<i style="background:${c}"></i>`).join("")}</span>
      <b>${name}</b><small>${sub}</small>
    </button>`;

  function blockersCallout() {
    const blockers = PS.settingsBlockers(PS.state.settings);
    if (!blockers.length) return U.callout("ok", "云端门禁已满足：配置了密钥、已开启付费并确认价格。每次调用仍需逐次勾选上传与付费。", "shield");
    return U.callout("warn", `云端暂不可用：${blockers.map((b) => PS.blockerLabels[b]).join("、")}。本机流程不受影响。`, "alert");
  }

  PS.views.settings = function () {
    const state = PS.state;
    const s = state.settings;
    const blockers = PS.settingsBlockers(s);
    const cloudReady = !blockers.length;
    const audit = PS.audit;
    const versions = state.health.versions;
    const limits = state.health.limits;
    const worker = state.health.worker;

    return `
    <div class="page">
      <div class="page-head"><div><span class="eyebrow">设置</span><h1>云端、本机与数据集</h1><p>只有修复、候选、云端线稿与云端自检会联网；其余工序在本机完成。</p></div>
        <div class="row"><span class="chip ${cloudReady ? "chip--jade" : "chip--ochre"}"><i></i>${cloudReady ? "云端已就绪" : "云端未就绪"}</span><button class="btn btn--primary" data-act="settings-save">${icon("check", "ic--sm")}保存设置</button></div>
      </div>
      <div class="settings">
        <nav class="settings__nav">
          ${anchors.map(([id, label], i) => `<a href="#/settings" data-scroll="${id}" class="${i === 0 ? "is-on" : ""}">${label}</a>`).join("")}
        </nav>
        <div>
          <section class="card set-card" id="set-cloud">
            <div class="set-card__head"><div><h2>云端服务</h2><p>Seedream 兼容接口；密钥只在本机加密保存，不回显。</p></div><span class="chip ${cloudReady ? "chip--jade" : "chip--ochre"}"><i></i>${s.api_key_configured ? "已配置" : "未配置"}</span></div>
            <div class="set-row"><div class="set-row__label"><b>模型</b><small>候选层拆分、修复与云端线稿</small></div>
              <select class="select" data-bind="settings.model">${PS.modelOptions.map((m) => `<option ${s.model === m ? "selected" : ""}>${esc(m)}</option>`).join("")}</select>
            </div>
            <div class="set-row"><div class="set-row__label"><b>接口地址</b><small>仅允许内置的端点白名单</small></div><input class="input mono" value="${esc(s.base_url)}" data-bind="settings.base_url" /></div>
            <div class="set-row"><div class="set-row__label"><b>API Key</b><small>存储形式：${esc(s.api_key_storage === "windows_dpapi" ? "Windows DPAPI" : s.api_key_storage)}</small></div>
              <div class="key-field"><input class="input" value="${s.api_key_configured ? "••••••••••••••••••3fQa" : ""}" readonly placeholder="未保存" /><button class="btn" data-act="key-replace">${icon("key", "ic--sm")}${s.api_key_configured ? "更换" : "配置"}</button><button class="btn btn--ghost" data-act="key-clear">清除</button></div>
            </div>
            <div class="set-card__body">
              ${blockersCallout()}
              <div class="limits-grid">
                <div><span>settings revision</span><b>${s.revision}</b></div>
                <div><span>生效范围</span><b>${esc(s.effective)}</b></div>
                <div><span>需要重启</span><b>${s.requires_restart ? "是" : "否"}</b></div>
                <div><span>响应上限</span><b>16 MB · 单请求</b></div>
              </div>
            </div>
          </section>

          <section class="card set-card" id="set-billing">
            <div class="set-card__head"><div><h2>云端调用</h2><p>预算与次数只做记录与提示，真正门槛是密钥、付费开关与价格确认。</p></div><button class="btn btn--sm" data-act="provider-open">${icon("cloud", "ic--sm")}云端自检</button></div>
            <div class="set-row"><div class="set-row__label"><b>允许付费调用</b><small>关闭后云端工序只显示原因</small></div>${U.toggleRow("付费开关", "", "settings.paid_calls_enabled")}</div>
            <div class="set-row"><div class="set-row__label"><b>已确认价格</b><small>关闭后新云端请求会被拒绝</small></div>${U.toggleRow("价格确认", "", "settings.pricing_confirmed")}</div>
            <div class="set-row"><div class="set-row__label"><b>预算与次数</b><small>单位：分；仅作台账提示</small></div>
              <div class="form-grid">
                <label class="field"><span class="field__label">预算上限（分）</span><input class="input mono" type="number" min="0" value="${s.budget_cents}" data-bind="settings.budget_cents" /></label>
                <label class="field"><span class="field__label">单次预留（分）</span><input class="input mono" type="number" min="0" value="${s.reservation_cents}" data-bind="settings.reservation_cents" /></label>
                <label class="field"><span class="field__label">最多调用次数</span><input class="input mono" type="number" min="1" max="100" value="${s.max_calls}" data-bind="settings.max_calls" /></label>
              </div>
            </div>
            <div class="set-row"><div class="set-row__label"><b>本月用量</b><small>${PS.calls.length} 次调用 · 已结算 ${money(PS.callTotal())}</small></div>
              <div style="display:grid;gap:8px">
                <div class="run-state__row"><span class="num" style="font-size:20px">${money(PS.callTotal())}</span><span class="muted">预算 ${money(s.budget_cents)}</span></div>
                <div class="progress"><i style="width:${Math.min(100, Math.round((PS.callTotal() / Math.max(1, s.budget_cents)) * 100))}%"></i></div>
              </div>
            </div>
            <div class="set-row"><div class="set-row__label"><b>接口限额</b><small>来自 /seedream/status 与 health</small></div>
              <div class="limits-grid">
                <div><span>上传</span><b>20 MB</b></div>
                <div><span>聚合输出</span><b>25 MP</b></div>
                <div><span>并发</span><b>1</b></div>
                <div><span>自动重试</span><b>关闭</b></div>
              </div>
            </div>
          </section>

          <section class="card set-card" id="set-ledger">
            <div class="set-card__head"><div><h2>调用台账</h2><p>每次云端调用独立记录；结果未知时先核对，不自动重发。</p></div><button class="btn btn--sm" data-act="ledger-refresh">${icon("refresh", "ic--sm")}刷新</button></div>
            <div class="set-card__body">
              <div class="ledger">
                <div class="ledger-row ledger-row--head"><span>调用</span><span>操作</span><span>状态</span><span>结算 / 引用</span><span>时间</span></div>
                ${PS.calls
                  .map(
                    (c) => `<div class="ledger-row">
                      <span class="mono">${esc(c.id)}</span>
                      <span>${esc(PS.operationLabel(c.operation))}</span>
                      <span>${stateChip(c.state)}</span>
                      <span>${money(c.costCents)}${c.reference ? `<br /><span class="mono note">${esc(c.reference)}</span>` : c.state === "succeeded" ? `<br /><button class="link-more" style="border:0;background:none;padding:0;font-size:12px" data-act="settlement-open" data-arg="${c.id}">补记结算</button>` : c.state === "outcome_unknown" ? `<br /><button class="link-more" style="border:0;background:none;padding:0;font-size:12px" data-act="call-open" data-arg="${c.id}">核对状态</button>` : `<br /><span class="note">无费用</span>`}</span>
                      <span class="note">${esc(c.at)}</span>
                    </div>`
                  )
                  .join("")}
              </div>
              <span class="note">结算金额与账单引用由人工核对后填写；台账不保存响应正文与密钥。</span>
            </div>
          </section>

          <section class="card set-card" id="set-local">
            <div class="set-card__head"><div><h2>本机处理</h2><p>数据保存在 <span class="mono">storage/api</span>；静态模板不读写任何文件。</p></div><span class="chip chip--jade"><i></i>就绪</span></div>
            <div class="worker-grid">
              <div class="worker">${icon("cpu")}<b>线稿模型</b><small>local-lineart v0.2 · CUDA · ${state.health.capabilities.lineart_model.available ? "前置检查通过" : "不可用"}</small></div>
              <div class="worker">${icon("wand")}<b>本地修复</b><small>LeftRefill · ${state.health.capabilities.leftrefill_model.available ? "可用" : "不可用"}</small></div>
              <div class="worker">${icon("pen")}<b>矢量化</b><small>${esc(versions.vector)}</small></div>
            </div>
            <div class="set-card__body">
              <div class="limits-grid">
                <div><span>上传上限</span><b>${U.bytes(limits.upload_bytes)}</b></div>
                <div><span>解码像素</span><b>${(limits.decode_pixels / 1e6).toFixed(1)} MP</b></div>
                <div><span>阈值处理</span><b>${(limits.threshold_pixels / 1e6).toFixed(1)} MP</b></div>
                <div><span>颜色矢量化</span><b>${(limits.color_vector_pixels / 1000).toFixed(0)} K</b></div>
                <div><span>模型线稿</span><b>${(limits.model_lineart_pixels / 1e6).toFixed(0)} MP</b></div>
                <div><span>平铺预览</span><b>${(limits.tile_pixels / 1e6).toFixed(1)} MP</b></div>
              </div>
              <div class="limits-grid">
                <div><span>worker 内存</span><b>${worker.memory_limit_mib} MiB</b></div>
                <div><span>线稿模型内存</span><b>${worker.lineart_model_memory_limit_mib} MiB</b></div>
                <div><span>LeftRefill 内存</span><b>${worker.leftrefill_memory_limit_mib} MiB</b></div>
                <div><span>任务超时</span><b>${worker.timeout_seconds} s</b></div>
              </div>
              ${worker.error ? U.callout("danger", `worker 报错：${esc(worker.error)}`, "alert") : U.callout("ok", `worker 心跳 ${worker.heartbeat_age_seconds}s · 当前任务 ${worker.active_job_id || "空闲"} · 并发 ${worker.concurrency}`, "cpu")}
              <span class="note">像素上限仍是临时标定值（provisional）；超出时先创建工作副本，而不是自动放大。</span>
            </div>
          </section>

          <section class="card set-card" id="set-dataset">
            <div class="set-card__head"><div><h2>数据集</h2><p>清单直接由原图、任务与来源记录派生；导出不会修改纹样。</p></div><button class="btn btn--sm" data-act="manifest">${icon("download", "ic--sm")}下载 manifest.csv</button></div>
            <div class="audit-grid">
              <div class="audit"><b>${audit.total_images}</b><span>原图总数</span></div>
              <div class="audit"><b>${audit.images_with_meta}</b><span>元数据完整</span></div>
              <div class="audit"><b>${audit.missing_meta}</b><span>缺元数据</span></div>
              <div class="audit"><b>${audit.usable_ab}</b><span>A/B 可用</span></div>
              <div class="audit"><b>${Math.round(audit.license_coverage * 100)}%</b><span>许可覆盖</span></div>
              <div class="audit"><b>${audit.duplicate_images}</b><span>重复内容</span></div>
              <div class="audit"><b>${audit.provenance_declared}</b><span>来源已声明</span></div>
              <div class="audit"><b>${audit.label_status.not_reviewed}</b><span>待复核标签</span></div>
            </div>
            <div class="set-card__body">
              <div class="limits-grid">
                <div><span>评级分布</span><b>A ${audit.grades.A} · B ${audit.grades.B} · C ${audit.grades.C} · U ${audit.grades.U}</b></div>
                <div><span>数据划分</span><b>train ${audit.splits.train} · val ${audit.splits.val} · test ${audit.splits.test}</b></div>
                <div><span>来源类型</span><b>${Object.entries(audit.source_types).map(([k, v]) => `${k} ${v}`).join(" · ")}</b></div>
                <div><span>批次</span><b>${audit.batches.length} 个</b></div>
              </div>
              <div class="row"><button class="btn btn--sm" data-act="audit-refresh">${icon("refresh", "ic--sm")}重新审计</button><span class="note">审计口径与 manifest 使用同一批行，不做像素处理。</span></div>
              <span class="note">manifest 字段：image_id、content_id、grade、split、license、provenance_status、source_*、collected_at、batch_id、宽高、sha256、original/normalized asset、label_status、missing_meta。</span>
            </div>
          </section>

          <section class="card set-card" id="set-look">
            <div class="set-card__head"><div><h2>外观</h2><p>两套配色共用同一套版式，只替换令牌。</p></div></div>
            <div style="padding:18px 24px 22px" class="theme-pick">
              ${themeOpt("paper", "宣纸", "浅色 · 黛青与朱砂", ["#f3eee4", "#23355e", "#b23f2a"])}
              ${themeOpt("ink", "夜墨", "深色 · 长时间修图", ["#12151c", "#e9e1cd", "#c24f37"])}
            </div>
          </section>

          <section class="card set-card" id="set-about">
            <div class="set-card__head"><div><h2>关于</h2><p>这是视觉模板，不是生产前端；所有数据与进度均为演示。</p></div><span class="chip chip--outline">未接入 /api/v1</span></div>
            <div class="set-card__body">
              <div class="limits-grid">
                <div><span>接口范围</span><b>${esc(state.health.scope)}</b></div>
                <div><span>manifest schema</span><b>${esc(versions.manifest)}</b></div>
                <div><span>算法版本</span><b>${esc(versions.grade)} / ${esc(versions.fingerprint)}</b></div>
                <div><span>矢量化</span><b>${esc(versions.vector)}</b></div>
              </div>
              ${U.callout("warn", "模板不会发起任何网络请求，也不写 <code>localStorage</code> / <code>sessionStorage</code>。需要真实处理时，请按「说明 → 接口覆盖」把动作替换为 <code>/api/v1</code> 调用。", "info")}
            </div>
          </section>
        </div>
      </div>
    </div>`;
  };

  /* ---------------------------------------------------------------- 云端验证 */
  PS.openProviderValidation = function () {
    const state = PS.state;
    state.provider = state.provider || {
      uploaded: false,
      asset: "",
      op: "decompose",
      intent: "separate_pattern",
      size: "1K",
      promptVersion: "decompose-v3.2",
      bbox: { left: 120, top: 120, right: 900, bottom: 900 },
      consentUpload: false,
      consentCharge: false,
    };
    openModal(providerMarkup(), { wide: true, kind: "provider" });
  };

  function providerMarkup() {
    const v = PS.state.provider;
    const isEdit = v.op === "edit";
    const ready = v.uploaded && v.consentUpload && v.consentCharge && !PS.settingsBlockers(PS.state.settings).length;
    return `<div class="modal__head"><div><h2>云端自检</h2><p>调用一次已注册的验证接口，用来确认密钥、模型与计费链路。</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
      <div class="modal__body">
        <div class="job-section">
          <div class="isec__title">1 · 输入</div>
          <div class="row">
            <button class="btn btn--sm" data-act="provider-upload">${icon("upload", "ic--sm")}${v.uploaded ? "重新选择示例图" : "上传示例图"}</button>
            <span class="note">${v.uploaded ? `<span class="mono">${esc(v.asset)}</span> · 1000 × 1000` : "自检同样需要显式上传，不能复用未经确认的本地路径。"}</span>
          </div>
        </div>
        <div class="job-section">
          <div class="isec__title">2 · 操作</div>
          ${U.seg("provider.op", [["decompose", "拆分层"], ["edit", "局部修复"], ["lineart", "线稿"]], { small: true, label: "操作" })}
          ${isEdit ? U.seg("provider.intent", [["restore_small_gap", "补小缺口"], ["reconnect_lines", "续接断线"]], { small: true, label: "意图" }) : ""}
          ${U.seg("provider.size", [["1K", "1K"], ["1.5K", "1.5K"], ["2K", "2K"], ["auto", "auto"]], { small: true, label: "尺寸" })}
          ${v.op === "lineart" ? `<span class="note">提示词固定为 cloud-lineart-v1，不接受编辑矩形。</span>` : ""}
          ${isEdit ? `${U.range("provider.bbox.left", "左", 0, 1000, 1, " px")}${U.range("provider.bbox.top", "上", 0, 1000, 1, " px")}${U.range("provider.bbox.right", "右", 0, 1000, 1, " px")}${U.range("provider.bbox.bottom", "下", 0, 1000, 1, " px")}` : ""}
        </div>
        <div class="job-section">
          <div class="isec__title">3 · 同意</div>
          ${PS.settingsBlockers(PS.state.settings).length ? U.callout("warn", "设置未就绪：" + PS.settingsBlockers(PS.state.settings).map((b) => PS.blockerLabels[b]).join("、"), "alert") : ""}
          ${U.toggleRow("同意上传这张图", "只发送本次验证所需图像", "provider.consentUpload")}
          ${U.toggleRow("确认价格并同意付费", "约 ¥0.06 / 次", "provider.consentCharge")}
        </div>
      </div>
      <div class="modal__foot"><span class="note">不会自动重试；结果未知时到调用台账核对。</span><span class="spacer"></span><button class="btn" data-act="close-modal">取消</button><button class="btn btn--primary" data-act="provider-submit" ${ready ? "" : "disabled"}>提交自检</button></div>`;
  }

  PS.refreshProviderModal = function () {
    const modal = document.querySelector("#modal");
    if (modal && modal.innerHTML.includes("云端自检")) {
      modal.innerHTML = providerMarkup();
    }
  };

  /* ---------------------------------------------------------------- 结算 */
  PS.openSettlement = function (callId) {
    const call = PS.callById(callId);
    if (!call) return;
    PS.state.settlement = { call: callId, cost: (call.costCents / 100).toFixed(2), ref: call.reference || "" };
    openModal(
      `<div class="modal__head"><div><h2>补记结算</h2><p><span class="mono">${esc(call.id)}</span> · ${esc(call.operation)} · ${esc(call.at)}</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
      <div class="modal__body">
        ${U.callout("warn", "金额与账单引用必须来自账号侧账单，不能粘贴接口响应正文，也不能包含密钥。", "ledger")}
        <div class="form-grid">
          <label class="field"><span class="field__label">实际费用（元）</span><input class="input mono" data-settlement-cost value="${esc(PS.state.settlement.cost)}" placeholder="0.18" data-autofocus /></label>
          <label class="field"><span class="field__label">账单引用</span><input class="input mono" data-settlement-ref value="${esc(PS.state.settlement.ref)}" placeholder="ark-2026-11-20-0041" /></label>
        </div>
        <span class="note">格式：最多两位小数；引用 8–100 位字母、数字与 <code>_.:-</code>。</span>
      </div>
      <div class="modal__foot"><span class="note">${stateChip(call.state)}</span><span class="spacer"></span><button class="btn" data-act="close-modal">取消</button><button class="btn btn--primary" data-act="settlement-save" data-arg="${call.id}">保存结算</button></div>`,
      { kind: "settlement" }
    );
  };

  PS.openCallDetail = function (callId) {
    const c = PS.callById(callId);
    if (!c) return;
    openModal(
      `<div class="modal__head"><div><h2>调用台账条目</h2><p class="mono">${esc(c.id)}</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
      <div class="modal__body">
        <div class="row" style="justify-content:space-between">${stateChip(c.state)}<span class="note">${esc(c.at)}</span></div>
        <dl class="kv"><dt>操作</dt><dd>${esc(c.operation)}</dd><dt>关联任务</dt><dd class="mono">${esc(c.job)}</dd><dt>结算</dt><dd>${money(c.costCents)}</dd><dt>账单引用</dt><dd class="mono">${esc(c.reference || "—")}</dd></dl>
        ${c.state === "outcome_unknown" ? U.callout("warn", "结果未知：先去账号侧核对，再选择「确认成功并补记」或「确认失败，无费用」。不要重复提交同一请求。", "shield") : ""}
      </div>
      <div class="modal__foot">
        <button class="btn" data-act="close-modal">关闭</button><span class="spacer"></span>
        ${c.state === "outcome_unknown" ? `<button class="btn" data-act="call-reconcile" data-arg="${c.id}">确认失败，无费用</button><button class="btn btn--primary" data-act="settlement-open" data-arg="${c.id}">确认成功并补记</button>` : `<button class="btn btn--primary" data-act="settlement-open" data-arg="${c.id}">补记结算</button>`}
      </div>`
    );
  };
})();

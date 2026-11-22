/* =============================================================================
   批量：流程预设、批次创建、逐图状态与人工续接
   ============================================================================= */
(function () {
  "use strict";
  const PS = window.PS;
  const U = PS.ui;
  const { icon, plate, esc, stateChip, money, get, openModal } = U;

  PS.views = PS.views || {};

  const recipeLabels = { color: "颜色提取", model_lineart: "本机模型线稿", cloud_lineart: "云端线稿" };
  const recipeCloud = (recipe) => recipe === "cloud_lineart";

  function optionChips(options) {
    const chips = [];
    if (options.crop) chips.push("裁切");
    if (options.repair) chips.push("修复");
    if (options.candidates) chips.push("云端候选");
    if (options.mask) chips.push("蒙版");
    if (options.vectorize) chips.push("矢量化");
    if (options.tile) chips.push("平铺");
    if (options.working_max_pixels) chips.push(Math.round(options.working_max_pixels / 10000) / 100 + " MP 副本");
    return chips.map((t) => `<span class="cat-chip">${esc(t)}</span>`).join("");
  }

  function presetCard(preset) {
    const on = PS.state.batch.presetId === preset.id;
    return `<div class="preset ${on ? "is-on" : ""}">
      <button class="preset__head" data-act="batch-pick" data-arg="${preset.id}" style="border:0;background:none;text-align:left;padding:0">
        <span><h4>${esc(preset.name)}</h4><p>${esc(preset.description)}</p></span>
        <span class="check ${on ? "is-checked" : ""}">${icon("check")}</span>
      </button>
      <div class="preset__opts"><span class="cat-chip">${esc(recipeLabels[preset.options.recipe] || preset.options.recipe)}</span>${optionChips(preset.options)}</div>
      <div class="preset__foot">
        <span class="note">rev ${preset.revision} · ${esc(preset.updated)}</span>
        <span class="preset__actions">
          <button class="btn btn--sm" data-act="preset-edit" data-arg="${preset.id}">编辑</button>
          <button class="btn btn--sm btn--ghost" data-act="preset-delete" data-arg="${preset.id}">删除</button>
        </span>
      </div>
    </div>`;
  }

  function batchCard(batch) {
    const counts = PS.batchCounts(batch);
    const preset = PS.presetById(batch.presetId) || PS.presets[0];
    const running = batch.state === "running";
    const paused = batch.state === "paused" || batch.state === "waiting";
    return `<article class="batch-card">
      <div class="batch-card__head">
        <div>
          <h3>${esc(batch.name)}</h3>
          <p>${esc(preset.name)} · revision ${batch.revision} · ${esc(batch.created)}</p>
        </div>
        <div class="row">${stateChip(batch.state)}<button class="icon-btn" data-act="batch-more" data-arg="${batch.id}" title="更多">${icon("more")}</button></div>
      </div>
      <div class="batch-progress">
        <div class="batch-progress__row"><span>${counts.done} 完成 · ${counts.active} 运行 · ${counts.failed} 失败 · 共 ${counts.total}</span><span>${counts.percent}%</span></div>
        <div class="progress"><i style="width:${counts.percent}%"></i></div>
      </div>
      ${batch.manualGate ? U.callout("warn", `<b>等待人工选择</b>：${esc(batch.manualGate.reason)}`, "pause") : ""}
      <div class="batch-items">${batch.items
        .map((item) => {
          const p = PS.patternById(item.pattern);
          const doneSteps = item.steps.slice(0, item.cursor);
          const steps = item.steps
            .map((name, i) => {
              const state = item.state === "failed" && i === item.cursor ? "is-failed" : i < item.cursor ? "is-done" : i === item.cursor && item.state === "running" ? "is-running" : "";
              return `<i class="${state}" title="${esc(U.stepLabel(name))}"></i>`;
            })
            .join("");
          const action =
            item.state === "waiting"
              ? `<button class="btn btn--sm" data-act="batch-gate" data-arg="${batch.id}:${item.pattern}">选择续接</button>`
              : item.state === "failed"
                ? `<button class="btn btn--sm" data-act="batch-item-resume" data-arg="${batch.id}:${item.pattern}">重试</button>`
                : `<span class="note">${doneSteps.length} / ${item.steps.length} 步</span>`;
          return `<div class="bitem">
            ${plate(p.orig, "bitem__img")}
            <span><b>${esc(p.name)}</b><small>${esc(p.era)} · ${item.results || 0} 个产物</small></span>
            ${stateChip(item.state)}
            <span class="bsteps">${steps}</span>
            <span style="text-align:right">${action}</span>
          </div>`;
        })
        .join("")}</div>
      <div class="row" style="margin-top:12px">
        ${running ? `<button class="btn btn--sm" data-act="batch-pause" data-arg="${batch.id}">${icon("pause", "ic--sm")}暂停</button>` : ""}
        ${paused && !batch.manualGate ? `<button class="btn btn--sm" data-act="batch-resume" data-arg="${batch.id}">${icon("play", "ic--sm")}继续</button>` : ""}
        <button class="btn btn--sm" data-act="batch-export" data-arg="${batch.id}">${icon("download", "ic--sm")}导出结果</button>
        <span class="spacer"></span>
        <button class="btn btn--sm btn--ghost" data-act="batch-cancel" data-arg="${batch.id}" ${["succeeded", "cancelled"].includes(batch.state) ? "disabled" : ""}>取消批次</button>
      </div>
    </article>`;
  }

  PS.views.batch = function () {
    const state = PS.state;
    const preset = PS.presetById(state.batch.presetId) || PS.presets[0];
    const cloud = recipeCloud(preset.options.recipe);
    const consents = state.batchConsentUpload && state.batchConsentCharge;
    const canCreate = state.batch.inputs.size > 0 && (!cloud || (consents && PS.settingsBlockers(state.settings).length === 0));
    const counts = PS.counts();

    return `
    <div class="page">
      <div class="page-head">
        <div><span class="eyebrow">批量</span><h1>一次提交，逐图推进</h1><p>预设保存可复用的处理配方；批次由本机队列逐图执行，单图失败不阻塞其它图片，云端批次逐批确认。</p></div>
        <div class="row">
          <button class="btn" data-act="preset-new">${icon("plus", "ic--sm")}新建预设</button>
          <button class="btn btn--primary" data-act="batch-export" data-arg="">${icon("download", "ic--sm")}导出结果</button>
        </div>
      </div>
      <div class="card stat-strip">
        <div><b class="num">${PS.presets.length}</b><span>流程预设</span></div>
        <div><b class="num">${PS.batches.filter((b) => b.state === "running").length}</b><span>运行中批次</span></div>
        <div><b class="num">${PS.batches.filter((b) => b.state === "waiting").length}</b><span>等待人工</span></div>
        <div><b class="num">${PS.batches.reduce((n, b) => n + PS.batchCounts(b).done, 0)}</b><span>已完成图片</span></div>
        <div><b class="num">${counts.patterns}</b><span>可加入纹样</span></div>
      </div>

      <div class="sec-head"><div><span class="eyebrow">流程预设</span><h2 class="sec-title">同一份配方，反复使用</h2></div><span class="note">点击卡片选中，编辑可改预处理与矢量化参数</span></div>
      <div class="preset-grid">${PS.presets.map(presetCard).join("")}</div>

      <section class="card create-card">
        <div class="set-card__head"><div><h2>新建处理批次</h2><p>最多 100 张输入；批次会逐图排队，不合并原图。</p></div>${cloud ? `<span class="chip chip--ochre">${icon("cloud", "ic--sm")}云端预设</span>` : `<span class="chip chip--jade">${icon("cpu", "ic--sm")}本机执行</span>`}</div>
        <div class="form-grid">
          ${U.selectRow("流程预设", "batch.presetId", PS.presets.map((p) => [p.id, p.name]), { rerender: true, hint: "预设会固定本次的预处理、矢量化与平铺开关。" })}
          <div class="field"><span class="field__label">当前配方</span>
            <div class="preset__opts" style="padding:8px 0"><span class="cat-chip">${esc(recipeLabels[preset.options.recipe])}</span>${optionChips(preset.options)}</div>
            <span class="field__hint">${esc(get(PS.state, "settings.model"))} · 逐图使用同一套参数。</span>
          </div>
          <div class="form-span">
            <span class="field__label" style="display:block;margin-bottom:8px">输入纹样 <span class="mono muted">${state.batch.inputs.size} 组</span></span>
            <div class="pick-list" style="max-height:230px">${PS.patterns
              .map(
                (p) => `<button class="pick-row ${state.batch.inputs.has(p.id) ? "is-on" : ""}" data-act="batch-toggle-input" data-arg="${p.id}">
                  ${plate(p.orig)}
                  <span><b>${esc(p.name)}</b><small>${esc(p.era)} · 当前 ${p.stage} / 8</small></span>
                  <span class="check ${state.batch.inputs.has(p.id) ? "is-checked" : ""}" style="width:18px;height:18px;margin-left:auto">${icon("check")}</span>
                </button>`
              )
              .join("")}</div>
          </div>
          ${
            cloud
              ? `<div class="form-span">${U.callout("warn", "云端批次会在开始前逐批确认；若结果未知，批次停在等待人工，不自动重发。", "cloud")}
                  <div class="stack" style="margin-top:10px">
                    ${U.toggleRow("同意本批上传", "只上传批次中的图片", "batchConsentUpload")}
                    ${U.toggleRow("确认价格并同意按批付费", `${money(PS.prices.lineart)} / 张起`, "batchConsentCharge")}
                  </div></div>`
              : ""
          }
        </div>
        <div class="row" style="padding:0 24px 20px">
          <span class="note">${cloud && PS.settingsBlockers(state.settings).length ? "云端未就绪：" + PS.settingsBlockers(state.settings).map((b) => PS.blockerLabels[b]).join("、") : "批次由本机 worker 串行执行，单图失败可在批次中点重试。"}</span>
          <span class="spacer"></span>
          <button class="btn btn--primary" data-act="batch-create" ${canCreate ? "" : "disabled"}>${icon("play", "ic--sm")}创建批次（${state.batch.inputs.size}）</button>
        </div>
      </section>

      <div class="sec-head" style="margin-top:34px"><div><span class="eyebrow">批次</span><h2 class="sec-title">运行、暂停与人工续接</h2></div><span class="note">刷新后批次由服务器恢复；这里用演示状态模拟</span></div>
      <div class="batch-grid">${PS.batches.map(batchCard).join("")}</div>
    </div>`;
  };

  /* ---------------------------------------------------------------- 预设编辑 */
  PS.openPresetModal = function (id) {
    const source = id ? PS.presetById(id) : null;
    const draft = source
      ? JSON.parse(JSON.stringify(source))
      : { id: "p" + (PS.presets.length + 1), name: "新预设", revision: 1, updated: U.nowTime(), description: "", options: { recipe: "color", crop: false, repair: false, candidates: false, mask: false, vectorize: true, tile: false, working_max_pixels: 1000000, extract: { mode: "otsu", polarity: "dark" }, vector: { max_colors: 4, detail: "medium" } } };
    PS.state.presetDraft = draft;
    PS.presetEditing = !!source;
    openModal(presetMarkup(draft, !!source), { wide: true, kind: "preset" });
  };

  PS.refreshPresetModal = function () {
    const draft = PS.state.presetDraft;
    const modal = document.querySelector("#modal");
    if (draft && modal && modal.dataset.modal === "preset") modal.innerHTML = presetMarkup(draft, !!PS.presetEditing);
  };

  function presetMarkup(d, isEdit) {
    const o = d.options;
    const toggle = (path, label, sub) => `
      <label class="check-line ${o[path] ? "is-on" : ""}" data-preset-check-row="${path}">
        <span class="check ${o[path] ? "is-checked" : ""}">${icon("check")}</span>
        <input type="checkbox" data-pdraft-check="options.${path}" ${o[path] ? "checked" : ""} style="position:absolute;opacity:0;pointer-events:none" />
        <span><b>${label}</b><small>${sub}</small></span>
      </label>`;
    return `<div class="modal__head"><div><h2>${isEdit ? "编辑流程预设" : "新建流程预设"}</h2><p>保存后 revision 加一；批次创建时固定使用该版本参数。</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
      <div class="modal__body">
        <div class="form-grid">
          <label class="field form-span"><span class="field__label">名称</span><input class="input" value="${esc(d.name)}" data-pdraft="name" data-autofocus /></label>
          <label class="field form-span"><span class="field__label">说明</span><input class="input" value="${esc(d.description)}" data-pdraft="description" /></label>
          <label class="field"><span class="field__label">处理路线</span>
            <select class="select" data-pdraft="options.recipe">
              ${Object.keys(recipeLabels).map((k) => `<option value="${k}" ${o.recipe === k ? "selected" : ""}>${recipeLabels[k]}</option>`).join("")}
            </select>
          </label>
          <label class="field"><span class="field__label">最大工作像素</span>
            <input class="input mono" type="number" min="10000" max="25000000" step="100000" value="${o.working_max_pixels || 1000000}" data-pdraft="options.working_max_pixels" />
          </label>
          <label class="field"><span class="field__label">颜色数</span>
            <select class="select" data-pdraft="options.vector.max_colors">
              ${[2, 4, 8, 16].map((n) => `<option value="${n}" ${Number(o.vector.max_colors) === n ? "selected" : ""}>${n} 色</option>`).join("")}
            </select>
          </label>
          <label class="field"><span class="field__label">细节</span>
            <select class="select" data-pdraft="options.vector.detail">
              ${[["low", "低"], ["medium", "中"], ["high", "高"]].map(([v, l]) => `<option value="${v}" ${o.vector.detail === v ? "selected" : ""}>${l}</option>`).join("")}
            </select>
          </label>
        </div>
        <div>
          <div class="isec__title" style="margin-bottom:8px">步骤开关</div>
          <div class="checks">
            ${toggle("crop", "先裁切", "按当前原图，不改变已有版本")}
            ${toggle("repair", "包含局部修复", "需要额外云端或本机修复参数")}
            ${toggle("candidates", "包含云端候选", "每图先拆分再选层")}
            ${toggle("mask", "包含蒙版修正", "提取后自动提交一笔默认笔迹")}
            ${toggle("vectorize", "矢量化", "PNG → SVG")}
            ${toggle("tile", "平铺预览", "2×2 / 3×3 需要逐图指定")}
          </div>
        </div>
        ${o.recipe === "cloud_lineart" ? U.callout("warn", "云端路线会在创建批次时要求上传与付费两项同意；结果未知时停在人工核对。", "cloud") : ""}
      </div>
      <div class="modal__foot"><span class="note">${isEdit ? "rev " + d.revision : "新预设"}</span><span class="spacer"></span><button class="btn" data-act="close-modal">取消</button><button class="btn btn--primary" data-act="preset-save" data-arg="${isEdit ? d.id : ""}">${isEdit ? "保存修改" : "创建预设"}</button></div>`;
  }

  PS.openBatchGate = function (batchId, patternId) {
    const batch = PS.batchById(batchId);
    if (!batch) return;
    const p = PS.patternById(patternId);
    const assets = PS.patternAssets(p).slice(-4);
    if (!PS.state.gate || PS.state.gate.batchId !== batchId || PS.state.gate.patternId !== patternId) {
      PS.state.gate = { batchId, patternId, asset: assets[0] ? assets[0].asset_id : "" };
    }
    const selected = PS.state.gate.asset;
    openModal(
      `<div class="modal__head"><div><h2>选择续接对象</h2><p>${esc(batch.name)} · ${esc(p.name)}</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
      <div class="modal__body">
        ${U.callout("warn", "同一原图已经存在更新的产物。批次不会自动猜测续接对象，请明确选择一张输入资产。", "alert")}
        <div class="pick-list" style="grid-template-columns:1fr">${assets
          .map(
            (a) => `<button class="pick-row ${selected === a.asset_id ? "is-on" : ""}" data-act="gate-pick" data-arg="${a.asset_id}">
              ${plate(a.file)}
              <span><b>${esc(a.label)}</b><small>${esc(a.kind)} · ${esc(a.size)} · ${esc(a.time)}</small></span>
              <span class="check ${selected === a.asset_id ? "is-checked" : ""}" style="width:18px;height:18px;margin-left:auto">${icon("check")}</span>
            </button>`
          )
          .join("")}</div>
      </div>
      <div class="modal__foot"><span class="note">选择后批次从该图继续，已完成的图片不重跑。</span><span class="spacer"></span><button class="btn" data-act="close-modal">取消</button><button class="btn btn--primary" data-act="gate-confirm" data-arg="${batchId}:${patternId}">确认续接</button></div>`,
      { kind: "gate" }
    );
  };

  PS.refreshGateModal = function () {
    const gate = PS.state.gate;
    if (gate) PS.openBatchGate(gate.batchId, gate.patternId);
  };
})();

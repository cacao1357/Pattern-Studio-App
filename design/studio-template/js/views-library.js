/* =============================================================================
   纹样库：筛选、网格 / 列表、档案抽屉、分类与元数据
   ============================================================================= */
(function () {
  "use strict";
  const PS = window.PS;
  const U = PS.ui;
  const { icon, plate, stamp, esc, stateChip, stageChip, openModal, openDrawer } = U;

  PS.views = PS.views || {};

  const KINDS = ["全部", "团花", "边饰", "云纹", "海水"];
  const GRADES = ["全部", "A", "B", "C"];

  PS.libraryList = function () {
    const { lib } = PS.state;
    const q = lib.query.trim().toLowerCase();
    const list = PS.patterns.filter((p) => {
      if (lib.kind !== "全部" && p.kind !== lib.kind) return false;
      if (lib.grade !== "全部" && p.grade !== lib.grade) return false;
      if (lib.category !== "全部" && !(p.categoryIds || []).includes(lib.category)) return false;
      if (q) {
        const hay = [p.name, p.era, p.kind, p.code, p.src, p.sourceName, p.sourceNote, PS.categoryNames(p).join(" ")].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sort = lib.sort;
    return list.slice().sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name, "zh-Hans-CN");
      if (sort === "grade") return a.grade.localeCompare(b.grade);
      if (sort === "stage") return b.stage - a.stage;
      return 0;
    });
  };

  function card(p) {
    return `
      <a class="work lib-card" data-act="open-pattern-drawer" data-arg="${p.id}">
        <div class="plate work__img">
          <img src="${PS.ASSETS}${p.orig}" alt="" />
          <div class="hover-line"><img src="${PS.ASSETS}${p.line}" alt="" /></div>
          ${stamp(p.grade)}
        </div>
        <div class="work__meta"><h4>${esc(p.name)}</h4><small class="mono">${esc(p.code.slice(-4))}</small></div>
        <small>${esc(p.era)} · ${esc(p.kind)} · ${esc(p.size)} px</small>
        <div class="lib-card__tags">${PS.categoryNames(p).map((n) => `<span class="cat-chip">${esc(n)}</span>`).join("")}</div>
        <div class="lib-card__bar" title="已完成 ${p.stage} / 8 道工序">${PS.STAGES.map((s) => `<i class="${s.n <= p.stage ? "on" : ""}"></i>`).join("")}</div>
      </a>`;
  }

  function row(p) {
    return `
      <a class="lib-row" data-act="open-pattern-drawer" data-arg="${p.id}">
        ${plate(p.orig, "lib-row__img")}
        <span>
          <h4>${esc(p.name)}</h4>
          <small>${esc(p.era)} · ${esc(p.kind)} · <span class="mono">${esc(p.code)}</span></small>
          <span class="lib-row__tags">${PS.categoryNames(p).map((n) => `<span class="cat-chip">${esc(n)}</span>`).join("")}</span>
        </span>
        <span><small>评级</small>${stamp(p.grade, "width:22px;height:22px;font-size:11px")}</span>
        <span><small>许可</small><small>${esc(p.license)}</small></span>
        <span class="list-progress"><span>${p.stage} / 8 · ${PS.stageOf(p.stage).name}</span><span class="bar-mini">${PS.STAGES.map((s) => `<i class="${s.n <= p.stage ? "on" : ""}"></i>`).join("")}</span></span>
        <span><small>${esc(p.updated)}</small><small>${p.assetCount} 个版本</small></span>
      </a>`;
  }

  function collectionMarkup() {
    const all = PS.libraryList();
    const shown = all.slice(0, PS.state.lib.limit);
    if (!all.length) return U.empty("没有匹配的纹样", "换个关键词，或清空筛选", "search");
    return PS.state.lib.view === "list" ? `<div class="lib-list">${shown.map(row).join("")}</div>` : `<div class="lib-grid">${shown.map(card).join("")}</div>`;
  }

  PS.refreshLibrary = function () {
    const all = PS.libraryList();
    const shown = all.slice(0, PS.state.lib.limit);
    const host = document.querySelector("[data-lib-collection]");
    if (host) host.innerHTML = collectionMarkup();
    const count = document.querySelector("[data-lib-count]");
    if (count) count.textContent = `显示 ${shown.length} / ${all.length} 组`;
    const pager = document.querySelector("[data-lib-pager]");
    if (pager) pager.innerHTML = all.length > shown.length ? `<button class="btn" data-act="lib-more">载入更多（还剩 ${all.length - shown.length} 组）</button>` : "";
  };

  PS.views.library = function () {
    const state = PS.state;
    const counts = PS.counts();
    const all = PS.libraryList();
    const shown = all.slice(0, state.lib.limit);
    return `
    <div class="page">
      <div class="page-head">
        <div><span class="eyebrow">纹样库</span><h1>每一版结果都在这里</h1><p>按原图分组；打开档案可下载任一版本、编辑来源与分类，或回到工作台继续。</p></div>
        <div class="row">
          <button class="btn" data-act="categories">${icon("tag", "ic--sm")}分类管理</button>
          <button class="btn btn--primary" data-act="upload">${icon("upload")}上传纹样</button>
        </div>
      </div>
      <div class="card stat-strip">
        <div><b class="num">${counts.patterns}</b><span>原图组</span></div>
        <div><b class="num">${counts.versions}</b><span>版本</span></div>
        <div><b class="num">${counts.gradeA}</b><span>A 级</span></div>
        <div><b class="num">${counts.svg}</b><span>已出 SVG</span></div>
        <div><b class="num">${counts.pending}</b><span>待补来源</span></div>
      </div>
      <div class="toolbar">
        <label class="search">${icon("search", "ic--sm")}<input class="input" placeholder="搜索名称、年代、编号或来源" value="${esc(state.lib.query)}" data-lib-search /></label>
        <div class="filter-chips">${KINDS.map((k) => `<button class="fchip ${state.lib.kind === k ? "is-on" : ""}" data-act="lib-kind" data-arg="${k}">${k}</button>`).join("")}</div>
        <span class="sp"></span>
        <div class="seg seg--sm">${GRADES.map((g) => `<button class="${state.lib.grade === g ? "is-on" : ""}" data-act="lib-grade" data-arg="${g}">${g === "全部" ? "全部评级" : g}</button>`).join("")}</div>
        <select class="select" style="width:auto" data-lib-sort aria-label="排序">
          <option value="updated" ${state.lib.sort === "updated" ? "selected" : ""}>最近更新</option>
          <option value="name" ${state.lib.sort === "name" ? "selected" : ""}>按名称</option>
          <option value="grade" ${state.lib.sort === "grade" ? "selected" : ""}>按评级</option>
          <option value="stage" ${state.lib.sort === "stage" ? "selected" : ""}>按进度</option>
        </select>
        <div class="seg seg--sm">
          <button class="${state.lib.view === "grid" ? "is-on" : ""}" data-act="lib-view" data-arg="grid" title="网格">${icon("library", "ic--sm")}</button>
          <button class="${state.lib.view === "list" ? "is-on" : ""}" data-act="lib-view" data-arg="list" title="列表">${icon("grid-list", "ic--sm")}</button>
        </div>
      </div>
      <div class="toolbar" style="margin-top:-8px">
        <div class="cat-chips">
          <button class="cat-chip cat-chip--btn ${state.lib.category === "全部" ? "is-on" : ""}" data-act="lib-cat" data-arg="全部">全部分类</button>
          ${PS.categories.map((c) => `<button class="cat-chip cat-chip--btn ${state.lib.category === c.id ? "is-on" : ""}" data-act="lib-cat" data-arg="${c.id}">${esc(c.name)}</button>`).join("")}
        </div>
        <span class="sp"></span>
        <span class="note" data-lib-count>显示 ${shown.length} / ${all.length} 组</span>
      </div>
      <div data-lib-collection>${collectionMarkup()}</div>
      <div class="pager" data-lib-pager>${all.length > shown.length ? `<button class="btn" data-act="lib-more">载入更多（还剩 ${all.length - shown.length} 组）</button>` : ""}</div>
    </div>`;
  };

  /* ---------------------------------------------------------------- 档案抽屉 */
  PS.openPatternDrawer = function (id, tab) {
    const p = PS.patternById(id);
    const state = PS.state;
    const same = state.drawerPattern === id;
    state.drawerPattern = id;
    state.drawerTab = tab || (same ? state.drawerTab : "assets") || "assets";
    PS.drawerMeta = PS.drawerMeta && PS.drawerMeta.id === id ? PS.drawerMeta : { id, cats: new Set(p.categoryIds || []) };
    openDrawer(drawerMarkup(p), { wide: true });
  };

  function drawerMarkup(p) {
    const state = PS.state;
    const tab = state.drawerTab || "assets";
    const tabs = [
      ["assets", "版本"],
      ["meta", "资料与分类"],
      ["jobs", "任务"],
      ["flows", "云端流程"],
    ];
    return `
      <div class="drawer__head">
        <div><span class="eyebrow">${esc(p.kind)} · ${esc(p.era)}</span><h2>${esc(p.name)}</h2><p class="mono">${esc(p.code)} · ${esc(p.size)} px</p></div>
        <button class="icon-btn" data-act="close-drawer" aria-label="关闭">${icon("x")}</button>
      </div>
      <div class="drawer__tabs">${tabs.map(([k, l]) => `<button class="${tab === k ? "is-on" : ""}" data-act="drawer-tab" data-arg="${k}">${l}</button>`).join("")}</div>
      <div class="drawer__body">${drawerBody(p, tab)}</div>
      <div class="drawer__foot">
        <button class="btn" data-act="drawer-download-all">${icon("download", "ic--sm")}下载全部</button>
        <button class="btn btn--primary" data-act="drawer-open-bench">在工作台打开 ${icon("arrow", "ic--sm")}</button>
      </div>`;
  }

  function drawerBody(p, tab) {
    if (tab === "meta") {
      const cats = PS.drawerMeta ? PS.drawerMeta.cats : new Set(p.categoryIds || []);
      return `
        <div class="form-grid">
          <label class="field"><span class="field__label">评级</span>
            <select class="select" data-meta-field="grade">
              ${["", "A", "B", "C", "U"].map((g) => `<option value="${g}" ${p.grade === g ? "selected" : ""}>${g || "未评级"}</option>`).join("")}
            </select>
          </label>
          <label class="field"><span class="field__label">来源类型</span>
            <select class="select" data-meta-field="sourceType">
              ${["馆藏实物拍摄", "出版物扫描", "网络图片", "派生资产", ""].map((t) => `<option value="${t}" ${p.sourceType === t ? "selected" : ""}>${t || "未确认"}</option>`).join("")}
            </select>
          </label>
          <label class="field form-span"><span class="field__label">来源名称</span><input class="input" value="${esc(p.sourceName)}" data-meta-field="sourceName" /></label>
          <label class="field form-span"><span class="field__label">来源地址</span><input class="input mono" value="${esc(p.sourceUrl)}" data-meta-field="sourceUrl" placeholder="https://" /></label>
          <label class="field"><span class="field__label">许可</span><input class="input" value="${esc(p.license)}" data-meta-field="license" /></label>
          <label class="field"><span class="field__label">采集日期</span><input class="input" value="${esc(p.collectedAt)}" data-meta-field="collectedAt" /></label>
          <label class="field form-span"><span class="field__label">来源备注</span><textarea class="textarea" data-meta-field="sourceNote">${esc(p.sourceNote)}</textarea></label>
        </div>
        <div>
          <div class="isec__title" style="margin-bottom:8px">分类 <span class="mono">${cats.size}</span></div>
          <div class="cat-chips">${PS.categories
            .map((c) => `<button class="cat-chip cat-chip--btn ${cats.has(c.id) ? "is-on" : ""}" data-act="meta-cat" data-arg="${c.id}">${esc(c.name)}</button>`)
            .join("")}</div>
        </div>
        <div class="row">
          <button class="btn btn--primary" data-act="meta-save">保存资料</button>
          <button class="btn btn--ghost" data-act="categories">管理分类</button>
          <span class="spacer"></span>
          <button class="btn btn--danger" data-act="pattern-delete">删除原图组</button>
        </div>
        ${U.callout("warn", "删除会连同全部版本、任务、分类关联与文件一起移除，且不能恢复；有排队或运行中的任务、或处于运行中的批次时会被拒绝。", "alert")}`;
    }
    if (tab === "jobs") {
      const jobs = PS.jobs.filter((j) => j.pattern === p.id);
      if (!jobs.length) return U.empty("这个原图组还没有任务", "从工作台提交一次处理即可", "tasks");
      return `<div class="job-sections">${jobs
        .map(
          (j) => `<div class="job-section">
            <div class="row" style="justify-content:space-between"><b>${esc(j.title)}</b>${stateChip(j.state)}</div>
            <div class="row" style="justify-content:space-between"><span class="note mono">${esc(j.id)} · ${esc(j.created)}</span><button class="btn btn--sm" data-act="job-detail" data-arg="${j.id}">详情</button></div>
            ${j.error ? `<div class="task__err">${icon("alert", "ic--sm")} ${esc(j.error.message)}</div>` : ""}
          </div>`
        )
        .join("")}</div>`;
    }
    if (tab === "flows") {
      const flows = PS.flows.filter((f) => f.pattern === p.id);
      if (!flows.length) return U.empty("还没有云端流程", "04 候选首次拆分后会建立流程记录", "cloud");
      return `<div class="job-sections">${flows
        .map(
          (f) => `<div class="job-section">
            <div class="row" style="justify-content:space-between"><b class="mono">${esc(f.id)}</b>${stateChip(f.state)}</div>
            <div class="note">revision ${f.revision} · ${esc(f.promptVersion)} · ${esc(f.size)} · 更新 ${esc(f.updated)}</div>
            <div class="job-steps">${f.steps.map(U.jobStep).join("")}</div>
            ${f.needsReconcile ? U.callout("warn", "云端结果未知，先核对调用台账，不要重复提交。", "shield") : ""}
            <div class="row"><button class="btn btn--sm" data-act="flow-open" data-arg="${f.id}">查看流程</button><button class="btn btn--sm btn--ghost" data-act="call-open" data-arg="${f.callId}">云端调用</button></div>
          </div>`
        )
        .join("")}</div>`;
    }
    const assets = PS.patternAssets(p);
    const byStage = {};
    assets.forEach((a) => {
      (byStage[a.stage] = byStage[a.stage] || []).push(a);
    });
    return `
      <div class="drawer__plate-wrap"><div class="plate drawer__plate">${U.compareBlock(p.orig, p.line, "drawer__plate")}</div></div>
      <div>
        <div class="isec__title" style="margin-bottom:10px">版本 <span class="mono">${assets.length}</span></div>
        ${Object.keys(byStage)
          .map(Number)
          .sort((a, b) => b - a)
          .map(
            (n) => `<div class="vgroup">
              <div class="vgroup__label"><span><span class="num">0${n}</span>${PS.stageOf(n).name}</span><span class="num">${byStage[n].length}</span></div>
              <div class="drawer__assets">${byStage[n]
                .map(
                  (a) => `<div class="drow">
                    <div class="plate drow__img" data-act="asset-open" data-arg="${a.file}"><img src="${PS.ASSETS}${a.file}" alt="" /></div>
                    <span><b>${esc(a.label)}</b><small>${esc(U.kindLabel(a.kind))} · ${esc(a.size)} · ${esc(a.time)}</small></span>
                    <button class="icon-btn" data-act="asset-download" data-arg="${a.file}" title="下载">${icon("download")}</button>
                  </div>`
                )
                .join("")}</div>
            </div>`
          )
          .join("")}
      </div>
      <div>
        <div class="isec__title" style="margin-bottom:10px">资料</div>
        <dl class="kv">
          <dt>评级</dt><dd>${stamp(p.grade, "width:22px;height:22px;font-size:12px")}</dd>
          <dt>来源</dt><dd>${esc(p.src)}</dd>
          <dt>来源名称</dt><dd>${esc(p.sourceName)}</dd>
          <dt>分类</dt><dd>${PS.categoryNames(p).map((n) => `<span class="cat-chip">${esc(n)}</span>`).join(" ") || "—"}</dd>
          <dt>许可</dt><dd>${esc(p.license)}</dd>
          <dt>工序进度</dt><dd>${p.stage} / 8 · ${PS.stageOf(p.stage).name}</dd>
          <dt>最近更新</dt><dd>${esc(p.updated)}</dd>
        </dl>
      </div>`;
  }

  PS.refreshDrawer = function () {
    const id = PS.state.drawerPattern;
    if (!id) return;
    const p = PS.patternById(id);
    const drawer = document.querySelector("#drawer");
    if (!drawer || !drawer.innerHTML) return;
    drawer.innerHTML = drawerMarkup(p);
  };

  /* ---------------------------------------------------------------- 分类管理 */
  PS.openCategoryManager = function () {
    const rows = PS.categories
      .map(
        (c) => `<div class="row" style="gap:8px;padding:6px 0;border-bottom:1px solid var(--line-1)">
          <input class="input" value="${esc(c.name)}" data-cat-name="${c.id}" />
          <button class="btn btn--sm" data-act="cat-rename" data-arg="${c.id}">保存</button>
          <button class="icon-btn icon-btn--danger" data-act="cat-delete" data-arg="${c.id}" title="删除分类">${icon("trash")}</button>
        </div>`
      )
      .join("");
    openModal(
      `<div class="modal__head"><div><h2>分类管理</h2><p>分类用于纹样库筛选；删除分类不会删除纹样组。</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
      <div class="modal__body">
        <div class="row"><input class="input" id="cat-new" placeholder="新分类名称" data-autofocus /><button class="btn btn--primary" data-act="cat-add">${icon("plus", "ic--sm")}新建</button></div>
        <div>${rows || U.empty("还没有分类", "先新建一个分类", "tag")}</div>
      </div>
      <div class="modal__foot"><span class="note">重命名与删除都会检查 revision；模板里直接模拟成功。</span><span class="spacer"></span><button class="btn" data-act="close-modal">完成</button></div>`,
      { kind: "categories" }
    );
  };

  /* ---------------------------------------------------------------- 纹样列选择 */
  PS.openPatternPicker = function () {
    const state = PS.state;
    state.pickerQuery = state.pickerQuery || "";
    openModal(
      `<div class="modal__head"><div><h2>添加纹样到工作台</h2><p>纹样列只保存本机的选择，不会移动或复制纹样。</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
      <div class="modal__body">
        <label class="search">${icon("search", "ic--sm")}<input class="input" placeholder="搜索纹样" value="${esc(state.pickerQuery)}" data-picker-search data-autofocus /></label>
        <div data-picker-list>${pickerList()}</div>
      </div>
      <div class="modal__foot"><span class="note">已加入 ${PS.workbenchItems.length} 组</span><span class="spacer"></span><button class="btn btn--ghost" data-act="picker-clear">清空</button><button class="btn btn--primary" data-act="close-modal">完成</button></div>`,
      { wide: true }
    );
  };

  function pickerList() {
    const q = (PS.state.pickerQuery || "").trim().toLowerCase();
    const list = PS.patterns.filter((p) => !q || (p.name + p.era + p.code).toLowerCase().includes(q));
    if (!list.length) return U.empty("没有匹配的纹样", "", "search");
    return `<div class="pick-list">${list
      .map(
        (p) => `<button class="pick-row ${PS.workbenchItems.includes(p.id) ? "is-on" : ""}" data-act="picker-toggle" data-arg="${p.id}">
          ${plate(p.orig)}
          <span><b>${esc(p.name)}</b><small>${esc(p.era)} · ${p.stage} / 8</small></span>
          <span class="check ${PS.workbenchItems.includes(p.id) ? "is-checked" : ""}" style="width:18px;height:18px;margin-left:auto">${icon("check")}</span>
        </button>`
      )
      .join("")}</div>`;
  }

  PS.refreshPicker = function () {
    const host = document.querySelector("[data-picker-list]");
    if (host) host.innerHTML = pickerList();
    const count = document.querySelector("#modal .modal__foot .note");
    if (count && /已加入/.test(count.textContent)) count.textContent = `已加入 ${PS.workbenchItems.length} 组`;
  };
})();

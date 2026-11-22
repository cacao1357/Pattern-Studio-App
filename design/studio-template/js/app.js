/* =============================================================================
   纹样工作台 · 全功能交互模板 —— 外壳、状态与交互
   演示数据、模拟任务，不发起任何网络请求。
   ============================================================================= */
(function () {
  "use strict";
  const PS = window.PS;
  const U = PS.ui;
  const { icon, esc, get, set, money, plate, openModal, closeModal, openDrawer, closeDrawer, openMenu, closeMenu, toast } = U;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const rand = (n) => Math.floor(Math.random() * n);
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  const state = (PS.state = {
    route: "home",
    theme: "paper",
    activePattern: "lotus",
    stage: 5,
    done: new Set(),
    versions: null,
    compare: false,
    zoom: 1,
    tileN: 3,
    seams: false,
    cands: new Set([1]),
    leftTab: "versions",
    procMode: "local",
    repairMode: "cloud",
    consentUpload: false,
    consentCharge: false,
    batchConsentUpload: false,
    batchConsentCharge: false,
    running: null,
    selectedElement: "p1c1",
    drawerPattern: null,
    drawerTab: "assets",
    taskTab: "all",
    lib: { query: "", kind: "全部", grade: "全部", category: "全部", sort: "updated", view: "grid", limit: 8 },
    batch: { presetId: "p1", inputs: new Set(["crane", "cloud"]) },
    settings: clone(PS.settings),
    health: PS.health,
    provider: null,
    settlement: null,
    feedback: null,
    presetDraft: null,
    upload: null,
    export: null,
    recolor: null,
    confirm: null,
    gate: null,
    pickerQuery: "",
    commandQuery: "",
    commandIndex: 0,
    params: {
      crop: { ratio: "1:1", x: 336, y: 336, w: 1728, h: 1728, rotation: "0", straighten: 0, workingMax: 1000000, brightness: 1, contrast: 1, sharpen: 0, denoise: "0" },
      repair: { reference: "asset-lotus-3-1", seed: 23407, intent: "restore_small_gap", feather: 8, size: "1K", saveMask: false, bbox: { x: 560, y: 180, w: 300, h: 300 } },
      candidate: { promptVersion: "decompose-v3.2", size: "1.5K", policy: "auto_or_confirm" },
      process: {
        size: "1K", promptVersion: "cloud-lineart-v1", med: "3", minArea: 24, hi: 88, tile: 92, sd: 12, transparent: true,
        extractMode: "otsu", polarity: "dark", threshold: 127, iterations: 5, window: 31, offset: 10, clahe: false,
        minComp: 0, maxHole: 0, brightness: 1, contrast: 1, sharpen: 0, denoise: "0",
        extractBbox: { x: 120, y: 120, w: 760, h: 760 },
      },
      mask: { algorithm: "brush", iterations: 5, brush: "add", radius: 32, denoise: "1", invert: false, overlay: true, opacity: 35 },
      vector: { mode: "color", colors: "4", detail: "medium", length: 1.0, corner: 60, splice: 45 },
      tile: { obs: "not_obvious", note: "右下角缠枝衔接自然，无需返工。" },
    },
  });

  let runTimer = null;
  const jobTimers = new Map();

  /* ------------------------------------------------------------ 基本切换 */
  function loadPattern(id, stage) {
    const p = PS.patternById(id);
    state.activePattern = p.id;
    if (!PS.workbenchItems.includes(p.id)) PS.workbenchItems.unshift(p.id);
    state.versions = PS.baseVersions(p);
    state.stage = clamp(stage || p.stage, 1, 8);
    state.done = new Set(PS.STAGES.filter((s) => s.n < state.stage).map((s) => s.n));
    state.cands = new Set([1]);
    state.compare = false;
    state.zoom = 1;
    state.selectedElement = "p1c1";
    state.consentUpload = false;
    state.consentCharge = false;
    state.leftTab = "versions";
  }
  loadPattern("lotus", 5);

  function go(route) {
    if (!PS.views[route]) route = "home";
    if (state.route === route && location.hash.replace(/^#\/?/, "").split("?")[0] === route) {
      render();
      return;
    }
    location.hash = "#/" + route;
  }

  function goStage(n) {
    if (state.running) return;
    n = clamp(n, 1, 8);
    state.stage = n;
    state.done = new Set(PS.STAGES.filter((s) => s.n < n && state.versions[s.n]).map((s) => s.n));
    if (n > 3 && PS.repair.decided === "rejected" && PS.repair.pattern === state.activePattern) state.done.add(3);
    state.compare = false;
    state.zoom = 1;
    state.consentUpload = false;
    state.consentCharge = false;
    if (state.route !== "workbench") go("workbench");
    else render();
  }

  function ensureVersions() {
    if (!state.versions) loadPattern(state.activePattern, state.stage);
  }

  /* ------------------------------------------------------------ 渲染 */
  function render() {
    ensureVersions();
    const view = $("#view");
    const scroll = view.scrollTop;
    const inspector = $(".inspector__body");
    const inspectorScroll = inspector ? inspector.scrollTop : 0;
    const versions = $(".versions__list");
    const versionsScroll = versions ? versions.scrollTop : 0;

    view.classList.toggle("is-flush", state.route === "workbench");
    document.body.classList.toggle("is-bench", state.route === "workbench");
    view.innerHTML = (PS.views[state.route] || PS.views.home)();
    view.scrollTop = scroll;
    const nextInspector = $(".inspector__body");
    if (nextInspector) nextInspector.scrollTop = inspectorScroll;
    const nextVersions = $(".versions__list");
    if (nextVersions) nextVersions.scrollTop = versionsScroll;

    $$(".rail__link").forEach((a) => a.classList.toggle("is-active", a.dataset.nav === state.route));
    const taskBadge = $('[data-badge="tasks"]');
    const taskCount = PS.jobs.filter((j) => j.state === "running" || j.state === "failed").length;
    if (taskBadge) {
      taskBadge.textContent = taskCount;
      taskBadge.hidden = taskCount === 0;
    }
    const batchBadge = $('[data-badge="batch"]');
    const batchCount = PS.batches.filter((b) => b.state === "running" || b.state === "waiting").length;
    if (batchBadge) {
      batchBadge.textContent = batchCount;
      batchBadge.hidden = batchCount === 0;
    }
    const titles = { home: "概览", workbench: "工作台", library: "纹样库", batch: "批量", tasks: "任务", settings: "设置", notes: "说明" };
    document.title = `纹样工作台 · ${titles[state.route] || "概览"}`;
    if (document.body.classList.contains("is-modal")) refreshModal();
  }

  function isEditingField() {
    const el = document.activeElement;
    return el && el.closest && el.closest(".view") && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  }

  /* ------------------------------------------------------------ 模拟任务 */
  function addVersion(stage, version) {
    const list = (state.versions[stage] = state.versions[stage] || []);
    list.push({ revision: list.length + 1, time: U.nowTime(), ...version });
    const p = PS.patternById(state.activePattern);
    p.assetCount = (p.assetCount || 0) + 1;
    p.stage = Math.max(p.stage, stage);
    p.updated = "刚刚";
    if (version.kind === "svg") p.hasSvg = true;
    state.done.add(stage);
  }

  function addCall(kind, cents) {
    const ops = { repair: "edit", "cloud-lineart": "lineart", pipeline: "decompose", "ai-pipeline": "decompose", validation: "decompose" };
    PS.calls.unshift({
      id: "call_" + Math.random().toString(36).slice(2, 5),
      operation: ops[kind] || kind,
      state: "succeeded",
      costCents: cents || 0,
      reference: "",
      at: "11-21 " + U.nowTime(),
      job: null,
    });
  }

  function startRun(opts) {
    if (state.running) return;
    if (opts.cloud) {
      if (PS.settingsBlockers(state.settings).length) {
        toast("云端未就绪：" + PS.settingsBlockers(state.settings).map((b) => PS.blockerLabels[b]).join("、"), "warn");
        return;
      }
      if (!state.consentUpload || !state.consentCharge) {
        toast("先勾选上传与付费两项同意", "warn");
        return;
      }
    }
    state.running = { progress: 0, label: opts.label, kind: opts.kind, stage: opts.stage, cloud: !!opts.cloud };
    paintRun();
    runTimer = setInterval(() => {
      if (!state.running) return;
      state.running.progress = Math.min(100, state.running.progress + 5 + Math.random() * 9);
      paintRun();
      if (state.running.progress >= 100) {
        clearInterval(runTimer);
        runTimer = null;
        const done = state.running;
        state.running = null;
        addVersion(opts.stage, { label: opts.label, kind: opts.kind, file: opts.file, size: opts.size || "1000 × 1000", source: opts.source });
        if (opts.cloud) addCall(opts.kind, opts.price);
        state.consentUpload = false;
        state.consentCharge = false;
        toast(`已生成「${opts.label}」`);
        if (typeof opts.after === "function") {
          render();
          opts.after();
        } else if (opts.advance !== false && opts.stage < 8) {
          goStage(opts.stage + 1);
        } else {
          render();
        }
        void done;
      }
    }, 120);
  }

  function paintRun() {
    if (state.route === "workbench" && PS.paintWorkbenchFoot) PS.paintWorkbenchFoot();
    const status = $("[data-run-status]");
    if (status) status.textContent = state.running ? "运行中 " + Math.round(state.running.progress) + "%" : "空闲";
  }

  function cancelRun() {
    if (runTimer) clearInterval(runTimer);
    runTimer = null;
    state.running = null;
    paintRun();
    toast("已取消，本次没有写入新版本", "warn");
  }

  function simulateJob(job) {
    if (jobTimers.has(job.id)) return;
    job.state = "running";
    job.started = U.nowTime();
    const index = job.steps.findIndex((s) => s.state === "queued");
    if (index >= 0) job.steps[index].state = "running";
    const timer = setInterval(() => {
      if (job.state !== "running") {
        clearInterval(timer);
        jobTimers.delete(job.id);
        return;
      }
      job.progress = Math.min(100, job.progress + 9 + rand(9));
      const running = job.steps.find((s) => s.state === "running");
      if (running) running.state = "succeeded";
      const next = job.steps.find((s) => s.state === "queued");
      if (next) next.state = "running";
      job.step = (next ? U.stepLabel(next.name) : "写入版本") + " · " + Math.round(job.progress) + "%";
      if (job.progress >= 100) {
        clearInterval(timer);
        jobTimers.delete(job.id);
        job.state = "succeeded";
        job.progress = 100;
        job.finished = U.nowTime();
        job.duration = "演示";
        job.steps.forEach((s) => {
          if (s.state === "running" || s.state === "queued") s.state = "succeeded";
        });
        if (!(job.result.assets || []).length) job.result.assets = [{ asset_id: "asset-demo-" + job.id.slice(-4), kind: "svg" }];
        toast(`任务 ${job.id} 已完成`);
      }
      if (state.route === "tasks" && !isEditingField()) render();
    }, 700);
    jobTimers.set(job.id, timer);
  }

  /* ------------------------------------------------------------ 弹层：命令面板 */
  const PAGES = [
    ["home", "概览", "home"],
    ["workbench", "工作台", "bench"],
    ["library", "纹样库", "library"],
    ["batch", "批量", "batch"],
    ["tasks", "任务", "tasks"],
    ["settings", "设置", "settings"],
    ["notes", "说明", "notes"],
  ];

  function commandList() {
    const cmds = [];
    PAGES.forEach(([route, label, ic]) => cmds.push({ id: "go-" + route, group: "页面", label, icon: ic, act: "nav", arg: route }));
    PS.STAGES.forEach((s) => cmds.push({ id: "stage-" + s.n, group: "工序", label: `0${s.n} ${s.title}`, icon: s.icon, act: "stage", arg: String(s.n), hint: "工作台" }));
    [
      ["上传纹样", "upload", "upload", ""],
      ["导出当前纹样", "download", "export", "pattern"],
      ["新建处理批次", "batch", "nav", "batch"],
      ["分类管理", "tag", "categories", ""],
      ["下载数据集清单", "database", "manifest", ""],
      ["云端自检", "cloud", "provider-open", ""],
      ["新建流程预设", "plus", "preset-new", ""],
      ["切换宣纸 / 夜墨", "moon", "theme", ""],
      ["使用说明", "notes", "nav", "notes"],
    ].forEach(([label, ic, act, arg], i) => cmds.push({ id: "cmd-" + i, group: "操作", label, icon: ic, act, arg }));
    return cmds;
  }

  function filteredCommands() {
    const q = state.commandQuery.trim().toLowerCase();
    const all = commandList();
    return q ? all.filter((c) => (c.label + " " + c.group).toLowerCase().includes(q)) : all;
  }

  function paintCommands() {
    const list = $("#cmd-list");
    if (!list) return;
    const items = filteredCommands();
    state.commandIndex = clamp(state.commandIndex, 0, Math.max(0, items.length - 1));
    if (!items.length) {
      list.innerHTML = `<div class="cmdk__empty">没有匹配的命令</div>`;
      return;
    }
    let group = "";
    list.innerHTML = items
      .map((c, i) => {
        const head = c.group !== group ? `<div class="cmdk__group">${c.group}</div>` : "";
        group = c.group;
        return `${head}<button class="cmdk__item ${i === state.commandIndex ? "is-active" : ""}" data-act="cmd-run" data-arg="${c.id}">${icon(c.icon)}<b>${esc(c.label)}</b>${c.hint ? `<small>${esc(c.hint)}</small>` : ""}</button>`;
      })
      .join("");
    const active = $(".cmdk__item.is-active", list);
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function openCommand() {
    closeMenu();
    document.body.classList.add("is-cmd");
    $("#cmdk").setAttribute("aria-hidden", "false");
    state.commandQuery = "";
    state.commandIndex = 0;
    const input = $("#cmd-input");
    input.value = "";
    paintCommands();
    setTimeout(() => input.focus(), 20);
  }

  function runCommand(id) {
    const cmd = commandList().find((c) => c.id === id);
    U.closeCommand();
    if (cmd) runAction(cmd.act, cmd.arg);
  }

  /* ------------------------------------------------------------ 弹层：上传 */
  function refreshUploadModal() {
    const modal = $("#modal");
    if (modal && modal.dataset.modal === "upload") modal.innerHTML = uploadMarkup();
  }

  function uploadMarkup() {
    const v = state.upload || {};
    const preview = v.preview || "";
    return `<div class="modal__head"><div><h2>上传纹样</h2><p>原图会另存一份规范输入；来源、许可与采集日期随图记录。</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
      <div class="modal__body">
        <div class="form-grid">
          <div class="form-span">
            <label class="dropzone" for="upload-file">
              ${icon("upload", "ic--lg")}
              <b>拖入图片，或点击选择</b>
              <span class="field__hint">PNG / JPG / TIFF · 单张最大 20 MB · 解码上限 25 MP</span>
            </label>
            <input id="upload-file" type="file" accept="image/*" hidden />
            <div class="upload-preview">${preview ? `<div class="plate"><img src="${esc(preview)}" alt="" /></div>` : `<span class="note">未选择文件；也可以先用示例图片走一遍流程。</span>`}</div>
            <div class="row" style="margin-top:8px"><button class="btn btn--sm" data-act="upload-demo">使用示例图片</button>${v.file || v.demo ? `<span class="note">${esc(v.file ? v.file.name : "lotus-original.svg")}${v.size ? " · " + esc(v.size) : ""}</span>` : ""}</div>
          </div>
          <label class="field"><span class="field__label">名称</span><input class="input" value="${esc(v.name || "")}" data-upload-field="name" placeholder="例如：缠枝莲团花" data-autofocus /></label>
          <label class="field"><span class="field__label">年代</span><input class="input" value="${esc(v.era || "")}" data-upload-field="era" placeholder="例如：明 · 万历" /></label>
          <label class="field"><span class="field__label">品类</span>
            <select class="select" data-upload-field="kind">${["团花", "边饰", "云纹", "海水", "折枝", "待整理"].map((k) => `<option ${v.kind === k ? "selected" : ""}>${k}</option>`).join("")}</select>
          </label>
          <label class="field"><span class="field__label">评级</span>
            <select class="select" data-upload-field="grade">${["A", "B", "C", ""].map((g) => `<option value="${g}" ${v.grade === g ? "selected" : ""}>${g || "未评级"}</option>`).join("")}</select>
          </label>
          <label class="field"><span class="field__label">来源类型</span>
            <select class="select" data-upload-field="sourceType">${["馆藏实物拍摄", "出版物扫描", "网络图片", "派生资产"].map((t) => `<option ${v.sourceType === t ? "selected" : ""}>${t}</option>`).join("")}</select>
          </label>
          <label class="field"><span class="field__label">采集日期</span><input class="input" value="${esc(v.collectedAt || "")}" data-upload-field="collectedAt" placeholder="2026-11-21" /></label>
          <label class="field form-span"><span class="field__label">来源名称</span><input class="input" value="${esc(v.sourceName || "")}" data-upload-field="sourceName" placeholder="馆藏机构、出版物或提供者" /></label>
          <label class="field form-span"><span class="field__label">来源地址</span><input class="input mono" value="${esc(v.sourceUrl || "")}" data-upload-field="sourceUrl" placeholder="https://" /></label>
          <label class="field form-span"><span class="field__label">许可</span><input class="input" value="${esc(v.license || "")}" data-upload-field="license" placeholder="例如：已确认（馆藏授权）/ 未确认" /></label>
          <label class="field form-span"><span class="field__label">来源备注</span><textarea class="textarea" data-upload-field="sourceNote" placeholder="材质、尺寸、残缺位置或扫描问题">${esc(v.sourceNote || "")}</textarea></label>
        </div>
        ${U.callout("warn", "上传前会先计算指纹检查近似版本；模板只模拟这一步，不会真的上传。", "info")}
      </div>
      <div class="modal__foot"><span class="note">单张 ≤ 20 MB</span><span class="spacer"></span><button class="btn" data-act="close-modal">取消</button><button class="btn btn--primary" data-act="upload-submit">上传并解析</button></div>`;
  }

  function openUpload() {
    state.upload = { name: "", era: "", kind: "团花", grade: "A", sourceType: "馆藏实物拍摄", sourceName: "", sourceUrl: "", license: "未确认", collectedAt: "2026-11-21", sourceNote: "", file: null, demo: false, preview: "", size: "" };
    openModal(uploadMarkup(), { wide: true, kind: "upload" });
  }

  function submitUpload() {
    const v = state.upload;
    if (!v || (!v.file && !v.demo)) {
      toast("请先选择图片，或使用示例图片", "warn");
      return;
    }
    if (!v.name.trim()) {
      toast("请填写纹样名称", "warn");
      return;
    }
    const foot = $("#modal .modal__foot");
    if (foot) foot.innerHTML = `<div class="modal__progress"><div class="run-state__row"><span>正在上传并计算指纹…</span><span class="num">0%</span></div><div class="progress progress--striped"><i style="width:0%"></i></div></div>`;
    let progress = 0;
    const bar = $("#modal .progress i");
    const num = $("#modal .run-state__row .num");
    const timer = setInterval(() => {
      progress = Math.min(100, progress + 12 + rand(10));
      if (bar) bar.style.width = progress + "%";
      if (num) num.textContent = Math.round(progress) + "%";
      if (progress >= 100) {
        clearInterval(timer);
        closeModal();
        openSimilarity();
      }
    }, 120);
  }

  function openSimilarity() {
    const v = state.upload;
    const similar = [PS.patternById("lotus"), PS.patternById("sepcolor")];
    openDrawer(
      `<div class="drawer__head">
        <div><span class="eyebrow">上传完成 · 相似度检查</span><h2>发现近似版本</h2><p>先确认是否复用已有原图组，避免同一张图出现两份互不相干的历史。</p></div>
        <button class="icon-btn" data-act="close-drawer" aria-label="关闭">${icon("x")}</button>
      </div>
      <div class="drawer__body">
        ${U.callout("warn", "相似度只用于提示，不会自动合并或替换；你可以改用已有版本，或保留这份新上传。", "search")}
        ${similar
          .map(
            (p, i) => `<div class="card" style="padding:12px">
              <div class="row" style="align-items:flex-start">
                ${plate(p.orig, "similar__thumb", "")}
                <div style="flex:1;min-width:0">
                  <b>${esc(p.name)}</b>
                  <div class="note">${esc(p.era)} · ${esc(p.kind)} · <span class="mono">${esc(p.code)}</span></div>
                  <div class="note">${esc(p.size)} px · ${p.assetCount} 个版本 · 相似度 ${i === 0 ? "96" : "88"}%</div>
                  <button class="btn btn--sm" style="margin-top:8px" data-act="sim-use" data-arg="${p.id}">改用「${esc(p.name)}」</button>
                </div>
              </div>
            </div>`
          )
          .join("")}
        <div class="flow-note">${icon("info", "ic--sm")}<div>新上传：${esc(v.name)} · ${esc(v.era || "未标注")} · ${esc(v.kind)} · ${esc(v.size || "尺寸待解析")}</div></div>
      </div>
      <div class="drawer__foot">
        <button class="btn" data-act="close-drawer">稍后再说</button>
        <button class="btn btn--primary" data-act="sim-keep">保留新上传 ${icon("arrow", "ic--sm")}</button>
      </div>`,
      { wide: true }
    );
  }

  function keepNewUpload() {
    const v = state.upload;
    const p = PS.patternById("lotus");
    const id = "new_" + Date.now().toString(36);
    const pattern = {
      id,
      name: v.name || "新上传纹样",
      era: v.era || "未标注",
      kind: v.kind || "待整理",
      grade: v.grade || "",
      size: v.size || "1000 × 1000",
      code: "PS-2611-0415",
      stage: 1,
      orig: "lotus-candidate-3.svg",
      line: "lotus-candidate-2.svg",
      src: v.sourceName || v.sourceType || "新上传",
      updated: "刚刚",
      createdAt: "2026-11-21 " + U.nowTime(),
      categoryIds: ["cat-todo"],
      license: v.license || "未确认",
      sourceType: v.sourceType || "",
      sourceName: v.sourceName || "",
      sourceUrl: v.sourceUrl || "",
      sourceNote: v.sourceNote || "",
      collectedAt: v.collectedAt || "",
      hasSvg: false,
      assetCount: 2,
    };
    PS.patterns.unshift(pattern);
    PS.workbenchItems.unshift(id);
    closeDrawer();
    loadPattern(id, 1);
    go("workbench");
    toast("已创建原图组，可从 01 来源继续");
  }

  /* ------------------------------------------------------------ 弹层：导出 */
  function exportAssets(scope, id) {
    if (scope === "batch") {
      const batch = PS.batchById(id);
      if (!batch) return [];
      return batch.items.flatMap((item) => {
        const p = PS.patternById(item.pattern);
        return PS.patternAssets(p).slice(-2).map((a) => ({ ...a, patternId: p.id, patternName: p.name }));
      });
    }
    const p = PS.patternById(scope === "pattern" ? state.activePattern : id);
    return PS.patternAssets(p).map((a) => ({ ...a, patternId: p.id, patternName: p.name }));
  }

  function openExport(scope = "pattern", id = "") {
    const assets = exportAssets(scope, id);
    state.export = { scope, id, selected: new Set(assets.map((a) => a.asset_id)), license: false, layout: "by_image", assets };
    openModal(exportMarkup(), { wide: true, kind: "export" });
  }

  function exportMarkup() {
    const e = state.export;
    const groups = {};
    e.assets.forEach((a) => {
      (groups[a.patternName] = groups[a.patternName] || []).push(a);
    });
    return `<div class="modal__head"><div><h2>导出成果</h2><p>${e.scope === "batch" ? "批次已完成的产物" : "当前原图组的全部版本"}；勾选后打包为 ZIP。</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
      <div class="modal__body">
        <div class="row"><button class="btn btn--sm" data-act="export-all">全选</button><button class="btn btn--sm" data-act="export-invert">反选</button><span class="note">已选 ${e.selected.size} / ${e.assets.length} · 最多 500 个文件 / 128 MiB</span></div>
        <div class="form-grid">
          <div class="field"><span class="field__label">目录布局</span>${U.seg("export.layout", [["by_image", "按原图分目录"], ["flat", "全部平铺"]], { small: true, label: "目录布局" })}</div>
          <div class="field"><span class="field__label">许可</span>${U.toggleRow("已确认素材许可", "导出前必须确认；模板只做演示", "export.license")}</div>
        </div>
        ${Object.keys(groups)
          .map(
            (name) => `<div>
              <div class="isec__title" style="margin-bottom:8px">${esc(name)} <span class="mono">${groups[name].length}</span></div>
              <div class="checks">${groups[name]
                .map(
                  (a) => `<button class="check-line ${e.selected.has(a.asset_id) ? "is-on" : ""}" data-act="export-toggle" data-arg="${a.asset_id}">
                    <span class="check ${e.selected.has(a.asset_id) ? "is-checked" : ""}">${icon("check")}</span>
                    <span><b>0${a.stage} ${esc(a.label)}</b><small>${esc(U.kindLabel(a.kind))} · ${esc(a.size)} · ${esc(a.asset_id.slice(0, 16))}</small></span>
                  </button>`
                )
                .join("")}</div>
            </div>`
          )
          .join("")}
        ${U.callout("warn", "ZIP 会包含来源与参数 JSON；模板不会真的生成大文件，只在完成后提示。", "download")}
      </div>
      <div class="modal__foot"><span class="note">${e.license ? "许可已确认" : "等待确认许可"}</span><span class="spacer"></span><button class="btn" data-act="close-modal">取消</button><button class="btn btn--primary" data-act="export-submit" ${!e.selected.size || !e.license ? "disabled" : ""}>打包导出（${e.selected.size}）</button></div>`;
  }

  function refreshExportModal() {
    const modal = $("#modal");
    if (modal && modal.dataset.modal === "export") modal.innerHTML = exportMarkup();
  }

  function submitExport() {
    const e = state.export;
    if (!e.selected.size) return toast("至少选择一个版本", "warn");
    if (!e.license) return toast("请先确认素材许可", "warn");
    const foot = $("#modal .modal__foot");
    if (foot) foot.innerHTML = `<div class="modal__progress"><div class="run-state__row"><span>正在打包 ${e.selected.size} 个文件…</span><span class="num">0%</span></div><div class="progress progress--striped"><i style="width:0%"></i></div></div>`;
    let progress = 0;
    const timer = setInterval(() => {
      progress = Math.min(100, progress + 15 + rand(12));
      const bar = $("#modal .progress i");
      const num = $("#modal .run-state__row .num");
      if (bar) bar.style.width = progress + "%";
      if (num) num.textContent = Math.round(progress) + "%";
      if (progress >= 100) {
        clearInterval(timer);
        closeModal();
        toast(`ZIP 已生成 · ${e.selected.size} 个文件 · 12.4 MB`);
      }
    }, 120);
  }

  /* ------------------------------------------------------------ 弹层：换色 */
  function openRecolor() {
    state.recolor = PS.svg.palette.reduce((acc, c) => ((acc[c] = c), acc), {});
    openModal(recolorMarkup(), { wide: true, kind: "recolor" });
  }

  function recolorMarkup() {
    return `<div class="modal__head"><div><h2>整版换色</h2><p>六位十六进制替换；每种源色只能替换一次，最多 16 组。</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
      <div class="modal__body">
        <div class="checks">${Object.keys(state.recolor)
          .map(
            (src) => `<div class="row" style="gap:10px">
              <span class="sw" style="width:28px;height:28px;border-radius:6px;background:${src};box-shadow:inset 0 0 0 1px rgba(0,0,0,.15)"></span>
              <span class="mono">${src}</span>
              <span class="muted">→</span>
              <input class="input mono" value="${esc(state.recolor[src])}" data-recolor="${src}" style="max-width:140px" />
            </div>`
          )
          .join("")}</div>
        ${U.callout("warn", "换色只替换单色填充；渐变、图片与滤镜不会改动。生成的新 SVG 会作为 07 的新版本。", "pen")}
      </div>
      <div class="modal__foot"><span class="note">${Object.keys(state.recolor).length} 组映射</span><span class="spacer"></span><button class="btn" data-act="close-modal">取消</button><button class="btn btn--primary" data-act="recolor-save">生成新版本</button></div>`;
  }

  function refreshRecolorModal() {
    const modal = $("#modal");
    if (modal && modal.dataset.modal === "recolor") modal.innerHTML = recolorMarkup();
  }

  /* ------------------------------------------------------------ 弹层：修复候选 */
  function openRepairReview() {
    const r = PS.repair;
    state.repairChoice = state.repairChoice || r.candidatesList[0].id;
    const choice = r.candidatesList.find((c) => c.id === state.repairChoice) || r.candidatesList[0];
    openModal(
      `<div class="modal__head"><div><h2>修复候选</h2><p>revision ${r.revision} · 接受前请核对选区外的像素没有被改动。</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
      <div class="modal__body">
        <div class="candidate-review">
          ${r.candidatesList
            .map(
              (c) => `<figure><div class="plate">${U.compareBlock(PS.patternById(state.activePattern).orig, c.file)}</div>
                <figcaption><span><b>${esc(c.label)}</b> · ${esc(c.note)}</span><button class="check ${state.repairChoice === c.id ? "is-checked" : ""}" data-act="repair-choice" data-arg="${c.id}" aria-label="选择 ${esc(c.label)}">${icon("check")}</button></figcaption>
              </figure>`
            )
            .join("")}
        </div>
        ${U.callout("warn", "接受后会写入新的修复版本；拒绝则保留候选但不作为后续输入。", "wand")}
        ${U.toggleRow("接受整图变化", "默认只接受选区内的变化", "repairAcceptFull")}
      </div>
      <div class="modal__foot"><span class="note">已选 ${esc(choice.label)}</span><span class="spacer"></span><button class="btn" data-act="repair-reject">拒绝候选</button><button class="btn btn--primary" data-act="repair-accept">接受并继续</button></div>`,
      { wide: true, kind: "repair" }
    );
  }

  /* ------------------------------------------------------------ 弹层：密钥 / 确认 */
  function openKeyModal() {
    openModal(
      `<div class="modal__head"><div><h2>${state.settings.api_key_configured ? "更换 API Key" : "配置 API Key"}</h2><p>保存后不回显；只在本机加密存储。</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
      <div class="modal__body">
        <label class="field"><span class="field__label">API Key</span><input class="input mono" type="password" id="key-input" placeholder="粘贴新的密钥" data-autofocus /></label>
        ${U.callout("warn", "模板只模拟保存，不会把内容写到任何地方；真实环境由 Windows DPAPI 保护。", "key")}
      </div>
      <div class="modal__foot"><span class="note">保存后 revision 加一</span><span class="spacer"></span><button class="btn" data-act="close-modal">取消</button><button class="btn btn--primary" data-act="key-save">保存密钥</button></div>`,
      { kind: "key" }
    );
  }

  function refreshKeyModal() {
    const modal = $("#modal");
    if (modal && modal.dataset.modal === "key") openKeyModal();
  }

  function confirmAction(title, text, act, arg) {
    state.confirm = { act, arg };
    openModal(
      `<div class="modal__head"><div><h2>${esc(title)}</h2><p>${esc(text)}</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
      <div class="modal__body">${U.callout("danger", "该操作不可撤销，请确认目标没有弄错。", "alert")}</div>
      <div class="modal__foot"><span class="spacer"></span><button class="btn" data-act="close-modal">取消</button><button class="btn btn--danger" data-act="confirm-yes">确认执行</button></div>`,
      { kind: "confirm" }
    );
  }

  /* ------------------------------------------------------------ 弹层刷新 */
  function refreshModal() {
    const modal = $("#modal");
    if (!modal) return;
    switch (modal.dataset.modal) {
      case "upload":
        return refreshUploadModal();
      case "provider":
        return PS.refreshProviderModal && PS.refreshProviderModal();
      case "preset":
        return PS.refreshPresetModal && PS.refreshPresetModal();
      case "feedback":
        return state.feedback && PS.openFeedback(state.feedback.job);
      case "export":
        return refreshExportModal();
      case "recolor":
        return refreshRecolorModal();
      case "categories":
        return PS.openCategoryManager();
      case "gate":
        return PS.refreshGateModal && PS.refreshGateModal();
      case "key":
        return refreshKeyModal();
      default:
        return undefined;
    }
  }

  /* ------------------------------------------------------------ 数据集清单 */
  function downloadManifest() {
    const fields = [
      "image_id", "content_id", "grade", "grade_version", "split", "license", "provenance_status", "source_type",
      "source_name", "source_url", "collected_at", "batch_id", "width", "height", "sha256", "original_asset_id",
      "normalized_asset_id", "source_note", "created_at", "label_status", "missing_meta",
    ];
    const rows = PS.patterns.map((p) => {
      const [width, height] = p.size.split(" × ").map((v) => v.trim());
      return [
        p.id, p.code, p.grade, "p0-v1", "unassigned", p.license, p.license === "未确认" ? "unverified" : "declared",
        p.sourceType, p.sourceName, p.sourceUrl, p.collectedAt, "", width, height, "3f9c6d2a7b1e4f08a5c3d9e2b7f4106c8d5e3a9b2c7f1d4e6a8b0c2d3e4f5a6b",
        "asset-" + p.id + "-1-1", "asset-" + p.id + "-1-2", p.sourceNote, p.createdAt, "not_reviewed",
        [p.sourceType ? "" : "source_type", p.sourceName ? "" : "source_name", p.license === "未确认" ? "license" : ""].filter(Boolean).join(";"),
      ];
    });
    const cell = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = "\ufeff" + [fields.join(",")].concat(rows.map((r) => r.map(cell).join(","))).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pattern-studio-dataset-manifest.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("已生成演示 manifest.csv · " + PS.patterns.length + " 行");
  }

  /* ------------------------------------------------------------ 菜单 */
  function openWorkbenchMenu() {
    const p = PS.patternById(state.activePattern);
    openMenu(
      `<div class="menu__label">${esc(p.name)}</div>
      <button data-act="wb-meta">${icon("tag")}编辑资料与分类</button>
      <button data-act="history" data-arg="assets">${icon("history")}查看版本历史</button>
      <button data-act="wb-copy">${icon("copy")}复制编号</button>
      <button data-act="feedback-open" data-arg="${(PS.jobs.find((j) => j.pattern === p.id) || {}).id || ""}">${icon("star")}质量反馈</button>
      <div class="menu__sep"></div>
      <button data-act="wb-delete" class="is-danger">${icon("trash")}删除原图组</button>`
    );
  }

  function openBatchMenu(id) {
    const b = PS.batchById(id);
    if (!b) return;
    openMenu(
      `<div class="menu__label">${esc(b.name)}</div>
      <button data-act="batch-pause" data-arg="${id}">${icon("pause")}暂停批次</button>
      <button data-act="batch-resume" data-arg="${id}">${icon("play")}继续批次</button>
      <button data-act="batch-export" data-arg="${id}">${icon("download")}导出结果</button>
      <div class="menu__sep"></div>
      <button data-act="batch-cancel" data-arg="${id}" class="is-danger">${icon("x")}取消批次</button>`
    );
  }

  /* ------------------------------------------------------------ 动作 */
  function runAction(name, arg) {
    switch (name) {
      case "theme": {
        state.theme = state.theme === "paper" ? "ink" : "paper";
        document.documentElement.dataset.theme = state.theme;
        render();
        return;
      }
      case "nav":
        return go(arg || "home");
      case "stage":
        return goStage(Number(arg));
      case "open-stage": {
        state.stage = Number(arg);
        if (state.route !== "workbench") go("workbench");
        else render();
        return;
      }
      case "open-pattern": {
        if (state.running) return toast("任务运行中，先取消再切换纹样", "warn");
        loadPattern(arg, PS.patternById(arg).stage);
        closeDrawer();
        go("workbench");
        return;
      }
      case "zoom": {
        const steps = [0.5, 0.75, 1, 1.25, 1.5, 2];
        const i = steps.indexOf(state.zoom);
        state.zoom = Number(arg) === 0 ? 1 : steps[clamp(i + Number(arg), 0, steps.length - 1)];
        const el = $(".canvas__plate") || $(".tile-sheet");
        if (el) el.style.transform = `scale(${state.zoom})`;
        const label = $(".zoom-val");
        if (label) label.textContent = Math.round(state.zoom * 100) + "%";
        return;
      }
      case "compare":
        state.compare = !state.compare;
        return render();
      case "wb-left-tab":
        state.leftTab = arg;
        return render();
      case "wb-prev":
      case "wb-next": {
        if (state.running) return toast("任务运行中，先取消再切换纹样", "warn");
        if (!PS.workbenchItems.length) return;
        const idx = PS.workbenchItems.indexOf(state.activePattern);
        const next = PS.workbenchItems[(idx + (name === "wb-next" ? 1 : PS.workbenchItems.length - 1) + PS.workbenchItems.length) % PS.workbenchItems.length];
        loadPattern(next, PS.patternById(next).stage);
        return render();
      }
      case "wb-mobile-assets":
        return PS.openPatternDrawer(state.activePattern, "assets");
      case "wb-meta":
        closeMenu();
        return PS.openPatternDrawer(state.activePattern, "meta");
      case "wb-more":
        return openWorkbenchMenu();
      case "wb-delete":
        closeMenu();
        return confirmAction("删除原图组？", `「${PS.patternById(state.activePattern).name}」的全部版本、任务与文件都会被移除。`, "pattern-delete", state.activePattern);
      case "wb-copy":
        closeMenu();
        U.copyText(PS.patternById(state.activePattern).code);
        return toast("已复制编号 " + PS.patternById(state.activePattern).code);
      case "wb-undo":
        return toast("演示：撤销会由后端记录版本链，模板不修改历史", "warn");
      case "wb-redo":
        return toast("演示：重做需要服务端版本链", "warn");
      case "wb-items-add":
        return PS.openPatternPicker();
      case "wb-items-remove":
        PS.workbenchItems = PS.workbenchItems.filter((id) => id !== arg);
        if (state.activePattern === arg) {
          const first = PS.workbenchItems[0] || PS.patterns[0].id;
          if (!PS.workbenchItems.length) PS.workbenchItems = [first];
          loadPattern(PS.workbenchItems[0], PS.patternById(PS.workbenchItems[0]).stage);
        }
        toast("已从纹样列移除");
        return render();
      case "wb-items-clear":
        return confirmAction("清空纹样列？", "只清空工作台的选择，不会删除任何纹样。", "items-clear", "");
      case "items-clear":
        PS.workbenchItems = [state.activePattern];
        toast("纹样列已清空，只保留当前纹样");
        return render();
      case "picker-toggle": {
        const has = PS.workbenchItems.includes(arg);
        PS.workbenchItems = has ? PS.workbenchItems.filter((id) => id !== arg) : [...PS.workbenchItems, arg];
        if (!PS.workbenchItems.length) PS.workbenchItems = [state.activePattern];
        PS.refreshPicker();
        return;
      }
      case "picker-clear":
        PS.workbenchItems = [state.activePattern];
        PS.refreshPicker();
        return toast("已清空纹样列");
      case "history":
        return PS.openPatternDrawer(state.activePattern, arg || "assets");
      case "upload":
        return openUpload();
      case "upload-demo":
        state.upload.demo = true;
        state.upload.file = null;
        state.upload.preview = PS.ASSETS + "lotus-original.svg";
        state.upload.size = "2400 × 2400";
        state.upload.name = state.upload.name || "缠枝莲团花（示例）";
        return refreshUploadModal();
      case "upload-submit":
        return submitUpload();
      case "sim-use": {
        const p = PS.patternById(arg);
        closeDrawer();
        loadPattern(p.id, p.stage);
        go("workbench");
        return toast(`已改用「${p.name}」的已有版本`);
      }
      case "sim-keep":
        return keepNewUpload();
      case "run":
        return runPrimary();
      case "run-cloud":
        return runCloud(arg);
      case "run-aux":
        return runAux(arg);
      case "cancel-run":
        return cancelRun();
      case "preview": {
        const st = PS.stageOf(state.stage);
        const file = state.stage === 4 ? "lotus-candidate-1.svg" : state.stage === 7 ? "lotus-vector.svg" : st.img;
        openModal(
          `<div class="modal__head"><div><h2>低分辨率预览</h2><p>预览不写入版本，也不触发云端调用。</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
          <div class="modal__body"><div class="plate" style="aspect-ratio:1">${`<img src="${PS.ASSETS}${file}" alt="" />`}</div></div>
          <div class="modal__foot"><span class="spacer"></span><button class="btn btn--primary" data-act="close-modal">关闭</button></div>`,
          { wide: true, kind: "preview" }
        );
        return;
      }
      case "repair-review":
        return openRepairReview();
      case "repair-choice":
        state.repairChoice = arg;
        return openRepairReview();
      case "repair-accept": {
        const c = (PS.repair.candidatesList || []).find((x) => x.id === state.repairChoice) || PS.repair.candidatesList[0];
        PS.repair.pattern = state.activePattern;
        PS.repair.decided = "accepted";
        PS.repair.accepted = c.file;
        addVersion(3, { label: "已接受修复", kind: "accepted_repair", file: c.file, size: "1000 × 1000" });
        closeModal();
        toast("已接受修复候选，写入 03 版本");
        return goStage(4);
      }
      case "repair-reject":
        PS.repair.pattern = state.activePattern;
        PS.repair.decided = "rejected";
        state.done.add(3);
        closeModal();
        toast("已拒绝修复候选，未写入版本", "warn");
        return goStage(4);
      case "flow-use-local":
        if (PS.flowFor(state.activePattern)) PS.flowFor(state.activePattern).state = "rejected";
        toast("已改用本地提取，云端流程标记为 rejected");
        return goStage(5);
      case "flow-reject":
        if (PS.flowFor(state.activePattern)) PS.flowFor(state.activePattern).state = "rejected";
        toast("已拒绝本次候选", "warn");
        return goStage(5);
      case "flow-history":
        return PS.openPatternDrawer(state.activePattern, "flows");
      case "flow-open": {
        const f = PS.flows.find((x) => x.id === arg);
        if (!f) return;
        openModal(
          `<div class="modal__head"><div><h2>云端流程</h2><p class="mono">${esc(f.id)} · revision ${f.revision}</p></div><button class="icon-btn" data-act="close-modal" aria-label="关闭">${icon("x")}</button></div>
          <div class="modal__body">
            <div class="row" style="justify-content:space-between">${U.stateChip(f.state)}<span class="note">${esc(f.promptVersion)} · ${esc(f.size)}</span></div>
            <div class="job-steps">${f.steps.map(U.jobStep).join("")}</div>
            ${f.needsReconcile ? U.callout("warn", "结果未知：先核对调用台账，不要重复提交。", "shield") : ""}
            <dl class="kv"><dt>拆分任务</dt><dd class="mono">${esc(f.decompositionJob)}</dd><dt>云端调用</dt><dd class="mono">${esc(f.callId)}</dd><dt>候选层</dt><dd>${f.layers.length}</dd></dl>
          </div>
          <div class="modal__foot"><span class="spacer"></span><button class="btn" data-act="call-open" data-arg="${f.callId}">查看调用</button><button class="btn btn--primary" data-act="close-modal">关闭</button></div>`
        );
        return;
      }
      case "svg-select":
        state.selectedElement = arg;
        return render();
      case "svg-nudge": {
        const [dx, dy] = String(arg).split(",").map(Number);
        const el = PS.svg.elements.find((x) => x.id === state.selectedElement);
        if (!el) return;
        el.dx += dx;
        el.dy += dy;
        return render();
      }
      case "svg-reset-el": {
        const el = PS.svg.elements.find((x) => x.id === state.selectedElement);
        if (el) {
          el.dx = 0;
          el.dy = 0;
        }
        return render();
      }
      case "svg-delete-el": {
        const el = PS.svg.elements.find((x) => x.id === state.selectedElement);
        if (el) {
          el.deleted = true;
          toast(`已标记删除「${el.label}」，应用后生成新版本`, "warn");
        }
        return render();
      }
      case "svg-apply": {
        const el = PS.svg.elements.find((x) => x.id === state.selectedElement);
        if (!el) return;
        addVersion(7, { label: "SVG · 图形编辑", kind: "svg", file: PS.fileFor(PS.patternById(state.activePattern), "svg"), size: "1000 × 1000" });
        toast(`已应用图形编辑：${el.label} ${el.dx}, ${el.dy}${el.deleted ? " · 已删除" : ""}`);
        return render();
      }
      case "svg-recolor":
        return openRecolor();
      case "recolor-save": {
        let valid = true;
        $$("[data-recolor]").forEach((input) => {
          const value = input.value.trim();
          if (!/^#[0-9a-fA-F]{6}$/.test(value)) valid = false;
          state.recolor[input.dataset.recolor] = value;
        });
        if (!valid) return toast("请填写六位十六进制颜色，例如 #1b2b54", "warn");
        PS.svg.palette = Object.keys(state.recolor).map((k) => state.recolor[k]);
        addVersion(7, { label: "SVG · 换色", kind: "svg", file: PS.fileFor(PS.patternById(state.activePattern), "svg"), size: "1000 × 1000" });
        closeModal();
        toast("换色版本已写入 07");
        return render();
      }
      case "tile-preview":
        return startRun({ kind: "tile-preview", label: "平铺预览", stage: 8, file: "lotus-seamless.svg", size: `${state.tileN} × ${state.tileN} · 500 px`, advance: false });
      case "seam-save": {
        const obs = get(state, "params.tile.obs");
        const list = state.versions[8] || [];
        if (list.length) list[list.length - 1].seam = obs;
        PS.repair.seam = obs;
        toast(`接缝观察已保存：${obs === "not_obvious" ? "未见接缝" : obs === "visible" ? "明显断线" : "未复核"}`);
        return render();
      }
      case "mask-undo":
      case "mask-redo":
        return toast(name === "mask-undo" ? "已撤销上一笔（演示）" : "已重做（演示）", "warn");
      case "mask-clear":
        return toast("已清空本次笔迹（演示）", "warn");
      case "export":
        return openExport("pattern", state.activePattern);
      case "export-submit":
        return submitExport();
      case "export-toggle": {
        const setSel = state.export.selected;
        if (setSel.has(arg)) setSel.delete(arg);
        else setSel.add(arg);
        return refreshExportModal();
      }
      case "export-all":
        state.export.selected = new Set(state.export.assets.map((a) => a.asset_id));
        return refreshExportModal();
      case "export-invert":
        state.export.selected = new Set(state.export.assets.filter((a) => !state.export.selected.has(a.asset_id)).map((a) => a.asset_id));
        return refreshExportModal();
      case "export-close":
        return closeModal();
      case "lib-kind":
        state.lib.kind = arg;
        return render();
      case "lib-grade":
        state.lib.grade = arg;
        return render();
      case "lib-cat":
        state.lib.category = arg;
        return render();
      case "lib-view":
        state.lib.view = arg;
        return render();
      case "lib-more":
        state.lib.limit += 8;
        return render();
      case "open-pattern-drawer":
        return PS.openPatternDrawer(arg);
      case "drawer-tab":
        state.drawerTab = arg;
        return PS.refreshDrawer();
      case "drawer-open-bench": {
        const id = state.drawerPattern;
        const p = PS.patternById(id);
        closeDrawer();
        loadPattern(p.id, p.stage);
        return go("workbench");
      }
      case "drawer-download-all":
        return toast("演示：将打包该原图组的全部版本", "warn");
      case "asset-download":
        U.download(arg, arg.split("/").pop());
        return toast("已下载演示资产 " + arg.split("/").pop());
      case "asset-open":
        window.open(PS.ASSETS + arg, "_blank");
        return;
      case "meta-cat": {
        if (!PS.drawerMeta) return;
        if (PS.drawerMeta.cats.has(arg)) PS.drawerMeta.cats.delete(arg);
        else PS.drawerMeta.cats.add(arg);
        return PS.refreshDrawer();
      }
      case "meta-save": {
        const p = PS.patternById(state.drawerPattern);
        $$("[data-meta-field]").forEach((el) => {
          p[el.dataset.metaField] = el.value;
        });
        p.categoryIds = PS.drawerMeta ? [...PS.drawerMeta.cats] : p.categoryIds;
        if (p.sourceName) p.src = p.sourceName;
        p.updated = "刚刚";
        toast("资料与分类已保存");
        PS.refreshDrawer();
        return render();
      }
      case "pattern-delete": {
        const id = arg || state.drawerPattern;
        closeModal();
        closeDrawer();
        PS.patterns = PS.patterns.filter((p) => p.id !== id);
        if (state.activePattern === id) loadPattern(PS.patterns[0].id, PS.patterns[0].stage);
        toast("已删除原图组（演示）", "warn");
        return render();
      }
      case "categories":
        return PS.openCategoryManager();
      case "cat-add": {
        const input = $("#cat-new");
        const name = input ? input.value.trim() : "";
        if (!name) return toast("请输入分类名称", "warn");
        PS.categories.push({ id: "cat_" + Math.random().toString(36).slice(2, 6), name, revision: 1 });
        toast("已新建分类");
        PS.openCategoryManager();
        return render();
      }
      case "cat-rename": {
        const input = $(`[data-cat-name="${arg}"]`);
        const name = input ? input.value.trim() : "";
        if (!name) return toast("分类名称不能为空", "warn");
        const c = PS.categoryById(arg);
        if (c) {
          c.name = name;
          c.revision += 1;
        }
        toast("分类已重命名");
        PS.openCategoryManager();
        return render();
      }
      case "cat-delete":
        PS.categories = PS.categories.filter((c) => c.id !== arg);
        PS.patterns.forEach((p) => (p.categoryIds = (p.categoryIds || []).filter((id) => id !== arg)));
        if (state.lib.category === arg) state.lib.category = "全部";
        toast("分类已删除，纹样组保留", "warn");
        PS.openCategoryManager();
        return render();
      case "job-detail":
        return PS.openJobDrawer(arg);
      case "job-cancel": {
        const job = PS.jobById(arg);
        if (!job) return;
        if (job.cloud) {
          toast("云端任务可能已有外部调用，先到台账核对", "warn");
          if (job.callId) PS.openCallDetail(job.callId);
          return;
        }
        if (jobTimers.has(job.id)) {
          clearInterval(jobTimers.get(job.id));
          jobTimers.delete(job.id);
        }
        job.state = "cancelled";
        job.finished = U.nowTime();
        job.error = { code: "JOB_CANCELLED", message: "任务已取消；已完成的早期步骤与版本保留。" };
        job.steps.forEach((s) => {
          if (s.state === "running" || s.state === "queued") s.state = "cancelled";
        });
        toast("任务已取消", "warn");
        if (state.route === "tasks") render();
        return PS.refreshDrawer();
      }
      case "job-retry": {
        const job = PS.jobById(arg);
        if (!job) return;
        const copy = clone(job);
        copy.id = "job_" + Math.random().toString(36).slice(2, 6);
        copy.state = "queued";
        copy.progress = 0;
        copy.step = "排队中";
        copy.created = U.nowTime();
        copy.started = "";
        copy.finished = "";
        copy.duration = "";
        copy.error = null;
        copy.attempt = (job.attempt || 1) + 1;
        copy.feedback = false;
        copy.steps = copy.steps.map((s) => ({ ...s, state: "queued" }));
        copy.result = { assets: [] };
        PS.jobs.unshift(copy);
        toast(`已重试，新任务 ${copy.id}`);
        simulateJob(copy);
        return state.route === "tasks" ? render() : PS.refreshDrawer();
      }
      case "job-open-bench": {
        const job = PS.jobById(arg);
        if (!job) return;
        closeDrawer();
        loadPattern(job.pattern, job.stage);
        return go("workbench");
      }
      case "jobs-refresh":
        PS.jobs.filter((j) => j.state === "running").forEach((j) => {
          j.progress = Math.min(100, j.progress + 8);
          if (j.progress >= 100) {
            j.state = "succeeded";
            j.finished = U.nowTime();
            j.duration = "演示";
            j.steps.forEach((s) => (s.state = "succeeded"));
          }
        });
        toast("任务列表已刷新");
        return render();
      case "task-tab":
        state.taskTab = arg;
        return render();
      case "feedback-open":
        closeMenu();
        if (!arg) return toast("这个原图组还没有可反馈的任务", "warn");
        return PS.openFeedback(arg);
      case "feedback-rate":
        state.feedback.rating = Number(arg);
        return refreshModal();
      case "feedback-issue": {
        const f = state.feedback;
        if (f.issues.has(arg)) f.issues.delete(arg);
        else f.issues.add(arg);
        return refreshModal();
      }
      case "feedback-save": {
        const f = state.feedback;
        const job = PS.jobById(f.job);
        if (!job) return;
        job.feedback = true;
        job.feedbackRating = f.rating;
        closeModal();
        toast("反馈已记录（演示）");
        return state.route === "tasks" ? render() : undefined;
      }
      case "settings-save":
        state.settings.revision += 1;
        state.settings.blockers = PS.settingsBlockers(state.settings);
        toast("设置已保存 · revision " + state.settings.revision);
        return render();
      case "key-replace":
        return openKeyModal();
      case "key-save": {
        const input = $("#key-input");
        const value = input ? input.value.trim() : "";
        if (!value) return toast("请输入 API Key", "warn");
        state.settings.api_key_configured = true;
        state.settings.api_key_storage = "windows_dpapi";
        state.settings.revision += 1;
        closeModal();
        toast("API Key 已保存（演示）");
        return render();
      }
      case "key-clear":
        return confirmAction("清除 API Key？", "清除后所有云端动作只显示原因，本机流程不受影响。", "key-clear-confirmed", "");
      case "key-clear-confirmed":
        state.settings.api_key_configured = false;
        state.settings.api_key_storage = "not_saved";
        state.settings.revision += 1;
        closeModal();
        toast("API Key 已清除", "warn");
        return render();
      case "provider-open":
        return PS.openProviderValidation();
      case "provider-upload":
        state.provider.uploaded = true;
        state.provider.asset = "asset-validate-" + Math.random().toString(36).slice(2, 6);
        return PS.refreshProviderModal();
      case "provider-submit": {
        const v = state.provider;
        PS.calls.unshift({
          id: "call_" + Math.random().toString(36).slice(2, 5),
          operation: v.op,
          state: "running",
          costCents: 0,
          reference: "",
          at: "11-21 " + U.nowTime(),
          job: null,
        });
        const call = PS.calls[0];
        closeModal();
        toast("云端自检已提交，等待结果");
        if (state.route === "settings") render();
        setTimeout(() => {
          call.state = "succeeded";
          toast("云端自检完成 · 请补记结算");
          if (state.route === "settings") render();
        }, 1600);
        return;
      }
      case "settlement-open":
        return PS.openSettlement(arg);
      case "settlement-save": {
        const call = PS.callById(arg);
        const costInput = $("[data-settlement-cost]");
        const refInput = $("[data-settlement-ref]");
        const cost = costInput ? costInput.value.trim() : "";
        const ref = refInput ? refInput.value.trim() : "";
        if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(cost)) return toast("金额格式不正确", "warn");
        if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(ref)) return toast("账单引用格式不正确", "warn");
        call.costCents = Math.round(Number(cost) * 100);
        call.reference = ref;
        call.state = "succeeded";
        closeModal();
        toast("结算已补记");
        return state.route === "settings" ? render() : undefined;
      }
      case "call-open":
        closeModal();
        return PS.openCallDetail(arg);
      case "call-reconcile": {
        const call = PS.callById(arg);
        if (call) {
          call.state = "failed";
          call.costCents = 0;
        }
        closeModal();
        toast("已标记为失败，无费用", "warn");
        return state.route === "settings" ? render() : undefined;
      }
      case "ledger-refresh":
        toast("台账已刷新");
        return render();
      case "audit-refresh": {
        const audit = PS.audit;
        audit.total_images = PS.patterns.length;
        audit.grades = { A: 0, B: 0, C: 0, U: 0, missing: 0 };
        PS.patterns.forEach((p) => {
          audit.grades[p.grade || "missing"] += 1;
        });
        audit.license_confirmed = PS.patterns.filter((p) => p.license !== "未确认").length;
        audit.license_unconfirmed = PS.patterns.length - audit.license_confirmed;
        audit.license_coverage = audit.total_images ? Math.round((audit.license_confirmed / audit.total_images) * 100) / 100 : 0;
        audit.images_with_meta = PS.patterns.filter((p) => p.sourceType && p.sourceName).length;
        audit.missing_meta = PS.patterns.length - audit.images_with_meta;
        audit.usable_ab = PS.patterns.filter((p) => ["A", "B"].includes(p.grade)).length;
        toast("数据集审计已重新计算");
        return render();
      }
      case "manifest":
        return downloadManifest();
      case "batch-pick":
        state.batch.presetId = arg;
        return render();
      case "batch-toggle-input": {
        if (state.batch.inputs.has(arg)) state.batch.inputs.delete(arg);
        else state.batch.inputs.add(arg);
        return render();
      }
      case "preset-new":
        return PS.openPresetModal(null);
      case "preset-edit":
        return PS.openPresetModal(arg);
      case "preset-save": {
        const d = state.presetDraft;
        if (!d || !d.name.trim()) return toast("预设名称不能为空", "warn");
        if (arg) {
          const target = PS.presetById(arg);
          const revision = target.revision + 1;
          Object.assign(target, { name: d.name, description: d.description, options: d.options, revision, updated: U.nowTime() });
          toast("预设已保存 · rev " + revision);
        } else {
          d.id = "p" + (PS.presets.length + 1 + rand(4));
          d.revision = 1;
          d.updated = U.nowTime();
          PS.presets.push(d);
          state.batch.presetId = d.id;
          toast("已创建流程预设");
        }
        state.presetDraft = null;
        closeModal();
        return render();
      }
      case "preset-delete":
        return confirmAction("删除流程预设？", `「${(PS.presetById(arg) || {}).name || "该预设"}」删除后不影响已创建的历史批次。`, "preset-delete-confirmed", arg);
      case "preset-delete-confirmed": {
        const p = PS.presetById(arg);
        if (!p) return;
        PS.presets = PS.presets.filter((x) => x.id !== arg);
        if (state.batch.presetId === arg) state.batch.presetId = PS.presets[0].id;
        toast("预设已删除，历史批次保留", "warn");
        return render();
      }
      case "batch-create": {
        const preset = PS.presetById(state.batch.presetId);
        const inputs = [...state.batch.inputs];
        if (!preset || !inputs.length) return toast("至少选择一组输入纹样", "warn");
        if (preset.options.recipe === "cloud_lineart") {
          if (PS.settingsBlockers(state.settings).length) return toast("云端未就绪", "warn");
          if (!state.batchConsentUpload || !state.batchConsentCharge) return toast("云端批次需要上传与付费两项同意", "warn");
        }
        const steps = ["load"];
        if (preset.options.crop) steps.push("crop");
        if (preset.options.repair) steps.push("repair");
        if (preset.options.candidates) steps.push("ai-pipeline");
        steps.push(preset.options.recipe === "cloud_lineart" ? "cloud-lineart" : preset.options.recipe === "model_lineart" ? "lineart" : "extract");
        if (preset.options.mask) steps.push("mask");
        if (preset.options.vectorize) steps.push("vectorize");
        if (preset.options.tile) steps.push("tile");
        steps.push("publish");
        const batch = {
          id: "batch_" + (2600 + PS.batches.length + rand(30)),
          name: `${preset.name} · ${inputs.length} 图`,
          presetId: preset.id,
          revision: 1,
          state: "running",
          created: "今天 " + U.nowTime(),
          manualGate: null,
          items: inputs.map((id) => ({ pattern: id, state: "queued", cursor: 0, steps: steps.slice(), results: 0 })),
        };
        PS.batches.unshift(batch);
        state.batchConsentUpload = false;
        state.batchConsentCharge = false;
        toast(`批次已创建 · ${inputs.length} 图`);
        return render();
      }
      case "batch-pause": {
        const b = PS.batchById(arg);
        if (!b) return;
        if (b.state === "running") b.state = "paused";
        closeMenu();
        toast("批次已暂停，已开始的任务会完成", "warn");
        return render();
      }
      case "batch-resume": {
        const b = PS.batchById(arg);
        if (!b) return;
        if (b.manualGate) return PS.openBatchGate(b.id, b.manualGate.pattern);
        b.state = "running";
        closeMenu();
        toast("批次已继续");
        return render();
      }
      case "batch-cancel":
        return confirmAction("取消这个批次？", "已完成图片的产物会保留，未开始的图片会标记为取消。", "batch-cancel-confirmed", arg);
      case "batch-cancel-confirmed": {
        const b = PS.batchById(arg);
        if (!b) return;
        closeMenu();
        b.state = "cancelled";
        b.items.forEach((item) => {
          if (!["succeeded", "failed", "cancelled"].includes(item.state)) item.state = "cancelled";
        });
        toast("批次已取消，已完成图片保留", "warn");
        return render();
      }
      case "batch-gate":
        return PS.openBatchGate(String(arg).split(":")[0], String(arg).split(":")[1]);
      case "gate-pick":
        if (state.gate) state.gate.asset = arg;
        return PS.refreshGateModal();
      case "gate-confirm": {
        const [batchId, patternId] = String(arg).split(":");
        const b = PS.batchById(batchId);
        if (!b) return;
        const item = b.items.find((i) => i.pattern === patternId);
        if (item) {
          item.state = "queued";
          item.waitingFor = null;
        }
        b.manualGate = null;
        b.state = "running";
        closeModal();
        toast("已选择续接对象，批次继续");
        return render();
      }
      case "batch-item-resume": {
        const [batchId, patternId] = String(arg).split(":");
        const b = PS.batchById(batchId);
        const item = b ? b.items.find((i) => i.pattern === patternId) : null;
        if (item) {
          item.state = "queued";
          item.cursor = 0;
          item.steps = item.steps.map((s) => s);
          b.manualGate = null;
          b.state = "running";
          toast("已重试该图");
        }
        return render();
      }
      case "batch-export": {
        if (!arg) return openExport("batch", PS.batches[0].id);
        return openExport("batch", arg);
      }
      case "batch-more":
        return openBatchMenu(arg);
      case "settings-open":
        return go("settings");
      case "close-modal":
        return closeModal();
      case "close-drawer":
        return closeDrawer();
      case "close-menu":
        return closeMenu();
      case "cmd-open":
        return openCommand();
      case "cmd-close":
        return U.closeCommand();
      case "cmd-run":
        return runCommand(arg);
      case "confirm-yes": {
        const pending = state.confirm;
        state.confirm = null;
        closeModal();
        if (pending) return runAction(pending.act, pending.arg);
        return;
      }
      default:
        return undefined;
    }
  }

  function runCloud(kind) {
    if (!state.consentUpload || !state.consentCharge) return toast("先勾选上传与付费两项同意", "warn");
    if (PS.settingsBlockers(state.settings).length) return toast("云端未就绪", "warn");
    const p = PS.patternById(state.activePattern);
    if (kind === "pipeline") {
      return startRun({
        kind: "pipeline",
        label: "云端拆分候选",
        stage: 4,
        file: "lotus-candidate-1.svg",
        size: "640 × 640",
        cloud: true,
        price: PS.prices.candidate,
        advance: false,
        after: () => {
          const flow = PS.flowFor(state.activePattern);
          if (flow) flow.state = "awaiting_selection";
          toast("候选层已更新，请重新勾选后合成");
          render();
        },
      });
    }
    return startRun({ kind, label: "云端任务", stage: state.stage, file: p.orig, cloud: true, price: PS.prices.lineart, advance: true });
  }

  function runAux(kind) {
    const p = PS.patternById(state.activePattern);
    if (kind === "prepare") return startRun({ kind: "prepare", label: "摆正", stage: 2, file: p.orig, size: p.size, advance: false });
    if (kind === "working-copy") return startRun({ kind: "working-copy", label: "工作副本", stage: 2, file: p.orig, size: "1000 × 1000", advance: false });
    if (kind === "enhance") return startRun({ kind: "enhance", label: "图像增强", stage: 2, file: p.orig, size: p.size, advance: false });
    if (kind === "repair-local") {
      if (!state.health.capabilities.leftrefill_model.available) return toast("本地 LeftRefill 不可用", "warn");
      return startRun({ kind: "repair", label: "本地修复候选", stage: 3, file: "lotus-repair.svg", size: "1000 × 1000", advance: false, after: () => openRepairReview() });
    }
    return undefined;
  }

  function runPrimary() {
    const p = PS.patternById(state.activePattern);
    const s = state.stage;
    if (s === 1) return goStage(2);
    if (s === 8) return openExport("pattern", state.activePattern);
    if (s === 3 && state.repairMode === "skip") {
      state.done.add(3);
      toast("已跳过局部修复，不产生云端调用");
      return goStage(4);
    }
    if (s === 2) return startRun({ kind: "crop", label: "裁切", stage: 2, file: "lotus-crop.svg", size: "720 × 720", advance: true });
    if (s === 3) {
      const local = state.repairMode === "local";
      return startRun({
        kind: "repair",
        label: local ? "本地修复候选" : "云端修复候选",
        stage: 3,
        file: "lotus-repair.svg",
        size: "1000 × 1000",
        cloud: !local,
        price: PS.prices.repair,
        advance: false,
        after: () => openRepairReview(),
      });
    }
    if (s === 4) {
      if (!state.cands.size) return toast("至少勾选一层候选", "warn");
      return startRun({ kind: "compose-layers", label: "候选合成", stage: 4, file: "lotus-candidate-1.svg", size: "640 × 640", advance: true });
    }
    if (s === 5) {
      if (state.procMode === "cloud") {
        return startRun({ kind: "cloud-lineart", label: "云端线稿", stage: 5, file: "lotus-line.svg", size: "1000 × 1000", cloud: true, price: PS.prices.lineart, advance: true });
      }
      if (state.procMode === "color") {
        return startRun({ kind: "extract", label: "透明 PNG", stage: 5, file: "lotus-mask.svg", size: "1000 × 1000", advance: true });
      }
      return startRun({ kind: state.procMode === "opencv" ? "lineart" : "lineart", label: "线稿 PNG", stage: 5, file: "lotus-line.svg", size: "1000 × 1000", advance: true });
    }
    if (s === 6) return startRun({ kind: "refine-mask", label: "蒙版修正", stage: 6, file: "lotus-mask.svg", size: "1000 × 1000", advance: true });
    if (s === 7) return startRun({ kind: "vectorize", label: "矢量 SVG", stage: 7, file: "lotus-vector.svg", size: "1000 × 1000", advance: true });
    return undefined;
  }

  /* ------------------------------------------------------------ 批量 ticker */
  function advanceBatches() {
    let changed = false;
    PS.batches.forEach((batch) => {
      if (batch.demo || batch.state !== "running" || batch.manualGate) return;
      let item = batch.items.find((i) => i.state === "running");
      if (!item) {
        item = batch.items.find((i) => i.state === "queued");
        if (item) {
          item.state = "running";
          item.cursor = 0;
          changed = true;
        }
      }
      if (!item) {
        if (batch.items.every((i) => ["succeeded", "failed", "cancelled"].includes(i.state))) {
          batch.state = "succeeded";
          batch.revision += 1;
          changed = true;
        }
        return;
      }
      item.cursor += 1;
      item.results = Math.min(item.steps.length, Math.max(item.results || 0, Math.floor(item.cursor / 2)));
      if (item.cursor >= item.steps.length) {
        item.state = "succeeded";
        item.cursor = item.steps.length;
        item.results = Math.max(item.results || 0, 2);
        batch.revision += 1;
      }
      changed = true;
    });
    if (changed && state.route === "batch" && !isEditingField()) render();
  }

  /* ------------------------------------------------------------ 路由 */
  function parseRoute() {
    const raw = location.hash.replace(/^#\/?/, "");
    const [path, qs] = raw.split("?");
    const route = PS.views[path] ? path : "home";
    state.route = route;
    const query = new URLSearchParams(qs || "");
    if (route === "workbench") {
      const pid = query.get("pattern");
      if (pid && PS.patternById(pid) && pid !== state.activePattern) loadPattern(pid);
      const stage = Number(query.get("stage"));
      if (stage >= 1 && stage <= 8) state.stage = stage;
      if (query.get("compare") === "1") state.compare = true;
      const tile = Number(query.get("tile"));
      if (tile === 2 || tile === 3) state.tileN = tile;
    }
    closeDrawer();
    closeModal();
    U.closeCommand();
    closeMenu();
    render();
  }

  function initialize() {
    const params = new URLSearchParams(location.search);
    const theme = params.get("theme");
    if (theme === "ink" || theme === "paper") {
      state.theme = theme;
      document.documentElement.dataset.theme = theme;
    }
    const stage = Number(params.get("stage"));
    if (stage >= 1 && stage <= 8) state.stage = stage;
    if (params.get("compare") === "1") state.compare = true;
    if (!location.hash) location.hash = "#/home";
    parseRoute();
  }

  /* ------------------------------------------------------------ 事件 */
  document.addEventListener("click", (event) => {
    const scrollLink = event.target.closest("[data-scroll]");
    if (scrollLink) {
      event.preventDefault();
      $$("[data-scroll]").forEach((a) => a.classList.toggle("is-on", a === scrollLink));
      const target = document.getElementById(scrollLink.dataset.scroll);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    const themePick = event.target.closest("[data-theme-pick]");
    if (themePick) {
      state.theme = themePick.dataset.themePick;
      document.documentElement.dataset.theme = state.theme;
      return render();
    }

    const segButton = event.target.closest("[data-seg]");
    if (segButton && segButton.tagName === "BUTTON") {
      const path = segButton.dataset.seg;
      const raw = segButton.dataset.val;
      const value = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
      set(state, path, value);
      if (path === "provider.op" && state.provider) {
        state.provider.intent = value === "edit" ? "restore_small_gap" : value === "lineart" ? "extract_lineart" : "separate_pattern";
      }
      if (segButton.closest("#modal")) refreshModal();
      else render();
      return;
    }

    const cand = event.target.closest("[data-cand]");
    if (cand) {
      const n = Number(cand.dataset.cand);
      if (state.cands.has(n)) state.cands.delete(n);
      else state.cands.add(n);
      return render();
    }

    const procMode = event.target.closest("[data-proc-mode]");
    if (procMode) {
      state.procMode = procMode.dataset.procMode;
      state.consentUpload = false;
      state.consentCharge = false;
      return render();
    }

    const repairMode = event.target.closest("[data-repair-mode]");
    if (repairMode) {
      state.repairMode = repairMode.dataset.repairMode;
      state.consentUpload = false;
      state.consentCharge = false;
      return render();
    }

    const actionEl = event.target.closest("[data-act]");
    if (actionEl) {
      event.preventDefault();
      if (actionEl.dataset.act !== "wb-more" && actionEl.dataset.act !== "batch-more") closeMenu();
      runAction(actionEl.dataset.act, actionEl.dataset.arg);
      return;
    }

    if (!event.target.closest("#menu")) closeMenu();
  });

  document.addEventListener("change", (event) => {
    const el = event.target;
    if (el.matches("#upload-file")) {
      const file = el.files && el.files[0];
      if (!file) return;
      state.upload.file = file;
      state.upload.demo = false;
      state.upload.size = "";
      if (!state.upload.name) state.upload.name = file.name.replace(/\.[^.]+$/, "");
      if (state.upload.preview && state.upload.preview.startsWith("blob:")) URL.revokeObjectURL(state.upload.preview);
      state.upload.preview = URL.createObjectURL(file);
      return refreshUploadModal();
    }
    if (el.matches("[data-toggle]")) {
      const path = el.dataset.toggle;
      set(state, path, el.checked);
      if (el.closest("#modal")) return refreshModal();
      return render();
    }
    if (el.matches("[data-bind]")) {
      const path = el.dataset.bind;
      const isNumber = el.type === "number" || el.type === "range";
      set(state, path, isNumber ? Number(el.value) : el.value);
      if (el.dataset.rerender) return render();
    }
    if (el.matches("[data-lib-sort]")) {
      state.lib.sort = el.value;
      return render();
    }
    if (el.matches("[data-pdraft]")) {
      const path = el.dataset.pdraft;
      const isNumber = el.type === "number";
      set(state.presetDraft, path, isNumber ? Number(el.value) : el.value);
      return;
    }
    if (el.matches("[data-pdraft-check]")) {
      const path = el.dataset.pdraftCheck;
      set(state.presetDraft, path, el.checked);
      const row = el.closest(".check-line");
      if (row) {
        row.classList.toggle("is-on", el.checked);
        const check = row.querySelector(".check");
        if (check) check.classList.toggle("is-checked", el.checked);
      }
      return;
    }
  });

  document.addEventListener("input", (event) => {
    const el = event.target;
    if (el.matches("[data-range]")) {
      const min = Number(el.min);
      const max = Number(el.max);
      const value = Number(el.value);
      set(state, el.dataset.range, value);
      el.style.setProperty("--p", ((value - min) / (max - min)) * 100 + "%");
      const out = $(`[data-val="${el.dataset.range}"]`);
      if (out) {
        const decimals = Number(el.dataset.decimals || 0);
        out.textContent = (decimals ? value.toFixed(decimals) : value) + (el.dataset.unit || "");
      }
      if (el.dataset.range === "params.mask.radius") {
        const dot = $("[data-brush-dot]");
        if (dot) {
          dot.style.width = value + "px";
          dot.style.height = value + "px";
        }
      }
      return;
    }
    if (el.matches("[data-lib-search]")) {
      state.lib.query = el.value;
      return PS.refreshLibrary();
    }
    if (el.matches("[data-picker-search]")) {
      state.pickerQuery = el.value;
      return PS.refreshPicker();
    }
    if (el.matches("#cmd-input")) {
      state.commandQuery = el.value;
      state.commandIndex = 0;
      return paintCommands();
    }
    if (el.matches("[data-upload-field]")) {
      state.upload[el.dataset.uploadField] = el.value;
      return;
    }
    if (el.matches("[data-meta-field]")) {
      return;
    }
    if (el.matches("[data-feedback-comment]")) {
      state.feedback.comment = el.value;
      return;
    }
    if (el.matches("[data-settlement-cost]")) {
      state.settlement.cost = el.value;
      return;
    }
    if (el.matches("[data-settlement-ref]")) {
      state.settlement.ref = el.value;
      return;
    }
    if (el.matches("[data-recolor]")) {
      state.recolor[el.dataset.recolor] = el.value;
      return;
    }
    if (el.matches("[data-pdraft]")) {
      const isNumber = el.type === "number";
      set(state.presetDraft, el.dataset.pdraft, isNumber ? Number(el.value) : el.value);
      return;
    }
    if (el.matches("[data-bind]")) {
      const isNumber = el.type === "number";
      set(state, el.dataset.bind, isNumber ? Number(el.value) : el.value);
    }
  });

  document.addEventListener("pointerdown", (event) => {
    const cmp = event.target.closest("[data-compare]");
    if (!cmp) return;
    event.preventDefault();
    const move = (ev) => {
      const rect = cmp.getBoundingClientRect();
      const pos = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width) * 100));
      cmp.style.setProperty("--pos", pos + "%");
    };
    move(event);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (document.body.classList.contains("is-cmd")) U.closeCommand();
      else openCommand();
      return;
    }
    if (document.body.classList.contains("is-cmd")) {
      const items = filteredCommands();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.commandIndex = Math.min(items.length - 1, state.commandIndex + 1);
        return paintCommands();
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        state.commandIndex = Math.max(0, state.commandIndex - 1);
        return paintCommands();
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const item = items[state.commandIndex];
        if (item) runCommand(item.id);
        return;
      }
    }
    if (event.key === "Escape") {
      if (document.body.classList.contains("is-cmd")) return U.closeCommand();
      if (document.body.classList.contains("is-modal")) return closeModal();
      if (document.body.classList.contains("is-drawer")) return closeDrawer();
      return closeMenu();
    }
    if (event.target.matches("input, textarea, select")) return;
    if (state.route !== "workbench" || state.running) return;
    if (/^[1-8]$/.test(event.key)) return goStage(Number(event.key));
    if (event.key.toLowerCase() === "c" && state.stage > 1 && state.stage !== 4 && state.stage !== 8) {
      state.compare = !state.compare;
      return render();
    }
    if (event.key === "[" || event.key === "]") {
      const idx = PS.workbenchItems.indexOf(state.activePattern);
      const next = PS.workbenchItems[(idx + (event.key === "]" ? 1 : PS.workbenchItems.length - 1) + PS.workbenchItems.length) % PS.workbenchItems.length];
      loadPattern(next, PS.patternById(next).stage);
      return render();
    }
  });

  $("#scrim").addEventListener("click", closeDrawer);
  window.addEventListener("hashchange", parseRoute);

  setInterval(advanceBatches, 1900);

  initialize();
})();

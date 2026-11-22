/* =============================================================================
   工作台：八道工序 + 版本 / 纹样列 + 云端门禁
   ============================================================================= */
(function () {
  "use strict";
  const PS = window.PS;
  const U = PS.ui;
  const { icon, plate, stamp, esc, money, get, openModal, toast } = U;

  PS.views = PS.views || {};

  function kv(rows) {
    return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  }
  function isec(title, body, meta = "") {
    return `<div class="isec">${title ? `<div class="isec__title"><span>${title}</span>${meta ? `<span class="mono">${meta}</span>` : ""}</div>` : ""}${body}</div>`;
  }
  function adv(summary, body) {
    return `<details class="adv"><summary>${summary}</summary><div class="adv__body">${body}</div></details>`;
  }
  function coordInputs(base) {
    const keys = [["x", "X"], ["y", "Y"], ["w", "W"], ["h", "H"]];
    return `<div class="coord-grid">${keys
      .map(([k, label]) => `<label class="coord"><span>${label}</span><input class="input" value="${esc(get(PS.state, base + "." + k))}" data-bind="${base}.${k}" /></label>`)
      .join("")}</div>`;
  }
  function cloudBlockers() {
    return PS.settingsBlockers(PS.state.settings);
  }
  function consentsOk() {
    return cloudBlockers().length === 0 && PS.state.consentUpload && PS.state.consentCharge;
  }
  function cloudGate() {
    const blockers = cloudBlockers();
    if (!blockers.length) return "";
    return U.callout("warn", `云端暂不可用：${blockers.map((b) => PS.blockerLabels[b]).join("、")}。本机工序不受影响。`, "cloud");
  }
  function costBlock(priceCents, desc) {
    return `<div class="cost">
      <div class="cost__row"><span>本次预估</span><b>${money(priceCents)}</b></div>
      <div class="cost__row"><span class="note">${desc}</span><span class="note">按次确认</span></div>
      ${U.toggleRow("同意上传当前输入", "只发送本次工序需要的像素与区域", "consentUpload")}
      ${U.toggleRow("确认价格并同意按次付费", `${money(priceCents)} · 1 次调用`, "consentCharge")}
    </div>`;
  }

  /* ---------------------------------------------------------------- 左栏 */
  function versionsColumn() {
    const state = PS.state;
    const p = PS.patternById(state.activePattern);
    if (state.leftTab === "items") {
      const rows = PS.workbenchItems
        .map((id) => {
          const item = PS.patternById(id);
          const current = id === p.id;
          return `<div style="display:grid;grid-template-columns:1fr 24px;gap:2px;align-items:center">
            <button class="item-card ${current ? "is-current" : ""}" data-act="open-pattern" data-arg="${id}" title="在工作台打开 ${esc(item.name)}">
              ${plate(item.orig, "item-card__img")}
              <span><b>${esc(item.name)}</b><small>${esc(item.era)} · 0${item.stage}</small></span>
            </button>
            <button class="vitem__del" data-act="wb-items-remove" data-arg="${id}" title="从纹样列移除" aria-label="从纹样列移除">${icon("x", "ic--sm")}</button>
          </div>`;
        })
        .join("");
      return `
        <div class="versions__head"><h3>纹样</h3><span class="chip">${PS.workbenchItems.length}</span></div>
        <div class="versions__tabs">
          <button data-act="wb-left-tab" data-arg="versions">版本</button>
          <button class="is-on" data-act="wb-left-tab" data-arg="items">纹样</button>
        </div>
        <div class="versions__list">${rows || U.empty("纹样列为空", "从纹样库挑选", "library")}</div>
        <div class="versions__foot">
          <button class="btn btn--sm btn--block" data-act="wb-items-add">${icon("plus", "ic--sm")}添加纹样</button>
          <button class="btn btn--sm btn--block btn--ghost" data-act="wb-items-clear">清空纹样列</button>
        </div>`;
    }

    const groups = state.versions || {};
    let total = 0;
    const html = Object.keys(groups)
      .map(Number)
      .sort((a, b) => b - a)
      .map((n) => {
        const list = groups[n] || [];
        total += list.length;
        return `<div class="vgroup">
          <div class="vgroup__label"><span><span class="num">0${n}</span>${PS.stageOf(n).name}</span><span class="num">${list.length}</span></div>
          ${list
            .slice()
            .reverse()
            .map(
              (v, i) => `<button class="vitem ${n === state.stage && i === 0 ? "is-current" : ""}" data-act="stage" data-arg="${n}" title="${esc(v.label)} · ${esc(v.size)}">
                ${plate(v.file, "vitem__img")}
                <span><b>${esc(v.label)}</b><small>${esc(v.size)} · ${esc(v.time)}</small></span>
                <span class="vitem__v">v${list.length - i}</span>
              </button>`
            )
            .join("")}
        </div>`;
      })
      .join("");

    return `
      <div class="versions__head"><h3>版本</h3><span class="chip">${total}</span></div>
      <div class="versions__tabs">
        <button class="is-on" data-act="wb-left-tab" data-arg="versions">版本</button>
        <button data-act="wb-left-tab" data-arg="items">纹样</button>
      </div>
      <div class="versions__list">${html}</div>
      <div class="versions__foot">
        <button class="btn btn--sm btn--block" data-act="wb-items-add">${icon("plus", "ic--sm")}添加纹样</button>
      </div>`;
  }

  /* ---------------------------------------------------------------- 画布 */
  function canvasContent() {
    const state = PS.state;
    const s = state.stage;
    const st = PS.stageOf(s);
    const p = PS.patternById(state.activePattern);
    const z = `style="transform:scale(${state.zoom})"`;
    const base = p.orig;

    if (s === 4) {
      const layers = (PS.flowFor(p.id) || {}).layers || [
        { id: "l1", name: "主体 · 外圈莲瓣", color: "#23355e" },
        { id: "l2", name: "主体 · 缠枝", color: "#3b5a8f" },
        { id: "l3", name: "底纹 · 分色", color: "#b9c7df" },
      ];
      return `<div class="cand-grid">${layers
        .map(
          (layer, i) => `<div class="cand ${state.cands.has(i + 1) ? "is-checked" : ""}" data-cand="${i + 1}">
            <span class="check">${icon("check")}</span>
            ${plate("lotus-candidate-" + ((i % 3) + 1) + ".svg", "cand__img")}
            <div class="cand__meta"><div><b>候选层 ${i + 1} · ${esc(layer.name)}</b><small>${i === 0 ? "主体轮廓" : i === 1 ? "缠枝细线" : "底纹填色"}</small></div><span class="mono muted">640²</span></div>
          </div>`
        )
        .join("")}</div>`;
    }

    if (s === 8) {
      return `<div class="tile-view"><div class="tile-sheet ${state.seams ? "show-seams" : ""}" style="--n:${state.tileN};transform:scale(${state.zoom})"></div></div>`;
    }

    let inner;
    if (state.compare && s > 1) {
      inner = `<div class="plate" style="width:100%;height:100%">${U.compareBlock(base, st.img)}</div>`;
    } else {
      let overlay = "";
      let file = st.img;
      if (s === 2) {
        file = base;
        overlay = `<div class="crop-box"><i></i><i></i><i></i><i></i><span>${esc(get(PS.state, "params.crop.w"))} × ${esc(get(PS.state, "params.crop.h"))}</span></div>`;
      }
      if (s === 3) {
        file = base;
        overlay = `<svg class="overlay-svg" viewBox="0 0 1000 1000"><circle class="repair-ring" cx="700" cy="300" r="92"/><circle class="repair-ring" cx="262" cy="742" r="64"/></svg>`;
      }
      if (s === 6) {
        overlay = `<svg class="overlay-svg" viewBox="0 0 1000 1000">
          <path class="mask-stroke mask-stroke--add" stroke-width="46" d="M300 640 C 340 690, 420 720, 500 720 S 640 700, 690 650"/>
          <path class="mask-stroke mask-stroke--core" d="M300 640 C 340 690, 420 720, 500 720 S 640 700, 690 650"/>
          <path class="mask-stroke mask-stroke--erase" stroke-width="34" d="M180 220 L 250 180 L 320 210"/>
          <path class="mask-stroke mask-stroke--core" d="M180 220 L 250 180 L 320 210"/>
        </svg>`;
      }
      if (s === 7) {
        const sel = PS.svg.elements.find((e) => e.id === state.selectedElement);
        overlay = `<svg class="overlay-svg" viewBox="0 0 1000 1000" style="pointer-events:none">
          <rect x="${120 + (sel ? sel.dx / 4 : 0)}" y="${160 + (sel ? sel.dy / 4 : 0)}" width="360" height="300" fill="none" stroke="#b23f2a" stroke-width="2" stroke-dasharray="8 6" rx="6"/>
        </svg>`;
      }
      inner = `<div class="plate" style="width:100%;height:100%">${overlay}<img src="${PS.ASSETS}${file}" alt="" /></div>`;
    }
    return `<div class="canvas__stage"><div class="canvas__plate" ${z}>${inner}</div></div>`;
  }

  /* ---------------------------------------------------------------- 参数面板 */
  function inspectorBody() {
    const state = PS.state;
    const s = state.stage;
    const p = PS.patternById(state.activePattern);

    switch (s) {
      case 1:
        return `
          <div class="isec">
            <div class="dropzone" data-act="upload" role="button" tabindex="0">
              ${icon("upload", "ic--lg")}
              <b>拖入图片，或点击选择</b>
              <span class="field__hint">PNG / JPG / TIFF · 单张最大 20 MB · 长边解码上限 25 MP</span>
            </div>
          </div>
          ${isec(
            "来源信息",
            `${kv([
              ["名称", esc(p.name)],
              ["年代", esc(p.era)],
              ["品类", esc(p.kind)],
              ["评级", stamp(p.grade, "width:20px;height:20px;font-size:11px")],
              ["许可", esc(p.license)],
              ["分类", PS.categoryNames(p).map((n) => `<span class="cat-chip">${esc(n)}</span>`).join(" ") || "—"],
            ])}
            <div class="row" style="margin-top:12px"><button class="btn btn--sm" data-act="wb-meta">${icon("tag", "ic--sm")}编辑资料</button><button class="btn btn--sm" data-act="history" data-arg="assets">${icon("history", "ic--sm")}历史</button><button class="btn btn--sm btn--ghost" data-act="upload">${icon("upload", "ic--sm")}上传新纹样</button></div>`
          )}
          ${isec(
            "原图",
            kv([
              ["尺寸", `<span class="num">${esc(p.size)} px</span>`],
              ["规范输入", `<span class="num">1000 × 1000 px</span>`],
              ["格式", "PNG · sRGB"],
              ["SHA-256", `<span class="mono">3f9c6d2a…5a6b</span>`],
              ["近似版本", p.id === "lotus" ? "发现 2 个近似" : "未发现"],
              ["采集于", esc(p.collectedAt)],
            ]),
            "original"
          )}
          ${isec(
            "历史集合",
            `<div class="row row--wrap">
              <button class="btn btn--sm" data-act="history" data-arg="assets">资产 ${p.assetCount}</button>
              <button class="btn btn--sm" data-act="history" data-arg="jobs">任务 ${PS.jobs.filter((j) => j.pattern === p.id).length}</button>
              <button class="btn btn--sm" data-act="history" data-arg="flows">云端流程 ${PS.flows.filter((f) => f.pattern === p.id).length}</button>
            </div>
            <span class="field__hint">按图历史接口分页读取 assets / jobs / flows，不触发任何处理。</span>`
          )}`;
      case 2:
        return `
          ${isec(
            "比例",
            U.seg("params.crop.ratio", [["自由", "自由"], ["1:1", "1 : 1"], ["4:3", "4 : 3"], ["原图", "原图"]], { label: "裁切比例" }),
            "裁剪框"
          )}
          ${isec(
            "坐标",
            `${coordInputs("params.crop")}
            <span class="field__hint">真实像素，半开区间；在画布上拖动四角调整，或直接填写。</span>`,
            "像素"
          )}
          ${isec(
            "摆正",
            `${U.seg("params.crop.rotation", [["0", "0°"], ["90", "90°"], ["180", "180°"], ["270", "270°"]], { small: true, label: "旋转" })}
            ${U.range("params.crop.straighten", "微调角度", -15, 15, 0.5, "°")}
            <button class="btn btn--sm btn--block" data-act="run-aux" data-arg="prepare">${icon("refresh", "ic--sm")}应用旋转与摆正</button>`
          )}
          ${isec(
            "工作副本",
            `${U.inputRow("最大像素", "params.crop.workingMax", { type: "number", min: 10000, max: 25000000, step: 100000, mono: true, hint: "颜色矢量化建议 ≤ 25 万像素；模型线稿上限 25 MP。" })}
            <button class="btn btn--sm btn--block" data-act="run-aux" data-arg="working-copy">${icon("image", "ic--sm")}创建工作副本</button>`
          )}
          ${adv(
            "图像增强（可选）",
            `${U.range("params.crop.brightness", "亮度", 0.2, 3, 0.05, "×")}
            ${U.range("params.crop.contrast", "对比度", 0.2, 3, 0.05, "×")}
            ${U.range("params.crop.sharpen", "锐化", 0, 1, 0.05)}
            ${U.seg("params.crop.denoise", [["0", "不去噪"], ["1", "轻度"], ["2", "较强"]], { small: true, label: "去噪" })}
            <button class="btn btn--sm btn--block" data-act="run-aux" data-arg="enhance">${icon("wand", "ic--sm")}应用增强</button>`
          )}`;
      case 3: {
        const mode = state.repairMode;
        return `
          ${isec(
            "处理方式",
            `<div class="mode-cards">
              <button class="mode-card ${mode === "skip" ? "is-on" : ""}" data-repair-mode="skip">${icon("arrow")}<b>跳过修复</b><small>纹样完整，直接进入候选</small></button>
              <button class="mode-card ${mode === "local" ? "is-on" : ""}" data-repair-mode="local">${icon("cpu")}<b>本地 LeftRefill</b><small>本机扩散修复，不产生费用</small></button>
              <button class="mode-card ${mode === "cloud" ? "is-on" : ""}" data-repair-mode="cloud">${icon("cloud")}<b>云端修复</b><small>生成 1–2 张候选，按次确认</small></button>
            </div>`
          )}
          ${
            mode === "skip"
              ? U.callout("ok", "跳过后不写入修复版本，也不会发出云端请求；候选与提取仍可继续。", "check")
              : mode === "local"
                ? `${isec(
                    "本地修复",
                    `${U.selectRow("参考图", "params.repair.reference", [["asset-lotus-3-1", "同图裁切 · 14:06"], ["asset-baoxiang-1-1", "宝相花原图"], ["asset-cloud-2-1", "如意云纹裁切"]], { hint: "LeftRefill 需要显式参考资产，不会回退到原图。" })}
                    ${U.inputRow("随机种子", "params.repair.seed", { type: "number", min: 0, max: 2147483647, mono: true })}
                    ${U.seg("params.repair.intent", [["restore_small_gap", "补小缺口"], ["reconnect_lines", "接续断线"]], { small: true, label: "修复意图" })}
                    ${U.range("params.repair.feather", "羽化", 0, 64, 1, " px")}
                    <div class="callout">${icon("cpu")}<div>本机修复使用 GPU 显存上限 4,096 MiB；耗时通常 20–60 秒。</div></div>
                    <button class="btn btn--sm btn--block" data-act="run-aux" data-arg="repair-local">${icon("wand", "ic--sm")}生成本地修复候选</button>`
                  )}`
                : `${isec(
                    "修复区域",
                    `${coordInputs("params.repair.bbox")}
                    ${U.range("params.repair.feather", "羽化", 0, 64, 1, " px")}
                    ${U.seg("params.repair.size", [["1K", "1K"], ["1.5K", "1.5K"], ["2K", "2K"]], { small: true, label: "输出尺寸" })}
                    ${U.toggleRow("同时保存损伤蒙版", "记录本次圈选区域，便于回溯", "params.repair.saveMask")}
                    <span class="field__hint">修复只允许补小缺口或接续断线；修复提示词固定，不接受自由文本。</span>`
                  )}
                    ${cloudGate()}
                    ${costBlock(PS.prices.repair, "预计 1 次调用 · 最多 2 张候选")}`
          }
          ${isec(
            "修复记录",
            `<div class="flow-note">${icon("history", "ic--sm")}<div>revision ${PS.repair.revision} · ${U.stateChip(PS.repair.state)} · ${PS.repair.candidates} 张候选 · 决定：${PS.repair.decided ? esc(PS.repair.decided) : "未记录"}</div></div>
            <button class="btn btn--sm btn--block" data-act="repair-review">${icon("layers", "ic--sm")}查看修复候选</button>`
          )}`;
      }
      case 4: {
        const flow = PS.flowFor(p.id);
        const layers = (flow || {}).layers || [
          { id: "l1", name: "主体 · 外圈莲瓣", color: "#23355e" },
          { id: "l2", name: "主体 · 缠枝", color: "#3b5a8f" },
          { id: "l3", name: "底纹 · 分色", color: "#b9c7df" },
        ];
        return `
          ${isec(
            "流程",
            `<div class="row" style="justify-content:space-between"><span class="note">${flow ? esc(flow.id) : "未建立流程"} · revision ${flow ? flow.revision : 0}</span>${U.stateChip(flow ? flow.state : "queued")}</div>
            ${flow && flow.needsReconcile ? U.callout("warn", "上一次云端结果未知：先到任务或设置台账核对调用状态，模板不会自动重发。", "shield") : ""}
            ${flow ? `<div class="job-steps">${flow.steps.map(U.jobStep).join("")}</div>` : ""}`,
            "pipeline"
          )}
          ${isec(
            "拆分提示词",
            `${U.selectRow("提示词版本", "params.candidate.promptVersion", [["decompose-v3.2", "decompose-v3.2"], ["decompose-v3.1", "decompose-v3.1（归档）"]], { hint: "提示词固定版本，界面不提供自由文本。", rerender: true })}
            ${U.seg("params.candidate.size", [["1K", "1K"], ["1.5K", "1.5K"], ["2K", "2K"], ["auto", "auto"]], { small: true, label: "生成尺寸" })}
            ${U.seg("params.candidate.policy", [["auto_or_confirm", "自动或确认"], ["manual", "全部人工确认"]], { small: true, label: "选层策略" })}`
          )}
          ${isec(
            "候选层",
            `<ul class="layer-list">${layers
              .map(
                (layer, i) => `<li data-cand="${i + 1}" style="cursor:pointer">
                  <span class="check ${state.cands.has(i + 1) ? "is-checked" : ""}">${icon("check")}</span>
                  <span class="sw" style="background:${layer.color}"></span>
                  <span>${esc(layer.name)}</span>
                  <small>${layer.id}</small>
                </li>`
              )
              .join("")}
            </ul>
            <span class="field__hint">已选 ${state.cands.size} 层；合成按勾选顺序叠放，不生成线稿。</span>`,
            `${state.cands.size} / ${layers.length}`
          )}
          ${isec(
            "云端拆分",
            `${cloudGate()}
            ${costBlock(PS.prices.candidate, "重新拆分 · 1 次调用 · 约 38 秒")}
            <button class="btn btn--sm btn--block" data-act="run-cloud" data-arg="pipeline" ${consentsOk() ? "" : "disabled"}>${icon("cloud", "ic--sm")}重新拆分候选层</button>`
          )}
          ${isec(
            "流程分支",
            `<div class="row row--wrap">
              <button class="btn btn--sm" data-act="flow-use-local">${icon("cpu", "ic--sm")}改用本地提取</button>
              <button class="btn btn--sm btn--ghost" data-act="flow-reject">拒绝本次候选</button>
              <button class="btn btn--sm btn--ghost" data-act="flow-history">流程记录</button>
            </div>
            <span class="field__hint">continue 用于首次选层；后续改选用 rerun（compose），不改动已归档结果。</span>`
          )}`;
      }
      case 5: {
        const mode = state.procMode;
        const methodCards = [
          ["local", "cpu", "本地模型", "线稿 v0.2 · CUDA"],
          ["cloud", "cloud", "云端模型", "按次确认"],
          ["opencv", "feather", "OpenCV 线稿", "无模型，最快"],
          ["color", "layers", "颜色提取", "保留色块"],
        ];
        const method = `<div class="mode-cards">${methodCards
          .map(
            ([k, ic, title, sub]) =>
              `<button class="mode-card ${mode === k ? "is-on" : ""}" data-proc-mode="${k}">${icon(ic)}<b>${title}</b><small>${sub}</small></button>`
          )
          .join("")}</div>`;
        let params = "";
        if (mode === "local") {
          const cap = PS.state.health.capabilities.lineart_model;
          params = `${cap.available ? "" : U.callout("warn", `本地线稿模型前置检查未通过：${esc(cap.reason || "unknown")}。可改用 OpenCV 或颜色提取。`, "alert")}
            ${adv(
              "线稿参数",
              `${U.range("params.process.hi", "高光保留", 50, 99.5, 0.5, "%")}
              ${U.range("params.process.tile", "平铺阈值", 50, 99.5, 0.5, "%")}
              ${U.range("params.process.sd", "标准差阈值", 0, 64, 1)}
              ${U.selectRow("中值核", "params.process.med", [["0", "自动"], ["3", "3"], ["5", "5"], ["7", "7"], ["9", "9"]])}
              ${U.inputRow("最小面积", "params.process.minArea", { type: "number", min: 0, max: 10000, mono: true, hint: "小于该面积的孤立笔画会被清除。" })}`,
              "统一参数"
            )}
            ${U.toggleRow("透明背景", "输出 RGBA PNG，供蒙版与矢量化使用", "params.process.transparent")}
            <div class="flow-note">${icon("cpu", "ic--sm")}<div>本机模型显存上限 8,192 MiB；25 MP 输入会分块推理。</div></div>`;
        } else if (mode === "cloud") {
          params = `${cloudGate()}
            ${U.seg("params.process.size", [["1K", "1K"], ["1.5K", "1.5K"], ["2K", "2K"], ["auto", "auto"]], { small: true, label: "生成尺寸" })}
            ${U.inputRow("提示词版本", "params.process.promptVersion", { readonly: true, mono: true, hint: "云端线稿使用注册提示词，不接受自由文本。" })}
            ${costBlock(PS.prices.lineart, "云端线稿 · 1 次调用 · 约 22 秒")}`;
        } else if (mode === "opencv") {
          params = `${U.range("params.process.hi", "高光保留", 50, 99.5, 0.5, "%")}
            ${U.range("params.process.tile", "平铺阈值", 50, 99.5, 0.5, "%")}
            ${U.range("params.process.sd", "标准差阈值", 0, 64, 1)}
            ${U.inputRow("最小面积", "params.process.minArea", { type: "number", min: 0, max: 10000, mono: true })}
            ${U.toggleRow("透明背景", "输出 RGBA PNG", "params.process.transparent")}
            <span class="field__hint">OpenCV 轮廓在 4 MP 输入内最稳；超过时先创建工作副本。</span>`;
        } else {
          params = `${U.selectRow("提取模式", "params.process.extractMode", [
            ["otsu", "Otsu 全局阈值"],
            ["manual", "手动阈值"],
            ["adaptive_mean", "自适应均值"],
            ["adaptive_gaussian", "自适应高斯"],
            ["sauvola", "Sauvola 局部阈值"],
            ["grabcut", "GrabCut 矩形"],
            ["alpha", "保留现有 alpha"],
          ], { rerender: true })}
            ${U.seg("params.process.polarity", [["dark", "深色前景"], ["light", "浅色前景"]], { small: true, label: "极性" })}
            ${["otsu", "manual"].includes(get(PS.state, "params.process.extractMode")) ? U.range("params.process.threshold", "阈值", 0, 255, 1) : ""}
            ${["adaptive_mean", "adaptive_gaussian", "sauvola"].includes(get(PS.state, "params.process.extractMode"))
              ? `${U.range("params.process.window", "窗口大小", 3, 255, 2, " px", "必须为奇数。")}
                 ${U.range("params.process.offset", "偏移", -50, 50, 1)}
                 ${U.toggleRow("CLAHE 预增强", "低对比度拓片可开启", "params.process.clahe")}`
              : ""}
            ${get(PS.state, "params.process.extractMode") === "grabcut"
              ? `${U.range("params.process.iterations", "迭代次数", 1, 10, 1)}
                 ${coordInputs("params.process.extractBbox")}`
              : ""}
            ${adv(
              "清理与增强（可选）",
              `${U.inputRow("最小连通面积", "params.process.minComp", { type: "number", min: 0, max: 10000, mono: true })}
              ${U.inputRow("最大孔洞面积", "params.process.maxHole", { type: "number", min: 0, max: 10000, mono: true })}
              ${U.range("params.process.brightness", "亮度", 0.2, 3, 0.05, "×")}
              ${U.range("params.process.contrast", "对比度", 0.2, 3, 0.05, "×")}
              ${U.range("params.process.sharpen", "锐化", 0, 1, 0.05)}
              ${U.seg("params.process.denoise", [["0", "不去噪"], ["1", "轻度"], ["2", "较强"]], { small: true, label: "去噪" })}`,
              "extract"
            )}`;
        }
        return `${isec("提取方式", method)}${isec("参数", params)}`;
      }
      case 6:
        return `
          ${isec(
            "算法",
            `${U.seg("params.mask.algorithm", [["brush", "画笔修补"], ["grabcut", "GrabCut 重算"]], { small: true, label: "蒙版算法" })}
            ${get(PS.state, "params.mask.algorithm") === "grabcut" ? U.range("params.mask.iterations", "迭代次数", 1, 10, 1) : ""}
            <span class="field__hint">只修改前景蒙版，不改变已有像素；提交后生成新的透明 PNG。</span>`
          )}
          ${isec(
            "画笔",
            `${U.seg("params.mask.brush", [["add", "补前景"], ["erase", "擦除"]], { small: true, label: "画笔模式" })}
            ${U.range("params.mask.radius", "笔刷大小", 4, 128, 1, " px")}
            <div class="brush-preview"><i data-brush-dot style="width:${get(PS.state, "params.mask.radius")}px;height:${get(PS.state, "params.mask.radius")}px"></i></div>`
          )}
          ${isec(
            "笔迹",
            `<ul class="layer-list">
              <li><span></span><span class="sw" style="background:var(--jade)"></span><span>补前景 · 下缘缠枝</span><small>46 px</small></li>
              <li><span></span><span class="sw" style="background:var(--error)"></span><span>擦除 · 左上杂点</span><small>34 px</small></li>
            </ul>
            <div class="row">
              <button class="btn btn--sm" data-act="mask-undo">${icon("undo", "ic--sm")}撤销</button>
              <button class="btn btn--sm" data-act="mask-redo">${icon("redo", "ic--sm")}重做</button>
              <button class="btn btn--sm btn--ghost" data-act="mask-clear" style="margin-left:auto">清空</button>
            </div>`,
            "2 笔"
          )}
          ${isec(
            "其它",
            `${U.seg("params.mask.denoise", [["0", "不去噪"], ["1", "轻度"], ["2", "较强"]], { small: true, label: "去噪" })}
            ${U.toggleRow("反相蒙版", "把前景与背景对调", "params.mask.invert")}
            ${U.toggleRow("显示原图底稿", "半透明叠在线稿下方", "params.mask.overlay")}
            ${U.range("params.mask.opacity", "底稿不透明度", 0, 100, 1, "%")}`
          )}`;
      case 7: {
        const sel = PS.svg.elements.find((e) => e.id === state.selectedElement);
        return `
          ${isec(
            "矢量参数",
            `${U.seg("params.vector.mode", [["monochrome", "单色"], ["color", "彩色"], ["contour", "轮廓"]], { small: true, label: "矢量化模式" })}
            ${get(PS.state, "params.vector.mode") !== "monochrome" ? U.seg("params.vector.colors", [["2", "2 色"], ["4", "4 色"], ["8", "8 色"], ["16", "16 色"]], { small: true, label: "颜色数" }) : ""}
            ${U.seg("params.vector.detail", [["low", "低"], ["medium", "中"], ["high", "高"]], { small: true, label: "细节" })}
            ${adv(
              "阈值",
              `${U.range("params.vector.length", "最短线段", 0.5, 10, 0.1, " px")}
              ${U.range("params.vector.corner", "拐角阈值", 0, 180, 1, "°")}
              ${U.range("params.vector.splice", "拼接阈值", 0, 180, 1, "°")}`,
              "vtracer"
            )}`
          )}
          ${isec(
            "颜色归并",
            `<div class="palette">${PS.svg.palette.map((c) => `<i style="background:${c}" title="${c}"></i>`).join("")}</div>
            <div class="swatch-row">${PS.svg.palette.map((c) => `<span class="mono muted">${c}</span>`).join("")}</div>
            <button class="btn btn--sm btn--block" data-act="svg-recolor">${icon("pen", "ic--sm")}整版换色</button>`,
            `${PS.svg.palette.length} 色`
          )}
          ${isec(
            "独立图形",
            `<div class="element-list">${PS.svg.elements
              .map(
                (el) => `<button class="element-row ${state.selectedElement === el.id ? "is-on" : ""}" data-act="svg-select" data-arg="${el.id}">
                  ${icon("eye", "ic--sm")}
                  <span class="sw" style="width:14px;height:14px;border-radius:3px;background:${el.color}"></span>
                  <span>${esc(el.label)}</span>
                  <small>${el.count}</small>
                </button>`
              )
              .join("")}</div>
            ${sel ? `<div class="nudge-grid">
              <button class="btn btn--sm" data-act="svg-nudge" data-arg="-10,0">← 10</button>
              <button class="btn btn--sm" data-act="svg-nudge" data-arg="0,-10">↑ 10</button>
              <button class="btn btn--sm" data-act="svg-nudge" data-arg="10,0">→ 10</button>
              <button class="btn btn--sm" data-act="svg-nudge" data-arg="0,10">↓ 10</button>
              <button class="btn btn--sm" data-act="svg-reset-el">归零</button>
              <button class="btn btn--sm btn--danger" data-act="svg-delete-el">删除</button>
            </div>
            <span class="field__hint">当前 ${esc(sel.label)} · 偏移 ${sel.dx}, ${sel.dy}${sel.deleted ? " · 已删除" : ""}</span>` : `<span class="field__hint">选择一个图形后可微调或删除。</span>`}
            <button class="btn btn--sm btn--block" data-act="svg-apply" ${sel ? "" : "disabled"}>${icon("pen", "ic--sm")}应用图形编辑</button>`,
            `${PS.svg.elements.reduce((n, e) => n + e.count, 0)} 个`
          )}
          ${isec(
            "SVG 摘要",
            kv([
              ["路径数", `<span class="num">${PS.svg.paths}</span>`],
              ["文件大小", `<span class="num">${U.bytes(PS.svg.bytes)}</span>`],
              ["source_sha256", `<span class="mono">${PS.svg.sourceSha.slice(0, 10)}…</span>`],
              ["版本", `<span class="mono">${PS.state.health.versions.vector}</span>`],
            ])
          )}`;
      }
      case 8:
        return `
          ${isec(
            "平铺规格",
            `${U.seg("tileN", [["2", "2 × 2"], ["3", "3 × 3"]], { small: true, label: "行列" })}
            ${U.toggleRow("标出接缝", "在单元边界画参考线", "seams")}
            <button class="btn btn--sm btn--block" data-act="tile-preview">${icon("tile", "ic--sm")}生成平铺预览</button>`
          )}
          ${isec(
            "接缝观察",
            `${U.seg("params.tile.obs", [["not_obvious", "未见接缝"], ["visible", "明显断线"], ["not_reviewed", "未复核"]], { small: true, label: "观察结论" })}
            <textarea class="textarea" data-bind="params.tile.note" placeholder="写下需要回头处理的位置…">${esc(get(PS.state, "params.tile.note"))}</textarea>
            <button class="btn btn--sm btn--block" data-act="seam-save">${icon("check", "ic--sm")}保存接缝观察</button>`,
            "revision 0"
          )}
          ${isec(
            "打包内容",
            `<ul class="layer-list">${["矢量 SVG", "透明 PNG", "平铺预览 PNG", "来源与参数 JSON"]
              .map((t) => `<li><span class="check is-checked">${icon("check")}</span><span></span><span>${t}</span><small></small></li>`)
              .join("")}</ul>
            <span class="field__hint">许可确认后导出；单次最多 500 个资产、128 MiB。</span>`
          )}
          ${isec(
            "导出摘要",
            kv([
              ["资产", `<span class="num">4 个</span>`],
              ["预计大小", `<span class="num">12.4 MB</span>`],
              ["布局", "按原图分目录"],
              ["许可", PS.patternById(PS.state.activePattern).license],
            ])
          )}`;
    }
    return "";
  }

  function inspectorFoot() {
    const state = PS.state;
    const s = state.stage;
    const p = PS.patternById(state.activePattern);
    const primaryMap = {
      1: ["下一步：裁切", "arrow"],
      2: ["应用裁切", "crop"],
      3: state.repairMode === "skip" ? ["跳过，进入候选", "arrow"] : state.repairMode === "local" ? ["本地修复", "wand"] : ["生成修复候选", "spark"],
      4: [`合成所选（${state.cands.size}）`, "layers"],
      5: state.procMode === "local" ? ["生成本地线稿", "spark"] : state.procMode === "cloud" ? ["云端生成线稿", "cloud"] : state.procMode === "opencv" ? ["提取轮廓线稿", "feather"] : ["提取前景", "layers"],
      6: ["提交蒙版", "check"],
      7: ["转为 SVG", "pen"],
      8: ["导出 ZIP", "download"],
    };
    const [label, ic] = primaryMap[s];
    const cloudNeeded = (s === 3 && state.repairMode === "cloud") || (s === 5 && state.procMode === "cloud");
    const localRepairBlocked = s === 3 && state.repairMode === "local" && !PS.state.health.capabilities.leftrefill_model.available;
    const disabled = !!state.running || (s === 4 && !state.cands.size) || (cloudNeeded && !consentsOk()) || localRepairBlocked;
    const action = s === 8 ? "export" : "run";
    const run = state.running
      ? `<div class="run-state">
          <div class="run-state__row"><span>${state.running.progress < 35 ? "准备输入" : state.running.progress < 80 ? "处理中 · " + esc(state.running.label) : "写入新版本"}</span><span class="num">${Math.round(state.running.progress)}%</span></div>
          <div class="progress progress--striped"><i style="width:${state.running.progress}%"></i></div>
        </div>`
      : "";
    let hint = "";
    if (cloudNeeded && cloudBlockers().length) hint = `<span class="field__hint">${icon("info", "ic--sm")} 云端未就绪：${cloudBlockers().map((b) => PS.blockerLabels[b]).join("、")}。</span>`;
    else if (cloudNeeded && !consentsOk()) hint = `<span class="field__hint">${icon("info", "ic--sm")} 勾选上传与付费两项同意后才能调用云端。</span>`;
    else if (localRepairBlocked) hint = `<span class="field__hint">${icon("alert", "ic--sm")} 本地 LeftRefill 不可用，请改用云端或跳过。</span>`;
    else if (s === 4 && !state.cands.size) hint = `<span class="field__hint">${icon("info", "ic--sm")} 至少勾选一层候选。</span>`;
    else if (s === 8) hint = `<span class="field__hint">${icon("shield", "ic--sm")} 导出前需要确认素材许可。</span>`;

    return `
      ${run}
      ${hint}
      <div class="inspector__foot-row">
        ${s >= 2 && s <= 7 ? `<button class="btn" data-act="preview" ${state.running ? "disabled" : ""}>${icon("eye", "ic--sm")}预览</button>` : ""}
        ${state.running ? `<button class="btn" data-act="cancel-run">取消</button>` : ""}
        <button class="btn btn--primary" data-act="${action}" ${disabled ? "disabled" : ""}>${icon(ic, "ic--sm")}${label}</button>
      </div>`;
  }

  /* ---------------------------------------------------------------- 工作台 */
  PS.views.workbench = function () {
    const state = PS.state;
    const p = PS.patternById(state.activePattern);
    const s = state.stage;
    const st = PS.stageOf(s);

    const steps = PS.STAGES.map((x) => {
      const done = state.done.has(x.n);
      const cls = x.n === s ? "is-current" : done ? "is-done" : x.optional ? "is-skip" : "";
      const hint = x.n === 3 ? "本机 / 云端" : x.n === 4 ? "必须云端" : x.n === 5 ? "本机 / 云端" : x.cloud ? "云端" : x.optional ? "可跳过" : "本机";
      return `<button class="step ${cls}" data-act="stage" data-arg="${x.n}" title="${esc(x.title)}（${x.n}）">
        <span class="step__dot">${done && x.n !== s ? icon("check") : x.n}</span>
        <span class="step__txt"><b>${x.name}</b><small>${hint}</small></span>
      </button>`;
    }).join("");

    const isCloudWork = (s === 3 && state.repairMode === "cloud") || s === 4 || (s === 5 && state.procMode === "cloud");
    const stageChip = isCloudWork
      ? `<span class="chip chip--ochre">${icon("cloud", "ic--sm")}云端工序</span>`
      : `<span class="chip chip--jade">${icon("cpu", "ic--sm")}${s === 3 && state.repairMode === "skip" ? "可跳过" : "本机完成"}</span>`;

    const canCompare = s > 1 && s !== 4 && s !== 8;
    const info = s === 8 ? `${state.tileN} × ${state.tileN} 平铺 · 单元 500 px` : s === 4 ? `${state.cands.size} 个已选候选层 · 640 × 640` : s === 7 ? `SVG · ${PS.svg.paths} 路径 · ${U.bytes(PS.svg.bytes)}` : "1000 × 1000 px · 300 dpi";
    const idx = Math.max(0, PS.workbenchItems.indexOf(p.id));
    const items = PS.workbenchItems.length || 1;

    return `
    <div class="bench">
      <header class="bench__head">
        <div class="bench__doc">
          ${plate(p.orig, "bench__doc-thumb")}
          <div><h1>${esc(p.name)}</h1><p>${esc(p.era)} · ${esc(p.kind)} · <span class="mono">${esc(p.code)}</span></p></div>
          ${stamp(p.grade, "width:22px;height:22px;font-size:12px")}
        </div>
        <div class="bench__head-sp"></div>
        <button class="icon-btn bench__assets-mobile" data-act="wb-mobile-assets" title="版本与纹样">${icon("folder")}</button>
        <div class="bench__pager">
          <button class="icon-btn" data-act="wb-prev" title="上一个纹样（[）">${icon("left")}</button>
          <span>${idx + 1} / ${items}</span>
          <button class="icon-btn" data-act="wb-next" title="下一个纹样（]）">${icon("right")}</button>
        </div>
        <button class="btn btn--sm" data-act="wb-meta">编辑资料</button>
        <button class="btn btn--sm" data-act="export">${icon("download", "ic--sm")}导出</button>
        <button class="icon-btn" data-act="wb-more" title="更多">${icon("more")}</button>
      </header>

      <nav class="stepper" aria-label="工序">${steps}</nav>

      <div class="bench__body">
        <aside class="versions" aria-label="版本与纹样">${versionsColumn()}</aside>

        <section class="canvas" aria-label="画布">
          <div class="canvas__tools">
            <button class="icon-btn" data-act="zoom" data-arg="-1" title="缩小">${icon("zoom-out")}</button>
            <span class="zoom-val">${Math.round(state.zoom * 100)}%</span>
            <button class="icon-btn" data-act="zoom" data-arg="1" title="放大">${icon("zoom-in")}</button>
            <button class="icon-btn" data-act="zoom" data-arg="0" title="适应">${icon("fit")}</button>
            <span class="sep"></span>
            <button class="icon-btn" data-act="wb-undo" title="撤销">${icon("undo")}</button>
            <button class="icon-btn" data-act="wb-redo" title="重做">${icon("redo")}</button>
            ${canCompare ? `<span class="sep"></span><button class="tool-label ${state.compare ? "is-on" : ""}" data-act="compare" title="对比原图（C）">${icon("compare", "ic--sm")}对比原图</button>` : ""}
          </div>
          ${canvasContent()}
          <div class="canvas__foot">
            <span class="pill">${icon(st.icon, "ic--sm")}<span class="num">0${s}</span> ${st.title} · ${info}</span>
            ${state.compare && canCompare ? `<span class="pill">左：原图　右：${st.name}结果</span>` : `<span class="pill">${icon("clock", "ic--sm")}最近保存 ${esc(p.updated)}</span>`}
          </div>
        </section>

        <aside class="inspector" aria-label="本工序参数">
          <div class="inspector__head">
            <div class="inspector__kicker">
              <span class="inspector__n">0${s}</span>
              ${stageChip}
            </div>
            <h2>${st.title}</h2>
            <p>${st.desc}</p>
          </div>
          <div class="inspector__body">${inspectorBody()}</div>
          <div class="inspector__foot">${inspectorFoot()}</div>
        </aside>
      </div>

      <footer class="bench__status">
        <span><span class="dot"></span>本机服务正常</span>
        <span>GPU · CUDA</span>
        <span>云端：${cloudBlockers().length ? "未就绪" : "已配置"}</span>
        <span>队列 ${PS.jobs.filter((j) => j.state === "running" || j.state === "queued").length} / 20</span>
        <span data-run-status>${state.running ? "运行中 " + Math.round(state.running.progress) + "%" : "空闲"}</span>
        <span class="sp"></span>
        <span><span class="kbd">1</span>–<span class="kbd">8</span> 切工序</span>
        <span><span class="kbd">[</span> <span class="kbd">]</span> 换纹样</span>
        <span><span class="kbd">C</span> 对比</span>
        <span><span class="kbd">Ctrl</span><span class="kbd">K</span> 命令</span>
      </footer>
    </div>`;
  };

  /** 只重绘参数栏底部，供模拟执行时更新进度，不打断滚动与画布。 */
  PS.paintWorkbenchFoot = function () {
    const foot = document.querySelector(".inspector__foot");
    if (foot) foot.innerHTML = inspectorFoot();
  };
})();

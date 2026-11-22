/* =============================================================================
   纹样工作台 · 全功能交互模板 —— 通用组件
   只做标记拼装与轻量 DOM，不持有业务状态。
   ============================================================================= */
(function () {
  "use strict";
  const PS = (window.PS = window.PS || {});
  const A = PS.ASSETS;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const esc = (value) =>
    String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const icon = (id, cls = "") => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const plate = (file, cls = "", extra = "") => `<div class="plate ${cls}">${extra}<img src="${A}${file}" alt="" loading="lazy" /></div>`;
  const compareBlock = (under, over, cls = "") => `
    <div class="compare ${cls}" data-compare>
      <div class="compare__layer"><img src="${A}${under}" alt="" /></div>
      <div class="compare__layer compare__top"><img src="${A}${over}" alt="" /></div>
      <div class="compare__bar"><span class="compare__knob">${icon("compare", "ic--sm")}</span></div>
    </div>`;

  const stamp = (grade, size = "") =>
    grade ? `<span class="stamp stamp--${esc(grade)}" ${size ? `style="${size}"` : ""} title="评级 ${esc(grade)}">${esc(grade)}</span>` : "";

  const money = (cents) => "¥" + ((Number(cents) || 0) / 100).toFixed(2);
  const bytes = (n) => {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
    if (v >= 1024) return Math.round(v / 1024) + " KB";
    return v + " B";
  };
  const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);

  const labels = {
    state: {
      succeeded: ["已完成", "chip--jade", "check"],
      running: ["进行中", "chip--primary", "play"],
      queued: ["排队中", "chip--outline", "clock"],
      waiting: ["待确认", "chip--ochre", "pause"],
      paused: ["已暂停", "chip--outline", "pause"],
      failed: ["失败", "chip--error", "alert"],
      cancelled: ["已取消", "chip--outline", "x"],
      outcome_unknown: ["结果未知", "chip--ochre", "shield"],
      decomposing: ["拆分中", "chip--primary", "cloud"],
      awaiting_selection: ["待选层", "chip--ochre", "layers"],
      needs_reconciliation: ["需核对", "chip--error", "shield"],
      rejected: ["已拒绝", "chip--outline", "x"],
      accepted: ["已接受", "chip--jade", "check"],
      not_reviewed: ["未复核", "chip--outline", "eye"],
      visible: ["明显断线", "chip--error", "alert"],
      not_obvious: ["未见接缝", "chip--jade", "check"],
    },
  };

  const stateChip = (state) => {
    const item = labels.state[state] || [state || "—", "chip--outline", "info"];
    return `<span class="chip ${item[1]}">${icon(item[2], "ic--sm")}${item[0]}</span>`;
  };

  const stageChip = (n) => `<span class="stage-pill"><span class="num">0${n}</span>${PS.stageOf(n).name}</span>`;

  const kindLabels = {
    original: "原图",
    normalized_input: "规范输入",
    cropped: "裁切",
    working_copy: "工作副本",
    prepared: "摆正",
    enhanced: "增强",
    foreground_mask: "前景蒙版",
    transparent_png: "透明 PNG",
    contour_line_art: "轮廓线稿",
    lineart: "线稿",
    svg: "矢量 SVG",
    tile_preview: "平铺预览",
    edge_candidate: "边缘候选",
    region_candidate: "区域候选",
    composed_candidate: "合成候选",
    generated_layer: "云端候选层",
    repair_composite: "修复候选",
    accepted_repair: "已接受修复",
    zip: "压缩包",
  };
  const kindLabel = (k) => kindLabels[k] || k;

  const get = (obj, path) => String(path).split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
  const set = (obj, path, value) => {
    const keys = String(path).split(".");
    const last = keys.pop();
    const target = keys.reduce((acc, key) => {
      if (acc[key] == null || typeof acc[key] !== "object") acc[key] = {};
      return acc[key];
    }, obj);
    target[last] = value;
  };

  const range = (path, label, min, max, step, unit = "", hint = "") => {
    const raw = get(PS.state, path);
    const val = raw == null ? min : Number(raw);
    const decimals = step < 1 ? String(step).split(".")[1].length : 0;
    const shown = decimals ? val.toFixed(decimals) : val;
    const p = ((val - min) / (max - min)) * 100;
    return `
      <div class="field">
        <div class="field__row">
          <span class="field__label">${esc(label)}</span>
          <span class="field__val" data-val="${esc(path)}">${shown}${esc(unit)}</span>
        </div>
        <input class="range" type="range" min="${min}" max="${max}" step="${step}" value="${val}"
          data-range="${esc(path)}" data-unit="${esc(unit)}" data-decimals="${decimals}" style="--p:${p}%" aria-label="${esc(label)}" />
        ${hint ? `<span class="field__hint">${hint}</span>` : ""}
      </div>`;
  };

  const toggleRow = (label, sub, path, opts = {}) => {
    const on = !!get(PS.state, path);
    return `
      <div class="toggle-row">
        <div><b>${esc(label)}</b>${sub ? `<small>${sub}</small>` : ""}</div>
        <label class="switch"><input type="checkbox" ${on ? "checked" : ""} ${opts.disabled ? "disabled" : ""} data-toggle="${esc(path)}" aria-label="${esc(label)}" /><span></span></label>
      </div>`;
  };

  const inputRow = (label, path, opts = {}) => {
    const value = get(PS.state, path);
    const attrs = [
      opts.type ? `type="${opts.type}"` : "",
      opts.min != null ? `min="${opts.min}"` : "",
      opts.max != null ? `max="${opts.max}"` : "",
      opts.step != null ? `step="${opts.step}"` : "",
      opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : "",
      opts.readonly ? "readonly" : "",
      opts.disabled ? "disabled" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `
      <label class="field">
        <span class="field__label">${esc(label)}</span>
        <input class="input ${opts.mono ? "mono" : ""}" value="${esc(value == null ? "" : value)}" data-bind="${esc(path)}" ${attrs} />
        ${opts.hint ? `<span class="field__hint">${opts.hint}</span>` : ""}
      </label>`;
  };

  const selectRow = (label, path, options, opts = {}) => {
    const value = String(get(PS.state, path));
    const items = options
      .map((o) => {
        const [v, text] = Array.isArray(o) ? o : [o, o];
        return `<option value="${esc(v)}" ${String(v) === value ? "selected" : ""}>${esc(text)}</option>`;
      })
      .join("");
    return `
      <label class="field">
        <span class="field__label">${esc(label)}</span>
        <select class="select" data-bind="${esc(path)}" ${opts.rerender ? 'data-rerender="1"' : ""}>${items}</select>
        ${opts.hint ? `<span class="field__hint">${opts.hint}</span>` : ""}
      </label>`;
  };

  const seg = (path, options, opts = {}) => {
    const value = String(get(PS.state, path));
    const items = options
      .map((o) => {
        const [v, text, ic] = Array.isArray(o) ? o : [o, o];
        return `<button type="button" data-seg="${esc(path)}" data-val="${esc(v)}" class="${String(v) === value ? "is-on" : ""}">${ic ? icon(ic, "ic--sm") : ""}${esc(text)}</button>`;
      })
      .join("");
    return `<div class="seg ${opts.block === false ? "" : "seg--block"} ${opts.small ? "seg--sm" : ""}" role="group" aria-label="${esc(opts.label || path)}">${items}</div>`;
  };

  const checkLine = (on, label, sub, attrs = "") => `
    <button type="button" class="check-line ${on ? "is-on" : ""}" ${attrs}>
      <span class="check ${on ? "is-checked" : ""}">${icon("check")}</span>
      <span><b>${esc(label)}</b>${sub ? `<small>${sub}</small>` : ""}</span>
    </button>`;

  const callout = (kind, text, iconId = "info") => `<div class="callout callout--${kind}">${icon(iconId)}<div>${text}</div></div>`;

  const empty = (text, sub = "", iconId = "folder") => `
    <div class="empty">${icon(iconId)}<b>${esc(text)}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;

  const stepLabel = (name) => PS.STEP_LABELS[name] || name;
  const jobStep = (step) => {
    const done = step.state === "succeeded" ? "is-done" : step.state === "running" ? "is-running" : step.state === "failed" ? "is-failed" : "";
    const stateText = (PS.STEP_STATE_LABELS || {})[step.state] || step.state;
    return `<div class="job-step ${done}"><span class="dot"></span><span>${esc(stepLabel(step.name))}</span><small>${esc(stateText)}</small></div>`;
  };

  const stars = (value, action = "feedback-rate") => `
    <div class="stars" role="group" aria-label="评分">
      ${[1, 2, 3, 4, 5]
        .map((n) => `<button type="button" class="${n <= value ? "is-on" : ""}" data-act="${action}" data-arg="${n}" aria-label="${n} 分">${icon("star")}</button>`)
        .join("")}
    </div>`;

  const toast = (message, kind = "ok") => {
    const host = $("#toasts");
    if (!host) return;
    const el = document.createElement("div");
    el.className = "toast" + (kind === "warn" ? " toast--warn" : kind === "error" ? " toast--error" : "");
    const ic = kind === "warn" ? "alert" : kind === "error" ? "alert" : "check";
    el.innerHTML = `${icon(ic)}<span>${esc(message)}</span>`;
    host.appendChild(el);
    setTimeout(() => el.classList.add("is-out"), 2800);
    setTimeout(() => el.remove(), 3200);
  };

  const openModal = (html, opts = {}) => {
    const el = $("#modal");
    el.className = "modal" + (opts.wide ? " modal--wide" : "") + (opts.tall ? " modal--tall" : "");
    el.innerHTML = html;
    el.dataset.modal = opts.kind || "";
    el.setAttribute("aria-hidden", "false");
    document.body.classList.add("is-modal");
    const focus = el.querySelector("[data-autofocus]") || el.querySelector("input:not([type=range]), textarea, select, button");
    if (focus) setTimeout(() => focus.focus(), 30);
  };
  const closeModal = () => {
    const el = $("#modal");
    if (!el) return;
    document.body.classList.remove("is-modal");
    el.setAttribute("aria-hidden", "true");
    el.dataset.modal = "";
    el.innerHTML = "";
  };

  const openDrawer = (html, opts = {}) => {
    const el = $("#drawer");
    el.className = "drawer" + (opts.wide ? " drawer--wide" : "");
    el.innerHTML = html;
    el.setAttribute("aria-hidden", "false");
    document.body.classList.add("is-drawer");
  };
  const closeDrawer = () => {
    document.body.classList.remove("is-drawer");
    const el = $("#drawer");
    if (el) el.setAttribute("aria-hidden", "true");
  };

  const openMenu = (html) => {
    const el = $("#menu");
    el.innerHTML = html;
    el.hidden = false;
  };
  const closeMenu = () => {
    const el = $("#menu");
    if (el) {
      el.hidden = true;
      el.innerHTML = "";
    }
  };

  const closeCommand = () => {
    const input = $("#cmd-input");
    if (input) input.blur();
    document.body.classList.remove("is-cmd");
    const el = $("#cmdk");
    if (el) el.setAttribute("aria-hidden", "true");
  };

  const download = (file, name) => {
    const a = document.createElement("a");
    a.href = A + file;
    a.download = name || file.split("/").pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const copyText = (text) => {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(() => {});
    return Promise.resolve();
  };

  const nowTime = () => {
    const d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  };

  PS.ui = {
    $,
    $$,
    esc,
    icon,
    plate,
    compareBlock,
    stamp,
    money,
    bytes,
    pct,
    stateChip,
    stageChip,
    kindLabel,
    get,
    set,
    range,
    toggleRow,
    inputRow,
    selectRow,
    seg,
    checkLine,
    callout,
    empty,
    stepLabel,
    jobStep,
    stars,
    toast,
    openModal,
    closeModal,
    openDrawer,
    closeDrawer,
    openMenu,
    closeMenu,
    closeCommand,
    download,
    copyText,
    nowTime,
  };
})();

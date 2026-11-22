/* =============================================================================
   纹样工作台 · 新版视觉原型（演示数据，不请求任何接口）
   直接用浏览器打开 index.html 即可；样例图引用 frontend/next-v2/assets/demo。
   ============================================================================= */
(function () {
  "use strict";

  const A = "../../frontend/next-v2/assets/demo/";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const icon = (id, cls = "") => `<svg class="ic ${cls}"><use href="#i-${id}"/></svg>`;

  /* ---------------------------------------------------------------- 演示数据 */
  const STAGES = [
    { n: 1, key: "source", name: "来源", title: "放入纹样", icon: "image", desc: "上传原图后另存一份规范输入，并记录评级与来源信息。", img: "lotus-original.svg" },
    { n: 2, key: "crop", name: "裁切", title: "框定纹样", icon: "crop", desc: "拖拽框选或填写像素坐标；超出像素上限时先创建工作副本。", img: "lotus-crop.svg" },
    { n: 3, key: "repair", name: "修复", title: "局部修复", icon: "wand", desc: "圈出残缺区域，确认后调用云端生成修复候选；纹样完整时可直接跳过。", img: "lotus-repair.svg", cloud: true, optional: true },
    { n: 4, key: "candidate", name: "候选", title: "选候选层", icon: "layers", desc: "云端按提示词拆分图层，勾选后合成一张候选；这一步不生成线稿。", img: "lotus-candidate-1.svg", cloud: true },
    { n: 5, key: "process", name: "处理", title: "生成线稿", icon: "feather", desc: "选择本地模型或云端模型生成线稿 PNG，也可改用 OpenCV 线稿或颜色提取。", img: "lotus-line.svg" },
    { n: 6, key: "mask", name: "蒙版", title: "修正前景", icon: "brush", desc: "画笔补前景、擦除杂点；提交后生成新的透明 PNG。", img: "lotus-mask.svg" },
    { n: 7, key: "vector", name: "矢量化", title: "转成矢量", icon: "pen", desc: "把线稿或透明 PNG 转成可编辑 SVG，颜色与细节参数在这一步调整。", img: "lotus-vector.svg" },
    { n: 8, key: "tile", name: "平铺", title: "检查接缝", icon: "tile", desc: "生成 2×2 / 3×3 平铺排列，记录接缝观察，成果打包成 ZIP。", img: "lotus-seamless.svg" },
  ];

  const PATTERNS = [
    { id: "lotus", name: "缠枝莲团花", era: "明 · 万历", kind: "团花", grade: "A", size: "2400 × 2400", code: "PS-2611-0412", stage: 5, orig: "lotus-original.svg", line: "lotus-line.svg", src: "馆藏青花瓷盘", updated: "14:38" },
    { id: "crane", name: "云鹤团花", era: "清 · 乾隆", kind: "团花", grade: "B", size: "800 × 800", code: "PS-2611-0397", stage: 8, orig: "crane-original.svg", line: "crane-line.svg", src: "缂丝补子", updated: "昨天" },
    { id: "meander", name: "回纹边饰", era: "商 · 晚期", kind: "边饰", grade: "A", size: "900 × 300", code: "PS-2611-0388", stage: 7, orig: "meander-original.svg", line: "meander-line.svg", src: "青铜簋口沿", updated: "昨天" },
    { id: "cloud", name: "如意云纹", era: "元", kind: "云纹", grade: "B", size: "800 × 500", code: "PS-2611-0381", stage: 6, orig: "cloud-original.svg", line: "cloud-line.svg", src: "织金锦残片", updated: "11-19" },
    { id: "sea", name: "海水江崖", era: "清 · 雍正", kind: "海水", grade: "A", size: "900 × 450", code: "PS-2611-0376", stage: 8, orig: "sea-original.svg", line: "sea-line.svg", src: "龙袍下摆", updated: "11-18" },
    { id: "baoxiang", name: "宝相花", era: "唐", kind: "团花", grade: "C", size: "600 × 600", code: "PS-2611-0362", stage: 3, orig: "baoxiang-original.svg", line: "baoxiang-line.svg", src: "敦煌藻井摹本", updated: "11-17" },
    { id: "seamless", name: "缠枝莲四方连续", era: "明 · 万历", kind: "边饰", grade: "A", size: "500 × 500", code: "PS-2611-0413", stage: 8, orig: "lotus-seamless.svg", line: "lotus-seamless.svg", src: "由 0412 派生", updated: "14:52" },
    { id: "sepcolor", name: "缠枝莲分色稿", era: "明 · 万历", kind: "团花", grade: "B", size: "640 × 640", code: "PS-2611-0414", stage: 4, orig: "lotus-candidate-3.svg", line: "lotus-candidate-2.svg", src: "由 0412 派生", updated: "14:20" },
  ];

  const TASKS = [
    { id: "job_8f21", name: "生成线稿 · 本地模型", pat: "lotus", stage: 5, status: "running", prog: 64, step: "推理 2 / 3", time: "刚刚" },
    { id: "job_8f1c", name: "候选层拆分 · 云端", pat: "lotus", stage: 4, status: "done", time: "14:32", dur: "38 秒", cost: "¥0.12" },
    { id: "job_8f02", name: "PNG → SVG 矢量化", pat: "crane", stage: 7, status: "done", time: "昨天 17:05", dur: "6 秒" },
    { id: "job_8ef7", name: "局部修复 · 云端", pat: "baoxiang", stage: 3, status: "failed", time: "昨天 16:41", err: "云端返回 429：请求过于频繁，请稍后重试" },
    { id: "job_8ee0", name: "平铺 3×3 · 打包 ZIP", pat: "sea", stage: 8, status: "done", time: "11-18 10:12", dur: "3 秒" },
    { id: "job_8ed4", name: "蒙版修正 · 提交笔迹", pat: "cloud", stage: 6, status: "done", time: "11-19 09:40", dur: "2 秒" },
    { id: "job_8ec1", name: "候选层拆分 · 云端", pat: "cloud", stage: 4, status: "cancelled", time: "11-19 09:31" },
  ];

  const state = {
    route: "home",
    theme: "paper",
    stage: 5,
    done: new Set([1, 2, 3, 4]),
    versions: {
      1: [{ label: "原图", file: "lotus-original.svg", size: "2400 × 2400", time: "14:02" }, { label: "规范输入", file: "lotus-original.svg", size: "1000 × 1000", time: "14:02" }],
      2: [{ label: "裁切", file: "lotus-crop.svg", size: "720 × 720", time: "14:06" }],
      3: [{ label: "修复候选", file: "lotus-repair.svg", size: "1000 × 1000", time: "14:15" }],
      4: [{ label: "候选合成", file: "lotus-candidate-1.svg", size: "640 × 640", time: "14:32" }],
      5: [{ label: "线稿 PNG", file: "lotus-line.svg", size: "1000 × 1000", time: "14:38" }],
    },
    compare: false,
    zoom: 1,
    tileN: 3,
    seams: false,
    cands: new Set([1]),
    procMode: "local",
    repairMode: "repair",
    brushMode: "add",
    running: false,
    progress: 0,
    libFilter: "全部",
    libQuery: "",
    taskTab: "all",
    priceOk: false,
  };

  const findPattern = (id) => PATTERNS.find((p) => p.id === id) || PATTERNS[0];
  const stageOf = (n) => STAGES[n - 1];

  /* ---------------------------------------------------------------- 小组件 */
  const plate = (file, cls = "", extra = "") =>
    `<div class="plate ${cls}">${extra}<img src="${A}${file}" alt="" loading="lazy" /></div>`;

  const compareBlock = (under, over, cls = "") => `
    <div class="compare ${cls}" data-compare>
      <div class="compare__layer"><img src="${A}${under}" alt="" /></div>
      <div class="compare__layer compare__top"><img src="${A}${over}" alt="" /></div>
      <div class="compare__bar"><span class="compare__knob">${icon("compare", "ic--sm")}</span></div>
    </div>`;

  const range = (key, label, min, max, step, val, unit = "", hint = "") => {
    const p = ((val - min) / (max - min)) * 100;
    return `
      <div class="field">
        <div class="field__row">
          <span class="field__label">${label}</span>
          <span class="field__val" data-val="${key}">${val}${unit}</span>
        </div>
        <input class="range" type="range" min="${min}" max="${max}" step="${step}" value="${val}"
          data-range="${key}" data-unit="${unit}" style="--p:${p}%" aria-label="${label}" />
        ${hint ? `<span class="field__hint">${hint}</span>` : ""}
      </div>`;
  };

  const toggle = (label, sub, on, key = "") => `
    <div class="toggle-row">
      <div><b>${label}</b>${sub ? `<small>${sub}</small>` : ""}</div>
      <label class="switch"><input type="checkbox" ${on ? "checked" : ""} data-toggle="${key}" aria-label="${label}" /><span></span></label>
    </div>`;

  const statusChip = (s) =>
    ({
      running: `<span class="chip chip--primary"><i></i>进行中</span>`,
      done: `<span class="chip chip--jade"><i></i>已完成</span>`,
      failed: `<span class="chip chip--error"><i></i>失败</span>`,
      cancelled: `<span class="chip chip--outline">已取消</span>`,
    })[s];

  /* =============================================================== 概览 */
  function viewHome() {
    const lotus = PATTERNS[0];
    const cur = state.stage;
    const flow = STAGES.map((s) => {
      const cls = state.done.has(s.n) ? "is-done" : s.n === cur ? "is-current" : "";
      const mark = state.done.has(s.n) ? icon("check", "ic--sm") : s.n === cur ? icon("play", "ic--sm") : "";
      return `
        <article class="flow-card ${cls}" data-go-stage="${s.n}">
          ${s.cloud ? `<span class="chip chip--ochre flow-card__cloud">${icon("cloud", "ic--sm")}云端</span>` : ""}
          ${plate(s.img, "flow-card__img")}
          <div class="flow-card__n"><span>0${s.n} · ${s.name}</span><span class="flow-card__state">${mark}</span></div>
          <h4>${s.title}</h4>
          <p>${s.desc}</p>
        </article>`;
    }).join("");

    const recent = PATTERNS.slice(1, 5)
      .map(
        (p) => `
        <a class="work" data-open-pattern="${p.id}">
          <div class="plate work__img">
            <img src="${A}${p.orig}" alt="" />
            <div class="hover-line"><img src="${A}${p.line}" alt="" /></div>
            <span class="stamp stamp--${p.grade}">${p.grade}</span>
          </div>
          <div class="work__meta"><h4>${p.name}</h4><small>${p.era}</small></div>
          <small>${p.kind} · ${p.size} px</small>
        </a>`
      )
      .join("");

    return `
    <div class="page">
      <section class="hero">
        <div>
          <span class="eyebrow">文物纹样提取与线稿数字化</span>
          <h1 class="hero__title">从一件旧纹样，<br />到一份<em>可编辑</em>的矢量。</h1>
          <p class="hero__lead">裁切、修复、拆层、提线稿、修蒙版、转 SVG、查接缝——八道工序走完，原图、每一版结果与来源记录都留在纹样库里，随时回到任一步重做。</p>
          <div class="hero__cta">
            <button class="btn btn--primary btn--lg" data-action="upload">${icon("upload")}上传纹样</button>
            <a class="btn btn--lg" href="#/workbench">继续「${lotus.name}」${icon("arrow", "ic--sm")}</a>
          </div>
          <div class="hero__stats">
            <div><b class="num">128</b><span>纹样组</span></div>
            <div><b class="num">74</b><span>A 级成果</span></div>
            <div><b class="num">412</b><span>可回溯版本</span></div>
            <div><b class="num">¥3.86</b><span>本月云端花费</span></div>
          </div>
        </div>
        <figure class="specimen" style="margin:0">
          <span class="specimen__tag specimen__tag--l">原图</span>
          <span class="specimen__tag specimen__tag--r">线稿</span>
          <div class="plate specimen__img">${compareBlock(lotus.orig, lotus.line, "specimen__img")}</div>
          <figcaption class="specimen__cap">
            <div><h3>${lotus.name}</h3><p>${lotus.era} · ${lotus.src} · <span class="mono">${lotus.code}</span></p></div>
            <span class="stamp stamp--A">A</span>
          </figcaption>
        </figure>
      </section>

      <section class="card resume">
        ${plate(lotus.orig, "resume__thumb")}
        <div>
          <h3>接着上次 · ${lotus.name}</h3>
          <p>停在「0${cur} ${stageOf(cur).title}」，当前版本：线稿 PNG · 1000 × 1000 · 14:38</p>
          <div class="steps-mini">${STAGES.map((s) => `<span class="${state.done.has(s.n) ? "is-done" : s.n === cur ? "is-current" : ""}">${s.name}</span>`).join("")}</div>
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
            <ul class="feed">
              ${TASKS.slice(0, 4)
                .map(
                  (t) => `<li>
                    <span class="feed__ic">${icon(stageOf(t.stage).icon, "ic--sm")}</span>
                    <div><b>${t.name}</b><small>${findPattern(t.pat).name} · ${t.time}</small></div>
                    ${statusChip(t.status)}
                  </li>`
                )
                .join("")}
            </ul>
          </div>
          <div class="card panel panel--ink">
            <div class="panel__head"><h3>云端按次确认</h3>${icon("cloud")}</div>
            <div class="meter">
              <div class="meter__big"><b class="num">¥3.86</b><span>本月 · 31 次调用</span></div>
              <p style="margin:0;font-size:13px;line-height:1.7">只有「03 修复」「04 候选」和「05 处理」选用云端模型时会调用云端，每次调用前显示价格并等你确认；其余在本机完成。</p>
              <a class="btn btn--sm" href="#/settings" style="justify-self:start">云端设置</a>
            </div>
          </div>
        </div>
      </section>
    </div>`;
  }

  /* =============================================================== 工作台 */
  function canvasContent() {
    const s = state.stage;
    const st = stageOf(s);
    const z = `style="transform:scale(${state.zoom})"`;

    if (s === 4) {
      const names = [
        ["单线加粗", "主体 · 外圈莲瓣"],
        ["双钩细线", "主体 · 缠枝"],
        ["分色填涂", "底纹 · 4 色"],
      ];
      return `<div class="cand-grid">${[1, 2, 3]
        .map(
          (i) => `
          <div class="cand ${state.cands.has(i) ? "is-checked" : ""}" data-cand="${i}">
            <span class="check">${icon("check")}</span>
            ${plate(`lotus-candidate-${i}.svg`, "cand__img")}
            <div class="cand__meta"><div><b>候选层 ${i} · ${names[i - 1][0]}</b><small>${names[i - 1][1]}</small></div><span class="mono muted">640²</span></div>
          </div>`
        )
        .join("")}</div>`;
    }

    if (s === 8) {
      return `<div class="tile-view"><div class="tile-sheet ${state.seams ? "show-seams" : ""}" style="--n:${state.tileN};transform:scale(${state.zoom})"></div></div>`;
    }

    let inner;
    if (state.compare && s > 1) {
      inner = `<div class="plate" style="width:100%;height:100%">${compareBlock("lotus-original.svg", st.img)}</div>`;
    } else {
      let overlay = "";
      let file = st.img;
      if (s === 2) {
        file = "lotus-original.svg";
        overlay = `<div class="crop-box"><i></i><i></i><i></i><i></i><span>720 × 720</span></div>`;
      }
      if (s === 3) {
        file = "lotus-original.svg";
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
      inner = `<div class="plate" style="width:100%;height:100%">${overlay}<img src="${A}${file}" alt="" /></div>`;
    }
    return `<div class="canvas__stage"><div class="canvas__plate" ${z}>${inner}</div></div>`;
  }

  function costCard(price, label) {
    return `
      <div class="cost">
        <div class="cost__row"><span>${label}</span><b>${price}</b></div>
        <label class="${state.priceOk ? "is-checked" : ""}" data-price-ok><span class="check">${icon("check")}</span>已确认价格，按次调用云端</label>
      </div>`;
  }

  function inspectorBody() {
    const s = state.stage;
    switch (s) {
      case 1:
        return `
          <div class="isec">
            <div style="display:grid;place-items:center;gap:8px;padding:26px 12px;border:1.5px dashed var(--line-3);border-radius:var(--r);text-align:center;background:var(--sunken)">
              ${icon("upload", "ic--lg")}
              <b style="font-size:14px">拖入图片，或点击选择</b>
              <span class="field__hint">PNG / JPG / TIFF · 单张最大 40 MB</span>
            </div>
          </div>
          <div class="isec">
            <div class="isec__title">来源信息</div>
            <div class="field"><span class="field__label">名称</span><input class="input" value="缠枝莲团花" /></div>
            <div class="coord-grid">
              <div class="field"><span class="field__label">年代</span><input class="input" value="明 · 万历" /></div>
              <div class="field"><span class="field__label">评级</span><select class="select"><option>A · 自动评定</option><option>B</option><option>C</option></select></div>
            </div>
            <div class="field"><span class="field__label">来源</span><select class="select"><option>馆藏实物拍摄</option><option>出版物扫描</option><option>网络图片</option></select></div>
          </div>
          <div class="isec">
            <div class="isec__title">原图</div>
            <dl class="kv"><dt>尺寸</dt><dd class="num">2400 × 2400 px</dd><dt>规范输入</dt><dd class="num">1000 × 1000 px</dd><dt>格式</dt><dd>PNG · sRGB</dd><dt>近似版本</dt><dd>未发现</dd></dl>
          </div>`;
      case 2:
        return `
          <div class="isec">
            <div class="isec__title">比例</div>
            <div class="seg seg--block" data-seg="ratio"><button>自由</button><button class="is-on">1 : 1</button><button>4 : 3</button><button>原图</button></div>
          </div>
          <div class="isec">
            <div class="isec__title">坐标 <span class="mono">真实像素</span></div>
            <div class="coord-grid">
              <label class="coord"><span>X</span><input class="input" value="336" /></label>
              <label class="coord"><span>Y</span><input class="input" value="336" /></label>
              <label class="coord"><span>W</span><input class="input" value="1728" /></label>
              <label class="coord"><span>H</span><input class="input" value="1728" /></label>
            </div>
            <span class="field__hint">在画布上拖动四角调整，或直接填写数值。</span>
          </div>
          <div class="isec">
            ${toggle("超出上限时创建工作副本", "长边缩到 2048 px 再处理", true)}
          </div>`;
      case 3:
        return `
          <div class="isec">
            <div class="isec__title">处理方式</div>
            <div class="mode-cards">
              <button class="mode-card ${state.repairMode === "skip" ? "is-on" : ""}" data-repair-mode="skip">${icon("arrow")}<b>跳过修复</b><small>纹样完整，直接进入候选</small></button>
              <button class="mode-card ${state.repairMode === "repair" ? "is-on" : ""}" data-repair-mode="repair">${icon("wand")}<b>局部修复</b><small>圈出残缺区域，云端生成</small></button>
            </div>
          </div>
          ${
            state.repairMode === "repair"
              ? `<div class="isec">
            <div class="isec__title">修复区域 <span class="mono">2 处</span></div>
            ${range("radius", "圈选笔刷", 8, 120, 1, 48, " px")}
            <div class="field"><span class="field__label">修复提示</span><textarea class="textarea">补全外圈缺失的莲瓣，保持青花线条粗细一致。</textarea></div>
          </div>
          <div class="isec">${costCard("¥0.18", "预计 1 次调用 · 2 张候选")}</div>`
              : ""
          }`;
      case 4:
        return `
          <div class="isec">
            <div class="isec__title">拆分提示词</div>
            <textarea class="textarea">缠枝莲主体；外圈莲瓣；底纹与留白。</textarea>
            <div class="field"><span class="field__label">拆分层数</span><div class="seg seg--block" data-seg="layers"><button class="is-on">3</button><button>4</button><button>5</button></div></div>
          </div>
          <div class="isec">
            <div class="isec__title">已选 <span class="mono">${state.cands.size} / 3</span></div>
            <ul class="layer-list">
              ${[1, 2, 3]
                .map(
                  (i) => `<li data-cand="${i}" style="cursor:pointer"><span class="check ${state.cands.has(i) ? "is-checked" : ""}" style="width:18px;height:18px">${icon("check")}</span>
                  <span class="sw" style="background:${["#23355e", "#3b5a8f", "#b9c7df"][i - 1]}"></span><span>候选层 ${i}</span><small>v1</small></li>`
                )
                .join("")}
            </ul>
          </div>
          <div class="isec">${costCard("¥0.12", "重新拆分 · 1 次调用")}</div>`;
      case 5:
        return `
          <div class="isec">
            <div class="isec__title">提取方式</div>
            <div class="mode-cards">
              ${[
                ["local", "cpu", "本地模型", "线稿 v0.2 · GPU"],
                ["cloud", "cloud", "云端模型", "按次确认"],
                ["opencv", "feather", "OpenCV 线稿", "无模型，最快"],
                ["color", "layers", "颜色提取", "保留色块"],
              ]
                .map(
                  ([k, ic, t, d]) =>
                    `<button class="mode-card ${state.procMode === k ? "is-on" : ""}" data-proc-mode="${k}">${icon(ic)}<b>${t}</b><small>${d}</small></button>`
                )
                .join("")}
            </div>
          </div>
          <div class="isec">
            <div class="isec__title">线稿参数 <span class="mono">local-lineart-v0.2</span></div>
            ${range("threshold", "阈值", 0, 1, 0.01, 0.62)}
            ${range("blur", "模糊半径", 0, 8, 1, 2, " px")}
            ${range("minArea", "最小面积", 0, 200, 1, 24, " px²", "小于该面积的孤立笔画会被清除。")}
          </div>
          <div class="isec">
            ${toggle("透明背景", "输出 RGBA PNG，供蒙版与矢量化使用", true)}
          </div>
          ${state.procMode === "cloud" ? `<div class="isec">${costCard("¥0.09", "预计 1 次调用")}</div>` : ""}`;
      case 6:
        return `
          <div class="isec">
            <div class="isec__title">画笔</div>
            <div class="seg seg--block" data-seg="brush">
              <button class="${state.brushMode === "add" ? "is-on" : ""}" data-brush="add">${icon("brush", "ic--sm")} 补前景</button>
              <button class="${state.brushMode === "erase" ? "is-on" : ""}" data-brush="erase">${icon("eraser", "ic--sm")} 擦除</button>
            </div>
            ${range("brush", "笔刷大小", 4, 96, 1, 32, " px")}
            <div class="brush-preview"><i data-brush-dot style="width:32px;height:32px"></i></div>
          </div>
          <div class="isec">
            ${toggle("显示原图底稿", "半透明叠在线稿下方", true)}
            ${range("overlay", "底稿不透明度", 0, 100, 1, 35, "%")}
          </div>
          <div class="isec">
            <div class="isec__title">笔迹 <span class="mono">2 笔</span></div>
            <ul class="layer-list">
              <li><span></span><span class="sw" style="background:var(--jade)"></span><span>补前景 · 下缘缠枝</span><small>46 px</small></li>
              <li><span></span><span class="sw" style="background:var(--error)"></span><span>擦除 · 左上杂点</span><small>34 px</small></li>
            </ul>
            <div style="display:flex;gap:8px"><button class="btn btn--sm">${icon("undo", "ic--sm")}撤销</button><button class="btn btn--sm">${icon("redo", "ic--sm")}重做</button><button class="btn btn--sm btn--ghost" style="margin-left:auto">清空</button></div>
          </div>`;
      case 7:
        return `
          <div class="isec">
            <div class="isec__title">矢量参数 <span class="mono">PNG → SVG</span></div>
            ${range("colors", "颜色数", 1, 12, 1, 4, " 色")}
            ${range("detail", "细节", 0, 1, 0.05, 0.7)}
            ${range("smooth", "曲线平滑", 0, 1, 0.05, 0.45)}
            ${range("minPart", "最少构件面积", 0, 100, 1, 12, " px²")}
          </div>
          <div class="isec">
            <div class="isec__title">颜色归并</div>
            <div class="palette"><i style="background:#1b2b54"></i><i style="background:#3a5285"></i><i style="background:#9fb1d1"></i><i style="background:#f3ecdc"></i></div>
          </div>
          <div class="isec">
            <div class="isec__title">独立图形 <span class="mono">186 个</span></div>
            <ul class="layer-list">
              <li>${icon("eye", "ic--sm")}<span class="sw" style="background:#1b2b54"></span><span>主轮廓</span><small>92</small></li>
              <li>${icon("eye", "ic--sm")}<span class="sw" style="background:#3a5285"></span><span>缠枝细线</span><small>61</small></li>
              <li>${icon("eye", "ic--sm")}<span class="sw" style="background:#9fb1d1"></span><span>花心填色</span><small>27</small></li>
              <li>${icon("eye", "ic--sm")}<span class="sw" style="background:#f3ecdc"></span><span>留白</span><small>6</small></li>
            </ul>
          </div>`;
      case 8:
        return `
          <div class="isec">
            <div class="isec__title">平铺规格</div>
            <div class="seg seg--block"><button class="${state.tileN === 2 ? "is-on" : ""}" data-tile="2">2 × 2</button><button class="${state.tileN === 3 ? "is-on" : ""}" data-tile="3">3 × 3</button><button class="${state.tileN === 4 ? "is-on" : ""}" data-tile="4">4 × 4</button></div>
            ${toggle("标出接缝", "在单元边界画参考线", state.seams, "seams")}
          </div>
          <div class="isec">
            <div class="isec__title">接缝观察</div>
            <div class="seg seg--block"><button class="is-on">无缝</button><button>轻微错位</button><button>明显断线</button></div>
            <textarea class="textarea" placeholder="写下需要回头处理的位置…">右下角缠枝衔接自然，无需返工。</textarea>
          </div>
          <div class="isec">
            <div class="isec__title">打包内容</div>
            <ul class="layer-list">
              ${["矢量 SVG", "透明 PNG", "平铺预览 PNG", "来源与参数 JSON"]
                .map((t) => `<li><span class="check is-checked" style="width:18px;height:18px">${icon("check")}</span><span></span><span>${t}</span><small></small></li>`)
                .join("")}
            </ul>
          </div>`;
    }
    return "";
  }

  const PRIMARY = {
    1: ["下一步：裁切", "arrow"],
    2: ["应用裁切", "crop"],
    3: ["生成修复候选", "spark"],
    4: ["合成所选", "layers"],
    5: ["生成线稿", "spark"],
    6: ["提交修正", "check"],
    7: ["转为 SVG", "pen"],
    8: ["打包 ZIP", "download"],
  };

  function inspectorFoot() {
    const s = state.stage;
    let [label, ic] = PRIMARY[s];
    if (s === 3 && state.repairMode === "skip") [label, ic] = ["跳过，进入候选", "arrow"];
    if (s === 4) label += `（${state.cands.size}）`;
    const needsPrice = (s === 3 && state.repairMode === "repair") || (s === 5 && state.procMode === "cloud");
    const disabled = state.running || (needsPrice && !state.priceOk) || (s === 4 && !state.cands.size);
    const run = state.running
      ? `<div class="run-state">
          <div class="run-state__row"><span>${state.progress < 40 ? "准备输入" : state.progress < 85 ? "处理中" : "写入新版本"}</span><span class="num">${Math.round(state.progress)}%</span></div>
          <div class="progress progress--striped"><i style="width:${state.progress}%"></i></div>
        </div>`
      : needsPrice && !state.priceOk
        ? `<span class="field__hint">${icon("info", "ic--sm")} 勾选价格确认后才能调用云端。</span>`
        : "";
    return `
      ${run}
      <div class="inspector__foot-row">
        ${s > 1 && s < 8 ? `<button class="btn" data-action="preview" ${state.running ? "disabled" : ""}>${icon("eye", "ic--sm")}预览</button>` : ""}
        ${state.running ? `<button class="btn" data-action="cancel">取消</button>` : ""}
        <button class="btn btn--primary" data-action="run" ${disabled ? "disabled" : ""}>${icon(ic, "ic--sm")}${label}</button>
      </div>`;
  }

  function viewWorkbench() {
    const p = PATTERNS[0];
    const s = state.stage;
    const st = stageOf(s);

    const steps = STAGES.map((x) => {
      const done = state.done.has(x.n);
      const cls = x.n === s ? "is-current" : done ? "is-done" : x.optional ? "is-skip" : "";
      return `<button class="step ${cls}" data-stage="${x.n}" title="${x.title}（${x.n}）">
        <span class="step__dot">${done && x.n !== s ? icon("check") : x.n}</span>
        <span class="step__txt"><b>${x.name}</b><small>${x.cloud ? "云端" : x.optional ? "可跳过" : "本机"}</small></span>
      </button>`;
    }).join("");

    let vCount = 0;
    const groups = Object.keys(state.versions)
      .map(Number)
      .sort((a, b) => b - a)
      .map((n) => {
        const list = state.versions[n];
        vCount += list.length;
        return `<div class="vgroup">
          <div class="vgroup__label"><span><span class="num">0${n}</span>${stageOf(n).name}</span><span class="num">${list.length}</span></div>
          ${list
            .slice()
            .reverse()
            .map(
              (v, i) => `<button class="vitem ${n === s && i === 0 ? "is-current" : ""}" data-stage="${n}">
                ${plate(v.file, "vitem__img")}
                <span><b>${v.label}</b><small>${v.size} · ${v.time}</small></span>
                <span class="vitem__v">v${list.length - i}</span>
              </button>`
            )
            .join("")}
        </div>`;
      })
      .join("");

    const canCompare = s > 1 && s !== 4 && s !== 8;
    const info = s === 8 ? `${state.tileN} × ${state.tileN} 平铺 · 单元 500 px` : s === 4 ? "3 个候选层 · 640 × 640" : "1000 × 1000 px · 300 dpi";

    return `
    <div class="bench">
      <header class="bench__head">
        <div class="bench__doc">
          ${plate(p.orig, "bench__doc-thumb")}
          <div><h1>${p.name}</h1><p>${p.era} · ${p.kind} · <span class="mono">${p.code}</span></p></div>
          <span class="stamp stamp--A" title="评级 A">A</span>
        </div>
        <div class="bench__head-sp"></div>
        <div class="bench__pager">
          <button class="icon-btn" data-action="prev" title="上一个纹样（[）">${icon("left")}</button>
          <span>1 / 6</span>
          <button class="icon-btn" data-action="next" title="下一个纹样（]）">${icon("right")}</button>
        </div>
        <button class="btn btn--sm" data-action="meta">编辑资料</button>
        <button class="btn btn--sm">${icon("download", "ic--sm")}导出</button>
        <button class="icon-btn" title="更多">${icon("more")}</button>
      </header>

      <nav class="stepper" aria-label="工序">${steps}</nav>

      <div class="bench__body">
        <aside class="versions" aria-label="版本">
          <div class="versions__head"><h3>版本</h3><span class="chip">${vCount}</span></div>
          <div class="versions__list">${groups}</div>
          <div class="versions__foot">
            <button class="btn btn--sm btn--block" data-action="pick">${icon("plus", "ic--sm")}添加纹样</button>
          </div>
        </aside>

        <section class="canvas" aria-label="画布">
          <div class="canvas__tools">
            <button class="icon-btn" data-zoom="-1" title="缩小">${icon("zoom-out")}</button>
            <span class="zoom-val">${Math.round(state.zoom * 100)}%</span>
            <button class="icon-btn" data-zoom="1" title="放大">${icon("zoom-in")}</button>
            <button class="icon-btn" data-zoom="0" title="适应">${icon("fit")}</button>
            <span class="sep"></span>
            <button class="icon-btn" title="撤销">${icon("undo")}</button>
            <button class="icon-btn" title="重做">${icon("redo")}</button>
            ${canCompare ? `<span class="sep"></span><button class="tool-label ${state.compare ? "is-on" : ""}" data-action="compare" title="对比原图（C）">${icon("compare", "ic--sm")}对比原图</button>` : ""}
          </div>
          ${canvasContent()}
          <div class="canvas__foot">
            <span class="pill">${icon(st.icon, "ic--sm")}<span class="num">0${s}</span> ${st.title} · ${info}</span>
            ${state.compare && canCompare ? `<span class="pill">左：原图　右：${st.name}结果</span>` : `<span class="pill">${icon("clock", "ic--sm")}最近保存 14:38</span>`}
          </div>
        </section>

        <aside class="inspector" aria-label="本工序参数">
          <div class="inspector__head">
            <div class="inspector__kicker">
              <span class="inspector__n">0${s}</span>
              ${st.cloud ? `<span class="chip chip--ochre">${icon("cloud", "ic--sm")}云端工序</span>` : `<span class="chip chip--jade">${icon("cpu", "ic--sm")}本机完成</span>`}
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
        <span>云端：已配置</span>
        <span class="sp"></span>
        <span><span class="kbd">1</span>–<span class="kbd">8</span> 切工序</span>
        <span><span class="kbd">[</span> <span class="kbd">]</span> 换纹样</span>
        <span><span class="kbd">C</span> 对比</span>
      </footer>
    </div>`;
  }

  /* =============================================================== 纹样库 */
  function viewLibrary() {
    const kinds = ["全部", "团花", "边饰", "云纹", "海水"];
    const list = PATTERNS.filter(
      (p) => (state.libFilter === "全部" || p.kind === state.libFilter) && (!state.libQuery || (p.name + p.era + p.code).includes(state.libQuery))
    );
    const cards = list
      .map(
        (p) => `
        <a class="work lib-card" data-open-pattern="${p.id}">
          <div class="plate work__img">
            <img src="${A}${p.orig}" alt="" />
            <div class="hover-line"><img src="${A}${p.line}" alt="" /></div>
            <span class="stamp stamp--${p.grade}">${p.grade}</span>
          </div>
          <div class="work__meta"><h4>${p.name}</h4><small class="mono">${p.code.slice(-4)}</small></div>
          <small>${p.era} · ${p.kind} · ${p.size} px</small>
          <div class="lib-card__bar" title="已完成 ${p.stage} / 8 道工序">${STAGES.map((s) => `<i class="${s.n <= p.stage ? "on" : ""}"></i>`).join("")}</div>
        </a>`
      )
      .join("");
    return `
    <div class="page">
      <div class="page-head">
        <div><span class="eyebrow">纹样库</span><h1>每一版结果都在这里</h1><p>按原图分组；打开档案可下载任一版本，或回到工作台继续。</p></div>
        <button class="btn btn--primary" data-action="upload">${icon("upload")}上传纹样</button>
      </div>
      <div class="card stat-strip">
        <div><b class="num">128</b><span>原图组</span></div>
        <div><b class="num">412</b><span>版本</span></div>
        <div><b class="num">74</b><span>A 级</span></div>
        <div><b class="num">39</b><span>已出 SVG</span></div>
        <div><b class="num">5</b><span>待补来源</span></div>
      </div>
      <div class="toolbar">
        <label class="search">${icon("search", "ic--sm")}<input class="input" placeholder="搜索名称、年代或编号" value="${state.libQuery}" data-lib-search /></label>
        <div class="filter-chips">${kinds.map((k) => `<button class="fchip ${state.libFilter === k ? "is-on" : ""}" data-lib-filter="${k}">${k}</button>`).join("")}</div>
        <span class="sp"></span>
        <div class="seg"><button class="is-on">全部评级</button><button>A</button><button>B</button><button>C</button></div>
        <div class="seg"><button class="is-on" title="网格">${icon("library", "ic--sm")}</button><button title="列表">${icon("grid-list", "ic--sm")}</button></div>
      </div>
      <div class="lib-grid">${cards || `<p class="muted">没有匹配的纹样。</p>`}</div>
    </div>`;
  }

  function openPatternDrawer(id) {
    const p = findPattern(id);
    const drawer = $("#drawer");
    const vers = [
      [p.orig, "原图"],
      [p.orig, "规范输入"],
      [p.line, "线稿"],
      [p.id === "lotus" ? "lotus-vector.svg" : p.line, "SVG"],
    ];
    drawer.innerHTML = `
      <div class="drawer__head">
        <div><span class="eyebrow">${p.kind} · ${p.era}</span><h2>${p.name}</h2><p class="mono">${p.code} · ${p.size} px</p></div>
        <button class="icon-btn" data-action="close-drawer" aria-label="关闭">${icon("x")}</button>
      </div>
      <div class="drawer__body">
        <div class="plate drawer__plate">${compareBlock(p.orig, p.line, "drawer__plate")}</div>
        <div>
          <div class="isec__title" style="margin-bottom:10px">版本 <span class="mono">${vers.length}</span></div>
          <div class="drawer__versions">${vers.map(([f, l]) => `<div>${plate(f)}<small>${l}</small></div>`).join("")}</div>
        </div>
        <div>
          <div class="isec__title" style="margin-bottom:10px">资料</div>
          <dl class="kv">
            <dt>评级</dt><dd><span class="stamp stamp--${p.grade}" style="width:22px;height:22px;font-size:12px">${p.grade}</span></dd>
            <dt>来源</dt><dd>${p.src}</dd>
            <dt>工序进度</dt><dd>${p.stage} / 8 · ${stageOf(p.stage).name}</dd>
            <dt>最近更新</dt><dd>${p.updated}</dd>
          </dl>
        </div>
      </div>
      <div class="drawer__foot">
        <button class="btn">${icon("download", "ic--sm")}下载</button>
        <a class="btn btn--primary" href="#/workbench" data-action="close-drawer">在工作台打开 ${icon("arrow", "ic--sm")}</a>
      </div>`;
    document.body.classList.add("is-drawer");
    drawer.setAttribute("aria-hidden", "false");
  }
  function closeDrawer() {
    document.body.classList.remove("is-drawer");
    $("#drawer").setAttribute("aria-hidden", "true");
  }

  /* =============================================================== 任务 */
  function viewTasks() {
    const tabs = [
      ["all", "全部"],
      ["running", "进行中"],
      ["failed", "失败"],
      ["done", "已完成"],
    ];
    const count = (k) => (k === "all" ? TASKS.length : TASKS.filter((t) => t.status === k).length);
    const list = TASKS.filter((t) => state.taskTab === "all" || t.status === state.taskTab);
    return `
    <div class="page">
      <div class="page-head">
        <div><span class="eyebrow">任务</span><h1>本机与云端任务</h1><p>失败任务保留错误信息，可重试；运行中的任务可以取消。</p></div>
        <button class="btn">${icon("refresh", "ic--sm")}刷新</button>
      </div>
      <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${state.taskTab === k ? "is-on" : ""}" data-task-tab="${k}">${l}<span class="num">${count(k)}</span></button>`).join("")}</div>
      <div class="task-list">
        ${list
          .map((t) => {
            const p = findPattern(t.pat);
            const right =
              t.status === "running"
                ? `<div class="task__prog"><span>${t.step} · ${t.prog}%</span><div class="progress progress--striped"><i style="width:${t.prog}%"></i></div></div>`
                : `<div class="task__prog"><span>${t.dur ? "耗时 " + t.dur : "—"}</span>${t.cost ? `<span>云端 ${t.cost}</span>` : ""}</div>`;
            const act =
              t.status === "failed"
                ? `<button class="icon-btn" title="重试">${icon("refresh")}</button>`
                : t.status === "running"
                  ? `<button class="icon-btn" title="取消">${icon("x")}</button>`
                  : `<a class="icon-btn" href="#/workbench" title="在工作台打开">${icon("arrow")}</a>`;
            return `<div class="task">
              ${plate(p.orig, "task__img")}
              <div><h4>${t.name}</h4><small>${p.name} · 0${t.stage} ${stageOf(t.stage).name} · <span class="mono">${t.id}</span></small>${t.err ? `<div class="task__err">${icon("alert", "ic--sm")} ${t.err}</div>` : ""}</div>
              ${right}
              <div>${statusChip(t.status)}</div>
              <small>${t.time}</small>
              ${act}
            </div>`;
          })
          .join("")}
      </div>
    </div>`;
  }

  /* =============================================================== 设置 */
  function viewSettings() {
    const themeOpt = (k, name, sub, sw) => `
      <button class="theme-opt ${state.theme === k ? "is-on" : ""}" data-theme-pick="${k}">
        <span class="theme-opt__sw">${sw.map((c) => `<i style="background:${c}"></i>`).join("")}</span>
        <b>${name}</b><small>${sub}</small>
      </button>`;
    return `
    <div class="page">
      <div class="page-head"><div><span class="eyebrow">设置</span><h1>云端、本机与外观</h1></div></div>
      <div class="settings">
        <nav class="settings__nav">
          <a href="#/settings" data-scroll="set-cloud" class="is-on">云端服务</a><a href="#/settings" data-scroll="set-billing">云端调用</a><a href="#/settings" data-scroll="set-local">本机处理</a><a href="#/settings" data-scroll="set-look">外观</a>
        </nav>
        <div>
          <section class="card set-card" id="set-cloud">
            <div class="set-card__head"><div><h2>云端服务</h2><p>用于「03 修复」「04 候选」与「05 处理 · 云端模型」。</p></div><span class="chip chip--jade"><i></i>已连接</span></div>
            <div class="set-row"><div class="set-row__label"><b>模型</b><small>候选层拆分与修复</small></div><select class="select"><option>doubao-seedream-5-0-pro-260628</option><option>doubao-seedream-5-5-261028</option></select></div>
            <div class="set-row"><div class="set-row__label"><b>接口地址</b></div><input class="input mono" value="https://ark.cn-beijing.volces.com/api/v3" /></div>
            <div class="set-row"><div class="set-row__label"><b>API Key</b><small>保存后不回显</small></div>
              <div class="key-field"><input class="input" value="••••••••••••••••••3fQa" readonly /><button class="btn">${icon("key", "ic--sm")}更换</button><button class="btn btn--ghost">清除</button></div></div>
          </section>
          <section class="card set-card" id="set-billing">
            <div class="set-card__head"><div><h2>云端调用</h2><p>每次调用前显示价格，确认后才发出请求。</p></div></div>
            <div class="set-row"><div class="set-row__label"><b>允许付费调用</b><small>关闭后云端工序只显示原因</small></div><div>${toggle("已开启", "", true)}</div></div>
            <div class="set-row"><div class="set-row__label"><b>本月用量</b></div>
              <div style="display:grid;gap:8px"><div class="run-state__row"><span class="num" style="font-size:20px">¥3.86</span><span class="muted">31 次</span></div><div class="progress"><i style="width:38%"></i></div></div></div>
          </section>
          <section class="card set-card" id="set-local">
            <div class="set-card__head"><div><h2>本机处理</h2><p>数据保存在 <span class="mono">storage/api</span>。</p></div><span class="chip chip--jade"><i></i>就绪</span></div>
            <div class="worker-grid">
              <div class="worker">${icon("cpu")}<b>线稿模型</b><small>local-lineart v0.2 · CUDA</small></div>
              <div class="worker">${icon("wand")}<b>本地修复</b><small>LeftRefill · 可用</small></div>
              <div class="worker">${icon("pen")}<b>矢量化</b><small>vtracer · 内存上限 2 GB</small></div>
            </div>
          </section>
          <section class="card set-card" id="set-look">
            <div class="set-card__head"><div><h2>外观</h2><p>两套配色共用同一套版式。</p></div></div>
            <div style="padding:18px 24px 22px" class="theme-pick">
              ${themeOpt("paper", "宣纸", "浅色 · 黛青与朱砂", ["#f3eee4", "#23355e", "#b23f2a"])}
              ${themeOpt("ink", "夜墨", "深色 · 长时间修图", ["#12151c", "#e9e1cd", "#c24f37"])}
            </div>
          </section>
        </div>
      </div>
    </div>`;
  }

  /* =============================================================== 渲染 */
  const VIEWS = { home: viewHome, workbench: viewWorkbench, library: viewLibrary, tasks: viewTasks, settings: viewSettings };
  let painted = "";

  function render() {
    const view = $("#view");
    const route = state.route;
    const fresh = painted !== route;
    painted = route;
    const scroll = view.scrollTop;
    view.classList.toggle("is-flush", route === "workbench");
    document.body.classList.toggle("is-bench", route === "workbench");
    view.innerHTML = VIEWS[route]();
    const page = $(".page", view);
    if (page && !fresh) page.style.animation = "none";
    if (!fresh) view.scrollTop = scroll;
    $$(".rail__link").forEach((a) => a.classList.toggle("is-active", a.dataset.nav === route));
    if (fresh) view.scrollTop = 0;
  }

  function paintInspectorFoot() {
    const foot = $(".inspector__foot");
    if (foot) foot.innerHTML = inspectorFoot();
  }

  function toast(msg) {
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `${icon("check")}<span>${msg}</span>`;
    $("#toasts").appendChild(el);
    setTimeout(() => el.classList.add("is-out"), 2600);
    setTimeout(() => el.remove(), 3000);
  }

  function parseRoute() {
    const r = (location.hash.replace(/^#\/?/, "").split("?")[0] || "home").trim();
    state.route = VIEWS[r] ? r : "home";
    closeDrawer();
    render();
  }

  /* ---------------------------------------------------------------- 模拟执行 */
  let timer = null;
  function runStage() {
    const s = state.stage;
    if (s === 1) return goStage(2);
    if (s === 3 && state.repairMode === "skip") {
      state.done.add(3);
      toast("已跳过局部修复，不产生云端调用");
      return goStage(4);
    }
    state.running = true;
    state.progress = 0;
    paintInspectorFoot();
    timer = setInterval(() => {
      state.progress = Math.min(100, state.progress + 4 + Math.random() * 7);
      paintInspectorFoot();
      if (state.progress >= 100) {
        clearInterval(timer);
        state.running = false;
        state.priceOk = false;
        state.done.add(s);
        const st = stageOf(s);
        const list = (state.versions[s] = state.versions[s] || []);
        if (s !== 8) {
          const label = { 2: "裁切", 3: "修复候选", 4: "候选合成", 5: "线稿 PNG", 6: "蒙版修正", 7: "矢量 SVG" }[s];
          list.push({ label, file: st.img, size: s === 2 ? "720 × 720" : "1000 × 1000", time: "刚刚" });
          toast(`已生成「${label}」v${list.length}`);
          goStage(s + 1);
        } else {
          toast("已打包 ZIP · 4 个文件");
          render();
        }
      }
    }, 110);
  }

  function goStage(n) {
    if (n < 1 || n > 8) return;
    state.stage = n;
    state.compare = false;
    state.zoom = 1;
    state.priceOk = false;
    if (state.route !== "workbench") location.hash = "#/workbench";
    else render();
  }

  /* ---------------------------------------------------------------- 事件 */
  document.addEventListener("click", (e) => {
    const sc = e.target.closest("[data-scroll]");
    if (sc) {
      e.preventDefault();
      $$("[data-scroll]").forEach((a) => a.classList.toggle("is-on", a === sc));
      const target = document.getElementById(sc.dataset.scroll);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const t = e.target.closest(
      "[data-action],[data-stage],[data-go-stage],[data-zoom],[data-cand],[data-proc-mode],[data-repair-mode],[data-brush],[data-tile],[data-price-ok],[data-open-pattern],[data-lib-filter],[data-task-tab],[data-theme-pick],.seg button"
    );
    if (!t) return;
    const d = t.dataset;

    if (d.action) {
      switch (d.action) {
        case "theme":
          return setTheme(state.theme === "paper" ? "ink" : "paper");
        case "upload":
          return toast("原型：这里会打开文件选择");
        case "pick":
          return toast("原型：这里会打开「添加纹样」浮窗");
        case "meta":
          return openPatternDrawer("lotus");
        case "prev":
        case "next":
          return toast("原型：切换到工作台里的上一个 / 下一个纹样");
        case "compare":
          state.compare = !state.compare;
          return render();
        case "run":
          return runStage();
        case "cancel":
          clearInterval(timer);
          state.running = false;
          paintInspectorFoot();
          return toast("已取消，本次没有写入新版本");
        case "preview":
          return toast("原型：生成低分辨率预览，不写入版本");
        case "close-drawer":
          return closeDrawer();
      }
    }
    if (d.goStage) return goStage(+d.goStage);
    if (d.stage && !state.running) return goStage(+d.stage);
    if (d.zoom !== undefined) {
      const steps = [0.5, 0.75, 1, 1.25, 1.5, 2];
      const i = steps.indexOf(state.zoom);
      state.zoom = +d.zoom === 0 ? 1 : steps[Math.max(0, Math.min(steps.length - 1, i + +d.zoom))];
      const plateEl = $(".canvas__plate") || $(".tile-sheet");
      if (plateEl) plateEl.style.transform = `scale(${state.zoom})`;
      const zv = $(".zoom-val");
      if (zv) zv.textContent = Math.round(state.zoom * 100) + "%";
      return;
    }
    if (d.cand) {
      const n = +d.cand;
      state.cands.has(n) ? state.cands.delete(n) : state.cands.add(n);
      return render();
    }
    if (d.procMode) {
      state.procMode = d.procMode;
      state.priceOk = false;
      return render();
    }
    if (d.repairMode) {
      state.repairMode = d.repairMode;
      return render();
    }
    if (d.brush) {
      state.brushMode = d.brush;
      return render();
    }
    if (d.tile) {
      state.tileN = +d.tile;
      return render();
    }
    if (d.priceOk !== undefined) {
      state.priceOk = !state.priceOk;
      t.classList.toggle("is-checked", state.priceOk);
      return paintInspectorFoot();
    }
    if (d.openPattern) return openPatternDrawer(d.openPattern);
    if (d.libFilter) {
      state.libFilter = d.libFilter;
      return render();
    }
    if (d.taskTab) {
      state.taskTab = d.taskTab;
      return render();
    }
    if (d.themePick) return setTheme(d.themePick);
    // 纯展示用的分段按钮
    if (t.matches(".seg button")) {
      $$("button", t.parentElement).forEach((b) => b.classList.toggle("is-on", b === t));
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.dataset.toggle === "seams") {
      state.seams = e.target.checked;
      const sheet = $(".tile-sheet");
      if (sheet) sheet.classList.toggle("show-seams", state.seams);
    }
  });

  document.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.range) {
      const min = +el.min,
        max = +el.max,
        v = +el.value;
      el.style.setProperty("--p", ((v - min) / (max - min)) * 100 + "%");
      const out = $(`[data-val="${el.dataset.range}"]`);
      if (out) out.textContent = v + (el.dataset.unit || "");
      if (el.dataset.range === "brush") {
        const dot = $("[data-brush-dot]");
        if (dot) dot.style.width = dot.style.height = Math.min(56, v) + "px";
      }
    }
    if (el.dataset.libSearch !== undefined) {
      state.libQuery = el.value.trim();
      const grid = $(".lib-grid");
      const tmp = document.createElement("div");
      tmp.innerHTML = viewLibrary();
      grid.innerHTML = $(".lib-grid", tmp).innerHTML;
    }
  });

  // 对比滑杆拖动
  document.addEventListener("pointerdown", (e) => {
    const cmp = e.target.closest("[data-compare]");
    if (!cmp) return;
    e.preventDefault();
    const move = (ev) => {
      const r = cmp.getBoundingClientRect();
      const pos = Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100));
      cmp.style.setProperty("--pos", pos + "%");
    };
    move(e);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === "Escape") return closeDrawer();
    if (state.route !== "workbench" || state.running) return;
    if (/^[1-8]$/.test(e.key)) goStage(+e.key);
    if (e.key.toLowerCase() === "c" && state.stage > 1 && state.stage !== 4 && state.stage !== 8) {
      state.compare = !state.compare;
      render();
    }
    if (e.key === "[" || e.key === "]") toast("原型：切换到上一个 / 下一个纹样");
  });

  $("#scrim").addEventListener("click", closeDrawer);

  function setTheme(k) {
    state.theme = k;
    document.documentElement.dataset.theme = k;
    if (state.route === "settings") render();
  }

  // 初始主题可用 ?theme=ink 指定，便于截图对照
  const params = new URLSearchParams(location.search);
  const qTheme = params.get("theme");
  if (qTheme === "ink" || qTheme === "paper") setTheme(qTheme);
  const qStage = +params.get("stage");
  if (qStage >= 1 && qStage <= 8) state.stage = qStage;
  if (params.get("compare") === "1") state.compare = true;

  window.addEventListener("hashchange", parseRoute);
  parseRoute();
})();

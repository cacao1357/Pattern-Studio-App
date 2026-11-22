/* =============================================================================
   纹样工作台 · 全功能交互模板 —— 演示数据
   全部数据写死在本文件里，不请求 /api/v1，也不写入浏览器存储。
   ============================================================================= */
(function () {
  "use strict";
  const PS = (window.PS = window.PS || {});

  PS.ASSETS = "../../frontend/next-v2/assets/demo/";

  /* ------------------------------------------------------------ 八道工序 */
  PS.STAGES = [
    { n: 1, key: "source", name: "来源", title: "放入纹样", icon: "image", desc: "上传原图后另存一份规范输入，并记录评级、许可与来源信息。", img: "lotus-original.svg" },
    { n: 2, key: "crop", name: "裁切", title: "框定纹样", icon: "crop", desc: "拖拽框选或填写像素坐标；可先摆正，超出像素上限时创建工作副本。", img: "lotus-crop.svg" },
    { n: 3, key: "repair", name: "修复", title: "局部修复", icon: "wand", desc: "圈出残缺区域，可选本地 LeftRefill 或云端生成修复候选；纹样完整时直接跳过。", img: "lotus-repair.svg", cloud: true, optional: true },
    { n: 4, key: "candidate", name: "候选", title: "选候选层", icon: "layers", desc: "云端按提示词拆分图层，勾选后合成一张候选；这一步不生成线稿。", img: "lotus-candidate-1.svg", cloud: true },
    { n: 5, key: "process", name: "处理", title: "生成线稿", icon: "feather", desc: "本地模型、云端模型、OpenCV 或颜色提取四条路线，产出线稿或透明 PNG。", img: "lotus-line.svg" },
    { n: 6, key: "mask", name: "蒙版", title: "修正前景", icon: "brush", desc: "画笔补前景、擦除杂点，或用 GrabCut 重算；提交后生成新的透明 PNG。", img: "lotus-mask.svg" },
    { n: 7, key: "vector", name: "矢量化", title: "转成矢量", icon: "pen", desc: "把线稿或透明 PNG 转成可编辑 SVG；可继续挪动或删除单个图形、整版换色。", img: "lotus-vector.svg" },
    { n: 8, key: "tile", name: "平铺", title: "检查接缝", icon: "tile", desc: "生成 2×2 / 3×3 平铺预览，记录接缝观察，成果打包成 ZIP。", img: "lotus-seamless.svg" },
  ];

  PS.jobKinds = {
    crop: { label: "裁切", stage: 2, icon: "crop", cloud: false },
    prepare: { label: "摆正", stage: 2, icon: "refresh", cloud: false },
    "working-copy": { label: "创建工作副本", stage: 2, icon: "image", cloud: false },
    enhance: { label: "图像增强", stage: 2, icon: "wand", cloud: false },
    repair: { label: "局部修复", stage: 3, icon: "wand", cloud: true },
    "ai-pipeline": { label: "云端拆分流程", stage: 4, icon: "cloud", cloud: true },
    "compose-layers": { label: "合成候选层", stage: 4, icon: "layers", cloud: false },
    lineart: { label: "生成线稿", stage: 5, icon: "feather", cloud: false },
    "cloud-lineart": { label: "云端线稿", stage: 5, icon: "cloud", cloud: true },
    extract: { label: "提取前景", stage: 5, icon: "layers", cloud: false },
    pipeline: { label: "颜色提取流水线", stage: 5, icon: "layers", cloud: false },
    "refine-mask": { label: "蒙版修正", stage: 6, icon: "brush", cloud: false },
    vectorize: { label: "PNG → SVG", stage: 7, icon: "pen", cloud: false },
    "edit-svg": { label: "SVG 图形编辑", stage: 7, icon: "pen", cloud: false },
    "recolor-svg": { label: "SVG 换色", stage: 7, icon: "pen", cloud: false },
    "tile-preview": { label: "平铺预览", stage: 8, icon: "tile", cloud: false },
    export: { label: "打包导出", stage: 8, icon: "download", cloud: false },
  };

  PS.STEP_LABELS = {
    load: "读取输入",
    validate: "校验参数",
    call: "云端调用",
    download: "下载结果",
    infer: "推理",
    postprocess: "后处理",
    composite: "合成选区",
    compose: "合成图层",
    publish: "写入版本",
    save: "保存",
    export: "打包",
    cleanup: "清理临时文件",
    queue: "排队",
    crop: "裁切",
    prepare: "摆正",
    repair: "局部修复",
    mask: "蒙版衔接",
    extract: "前景提取",
    vectorize: "矢量化",
    tile: "平铺预览",
    "decompose-layers": "云端拆分图层",
    select_layers: "选择候选层",
    "compose-layers": "合成候选层",
    "cloud-lineart": "云端线稿",
    "refine-mask": "蒙版修正",
    "edit-svg": "SVG 图形编辑",
    "recolor-svg": "SVG 换色",
    "tile-preview": "平铺预览",
    "ai-pipeline": "云端候选流程",
  };

  PS.STEP_STATE_LABELS = {
    succeeded: "完成",
    running: "进行中",
    queued: "等待",
    failed: "失败",
    cancelled: "已取消",
    skipped: "已跳过",
    outcome_unknown: "未知",
    waiting: "等待",
  };

  /* ------------------------------------------------------------ 分类 */
  PS.categories = [
    { id: "cat-qinghua", name: "青花", revision: 3 },
    { id: "cat-tuanhua", name: "团花", revision: 2 },
    { id: "cat-bianshi", name: "边饰", revision: 1 },
    { id: "cat-yunwen", name: "云纹", revision: 1 },
    { id: "cat-haishui", name: "海水", revision: 1 },
    { id: "cat-kesi", name: "缂丝", revision: 1 },
    { id: "cat-dunhuang", name: "敦煌", revision: 4 },
    { id: "cat-todo", name: "待整理", revision: 1 },
  ];

  /* ------------------------------------------------------------ 纹样组 */
  PS.patterns = [
    {
      id: "lotus", name: "缠枝莲团花", era: "明 · 万历", kind: "团花", grade: "A", size: "2400 × 2400",
      code: "PS-2611-0412", stage: 5, orig: "lotus-original.svg", line: "lotus-line.svg",
      src: "馆藏青花瓷盘", updated: "14:38", createdAt: "2026-11-19 09:12",
      categoryIds: ["cat-qinghua", "cat-tuanhua"], license: "已确认（馆藏授权）",
      sourceType: "馆藏实物拍摄", sourceName: "中国丝绸博物馆 · 瓷器库", sourceUrl: "https://example.org/collection/ps-0412",
      sourceNote: "青花缠枝莲纹盘，口径 28 cm；盘心完整，外圈一处剥釉。", collectedAt: "2026-11-19",
      hasSvg: true, assetCount: 9,
    },
    {
      id: "crane", name: "云鹤团花", era: "清 · 乾隆", kind: "团花", grade: "B", size: "800 × 800",
      code: "PS-2611-0397", stage: 8, orig: "crane-original.svg", line: "crane-line.svg",
      src: "缂丝补子", updated: "昨天", createdAt: "2026-11-17 15:40",
      categoryIds: ["cat-kesi", "cat-tuanhua"], license: "已确认（私人藏品授权）",
      sourceType: "馆藏实物拍摄", sourceName: "私人藏家提供", sourceUrl: "",
      sourceNote: "缂丝云鹤补子，蓝色地，鹤身金线可见。", collectedAt: "2026-11-17",
      hasSvg: true, assetCount: 8,
    },
    {
      id: "meander", name: "回纹边饰", era: "商 · 晚期", kind: "边饰", grade: "A", size: "900 × 300",
      code: "PS-2611-0388", stage: 7, orig: "meander-original.svg", line: "meander-line.svg",
      src: "青铜簋口沿", updated: "昨天", createdAt: "2026-11-16 10:05",
      categoryIds: ["cat-bianshi"], license: "已确认（馆藏授权）",
      sourceType: "馆藏实物拍摄", sourceName: "青铜器拓片库", sourceUrl: "https://example.org/collection/ps-0388",
      sourceNote: "拓片扫描，边缘有折痕。", collectedAt: "2026-11-16",
      hasSvg: true, assetCount: 7,
    },
    {
      id: "cloud", name: "如意云纹", era: "元", kind: "云纹", grade: "B", size: "800 × 500",
      code: "PS-2611-0381", stage: 6, orig: "cloud-original.svg", line: "cloud-line.svg",
      src: "织金锦残片", updated: "11-19", createdAt: "2026-11-15 16:22",
      categoryIds: ["cat-yunwen", "cat-todo"], license: "未确认",
      sourceType: "出版物扫描", sourceName: "《元代织金锦研究》图版 42", sourceUrl: "",
      sourceNote: "需补授权信息；书页有网纹。", collectedAt: "2026-11-15",
      hasSvg: false, assetCount: 6,
    },
    {
      id: "sea", name: "海水江崖", era: "清 · 雍正", kind: "海水", grade: "A", size: "900 × 450",
      code: "PS-2611-0376", stage: 8, orig: "sea-original.svg", line: "sea-line.svg",
      src: "龙袍下摆", updated: "11-18", createdAt: "2026-11-14 09:30",
      categoryIds: ["cat-haishui", "cat-kesi"], license: "已确认（馆藏授权）",
      sourceType: "馆藏实物拍摄", sourceName: "故宫博物院 · 织绣库", sourceUrl: "https://example.org/collection/ps-0376",
      sourceNote: "龙袍下摆局部，金线反光明显。", collectedAt: "2026-11-14",
      hasSvg: true, assetCount: 10,
    },
    {
      id: "baoxiang", name: "宝相花", era: "唐", kind: "团花", grade: "C", size: "600 × 600",
      code: "PS-2611-0362", stage: 3, orig: "baoxiang-original.svg", line: "baoxiang-line.svg",
      src: "敦煌藻井摹本", updated: "11-17", createdAt: "2026-11-13 11:18",
      categoryIds: ["cat-dunhuang", "cat-tuanhua"], license: "未确认",
      sourceType: "网络图片", sourceName: "敦煌图案公开课资料", sourceUrl: "https://example.org/dunhuang/baoxiang",
      sourceNote: "摹本分辨率偏低，仅作练习。", collectedAt: "2026-11-13",
      hasSvg: false, assetCount: 3,
    },
    {
      id: "seamless", name: "缠枝莲四方连续", era: "明 · 万历", kind: "边饰", grade: "A", size: "500 × 500",
      code: "PS-2611-0413", stage: 8, orig: "lotus-seamless.svg", line: "lotus-seamless.svg",
      src: "由 0412 派生", updated: "14:52", createdAt: "2026-11-19 14:52",
      categoryIds: ["cat-qinghua", "cat-bianshi"], license: "已确认（馆藏授权）",
      sourceType: "派生资产", sourceName: "PS-2611-0412", sourceUrl: "",
      sourceNote: "由缠枝莲团花调整接缝后平铺。", collectedAt: "2026-11-19",
      hasSvg: true, assetCount: 8,
    },
    {
      id: "sepcolor", name: "缠枝莲分色稿", era: "明 · 万历", kind: "团花", grade: "B", size: "640 × 640",
      code: "PS-2611-0414", stage: 4, orig: "lotus-candidate-3.svg", line: "lotus-candidate-2.svg",
      src: "由 0412 派生", updated: "14:20", createdAt: "2026-11-19 14:20",
      categoryIds: ["cat-qinghua", "cat-tuanhua"], license: "已确认（馆藏授权）",
      sourceType: "派生资产", sourceName: "PS-2611-0412", sourceUrl: "",
      sourceNote: "云端拆分后的分色候选，尚未选层。", collectedAt: "2026-11-19",
      hasSvg: false, assetCount: 4,
    },
    {
      id: "peony", name: "折枝牡丹", era: "宋", kind: "团花", grade: "B", size: "1200 × 900",
      code: "PS-2611-0354", stage: 2, orig: "baoxiang-original.svg", line: "baoxiang-line.svg",
      src: "织物残片", updated: "11-16", createdAt: "2026-11-12 14:08",
      categoryIds: ["cat-tuanhua", "cat-todo"], license: "未确认",
      sourceType: "出版物扫描", sourceName: "《宋代织物纹样》图 17", sourceUrl: "",
      sourceNote: "已裁切，待补来源。", collectedAt: "2026-11-12",
      hasSvg: false, assetCount: 2,
    },
    {
      id: "lotusbird", name: "莲池水禽", era: "明 · 嘉靖", kind: "团花", grade: "B", size: "1500 × 1500",
      code: "PS-2611-0341", stage: 6, orig: "sea-original.svg", line: "sea-line.svg",
      src: "青花碗心", updated: "11-15", createdAt: "2026-11-10 10:42",
      categoryIds: ["cat-qinghua", "cat-tuanhua"], license: "已确认（馆藏授权）",
      sourceType: "馆藏实物拍摄", sourceName: "景德镇陶瓷馆", sourceUrl: "https://example.org/collection/ps-0341",
      sourceNote: "碗心局部，水波纹与外圈莲瓣衔接。", collectedAt: "2026-11-10",
      hasSvg: false, assetCount: 5,
    },
    {
      id: "geo", name: "几何回纹", era: "战国", kind: "边饰", grade: "B", size: "640 × 640",
      code: "PS-2611-0330", stage: 5, orig: "meander-original.svg", line: "meander-line.svg",
      src: "漆器口沿", updated: "11-14", createdAt: "2026-11-09 16:20",
      categoryIds: ["cat-bianshi"], license: "已确认（馆藏授权）",
      sourceType: "馆藏实物拍摄", sourceName: "楚墓漆器整理组", sourceUrl: "",
      sourceNote: "红黑漆层剥落，线稿提取中。", collectedAt: "2026-11-09",
      hasSvg: false, assetCount: 4,
    },
    {
      id: "bird", name: "花鸟补子", era: "清 · 康熙", kind: "团花", grade: "A", size: "720 × 720",
      code: "PS-2611-0318", stage: 7, orig: "cloud-original.svg", line: "cloud-line.svg",
      src: "刺绣补子", updated: "11-13", createdAt: "2026-11-08 09:55",
      categoryIds: ["cat-kesi", "cat-tuanhua"], license: "已确认（私人藏品授权）",
      sourceType: "馆藏实物拍摄", sourceName: "私人藏家提供", sourceUrl: "",
      sourceNote: "刺绣补子，已出 SVG，待接缝检查。", collectedAt: "2026-11-08",
      hasSvg: true, assetCount: 7,
    },
  ];

  /* ------------------------------------------------------------ 分类与计分辅助 */
  PS.patternById = (id) => PS.patterns.find((p) => p.id === id) || PS.patterns[0];
  PS.categoryById = (id) => PS.categories.find((c) => c.id === id);
  PS.categoryNames = (p) => (p.categoryIds || []).map((id) => (PS.categoryById(id) || {}).name).filter(Boolean);
  PS.patternLabel = (id) => (PS.patternById(id) || {}).name || "未命名";
  PS.stageOf = (n) => PS.STAGES[n - 1] || PS.STAGES[0];

  PS.counts = function () {
    const totalVersions = PS.patterns.reduce((sum, p) => sum + (p.assetCount || 0), 0);
    const gradeA = PS.patterns.filter((p) => p.grade === "A").length;
    const svg = PS.patterns.filter((p) => p.hasSvg).length;
    const pending = PS.patterns.filter((p) => p.license === "未确认").length;
    return { patterns: PS.patterns.length, versions: totalVersions, gradeA, svg, pending };
  };

  PS.callTotal = () => PS.calls.reduce((sum, c) => sum + (c.costCents || 0), 0);

  /* ------------------------------------------------------------ 初始版本 */
  function fileFor(p, kind) {
    const map = {
      crop: p.orig,
      prepare: p.orig,
      working_copy: p.orig,
      enhanced: p.orig,
      repair_composite: p.id === "lotus" ? "lotus-repair.svg" : p.orig,
      composed_candidate: p.id === "lotus" ? "lotus-candidate-1.svg" : p.orig,
      lineart: p.line,
      transparent_png: p.id === "lotus" ? "lotus-mask.svg" : p.line,
      svg: p.id === "lotus" ? "lotus-vector.svg" : p.line,
      tile_preview: p.id === "lotus" || p.id === "seamless" ? "lotus-seamless.svg" : p.orig,
    };
    return map[kind] || p.orig;
  }
  PS.fileFor = fileFor;

  PS.baseVersions = function (p) {
    const groups = {
      1: [
        { label: "原图", kind: "original", file: p.orig, size: p.size, time: "09:12", revision: 1 },
        { label: "规范输入", kind: "normalized_input", file: p.orig, size: "1000 × 1000", time: "09:12", revision: 2 },
      ],
    };
    const stageLabels = {
      2: ["裁切", "cropped", p.stage === 2 ? "720 × 720" : p.stage >= 2 ? "1000 × 1000" : ""],
      3: ["修复候选", "repair_composite", "1000 × 1000"],
      4: ["候选合成", "composed_candidate", "640 × 640"],
      5: ["线稿 PNG", "lineart", "1000 × 1000"],
      6: ["蒙版修正", "transparent_png", "1000 × 1000"],
      7: ["矢量 SVG", "svg", "1000 × 1000"],
      8: ["平铺预览", "tile_preview", "3 × 3 · 500 px"],
    };
    const stageTimes = { 2: "14:06", 3: "14:15", 4: "14:32", 5: "14:38", 6: "14:44", 7: "14:50", 8: "14:55" };
    for (let n = 2; n <= p.stage; n += 1) {
      const [label, kind, size] = stageLabels[n];
      groups[n] = [{ label, kind, file: fileFor(p, kind), size, time: stageTimes[n] || "14:00", revision: 1 }];
    }
    return groups;
  };

  PS.patternAssets = function (p) {
    const groups = PS.baseVersions(p);
    const list = [];
    Object.keys(groups)
      .map(Number)
      .sort((a, b) => a - b)
      .forEach((stage) => {
        groups[stage].forEach((v, i) => {
          list.push({
            asset_id: "asset-" + p.id + "-" + stage + "-" + (i + 1),
            image_id: p.id,
            stage,
            label: v.label,
            kind: v.kind,
            file: v.file,
            size: v.size,
            time: v.time,
            revision: v.revision || 1,
            seam: stage === 8 ? "not_obvious" : null,
          });
        });
      });
    return list;
  };

  /* ------------------------------------------------------------ 工作台纹样列 */
  PS.workbenchItems = ["lotus", "crane", "cloud", "meander", "sea", "baoxiang"];

  /* ------------------------------------------------------------ 云端流程 */
  PS.flows = [
    {
      id: "flow_5d21", pattern: "lotus", revision: 4, state: "awaiting_selection",
      promptVersion: "decompose-v3.2", size: "1.5K", created: "14:20", updated: "14:32",
      decompositionJob: "job_8f1c", callId: "call_7a1",
      steps: [
        { name: "decompose-layers", state: "succeeded" },
        { name: "select_layers", state: "running" },
        { name: "vectorize", state: "queued" },
      ],
      layers: [
        { id: "layer_1", name: "主体 · 外圈莲瓣", color: "#23355e", selected: true },
        { id: "layer_2", name: "主体 · 缠枝", color: "#3b5a8f", selected: false },
        { id: "layer_3", name: "底纹 · 分色", color: "#b9c7df", selected: false },
      ],
      needsReconcile: false,
    },
    {
      id: "flow_4b18", pattern: "sepcolor", revision: 2, state: "needs_reconciliation",
      promptVersion: "decompose-v3.2", size: "1K", created: "11-18 16:10", updated: "11-18 16:24",
      decompositionJob: "job_8e44", callId: "call_6f0",
      steps: [
        { name: "decompose-layers", state: "outcome_unknown" },
        { name: "select_layers", state: "queued" },
      ],
      layers: [],
      needsReconcile: true,
    },
  ];

  PS.flowFor = (patternId) => PS.flows.find((f) => f.pattern === patternId) || null;

  /* ------------------------------------------------------------ 任务 */
  PS.jobs = [
    {
      id: "job_8f21", kind: "lineart", title: "生成线稿 · 本地模型", pattern: "lotus", stage: 5,
      state: "running", progress: 64, step: "推理 2 / 3", created: "14:36", started: "14:37", finished: "",
      duration: "", cloud: false, costCents: 0, feedback: false,
      steps: [
        { name: "load", state: "succeeded" },
        { name: "infer", state: "running" },
        { name: "postprocess", state: "queued" },
        { name: "publish", state: "queued" },
      ],
      params: { method: "model", local: true, input_asset_id: "asset-lotus-4-1" },
      result: { assets: [] },
      error: null,
    },
    {
      id: "job_8f1c", kind: "pipeline", title: "候选层拆分 · 云端", pattern: "lotus", stage: 4,
      state: "succeeded", progress: 100, step: "", created: "14:28", started: "14:28", finished: "14:32",
      duration: "38 秒", cloud: true, costCents: 12, feedback: false, callId: "call_7a1",
      steps: [
        { name: "load", state: "succeeded" },
        { name: "call", state: "succeeded" },
        { name: "download", state: "succeeded" },
        { name: "publish", state: "succeeded" },
      ],
      params: { operation: "decompose", intent: "separate_pattern", size: "1.5K", prompt_version: "decompose-v3.2" },
      result: { assets: [{ asset_id: "asset-lotus-4-1", kind: "generated_layer" }], steps: [] },
      error: null,
    },
    {
      id: "job_8f02", kind: "vectorize", title: "PNG → SVG 矢量化", pattern: "crane", stage: 7,
      state: "succeeded", progress: 100, step: "", created: "昨天 17:05", started: "昨天 17:05", finished: "昨天 17:05",
      duration: "6 秒", cloud: false, costCents: 0, feedback: true,
      steps: [
        { name: "load", state: "succeeded" },
        { name: "postprocess", state: "succeeded" },
        { name: "publish", state: "succeeded" },
      ],
      params: { mode: "color", max_colors: 8, detail: "medium" },
      result: { assets: [{ asset_id: "asset-crane-7-1", kind: "svg" }] },
      error: null,
    },
    {
      id: "job_8ef7", kind: "repair", title: "局部修复 · 云端", pattern: "baoxiang", stage: 3,
      state: "failed", progress: 0, step: "", created: "昨天 16:41", started: "昨天 16:41", finished: "昨天 16:42",
      duration: "12 秒", cloud: true, costCents: 0, feedback: false, callId: "call_6d8",
      steps: [
        { name: "load", state: "succeeded" },
        { name: "validate", state: "succeeded" },
        { name: "call", state: "failed" },
      ],
      params: { method: "cloud", intent: "restore_small_gap", size: "1K", bbox: { left: 620, top: 240, right: 760, bottom: 400 } },
      result: { assets: [] },
      error: { code: "PROVIDER_RATE_LIMITED", message: "云端返回 429：请求过于频繁，请稍后重试；本次未自动重发。" },
    },
    {
      id: "job_8ee0", kind: "export", title: "平铺 3×3 · 打包 ZIP", pattern: "sea", stage: 8,
      state: "succeeded", progress: 100, step: "", created: "11-18 10:12", started: "11-18 10:12", finished: "11-18 10:12",
      duration: "3 秒", cloud: false, costCents: 0, feedback: false,
      steps: [
        { name: "load", state: "succeeded" },
        { name: "export", state: "succeeded" },
      ],
      params: { asset_ids: ["asset-sea-8-1"], layout: "by_image", license_acknowledged: true },
      result: { assets: [{ asset_id: "asset-sea-zip-1", kind: "zip", filename: "pattern-studio-2026-11-18.zip" }] },
      error: null,
    },
    {
      id: "job_8ed4", kind: "refine-mask", title: "蒙版修正 · 提交笔迹", pattern: "cloud", stage: 6,
      state: "succeeded", progress: 100, step: "", created: "11-19 09:40", started: "11-19 09:40", finished: "11-19 09:40",
      duration: "2 秒", cloud: false, costCents: 0, feedback: false,
      steps: [
        { name: "load", state: "succeeded" },
        { name: "composite", state: "succeeded" },
        { name: "publish", state: "succeeded" },
      ],
      params: { algorithm: "brush", strokes: 2, invert: false, denoise: 1 },
      result: { assets: [{ asset_id: "asset-cloud-6-1", kind: "transparent_png" }] },
      error: null,
    },
    {
      id: "job_8ec1", kind: "pipeline", title: "候选层拆分 · 云端", pattern: "cloud", stage: 4,
      state: "cancelled", progress: 0, step: "", created: "11-19 09:31", started: "11-19 09:31", finished: "11-19 09:32",
      duration: "—", cloud: true, costCents: 0, feedback: false, callId: "call_6e1",
      steps: [
        { name: "load", state: "succeeded" },
        { name: "call", state: "cancelled" },
      ],
      params: { operation: "decompose", intent: "separate_pattern", size: "1K" },
      result: { assets: [] },
      error: { code: "JOB_CANCELLED", message: "任务已取消；已完成的早期步骤与版本保留。" },
    },
    {
      id: "job_8e44", kind: "pipeline", title: "候选层拆分 · 云端", pattern: "sepcolor", stage: 4,
      state: "failed", progress: 0, step: "", created: "11-18 16:10", started: "11-18 16:10", finished: "11-18 16:24",
      duration: "—", cloud: true, costCents: 0, feedback: false, callId: "call_6f0",
      steps: [
        { name: "load", state: "succeeded" },
        { name: "call", state: "failed" },
      ],
      params: { operation: "decompose", intent: "separate_pattern", size: "1K" },
      result: { assets: [] },
      error: { code: "NEEDS_RECONCILIATION", message: "云端结果未知，请先核对调用记录，不要重复提交。" },
    },
    {
      id: "job_8de0", kind: "working-copy", title: "创建工作副本", pattern: "sea", stage: 2,
      state: "succeeded", progress: 100, step: "", created: "11-18 08:55", started: "11-18 08:55", finished: "11-18 08:55",
      duration: "4 秒", cloud: false, costCents: 0, feedback: false,
      steps: [
        { name: "load", state: "succeeded" },
        { name: "infer", state: "succeeded" },
        { name: "publish", state: "succeeded" },
      ],
      params: { max_pixels: 1000000 },
      result: { assets: [{ asset_id: "asset-sea-2-2", kind: "working_copy" }] },
      error: null,
    },
    {
      id: "job_8dd2", kind: "cloud-lineart", title: "云端线稿", pattern: "bird", stage: 5,
      state: "succeeded", progress: 100, step: "", created: "11-17 15:20", started: "11-17 15:20", finished: "11-17 15:22",
      duration: "22 秒", cloud: true, costCents: 9, feedback: false, callId: "call_6b2",
      steps: [
        { name: "load", state: "succeeded" },
        { name: "call", state: "succeeded" },
        { name: "download", state: "succeeded" },
        { name: "publish", state: "succeeded" },
      ],
      params: { prompt_version: "cloud-lineart-v1", size: "1K" },
      result: { assets: [{ asset_id: "asset-bird-5-1", kind: "lineart" }] },
      error: null,
    },
  ];

  PS.jobById = (id) => PS.jobs.find((j) => j.id === id);

  /* ------------------------------------------------------------ 云端调用台账 */
  PS.calls = [
    { id: "call_7a1", operation: "decompose", state: "succeeded", costCents: 12, reference: "ark-2026-11-20-0041", at: "11-20 14:32", job: "job_8f1c" },
    { id: "call_6f0", operation: "decompose", state: "outcome_unknown", costCents: 0, reference: "", at: "11-18 16:24", job: "job_8e44" },
    { id: "call_6e1", operation: "decompose", state: "cancelled", costCents: 0, reference: "", at: "11-19 09:32", job: "job_8ec1" },
    { id: "call_6d8", operation: "edit", state: "failed", costCents: 0, reference: "", at: "11-20 16:42", job: "job_8ef7" },
    { id: "call_6b2", operation: "lineart", state: "succeeded", costCents: 9, reference: "ark-2026-11-17-0118", at: "11-17 15:22", job: "job_8dd2" },
    { id: "call_68a", operation: "edit", state: "succeeded", costCents: 18, reference: "ark-2026-11-14-0093", at: "11-14 11:06", job: "job_8d10" },
  ];

  PS.callById = (id) => PS.calls.find((c) => c.id === id);

  /* ------------------------------------------------------------ 批量预设 */
  PS.presets = [
    {
      id: "p1", name: "PNG → SVG · 标准", revision: 3, updated: "11-20 09:12",
      description: "颜色提取 + 4 色矢量化，适合青花与织锦。",
      options: { recipe: "color", crop: false, repair: false, candidates: false, mask: false, vectorize: true, tile: false, working_max_pixels: 1000000, extract: { mode: "otsu", polarity: "dark" }, vector: { max_colors: 4, detail: "medium" } },
    },
    {
      id: "p2", name: "模型线稿 → SVG", revision: 1, updated: "11-19 17:40",
      description: "本机线稿模型出 PNG，再以 2 色矢量化；慢但细节稳。",
      options: { recipe: "model_lineart", crop: true, repair: false, candidates: false, mask: true, vectorize: true, tile: false, working_max_pixels: 4000000, extract: { mode: "alpha" }, vector: { max_colors: 2, detail: "high" } },
    },
    {
      id: "p3", name: "云端线稿 → SVG", revision: 2, updated: "11-18 10:20",
      description: "云端线稿需要逐批同意上传与付费；结果未知时停止，不自动重发。",
      options: { recipe: "cloud_lineart", crop: true, repair: false, candidates: false, mask: false, vectorize: true, tile: false, working_max_pixels: 1000000, extract: { mode: "alpha" }, vector: { max_colors: 2, detail: "medium" } },
    },
    {
      id: "p4", name: "仅出透明 PNG", revision: 1, updated: "11-17 08:05",
      description: "只做前景提取与蒙版衔接，后续再单独转 SVG。",
      options: { recipe: "color", crop: false, repair: false, candidates: false, mask: true, vectorize: false, tile: false, working_max_pixels: 1000000, extract: { mode: "sauvola", polarity: "dark" }, vector: { max_colors: 8, detail: "medium" } },
    },
  ];

  PS.presetById = (id) => PS.presets.find((p) => p.id === id);

  /* ------------------------------------------------------------ 处理批次 */
  PS.batches = [
    {
      id: "batch_2601", name: "青花团花 · 批量矢量化", presetId: "p1", revision: 6,
      state: "running", created: "今天 13:52", manualGate: null, demo: true,
      items: [
        { pattern: "crane", state: "succeeded", cursor: 4, steps: ["load", "call", "publish", "export"], results: 2 },
        { pattern: "cloud", state: "running", cursor: 2, steps: ["load", "extract", "vectorize", "publish"], results: 1 },
        { pattern: "meander", state: "queued", cursor: 0, steps: ["load", "extract", "vectorize", "publish"], results: 0 },
        { pattern: "lotusbird", state: "queued", cursor: 0, steps: ["load", "extract", "vectorize", "publish"], results: 0 },
      ],
    },
    {
      id: "batch_2588", name: "缂丝补子 · 云端线稿", presetId: "p3", revision: 11,
      state: "waiting", created: "昨天 09:20", demo: true, manualGate: { pattern: "bird", reason: "同一原图已有更新的线稿版本；需明确选择续接对象。" },
      items: [
        { pattern: "bird", state: "waiting", cursor: 1, steps: ["load", "cloud-lineart", "publish"], results: 0 },
        { pattern: "sea", state: "succeeded", cursor: 3, steps: ["load", "cloud-lineart", "publish"], results: 2 },
        { pattern: "crane", state: "cancelled", cursor: 1, steps: ["load", "cloud-lineart"], results: 0 },
      ],
    },
    {
      id: "batch_2570", name: "织物残片 · 仅出 PNG", presetId: "p4", revision: 4,
      state: "succeeded", created: "11-18 16:40", manualGate: null, demo: true,
      items: [
        { pattern: "peony", state: "succeeded", cursor: 4, steps: ["load", "extract", "mask", "publish"], results: 2 },
        { pattern: "geo", state: "succeeded", cursor: 4, steps: ["load", "extract", "mask", "publish"], results: 1 },
      ],
    },
  ];

  PS.batchById = (id) => PS.batches.find((b) => b.id === id);
  PS.batchCounts = function (b) {
    const total = b.items.length;
    const done = b.items.filter((i) => i.state === "succeeded").length;
    const failed = b.items.filter((i) => i.state === "failed").length;
    const active = b.items.filter((i) => i.state === "running").length;
    return { total, done, failed, active, percent: total ? Math.round(((done + failed) / total) * 100) : 0 };
  };

  /* ------------------------------------------------------------ 修复候选 */
  PS.repair = {
    id: "repair_7c1", pattern: "lotus", revision: 3, state: "succeeded",
    method: "cloud", candidates: 2, decided: null, accepted: null,
    created: "14:15", bbox: { left: 560, top: 180, right: 860, bottom: 480 },
    candidatesList: [
      { id: "cand_a", file: "lotus-repair.svg", label: "候选 A", note: "补全外圈莲瓣，线条略粗", size: "1000 × 1000" },
      { id: "cand_b", file: "lotus-crop.svg", label: "候选 B", note: "保守修复，只补缺口", size: "1000 × 1000" },
    ],
  };

  /* ------------------------------------------------------------ SVG 图形与颜色 */
  PS.svg = {
    sourceSha: "3f9c6d2a7b1e4f08a5c3d9e2b7f4106c8d5e3a9b2c7f1d4e6a8b0c2d3e4f5a6b",
    paths: 69,
    bytes: 377710,
    mode: "color",
    elements: [
      { id: "p1c1", label: "主轮廓", color: "#1b2b54", count: 32, dx: 0, dy: 0, deleted: false },
      { id: "p1c2", label: "缠枝细线", color: "#3a5285", count: 21, dx: 0, dy: 0, deleted: false },
      { id: "p2c1", label: "花心填色", color: "#9fb1d1", count: 11, dx: 0, dy: 0, deleted: false },
      { id: "p3c1", label: "留白", color: "#f3ecdc", count: 5, dx: 0, dy: 0, deleted: false },
    ],
    palette: ["#1b2b54", "#3a5285", "#9fb1d1", "#f3ecdc"],
  };

  /* ------------------------------------------------------------ 数据集审计 */
  PS.audit = {
    total_images: 12,
    images_with_meta: 9,
    missing_meta: 3,
    usable_ab: 9,
    grades: { A: 5, B: 5, C: 1, U: 1, missing: 0 },
    splits: { train: 7, val: 2, test: 1, unassigned: 2 },
    license_confirmed: 9,
    license_unconfirmed: 3,
    license_coverage: 0.75,
    provenance_declared: 9,
    provenance_unverified: 3,
    source_types: { 馆藏实物拍摄: 7, 出版物扫描: 2, 网络图片: 1, 派生资产: 2 },
    batches: ["batch_2601", "batch_2588", "batch_2570"],
    content_ids: 12,
    duplicate_content_ids: 1,
    duplicate_images: 2,
    label_status: { not_reviewed: 12 },
  };

  /* ------------------------------------------------------------ 本机与云端状态 */
  PS.health = {
    status: "ok",
    scope: "s1_local_workbench",
    database: true,
    storage: true,
    worker: {
      alive: true,
      heartbeat_age_seconds: 1.2,
      active_job_id: "job_8f21",
      error: null,
      timeout_seconds: 900,
      memory_limit_mib: 6144,
      lineart_model_memory_limit_mib: 8192,
      leftrefill_memory_limit_mib: 4096,
      concurrency: 1,
    },
    versions: {
      manifest: "local-s1-v2",
      grade: "p0-v1",
      fingerprint: "p0-v1",
      pattern_score: "p0-v1",
      normalization: "normalize-image-v1",
      provenance: "p0-v1",
      extraction: "local-extraction-v2",
      vector: "vtracer-0.6-rgba-v4",
    },
    capabilities: {
      lineart_model: { available: true, reason: null, checked: "prerequisites_only" },
      leftrefill_model: { available: true, reason: null, checked: "prerequisites_only" },
    },
    limits: {
      upload_bytes: 20971520,
      decode_pixels: 25000000,
      working_pixels: 1000000,
      color_vector_pixels: 250000,
      model_lineart_pixels: 25000000,
      threshold_pixels: 4000000,
      working_copy_pixels: 25000000,
      tile_pixels: 4000000,
      provisional: true,
    },
  };

  PS.settings = {
    revision: 19,
    api_key_configured: true,
    api_key_storage: "windows_dpapi",
    model: "doubao-seedream-5-0-pro-260628",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    paid_calls_enabled: true,
    pricing_confirmed: true,
    budget_cents: 5000,
    reservation_cents: 20,
    max_calls: 100,
    blockers: [],
    effective: "next_provider_job",
    requires_restart: false,
  };

  PS.settingsBlockers = function (s) {
    const issues = [];
    if (!s.api_key_configured) issues.push("API_KEY_MISSING");
    if (!s.paid_calls_enabled) issues.push("PAID_CALLS_DISABLED");
    if (!s.pricing_confirmed) issues.push("PRICING_NOT_CONFIRMED");
    return issues;
  };

  PS.blockerLabels = {
    API_KEY_MISSING: "未配置 API Key",
    PAID_CALLS_DISABLED: "付费调用已关闭",
    PRICING_NOT_CONFIRMED: "未确认价格",
  };

  PS.OPERATION_LABELS = {
    decompose: "拆分层",
    edit: "局部修复",
    lineart: "云端线稿",
    validation: "自检",
  };
  PS.operationLabel = (op) => PS.OPERATION_LABELS[op] || op;

  /* ------------------------------------------------------------ 预设示例与价格 */
  PS.prices = { repair: 18, candidate: 12, lineart: 9, validation: 6 };

  PS.modelOptions = [
    "doubao-seedream-5-0-pro-260628",
    "doubao-seedream-5-5-261028",
    "doubao-seedream-4-5-251128",
  ];
})();

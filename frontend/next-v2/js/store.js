/* =============================================================================
   store.js — 页面共享的服务端数据（健康、设置、会话资产、纹样库、最近任务）。
   约定：
   - 视图通过 import { store } 读取数据；
   - 数据变化后由调用方决定何时 api.render()（app.js 的 patch 不做深合并）；
   - 会话只保留在内存里，刷新后通过 URL 的 image 参数或纹样库重新进入。
   - 会话与异步加载带归属令牌：每次会话身份改变（新会话发布、resetSession）
     都会递增 sessionEpoch；异步请求返回后若令牌已过期就丢弃结果，避免慢响应
     覆盖新会话。runJob 在提交前捕获令牌，轮询与终态写入只属于原会话。
   ============================================================================= */

import { api, ApiError, waitForJob } from "./api.js";
import { STAGES } from "./data.js";
import { stageForKind } from "./format.js";

const listeners = new Set();

/* 会话身份令牌：只在模块内递增，不写入 URL 或浏览器存储。 */
let sessionEpoch = 0;
/* 异步加载序号：每次 ensureSession / openAsset / startFromImage 入口递增。 */
let loadSeq = 0;

function emit(reason) {
  for (const listener of listeners) {
    try {
      listener(reason);
    } catch (error) {
      console.error("store listener failed", error);
    }
  }
}

function blankSession() {
  return {
    imageId: "",
    image: null,
    assets: [],
    currentAssetId: "",
    jobs: [],
    activeJob: null,
    busy: false,
    error: "",
  };
}

/** 模型线稿能力未知时的占位；不能把“未知”当成“不可用”。 */
function blankLineartModel() {
  return { available: null, reason: "", checked: "" };
}

/**
 * 解析 health.capabilities.lineart_model。旧后端、缺字段、非法值一律视为
 * “未知”（available: null），只有后端明确给出布尔值才下结论。
 */
function parseLineartModel(health) {
  const raw = health?.capabilities?.lineart_model;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return blankLineartModel();
  return {
    available: typeof raw.available === "boolean" ? raw.available : null,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    checked: typeof raw.checked === "string" ? raw.checked : "",
  };
}

function uniqueAssets(list) {
  const seen = new Set();
  const out = [];
  for (const asset of list) {
    if (!asset || !asset.asset_id || seen.has(asset.asset_id)) continue;
    seen.add(asset.asset_id);
    out.push(asset);
  }
  return out;
}

export const store = {
  health: null,
  healthError: "",
  /* 模型线稿前置检查结果：available 为布尔才是已知；null 表示未知。 */
  lineartModel: blankLineartModel(),
  settings: null,
  settingsError: "",
  seedream: null,
  dataset: null,
  recentAssets: [],
  recentJobs: [],
  recentLoaded: false,
  recentLoadedAt: 0,
  datasetLoaded: false,
  datasetLoadedAt: 0,
  session: blankSession(),
  library: {
    items: [],
    cursor: "",
    nextCursor: null,
    loading: false,
    error: "",
    q: "",
    kinds: [],
    grade: "全部",
    sort: "最新",
    view: "grid",
    totalHint: 0,
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  notify(reason = "manual") {
    emit(reason);
  },
  patch(partial, reason = "patch") {
    Object.assign(this, partial);
    emit(reason);
  },

  /* ------------------------------------------------------------ 当前位置 */

  /* 用户最近停留的工序（1–8），只存在内存里；首页据此把高亮跟到当前位置。 */
  lastStage: 0,

  /** 记下当前工序。不广播：换工序时首页不在屏幕上，重绘由下次进入首页负责。 */
  noteStage(stage) {
    const n = Number(stage);
    if (!Number.isInteger(n) || n < 1 || n > STAGES.length) return;
    this.lastStage = n;
  },

  /* ------------------------------------------------------------ 会话归属 */

  /** 当前会话令牌；调用方可在异步操作前捕获，结束后比较。 */
  sessionToken() {
    return sessionEpoch;
  },

  /** 令牌是否仍属于当前会话。 */
  isSessionCurrent(token) {
    return token !== undefined && token === sessionEpoch;
  },

  /* ------------------------------------------------------------ 服务状态 */

  async loadHealth() {
    try {
      const health = await api.health();
      this.health = health;
      this.healthError = "";
      this.lineartModel = parseLineartModel(health);
    } catch (error) {
      // health 读取失败（含整体 503）时保留上一次已知能力：不能据此断言
      // 缺少依赖或模型文件；真实推理失败仍由任务错误展示。
      this.health = null;
      this.healthError = error?.message || "无法连接本机服务。";
    }
    // 只广播 health；不触碰 settings、seedream 或任何用户参数，
    // 30 秒轮询可以安全地反复调用。
    emit("health");
    return this.health;
  },

  /** 只刷新云端调用状态（任务终态后的轻量刷新，失败静默）。 */
  async refreshBudget() {
    try {
      this.seedream = await api.seedreamStatus();
      emit("seedream");
    } catch {
      /* 状态刷新失败不影响任务结果 */
    }
    return this.seedream;
  },

  async loadSettings() {
    try {
      const [settings, seedream] = await Promise.all([api.settings(), api.seedreamStatus()]);
      this.settings = settings;
      this.seedream = seedream;
      this.settingsError = "";
    } catch (error) {
      this.settingsError = error?.message || "无法读取设置。";
    }
    emit("settings");
    return this.settings;
  },

  async saveSettings(payload) {
    const settings = await api.updateSettings(payload);
    this.settings = settings;
    this.settingsError = "";
    try {
      this.seedream = await api.seedreamStatus();
    } catch {
      /* 设置已保存；状态刷新失败不覆盖结果 */
    }
    emit("settings");
    return settings;
  },

  async loadDataset() {
    try {
      this.dataset = await api.datasetAudit();
      this.datasetLoaded = true;
      this.datasetLoadedAt = Date.now();
      emit("dataset");
    } catch {
      this.dataset = null;
    }
    return this.dataset;
  },

  /**
   * 按图读取一类历史（assets / jobs / flows），按 next_cursor 读完当前可读分页。
   * 只读：不提交任务、不重试、不核销云端调用。分页中途失败返回已读部分并标记
   * complete=false，调用方不能把它当作完整历史。
   */
  async imageHistory(imageId, collection, { limit = 50, maxPages = 20 } = {}) {
    const items = [];
    let cursor = "";
    let pages = 0;
    for (; pages < maxPages; pages += 1) {
      const page = await api.imageHistory(imageId, { collection, limit, cursor });
      items.push(...(page?.items || []));
      cursor = page?.next_cursor || "";
      if (!cursor) return { items, complete: true, pages: pages + 1 };
    }
    return { items, complete: false, pages };
  },

  async loadRecent() {
    try {
      const [assets, jobs] = await Promise.all([
        api.assets({ limit: 6 }),
        api.jobs({ limit: 8 }),
      ]);
      this.recentAssets = assets.items || [];
      this.recentJobs = jobs.items || [];
      this.recentLoaded = true;
      this.recentLoadedAt = Date.now();
      emit("recent");
    } catch {
      /* 首页局部数据失败时保留空列表，不阻塞整页 */
    }
  },

  /* ------------------------------------------------------------ 会话 */

  resetSession() {
    sessionEpoch += 1;
    this.session = blankSession();
    emit("session");
  },

  async ensureSession(imageId) {
    if (!imageId) return this.session;
    const seq = ++loadSeq;
    const epoch = sessionEpoch;
    if (this.session.imageId === imageId && this.session.image) {
      // 已经打开同一张图：让更早的 pending 请求失效后直接复用。
      loadSeq += 1;
      return this.session;
    }
    const image = await api.image(imageId).catch((error) => {
      if (seq !== loadSeq || sessionEpoch !== epoch) return null;
      throw error;
    });
    if (!image) return null;
    if (seq !== loadSeq || sessionEpoch !== epoch) return null;
    const assets = uniqueAssets([image.normalized, image.original]);
    sessionEpoch += 1;
    this.session = {
      ...blankSession(),
      imageId,
      image,
      assets,
      currentAssetId: assets[0]?.asset_id || "",
    };
    emit("session");
    return this.session;
  },

  /**
   * 上传新纹样并打开会话。上传是写请求，必须在**发请求前**捕获会话归属：
   * 上传期间用户若已切到别的会话，晚到的上传结果只返回给调用方，
   * 不发布会话、也不会给上传图片再发 GET /images/{id}。
   * @returns {{ result: object, session: object|null, stale: boolean }}
   */
  async uploadToSession(file, options = {}) {
    const token = sessionEpoch;
    const pendingLoad = loadSeq;
    // 来源名默认用文件名，让工作台标题和纹样库能区分不同纹样；调用方可覆盖。
    const provenance = { source_name: String(file?.name || "").slice(0, 200), ...(options.provenance || {}) };
    const result = await api.uploadImage(file, provenance, options);
    // 上传期间有任何新的加载开始（打开别的纹样/资产）或会话已切换，
    // 都说明这份上传结果是晚到的，不能再发布。
    if (!this.isSessionCurrent(token) || loadSeq !== pendingLoad) {
      return { result, session: null, stale: true };
    }
    const session = await this.startFromImage(result, { token });
    if (!session) return { result, session: null, stale: true };
    return { result, session, stale: false };
  },

  async startFromImage(imageRecord, { token } = {}) {
    const imageId = imageRecord.image_id;
    // 传入 token 时以它作为归属：发请求前先判 stale（不浪费一次 GET）。
    if (token !== undefined && !this.isSessionCurrent(token)) return null;
    const epoch = token === undefined ? sessionEpoch : token;
    const seq = ++loadSeq;
    const image = await api.image(imageId).catch((error) => {
      if (seq !== loadSeq || sessionEpoch !== epoch) return null;
      throw error;
    });
    if (!image) return null;
    if (seq !== loadSeq || sessionEpoch !== epoch) return null;
    const assets = uniqueAssets([image.normalized, image.original]);
    sessionEpoch += 1;
    this.session = {
      ...blankSession(),
      imageId,
      image,
      assets,
      currentAssetId: assets[0]?.asset_id || "",
    };
    emit("session");
    return this.session;
  },

  /** 从纹样库挑一个资产作为工作输入。 */
  async openAsset(assetId, { stage = null } = {}) {
    const seq = ++loadSeq;
    const epoch = sessionEpoch;
    const current = () => seq === loadSeq && sessionEpoch === epoch;
    let asset;
    try {
      asset = await api.asset(assetId);
    } catch (error) {
      if (!current()) return null;
      throw error;
    }
    if (!current()) return null;
    let image = null;
    if (asset.image_id) {
      try {
        image = this.session.imageId === asset.image_id && this.session.image
          ? this.session.image
          : await api.image(asset.image_id);
      } catch {
        if (!current()) return null;
        image = null;
      }
    }
    if (!current()) return null;
    const extras = image ? [image.normalized, image.original] : [];
    sessionEpoch += 1;
    this.session = {
      ...blankSession(),
      imageId: asset.image_id || "",
      image,
      assets: uniqueAssets([...extras, asset]),
      currentAssetId: asset.asset_id,
    };
    emit("session");
    const humanCorrected =
      asset.annotation_source === "human_foreground_correction" ||
      asset.parameters?.annotation_source === "human_foreground_correction";
    return { asset, stage: stage ?? (humanCorrected ? 6 : stageForKind(asset.kind)) };
  },

  setCurrentAsset(assetId) {
    if (!assetId || this.session.currentAssetId === assetId) return;
    this.session.currentAssetId = assetId;
    emit("session");
  },

  /**
   * 只从当前工作台移除一份派生资产，不删除纹样库里的记录。
   * 原件与规范输入是会话底座，不允许移除。
   */
  removeAsset(assetId) {
    const index = this.session.assets.findIndex((asset) => asset.asset_id === assetId);
    if (index < 0) return null;
    const removed = this.session.assets[index];
    if (["original", "normalized", "normalized_input"].includes(removed.kind)) return null;
    const remaining = this.session.assets.filter((asset) => asset.asset_id !== assetId);
    if (this.session.currentAssetId === assetId) {
      const fallback = this.session.assets[index - 1] || this.session.assets[index + 1] || null;
      this.session.currentAssetId = fallback?.asset_id || "";
    }
    this.session.assets = remaining;
    emit("session");
    return removed;
  },

  currentAsset() {
    return this.session.assets.find((asset) => asset.asset_id === this.session.currentAssetId) || null;
  },

  assetById(assetId) {
    return this.session.assets.find((asset) => asset.asset_id === assetId) || null;
  },

  /** 把按图恢复时读取到的资产并入当前会话；已存在则不重复加入。 */
  rememberAsset(asset, { token } = {}) {
    if (!asset?.asset_id) return null;
    if (token !== undefined && token !== sessionEpoch) return null;
    const existing = this.assetById(asset.asset_id);
    if (existing) return existing;
    this.session.assets = uniqueAssets([...this.session.assets, asset]);
    emit("session");
    return asset;
  },

  /**
   * 把任务产物并入会话资产（按出现顺序）。
   * 传入 token 时只在仍属于该会话时写入；失败/取消任务也已发布的产物同样保留。
   */
  addJobAssets(job, { token } = {}) {
    if (token !== undefined && token !== sessionEpoch) return [];
    const assets = job?.result?.assets || [];
    if (!assets.length) return [];
    this.session.assets = uniqueAssets([...this.session.assets, ...assets]);
    emit("session");
    return assets;
  },

  /**
   * 接受修复后按 decision.accepted_asset_id 读取 accepted_repair 并加入会话。
   * 只有真正读取成功并写入会话才算“可用”；读取失败/会话已切换都如实返回状态。
   * @returns {{ asset: object|null, status: "adopted"|"already_present"|"no_accepted_asset"|"stale_session"|"fetch_failed", error?: Error }}
   */
  async adoptAcceptedRepair(infoOrResult, token) {
    const decision =
      infoOrResult?.decision && typeof infoOrResult.decision === "object"
        ? infoOrResult.decision
        : infoOrResult;
    const acceptedId = String(decision?.accepted_asset_id || "").trim();
    if (!acceptedId) return { asset: null, status: "no_accepted_asset" };
    const current = () => token === undefined || token === sessionEpoch;
    if (!current()) return { asset: null, status: "stale_session" };
    const existing = this.assetById(acceptedId);
    if (existing) return { asset: existing, status: "already_present" };
    let asset;
    try {
      asset = await api.asset(acceptedId);
    } catch (error) {
      if (!current()) return { asset: null, status: "stale_session" };
      return { asset: null, status: "fetch_failed", error };
    }
    if (!current()) return { asset: null, status: "stale_session" };
    if (!asset || !asset.asset_id) {
      return { asset: null, status: "fetch_failed", error: new ApiError("修复资产读取结果为空。") };
    }
    // 等待期间可能有并发的接受调用已经加入，避免重复。
    const duplicate = this.assetById(acceptedId);
    if (duplicate) return { asset: duplicate, status: "already_present" };
    this.session.assets = uniqueAssets([...this.session.assets, asset]);
    emit("session");
    return { asset, status: "adopted" };
  },

  /**
   * 提交并等待一个本机任务，期间更新 session.busy / activeJob。
   * @param {Function|Promise} submit 提交函数；在调用前捕获会话归属令牌。
   *   runJob 只把提交前已捕获令牌的原会话视为“拥有”这个任务：
   *   会话切换后不再轮询、不写 jobs/assets、不清 busy/activeJob。
   * @returns {Promise<{job: object|null, owned: boolean}>}
   */
  async runJob(submit, { onQueued, onTick, signal, interval } = {}) {
    const token = sessionEpoch;
    const owned = () => token === sessionEpoch;
    let busySet = false;
    try {
      const queued = await (typeof submit === "function" ? submit() : submit);
      if (!queued || !queued.job_id) return { job: null, owned: false };
      if (!owned()) return { job: null, owned: false };
      this.session.activeJob = queued;
      this.session.busy = true;
      busySet = true;
      emit("job-start");
      onQueued?.(queued);
      const final = await waitForJob(queued.job_id, {
        signal,
        interval,
        abandon: () => !owned(),
        onTick: (snapshot) => {
          if (!owned()) return;
          this.session.activeJob = snapshot;
          onTick?.(snapshot);
        },
      });
      if (!final || !owned()) return { job: final, owned: false };
      this.session.jobs.push(final);
      this.addJobAssets(final, { token });
      return { job: final, owned: true };
    } finally {
      if (busySet && owned()) {
        this.session.busy = false;
        this.session.activeJob = null;
        emit("job-end");
      }
    }
  },

  /* ------------------------------------------------------------ 纹样库 */

  async loadLibrary({ append = false } = {}) {
    const lib = this.library;
    if (lib.loading) return;
    lib.loading = true;
    lib.error = "";
    emit("library-loading");
    try {
      const page = await api.assets({
        limit: 50,
        cursor: append ? lib.cursor : "",
        q: lib.q,
        kinds: lib.kinds,
      });
      const items = append ? [...lib.items, ...(page.items || [])] : page.items || [];
      lib.items = this.filterAndSort(items);
      lib.cursor = page.next_cursor || "";
      lib.nextCursor = page.next_cursor || null;
      lib.totalHint = lib.items.length;
    } catch (error) {
      lib.error = error?.message || "纹样库读取失败。";
      if (!append) lib.items = [];
    } finally {
      lib.loading = false;
      emit("library");
    }
  },

  filterAndSort(items) {
    const lib = this.library;
    let list = items.slice();
    if (lib.grade !== "全部") list = list.filter((asset) => (asset.grade || "U") === lib.grade);
    const order = { A: 0, B: 1, C: 2, U: 3 };
    if (lib.sort === "评级") {
      list.sort((a, b) => (order[a.grade] ?? 4) - (order[b.grade] ?? 4) || String(b.created_at).localeCompare(String(a.created_at)));
    } else if (lib.sort === "最早") {
      list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    } else if (lib.sort === "类型") {
      list.sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || String(b.created_at).localeCompare(String(a.created_at)));
    }
    return list;
  },

  setLibraryQuery(partial) {
    Object.assign(this.library, partial);
    emit("library-query");
  },
};

export { ApiError };

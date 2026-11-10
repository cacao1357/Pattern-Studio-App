/* =============================================================================
   store.js — 页面共享的服务端数据（健康、设置、会话资产、纹样库、最近任务）。
   约定：
   - 视图通过 import { store } 读取数据；
   - 数据变化后由调用方决定何时 api.render()（app.js 的 patch 不做深合并）；
   - 会话只保留在内存里，刷新后通过 URL 的 image 参数或纹样库重新进入。
   ============================================================================= */

import { api, ApiError, waitForJob } from "./api.js";
import { stageForKind } from "./format.js";

const listeners = new Set();

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

  /* ------------------------------------------------------------ 服务状态 */

  async loadHealth() {
    try {
      const health = await api.health();
      this.health = health;
      this.healthError = "";
    } catch (error) {
      this.health = null;
      this.healthError = error?.message || "无法连接本机服务。";
    }
    emit("health");
    return this.health;
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
    this.session = blankSession();
    emit("session");
  },

  async ensureSession(imageId) {
    if (!imageId) return this.session;
    if (this.session.imageId === imageId && this.session.image) return this.session;
    const image = await api.image(imageId);
    const assets = uniqueAssets([image.normalized, image.original]);
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

  async startFromImage(imageRecord) {
    const imageId = imageRecord.image_id;
    const image = await api.image(imageId);
    const assets = uniqueAssets([image.normalized, image.original]);
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
    const asset = await api.asset(assetId);
    let image = null;
    if (asset.image_id) {
      try {
        image = this.session.imageId === asset.image_id && this.session.image
          ? this.session.image
          : await api.image(asset.image_id);
      } catch {
        image = null;
      }
    }
    const extras = image ? [image.normalized, image.original] : [];
    this.session = {
      ...blankSession(),
      imageId: asset.image_id || "",
      image,
      assets: uniqueAssets([...extras, asset]),
      currentAssetId: asset.asset_id,
    };
    emit("session");
    return { asset, stage: stage ?? stageForKind(asset.kind) };
  },

  setCurrentAsset(assetId) {
    if (!assetId || this.session.currentAssetId === assetId) return;
    this.session.currentAssetId = assetId;
    emit("session");
  },

  currentAsset() {
    return this.session.assets.find((asset) => asset.asset_id === this.session.currentAssetId) || null;
  },

  assetById(assetId) {
    return this.session.assets.find((asset) => asset.asset_id === assetId) || null;
  },

  /** 把任务产物并入会话资产（按出现顺序）。 */
  addJobAssets(job) {
    const assets = job?.result?.assets || [];
    if (!assets.length) return [];
    this.session.assets = uniqueAssets([...this.session.assets, ...assets]);
    emit("session");
    return assets;
  },

  /**
   * 提交并等待一个本机任务，期间更新 session.busy / activeJob。
   * onTick 会收到每次轮询的任务快照，可用于局部进度文案。
   */
  async runJob(jobPromise, { onTick, signal } = {}) {
    const queued = await jobPromise;
    this.session.activeJob = queued;
    this.session.busy = true;
    emit("job-start");
    try {
      const final = await waitForJob(queued.job_id, { signal, onTick: (snap) => {
        this.session.activeJob = snap;
        onTick?.(snap);
      } });
      this.session.jobs.push(final);
      this.addJobAssets(final);
      return final;
    } finally {
      this.session.busy = false;
      this.session.activeJob = null;
      emit("job-end");
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

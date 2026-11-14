/* 任务中心纯逻辑：目标定位与筛选。用 data URL 递归加载真实 ES Module，不碰 DOM。 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const JS_ROOT = new URL("../next-v2/js/", import.meta.url);
const moduleCache = new Map();
const RELATIVE_IMPORT = /from\s+["'](\.{1,2}\/[^"']+)["']/g;

async function loadRecord(specifier, baseUrl = JS_ROOT) {
  const url = new URL(specifier, baseUrl);
  const key = url.href;
  if (moduleCache.has(key)) return moduleCache.get(key);
  const pending = (async () => {
    let source = await readFile(url, "utf8");
    const dependencies = [...source.matchAll(RELATIVE_IMPORT)].map((match) => match[1]);
    for (const dependency of dependencies) {
      const dependencyRecord = await loadRecord(dependency, url);
      source = source
        .split(`from "${dependency}"`)
        .join(`from "${dependencyRecord.dataUrl}"`)
        .split(`from '${dependency}'`)
        .join(`from '${dependencyRecord.dataUrl}'`);
    }
    const dataUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
    return { dataUrl, module: await import(dataUrl) };
  })();
  moduleCache.set(key, pending);
  return pending;
}

const { module: tasks } = await loadRecord("./views/tasks.js");

const baseJob = {
  job_id: "job-1",
  kind: "pipeline",
  state: "failed",
  input_asset_id: "input-asset",
  result: {
    assets: [
      { asset_id: "mask", kind: "foreground_mask", image_id: "image-1" },
      { asset_id: "line", kind: "lineart", image_id: "image-1" },
      { asset_id: "zip", kind: "zip", image_id: "image-1" },
    ],
  },
};

test("taskTarget uses the last published non-archive asset", () => {
  const target = tasks.taskTarget(baseJob);
  assert.equal(target.assetId, "line");
  assert.equal(target.imageId, "image-1");
  assert.equal(target.stage, 5);
});

test("taskTarget falls back to the input asset", () => {
  const target = tasks.taskTarget({
    job_id: "job-2",
    kind: "crop",
    state: "failed",
    input_asset_id: "input-only",
    result: { assets: [{ asset_id: "zip-only", kind: "zip" }] },
  });
  assert.equal(target.assetId, "input-only");
  assert.equal(target.stage, 2);
});

test("taskTarget refuses jobs without an asset or image", () => {
  assert.equal(tasks.taskTarget({ job_id: "job-3", kind: "export", state: "failed", result: { assets: [] } }), null);
  assert.equal(tasks.taskTarget(null), null);
});

test("statusGroup folds queued/running into active", () => {
  assert.equal(tasks.statusGroup("queued"), "active");
  assert.equal(tasks.statusGroup("running"), "active");
  assert.equal(tasks.statusGroup("failed"), "failed");
  assert.equal(tasks.statusGroup("succeeded"), "succeeded");
  assert.equal(tasks.statusGroup("cancelled"), "cancelled");
});

test("taskMatches filters by status, kind, id and error", () => {
  assert.equal(tasks.taskMatches(baseJob, "", "failed"), true);
  assert.equal(tasks.taskMatches(baseJob, "", "succeeded"), false);
  assert.equal(tasks.taskMatches(baseJob, "一键处理", "all"), true);
  assert.equal(tasks.taskMatches(baseJob, "job-1", "all"), true);
  assert.equal(tasks.taskMatches(baseJob, "不存在", "all"), false);
  assert.equal(
    tasks.taskMatches({ ...baseJob, error: { code: "WORKER_MEMORY_LIMIT", message: "memory limit" } }, "memory", "failed"),
    true
  );
});

/* ------------------------------------------------------------------ DOM 替身行为回归 */

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

async function waitFor(predicate, timeout = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function fakeElement() {
  return {
    innerHTML: "",
    textContent: "",
    value: "",
    hidden: false,
    disabled: false,
    handlers: {},
    addEventListener(type, handler) {
      (this.handlers[type] ||= []).push(handler);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

/** 只实现任务视图实际用到的 DOM 部分；返回操作后可在测试里读取的节点。 */
function mountTasksView() {
  const elements = {
    "[data-tk-list]": fakeElement(),
    "[data-tk-more]": fakeElement(),
    "[data-tk-refresh]": fakeElement(),
    "[data-tk-count]": fakeElement(),
    "[data-tk-detail]": fakeElement(),
    "[data-tk-q]": fakeElement(),
  };
  const page = {
    isConnected: true,
    handlers: {},
    addEventListener(type, handler) {
      (this.handlers[type] ||= []).push(handler);
    },
    querySelector(selector) {
      return elements[selector] || null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const root = { querySelector: (selector) => (selector === ".tk-page" ? page : null) };
  const originalDocument = globalThis.document;
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  tasks.default.mount(root, {}, { toast() {}, closeDrawer() {}, go() {} }, new URLSearchParams());
  return {
    list: elements["[data-tk-list]"],
    detail: elements["[data-tk-detail]"],
    more: elements["[data-tk-more]"],
    loadMore() {
      (this.more.handlers.click || []).forEach((handler) => handler({}));
    },
    clickStatus(status) {
      const chip = { dataset: { tkStatus: status } };
      const event = {
        target: {
          closest(selector) {
            return selector === "[data-tk-status]" ? chip : null;
          },
        },
      };
      (page.handlers.click || []).forEach((handler) => handler(event));
    },
    restore() {
      tasks.default.unmount();
      globalThis.document = originalDocument;
    },
  };
}

test("自动轮询只刷新进行中任务，不丢已加载的后续分页", async () => {
  const originalFetch = globalThis.fetch;
  let firstPageCalls = 0;
  const jobOne = {
    job_id: "job-1",
    kind: "crop",
    state: "running",
    input_asset_id: "input-1",
    created_at: "2026-11-14T10:00:00+08:00",
    updated_at: "2026-11-14T10:00:01+08:00",
  };
  const jobTwo = {
    job_id: "job-2",
    kind: "crop",
    state: "succeeded",
    input_asset_id: "input-1",
    created_at: "2026-11-14T09:00:00+08:00",
    updated_at: "2026-11-14T09:30:00+08:00",
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), "http://local");
    if (url.pathname === "/api/v1/jobs/job-1") {
      return jsonResponse({ ...jobOne, state: "succeeded", updated_at: "2026-11-14T10:00:09+08:00" });
    }
    if (url.pathname === "/api/v1/jobs") {
      const cursor = url.searchParams.get("cursor") || "";
      if (!cursor) {
        firstPageCalls += 1;
        return jsonResponse({ items: [jobOne], next_cursor: "page-2" });
      }
      return jsonResponse({ items: [jobTwo], next_cursor: null });
    }
    throw new Error(`unexpected fetch: ${init.method || "GET"} ${url.pathname}`);
  };
  const view = mountTasksView();
  try {
    await waitFor(() => view.list.innerHTML.includes('data-tk-job="job-1"'));
    assert.equal(view.more.hidden, false);
    view.loadMore();
    await waitFor(() => view.list.innerHTML.includes('data-tk-job="job-2"'));
    assert.equal(firstPageCalls, 1);

    await tasks.pollActiveJobs();

    // 轮询后第一页与“加载更多”的第二页都还在，且没有重新拉第一页。
    assert.match(view.list.innerHTML, /data-tk-job="job-1"/);
    assert.match(view.list.innerHTML, /data-tk-job="job-2"/);
    assert.equal(firstPageCalls, 1);
    assert.match(view.list.innerHTML, /已完成/);
  } finally {
    view.restore();
    globalThis.fetch = originalFetch;
  }
});

test("筛选排除当前任务时，详情跟随可见任务或清空", async () => {
  const originalFetch = globalThis.fetch;
  const jobOk = {
    job_id: "job-ok",
    kind: "crop",
    state: "succeeded",
    input_asset_id: "input-1",
    created_at: "2026-11-14T10:00:00+08:00",
  };
  const jobBad = {
    job_id: "job-bad",
    kind: "crop",
    state: "failed",
    input_asset_id: "input-1",
    created_at: "2026-11-14T09:00:00+08:00",
    error: { code: "WORKER_TIMEOUT", message: "worker timeout" },
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://local");
    if (url.pathname === "/api/v1/jobs") {
      return jsonResponse({ items: [jobOk, jobBad], next_cursor: null });
    }
    throw new Error(`unexpected fetch: ${url.pathname}`);
  };
  const view = mountTasksView();
  try {
    await waitFor(() => view.detail.innerHTML.includes("job-ok"));
    view.clickStatus("failed");
    assert.match(view.detail.innerHTML, /job-bad/);
    assert.doesNotMatch(view.detail.innerHTML, /job-ok/);

    // 没有任何“进行中”任务时，不能继续显示被筛掉的失败任务。
    view.clickStatus("active");
    assert.doesNotMatch(view.detail.innerHTML, /job-bad/);
    assert.doesNotMatch(view.detail.innerHTML, /job-ok/);
  } finally {
    view.restore();
    globalThis.fetch = originalFetch;
  }
});

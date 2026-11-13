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

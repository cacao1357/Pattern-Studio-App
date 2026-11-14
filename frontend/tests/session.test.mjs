/* 会话操作：从工作台移除派生资产，不碰原件/规范输入。 */

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

const { module: storeModule } = await loadRecord("./store.js");
const store = storeModule.store;

function seed(assets, currentAssetId) {
  store.session = {
    imageId: "image-1",
    image: null,
    assets,
    currentAssetId,
    jobs: [],
    activeJob: null,
    busy: false,
    error: "",
  };
}

const base = { asset_id: "original", kind: "original" };
const normalized = { asset_id: "normalized", kind: "normalized_input" };
const lineart = { asset_id: "lineart", kind: "lineart" };
const svg = { asset_id: "svg", kind: "svg" };

test("removeAsset removes a derived asset and falls back from the current one", () => {
  seed([base, normalized, lineart, svg], "svg");
  const removed = store.removeAsset("svg");
  assert.equal(removed.asset_id, "svg");
  assert.deepEqual(store.session.assets.map((asset) => asset.asset_id), ["original", "normalized", "lineart"]);
  assert.equal(store.session.currentAssetId, "lineart");
});

test("removeAsset keeps the current asset when removing a non-current entry", () => {
  seed([base, normalized, lineart, svg], "lineart");
  store.removeAsset("svg");
  assert.equal(store.session.currentAssetId, "lineart");
});

test("removeAsset refuses the original and normalized inputs", () => {
  seed([base, normalized, lineart], "lineart");
  assert.equal(store.removeAsset("original"), null);
  assert.equal(store.removeAsset("normalized"), null);
  assert.equal(store.session.assets.length, 3);
});

test("removeAsset falls back to the remaining base asset", () => {
  seed([base, { asset_id: "crop", kind: "cropped" }], "crop");
  store.removeAsset("crop");
  assert.equal(store.session.currentAssetId, "original");
  assert.deepEqual(store.session.assets.map((asset) => asset.asset_id), ["original"]);
});

test("removeAsset is a no-op for an unknown id", () => {
  seed([base, lineart], "lineart");
  assert.equal(store.removeAsset("missing"), null);
  assert.equal(store.session.currentAssetId, "lineart");
});

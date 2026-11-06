// Offline Edge integration check. Requires the existing Python env and Edge; no npm deps.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = process.argv[2] || "D:/CondaEnvs/pattern-studio/python.exe";
const edge = process.env.PATTERN_STUDIO_TEST_EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const temp = await mkdtemp(path.join(tmpdir(), "pattern-a-browser-"));
const output = path.join(root, "storage", "validation", "a");
const checks = [];
let fixture, browser, socket;

function firstLine(child, stream, matcher) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Fixture/browser startup timed out")), 20000);
    child.once("error", reject);
    child.once("exit", (code) => { if (code) reject(new Error("Fixture/browser exited: " + code)); });
    child[stream].on("data", (data) => {
      buffer = (buffer + data).slice(-32768);
      const match = buffer.match(matcher);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
}

try {
  fixture = spawn(python, ["-B", "backend/tests/browser_fixture_a.py", temp], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const info = JSON.parse(await firstLine(fixture, "stdout", /FIXTURE (\{[^\r\n]+\})/));
  await mkdir(output, { recursive: true });
  browser = spawn(edge, ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + path.join(temp, "edge"),
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "about:blank"],
    { cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await firstLine(browser, "stderr", /DevTools listening on (ws:\/\/[^\s]+)/);
  socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 0, sessionId;
  const pending = new Map(), errors = [], requests = [];
  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const ticket = pending.get(data.id); pending.delete(data.id); clearTimeout(ticket.timer);
      data.error ? ticket.reject(new Error(data.error.message)) : ticket.resolve(data.result);
    } else if (data.method === "Runtime.exceptionThrown") {
      errors.push(data.params.exceptionDetails.text);
    } else if (data.method === "Network.requestWillBeSent") {
      requests.push({ method: data.params.request.method, path: new URL(data.params.request.url).pathname });
    }
  });
  const call = (method, params = {}, page = true) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(page && sessionId ? { sessionId } : {}) }));
  });
  const target = await call("Target.createTarget", { url: "about:blank" }, false);
  sessionId = (await call("Target.attachToTarget", { targetId: target.targetId, flatten: true }, false)).sessionId;
  await call("Runtime.enable"); await call("Page.enable"); await call("Network.enable");
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error("Page evaluation failed: " + result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, label, timeout = 12000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const diagnostic = await evaluate("({settingsOpen:document.getElementById('settings-dialog')?.open,settingsError:document.getElementById('settings-error')?.textContent,health:document.getElementById('health-label')?.textContent,aiState:document.getElementById('ai-pipeline-state')?.textContent,aiSelection:document.getElementById('ai-selection-note')?.textContent,aiComposeDisabled:document.getElementById('ai-compose')?.disabled,aiError:document.getElementById('ai-pipeline-error')?.textContent,checkbox:Array.from(document.querySelectorAll('[data-ai-layer-id]')).map(e=>({checked:e.checked,disabled:e.disabled}))})");
    throw new Error("UI timeout: " + label + " " + JSON.stringify({ diagnostic, errors, requests: requests.slice(-12) }));
  };
  const check = (label) => { checks.push(label); console.log("PASS " + label); };
  const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const fill = (id, value, event = "input") => evaluate(`(() => {const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);

  await call("Page.navigate", { url: info.url });
  await waitFor("document.getElementById('health-label')?.textContent.includes('就绪') || document.getElementById('health-label')?.textContent.includes('正常') || document.getElementById('health-label')?.textContent.includes('可用')", "initial application");
  await click("open-settings");
  await waitFor("document.getElementById('settings-dialog').open && document.getElementById('settings-model').value.length > 0", "settings loaded");
  assert.equal(await evaluate("document.getElementById('settings-key-input').value"), "");
  check("settings open without returning a key");
  await fill("settings-key-action", "replace", "change");
  await fill("settings-key-input", "browser-synthetic-key");
  await fill("settings-budget", "12.34");
  await fill("settings-reservation", "0.56");
  await click("settings-save");
  await waitFor("document.getElementById('settings-revision').textContent.includes('2') && !document.getElementById('settings-save').disabled", "settings saved");
  assert.equal(await evaluate("document.getElementById('settings-key-input').value"), "");
  const state = await evaluate("fetch('/api/v1/settings').then(r=>r.json())");
  assert.equal(state.budget_cents, 1234); assert.equal(state.reservation_cents, 56); assert.equal(state.api_key_configured, true);
  assert.equal(await evaluate("JSON.stringify({...localStorage}) + JSON.stringify({...sessionStorage})").then(s => s.includes("browser-synthetic-key")), false);
  check("save converts money, clears input, and stores no browser key");
  await evaluate("fetch('/api/v1/settings',{method:'PUT',headers:{'Content-Type':'application/json','X-Pattern-Studio':'local'},body:JSON.stringify({revision:2,max_calls:6})}).then(r=>r.json())");
  await click("settings-save");
  await waitFor("document.getElementById('settings-error').textContent.length > 0 && document.getElementById('settings-revision').textContent.includes('3')", "settings conflict recovery");
  check("stale settings revision reloads and reports conflict");
  await fill("settings-key-action", "clear", "change");
  // If the application requests its existing confirmation dialog, accept that UI.
  await click("settings-save");
  await new Promise((resolve) => setTimeout(resolve, 150));
  await evaluate("(() => {const d=document.getElementById('confirm-dialog');if(d.open)document.getElementById('confirm-accept').click();})()");
  await waitFor("document.getElementById('settings-revision').textContent.includes('4')", "clear key saved");
  assert.equal(await evaluate("fetch('/api/v1/settings').then(r=>r.json()).then(s=>s.api_key_configured)"), false);
  check("clear key is persisted");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await writeFile(path.join(output, "settings-desktop.png"), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate("document.getElementById('settings-dialog').getBoundingClientRect().width <= 390"), true);
  await writeFile(path.join(output, "settings-mobile.png"), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
  check("settings dialog fits 390px viewport");
  await call("Emulation.clearDeviceMetricsOverride");
  await click("settings-close");

  // Exercise failed workflows before the ordinary successful workflow. Only
  // fixture responses are altered; no failed state or cloud request is persisted.
  const fixtureFlow = await evaluate(`fetch('/api/v1/pipelines/${info.pipeline_id}').then(r=>r.json())`);
  for (const failure of ["no-decomposition", "layers-unavailable"]) {
    await evaluate(`(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, options) => {
        const pathname = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
        if (pathname === '/api/v1/jobs/${fixtureFlow.decomposition_job_id}/layers') {
          window.fixtureLayersFailed = true;
          return new Response(JSON.stringify({error:{code:'FIXTURE_LAYERS_UNAVAILABLE',message:'fixture layers unavailable'}}),
            {status:503,headers:{'Content-Type':'application/json'}});
        }
        const response = await originalFetch(input, options);
        if (pathname !== '/api/v1/pipelines/${info.pipeline_id}') return response;
        const data = await response.json();
        data.state = 'failed'; data.decision = null;
        data.error = {code:'FIXTURE_FAILURE',message:'fixture workflow failed'};
        data.recovery = {...data.recovery,can_compose:${failure === "layers-unavailable"}};
        if (${failure === "no-decomposition"}) data.decomposition_job_id = null;
        return new Response(JSON.stringify(data), {status:200,headers:{'Content-Type':'application/json'}});
      };
    })()`);
    await click("open-history");
    await waitFor("document.querySelectorAll('#history-list [data-history-id]').length > 0", "failure history loaded");
    await evaluate(`document.querySelector('#history-list [data-history-id="${fixtureFlow.decomposition_job_id}"]')?.click()`);
    await waitFor(`document.querySelector('#history-detail [data-history-action="restore"][data-job-id="${fixtureFlow.decomposition_job_id}"]')`, "failure job detail");
    await evaluate(`document.querySelector('#history-detail [data-history-action="restore"][data-job-id="${fixtureFlow.decomposition_job_id}"]').click()`);
    await waitFor("document.getElementById('ai-pipeline-error').textContent.includes('fixture workflow failed')", "failed workflow restored");
    if (failure === "layers-unavailable") await waitFor("window.fixtureLayersFailed", "candidate layer failure received");
    await evaluate("document.querySelector('.rail-step[data-stage=\"4\"]').click()");
    const recovery = await evaluate("(() => {const e=document.getElementById('ai-use-local');return {visible:e.getClientRects().length>0 && !e.closest('[hidden]'),enabled:!e.disabled,candidatesHidden:document.getElementById('ai-candidates').hidden};})()");
    assert.equal(recovery.candidatesHidden, true);
    assert.equal(recovery.visible, true, `local recovery hidden after ${failure}`);
    assert.equal(recovery.enabled, true, `local recovery disabled after ${failure}`);
    check(`failed workflow retains local recovery: ${failure}`);
    await call("Page.reload");
    await waitFor("document.getElementById('health-chip')?.classList.contains('is-ok')", "application reloaded");
  }

  // Load the fixture workflow via the application's ordinary history action.
  await click("open-history");
  await waitFor("document.querySelectorAll('#history-list [data-history-id]').length > 0", "history loaded");
  const flow = await evaluate(`fetch('/api/v1/pipelines/${info.pipeline_id}').then(r=>r.json())`);
  const actions = await evaluate("Array.from(document.querySelectorAll('#history-detail [data-history-action]')).map(e=>({action:e.dataset.historyAction,jobId:e.dataset.jobId,pipelineId:e.dataset.pipelineId}))");
  await evaluate(`document.querySelector('#history-list [data-history-id="${flow.decomposition_job_id}"]')?.click()`);
  const loadButton = await evaluate(`(() => {const e=document.querySelector('#history-detail [data-history-action="restore"][data-job-id="${flow.decomposition_job_id}"]');if(e){e.click();return true}return false})()`);
  if (!loadButton) throw new Error("Workflow history action missing: " + JSON.stringify(actions));
  await waitFor("document.querySelector('[data-ai-layer-id]')", "AI layers loaded");
  await evaluate("document.querySelector('[data-ai-layer-id]').click()");
  await waitFor("!document.getElementById('ai-compose').disabled", "layer selection ready");
  await click("ai-compose");
  await waitFor("document.getElementById('confirm-dialog').open", "compose confirmation");
  await click("confirm-accept");
  await waitFor("!document.getElementById('ai-rerun-vectorize').disabled", "composed PNG available", 20000);
  check("archived layers compose and vectorize using the real local worker");
  await click("ai-rerun-vectorize");
  await waitFor(`fetch('/api/v1/pipelines/${info.pipeline_id}').then(r=>r.json()).then(f=>f.branches.length===1 && f.branches[0].state==='succeeded')`, "local branch finished", 20000);
  const current = await evaluate(`fetch('/api/v1/pipelines/${info.pipeline_id}').then(r=>r.json())`);
  assert.equal(current.branches.length, 1); assert.equal(current.branches[0].kind, "vectorize");
  check("vector rerun creates a local branch without another cloud request");
  await waitFor("!document.getElementById('ai-rerun-compose').disabled", "local compose rerun ready");
  await click("ai-rerun-compose");
  await waitFor(`fetch('/api/v1/pipelines/${info.pipeline_id}').then(r=>r.json()).then(f=>f.branches.length===2 && f.branches[1].state==='succeeded')`, "composition branch finished", 20000);
  check("completed workflow supports composition rerun with archived layers");
  await waitFor("!document.getElementById('preview-apply').disabled", "branch preview ready");
  await click("preview-apply");
  await waitFor("document.querySelectorAll('#ai-branches button').length===2", "branches refreshed");
  await evaluate("document.querySelector('#ai-branches button').click()");
  await waitFor(`document.getElementById('ai-workflow-id').textContent.includes('pattern-extraction') && document.querySelectorAll('#ai-branches button').length===2`, "branch restored with original workflow");
  check("restoring a branch retains its original workflow and lineage");
  assert.equal(requests.filter(r => /seedream\/validations$/.test(r.path) && r.method === "POST").length, 0);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  check("no page exceptions or cloud-generation requests");
  await writeFile(path.join(output, "browser-checks.json"), JSON.stringify({ checks, providerRequests: 0, pageErrors: errors, screenshots: ["settings-desktop.png", "settings-mobile.png"] }, null, 2));
  await call("Browser.close", {}, false);
} finally {
  socket?.close();
  browser?.kill(); fixture?.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
  assert.equal(path.basename(temp).startsWith("pattern-a-browser-"), true);
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

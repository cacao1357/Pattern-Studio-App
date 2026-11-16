// Offline browser acceptance for visual SVG editing, persistence and overlay.
// Run: node scripts/validate_system_editing.mjs D:/CondaEnvs/pattern-studio/python.exe
// Uses a temporary API store and Chrome profile; all artifacts stay in ignored storage/.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = process.argv[2] || "D:/CondaEnvs/pattern-studio/python.exe";
const browserExecutable = process.env.PATTERN_STUDIO_TEST_BROWSER || process.env.PATTERN_STUDIO_TEST_EDGE ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const temp = await mkdtemp(path.join(tmpdir(), "pattern-system-editing-"));
const profile = path.join(temp, "profile");
const output = path.join(root, "storage", "validation", "system-improvements-20261116");
const checks = [];
let fixture, browser, socket, sessionId;
const errors = [];
const requests = [];
const pending = new Map();
let nextId = 0;

function firstLine(child, stream, matcher, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`Process startup timed out: ${buffer.slice(-1500)}`)), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      if (code) { clearTimeout(timer); reject(new Error(`Process exited before readiness (${code}): ${buffer.slice(-1500)}`)); }
    });
    child[stream].on("data", (data) => {
      buffer = (buffer + data).slice(-32768);
      const match = buffer.match(matcher);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
}

function cleanChildEnvironment(extra = {}) {
  const allowed = ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
    "CONDA_PREFIX", "CONDA_DEFAULT_ENV"];
  const env = {};
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...extra };
}

async function stopOwnedBrowser() {
  browser?.kill();
  if (process.platform !== "win32") return;
  // Match only the unique profile created by this run; never close the user's browser.
  const command = "$profile = [IO.Path]::GetFullPath($env:PATTERN_SYSTEM_EDITING_PROFILE); " +
    "if ([IO.Path]::GetFileName($profile) -ne 'profile' -or " +
    "-not [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($profile)).StartsWith('pattern-system-editing-')) { exit 2 }; " +
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | " +
    "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) } | " +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }";
  await new Promise((resolve) => {
    const cleanup = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
      stdio: "ignore",
      env: cleanChildEnvironment({ PATTERN_SYSTEM_EDITING_PROFILE: profile }),
    });
    const timer = setTimeout(() => { cleanup.kill(); resolve(); }, 8000);
    cleanup.once("error", () => { clearTimeout(timer); resolve(); });
    cleanup.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

function cdpCall(method, params = {}, page = true) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(page && sessionId ? { sessionId } : {}) }));
  });
}

async function evaluate(expression) {
  const result = await cdpCall("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`Page evaluation failed: ${result.exceptionDetails.text}`);
  return result.result.value;
}

async function waitFor(expression, label, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diagnostic = await evaluate(`({hash:location.hash,stage:document.querySelector('.wb')?.dataset.stage,
    asset:document.querySelector('.wb-doc__id')?.textContent,editor:document.querySelector('[data-svg-editor]')?.textContent,
    elements:[...document.querySelectorAll('[data-svg-element]')].map(e=>({id:e.dataset.svgElement,transform:e.getAttribute('transform')})),
    pointerTrace:window.__svgPointerTrace,
    errors:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent)})`);
  await screenshot("system-editing-failure.png");
  throw new Error(`UI timeout: ${label} ${JSON.stringify({ diagnostic, errors, requests: requests.slice(-20) })}`);
}

async function clickAt(x, y) {
  await cdpCall("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdpCall("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdpCall("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function dragAt(x, y, dx, dy) {
  await cdpCall("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdpCall("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdpCall("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + dx, y: y + dy, button: "left", buttons: 1 });
  await cdpCall("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y: y + dy, button: "left", clickCount: 1 });
}

async function screenshot(name) {
  const shot = await cdpCall("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(path.join(output, name), Buffer.from(shot.data, "base64"));
}

function check(label) {
  checks.push(label);
  console.log(`PASS ${label}`);
}

try {
  await mkdir(output, { recursive: true });
  fixture = spawn(python, ["-B", "backend/tests/browser_fixture_system.py", temp], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: cleanChildEnvironment(),
  });
  const info = JSON.parse(await firstLine(fixture, "stdout", /FIXTURE (\{[^\r\n]+\})/));
  assert.equal(info.provider_call_count, 0);
  assert.equal(info.raster_roundtrip_samples.length, 3);
  console.log("READY isolated API and local SVG fixtures");

  browser = spawn(browserExecutable, ["--headless=new", "--disable-gpu", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-sync", "--no-proxy-server", "about:blank"], {
    cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: cleanChildEnvironment(),
  });
  const browserWs = await firstLine(browser, "stderr", /DevTools listening on (ws:\/\/[^\s]+)/, 30000);
  socket = new WebSocket(browserWs);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const ticket = pending.get(data.id); pending.delete(data.id); clearTimeout(ticket.timer);
      data.error ? ticket.reject(new Error(data.error.message)) : ticket.resolve(data.result);
    } else if (data.method === "Runtime.exceptionThrown") {
      errors.push(data.params.exceptionDetails.text);
    } else if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") {
      errors.push(data.params.args?.map((item) => item.value || item.description || "").join(" ") || "console.error");
    } else if (data.method === "Network.requestWillBeSent") {
      const request = data.params.request;
      requests.push({ method: request.method, url: request.url, path: new URL(request.url).pathname });
    }
  });

  const target = await cdpCall("Target.createTarget", { url: "about:blank" }, false);
  sessionId = (await cdpCall("Target.attachToTarget", { targetId: target.targetId, flatten: true }, false)).sessionId;
  await cdpCall("Runtime.enable"); await cdpCall("Page.enable"); await cdpCall("Network.enable");
  await cdpCall("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  const hash = new URLSearchParams({ image: info.image_id, asset: info.svg_asset_id, stage: "7", v: "2" });
  await cdpCall("Page.navigate", { url: `${info.url}/#/workbench?${hash}` });
  await waitFor(`document.querySelector('.wb')?.dataset.stage==='vector' &&
    import('/js/store.js').then(m=>m.store.session.currentAssetId===${JSON.stringify(info.svg_asset_id)})`, "synthetic SVG editor opens");
  await waitFor("document.querySelectorAll('[data-svg-element]').length===2", "one compound path exposes two visual elements");
  const initialEditor = await evaluate(`({ids:[...document.querySelectorAll('[data-svg-element]')].map(e=>e.dataset.svgElement),
    fills:[...document.querySelectorAll('[data-svg-element]')].map(e=>e.getAttribute('fill-rule')),
    source:document.querySelector('[data-compare-mode]')?.dataset.compareMode||''})`);
  assert.equal(initialEditor.ids.length, 2);
  assert.ok(initialEditor.ids.some((id) => id.endsWith("c0")) && initialEditor.ids.some((id) => id.endsWith("c1")));
  assert.ok(initialEditor.fills.every((rule) => rule === "evenodd"));
  await screenshot("system-editing-initial.png");
  check("one source path with a hole and two disjoint shapes loads as two separate editable visual elements");

  // Render the original SVG and a fresh safe SVG rebuilt solely from GET
  // /svg-elements fields. Exact equality in Chromium checks path, fill-rule,
  // holes, stacking and transforms without relying on an SVG library in Node.
  const roundTrips = await evaluate(`(async(samples)=>{
    const editor=await import('/js/svg-edit.js');
    const escapeXml=(value)=>String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
    const load=async(blob)=>{const url=URL.createObjectURL(blob);try{const image=new Image();image.src=url;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
      return {width:canvas.width,height:canvas.height,pixels:context.getImageData(0,0,canvas.width,canvas.height).data};
    }finally{URL.revokeObjectURL(url)}};
    const output=[];
    for(const sample of samples){
      const [svgResponse,elementsResponse]=await Promise.all([
        fetch('/api/v1/assets/'+sample.svg_asset_id+'/preview'),
        fetch('/api/v1/assets/'+sample.svg_asset_id+'/svg-elements')]);
      if(!svgResponse.ok||!elementsResponse.ok)throw new Error('SVG fixture read failed for '+sample.name);
      const originalBlob=await svgResponse.blob(),payload=await elementsResponse.json();
      const root=document.createElementNS('http://www.w3.org/2000/svg','svg');
      root.setAttribute('width',String(payload.width));root.setAttribute('height',String(payload.height));
      root.setAttribute('viewBox','0 0 '+payload.width+' '+payload.height);
      root.innerHTML=editor.mergedDrawMarkup(editor.createSvgDraft(editor.parseSvgElements(payload)));
      const rebuilt=new Blob([new XMLSerializer().serializeToString(root)],{type:'image/svg+xml'});
      const [a,b]=await Promise.all([load(originalBlob),load(rebuilt)]);
      if(a.width!==b.width||a.height!==b.height)throw new Error('SVG dimensions changed: '+sample.name);
      let mismatch=0,maxDelta=0;const first=[];
      for(let i=0;i<a.pixels.length;i++){const delta=Math.abs(a.pixels[i]-b.pixels[i]);if(delta){mismatch++;maxDelta=Math.max(maxDelta,delta);if(first.length<8)first.push({channel:i,source:a.pixels[i],rebuilt:b.pixels[i]});}}
      output.push({name:sample.name,width:a.width,height:a.height,elements:payload.elements.length,
        source_sha256:payload.source_sha256,mismatch_channels:mismatch,max_channel_delta:maxDelta,first_mismatches:first});
    }
    return output;
  })(${JSON.stringify(info.raster_roundtrip_samples)})`);
  assert.equal(roundTrips.length, 3);
  for (const result of roundTrips) assert.equal(result.mismatch_channels, 0, `${result.name} SVG roundtrip pixels differ: ${JSON.stringify(result)}`);
  check("three delivered electronic GT alpha vectors render pixel-identically after GET svg-elements reconstruction in Chrome");

  const initialSvg = await evaluate(`fetch('/api/v1/assets/'+${JSON.stringify(info.svg_asset_id)}+'/preview').then(r=>r.text())`);
  const initialElements = await evaluate("[...document.querySelectorAll('[data-svg-element]')].map(e=>({id:e.dataset.svgElement,transform:e.getAttribute('transform')}))");
  const primaryId = initialElements.find((entry) => entry.id.endsWith("c0")).id;
  const secondaryId = initialElements.find((entry) => entry.id.endsWith("c1")).id;
  const componentPoint = async (id) => evaluate(`(()=>{const svg=document.querySelector('[data-svg-surface]');
    const shape=svg.querySelector('[data-svg-element="${id}"]');if(!shape)throw new Error('Missing SVG shape '+${JSON.stringify(id)});
    const box=shape.getBBox();const point=new DOMPoint(box.x+3,box.y+3).matrixTransform(svg.getScreenCTM());
    return {x:point.x,y:point.y}})()`);
  const primaryPoint = await componentPoint(primaryId);
  await clickAt(primaryPoint.x, primaryPoint.y);
  await waitFor(`document.querySelectorAll('[data-svg-element].is-selected').length===1 &&
    document.querySelector('[data-svg-live]')?.textContent.includes('已选 1')`, "select one visual component");
  assert.equal(await evaluate("document.querySelectorAll('[data-svg-element].is-selected').length"), 1);
  check("pointer selection isolates exactly one visual component in a compound path");

  const holePoint=await evaluate(`(()=>{const shape=document.querySelector('[data-svg-element="${primaryId}"]');
    const box=shape.getBBox();const point=new DOMPoint(box.x+box.width/2,box.y+box.height/2).matrixTransform(shape.getScreenCTM());
    return {x:point.x,y:point.y}})()`);
  await clickAt(holePoint.x,holePoint.y);
  await waitFor("document.querySelectorAll('[data-svg-element].is-selected').length===0", "hole is empty hit space");
  const reselect=await componentPoint(primaryId);
  await clickAt(reselect.x,reselect.y);
  await waitFor("document.querySelectorAll('[data-svg-element].is-selected').length===1", "reselect the filled part of the ring");
  check("clicking the evenodd hole clears selection instead of selecting the enclosing figure");

  const movedFrom = await evaluate(`document.querySelector('[data-svg-element="${primaryId}"]').getAttribute('transform')||''`);
  await evaluate(`(()=>{window.__svgPointerTrace=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])document.addEventListener(type,e=>{window.__svgPointerTrace.push({type,x:e.clientX,y:e.clientY,target:e.target?.tagName,id:e.target?.getAttribute?.('data-svg-element'),surface:!!e.target?.closest?.('[data-svg-surface]')});},true);})()`);
  const dragPoint=await componentPoint(primaryId);
  await dragAt(dragPoint.x, dragPoint.y, 18, 11);
  await waitFor(`(document.querySelector('[data-svg-element="${primaryId}"]')?.getAttribute('transform')||'')!==${JSON.stringify(movedFrom)} &&
    document.querySelector('[data-svg-act="undo"]')?.disabled===false`, "drag selected SVG element");
  const movedTo = await evaluate(`document.querySelector('[data-svg-element="${primaryId}"]').getAttribute('transform')||''`);
  const otherAfterMove = await evaluate(`document.querySelector('[data-svg-element="${secondaryId}"]').getAttribute('transform')||''`);
  assert.notEqual(movedTo, movedFrom);
  assert.equal(otherAfterMove, initialElements.find((entry) => entry.id === secondaryId).transform);
  check("drag moves the selected visual component while leaving its neighboring component fixed");

  await evaluate("document.querySelector('[data-svg-act=undo]').click()");
  await waitFor(`(document.querySelector('[data-svg-element="${primaryId}"]')?.getAttribute('transform')||'')===${JSON.stringify(movedFrom)}`,
    "undo selected component move");
  await evaluate("document.querySelector('[data-svg-act=redo]').click()");
  await waitFor(`(document.querySelector('[data-svg-element="${primaryId}"]')?.getAttribute('transform')||'')===${JSON.stringify(movedTo)}`,
    "redo selected component move");
  check("undo and redo restore the selected component's movement");

  const secondaryPoint = await componentPoint(secondaryId);
  await clickAt(secondaryPoint.x, secondaryPoint.y);
  await waitFor(`document.querySelector('[data-svg-element="${secondaryId}"]')?.classList.contains('is-selected')`, "select second component");
  await evaluate("(document.querySelector('[data-svg-act=delete-selected]')||document.querySelector('[data-svg-act=delete]')).click()");
  await waitFor(`!document.querySelector('[data-svg-element="${secondaryId}"]') && document.querySelectorAll('[data-svg-element]').length===1`,
    "delete only selected component");
  await evaluate("document.querySelector('[data-svg-act=undo]').click()");
  await waitFor("document.querySelectorAll('[data-svg-element]').length===2", "undo component deletion");
  await evaluate("document.querySelector('[data-svg-act=redo]').click()");
  await waitFor(`!document.querySelector('[data-svg-element="${secondaryId}"]') && document.querySelectorAll('[data-svg-element]').length===1`,
    "redo component deletion");
  check("delete, undo and redo affect only the chosen visual component");
  await screenshot("system-editing-before-save.png");

  await evaluate("document.querySelector('[data-svg-act=save]').click()");
  await waitFor(`import('/js/store.js').then(m=>m.store.session.currentAssetId!==${JSON.stringify(info.svg_asset_id)} &&
    m.store.currentAsset()?.kind==='svg' && !m.store.session.activeJob)`, "publish saved SVG version", 30000);
  const saved = await evaluate(`import('/js/store.js').then(m=>{const a=m.store.currentAsset();return {
    asset_id:a.asset_id,kind:a.kind,image_id:a.image_id,source_asset_id:a.source_asset_id,parents:a.parents,
    manual_geometry_edit:a.manual_geometry_edit,geometry_verified:a.geometry_verified}})`);
  assert.notEqual(saved.asset_id, info.svg_asset_id);
  assert.equal(saved.kind, "svg");
  const originalAfterSave = await evaluate(`fetch('/api/v1/assets/'+${JSON.stringify(info.svg_asset_id)}+'/preview').then(r=>r.text())`);
  assert.equal(originalAfterSave, initialSvg, "saved editing must leave the input SVG immutable");
  const newElements = await evaluate(`fetch('/api/v1/assets/'+${JSON.stringify(saved.asset_id)}+'/svg-elements').then(r=>r.json())`);
  assert.equal(newElements.elements.length, 1);
  assert.equal(newElements.elements[0].fill_rule, "evenodd", "the retained ring must keep its hole fill rule");
  assert.match(newElements.elements[0].d, /M/i);
  assert.ok((saved.parents || []).some((parent) => parent.role === "svg_edit_source" && parent.asset_id === info.svg_asset_id));
  check("save publishes a traceable new SVG version, keeps the original unchanged and preserves the ring hole");

  // Reload by the saved asset deep link, proving that persisted output can be
  // reopened after the in-memory editor draft has been discarded.
  const savedHash = new URLSearchParams({ image: info.image_id, asset: saved.asset_id, stage: "7", v: "2" });
  await cdpCall("Page.navigate", { url: `${info.url}/#/workbench?${savedHash}` });
  await waitFor(`document.querySelector('[data-svg-surface]') &&
    import('/js/store.js').then(m=>m.store.session.currentAssetId===${JSON.stringify(saved.asset_id)}) &&
    document.querySelectorAll('[data-svg-element]').length===1`, "reopen saved version from a fresh route");
  await evaluate("window.__beforeSavedReload=true");
  await cdpCall("Page.reload", { ignoreCache: true });
  await waitFor(`(async()=>{if(window.__beforeSavedReload || document.readyState!=='complete')return false;
    const {store}=await import('/js/store.js');
    return store.session.currentAssetId===${JSON.stringify(saved.asset_id)} &&
      !!document.querySelector('[data-svg-surface]') && document.querySelectorAll('[data-svg-element]').length===1;})()`,
    "saved version survives page refresh", 30000);
  check("saved SVG reloads from its asset link after a full browser refresh");

  await evaluate("document.querySelector('[data-act=compare]').click()");
  await waitFor("document.querySelector('[data-act=compare-mode][data-val=overlay]')?.disabled===false", "overlay compare is available");
  await evaluate("document.querySelector('[data-act=compare-mode][data-val=overlay]').click()");
  await waitFor(`document.querySelector('[data-compare][data-compare-mode=overlay]') &&
    document.querySelector('.wb-compare__overlay')?.complete && document.querySelector('.wb-compare__img')?.complete`,
    "same-coordinate SVG overlay loads");
  const zoomRects = [];
  for (const value of ["fit", "1", "2"]) {
    await evaluate(`document.querySelector('[data-act=zoom][data-val="${value}"]').click()`);
    await waitFor(`document.querySelector('[data-live=zoom]')?.textContent===${JSON.stringify(value === "fit" ? "适应" : value === "1" ? "100%" : "200%")}`,
      `zoom ${value}`);
    const rect = await evaluate(`(()=>{const a=document.querySelector('.wb-compare__img').getBoundingClientRect();
      const b=document.querySelector('.wb-compare__overlay').getBoundingClientRect();
      return {current:{left:a.left,top:a.top,width:a.width,height:a.height},overlay:{left:b.left,top:b.top,width:b.width,height:b.height}}})()`);
    for (const key of ["left", "top", "width", "height"]) assert.ok(Math.abs(rect.current[key] - rect.overlay[key]) < 0.5, `overlay ${key} must share zoom ${value}`);
    zoomRects.push({ mode: value, current: rect.current, overlay: rect.overlay });
  }
  await screenshot("system-editing-overlay-200.png");
  check("transparent overlay shares the current SVG's canvas box at fit, 100% and 200% zoom");

  const external = requests.filter((request) => {
    const url = new URL(request.url);
    return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && url.origin !== info.url;
  });
  assert.deepEqual(external, [], "browser must not contact external services");
  const forbiddenPosts = requests.filter((request) => request.method === "POST" &&
    /\/api\/v1\/(?:pipelines\/ai|jobs\/(?:repair|cloud-lineart|decompose-layers))$/.test(request.path));
  assert.deepEqual(forbiddenPosts, [], "test must not submit repair or cloud-generation jobs");
  const providerCallCount = await evaluate("fetch('/api/v1/seedream/status').then(r=>r.json()).then(s=>s.budget.call_count)");
  assert.equal(providerCallCount, 0);
  assert.deepEqual(errors, [], `browser console/page errors: ${JSON.stringify(errors)}`);
  check("no browser errors, external network traffic, repair jobs or provider calls");

  const report = { checks, synthetic: { width: info.width, height: info.height, visualComponents: 2, holes: 1 },
    raster_roundtrip: roundTrips, zoomRects, browserErrors: errors.length,
    externalRequests: external.length, forbiddenPosts: forbiddenPosts.length, providerCallCount };
  await writeFile(path.join(output, "system-editing-browser-checks.json"), JSON.stringify(report, null, 2), "utf8");
  await cdpCall("Browser.close", {}, false);
} finally {
  socket?.close();
  fixture?.kill();
  await stopOwnedBrowser();
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
  assert.equal(path.basename(temp).startsWith("pattern-system-editing-"), true);
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

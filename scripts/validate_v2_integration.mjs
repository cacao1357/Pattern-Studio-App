// New workbench integration smoke: isolated data, real local worker, no cloud calls.
// Run: node scripts/validate_v2_integration.mjs D:/CondaEnvs/pattern-studio/python.exe
// --pages-only checks all pages plus layout; --layout-only checks responsive assets and drawer.
// --entry-only checks workbench resume and starting fresh without deleting library versions.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = process.argv[2] || "D:/CondaEnvs/pattern-studio/python.exe";
const browserExecutable = process.env.PATTERN_STUDIO_TEST_BROWSER || process.env.PATTERN_STUDIO_TEST_EDGE || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const temp = await mkdtemp(path.join(tmpdir(), "pattern-v2-browser-"));
const output = path.join(root, "storage", "validation", "v2-reliability");
const checks = [];
const archiveOnly = process.argv.includes("--archive-only");
const sessionOnly = process.argv.includes("--session-only");
const layoutOnly = process.argv.includes("--layout-only");
const batchOnly = process.argv.includes("--batch-only");
const entryOnly = process.argv.includes("--entry-only");
const pagesOnly = batchOnly || layoutOnly || process.argv.includes("--pages-only");
let fixture, browser, socket;

function firstLine(child, stream, matcher) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Fixture/browser startup timed out: " + buffer.slice(-1000))), 20000);
    child.once("error", reject);
    child.once("exit", (code) => { if (code) reject(new Error("Fixture/browser exited: " + code)); });
    child[stream].on("data", (data) => {
      buffer = (buffer + data).slice(-32768);
      const match = buffer.match(matcher);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
}

async function stopOwnedBrowser() {
  browser?.kill();
  if (process.platform !== "win32") return;
  // Windows launchers can exit while their browser process remains alive.
  // Match only this run's unique profile; never close the user's browser.
  const command = "$testProfilePath = [IO.Path]::GetFullPath($env:PATTERN_STUDIO_TEST_PROFILE); " +
    "if ([IO.Path]::GetFileName($testProfilePath) -ne 'edge' -or -not [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($testProfilePath)).StartsWith('pattern-v2-browser-')) { exit 2 }; " +
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | " +
    "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($testProfilePath) } | " +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }";
  await new Promise((resolve) => {
    const cleanup = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true, stdio: "ignore",
      env: { ...process.env, PATTERN_STUDIO_TEST_PROFILE: path.join(temp, "edge") },
    });
    const timer = setTimeout(() => { cleanup.kill(); resolve(); }, 8000);
    cleanup.once("error", () => { clearTimeout(timer); resolve(); });
    cleanup.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

try {
  fixture = spawn(python, ["-B", "backend/tests/browser_fixture_a.py", temp], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const info = JSON.parse(await firstLine(fixture, "stdout", /FIXTURE (\{[^\r\n]+\})/));
  await mkdir(output, { recursive: true });
  console.log("READY isolated API fixture");
  browser = spawn(browserExecutable, ["--headless=new", "--disable-gpu", "--remote-debugging-port=0", "--user-data-dir=" + path.join(temp, "edge"),
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "about:blank"],
    { cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await firstLine(browser, "stderr", /DevTools listening on (ws:\/\/[^\s]+)/);
  console.log("READY isolated browser");
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
      const details = data.params.exceptionDetails;
      errors.push(details.exception?.description || details.text);
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
    const diagnostic = await evaluate("({stage:document.querySelector('.wb')?.dataset.stage,error:document.querySelector('.wb-error')?.textContent,notice:document.querySelector('.wb-note')?.textContent,layers:[...document.querySelectorAll('[data-act=layer]')].map(e=>({id:e.dataset.id,on:e.getAttribute('aria-pressed')})),compose:document.querySelector('[data-act=compose-layers]')?.outerHTML})");
    const batchDiagnostic = batchOnly ? await evaluate("({error:document.querySelector('.pf-error')?.textContent,run:document.querySelector('.pf-run')?.innerText?.slice(-1400)})") : undefined;
    const route = await evaluate("({hash: location.hash, stage: document.querySelector('.wb')?.dataset.stage, entry: Boolean(document.querySelector('.wb-entry'))})");
    throw new Error("UI timeout: " + label + " " + JSON.stringify({ route, diagnostic, batchDiagnostic, errors, requests: requests.slice(-12) }));
  };
  const check = (label) => { checks.push(label); console.log("PASS " + label); };
  const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const fill = (id, value, event = "input") => evaluate(`(() => {const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);


  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  if (entryOnly) {
    const reload = async () => {
      const before = await evaluate("performance.timeOrigin");
      await call("Page.reload");
      await waitFor(`performance.timeOrigin !== ${before}`, "new document after reload");
    };
    const url = info.url + "/#/workbench?asset=" + info.input_asset_id + "&stage=3&v=2";
    await call("Page.navigate", { url });
    const currentStage = "document.querySelector('.wb')?.dataset.stage === 'repair'";
    await waitFor(currentStage, "direct link opens without a prompt");
    const group = await evaluate(`fetch('/api/v1/patterns').then(r=>r.json()).then(p=>p.items[0])`);
    assert.ok(group.assets.length > 2);
    const added = await evaluate(`import('/js/api.js').then(({api})=>api.addWorkbenchItems([${JSON.stringify(group.image_id)}]))`);
    assert.deepEqual(added.added, [group.image_id]);
    await reload();
    await waitFor("Boolean(document.querySelector('[data-entry=continue]'))", "resume prompt after reload");
    await evaluate("document.querySelector('[data-entry=continue]').click()");
    await waitFor(currentStage, "resume prior stage");
    await waitFor(`import('/js/store.js').then(m=>m.store.session.currentAssetId===${JSON.stringify(info.input_asset_id)})`, "resume prior asset");

    await evaluate("location.hash='#/library'");
    await waitFor("document.querySelector('[data-act=assign]')", "library route");
    await reload();
    await waitFor("document.querySelector('[data-act=assign]')", "library reload");
    await evaluate("location.hash='#/workbench'");
    await waitFor("Boolean(document.querySelector('[data-entry=new]'))", "prompt on workbench navigation");
    await evaluate("document.querySelector('[data-entry=continue]').click()");
    await waitFor(currentStage, "resume prior stage from generic entry");
    await evaluate("location.hash='#/library'");
    await waitFor("document.querySelector('[data-act=assign]')", "library route after resume");
    await evaluate("location.hash='#/workbench'");
    await waitFor("Boolean(document.querySelector('[data-entry=new]'))", "prompt on return to workbench");
    await evaluate(`(() => {
      const fetch = window.fetch;
      window.fetch = (...args) => {
        if (!String(args[0]).endsWith('/workbench/items/all')) return fetch(...args);
        window.fetch = fetch;
        return Promise.resolve(Response.json({error: {code: 'SERVICE_ERROR'}}, {status: 500}));
      };
      document.querySelector('[data-entry=new]').click();
    })()`);
    await waitFor("document.querySelector('[data-entry=new]')?.disabled === false && document.querySelector('#toasts').textContent.includes('无法清空工作台')", "failed clear keeps the entry choice");
    assert.equal(await evaluate("fetch('/api/v1/workbench/items').then(r=>r.json()).then(p=>p.items.length)"), 1);
    await evaluate("document.querySelector('[data-entry=new]').click()");
    await waitFor("document.querySelector('.wb') && !document.querySelector('[data-pattern]')", "fresh workbench is empty");
    assert.equal(await evaluate("fetch('/api/v1/workbench/items').then(r=>r.json()).then(p=>p.items.length)"), 0);
    const saved = await evaluate(`fetch('/api/v1/patterns/${group.image_id}').then(r=>r.json())`);
    assert.deepEqual(saved.assets.map(a=>a.asset_id), group.assets.map(a=>a.asset_id));
    await reload();
    await waitFor("document.querySelector('.wb') && !document.querySelector('[data-pattern]')", "empty workbench opens directly after reload");
    for (const width of [1440, 390]) {
      await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      const actions = await evaluate(`(() => {
        const count = selector => [...document.querySelectorAll(selector)].filter(button =>
          !button.disabled && !button.closest('[hidden]') && button.getClientRects().length
        ).length;
        return {
          upload: count('[data-action="upload"], [data-act="upload"]'),
          fromLibrary: count('[data-act="workbench-picker"]'),
          batchImport: count('[data-act="batch-import"]'),
        };
      })()`);
      assert.deepEqual(actions, { upload: 1, fromLibrary: 1, batchImport: 1 }, "distinct import actions at " + width + "px");
    }
    check("empty workbench exposes one action for uploading, picking from the library and importing multiple files at both widths");
    await evaluate(`location.hash='#/workbench?image=${group.image_id}&asset=${info.input_asset_id}&stage=3&v=2'`);
    await waitFor(currentStage, "saved pattern can be opened again");
    assert.equal(errors.length, 0, JSON.stringify(errors));
    check("workbench prompts on return and reload, restores the asset and stage, and keeps every library version after starting fresh");
    await waitFor(`import('/js/store.js').then(({store})=>store.session.currentAssetId===${JSON.stringify(info.input_asset_id)})`, "original session restored");
    const latestImage = await evaluate(`(async () => {
      const {api} = await import('/js/api.js');
      const {store} = await import('/js/store.js');
      const canvas = document.createElement('canvas');
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const other = await api.uploadImage(new File([blob], 'newer-library-pattern.png', {type:'image/png'}));
      await store.loadRecent();
      return [other.image_id, store.recentAssets[0]?.image_id];
    })()`);
    assert.ok(latestImage[0] && latestImage[0] !== group.image_id);
    assert.equal(latestImage[1], latestImage[0]);
    await evaluate("location.hash='#/library'");
    const editSource = `[data-act="pattern-meta"][data-image="${group.image_id}"]`;
    await waitFor(`document.querySelector(${JSON.stringify(editSource)})`, "active pattern in library");
    await evaluate(`document.querySelector(${JSON.stringify(editSource)}).click()`);
    await fill("pm-source-name", "修复工序资料回归");
    await evaluate("document.querySelector('[data-pm-save]').click()");
    await waitFor("!document.querySelector('[data-pm-save]') && document.querySelector('.lb-page').textContent.includes('修复工序资料回归')", "updated source in library");
    await waitFor("import('/js/store.js').then(({store})=>store.session.image?.meta?.source_name==='修复工序资料回归')", "library edit updates the open document");
    await evaluate("location.hash='#/home'");
    await waitFor("document.querySelector('[data-resume]')", "home resume available");
    await evaluate("document.querySelector('[data-resume]').click()");
    await waitFor("document.querySelector('.wb')", "home resume opens workbench");
    const resumed = await evaluate(`import('/js/store.js').then(({store})=>({
      asset:store.session.currentAssetId, stage:document.querySelector('.wb').dataset.stage,
      drawer:!!document.querySelector('#drawer')
    }))`);
    assert.deepEqual(resumed, {asset:info.input_asset_id, stage:"repair", drawer:false});
    assert.equal(await evaluate("document.querySelector('.wb-doc__name').textContent"), "修复工序资料回归");
    check("home resumes the active version and stage after a different pattern enters the library");
    const attempts = await evaluate(`(async () => {
      const {store} = await import('/js/store.js');
      store.datasetLoadedAt = 0;
      const originalFetch = window.fetch;
      let count = 0;
      window.fetch = (...args) => {
        if (String(args[0]).includes('/datasets/audit') && ++count <= 4) {
          return Promise.resolve(Response.json({}, {status:503}));
        }
        return originalFetch(...args);
      };
      try {
        location.hash = '#/home';
        await new Promise(resolve => setTimeout(resolve, 850));
        return count;
      } finally {
        window.fetch = originalFetch;
      }
    })()`);
    assert.equal(attempts, 1, "one failed home data request must not trigger a render/reload loop");
    await evaluate("location.hash='#/library'");
    const openGroup = `[data-act="pattern-workbench"][data-image="${group.image_id}"]`;
    await waitFor(`document.querySelector(${JSON.stringify(openGroup)})`, "library navigation after home data error");
    await evaluate(`(() => {
      const originalFetch = window.fetch;
      window.fetch = (...args) => {
        if (!String(args[0]).endsWith('/workbench/items') || args[1]?.method !== 'POST') return originalFetch(...args);
        window.fetch = originalFetch;
        return Promise.resolve(Response.json({error:{code:'WORKBENCH_LIMIT'}}, {status:409}));
      };
      document.querySelector(${JSON.stringify(openGroup)}).click();
    })()`);
    await waitFor("document.querySelector('.wb') && document.querySelector('#toasts').textContent.includes('500')", "library opens with a visible warning when membership fails");
    await evaluate("location.hash='#/home'");
    await waitFor("import('/js/store.js').then(({store})=>store.datasetLoadedAt>0)", "home data recovers on next visit");
    check("home recovers after a failed request and library membership errors remain visible");
    assert.equal(errors.length, 0, JSON.stringify(errors));
    await call("Browser.close",{},false);
  } else {
  if (batchOnly) {
    await call("Page.navigate", { url: info.url + "/#/workbench?asset=" + info.input_asset_id + "&stage=1&v=2" });
    await waitFor("Boolean(document.querySelector('[data-act=batch-import]'))", "batch workbench entry");
    const imported = await evaluate(`(async()=>{
      const {importFiles}=await import('/js/batch.js');
      const {app}=await import('/js/app.js');
      const files=[];
      for(let i=0;i<3;i++){
        const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
        const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,64,64);
        c.strokeStyle='black';c.lineWidth=4;c.strokeRect(8,8,45,45);
        const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));
        files.push(new File([blob],'batch-smoke-'+i+'-'+'a'.repeat(80)+'.png',{type:'image/png',lastModified:100+i}));
      }
      files.push(new File(['invalid'],'unsupported.txt',{type:'text/plain'}));
      return importFiles(files,{onChange:()=>app.render()});
    })()`);
    assert.equal(imported.done, 3);
    assert.equal(imported.skipped, 1);
    await waitFor("document.querySelectorAll('[data-pattern]').length>=4", "separate original groups");
    const groupIds = await evaluate("[...document.querySelectorAll('[data-pattern]')].map(e=>e.dataset.pattern)");
    assert.equal(new Set(groupIds).size, groupIds.length);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.wb-steps'),'::before').content"), "none");
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.wb-step')).backgroundColor"), "rgba(0, 0, 0, 0)");
    check("batch import preserves three originals, reports unsupported file and renders separate pattern groups");
    await evaluate("[...document.querySelectorAll('[data-pattern]')].find(e=>e.textContent.includes('batch-smoke-0')).querySelector('[data-act=pattern-open]').click()");
    await waitFor("document.querySelector('.wb-doc__name')?.textContent.includes('batch-smoke-0') && document.querySelector('.bp-dupes__list li')", "long document and duplicate names");
    await writeFile(path.join(output,"batch-workbench.png"),Buffer.from((await call("Page.captureScreenshot",{format:"png"})).data,"base64"));

    const batchLayoutFailures = [];
    for (const [width,height] of [[1440,900],[1080,720],[390,844]]) {
      await call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:width<820});
      await new Promise(r=>setTimeout(r,200));
      const overflowingNames=await evaluate(`(() => {
        const fields = [...document.querySelectorAll('.wb-doc__name,.bp-dupes__list li span')];
        return fields.filter(el => {
          const box = el.getBoundingClientRect();
          if (!box.width) return false;
          const panel = el.closest('.wb-doc,.bp-import').getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(el);
          const visibleTextEnd = getComputedStyle(el).overflowX === 'visible'
            ? range.getBoundingClientRect().right : box.right;
          return box.left < panel.left - 1 || Math.max(box.right, visibleTextEnd) > panel.right + 1;
        }).map(el => el.textContent);
      })()`);
      assert.deepEqual(overflowingNames, [], 'long document and duplicate names fit their panels at '+width);
      const geometry=await evaluate(`(()=>{
        const scroller=document.querySelector('.wb-groups');
        const first=scroller.querySelector('[data-pattern]');
        const copies=Array.from({length:25},()=>first.cloneNode(true));scroller.append(...copies);
        scroller.scrollTop=scroller.scrollHeight;
        const result={vertical:document.documentElement.scrollHeight>innerHeight+1,
          horizontal:document.documentElement.scrollWidth>innerWidth+1,scrolls:scroller.scrollTop>0};
        copies.forEach(e=>e.remove());scroller.scrollTop=0;return result;
      })()`);
      if (geometry.vertical || geometry.horizontal || !geometry.scrolls) batchLayoutFailures.push({width,height,...geometry});
    }
    await call("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    if (!batchLayoutFailures.length) check("pattern column scrolls internally while the page remains fixed at desktop and mobile sizes");

    await evaluate("document.querySelector('[data-act=open-export]').click()");
    await waitFor("Boolean(document.querySelector('[data-bx-all]'))", "export modal");
    await evaluate("document.querySelector('[data-bx-none]').click();document.querySelector('[data-bx-kind=original]').click()");
    const exportChoice = await evaluate("import('/js/views/batch-export.js').then(m=>m.exportModalSnapshot())");
    assert.equal(exportChoice.stats.count, groupIds.length);
    await evaluate("document.querySelector('[data-bx-zoom]').click()");
    await waitFor("Boolean(document.querySelector('[data-bx-zoom-close]'))", "export enlarged preview");
    await evaluate("document.querySelector('[data-bx-zoom-close]').click();document.querySelector('[data-bx-submit]').click()");
    await waitFor("Boolean(document.querySelector('[data-bx-download]'))", "real batch ZIP",30000);
    assert.ok(await evaluate("fetch(document.querySelector('[data-bx-download]').href).then(async r=>r.ok&&(await r.blob()).size>0)"));
    await writeFile(path.join(output,"batch-export.png"),Buffer.from((await call("Page.captureScreenshot",{format:"png"})).data,"base64"));
    await evaluate("document.querySelector('[data-bx-close]').click()");
    check("export modal selects a common processing type, enlarges thumbnails and produces a real ZIP");

    await evaluate("location.hash='#/library'");
    await waitFor("document.querySelector('[data-act=assign]') && document.querySelector('[data-act=process-batch]')", "grouped library");
    for (const name of ["批量验收","多重归类"]) {
      await evaluate("document.querySelector('[data-act=cat-new]').click()");
      await fill("lb-cat-input",name);
      await evaluate("document.querySelector('[data-act=cat-save]').click()");
      await waitFor(`document.querySelector('[data-act=cat-filter]') && document.querySelector('.lb-cats').textContent.includes(${JSON.stringify(name)})`, "create category "+name);
    }
    await evaluate("document.querySelector('[data-act=assign]').click()");
    await waitFor("document.querySelectorAll('[data-assign]').length===2", "many-to-many category assignment");
    await evaluate("document.querySelectorAll('[data-assign]').forEach(e=>e.click());document.querySelector('[data-assign-save]').click()");
    await waitFor("!document.querySelector('[data-assign-save]')", "category save");
    const assignment=await evaluate("fetch('/api/v1/patterns').then(r=>r.json()).then(p=>p.items.find(g=>g.category_ids.length===2))");
    assert.ok(assignment);
    check("grouped library creates manual categories and assigns one original to multiple categories");

    await evaluate("location.hash=" + JSON.stringify("#/workbench?asset=" + info.input_asset_id + "&stage=1&v=2"));
    await waitFor("document.querySelector('.wb') && document.querySelectorAll('[data-pattern]').length>=4", "workbench one-click entry");
    await evaluate("document.querySelector('[data-act=process-batch]').click()");
    await waitFor("Boolean(document.querySelector('[data-pf-run-preset]'))", "batch preset picker");
    await evaluate(`(()=>{const select=document.querySelector('[data-pf-run-preset]');
      select.value=[...select.options].find(o=>o.textContent.includes('云端线稿')).value;
      select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor("document.querySelector('[data-pf-run-start]')?.disabled && document.querySelector('.pf-run').textContent.includes('云端尚未启用')", "disabled cloud preset explains how to proceed");
    await evaluate(`(()=>{const select=document.querySelector('[data-pf-run-preset]');
      const option=[...select.options].find(o=>o.textContent.includes('颜色提取'));
      select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await evaluate("document.querySelector('[data-pf-select-none]').click()");
    assert.equal(await evaluate("document.querySelectorAll('[data-pf-image]:enabled:not(:checked)').length"), groupIds.length);
    for (const name of ["batch-smoke-0", "batch-smoke-1", "batch-smoke-2"]) {
      await evaluate(`[...document.querySelectorAll('[data-pf-image]')].find(e=>e.closest('label').textContent.includes(${JSON.stringify(name)})).click()`);
    }
    check("one-click processing allows individual images to be selected again after clearing the selection");
    await waitFor("document.querySelector('[data-pf-run-start]')?.disabled===false", "local preset ready");
    assert.equal(await evaluate("document.querySelectorAll('[data-pf-consent-upload]').length"),0);
    await evaluate("document.querySelector('[data-pf-run-start]').click()");
    await waitFor("import('/js/processing.js').then(m=>Boolean(m.processing.detail?.batch_id))", "batch admitted");
    const batchId=await evaluate("import('/js/processing.js').then(m=>m.processing.detail.batch_id)");
    const snapshot=await evaluate("fetch('/api/v1/processing-batches/'+ "+JSON.stringify(batchId)+").then(r=>r.json()).then(b=>b.snapshot)");
    assert.equal(snapshot.consent_to_upload,false);
    assert.equal(snapshot.consent_to_charge,false);
    await waitFor("Boolean(document.querySelector('#pf-dock:not([hidden])'))", "batch progress entry");
    const assertWorkbenchClear = async (label) => {
      const covered = await evaluate(`(() => {
        const wb = document.querySelector('.wb').getBoundingClientRect();
        return [...document.querySelectorAll('.pf-window, #pf-dock')].filter(e => {
          const box = e.getBoundingClientRect();
          return box.width && box.height && box.right > wb.left && box.left < wb.right &&
            box.bottom > wb.top + 1 && box.top < wb.bottom - 1;
        }).map(e => e.id || e.className);
      })()`);
      assert.deepEqual(covered, [], label);
    };
    for (const [width,height] of [[1440,900],[1080,720],[390,844]]) {
      await call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:width===390});
      await assertWorkbenchClear("batch controls overlap the workbench after submission at "+width);
      const dockPoint = `(() => {
        const dock = document.querySelector('#pf-dock');
        if (!dock) return {clickable:false};
        const rect = dock.getBoundingClientRect();
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        return { x, y, clickable: dock.contains(document.elementFromPoint(x,y)) };
      })()`;
      await waitFor(dockPoint + ".clickable", "batch progress entry is reachable at "+width, 2500);
      const point = await evaluate(dockPoint);
      await call("Input.dispatchMouseEvent",{type:"mousePressed",x:point.x,y:point.y,button:"left",clickCount:1});
      await call("Input.dispatchMouseEvent",{type:"mouseReleased",x:point.x,y:point.y,button:"left",clickCount:1});
      await waitFor("Boolean(document.querySelector('.pf-window:not([hidden]) [data-pf-close-window]'))","progress details");
      await evaluate("document.querySelector('[data-pf-close-window]').click()");
      await assertWorkbenchClear("batch controls overlap the workbench after collapse at "+width);
      if (width !== 1080) await writeFile(path.join(output,"batch-background-"+width+".png"),Buffer.from((await call("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    check("background processing and collapsed progress leave the desktop and narrow workbench unobstructed");
    await call("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await waitFor(`fetch('/api/v1/processing-batches/'+${JSON.stringify(batchId)}).then(r=>r.json()).then(b=>b.state==='succeeded')`, "real batch finishes with collapsed UI",60000);
    await evaluate("window.__batchBeforeReload=true");
    await call("Page.reload");
    await waitFor("window.__batchBeforeReload!==true && Boolean(document.querySelector('[data-entry=continue]'))", "resume workbench after reload");
    await evaluate("document.querySelector('[data-entry=continue]').click()");
    await waitFor("Boolean(document.querySelector('#pf-dock:not([hidden])')) && Boolean(document.querySelector('.wb'))", "batch recovery after reload");
    await assertWorkbenchClear("batch controls overlap the workbench after reload");
    await evaluate("document.querySelector('#pf-dock').click()");
    await waitFor("Boolean(document.querySelector('[data-pf-export-results]'))", "restored batch result actions");
    await evaluate("document.querySelector('[data-pf-export-results]').click()");
    await waitFor("Boolean(document.querySelector('[data-bx-kind=svg]'))", "shared export of SVG results");
    await writeFile(path.join(output,"batch-results.png"),Buffer.from((await call("Page.captureScreenshot",{format:"png"})).data,"base64"));
    await evaluate("document.querySelector('[data-bx-close]').click();document.querySelector('[data-pf-close-window]')?.click()");
    check("saved preset runs a local batch, survives collapsed progress and reload, and reuses the SVG export picker");
    assert.deepEqual(batchLayoutFailures,[],"batch layout must scroll only inside its regions");
  }
  let model, uploaded, isolated;
  if (!archiveOnly && !pagesOnly) {
  await call("Page.navigate", { url: info.url + "/#/workbench?asset=" + info.input_asset_id + "&stage=3" });
  await waitFor("document.querySelector('[data-act=run-model-lineart]') && document.querySelector('.wb')?.dataset.stage==='process'", "model default route");
  await waitFor("import('/js/store.js').then(m=>m.store.lineartModel.available===true)", "model prerequisites");
  await waitFor(`import('/js/store.js').then(m=>m.store.session.currentAssetId===${JSON.stringify(info.input_asset_id)} && document.querySelector('[data-act=run-model-lineart]')?.disabled===false)`, "initial model input loaded");
  check("backend model capability enables the default model route");

  uploaded = await evaluate(`(async()=>{
    const {api}=await import('/js/api.js');
    const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;
    const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,128,128);
    c.strokeStyle='black';c.lineWidth=4;c.beginPath();c.arc(64,64,42,0,Math.PI*2);c.stroke();
    const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));
    const a=await api.uploadImage(new File([blob],'browser-ring.png',{type:'image/png'}));
    location.hash='#/workbench?asset='+a.normalized.asset_id+'&stage=3';
    return {imageId:a.image_id,assetId:a.normalized.asset_id};
  })()`);
  await waitFor(`import('/js/store.js').then(m=>m.store.session.currentAssetId===${JSON.stringify(uploaded.assetId)})`, "synthetic ring input");
  if (!sessionOnly) {
  await evaluate("document.querySelector('[data-act=run-model-lineart]').click()");
  await waitFor("import('/js/store.js').then(m=>Boolean(m.store.session.activeJob?.job_id))", "model job admitted");
  const jobId=await evaluate("import('/js/store.js').then(m=>m.store.session.activeJob.job_id)");
  await waitFor("import('/js/store.js').then(m=>m.store.session.jobs.some(j=>j.state==='succeeded' && j.kind==='lineart' && j.parameters.method==='model'))", "model PNG", 105000);
  model = await evaluate(`import('/js/store.js').then(({store})=>{
    const j=store.session.jobs.find(j=>j.job_id===${JSON.stringify(jobId)});
    return {state:j.state,parameters:j.parameters,assets:j.result.assets.map(a=>({id:a.asset_id,kind:a.kind,source:a.source_asset_id,device:a.parameters?.inference_device})),current:store.currentAsset()?.kind};
  })`);
  assert.equal(model.parameters.method, "model");
  assert.equal("extract" in model.parameters, false);
  assert.equal("enhance" in model.parameters, false);
  const png = model.assets.find(a=>a.kind==="lineart");
  assert(png, "local model must publish lineart PNG");
  assert(!model.assets.some(a=>a.kind==='svg'), "extraction must leave vectorization for the later stage");
  assert.equal(png.device, "cuda");
  assert.equal(model.current, "lineart");
  await waitFor("document.querySelector('.wb-panel')?.textContent.includes('推理设备 CUDA')", "actual inference device and ink coverage visible");
  check("UI submits local model lineart and adopts the real CUDA PNG without automatic vectorization");
  await evaluate("document.querySelector('[data-act=go-vector]').click()");
  await waitFor("document.querySelector('.wb')?.dataset.stage==='vector' && document.querySelector('[data-act=run-vectorize]')?.disabled===false", "separate vector stage");
  await evaluate("document.querySelector('[data-act=run-vectorize]').click()");
  await waitFor("import('/js/store.js').then(m=>m.store.session.jobs.some(j=>j.kind==='vectorize' && j.state==='succeeded'))", "PNG to SVG");
  const vector = await evaluate("import('/js/store.js').then(m=>m.store.session.assets.find(a=>a.kind==='svg'))");
  assert.equal(vector.source_asset_id,png.id);
  check("separate vectorization uses the selected lineart PNG");
  await writeFile(path.join(output,"workbench-model.png"), Buffer.from((await call("Page.captureScreenshot", {format:"png"})).data,"base64"));

  await evaluate(`location.hash='#/workbench?asset='+${JSON.stringify(png.id)}+'&stage=5&v=2'`);
  await waitFor("document.querySelector('[data-act=go-mask]')?.disabled===false", "model PNG can enter mask correction");
  await evaluate("document.querySelector('[data-act=go-mask]').click()");
  await waitFor("document.querySelector('[data-act=prepare-lineart-mask]')?.disabled===false", "prepare editable alpha mask");
  await evaluate("document.querySelector('[data-act=prepare-lineart-mask]').click()");
  await waitFor("import('/js/store.js').then(({store})=>store.currentAsset()?.kind==='transparent_png' && !store.session.busy)", "adopt prepared PNG");
  const centerAlpha = (assetId) => evaluate(`(async()=>{
    const {api}=await import('/js/api.js');
    const blob=await fetch(api.assetDownloadUrl(${JSON.stringify(assetId)})).then(r=>r.blob());
    const bitmap=await createImageBitmap(blob);
    const ctx=new OffscreenCanvas(bitmap.width,bitmap.height).getContext('2d');
    ctx.drawImage(bitmap,0,0);
    return ctx.getImageData(bitmap.width/2,bitmap.height/2,1,1).data[3];
  })()`);
  assert.equal(await centerAlpha(png.id),0);
  const center = await evaluate(`(()=>{
    const rect=document.querySelector('[data-media]').getBoundingClientRect();
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  })()`);
  await call("Input.dispatchMouseEvent",{type:"mousePressed",...center,button:"left",buttons:1,clickCount:1});
  await call("Input.dispatchMouseEvent",{type:"mouseReleased",...center,button:"left",clickCount:1});
  await waitFor("document.querySelector('[data-act=run-mask]')?.disabled===false","submit actual brush stroke");
  await evaluate("document.querySelector('[data-act=run-mask]').click()");
  await waitFor("import('/js/store.js').then(({store})=>store.currentAsset()?.annotation_source==='human_foreground_correction' && !store.session.busy)","adopt brush correction");
  const editedId=await evaluate("import('/js/store.js').then(({store})=>store.currentAsset().asset_id)");
  assert.equal(await centerAlpha(editedId),255);
  await evaluate("document.querySelector('[data-act=go-vector]').click()");
  await waitFor("document.querySelector('[data-act=run-vectorize]')?.disabled===false","vectorize corrected ink");
  await evaluate("document.querySelector('[data-act=run-vectorize]').click()");
  await waitFor(`import('/js/store.js').then(({store})=>store.currentAsset()?.kind==='svg' && store.currentAsset().source_asset_id===${JSON.stringify(editedId)})`, "SVG uses corrected PNG");
  check("real pointer adds visible ink in the model PNG's blank center and the saved correction feeds vectorization");
  }

  // Delay one real poll response, then change images before it reaches the store.
  // Stage-only navigation preserves the selected SVG. Explicitly choose the RGB
  // source for cropping, just as the user must after completing vectorization.
  await evaluate(`document.querySelector('[data-act=asset][data-id="'+${JSON.stringify(uploaded.assetId)}+'"]')?.click()`);
  await evaluate(`(async()=>{
    location.hash='#/workbench?asset='+${JSON.stringify(uploaded.assetId)}+'&stage=2';
    window.__originalFetch=window.fetch.bind(window);
    window.__pollHeld=false;
    window.fetch=async(...args)=>{
      const response=await window.__originalFetch(...args);
      if(!window.__pollHeld && (!args[1]?.method || args[1].method==='GET') && new URL(String(args[0]),location.href).pathname.startsWith('/api/v1/jobs/')){
        window.__pollHeld=true;
        await new Promise(r=>window.__releasePoll=r);
      }
      return response;
    };
  })()`);
  await waitFor(`import('/js/store.js').then(m=>m.store.session.currentAssetId===${JSON.stringify(uploaded.assetId)} && Boolean(document.querySelector('[data-act=apply-crop]')) && !document.querySelector('[data-act=apply-crop]').disabled)`, "crop input loaded");
  await evaluate("document.querySelector('[data-act=apply-crop]').click()");
  await waitFor("window.__pollHeld===true", "real poll response held");
  const oldJob = await evaluate("import('/js/store.js').then(m=>m.store.session.activeJob.job_id)");
  await evaluate(`location.hash='#/workbench?asset='+${JSON.stringify(info.input_asset_id)}+'&stage=2'`);
  await waitFor(`import('/js/store.js').then(m=>m.store.session.currentAssetId===${JSON.stringify(info.input_asset_id)})`, "second image opened");
  await evaluate("window.__releasePoll();window.fetch=window.__originalFetch");
  await waitFor(`fetch('/api/v1/jobs/'+${JSON.stringify(oldJob)}).then(r=>r.json()).then(j=>['succeeded','failed','cancelled'].includes(j.state))`, "old task completes");
  await new Promise(r=>setTimeout(r,1500));
  isolated=await evaluate(`import('/js/store.js').then(({store})=>({current:store.session.currentAssetId,busy:store.session.busy,foreign:store.session.assets.some(a=>a.image_id===${JSON.stringify(uploaded.imageId)})}))`);
  assert.equal(isolated.current,info.input_asset_id);
  assert.equal(isolated.busy,false);
  assert.equal(isolated.foreign,false);
  check("late task polling and success callbacks do not modify another image session");
  }

  // Reuse the fixture's archived cloud layers while payment is disabled.
  if (!pagesOnly) {
  if (archiveOnly) await call("Page.navigate", {url:info.url+'/#/workbench?asset='+info.input_asset_id+'&stage=4'});
  else await evaluate(`location.hash='#/workbench?asset='+${JSON.stringify(info.input_asset_id)}+'&stage=4'`);
  await waitFor("document.querySelector('[data-act=layer]')", "archived cloud layers restored without a key");
  await waitFor("document.querySelector('[data-act=compose-layers]')", "archived flow restoration completed before selection");
  // Readiness and click share one evaluation: a legitimate repaint between two
  // CDP calls must not turn optional chaining into a silently skipped click.
  await waitFor("(()=>{const layer=document.querySelector('[data-act=layer][aria-pressed=false]');if(!layer||!document.querySelector('[data-act=compose-layers]'))return false;layer.click();return true})()", "select an archived layer");
  await waitFor("document.querySelector('[data-act=compose-layers]')?.disabled===false", "archived layers can compose locally");
  await evaluate("document.querySelector('[data-act=compose-layers]').click()");
  await waitFor(`fetch('/api/v1/pipelines/'+${JSON.stringify(info.pipeline_id)}).then(r=>r.json()).then(f=>f.state==='succeeded' && f.decision?.action==='select_layers')`, "first selection advances the cloud workflow", 30000);
  await waitFor("import('/js/store.js').then(m=>!m.store.session.busy)", "first local composition adopted");
  check("archived layers continue their workflow while cloud payment is disabled");

  await call("Page.reload", { ignoreCache: true });
  await waitFor("Boolean(document.querySelector('[data-entry=continue]'))", "resume archived selection after reload");
  await evaluate("document.querySelector('[data-entry=continue]').click()");
  await waitFor("document.querySelector('[data-act=layer][aria-pressed=true]') && document.querySelector('[data-act=compose-layers]')?.disabled===false", "selected layers restored after reload");
  await evaluate("document.querySelector('[data-act=compose-layers]').click()");
  await waitFor(`fetch('/api/v1/pipelines/'+${JSON.stringify(info.pipeline_id)}).then(r=>r.json()).then(f=>f.branches?.some(b=>b.state==='succeeded' && b.action==='compose'))`, "local recomposition branch", 30000);
  assert.equal(requests.filter(r=>r.method==='POST' && r.path.endsWith('/continue')).length,1);
  assert.equal(requests.filter(r=>r.method==='POST' && r.path.endsWith('/rerun')).length,1);
  check("reload restores selection and recomposition uses a local workflow branch");
  }

  if (!archiveOnly && !pagesOnly) {
  await call("Emulation.setDeviceMetricsOverride", {width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate("location.hash='#/workbench?asset='+"+JSON.stringify(uploaded.assetId)+"+'&stage=3'");
  await waitFor("document.querySelector('[data-act=run-model-lineart]')", "narrow model route");
  await writeFile(path.join(output,"workbench-narrow.png"),Buffer.from((await call("Page.captureScreenshot", {format:"png"})).data,"base64"));
  }
  if (pagesOnly && !batchOnly) {
    let pageCase=0;
    const navigatePage=async (url)=>{
      const freshUrl=new URL(url);
      freshUrl.searchParams.set("validationPage",String(++pageCase));
      await evaluate('window.__previousTestDocument=true');
      await call('Page.navigate',{url:freshUrl.href});
      await waitFor('window.__previousTestDocument!==true && document.readyState==="complete"','new test document loaded');
    };
    const stageKeys=['source','crop','repair','candidate','process','mask','vector','tile'];
    async function checkCoordinateRows(prefix, width) {
      await evaluate(`(() => {
        const toggle = document.querySelector('[data-act=panel-toggle][aria-expanded=false]');
        if (toggle?.getClientRects().length) toggle.click();
      })()`);
      await waitFor(`document.getElementById('wb-${prefix}Left')?.getBoundingClientRect().height > 0`, prefix + ' coordinates visible');
      const fields = await evaluate(`['Left','Top','Width','Height'].map(name => {
        const input = document.getElementById('wb-${prefix}' + name);
        const box = input.getBoundingClientRect();
        return {left:box.left, right:box.right, top:box.top, bottom:box.bottom,
          label:input.labels[0].querySelector('.field__label').getBoundingClientRect().top};
      })`);
      for (const [left, right] of [[fields[0], fields[1]], [fields[2], fields[3]]]) {
        assert.ok(Math.abs(left.top - right.top) <= 1 && Math.abs(left.label - right.label) <= 1,
          prefix + ' labels and inputs must align at ' + width + 'px');
        assert.ok(left.right <= right.left && right.right <= width + 1);
      }
      assert.ok(fields[0].bottom <= fields[2].top);
    }
    if (!layoutOnly) for (const width of [1440,1080,390]) {
      await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
      for (const [route,selector] of [['home','.home'],['library','.lb-page'],['tasks','.tk-page'],['settings','.st-page'],['notes','.notes']]) {
        await navigatePage(info.url+'/#/'+route);
        await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`,route+' rendered');
        const overflow=await evaluate('document.documentElement.scrollWidth>innerWidth+1');
        assert.equal(overflow,false,route+' overflow at '+width);
      }
      for (let stage=1;stage<=8;stage++) {
        await navigatePage(info.url+'/#/workbench?asset='+info.input_asset_id+'&stage='+stage+'&v=2');
        await waitFor(`document.querySelector('.wb')?.dataset.stage===${JSON.stringify(stageKeys[stage-1])}`, 'stage '+stage);
        assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'),false,'stage '+stage+' overflow at '+width);
        if(stage===2) await checkCoordinateRows('crop', width);
        if(stage===3) {
          await waitFor(`import('/js/store.js').then(({store}) => store.session.currentAssetId === ${JSON.stringify(info.input_asset_id)} && !!document.querySelector('[data-act=skip-repair]:not(:disabled)'))`, 'skip repair available on loaded pattern');
          await waitFor("import('/js/store.js').then(({store}) => store.leftrefillModel.available !== null)", 'local repair capability');
          if (await evaluate("import('/js/store.js').then(({store}) => store.leftrefillModel.available)")) {
            await evaluate("document.querySelector('[data-seg=repairMethod][data-val=leftrefill]').click()");
            await checkCoordinateRows('repair', width);
          }
          await evaluate("document.querySelector('[data-act=skip-repair]').click()");
          await waitFor("document.querySelector('.wb-panel [data-act=go-process]:not(:disabled)') && document.querySelector('.wb-panel [data-act=skip-repair]')?.textContent.includes('继续修复')", 'repair skipped without generation');
        }
        if(stage===5) {
          await waitFor("Boolean(document.querySelector('[data-seg=processRoute][data-val=cloud]'))",'cloud route available');
          await evaluate("document.querySelector('[data-seg=processRoute][data-val=cloud]').click()");
          await waitFor("document.querySelector('[data-act=run-cloud-lineart]')?.disabled===true",'disabled cloud route leaves local available');
          await writeFile(path.join(output,'cloud-route-'+width+'.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
        }
      }
      check('home/library/tasks/settings/notes and eight stages fit, with aligned coordinate fields at '+width+'px');
    }
    for (const [width,height] of [[1920,1080],[1440,900],[1280,720],[1080,720],[821,640],[820,900],[390,844]]) {
      await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<=820});
      await navigatePage(info.url+'/#/workbench?asset='+info.input_asset_id+'&stage=1&v=2');
      await waitFor("document.querySelector('.wb-assets .wb-thumb[aria-current=true]') && document.querySelector('.wb-media__img')",'independent assets loaded');
      const layout=await evaluate(`(() => {
        const box=(selector)=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:r.width}};
        return {rail:box('.wb-rail'),assets:box('.wb-assets'),main:box('.wb-main'),steps:box('.wb-steps'),lastStep:box('.wb-steps li:last-child'),foot:box('.wb-rail__foot'),wb:box('.wb'),independent:document.querySelector('.wb-assets').parentElement.classList.contains('wb'),overflow:document.documentElement.scrollWidth>innerWidth+1};
      })()`);
      assert.equal(layout.independent,true,'assets must be a separate column');
      assert.equal(layout.overflow,false,'layout overflow at '+width+'x'+height);
      if(width>820) {
        assert.ok(layout.rail.right<=layout.assets.left+1 && layout.assets.right<=layout.main.left+1,'desktop columns must not overlap');
        assert.ok(layout.assets.height>=layout.wb.height-2,'asset list has full workbench height');
        assert.ok(layout.main.width>=300,'canvas retains usable width');
        if(height>=900) assert.ok(layout.foot.top-layout.lastStep.bottom<=28,'steps use available vertical space');
      }
      if(width>820 && width<=1300) {
        for(const expanded of [true,false]) {
          await evaluate(`(() => {const toggle=document.querySelector('[data-act=panel-toggle]');if((toggle.getAttribute('aria-expanded')==='true')!==${expanded}) toggle.click()})()`);
          await waitFor(`document.querySelector('[data-act=panel-toggle]')?.getAttribute('aria-expanded')===${JSON.stringify(String(expanded))}`,'parameter drawer toggle');
          const drawer=await evaluate(`(() => {const p=document.querySelector('.wb-panel').getBoundingClientRect(),a=document.querySelector('.wb-assets').getBoundingClientRect();return {left:p.left,assetsRight:a.right,bottom:p.bottom}})()`);
          assert.ok(drawer.left>=drawer.assetsRight-1,'drawer must not cover asset column');
        }
      }
      if(width>820 && height<=720) {
        const reachable=await evaluate(`(() => {const rail=document.querySelector('.wb-rail');rail.scrollTop=rail.scrollHeight;const button=rail.querySelector('[data-act=go-export]').getBoundingClientRect(),r=rail.getBoundingClientRect();return button.top>=r.top && button.bottom<=r.bottom+1})()`);
        assert.equal(reachable,true,'export remains reachable in a short window');
      }
      if(width===1920) {
        const scrollable=await evaluate(`(() => {
          const scroller=document.querySelector('.wb-groups'),grid=scroller.querySelector('.wb-group__grid'),first=grid.firstElementChild;
          const clones=Array.from({length:30},()=>first.cloneNode(true));grid.append(...clones);
          scroller.scrollTop=scroller.scrollHeight;const moved=scroller.scrollTop>0;
          clones.forEach(node=>node.remove());scroller.scrollTop=0;return moved;
        })()`);
        assert.equal(scrollable,true,'many assets scroll inside the independent column');
      }
      await evaluate(`(() => {
        const thumb=document.querySelector('.wb-assets .wb-thumb:not([aria-current=true])');
        window.__layoutSelected=thumb.dataset.id;thumb.click();
      })()`);
      await waitFor("document.querySelector('.wb-assets .wb-thumb[aria-current=true]')?.dataset.id===window.__layoutSelected",'asset selection updates from new column');
      if(width>820 && width<=1300) {
        assert.equal(await evaluate("window.dispatchEvent(new Event('resize'));document.querySelector('[data-act=panel-toggle]').getAttribute('aria-expanded')"),'false','closed drawer stays closed after selection and resize');
      }
      if(width===1920 || width===1440 || width===390) await writeFile(path.join(output,'asset-column-'+width+'.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
      check('independent asset column, selection and responsive layout at '+width+'x'+height);
    }
    if (!layoutOnly) {
      const settingsUrl = '/api/v1/settings';
      const current = () => evaluate(`fetch('${settingsUrl}').then(r=>r.json())`);
      const initial = await current();
      // A historical partial opt-in must survive an unrelated save.
      assert.equal(await evaluate(`fetch('${settingsUrl}',{method:'PUT',headers:{'Content-Type':'application/json','X-Pattern-Studio':'local'},
        body:JSON.stringify({revision:${initial.revision},paid_calls_enabled:false,pricing_confirmed:true})}).then(r=>r.ok)`), true);
      await navigatePage(info.url+'/#/settings');
      const billing = '[data-cfg=billing_enabled]';
      await waitFor(`document.querySelector('${billing}')?.getAttribute('aria-checked')==='false'`, 'partial billing opt-in stays off');
      await fill('st-cloud-model','ep-20261122123456-test');
      await evaluate("document.querySelector('[data-act=save]').click()");
      await waitFor(`fetch('${settingsUrl}').then(r=>r.json()).then(s=>s.model==='ep-20261122123456-test')`, 'unrelated setting saved');
      const after = await current();
      assert.deepEqual([after.paid_calls_enabled, after.pricing_confirmed], [false,true]);
      for (const enabled of [true,false]) {
        await waitFor("document.querySelector('.st-page[data-saved=true]:not([data-saving])') && document.querySelector('[data-act=save]').disabled", 'billing form ready');
        await evaluate(`document.querySelector('${billing}').click()`);
        assert.equal(await evaluate("document.querySelector('[data-act=save]').disabled"),false);
        await evaluate("document.querySelector('[data-act=save]').click()");
        await waitFor(`fetch('${settingsUrl}').then(r=>r.json()).then(s=>s.paid_calls_enabled===${enabled} && s.pricing_confirmed===${enabled})`, 'billing choice saved: '+enabled);
      }
      check('one billing switch updates both flags only on explicit change');
    }
  }
  // Newly merged repair entry must reflect actual local prerequisites and must
  // never submit a paid fallback merely because local weights are absent.
  await call("Page.navigate", {url:info.url+'/#/workbench?asset='+info.input_asset_id+'&stage=3&v=2'});
  await waitFor("document.querySelector('.wb')?.dataset.stage==='repair' && document.querySelector('[data-seg=repairMethod][data-val=leftrefill]')", "repair route ready");
  await waitFor(`import('/js/store.js').then(m=>m.store.session.currentAssetId===${JSON.stringify(info.input_asset_id)} && m.store.leftrefillModel.available!==null)`, "repair capability and input loaded");
  const repairCapability = await evaluate(`import('/js/store.js').then(m=>({available:m.store.leftrefillModel.available,disabled:document.querySelector('[data-seg=repairMethod][data-val=leftrefill]').disabled,text:document.querySelector('.wb').textContent}))`);
  assert.equal(repairCapability.disabled, repairCapability.available === false);
  if (repairCapability.available === false) assert.match(repairCapability.text,/基础模型|基础网络|依赖|配置|检查失败|模型文件/);
  if (repairCapability.available) {
    await evaluate("document.querySelector('[data-seg=repairMethod][data-val=leftrefill]').click()");
    await waitFor("Boolean(document.querySelector('[data-field=repairWidth]'))", "local repair box controls");
    for (const [key,value] of Object.entries({repairLeft:32,repairTop:24,repairWidth:64,repairHeight:40})) {
      await fill("wb-"+key,value);
    }
    const visibleBox = await evaluate(`(() => {
      const region = document.querySelector('[data-repair-overlay] .wb-repair__region');
      return ['left', 'top', 'width', 'height'].map(key => Number.parseFloat(region.style[key]) * 512 / 100);
    })()`);
    assert.deepEqual(visibleBox.map(Math.round), [32, 24, 64, 40]);
  }
  check("local repair entry reflects prerequisites without generating or calling cloud");

  // Revisit the same asset, clear it, then use the identical link again. A stale
  // lastAppliedTarget previously left this route with an empty session.
  const reopenHash = await evaluate("location.hash");
  await evaluate("location.hash='#/home'");
  await waitFor("!document.querySelector('.wb')", "leave repair workbench");
  await evaluate(`location.hash=${JSON.stringify(reopenHash)}`);
  await waitFor("document.querySelector('[data-act=clear-session]')?.disabled===false", "workbench clear ready");
  await evaluate("window.confirm=()=>true;document.querySelector('[data-act=clear-session]').click()");
  await waitFor("import('/js/store.js').then(m=>m.store.session.assets.length===0)", "clear workbench");
  await evaluate(`location.hash=${JSON.stringify(reopenHash)}`);
  await waitFor(`import('/js/store.js').then(m=>m.store.session.currentAssetId===${JSON.stringify(info.input_asset_id)} && m.store.session.assets.length>0)`, "reopen identical asset link after clear");
  check("clearing workbench does not prevent reopening the identical asset link");

  await evaluate("location.hash='#/tasks'");
  await waitFor("document.querySelector('[data-tk-list] .tk-row') && !document.querySelector('[data-tk-refresh]').disabled", "task center reads real local history");
  await evaluate("document.querySelector('[data-tk-status=failed]').click()");
  const filteredTasks = await evaluate("({states:[...document.querySelectorAll('.tk-row__state')].map(e=>e.textContent),detail:document.querySelector('[data-tk-detail]').textContent})");
  assert.ok(filteredTasks.states.every(state=>state==='失败'));
  if (!filteredTasks.states.length) assert.match(filteredTasks.detail,/选一条任务/);
  check("task center loads history and clears details when filtering removes all rows");

  const budget=await evaluate("fetch('/api/v1/seedream/status').then(r=>r.json()).then(s=>s.budget.call_count)");
  // The fixture begins with one synthetic archived call; this test must add none.
  assert.equal(budget,1);
  const cloudRequests=requests.filter(r=>r.method==='POST' && /(?:pipelines\/ai|jobs\/(?:repair|cloud-lineart)|seedream\/validations)$/.test(r.path));
  assert.equal(cloudRequests.length,0);
  assert.equal(errors.length,0,JSON.stringify(errors));
  check("page has no exceptions and sends no cloud-generation requests");
  await writeFile(path.join(output,"browser-checks.json"),JSON.stringify({checks,model,isolated,cloudGenerationRequests:0,pageErrors:errors},null,2));
  await call("Browser.close",{},false);
  }
} finally {
  socket?.close();fixture?.kill();
  await stopOwnedBrowser();
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.equal(path.dirname(path.resolve(temp)),path.resolve(tmpdir()));
  assert.equal(path.basename(temp).startsWith("pattern-v2-browser-"),true);
  await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}

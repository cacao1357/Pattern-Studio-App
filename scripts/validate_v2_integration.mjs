// New workbench integration smoke: isolated data, real local worker, no cloud calls.
// Run: node scripts/validate_v2_integration.mjs D:/CondaEnvs/pattern-studio/python.exe
// --pages-only checks all pages plus layout; --layout-only checks responsive assets and drawer.
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
const pagesOnly = layoutOnly || process.argv.includes("--pages-only");
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
    const diagnostic = await evaluate("({stage:document.querySelector('.wb')?.dataset.stage,error:document.querySelector('.wb-error')?.textContent,notice:document.querySelector('.wb-note')?.textContent,layers:[...document.querySelectorAll('[data-act=layer]')].map(e=>({id:e.dataset.id,on:e.getAttribute('aria-pressed')})),compose:document.querySelector('[data-act=compose-layers]')?.outerHTML})");
    throw new Error("UI timeout: " + label + " " + JSON.stringify({ diagnostic, errors, requests: requests.slice(-12) }));
  };
  const check = (label) => { checks.push(label); console.log("PASS " + label); };
  const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const fill = (id, value, event = "input") => evaluate(`(() => {const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);


  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
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
  check("UI submits local model lineart and adopts the real CUDA PNG without automatic vectorization");
  await evaluate("document.querySelector('[data-act=go-vector]').click()");
  await waitFor("document.querySelector('.wb')?.dataset.stage==='vector' && document.querySelector('[data-act=run-vectorize]')?.disabled===false", "separate vector stage");
  await evaluate("document.querySelector('[data-act=run-vectorize]').click()");
  await waitFor("import('/js/store.js').then(m=>m.store.session.jobs.some(j=>j.kind==='vectorize' && j.state==='succeeded'))", "PNG to SVG");
  const vector = await evaluate("import('/js/store.js').then(m=>m.store.session.assets.find(a=>a.kind==='svg'))");
  assert.equal(vector.source_asset_id,png.id);
  check("separate vectorization uses the selected lineart PNG");
  await writeFile(path.join(output,"workbench-model.png"), Buffer.from((await call("Page.captureScreenshot", {format:"png"})).data,"base64"));
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
  if (pagesOnly) {
    let pageCase=0;
    const navigatePage=async (url)=>{
      const freshUrl=new URL(url);
      freshUrl.searchParams.set("validationPage",String(++pageCase));
      await evaluate('window.__previousTestDocument=true');
      await call('Page.navigate',{url:freshUrl.href});
      await waitFor('window.__previousTestDocument!==true && document.readyState==="complete"','new test document loaded');
    };
    const stageKeys=['source','crop','repair','candidate','process','mask','vector','tile'];
    if (!layoutOnly) for (const width of [1440,390]) {
      await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
      for (const [route,selector] of [['home','.home'],['settings','.st-page'],['notes','.notes']]) {
        await navigatePage(info.url+'/#/'+route);
        await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`,route+' rendered');
        const overflow=await evaluate('document.documentElement.scrollWidth>innerWidth+1');
        assert.equal(overflow,false,route+' overflow at '+width);
      }
      for (let stage=1;stage<=8;stage++) {
        await navigatePage(info.url+'/#/workbench?asset='+info.input_asset_id+'&stage='+stage+'&v=2');
        await waitFor(`document.querySelector('.wb')?.dataset.stage===${JSON.stringify(stageKeys[stage-1])}`, 'stage '+stage);
        assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'),false,'stage '+stage+' overflow at '+width);
        if(stage===3) {
          await waitFor("Boolean(document.querySelector('[data-act=skip-repair]'))",'skip repair visible');
          await evaluate("document.querySelector('[data-act=skip-repair]').click()");
          await waitFor("document.querySelector('.wb-note')?.textContent.includes('已跳过修复')",'repair skipped without generation');
        }
        if(stage===5) {
          await waitFor("Boolean(document.querySelector('[data-seg=processRoute][data-val=cloud]'))",'cloud route available');
          await evaluate("document.querySelector('[data-seg=processRoute][data-val=cloud]').click()");
          await waitFor("document.querySelector('[data-act=run-cloud-lineart]')?.disabled===true",'disabled cloud route leaves local available');
          await writeFile(path.join(output,'cloud-route-'+width+'.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
        }
      }
      check('home/settings/notes and eight stages render without horizontal overflow at '+width+'px');
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
  }
  // Newly merged repair entry must reflect actual local prerequisites and must
  // never submit a paid fallback merely because local weights are absent.
  await call("Page.navigate", {url:info.url+'/#/workbench?asset='+info.input_asset_id+'&stage=3&v=2'});
  await waitFor("document.querySelector('.wb')?.dataset.stage==='repair' && document.querySelector('[data-seg=repairMethod][data-val=leftrefill]')", "repair route ready");
  await waitFor(`import('/js/store.js').then(m=>m.store.session.currentAssetId===${JSON.stringify(info.input_asset_id)} && m.store.leftrefillModel.available!==null)`, "repair capability and input loaded");
  const repairCapability = await evaluate(`import('/js/store.js').then(m=>({available:m.store.leftrefillModel.available,disabled:document.querySelector('[data-seg=repairMethod][data-val=leftrefill]').disabled,text:document.querySelector('.wb').textContent}))`);
  assert.equal(repairCapability.disabled, repairCapability.available === false);
  if (repairCapability.available === false) assert.match(repairCapability.text,/基础模型|基础网络|依赖|配置|检查失败|模型文件/);
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
} finally {
  socket?.close();fixture?.kill();
  await stopOwnedBrowser();
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.equal(path.dirname(path.resolve(temp)),path.resolve(tmpdir()));
  assert.equal(path.basename(temp).startsWith("pattern-v2-browser-"),true);
  await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}

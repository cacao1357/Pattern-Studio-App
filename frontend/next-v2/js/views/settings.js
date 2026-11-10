/* =============================================================================
   views/settings.js — 设置：云端服务、费用门禁、本机处理（只读）与边界说明。
   数据层：store.settings（GET/PUT /api/v1/settings，带 revision 校验）、
           store.seedream（/seedream/status 的预算读数）、store.health（本机状态）。
   交互约定：
   - 表单先在本页编辑，按「保存设置」才 PUT；只提交改动字段 + 当前 revision；
   - 密钥只显示“是否配置”，替换时输 password，留空不修改；清除密钥是显式动作；
   - 保存写入本机配置，不会测试或回显密钥；409 提示重新加载，422 显示中文校验信息；
   - 本机处理区块只读，字段全部来自 /health，不编造 GPU / 设备 / 模型名。
   ============================================================================= */

import { store } from "../store.js";
import { icon } from "../icons.js";
import { blockerLabel, escapeHtml as esc, formatBytes, shortId } from "../format.js";

/* ---------- 常量 ---------- */

const SECTIONS = [
  { id: "cloud", n: "01", title: "云端服务", note: "只在生成候选时用到" },
  { id: "cost", n: "02", title: "费用门禁", note: "超出预算即拒绝" },
  { id: "local", n: "03", title: "本机处理", note: "只读 · 原件不出本机" },
  { id: "about", n: "04", title: "关于与边界", note: "数据留在本机" },
];

const VERSION_LABELS = {
  manifest: "清单版本",
  grade: "评级",
  fingerprint: "指纹",
  pattern_score: "纹样评分",
  normalization: "规范化",
  provenance: "来源记录",
  extraction: "提取",
  vector: "矢量化",
};

const LIMIT_LABELS = {
  upload_bytes: "上传上限",
  decode_pixels: "解码像素",
  working_pixels: "工作像素",
  tile_pixels: "平铺像素",
};

/* ---------- 视图内状态 ---------- */

let baseline = null;
let pendingClear = false;
let saving = false;
let stale = false;
let ctx = null;
let timers = [];
let scrollHandler = null;
let scrollFrame = 0;
let storeUnsubscribe = null;

/* ---------- 小工具 ---------- */

const prefersReduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const settings = () => store.settings;
const yuan = (cents) => (Number(cents || 0) / 100).toFixed(2);
const money = (cents) => `¥${(Number(cents || 0) / 100).toFixed(2)}`;

function switchValue(page, name) {
  return page.querySelector(`[data-cfg="${name}"]`)?.getAttribute("aria-checked") === "true";
}

function setSwitch(page, name, on) {
  const el = page.querySelector(`[data-cfg="${name}"]`);
  if (el) el.setAttribute("aria-checked", String(Boolean(on)));
}

function revLabel(settingsRecord) {
  return settingsRecord && Number.isInteger(settingsRecord.revision) ? String(settingsRecord.revision) : "—";
}

/* ---------- 页头 / 目录 / 保存条 ---------- */

function headHtml(record) {
  const blockers = (record?.blockers || []).length;
  return `
  <header class="st-head">
    <div class="st-head__text">
      <p class="eyebrow">四 · 配置</p>
      <h1 class="title st-head__title">设置</h1>
      <p class="lead st-head__lead">
        这里的字段直接读写本机服务：保存后写入本机配置，用于下一次云端任务。
        密钥只显示是否已配置，不回显完整内容；本地处理与数据都不依赖云端。
      </p>
    </div>
    <div class="st-head__meta">
      <span class="chip chip--jade">真实本机配置</span>
      <span class="chip" data-head-key>${record ? (record.api_key_configured ? "密钥已配置" : "密钥未配置") : "读取中"}</span>
      <span class="chip${blockers ? " chip--gold" : " chip--jade"}" data-head-cloud>
        ${record ? `云端${blockers ? `不可用 · ${blockers} 项` : "配置就绪"}` : "读取中"}
      </span>
    </div>
  </header>`;
}

function navHtml() {
  return `
  <nav class="st-nav" aria-label="设置分区">
    <p class="label st-nav__head">分区</p>
    <ul class="st-nav__list">
      ${SECTIONS.map(
        (section, index) => `
      <li>
        <button class="st-nav__item" type="button" data-nav-to="${section.id}"
          aria-controls="st-${section.id}"${index === 0 ? ' aria-current="location"' : ""}>
          <span class="st-nav__n">${section.n}</span>
          <span class="st-nav__name">${section.title}</span>
          <span class="st-nav__note">${section.note}</span>
        </button>
      </li>`
      ).join("")}
    </ul>
    <p class="st-nav__foot">保存写入本机配置<br />刷新后仍从服务端读取</p>
  </nav>`;
}

function savebarHtml() {
  return `
  <div class="st-savebar" role="region" aria-label="保存设置">
    <div class="wrap st-savebar__inner">
      <p class="st-savebar__note" data-st-note data-dirty="false" aria-live="polite">正在读取当前配置…</p>
      <p class="st-savebar__hint" data-st-hint>保存写入本机配置 · 带 revision 校验 · 不回显密钥</p>
      <p class="st-form-error" data-st-error role="alert" hidden></p>
      <div class="st-savebar__acts">
        <button class="btn btn--ghost btn--sm" type="button" data-act="reload" hidden>重新加载</button>
        <button class="btn btn--ghost btn--sm" type="button" data-act="reset" disabled>放弃更改</button>
        <button class="btn btn--primary btn--sm" type="button" data-act="save" disabled>${icon("check")}保存设置</button>
      </div>
    </div>
  </div>`;
}

function secHead(n, title, note, id) {
  return `
  <div class="st-sec__head">
    <span class="st-sec__no">${n}</span>
    <h2 class="st-sec__title" id="${id}">${title}</h2>
    <span class="st-sec__note">${note}</span>
  </div>`;
}

/* ---------- 01 云端服务 ---------- */

function blockersHtml(record) {
  const codes = Array.isArray(record?.blockers) ? record.blockers : [];
  if (!codes.length) {
    return `
    <div class="st-blockers" data-blockers aria-live="polite">
      <p class="st-blockers__title">${icon("check")}当前云端配置已就绪</p>
      <p class="st-blockers__copy">密钥、付费开关、价格确认与预算都已配置；实际调用仍会按费用门禁逐次检查。</p>
      <p class="field__hint">修改后按「保存设置」写入本机配置；接口只保存配置，不测试密钥，也不会立即发起云端调用。</p>
    </div>`;
  }
  return `
  <div class="st-blockers st-blockers--warn" data-blockers aria-live="polite">
    <p class="st-blockers__title">${icon("alert")}当前云端不可用</p>
    <p class="st-blockers__copy">以下条件尚未满足，云端调用会被拒绝；本地处理不受影响。</p>
    <ul class="st-blockers__list">
      ${codes
        .map(
          (code) =>
            `<li><span class="chip chip--gold">${esc(blockerLabel(code))}</span><code class="mono">${esc(code)}</code></li>`
        )
        .join("")}
    </ul>
    <p class="field__hint">修改后按「保存设置」写入本机配置；接口只保存，不测试密钥，也不会立即发起云端调用。</p>
  </div>`;
}

function cloudSection(record) {
  return `
  <section class="st-sec" id="st-cloud" data-sec="cloud" aria-labelledby="st-cloud-title">
    ${secHead("01", "云端服务", "只在生成候选时用到", "st-cloud-title")}
    <div class="st-sec__body">
      <div class="st-row2">
        <div class="field">
          <label class="field__label" for="st-cloud-model">模型</label>
          <input class="input" id="st-cloud-model" name="cloud-model" type="text" data-cfg="model"
            value="${esc(record.model)}" spellcheck="false" autocomplete="off" />
          <p class="field__hint">本机服务当前使用的云端模型名，保存后用于下一次云端任务。</p>
        </div>
        <div class="field">
          <label class="field__label" for="st-cloud-base">接口地址</label>
          <input class="input" id="st-cloud-base" name="cloud-base" type="url" data-cfg="base_url"
            value="${esc(record.base_url)}" spellcheck="false" autocomplete="off" />
          <p class="field__hint">只接受服务商官方接口根地址；不符合校验时保存会返回 422。</p>
        </div>
      </div>

      <div class="field">
        <div class="field__label"><span>API Key</span><span class="st-field-note">只读状态</span></div>
        <div class="st-keyrow" role="group" aria-label="API Key 状态">
          <span class="mono st-keyrow__val" data-key-state>${record.api_key_configured ? "已配置 · 仅存本机" : "未配置"}</span>
          <span class="chip ${record.api_key_configured ? "chip--jade" : "chip--gold"}" data-key-chip>
            ${record.api_key_configured ? "已配置" : "未配置"}
          </span>
          <button class="btn btn--ghost btn--sm" type="button" data-act="clear-key" aria-pressed="false">清除密钥</button>
        </div>
        <p class="field__hint" data-key-hint>密钥只保存在本机配置，页面不会回显完整内容；替换时填写新值即可。</p>
      </div>

      <form class="field" data-key-form novalidate>
        <label class="field__label" for="st-api-key">替换 API Key<span class="st-field-note">留空不修改</span></label>
        <input class="input" id="st-api-key" name="api-key" type="password" data-cfg="api_key"
          autocomplete="new-password" spellcheck="false" placeholder="仅在替换密钥时填写" />
        <p class="field__hint">填入新值即会替换当前密钥；留空表示保持现状。保存只写回本机，不发送到远程，也不会立即测试密钥是否可用。</p>
      </form>

      <div data-blockers-wrap>${blockersHtml(record)}</div>
    </div>
  </section>`;
}

/* ---------- 02 费用门禁 ---------- */

function budgetFactsHtml() {
  const budget = store.seedream && store.seedream.budget ? store.seedream.budget : null;
  const calls = budget ? `${budget.call_count ?? 0} / ${budget.max_calls ?? "—"}` : "—";
  return `
    <dl class="st-facts" aria-label="费用概览" data-budget-facts>
      <div><dt>预算上限</dt><dd class="mono">${budget ? `¥${esc(budget.limit_cny)}` : "—"}</dd></div>
      <div><dt>云端已用</dt><dd class="mono">${budget ? `¥${esc(budget.committed_cny)}` : "—"}</dd></div>
      <div><dt>剩余额度</dt><dd class="mono">${budget ? `¥${esc(budget.remaining_cny)}` : "—"}</dd></div>
      <div><dt>云端调用</dt><dd class="mono">${esc(calls)}</dd></div>
    </dl>`;
}

function costSection(record) {
  return `
  <section class="st-sec" id="st-cost" data-sec="cost" aria-labelledby="st-cost-title">
    ${secHead("02", "费用门禁", "超出预算即拒绝", "st-cost-title")}
    <div class="st-sec__body">
      ${budgetFactsHtml()}

      <div class="st-row2">
        <div class="field">
          <label class="field__label" for="st-budget">预算上限<span class="st-field-note">元</span></label>
          <input class="input" id="st-budget" name="budget-yuan" type="number" min="0" max="1000000" step="0.01"
            inputmode="decimal" data-cfg="budget" value="${esc(yuan(record.budget_cents))}" />
          <p class="field__hint">单位是元，最多两位小数；提交时换算成“分”，范围 0–1,000,000 元。</p>
        </div>
        <div class="field">
          <label class="field__label" for="st-reservation">单次预留<span class="st-field-note">元</span></label>
          <input class="input" id="st-reservation" name="reservation-yuan" type="number" min="0" max="1000000"
            step="0.01" inputmode="decimal" data-cfg="reservation" value="${esc(yuan(record.reservation_cents))}" />
          <p class="field__hint">每次调用前先按这个金额预留；为 0 时云端调用会被拒绝。</p>
        </div>
      </div>

      <div class="st-row2">
        <div class="field">
          <label class="field__label" for="st-max-calls">最大调用次数</label>
          <input class="input" id="st-max-calls" name="max-calls" type="number" min="1" max="100" step="1"
            inputmode="numeric" data-cfg="max_calls" value="${esc(String(record.max_calls))}" />
          <p class="field__hint">1–100 次；达到上限后需要重新确认。</p>
        </div>
        <div class="field field--note">
          <p class="field__hint">
            预算、预留与次数都由本机服务校验；保存只更新配置，不会立即产生任何费用。
          </p>
        </div>
      </div>

      <div class="st-toggle">
        <div class="st-toggle__text">
          <p class="st-toggle__label" id="st-paid-label">允许付费调用</p>
          <p class="st-toggle__hint">关闭时所有云端调用都会被拒绝；本地线稿、矢量化、蒙版与平铺不受影响。</p>
        </div>
        <button class="switch" type="button" role="switch" data-cfg="paid_calls_enabled"
          aria-checked="${record.paid_calls_enabled}" aria-labelledby="st-paid-label"></button>
      </div>

      <div class="st-toggle">
        <div class="st-toggle__text">
          <p class="st-toggle__label" id="st-pricing-label">已确认价格</p>
          <p class="st-toggle__hint">表示你已了解服务商价格；未确认时云端调用会被拒绝。</p>
        </div>
        <button class="switch" type="button" role="switch" data-cfg="pricing_confirmed"
          aria-checked="${record.pricing_confirmed}" aria-labelledby="st-pricing-label"></button>
      </div>

      <p class="st-warning" data-cost-warning role="status" hidden></p>
    </div>
  </section>`;
}

/* ---------- 03 本机处理（只读） ---------- */

function factRows(rows) {
  return rows
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd class="mono">${esc(String(value))}</dd></div>`)
    .join("");
}

function localSection() {
  const health = store.health;
  const worker = health && health.worker ? health.worker : null;
  const versions = health && health.versions ? health.versions : null;
  const limits = health && health.limits ? health.limits : null;
  const ok = Boolean(health && health.status === "ok");

  const workerRows = worker
    ? [
        ["状态", worker.alive ? "在线" : "离线"],
        ["并发", `${worker.concurrency ?? "—"} 个任务`],
        ["任务超时", worker.timeout_seconds != null ? `${worker.timeout_seconds} 秒` : "—"],
        ["云端超时", worker.provider_timeout_seconds != null ? `${worker.provider_timeout_seconds} 秒` : "—"],
        ["内存上限", worker.memory_limit_mib != null ? `${worker.memory_limit_mib} MiB` : "—"],
        [
          "线稿内存上限",
          worker.lineart_model_memory_limit_mib != null ? `${worker.lineart_model_memory_limit_mib} MiB` : "—",
        ],
        ["当前任务", worker.active_job_id ? shortId(worker.active_job_id) : "空闲"],
        ["心跳", worker.heartbeat_age_seconds != null ? `${worker.heartbeat_age_seconds} 秒前` : "—"],
      ]
    : [];

  const versionRows = versions
    ? Object.entries(versions).map(([key, value]) => [VERSION_LABELS[key] || key, value])
    : [];
  const limitRows = limits
    ? Object.entries(limits)
        .filter(([key, value]) => typeof value !== "boolean")
        .map(([key, value]) => [
          LIMIT_LABELS[key] || key,
          key === "upload_bytes" ? formatBytes(value) : Number(value).toLocaleString("zh-CN"),
        ])
    : [];

  return `
    <div data-local-wrap>
      <div class="st-statusline">
        <span class="dot${ok ? "" : " dot--gold"}" aria-hidden="true"></span>
        <span class="st-statusline__text">
          本机服务 ${health ? (ok ? "正常" : "降级") : "读取中"}
          ${health ? `<span class="mono">· 数据库 ${health.database ? "正常" : "异常"} · 存储 ${health.storage ? "正常" : "异常"}</span>` : ""}
        </span>
        <span class="chip">${health && health.scope ? esc(health.scope) : "—"}</span>
      </div>

      <div class="st-subsec">
        <div class="st-subsec__head"><span class="label">处理进程</span><span class="st-field-note">来自 /api/v1/health</span></div>
        <dl class="st-facts st-facts--readonly">
          ${worker ? factRows(workerRows) : `<div><dt>状态</dt><dd>—</dd></div>`}
        </dl>
        ${
          worker && worker.error
            ? `<p class="st-warning">处理进程报告错误：${esc(String(worker.error))}</p>`
            : ""
        }
      </div>

      <div class="st-subsec">
        <div class="st-subsec__head"><span class="label">版本</span><span class="st-field-note">extraction / vector 等</span></div>
        ${
          versionRows.length
            ? `<dl class="st-meta">${versionRows
                .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd class="mono">${esc(String(value))}</dd></div>`)
                .join("")}</dl>`
            : `<p class="field__hint">—</p>`
        }
      </div>

      <div class="st-subsec">
        <div class="st-subsec__head"><span class="label">上限</span><span class="st-field-note">像素 / 字节</span></div>
        ${
          limitRows.length
            ? `<dl class="st-meta">${limitRows
                .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd class="mono">${esc(String(value))}</dd></div>`)
                .join("")}</dl>`
            : `<p class="field__hint">—</p>`
        }
      </div>

      <p class="field__hint">
        以上为只读状态：数据保存在本机 <span class="mono">storage/api/</span>，页面不写浏览器存储，也不会改动处理路径。
      </p>
    </div>`;
}

/* ---------- 04 关于与边界 ---------- */

function aboutSection(record) {
  return `
  <section class="st-sec" id="st-about" data-sec="about" aria-labelledby="st-about-title">
    ${secHead("04", "关于与边界", "数据留在本机", "st-about-title")}
    <div class="st-sec__body">
      <p class="copy">
        纹样工作台是本机优先的工具：原件、中间结果、蒙版与导出都保存在本机，云端只在生成候选或局部修复时使用。
        设置页写入的配置也留在本机，不写浏览器存储，不需要登录。
      </p>
      <dl class="st-facts st-facts--about">
        <div><dt>数据位置</dt><dd>本机 <span class="mono">storage/api/</span></dd></div>
        <div><dt>密钥</dt><dd>仅本机配置 · 不回显完整内容</dd></div>
        <div><dt>浏览器存储</dt><dd>不使用 · 刷新后从服务端重新读取</dd></div>
        <div><dt>云端</dt><dd>默认关闭 · 不影响本地处理</dd></div>
      </dl>
      <p class="field__hint">
        当前配置修订 <span class="mono" data-revision>${revLabel(record)}</span>；
        「保存设置」只在本机写回配置，不会立即验证密钥，也不会自动发起云端调用。
      </p>
      <div class="st-about__acts">
        <a class="btn btn--ghost btn--sm" href="/legacy/" target="_blank" rel="noopener">
          ${icon("external")}打开旧版工作台（只读对照）
        </a>
        <a class="btn btn--quiet btn--sm" href="#/library">去纹样库</a>
        <a class="btn btn--quiet btn--sm" href="#/notes">使用说明</a>
      </div>
      <p class="field__hint">旧版前端只用于只读对照，新前端不依赖它的任何文件。</p>
    </div>
  </section>`;
}

/* ---------- 表单读取 / 未保存状态 ---------- */

function currentForm(page) {
  const raw = (name) => {
    const el = page.querySelector(`[data-cfg="${name}"]`);
    return el ? el.value : "";
  };
  const budgetRaw = raw("budget").trim();
  const reservationRaw = raw("reservation").trim();
  const callsRaw = raw("max_calls").trim();
  return {
    model: raw("model").trim(),
    baseUrl: raw("base_url").trim(),
    budgetRaw,
    reservationRaw,
    callsRaw,
    budget: budgetRaw === "" ? NaN : Number(budgetRaw),
    reservation: reservationRaw === "" ? NaN : Number(reservationRaw),
    maxCalls: callsRaw === "" ? NaN : Number(callsRaw),
    paid: switchValue(page, "paid_calls_enabled"),
    pricing: switchValue(page, "pricing_confirmed"),
    keyValue: raw("api_key").trim(),
    keyAction: pendingClear ? "clear" : "keep",
  };
}

function snapshotOf(record) {
  return {
    model: String(record?.model || ""),
    baseUrl: String(record?.base_url || ""),
    budget: Number(record?.budget_cents || 0) / 100,
    reservation: Number(record?.reservation_cents || 0) / 100,
    maxCalls: Number(record?.max_calls || 1),
    paid: Boolean(record?.paid_calls_enabled),
    pricing: Boolean(record?.pricing_confirmed),
    keyAction: "keep",
  };
}

function numberChanged(now, base) {
  return !(Number.isFinite(now) && now === base);
}

function changedFields(page) {
  const now = currentForm(page);
  if (!baseline) return { now, keys: [] };
  const keys = [];
  if (now.model !== baseline.model) keys.push("model");
  if (now.baseUrl !== baseline.baseUrl) keys.push("base_url");
  if (numberChanged(now.budget, baseline.budget)) keys.push("budget_cents");
  if (numberChanged(now.reservation, baseline.reservation)) keys.push("reservation_cents");
  if (numberChanged(now.maxCalls, baseline.maxCalls)) keys.push("max_calls");
  if (now.paid !== baseline.paid) keys.push("paid_calls_enabled");
  if (now.pricing !== baseline.pricing) keys.push("pricing_confirmed");
  if (now.keyValue || now.keyAction !== baseline.keyAction) keys.push("api_key");
  return { now, keys };
}

function showError(page, message) {
  const el = page.querySelector("[data-st-error]");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function clearError(page) {
  const el = page.querySelector("[data-st-error]");
  if (!el) return;
  el.textContent = "";
  el.hidden = true;
}

function paintSaveState(page) {
  if (!page || !page.isConnected) return;
  const { keys } = changedFields(page);
  const dirty = keys.length;
  const saveButton = page.querySelector('[data-act="save"]');
  const resetButton = page.querySelector('[data-act="reset"]');
  const reloadButton = page.querySelector('[data-act="reload"]');
  const note = page.querySelector("[data-st-note]");
  const bar = page.querySelector(".st-savebar");
  const blocked = !settings();

  if (saveButton) saveButton.disabled = dirty === 0 || saving || stale || blocked;
  if (resetButton) resetButton.disabled = dirty === 0 || saving;
  if (reloadButton) reloadButton.hidden = !stale;
  if (bar) {
    bar.classList.toggle("is-busy", saving);
    bar.classList.toggle("is-stale", stale);
  }
  if (!note) return;
  note.dataset.dirty = String(dirty > 0 && !saving);
  const text = saving
    ? "保存中…"
    : stale
      ? "设置已被其他操作更新 · 请重新加载"
      : dirty
        ? `未保存的修改 · ${dirty} 处`
        : page.dataset.saved === "true"
          ? "已保存 · 已写入本机配置"
          : "尚未修改 · 保存写入本机配置";
  if (note.textContent !== text) note.textContent = text;
}

function flashSaved(page) {
  const bar = page.querySelector(".st-savebar");
  if (!bar) return;
  bar.classList.add("is-saved");
  timers.push(
    setTimeout(() => {
      if (document.body.contains(bar)) bar.classList.remove("is-saved");
    }, 1800)
  );
}

/* ---------- 派生读数 ---------- */

function paintKeyState(page) {
  const record = settings();
  const configured = Boolean(record && record.api_key_configured);
  const state = page.querySelector("[data-key-state]");
  const chip = page.querySelector("[data-key-chip]");
  const clearButton = page.querySelector('[data-act="clear-key"]');
  const hint = page.querySelector("[data-key-hint]");
  const headChip = page.querySelector("[data-head-key]");

  if (state) {
    state.textContent = pendingClear
      ? "已标记清除 · 保存后生效"
      : configured
        ? "已配置 · 仅存本机"
        : "未配置";
  }
  if (chip) {
    chip.textContent = pendingClear ? "待清除" : configured ? "已配置" : "未配置";
    chip.classList.toggle("chip--jade", configured && !pendingClear);
    chip.classList.toggle("chip--gold", !configured || pendingClear);
  }
  if (clearButton) {
    clearButton.textContent = pendingClear ? "撤销清除" : "清除密钥";
    clearButton.setAttribute("aria-pressed", String(pendingClear));
  }
  if (hint) {
    hint.textContent = pendingClear
      ? "保存设置后会清除本机保存的密钥；保存前可再次点击按钮撤销。"
      : "密钥只保存在本机配置，页面不会回显完整内容；替换时填写新值即可。";
  }
  if (headChip) {
    headChip.textContent = pendingClear ? "密钥待清除" : configured ? "密钥已配置" : "密钥未配置";
  }
}

function paintBlockers(page) {
  const wrap = page.querySelector("[data-blockers-wrap]");
  if (wrap) wrap.innerHTML = blockersHtml(settings());
  const headCloud = page.querySelector("[data-head-cloud]");
  if (headCloud) {
    const count = (settings()?.blockers || []).length;
    headCloud.textContent = count ? `云端不可用 · ${count} 项` : "云端配置就绪";
    headCloud.classList.toggle("chip--gold", count > 0);
    headCloud.classList.toggle("chip--jade", count === 0);
  }
}

function paintBudgetFacts(page) {
  const wrap = page.querySelector("[data-budget-facts]");
  if (wrap) wrap.outerHTML = budgetFactsHtml();
}

function paintRevision(page) {
  const el = page.querySelector("[data-revision]");
  if (el) el.textContent = revLabel(settings());
}

function paintCostWarning(page) {
  const form = currentForm(page);
  const warnings = [];
  if (form.budgetRaw !== "" && (!Number.isFinite(form.budget) || form.budget < 0)) {
    warnings.push("预算请填写 0–1,000,000 元之间的金额");
  } else if (Number.isFinite(form.budget) && form.budget <= 0) {
    warnings.push("预算为 0 元：云端调用会被拒绝");
  }
  if (form.reservationRaw !== "" && !Number.isFinite(form.reservation)) {
    warnings.push("单次预留请填写 0–1,000,000 元之间的金额");
  } else if (Number.isFinite(form.reservation) && form.reservation <= 0) {
    warnings.push("单次预留为 0 元：云端调用会被拒绝");
  } else if (Number.isFinite(form.reservation) && Number.isFinite(form.budget) && form.reservation > form.budget) {
    warnings.push("单次预留高于预算上限，云端调用会被拒绝");
  }
  if (form.callsRaw !== "" && (!Number.isFinite(form.maxCalls) || form.maxCalls < 1)) {
    warnings.push("最大调用次数需在 1–100 之间");
  }
  if (!form.paid) warnings.push("付费开关已关闭：云端调用会被拒绝");
  if (!form.pricing) warnings.push("价格尚未确认：云端调用会被拒绝");

  const el = page.querySelector("[data-cost-warning]");
  if (!el) return;
  const text = warnings.join("；");
  if (el.textContent !== text) el.textContent = text;
  el.hidden = !text;
}

function paintLocal(page) {
  const wrap = page.querySelector("[data-local-wrap]");
  if (wrap) wrap.outerHTML = localSection();
}

/* ---------- 保存 / 放弃 / 重新加载 ---------- */

function yuanToCents(raw) {
  const text = String(raw || "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return null;
  return Math.round(amount * 100);
}

function intInRange(raw, min, max) {
  const text = String(raw || "").trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

async function saveForm(page, api) {
  if (saving || stale) return;
  const record = settings();
  if (!record || !Number.isInteger(record.revision)) {
    showError(page, "设置尚未加载完成，请重新加载后再保存。");
    return;
  }

  const { now, keys } = changedFields(page);
  clearError(page);
  if (!keys.length) {
    api.toast("没有需要保存的修改", "info");
    return;
  }

  const problems = [];
  const payload = { revision: record.revision };

  if (keys.includes("model")) {
    if (!now.model) problems.push("模型名不能为空。");
    else payload.model = now.model;
  }
  if (keys.includes("base_url")) {
    if (!now.baseUrl) problems.push("接口地址不能为空。");
    else payload.base_url = now.baseUrl;
  }
  if (keys.includes("budget_cents")) {
    const cents = yuanToCents(now.budgetRaw);
    if (cents === null) problems.push("预算请填写 0–1,000,000 元之间的金额，最多两位小数。");
    else payload.budget_cents = cents;
  }
  if (keys.includes("reservation_cents")) {
    const cents = yuanToCents(now.reservationRaw);
    if (cents === null) problems.push("单次预留请填写 0–1,000,000 元之间的金额，最多两位小数。");
    else payload.reservation_cents = cents;
  }
  if (keys.includes("max_calls")) {
    const calls = intInRange(now.callsRaw, 1, 100);
    if (calls === null) problems.push("最大调用次数需为 1–100 的整数。");
    else payload.max_calls = calls;
  }
  if (keys.includes("paid_calls_enabled")) payload.paid_calls_enabled = now.paid;
  if (keys.includes("pricing_confirmed")) payload.pricing_confirmed = now.pricing;
  if (keys.includes("api_key")) {
    if (now.keyValue) {
      if (!/^[\x21-\x7E]+$/.test(now.keyValue)) {
        problems.push("API Key 只能包含可见 ASCII 字符，且不能含空格。");
      } else {
        payload.api_key_action = "replace";
        payload.api_key = now.keyValue;
      }
    } else if (now.keyAction === "clear") {
      payload.api_key_action = "clear";
    } else {
      payload.api_key_action = "keep";
    }
  }

  if (problems.length) {
    showError(page, problems.join(" "));
    return;
  }

  saving = true;
  page.dataset.saving = "true";
  paintSaveState(page);
  try {
    const next = await store.saveSettings(payload);
    afterSave(page, next, api);
  } catch (error) {
    handleSaveError(page, error, api);
  } finally {
    saving = false;
    if (ctx && ctx.page === page) {
      delete page.dataset.saving;
      paintSaveState(page);
    }
  }
}

function afterSave(page, record, api) {
  pendingClear = false;
  stale = false;
  const keyInput = page.querySelector('[data-cfg="api_key"]');
  if (keyInput) keyInput.value = "";
  baseline = snapshotOf(record);
  page.dataset.saved = "true";
  paintKeyState(page);
  paintBlockers(page);
  paintBudgetFacts(page);
  paintRevision(page);
  paintCostWarning(page);
  paintSaveState(page);
  flashSaved(page);
  api.toast("设置已保存", "done");
}

function handleSaveError(page, error, api) {
  const code = error?.code || "";
  if (error?.status === 409 || code === "STALE_SETTINGS") {
    stale = true;
    const message = "设置已被其他操作更新，请重新加载后再保存。";
    showError(page, message);
    api.toast("设置已被其他操作更新，请重新加载", "warn");
    paintSaveState(page);
    return;
  }
  showError(page, error?.message || "保存设置失败，请稍后重试。");
  api.toast(error?.message || "保存设置失败", "warn");
}

function resetForm(page, api) {
  if (!baseline) return;
  clearError(page);
  pendingClear = false;
  const put = (name, value) => {
    const el = page.querySelector(`[data-cfg="${name}"]`);
    if (el) el.value = String(value);
  };
  put("model", baseline.model);
  put("base_url", baseline.baseUrl);
  put("budget", baseline.budget.toFixed(2));
  put("reservation", baseline.reservation.toFixed(2));
  put("max_calls", baseline.maxCalls);
  put("api_key", "");
  setSwitch(page, "paid_calls_enabled", baseline.paid);
  setSwitch(page, "pricing_confirmed", baseline.pricing);
  page.dataset.saved = "false";
  paintKeyState(page);
  paintCostWarning(page);
  paintSaveState(page);
  api.toast("已放弃未保存的修改", "info");
}

async function reloadSettings(page, api) {
  stale = false;
  clearError(page);
  paintSaveState(page);
  await store.loadSettings();
  if (!ctx || ctx.page !== page) return;
  if (store.settingsError) {
    showError(page, store.settingsError);
    paintSaveState(page);
    return;
  }
  api.refresh();
}

/* ---------- 开关 / 密钥 / 目录 ---------- */

function toggleSwitch(button, page) {
  const on = button.getAttribute("aria-checked") === "true";
  button.setAttribute("aria-checked", String(!on));
  paintCostWarning(page);
  paintSaveState(page);
}

function toggleClearKey(page, api) {
  if (pendingClear) {
    pendingClear = false;
  } else {
    if (!settings()?.api_key_configured) {
      api.toast("当前未配置 API Key，无需清除", "info");
      return;
    }
    pendingClear = true;
    const keyInput = page.querySelector('[data-cfg="api_key"]');
    if (keyInput) keyInput.value = "";
  }
  paintKeyState(page);
  paintSaveState(page);
}

/* ---------- 目录滚动 ---------- */

function paintNav(page, id) {
  page.querySelectorAll("[data-nav-to]").forEach((el) => {
    if (el.dataset.navTo === id) el.setAttribute("aria-current", "location");
    else el.removeAttribute("aria-current");
  });
  const list = page.querySelector(".st-nav__list");
  const active = page.querySelector(`[data-nav-to="${id}"]`);
  if (!list || !active || list.scrollWidth <= list.clientWidth) return;
  const listRect = list.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  const delta = activeRect.left - listRect.left - (listRect.width - activeRect.width) / 2;
  if (Math.abs(delta) < 6) return;
  list.scrollBy({ left: delta, behavior: prefersReduced() ? "auto" : "smooth" });
}

function scrollToSection(page, id) {
  const target = page.querySelector(`[data-sec="${id}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: prefersReduced() ? "auto" : "smooth", block: "start" });
  paintNav(page, id);
  page.querySelector(`[data-nav-to="${id}"]`)?.focus({ preventScroll: true });
}

function initScrollSpy(page) {
  const sections = [...page.querySelectorAll("[data-sec]")];
  if (!sections.length) return;
  const update = () => {
    const topbar = document.querySelector(".topbar");
    const offset = (topbar ? topbar.getBoundingClientRect().height : 68) + 110;
    let current = sections[0].dataset.sec;
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= offset) current = section.dataset.sec;
    }
    paintNav(page, current);
  };
  const onScroll = () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(update);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  scrollHandler = onScroll;
  update();
}

/* ---------- 读取中 / 读取失败 ---------- */

function stateSection() {
  const error = store.settingsError;
  if (error) {
    return `
    <div class="st-state st-state--error" role="alert">
      <span class="st-state__icon" aria-hidden="true">${icon("alert")}</span>
      <p class="st-state__title">设置读取失败</p>
      <p class="st-state__copy">${esc(error)}</p>
      <button class="btn btn--ghost btn--sm" type="button" data-act="retry-settings">
        ${icon("history")}重新读取
      </button>
    </div>`;
  }
  return `
  <div class="st-state" role="status">
    <span class="st-state__spinner" aria-hidden="true"></span>
    <p class="st-state__title">正在读取本机设置…</p>
    <p class="st-state__copy">配置来自本机服务 /api/v1/settings。</p>
  </div>`;
}

function bindRetry(page, api) {
  page.addEventListener("click", (event) => {
    if (!event.target.closest('[data-act="retry-settings"]')) return;
    store.loadSettings().then(() => {
      if (ctx && ctx.page === page) api.refresh();
    });
  });
}

/* ---------- 视图模块 ---------- */

export default {
  id: "settings",
  title: "设置",

  render() {
    pendingClear = false;
    const record = settings();
    return `
    <div class="st-page">
      <div class="wrap">
        ${headHtml(record)}
        <div class="st-body">
          ${navHtml()}
          <div class="st-sections">
            ${
              record
                ? `${cloudSection(record)}
                   ${costSection(record)}
                   <section class="st-sec" id="st-local" data-sec="local" aria-labelledby="st-local-title">
                     ${secHead("03", "本机处理", "只读 · 原件不出本机", "st-local-title")}
                     <div class="st-sec__body">${localSection()}</div>
                   </section>
                   ${aboutSection(record)}`
                : stateSection()
            }
          </div>
        </div>
      </div>
      ${record ? savebarHtml() : ""}
    </div>`;
  },

  mount(root, state, api) {
    const page = root.querySelector(".st-page");
    if (!page) return;
    ctx = { page, api };

    if (!store.settings) {
      bindRetry(page, api);
      if (store.settingsError) return;
      (async () => {
        await Promise.all([store.loadSettings(), store.health ? null : store.loadHealth()]);
        if (!ctx || ctx.page !== page) return;
        api.refresh();
      })();
      return;
    }

    baseline = snapshotOf(store.settings);
    stale = false;
    saving = false;
    clearError(page);
    paintKeyState(page);
    paintCostWarning(page);
    paintSaveState(page);

    if (!store.health) {
      store.loadHealth().then(() => {
        if (ctx && ctx.page === page) {
          paintLocal(page);
          paintSaveState(page);
        }
      });
    }

    storeUnsubscribe = store.subscribe((reason) => {
      if (reason === "health" && ctx && ctx.page === page) paintLocal(page);
    });

    /* 输入：只改本页 DOM，保留焦点；不整页重绘 */
    page.querySelectorAll("[data-cfg]").forEach((el) => {
      if (el.matches("button")) return;
      const onEdit = () => {
        if (el.dataset.cfg === "api_key") {
          if (el.value.trim() && pendingClear) pendingClear = false;
          paintKeyState(page);
        }
        paintCostWarning(page);
        paintSaveState(page);
      };
      el.addEventListener("input", onEdit);
      el.addEventListener("change", onEdit);
    });

    const keyForm = page.querySelector("[data-key-form]");
    if (keyForm) {
      keyForm.addEventListener("submit", (event) => {
        event.preventDefault();
        saveForm(page, api);
      });
    }

    page.addEventListener("click", (event) => {
      const nav = event.target.closest("[data-nav-to]");      if (nav) {
        scrollToSection(page, nav.dataset.navTo);
        return;
      }
      const toggle = event.target.closest(".switch[data-cfg]");
      if (toggle) {
        toggleSwitch(toggle, page);
        return;
      }
      const action = event.target.closest("[data-act]");
      if (!action || !page.contains(action)) return;
      switch (action.dataset.act) {
        case "save":
          saveForm(page, api);
          break;
        case "reset":
          resetForm(page, api);
          break;
        case "reload":
          reloadSettings(page, api);
          break;
        case "clear-key":
          toggleClearKey(page, api);
          break;
        default:
          break;
      }
    });

    initScrollSpy(page);
  },

  unmount() {
    if (scrollHandler) {
      window.removeEventListener("scroll", scrollHandler);
      scrollHandler = null;
    }
    cancelAnimationFrame(scrollFrame);
    timers.forEach((timer) => clearTimeout(timer));
    timers = [];
    storeUnsubscribe?.();
    storeUnsubscribe = null;
    baseline = null;
    pendingClear = false;
    saving = false;
    stale = false;
    ctx = null;
  },
};

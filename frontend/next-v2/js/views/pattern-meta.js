/* =============================================================================
   views/pattern-meta.js — 纹样资料（等级与来源）编辑抽屉。

   资料属于整张纹样（原图组）：工作台与纹样库共用同一个 PATCH
   `/api/v1/patterns/{image_id}`。等级是人工评定，会覆盖按清晰度/对比度的
   自动结果并标记 grade_version=manual-v1；来源只作人工声明。
   ============================================================================= */

import { api as http } from "../api.js";
import { icon } from "../icons.js";
import { escapeHtml as esc, shortId } from "../format.js";

const GRADE_OPTIONS = [
  ["U", "未评定"],
  ["A", "A 级"],
  ["B", "B 级"],
  ["C", "C 级"],
];

const cleanType = (meta) => {
  const value = String(meta?.source_type || "").trim();
  return value && value !== "未确认" ? value : "";
};

/** 打开资料编辑抽屉；onSaved 收到 PATCH 结果。 */
export function openPatternMetaDrawer({ api, imageId, name = "", meta = {}, sourceNote = "", onSaved = null }) {
  if (!imageId || typeof api?.drawer !== "function") return null;
  const grade = String(meta.grade || "U").toUpperCase();
  const body = `
    <p class="drawer-lead">资料属于整张纹样（原图组）：保存后工作台与纹样库显示同一份等级与来源；已生成的版本保留各自的生成记录。</p>
    <div class="field">
      <label class="field__label" for="pm-grade"><span>等级</span></label>
      <select class="select" id="pm-grade" data-pm-grade>
        ${GRADE_OPTIONS.map(
          ([value, text]) => `<option value="${value}"${value === grade ? " selected" : ""}>${text}</option>`
        ).join("")}
      </select>
      <p class="field__hint">手动选择会覆盖按清晰度/对比度的自动评定，并标记为「人工评定」。</p>
    </div>
    <div class="field">
      <label class="field__label" for="pm-source-type"><span>来源类型</span></label>
      <input class="input" id="pm-source-type" data-pm-source-type maxlength="32"
        value="${esc(cleanType(meta))}" placeholder="如：博物馆藏品、出版物、自采" autocomplete="off" />
    </div>
    <div class="field">
      <label class="field__label" for="pm-source-name"><span>来源名称</span></label>
      <input class="input" id="pm-source-name" data-pm-source-name maxlength="200"
        value="${esc(meta.source_name || "")}" placeholder="如：敦煌研究院" autocomplete="off" />
      <p class="field__hint">没有单独登记纹样名称时，这里也会作为纹样标题显示。</p>
    </div>
    <div class="field">
      <label class="field__label" for="pm-source-url"><span>来源链接</span></label>
      <input class="input" id="pm-source-url" data-pm-source-url maxlength="500"
        value="${esc(meta.source_url || "")}" placeholder="https://…" inputmode="url" autocomplete="off" />
    </div>
    <div class="field">
      <label class="field__label" for="pm-source-note"><span>来源备注</span></label>
      <textarea class="textarea" id="pm-source-note" data-pm-source-note maxlength="1000" rows="3"
        placeholder="馆藏编号、采集说明等">${esc(sourceNote || "")}</textarea>
    </div>
    <div class="drawer-actions">
      <button class="btn btn--primary btn--sm" type="button" data-pm-save>${icon("check")}保存资料</button>
      <button class="btn btn--quiet btn--sm" type="button" data-pm-cancel>取消</button>
    </div>
    <p class="drawer-foot">来源只作人工声明，不会自动核验；全部留空会回到「来源未登记」。链接只接受 http(s) 地址。</p>
  `;
  const el = api.drawer({
    title: `资料 · ${esc(name || "未命名纹样")}`,
    meta: `#${esc(shortId(imageId))} · 等级与来源`,
    body,
  });
  if (!el) return null;

  el.addEventListener("click", async (event) => {
    if (event.target.closest("[data-pm-cancel]")) {
      api.closeDrawer();
      return;
    }
    const save = event.target.closest("[data-pm-save]");
    if (!save) return;
    const value = (selector) => String(el.querySelector(selector)?.value || "").trim();
    save.disabled = true;
    try {
      const result = await http.updatePatternMeta(imageId, {
        grade: value("[data-pm-grade]") === grade ? "" : value("[data-pm-grade]"),
        source_type: value("[data-pm-source-type]"),
        source_name: value("[data-pm-source-name]"),
        source_url: value("[data-pm-source-url]"),
        source_note: value("[data-pm-source-note]"),
      });
      api.closeDrawer();
      api.toast("纹样资料已保存。", "done");
      await onSaved?.(result);
    } catch (error) {
      save.disabled = false;
      api.toast(error?.message || "资料保存失败，请稍后再试。", "warn");
    }
  });
  return el;
}

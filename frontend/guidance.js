"use strict";

/* Plain-language guidance for the current workspace.
 *
 * Explains what to do next, why an action is unavailable, where results appear
 * and what to do after a failure. It is a pure projection of page state and
 * never triggers jobs, uploads or paid calls.
 */

function step(key, label, state, detail) {
  return { key, label, state, detail: detail || "" };
}

function firstCurrent(steps) {
  let seen = false;
  return steps.map((item) => {
    if (item.state === "current" && !seen) {
      seen = true;
      return item;
    }
    if (item.state === "current") return { ...item, state: "todo" };
    return item;
  });
}

export function buildGuidance(context = {}) {
  const hasInput = Boolean(context.hasInput);
  const tooLarge = Boolean(context.tooLarge);
  const preview = context.preview || { state: "none" };
  const task = context.task || { state: "" };
  const taskState = String(task.state || "").toLowerCase();
  const previewState = String(preview.state || "none");
  const hasMask = Boolean(context.hasMaskPairs);
  const hasTransparent = Boolean(context.hasTransparent);
  const hasSvg = Boolean(context.hasSvg);
  const hasResult = Boolean(context.hasResult);
  const versionCount = Number(context.versionCount) || 0;

  let headline = "先放入一张纹样";
  let detail = "上传 PNG 或 JPEG 后，原文件保留，规范输入另存；之后可选择提取方式。";
  let tone = "idle";

  if (tooLarge) {
    headline = "当前图超过本地处理上限";
    detail = "不会自动缩小。请在“来源 → 工作副本”明确设置像素上限，再继续提取。";
    tone = "warning";
  } else if (taskState === "queued" || taskState === "running") {
    const label = task.label || "任务";
    if (task.cancelBusy) {
      headline = "正在请求取消「" + label + "」…";
      detail = "等待服务端给出真实终态。取消与成功同时发生时，页面以服务端返回的状态为准。";
      tone = "working";
    } else if (task.cancelSupported) {
      headline = "正在处理「" + label + "」";
      detail = "可以等待，或在任务条请求取消。取消只停止这次本地处理：恢复处理起点，已完成步骤留在历史中。";
      tone = "working";
    } else {
      headline = "正在处理「" + label + "」";
      detail = task.cancelReason || "此任务暂不支持取消，请等待真实终态；页面不会自动重发。";
      tone = "working";
    }
  } else if (previewState === "ready") {
    headline = "预览已生成，尚未应用";
    detail = "应用后才会写入版本并切换工作区；放弃不会删除已生成的任务和文件，也不会自动应用。";
    tone = "ready";
  } else if (previewState === "pending") {
    headline = "正在生成「" + (preview.label || "预览") + "」…";
    detail = "预览只关联当前图片和当前参数修订。可等待，或在任务条请求取消；结果不会自动应用。";
    tone = "working";
  } else if (previewState === "stale" || previewState === "expired") {
    headline = previewState === "expired" ? "预览已过期，不能应用" : "参数或图片已更新，此预览不能应用";
    detail = "画布上的旧预览不会覆盖新参数。请重新执行一次预览，或放弃后回到当前输入。";
    tone = "warning";
  } else if (previewState === "failed") {
    headline = "预览生成失败，工作区未改变";
    detail = "失败不会删除已有成果。检查参数或输入后可重新预览；历史中保留失败记录。";
    tone = "warning";
  } else if (taskState === "failed") {
    headline = "上一步任务失败";
    detail = "已有成果保持有效。先检查错误原因与输入，再决定重试或调整参数；AI／付费任务不会自动重发。";
    tone = "warning";
  } else if (taskState === "cancelled") {
    headline = "任务已取消，未应用到工作区";
    detail = "处理起点已恢复，已完成的中间成果留在历史中。需要继续时重新执行会创建新任务，原记录不覆盖。";
    tone = "warning";
  } else if (!hasInput) {
    headline = "先放入一张纹样";
    detail = "支持 PNG 或 JPEG。上传后原图与规范输入都会保留，可从“处理”开始本地提取。";
    tone = "idle";
  } else if (hasTransparent && !hasSvg) {
    headline = "透明成果已可用，可继续矢量化或精修蒙版";
    detail = "提取成果在左栏版本区。若要修正边缘，先打开蒙版画笔；满意后再生成 SVG。";
    tone = "ready";
  } else if (hasSvg) {
    headline = "已生成矢量成果";
    detail = "在左栏版本区预览或下载。SVG 调色与颜色替换留待后续切片；本轮可继续导出 ZIP。";
    tone = "done";
  } else if (hasResult) {
    headline = "成果已归档，可预览并决定下一步";
    detail = "将需要的版本“设为当前输入”后继续处理；勾选版本可打包 ZIP。";
    tone = "ready";
  } else {
    headline = "当前输入已就绪，可开始本地提取";
    detail = "建议先用“预览”检查效果：满意后应用；不满意就放弃并调整参数，不产生正式版本。";
    tone = "ready";
  }

  if (context.hasTransparency === true && context.extractMode === "alpha") {
    detail += " 检测到透明输入：Alpha 模式保留源透明通道，处理前后接近是正常保真，不是没有处理。";
  } else if (context.hasTransparency === true) {
    detail += " 检测到透明输入：若可见图形被大量去掉，优先改用“既有 Alpha”保留原透明。";
  }
  if (["adaptive_mean", "adaptive_gaussian", "sauvola"].includes(context.extractMode)) {
    detail += " 局部阈值适合光照不均的细线，也可能掏空大面积色块；请与 Alpha/Otsu 对照。";
  }

  const steps = firstCurrent([
    step("source", "来源", hasInput ? "done" : "current", hasInput ? "原图与规范输入已保留" : "PNG / JPEG"),
    step("prepare", "准备", hasInput ? (tooLarge ? "blocked" : "done") : "todo", tooLarge ? "需显式创建工作副本" : "裁切或轻增强"),
    step("extract", "提取", hasMask || hasTransparent ? "done" : hasInput && !tooLarge ? "current" : "todo", "前景蒙版与透明 PNG"),
    step("refine", "精修", hasMask ? "done" : "todo", hasMask ? "可逐笔修正蒙版" : "提取后可修正"),
    step("vector", "矢量", hasSvg ? "done" : hasTransparent ? "current" : "todo", hasSvg ? "SVG 已生成" : "透明成果转 SVG"),
    step("export", "导出", "todo", versionCount ? "勾选版本打包 ZIP" : "成果可下载")
  ]);

  let failure = null;
  if (taskState === "failed" || taskState === "cancelled") {
    failure = {
      title: taskState === "cancelled" ? "取消后的状态" : "失败后的下一步",
      lines: taskState === "cancelled"
        ? [
            "取消不会删除已完成的步骤或确认成果。",
            "中间成果标为未完成，不会自动成为当前输入。",
            "重新执行会创建新任务，保留原记录以便对照。"
          ]
        : [
            "失败不会删除已有版本；旧成果仍可下载。",
            "检查输入尺寸、框选与提取参数后重新执行。",
            "只有服务端允许的本地失败任务才显示重试；收费任务不会自动重发。",
            "历史抽屉保留任务编号与原始错误。"
          ]
    };
  } else if (previewState === "stale" || previewState === "expired") {
    failure = {
      title: "为什么不能应用",
      lines: [
        "预览绑定生成时的参数修订号与输入图片。",
        "参数或图片变化后，旧结果不能代表当前设置。",
        "重新预览即可获得与当前参数一致的结果。"
      ]
    };
  }

  const blocked = Array.isArray(context.blocked)
    ? context.blocked.filter((item) => item && item.reason)
    : [];

  return {
    tone,
    headline,
    detail,
    steps,
    failure,
    blocked,
    locations: versionCount
      ? "成果在左栏版本区；未应用预览只显示在画布。任务状态在底部状态条，历史抽屉保留原始记录。"
      : "成果会出现在左栏版本区；未应用预览只显示在画布。任务状态在底部状态条。",
    undo: context.canUndo
      ? "可按 Ctrl+Z 撤销当前图片的上一步编辑；Ctrl+Shift+Z 或 Ctrl+Y 重做。"
      : "当前图片暂无可撤销的编辑。"
  };
}

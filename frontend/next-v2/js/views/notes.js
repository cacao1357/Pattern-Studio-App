/* =============================================================================
   views/notes.js — 使用说明：这套本机工作台是什么、八道工序怎么用、
   数据与安全边界、已知限制、旧版入口。
   ============================================================================= */

import { icon } from "../icons.js";

const STAGE_GUIDE = [
  ["01 来源", "上传 PNG / JPEG，保留原件并生成规范输入；记录评级、来源与指纹。", "原图、规范输入"],
  ["02 裁切", "在真实图版上框出纹样单元；大图可先创建工作副本，避免超过像素上限。", "裁切图、工作副本"],
  ["03 修复", "可选：云端修复会上传当前整张输入与框坐标，并按次计费；本地 LeftRefill 在本机执行、不上传、不计费。生成候选后接受或拒绝，纹样完整可直接跳过。", "修复候选、接受记录"],
  ["04 候选", "云端按提示词拆分图层，提交会上传并按次计费；勾选后在本地合成，不生成线稿。", "候选层、合成候选"],
  ["05 处理", "选本地模型、云端线稿（上传并按次计费）、OpenCV 或颜色提取；颜色提取生成带透明背景的 PNG。", "线稿 PNG、透明 PNG"],
  ["06 蒙版", "线稿先「准备蒙版」得到可编辑透明 PNG；用笔刷补前景或擦除杂点，提交后生成新的透明 PNG。", "修正后的透明 PNG"],
  ["07 矢量化", "把线稿或透明 PNG 转成可编辑 SVG；颜色与细节在这一步调整。", "矢量 SVG"],
  ["08 平铺", "选单元生成 2×2 / 3×3 排列，记录接缝观察，并把成果打包成 ZIP。", "平铺预览、ZIP 包"],
];

const SHORTCUTS = [
  ["1 – 8", "在工作台切换八道工序"],
  ["[ / ]", "在当前会话的纹样之间前后切换"],
  ["C", "开关对比（当前纹样与同图原件）"],
  ["Ctrl / ⌘ K", "打开命令面板，搜索页面、工序与操作"],
  ["Esc", "关闭抽屉、命令面板或导览"],
];

export default {
  id: "notes",
  title: "使用说明",

  render() {
    return `
      <div class="notes">
        <section class="notes-hero wrap wrap--tight">
          <h1 class="title notes-hero__title">从原图到可编辑 SVG，八道工序各有产物。</h1>
          <p class="lead notes-hero__lead">
            上传后按工序推进，任意一步都可以重跑。
          </p>
        </section>

        <section class="section">
          <div class="wrap">
            <header class="sec-head">
              <div class="sec-head__main">
                <h2 class="section-title">每一步在做什么</h2>
              </div>
              <p class="sec-head__aside">不必按顺序走完，从任意一道工序都能进入。</p>
            </header>
            <div class="notes-table notes-table--three" role="table" aria-label="八道工序说明">
              <div class="notes-table__row notes-table__row--head" role="row">
                <span role="columnheader">工序</span><span role="columnheader">做什么</span><span role="columnheader">主要产物</span>
              </div>
              ${STAGE_GUIDE.map(
                ([stage, what, out]) =>
                  `<div class="notes-table__row" role="row"><span role="cell" class="notes-table__k">${stage}</span><span role="cell">${what}</span><span role="cell">${out}</span></div>`
              ).join("")}
            </div>
            <p class="notes-foot">到「任务」查看进度和失败原因。</p>
          </div>
        </section>

        <section class="section">
          <div class="wrap">
            <header class="sec-head">
              <div class="sec-head__main">
                <h2 class="section-title">常用的几个动作</h2>
              </div>
              <p class="sec-head__aside">单张上传在工作台顶栏；「从库选图」与「批量导入」在纹样列。</p>
            </header>
            <div class="notes-why">
              <article class="card notes-why__card" data-reveal>
                <p class="label">页面</p>
                <ul class="notes-list">
                  <li><a href="#/home">首页</a>：最近成果、接着上次、八道工序与云端说明</li>
                  <li><a href="#/workbench">工作台</a>：四栏——文档与工序、纹样、图版、参数</li>
                  <li><a href="#/library">纹样库</a>：纹样的分页、筛选与档案</li>
                  <li><a href="#/tasks">任务</a>：本机任务索引与详情</li>
                  <li><a href="#/settings">设置</a>：云端 API Key、本机状态与版本</li>
                </ul>
              </article>
              <article class="card notes-why__card notes-why__card--accent" data-reveal style="--i:1">
                <p class="label">快捷键</p>
                <dl class="notes-kbd">
                  ${SHORTCUTS.map(([key, text]) => `<div><dt><span class="kbd">${key}</span></dt><dd>${text}</dd></div>`).join("")}
                </dl>
              </article>
              <article class="card notes-why__card" data-reveal style="--i:2">
                <p class="label">任务与结果</p>
                <ul class="notes-list">
                  <li>任务失败时显示后端错误原因；可换更小的图或降低细节重试</li>
                  <li>导出的 ZIP 包含所选纹样、清单与来源信息</li>
                </ul>
              </article>
            </div>
          </div>
        </section>

        <section class="section">
          <div class="wrap">
            <header class="sec-head">
              <div class="sec-head__main">
                <h2 class="section-title">数据在哪，哪里会花钱</h2>
              </div>
              <p class="sec-head__aside">下面这些可以直接核对。</p>
            </header>
            <div class="notes-table" role="table" aria-label="数据与安全边界">
              <div class="notes-table__row notes-table__row--head" role="row">
                <span role="columnheader">边界</span><span role="columnheader">现状</span>
              </div>
              ${[
                ["运行方式", "只监听 127.0.0.1:8765；同源、无登录，只适合本机使用"],
                ["数据位置", "图片、任务、纹样与 SQLite 历史都在 storage/api/；保留该目录即可保留数据"],
                ["密钥", "保存在本机服务配置里，接口只返回「是否已配置」，不回显明文"],
                ["云端", "03 云端修复、04 候选与 05 云端线稿在点按钮后上传当前输入并按次计费；本地 LeftRefill、本地模型线稿、OpenCV 与颜色提取不调用云端"],
                ["旧前端", "旧版页面连接同一个本机服务与 storage/api/ 数据；它不是只读副本，在旧版里的改动同样写入这份数据"],
              ]
                .map(
                  ([k, v]) =>
                    `<div class="notes-table__row" role="row"><span role="cell" class="notes-table__k">${k}</span><span role="cell">${v}</span></div>`
                )
                .join("")}
            </div>
          </div>
        </section>

        <section class="section">
          <div class="wrap wrap--tight">
            <header class="sec-head">
              <div class="sec-head__main">
                <h2 class="section-title">遇到问题时先看这里</h2>
              </div>
              <p class="sec-head__aside">先看错误原因，再决定是否重试。</p>
            </header>
            <ol class="stops">
              <li class="stops__item" data-reveal>
                <span class="stops__no">01</span>
                <div class="stops__body">
                  <h3 class="h3">右上角显示「本机服务未连接」</h3>
                  <p class="stops__text">确认服务仍在运行，刷新页面；状态条会显示数据库、存储与后台任务的健康状态。</p>
                </div>
              </li>
              <li class="stops__item" data-reveal>
                <span class="stops__no">02</span>
                <div class="stops__body">
                  <h3 class="h3">处理任务失败</h3>
                  <p class="stops__text">常见原因：图片超过像素上限、内存上限或矢量化参数过细。先创建工作副本或降低细节。</p>
                </div>
              </li>
              <li class="stops__item" data-reveal>
                <span class="stops__no">03</span>
                <div class="stops__body">
                  <h3 class="h3">云端生成不可用</h3>
                  <p class="stops__text">到设置里填写 API Key，并打开「允许云端计费调用」；保存只做本地校验，不会发起调用。云端修复、候选与线稿点按钮后上传并按次计费；云端不可用时仍可用本地 LeftRefill、本地线稿、OpenCV 与颜色提取。</p>
                </div>
              </li>
              <li class="stops__item" data-reveal>
                <span class="stops__no">04</span>
                <div class="stops__body">
                  <h3 class="h3">文件被占用或设置保存冲突</h3>
                  <p class="stops__text">同一 storage 目录只允许一个服务进程；设置被其他页面改过时会提示重新读取，不会部分写入。</p>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section class="section">
          <div class="wrap wrap--tight">
            <div class="notes-known card" data-reveal>
              <div>
                <p class="label">处理前准备</p>
                <ul class="notes-list">
                  <li>本地线稿模型未安装时，可选 OpenCV 线稿或颜色提取。</li>
                  <li>本地 LeftRefill 需要 NVIDIA 显卡、512 × 512 的目标图和一张已保存的参考图。</li>
                  <li>大图超过处理上限时，可在「裁切」创建工作副本。</li>
                </ul>
              </div>
              <div class="notes-compare">
                <p class="label">想看原来的界面</p>
                <a class="notes-compare__link" href="/legacy/" target="_blank" rel="noreferrer noopener">
                  打开旧版工作台 ${icon("external")}
                </a>
                <p class="notes-compare__note">旧版界面 · 共用本机服务与数据</p>
              </div>
            </div>
            <div class="notes-actions">
              <a class="btn btn--primary" href="#/workbench" data-magnetic>去工作台走一遍 ${icon("arrow")}</a>
              <a class="btn btn--ghost" href="#/home">回到首页</a>
            </div>
          </div>
        </section>
      </div>
    `;
  },

  mount(root, state, api) {
    root.querySelectorAll('a[target="_blank"]').forEach((link) => {
      link.addEventListener("click", () => api.toast("将在新标签页打开旧版工作台（与本页共用本机数据）", "info"));
    });
  },
};

/* =============================================================================
   views/notes.js — 使用说明：这套本机工作台是什么、八道工序怎么用、
   数据与安全边界、已知限制、旧版入口。
   ============================================================================= */

import { icon } from "../icons.js";

const STAGE_GUIDE = [
  ["01 来源", "上传 PNG / JPEG，保留原件并生成规范输入；同时记录评级、来源与指纹。", "原图、规范输入"],
  ["02 裁切", "在真实图版上框出纹样单元；大图先创建工作副本可避免整页超限。", "裁切图、工作副本"],
  ["03 修复", "圈出问题区域，经明确确认后调用云端生成修复候选；纹样完整时可以明确跳过。", "修复候选、接受记录"],
  ["04 候选", "配置云端后按提示词拆分图层，勾选后在本地合成；这一步不生成线稿。", "候选层、合成候选"],
  ["05 处理", "明确选择本地模型或云端模型生成线稿 PNG；也可用 OpenCV 或颜色提取。", "线稿 PNG、透明 PNG"],
  ["06 蒙版", "对透明 PNG 补前景或擦除杂点，提交后生成新的透明 PNG。", "修正后的透明 PNG"],
  ["07 矢量化", "把线稿或透明 PNG 转成可编辑 SVG；颜色与细节在这一步调整。", "矢量 SVG"],
  ["08 平铺", "选单元生成 2×2 / 3×3 排列，记录接缝观察，并把成果打包成 ZIP。", "平铺预览、ZIP 包"],
];

const SHORTCUTS = [
  ["1 – 8", "在工作台切换八道工序"],
  ["[ / ]", "在当前会话的资产之间前后切换"],
  ["C", "开关对比（当前资产与同图原件）"],
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
          <p class="eyebrow">八道工序 · 参数可改</p>
          <h1 class="title notes-hero__title">从原图到可编辑 SVG，八道工序各有产物。</h1>
          <p class="lead notes-hero__lead">
            上传后按工序推进，任意一步都可以重跑。
          </p>
          <div class="notes-hero__chips">
            <span class="chip chip--jade">${icon("check")}可编辑 SVG</span>
            <span class="chip">${icon("flask")}参数可调</span>
            <span class="chip">${icon("layers")}每步独立产物</span>
            <span class="chip">${icon("download")}ZIP 打包导出</span>
          </div>
        </section>

        <section class="section">
          <div class="wrap">
            <header class="sec-head">
              <div class="sec-head__main">
                <span class="sec-head__no">一 · 八道工序</span>
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
            <p class="notes-foot">处理任务在后台队列串行执行；页面会轮询任务状态。失败或取消的任务保留原因。</p>
          </div>
        </section>

        <section class="section">
          <div class="wrap">
            <header class="sec-head">
              <div class="sec-head__main">
                <span class="sec-head__no">二 · 入口与快捷键</span>
                <h2 class="section-title">常用的几个动作</h2>
              </div>
              <p class="sec-head__aside">顶部「上传纹样」随时可用；工作台左栏的资产轨决定当前画布显示哪一个资产。</p>
            </header>
            <div class="notes-why">
              <article class="card notes-why__card" data-reveal>
                <p class="label">页面</p>
                <ul class="notes-list">
                  <li><a href="#/home">首页</a>：最近成果、接着上次、八道工序与云端说明</li>
                  <li><a href="#/workbench">工作台</a>：三栏——文档与工序、图版、参数</li>
                  <li><a href="#/library">纹样库</a>：真实资产的分页、筛选与档案</li>
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
                  <li>导出的 ZIP 包含所选资产、清单与来源信息</li>
                </ul>
              </article>
            </div>
          </div>
        </section>

        <section class="section">
          <div class="wrap">
            <header class="sec-head">
              <div class="sec-head__main">
                <span class="sec-head__no">三 · 数据与云端</span>
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
                ["数据位置", "图片、任务、资产与 SQLite 历史都在 storage/api/；保留该目录即可保留数据"],
                ["密钥", "保存在本机服务配置里，接口只返回「是否已配置」，不回显明文"],
                ["云端", "03 修复、04 候选与 05 云端线稿会调用云端；每次调用前分别确认上传与调用"],
                ["旧前端", "原文件仍在 frontend/ 根目录，可通过 /legacy/ 只读打开对照；不参与新界面"],
                ["备份", "优化前的静态版保存在 frontend/next-v2-backup-20261110/，可随时删除"],
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
                <span class="sec-head__no">四 · 故障排查</span>
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
                  <p class="stops__text">到设置里填写 API Key 并开启云端调用；保存只做本地校验，不会发起调用。云端线稿、修复与候选每次都要分别确认上传与调用。</p>
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

        <section class="section section--closing">
          <div class="wrap wrap--tight">
            <div class="notes-known card" data-reveal>
              <div>
                <p class="label">已知限制</p>
                <ul class="notes-list">
                  <li>「本地线稿模型」需要本机已安装 torch、分割模型库与 model/ 权重；没有这些依赖时请用 OpenCV 线稿或颜色提取。</li>
                  <li>云端线稿、修复与候选每次调用都要重新确认上传与调用；失败或结果未知时不会自动重发。</li>
                  <li>大图（接近 100 万像素）在部分机器的矢量化阶段可能触及内存上限，先创建工作副本更稳。</li>
                  <li>页面按 Chrome 验证；未做完整的屏幕阅读器人工走查（已有焦点环、aria 状态与减少动态效果适配）。</li>
                  <li>字体依赖本机 Noto Serif SC、Noto Sans SC、Bahnschrift、Cascadia Code；缺字体会回退。</li>
                </ul>
              </div>
              <div class="notes-compare">
                <p class="label">想看原来的界面</p>
                <a class="notes-compare__link" href="/legacy/" target="_blank" rel="noreferrer noopener">
                  打开旧版工作台 ${icon("external")}
                </a>
                <p class="notes-compare__note">旧版界面 · 只读对照</p>
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
      link.addEventListener("click", () => api.toast("将在新标签页打开旧版工作台", "info"));
    });
  },
};

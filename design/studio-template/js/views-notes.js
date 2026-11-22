/* =============================================================================
   说明：工序、门禁、快捷键与接口覆盖表
   ============================================================================= */
(function () {
  "use strict";
  const PS = window.PS;
  const U = PS.ui;
  const { icon, esc } = U;

  PS.views = PS.views || {};

  const map = [
    {
      title: "基础、设置与云端自检",
      rows: [
        ["GET", "/api/v1/health", "概览状态条、工作台底栏、设置·本机处理", "数据库、存储、worker、模型能力、像素上限与版本快照"],
        ["GET", "/api/v1/settings", "设置·云端服务", "密钥是否配置、模型、地址、付费与价格确认、revision、blockers"],
        ["PUT", "/api/v1/settings", "设置·保存设置", "带 revision 的原子更新；冲突时提示重读，不静默覆盖"],
        ["GET", "/api/v1/seedream/status", "设置·云端调用 · 接口限额", "配置状态、预算、单次上限与自动重试策略"],
        ["POST", "/api/v1/seedream/inputs", "云端自检 · 上传示例图", "验证用输入上传，返回资产 id"],
        ["POST", "/api/v1/seedream/validations", "云端自检 · 提交", "按 operation / intent / size 提交一次受控调用"],
        ["GET", "/api/v1/seedream/validations/{call_id}", "调用台账条目", "查询单次云端调用状态与结果"],
        ["POST", "/api/v1/seedream/validations/{call_id}/settlement", "补记结算", "实际费用与账号账单引用；不保存响应正文"],
        ["GET", "/api/v1/openapi.json", "说明·接口覆盖（开发对照）", "运行时接口自省，模板不请求"],
      ],
    },
    {
      title: "图像、资产与按图历史",
      rows: [
        ["POST", "/api/v1/images", "上传浮窗", "原图 + 规范输入；可带来源、许可、采集日期与批次号"],
        ["GET", "/api/v1/images/{image_id}", "档案抽屉 · 工作台来源", "原图、规范输入、来源备注与元数据"],
        ["GET", "/api/v1/images/{image_id}/history", "档案抽屉 · 版本 / 任务 / 云端流程", "collection=assets|jobs|flows，分页只读"],
        ["GET", "/api/v1/images", "概览最近成果、纹样库", "按原图组倒序分页"],
        ["GET", "/api/v1/assets", "导出选择、批量输入", "按关键词与资产类型分页"],
        ["GET", "/api/v1/assets/{asset_id}", "版本详情", "单个资产的元数据与来源"],
        ["GET", "/api/v1/assets/{asset_id}/preview", "图版预览", "PNG / JPG / SVG 预览流"],
        ["GET", "/api/v1/assets/{asset_id}/download", "版本下载、ZIP 下载", "不可预览的 ZIP 走下载"],
      ],
    },
    {
      title: "本机任务与流水线",
      rows: [
        ["POST", "/api/v1/jobs/crop", "02 裁切 · 应用裁切", "bbox 半开区间，真实像素"],
        ["POST", "/api/v1/jobs/prepare", "02 裁切 · 旋转与摆正", "rotation 0/90/180/270，straighten ±15°"],
        ["POST", "/api/v1/jobs/working-copy", "02 裁切 · 创建工作副本", "显式最大像素，不自动缩放"],
        ["POST", "/api/v1/jobs/enhance", "02 裁切 · 图像增强（可选）", "亮度、对比度、去噪、锐化"],
        ["POST", "/api/v1/jobs/extract", "05 处理 · 颜色提取 / 前景", "alpha、Otsu、手动、GrabCut、自适应、Sauvola 与清理参数"],
        ["POST", "/api/v1/jobs/lineart", "05 处理 · 本地模型 / OpenCV", "method=model|opencv；模型不接受 OpenCV 参数"],
        ["POST", "/api/v1/jobs/vectorize", "07 矢量化 · 转为 SVG", "monochrome/color/contour、颜色数、细节与阈值"],
        ["POST", "/api/v1/pipelines", "批量预设 / 颜色提取流水线", "recipe=color 或 model_lineart，一次完成提取与矢量"],
        ["POST", "/api/v1/exports", "导出浮窗 · 打包 ZIP", "资产集合、许可确认、flat / by_image 布局"],
        ["GET", "/api/v1/jobs", "任务页", "本机任务索引，按时间倒序分页"],
        ["GET", "/api/v1/jobs/{job_id}", "任务详情", "状态、步骤、参数、结果、错误、尝试次数"],
        ["POST", "/api/v1/jobs/{job_id}/cancel", "任务详情 · 取消", "云端任务可能需要先核对，不能直接取消"],
        ["GET", "/api/v1/pipelines/{pipeline_id}", "任务详情 · 流水线", "本地流水线或云端流程的统一读取"],
        ["POST", "/api/v1/jobs/{job_id}/retry", "任务详情 · 重试", "成功/失败任务均可重试，生成新的尝试记录"],
        ["POST", "/api/v1/feedback", "质量反馈", "1–5 分、问题标签、说明、训练与展示两项独立授权"],
      ],
    },
    {
      title: "纹样库、分类与纹样列",
      rows: [
        ["GET", "/api/v1/patterns", "纹样库", "q / kind / category_id 与 cursor 分页"],
        ["GET", "/api/v1/patterns/{image_id}", "档案抽屉", "原图组、资产、分类、元数据与 revision"],
        ["DELETE", "/api/v1/patterns/{image_id}", "档案抽屉 · 删除原图组", "忙碌的组会被拒绝；删除不可恢复"],
        ["PATCH", "/api/v1/patterns/{image_id}", "档案抽屉 · 资料与分类", "评级、来源类型/名称/地址/备注；空字符串表示清除"],
        ["PUT", "/api/v1/patterns/{image_id}/categories", "档案抽屉 · 分类", "带 revision 的整组分类替换"],
        ["GET", "/api/v1/pattern-categories", "纹样库筛选、分类管理", "全部分类与 revision"],
        ["POST", "/api/v1/pattern-categories", "分类管理 · 新建", "名称 1–200 字"],
        ["PUT", "/api/v1/pattern-categories/{category_id}", "分类管理 · 重命名", "带 revision 校验"],
        ["DELETE", "/api/v1/pattern-categories/{category_id}", "分类管理 · 删除", "只解除关联，不删除纹样组"],
        ["GET", "/api/v1/workbench/items", "工作台 · 纹样列", "本机选择的分页列表"],
        ["POST", "/api/v1/workbench/items", "工作台 · 添加纹样", "最多 200 个原图 id"],
        ["DELETE", "/api/v1/workbench/items", "工作台 · 移除纹样", "按 id 批量移除"],
        ["DELETE", "/api/v1/workbench/items/all", "工作台 · 清空纹样列", "只清空选择，不删除纹样"],
      ],
    },
    {
      title: "批量预设与处理批次",
      rows: [
        ["GET", "/api/v1/workflow-presets", "批量 · 预设列表", "可复用处理配方"],
        ["POST", "/api/v1/workflow-presets", "批量 · 新建预设", "名称、路线、裁切/修复/候选/蒙版/矢量化/平铺开关"],
        ["PUT", "/api/v1/workflow-presets/{preset_id}", "批量 · 编辑预设", "带 revision，保存后加一"],
        ["DELETE", "/api/v1/workflow-presets/{preset_id}", "批量 · 删除预设", "不影响已创建的批次"],
        ["POST", "/api/v1/processing-batches", "批量 · 创建批次", "preset_id + 最多 100 个输入；云端路线需双同意"],
        ["GET", "/api/v1/processing-batches", "批量 · 批次列表", "服务器持久推进，刷新可恢复"],
        ["GET", "/api/v1/processing-batches/{batch_id}", "批量 · 批次详情", "逐图状态、步骤、等待原因与 revision"],
        ["POST", "/api/v1/processing-batches/{batch_id}/items/{item_id}/resume", "批量 · 人工续接", "明确选择同图后代资产后继续"],
        ["POST", "/api/v1/processing-batches/{batch_id}/cancel", "批量 · 取消批次", "带 revision；已完成的图片保留"],
      ],
    },
    {
      title: "SVG 编辑与后处理",
      rows: [
        ["GET", "/api/v1/assets/{asset_id}/svg-elements", "07 矢量化 · 独立图形", "按元素 id 返回分组与数量"],
        ["POST", "/api/v1/jobs/edit-svg", "07 矢量化 · 图形编辑", "source_sha256 + 每个元素的 dx/dy/deleted，最多 2000 条"],
        ["POST", "/api/v1/jobs/recolor-svg", "07 矢量化 · 整版换色", "最多 16 组六位十六进制映射"],
        ["POST", "/api/v1/jobs/repair", "03 修复 · 云端 / LeftRefill", "bbox、意图、羽化、seed、参考图与双同意"],
        ["GET", "/api/v1/repairs/{job_id}", "03 修复 · 候选记录", "候选、revision 与决定"],
        ["POST", "/api/v1/repairs/{job_id}/decision", "修复候选 · 接受/拒绝", "接受必须选具体版本；可确认整图变化"],
        ["POST", "/api/v1/jobs/tile-preview", "08 平铺 · 生成预览", "2×2 / 3×3 与接缝观察"],
        ["PUT", "/api/v1/assets/{asset_id}/seam-observation", "08 平铺 · 保存接缝观察", "not_reviewed / visible / not_obvious + revision"],
      ],
    },
    {
      title: "云端辅助流程",
      rows: [
        ["POST", "/api/v1/pipelines/ai", "04 候选 · 云端拆分", "prompt_version、size、选层策略与双同意"],
        ["GET", "/api/v1/jobs/{job_id}/layers", "04 候选 · 候选层", "拆分产物列表与层 id"],
        ["POST", "/api/v1/jobs/compose-layers", "04 候选 · 合成", "1–16 个层 id，按顺序叠放"],
        ["POST", "/api/v1/pipelines/{pipeline_id}/continue", "04 候选 · 首次选层", "action=select_layers|use_local|reject，带 revision"],
        ["POST", "/api/v1/pipelines/{pipeline_id}/rerun", "04 候选 · 改选重合成", "action=compose|vectorize，带 revision"],
        ["POST", "/api/v1/jobs/cloud-lineart", "05 处理 · 云端线稿", "注册提示词与双同意，不接受自由文本"],
        ["POST", "/api/v1/jobs/refine-mask", "06 蒙版 · 提交修正", "画笔笔迹 / GrabCut、反相、去噪与迭代次数"],
      ],
    },
    {
      title: "数据集",
      rows: [
        ["GET", "/api/v1/datasets/manifest.csv", "设置·数据集 · 下载清单", "21 列 UTF-8 BOM CSV，与审计同一批行"],
        ["GET", "/api/v1/datasets/audit", "设置·数据集 · 审计", "评级、划分、许可覆盖、来源、重复内容与版本快照"],
      ],
    },
  ];

  const shortcuts = [
    ["1 – 8", "切换工序（工作台）"],
    ["[ / ]", "上一个 / 下一个纹样"],
    ["C", "对比原图"],
    ["Ctrl / ⌘ + K", "命令面板"],
    ["Esc", "关闭弹层 / 抽屉 / 命令面板"],
    ["Enter（命令面板）", "执行选中项"],
  ];

  PS.views.notes = function () {
    return `
    <div class="page">
      <div class="page-head">
        <div><span class="eyebrow">使用说明</span><h1>把真实接口换成这套版式</h1><p>模板只复刻交互与视觉，不连接服务；下面按页说明每个动作对应的接口。</p></div>
        <button class="btn" data-act="manifest">${icon("download", "ic--sm")}下载演示 manifest</button>
      </div>
      <div class="notes">
        <nav class="notes__toc">
          <a href="#/notes" data-scroll="n-intro">模板边界</a>
          <a href="#/notes" data-scroll="n-flow">八道工序</a>
          <a href="#/notes" data-scroll="n-cloud">云端门禁</a>
          <a href="#/notes" data-scroll="n-batch">批量与预设</a>
          <a href="#/notes" data-scroll="n-data">纹样库与数据集</a>
          <a href="#/notes" data-scroll="n-keys">快捷键</a>
          <a href="#/notes" data-scroll="n-trouble">故障排查</a>
          <a href="#/notes" data-scroll="n-api">接口覆盖</a>
        </nav>
        <div class="notes__body">
          <section class="note-sec" id="n-intro">
            <h2>模板边界</h2>
            <p>这套模板延续「宣纸 · 黛青」的版式、令牌与图版语言，把当前系统的全部后端能力排进可点击的界面。所有数据都是 <code>js/data.js</code> 里的演示值；任务进度、版本写入、云端调用与批次数由浏览器内的计时器模拟，不发请求、不写文件、不写浏览器存储。</p>
            <ul>
              <li>直接双击 <code>index.html</code> 即可打开，<code>file://</code> 下没有构建步骤。</li>
              <li>样图引用 <code>frontend/next-v2/assets/demo/</code>；基础样式引用 <code>design/frontend-redesign/styles.css</code>。</li>
              <li>接入时按「接口覆盖」把动作换成 <code>/api/v1</code> 调用，并把演示状态换成服务端返回；视觉层不需要重做。</li>
            </ul>
            <div class="callout callout--warn">${icon("alert")}<div>模板不会替你验证真实模型、真实云端费用或真实素材质量；这些仍需要单独的验收记录。</div></div>
          </section>

          <section class="note-sec" id="n-flow">
            <h2>八道工序</h2>
            <table class="api-map">
              <thead><tr><th>工序</th><th>模板里能做什么</th><th>对应接口</th></tr></thead>
              <tbody>
                <tr><td>01 来源</td><td>上传、来源/许可、近似版本、按图历史</td><td>POST /images、GET /images/{id}/history</td></tr>
                <tr><td>02 裁切</td><td>bbox、旋转、摆正、工作副本、增强</td><td>crop、prepare、working-copy、enhance</td></tr>
                <tr><td>03 修复</td><td>跳过、本机 LeftRefill、云端候选与接受/拒绝</td><td>repair、repairs/{id}、decision</td></tr>
                <tr><td>04 候选</td><td>提示词版本、尺寸、选层、合成、continue / rerun</td><td>pipelines/ai、layers、compose-layers</td></tr>
                <tr><td>05 处理</td><td>本地模型、云端线稿、OpenCV、颜色提取及全部清理参数</td><td>lineart、cloud-lineart、extract、pipelines</td></tr>
                <tr><td>06 蒙版</td><td>画笔补/擦、GrabCut、反相、去噪、笔迹撤销</td><td>refine-mask</td></tr>
                <tr><td>07 矢量化</td><td>颜色数、细节、阈值、单图形挪动/删除、整版换色</td><td>vectorize、svg-elements、edit-svg、recolor-svg</td></tr>
                <tr><td>08 平铺</td><td>2×2 / 3×3、接缝观察、打包导出</td><td>tile-preview、seam-observation、exports</td></tr>
              </tbody>
            </table>
            <p>工作台左栏可在「版本」与「纹样」之间切换：版本按工序分组，纹样列对应 <code>/workbench/items</code>；<span class="mono">[</span> 与 <span class="mono">]</span> 可以在纹样间切换。</p>
          </section>

          <section class="note-sec" id="n-cloud">
            <h2>云端门禁与费用</h2>
            <p>云端动作必须同时满足设置门禁与逐次同意：设置里的密钥、付费开关、价格确认，加上每次请求的「同意上传」与「确认价格并同意付费」。任一缺失时主按钮禁用并说明原因，本机流程照常可用。</p>
            <ul>
              <li>修复：<code>¥0.18</code>/次；候选拆分：<code>¥0.12</code>/次；云端线稿：<code>¥0.09</code>/次；自检：<code>¥0.06</code>/次（均为演示价格）。</li>
              <li>结果未知时界面显示「需核对」，台账提供补记结算与「确认失败，无费用」两条人工路径，不自动重发。</li>
              <li>调用台账记录操作、状态、结算与账单引用，不保存响应正文与密钥。</li>
            </ul>
            <div class="callout callout--warn">${icon("shield")}<div>预算、单次预留与调用次数只做提示；真正的门槛是密钥、付费开关与价格确认。</div></div>
          </section>

          <section class="note-sec" id="n-batch">
            <h2>批量与预设</h2>
            <p>预设保存处理配方（路线、裁切、修复、候选、蒙版、矢量化、平铺与工作像素）。创建批次时选择最多 100 个输入，批次由服务器逐图推进；单图失败不阻塞其它图片，失败项可单独重试。</p>
            <ul>
              <li>云端预设要求批次级的上传与付费双同意；结果未知时批次停在「等待人工」，需要明确选择同图后代资产才能续接。</li>
              <li>暂停只停止继续取图，已开始的任务仍会完成并写入版本。</li>
              <li>导出范围为批次已完成的产物，沿用许可确认、500 个文件与 128 MiB 限制。</li>
            </ul>
          </section>

          <section class="note-sec" id="n-data">
            <h2>纹样库与数据集</h2>
            <p>纹样库按原图组展示，档案抽屉分「版本 / 资料与分类 / 任务 / 云端流程」四页。资料页可以改评级、来源与分类，删除原图组会连同全部版本和文件一起移除，且忙碌时会被拒绝。</p>
            <p>数据集清单由原图、任务与来源记录派生：21 列、UTF-8 BOM、不修改任何纹样。模板里的「下载 manifest.csv」会用演示数据在浏览器内生成一份真实可下载的 CSV，便于核对字段。</p>
          </section>

          <section class="note-sec" id="n-keys">
            <h2>快捷键</h2>
            <div class="kbd-list">${shortcuts.map(([k, v]) => `<div><span>${esc(v)}</span><span class="kbd">${esc(k)}</span></div>`).join("")}</div>
          </section>

          <section class="note-sec" id="n-trouble">
            <h2>故障排查</h2>
            <h3>模型相关工序不可用</h3>
            <p>先看设置·本机处理的模型前置检查与原因码；模型依赖必须安装在启动服务的同一个 Python 环境里。模板里可以切换到 OpenCV 或颜色提取继续。</p>
            <h3>矢量化触发内存上限</h3>
            <p>先在 02 裁切创建工作副本（颜色矢量化建议 ≤ 25 万像素），或降低颜色数与细节。worker 的 6,144 MiB 上限可在设置里看到。</p>
            <h3>云端结果未知</h3>
            <p>不要重复提交。到任务详情或调用台账核对账号侧账单，再补记结算或确认失败。批次会停在等待人工，不会自动猜测续接对象。</p>
            <h3>设置保存冲突</h3>
            <p>设置带 revision。若返回 409，重新读取页面再应用修改；模板里保存会模拟 revision 加一。</p>
          </section>

          <section class="note-sec" id="n-api">
            <h2>接口覆盖</h2>
            <p>下列接口均已在模板中对应到可见动作；未接入生产服务，只用于交付评审与后续替换。</p>
            ${map
              .map(
                (group) => `<h3>${esc(group.title)}</h3>
                <table class="api-map">
                  <thead><tr><th>方法 / 路径</th><th>模板位置</th><th>说明</th></tr></thead>
                  <tbody>${group.rows.map(([m, p, where, note]) => `<tr><td>${esc(m)} ${esc(p)}</td><td>${esc(where)}</td><td>${esc(note)}</td></tr>`).join("")}</tbody>
                </table>`
              )
              .join("")}
          </section>
        </div>
      </div>
    </div>`;
  };
})();

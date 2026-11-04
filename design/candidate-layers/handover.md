# 候选图层页（stage 04）交接文档

范围：Pattern Studio 工作台第 4 阶段「候选」页的静态 UI 原型、React 组件骨架与集成说明。
本页是工作台内部页面，不是独立落地页；外壳（顶条 / 阶段导航 / 版本栏 / 画布 / 状态条）沿用现有工作台。
视觉唯一基准：`prototype/index.html`。React 骨架（`react-skeleton/`）必须与其一致。

## 1. 设计令牌

机器可读版本见 [tokens.json](./tokens.json)。与现有 `frontend/styles.css` 的映射：

| 令牌 | 值 | frontend/styles.css 变量 |
| --- | --- | --- |
| color.ink | #1b2b54 | `--ink` |
| color.paper | #edede7 | `--paper` |
| color.paperHi | #f6f6f1 | `--paper-hi` |
| color.paper2 | #e4e4dc | `--paper-2` |
| color.ink85 | #33406b | `--ink-85` |
| color.ink60 | #4f587b | `--ink-60` |
| color.ink40 | #838aa6 | `--ink-40` |
| color.ink25 | #bfc2ce | `--ink-25` |
| color.ink12 | #dcdde3 | `--ink-12` |
| fontFamily.display | Noto Serif SC | `--font-display` |
| fontFamily.ui | Noto Sans SC | `--font-ui` |
| fontSize.display | 28px | 对应 `--t-empty` 量级；页标题「候选图层」使用 |
| fontSize.h1 | 22px | `--t-dialog` |
| fontSize.h2 | 18px | 介于 `--t-h` 与 `--t-dialog` 之间，本页未使用 |
| fontSize.body | 14px | `--t-body` |
| fontSize.small | 13px | `--t-small` |
| fontSize.micro | 12px | `--t-micro` |
| fontWeight.regular / medium / semibold | 400 / 500 / 600 | 现有一致 |
| spacing.1–7 | 4/8/12/16/24/32/48px | `--s1`–`--s6`（48 为新增大档） |
| radius.none | 0 | 全站零圆角 |
| border.rule | 1px solid #bfc2ce | `--rule` |
| border.strong | 1px solid #1b2b54 | `--rule-ink` |
| border.bar | 3px solid #1b2b54 | `--bar` |

补充约定（沿用现有语言，未新增颜色）：

- 透明区域用棋盘格表达：`repeating-conic-gradient(--ink-12 25%, --paper-hi 50%)`，16px 格。
  生产可改用现有网点 `--dots-sparse`（`.ai-layer-visual` 已在用），二者取其一即可。
- 交互过渡统一 120ms linear，仅 hover/focus；无入场动画。
- 焦点环统一 `outline: 2px solid var(--ink); outline-offset: 2px;`。
- 错误/警告只用墨纸对比、线宽（3px 左条）与文案表达，不引入新颜色。

## 2. 页面结构树

```
body
└─ div.app-shell                       (h-screen 纵向 flex)
   ├─ header 顶条 52px                 品牌 / 本机就绪 / 历史 / 设置
   ├─ nav 阶段导航 46px                01 来源 … 04 候选(aria-current) … 07 平铺
   ├─ main 工作面 (grid: 版本栏 | 画布 | 候选区)
   │  ├─ aside 版本栏                  h2「版本」+ role=list（原始文件/规范输入*/前景蒙版/透明 PNG/候选合成）
   │  ├─ section 输入画布 aria-labelledby=文件名
   │  │  ├─ div 头部                   h2 文件名+「规范输入」 · 缩放控制组
   │  │  ├─ dl 尺寸信息                尺寸 / 坐标空间 / 质量参考
   │  │  ├─ div 画布区                 只读批注（左上）+ 棋盘格图框 + 内联 SVG 缩略
   │  │  └─ p 底部提示                 「候选阶段画布为只读…」
   │  └─ aside 候选工作区 aria-label=候选图层工作区
   │     ├─ PageHeader                 h1「候选图层」+ 任务状态徽标 + dl 输入信息
   │     ├─ 滚动区（ready/selected）
   │     │  ├─ 筛选条                  全部 / 已选 / 待复核（role=group, aria-pressed）
   │     │  ├─ 底图说明行              「底图 · 仅作坐标参考，不可选」（虚线框）
   │     │  ├─ 候选网格 role=group     article.candidate × n
   │     │  └─ p 页脚提示              「几何与保真尚未核验…」
   │     ├─ 滚动区（empty/loading/error）
   │     │  └─ StatePanel              空 / 骨架 / 错误 + 占位按钮
   │     ├─ SelectionSummary           已选 n / 5 层 · 图层序号 · 矢量参数说明
   │     └─ DecisionBar                改用本地流程 / 拒绝候选 / 合成所选图层
   └─ footer 状态条 37px               任务 · 状态徽标 · 信息行 · 阶段 04/07
```

## 3. 组件清单

React 骨架位于 `react-skeleton/src/`；「对应现有实现」指 `frontend/index.html` / `frontend/workbench.js`。

| 组件 | 职责 | 主要 Props | 文件 | 对应现有实现 |
| --- | --- | --- | --- | --- |
| AppShell | 顶条 + 阶段导航 + 三栏 + 状态条槽位 | stages, versionRail, canvas, workspace, statusBar | components/AppShell.tsx | `.app-bar` / `.rail` / `.work` / `#status-bar` 外壳 |
| PageHeader | 页标题「候选图层」+ 输入信息 + 状态徽标 | input, state | components/PageHeader.tsx | `#ai-panel` 的 `.tools-title` + `#ai-state-badge`；输入信息对应 `.dims`（`#working-dims` / `#coordinate-id`） |
| VersionRail | 左侧版本条，高亮当前输入 | versions | components/VersionRail.tsx | `#version-list` / `.version-item`（`is-current`） |
| InputCanvas | 中栏只读画布：文件名、尺寸、棋盘格缩略、缩放 | input, zoom, canZoomIn/Out, onZoomIn/Out/Fit | components/InputCanvas.tsx | `#canvas-panel` / `.light-head` / `.stage .frame`（本页只读，无框选层） |
| CandidateWorkspace | 右栏工作区编排：筛选/底图/网格/汇总/决策/状态面板 | state, basemap, candidates, selectedIds, filter, 各回调 | components/CandidateWorkspace.tsx | `#ai-candidates` 区块整体 |
| CandidateFilterBar | 全部/已选/待复核 分段筛选 | filter, counts, onChange | components/CandidateFilterBar.tsx | 无（新增；样式参考 `.segmented`） |
| CandidateGrid | 候选网格与空筛选提示 | candidates, selectedIds, onToggle | components/CandidateGrid.tsx | `#ai-layer-list`（`.layers`） |
| CandidateCard | 单个候选：缩略、序号、尺寸、选中态、AI/未核验/存疑徽标 | candidate, selected, onToggle | components/CandidateCard.tsx | `.ai-layer-card`（`renderAiCandidates` 内构建） |
| SelectionSummary | 已选数量与图层序号、矢量参数说明 | total, selectedZ | components/SelectionSummary.tsx | `#ai-selection-note` |
| DecisionBar | 合成/拒绝/改用本地 三个动作 | canCompose, onCompose, onReject, onUseLocal | components/DecisionBar.tsx | `#ai-compose` / `#ai-reject` / `#ai-use-local`（`#ai-decision`） |
| StatePanel | empty / loading / error 占位 | state, onGenerate, onRetry | components/StatePanel.tsx | `#ai-empty` / `#ai-error` / `.skeleton` |
| StatusBar | 底部状态条 | state, selectedZ | components/StatusBar.tsx | `#status-bar`（`#task-status` / `#task-empty`） |
| Icon | 内联 SVG 图标（复用现有 sprite 形状） | name, className | components/Icon.tsx | `index.html` 的 `<symbol id="i-*">` |
| Thumb | 抽象纹样占位缩略图（内联 SVG，无真实素材） | seed, big | components/Thumb.tsx | 原型专用，无对应 |

选择状态对应 `state.ai.selectedLayerIds`（Set）；合成按钮禁用条件对应
`workbench.js` 中 `setDisabled(dom.aiCompose, … || state.ai.selectedLayerIds.size === 0)`。

## 4. 交互要求（仅描述，不实现业务）

| 触发 | 行为 | 状态变化 | 禁用/边界 |
| --- | --- | --- | --- |
| 点击候选卡缩略区 | 切换该层选中态 | selectedIds 增删；卡片边框/底色/勾选块切换；汇总、状态条、合成按钮联动 | 底图行不可选（无点击行为）；空筛选结果只显示提示 |
| 点击筛选（全部/已选/待复核） | 切换网格内容 | filter 变化；计数徽标随选择联动 | 「待复核」= warnings 非空的候选 |
| 缩放 −/＋/适应 | 画布缩略在 50–150% 间步进 | zoom 变化，按钮到界即禁用 | 纯展示，不影响坐标语义 |
| 合成所选图层 | TODO：复用已归档图层走 `compose` 重跑 | — | 未选任何层时禁用；loading/empty 下不出现 |
| 拒绝候选 | TODO：记录拒绝，不自动重发 | — | 二次确认由业务侧决定 |
| 改用本地流程 | TODO：回退本地提取 | — | 所有状态可用 |
| 生成候选（empty）/ 重试生成（error） | TODO：提交/重试拆层任务 | — | 需要上传与费用双确认；结果不确定不自动重发 |

五态定义：empty（无候选）、loading（骨架）、ready（5 候选默认未选）、
selected（默认选 1、2 层）、error（失败+重试）。经 `?state=` 切换，非法值按 ready。

## 5. 与现有 vanilla JS 前端的集成说明

**不要**把 Tailwind 运行时（CDN 或构建产物）带入生产。生产集成应将本原型的
工具类映射到 `frontend/styles.css` 既有类，或在 `styles.css` 内新增有作用域的 CSS
（建议统一前缀 `.ai-`）。映射参考：

| 原型元素 | 可复用的现有类 |
| --- | --- |
| 主按钮 / 次按钮 / 文字按钮 | `.btn .btn-solid` / `.btn .btn-line` / `.btn .btn-quiet`（尺寸 `.btn-sm`） |
| AI 生成 / 几何未核验 / 候选存疑 徽标 | `.mini-badge .is-ai` / `.is-unverified`；存疑可复用 `.chip-mark` 的左 2px 实条形式 |
| 任务状态徽标 | `.status-pill`（`.is-waiting_user` / `.is-failed` / `.is-running`） |
| 页标题与状态行 | `.tools-title` + `.tag` + `.tools-head-row` |
| 候选卡 | `.ai-layer-card`（含 `.is-selected` / `.ai-layer-visual` / `.ai-layer-badge` / `.ai-layer-index`） |
| 底图说明行 | `.ai-reference`（`.references` 容器） |
| 决策区 | `.decision` / `.decision-acts` |
| 空/错状态 | `.empty-note` / `.field-error`；骨架用 `.skeleton` |
| 画布棋盘格 | `.frame` / `.ai-layer-visual` 的网点背景，或新增 `.checker` |

DOM 落点（`frontend/index.html` stage 04 面板）：

- 候选网格 → `#ai-layer-list`；底图行 → `#ai-reference-list`；整区 → `#ai-candidates`。
- 决策三键 → `#ai-compose` / `#ai-reject` / `#ai-use-local`；选中摘要 → `#ai-selection-note`。
- 页头状态徽标 → `#ai-state-badge`；错误 → `#ai-error`；空态 → `#ai-empty`。
- 中栏只读画布沿用 `#canvas-panel`；本页的缩放控制与只读批注为新增元素。
- 版本栏沿用 `#version-list`；「候选合成」条目在合成成功后由既有版本逻辑产生。

需要接回 `frontend/workbench.js` 的事件：

- 选择切换：`renderAiCandidates()` 中 checkbox 的 change → `state.ai.selectedLayerIds.add/delete`，随后 `renderAiPanel()`。
- 卡片/筛选重渲染 → `renderAiCandidates()`；摘要与合成禁用 → `updateActionState()`（`#ai-compose` 已按 `selectedLayerIds.size === 0` 禁用）。
- 合成 / 拒绝 / 改用本地 → 现有 `#ai-compose` / `#ai-reject` / `#ai-use-local` 提交流程（`compose_layers` / `select_layers` / `use_local`）。
- 筛选（全部/已选/待复核）与缩放为纯前端状态，不写入工作区历史，不触发提交。

## 6. 后续约束（本页明确不做）

- 无后端、无真实 AI 请求、无付费调用；所有业务入口仅 TODO 占位。
- 无路由、无持久化、无 localStorage；`?state=` 只是演示开关。
- 无暗色模式、无移动端适配（仅保证 1024px 可用）、无拖拽排序。
- 不使用真实图像素材；缩略图一律内联 SVG / 棋盘格 / 抽象占位。
- 不新增颜色、圆角、阴影、渐变洗色与图标库。

## 7. 已知假设与待确认问题

1. 断点取 1181px：≥1181 为完整三栏（248 / 弹性 / 380），≤1180 版本栏收成 64px 图标列、右栏 320px。是否沿用现有 `--w-film/--w-tools` 的 1180/1024 两档媒体查询需确认。
2. 「待复核」筛选目前定义为 `warnings` 非空；是否把低置信度（如 < 0.5）也纳入待复核，待 B 的选层规则确定后再定。
3. 候选卡的「置信度 / 面积占比」直接展示数值，未做阈值着色（设计语言不允许新颜色）；是否需要改为仅文案提示（如「置信偏低」）待确认。
4. error 状态文案假设「云端超时、结果不确定」为最典型的失败形态；其他失败（配额、参数拒绝）是否复用同一面板待确认。
5. 版本栏的「候选合成」条目是静态占位；它与合成任务产物（`composed_candidate`）在版本区的呈现顺序与徽标规则待 A 确认。

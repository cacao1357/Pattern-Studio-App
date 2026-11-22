# 纹样工作台 · 全功能交互模板「宣纸 · 黛青」

这是基于 `design/frontend-redesign/` 视觉原型扩展出的**可点击交互模板**：把当前系统 `/api/v1` 的全部能力排进界面，但不接入服务、不发请求、不写文件、不写浏览器存储。数据与进度都在 `js/data.js` 与本地计时器里模拟。

原视觉原型一行未改；本目录只是它的功能适配版，样式直接复用原型的令牌与组件。

## 打开

直接双击 `index.html` 即可（`file://` 可用，无构建步骤、无第三方依赖）。也可以从仓库根目录启动只读预览服务：

```powershell
python design/studio-template/serve.py
# 浏览器打开 http://127.0.0.1:8790/design/studio-template/
```

`serve.py` 只允许读取模板目录、原型的 `styles.css` 与 `frontend/next-v2/assets/` 下的演示图；仓库其他路径（`storage/`、配置、密钥、源码）一律 404。预览服务不改变模板本身，模板也不会向它发请求。

样式依赖：

- `../frontend-redesign/styles.css`：原型令牌、按钮、表单、图版、工作台骨架；
- `./template.css`：只追加模板新组件（对话框、命令面板、批量卡片、台账、说明表格等），颜色全部取现有令牌。

如果要把本目录单独拷走，请把原型的 `styles.css` 一并带上，或把 `index.html` 里的这条链接改成新位置。

## 页面

| 路由 | 页面 | 覆盖的能力 |
| --- | --- | --- |
| `#/home` | 概览 | 系统状态、接着上次、八道工序、最近成果、任务动态、云端用量、数据集概览 |
| `#/workbench` | 工作台 | 八道工序全部参数；版本列与纹样列；上传、裁切/摆正/副本/增强、修复、候选、提取、蒙版、矢量化、SVG 编辑与换色、平铺、接缝、导出 |
| `#/library` | 纹样库 | 统计、搜索、品类/分类/评级筛选、排序、网格/列表、载入更多、档案抽屉（版本 / 资料与分类 / 任务 / 云端流程）、删除 |
| `#/batch` | 批量 | 流程预设增删改、批次创建、逐图状态、暂停/继续/取消、失败重试、云端批次双同意、人工续接、批次导出 |
| `#/tasks` | 任务 | 状态页签、进度、错误码、取消、重试、任务详情、调用关联、质量反馈（评分 / 问题标签 / 训练与展示授权） |
| `#/settings` | 设置 | 云端服务、付费与价格确认、预算、云端自检、调用台账与补记结算、本机能力与像素上限、数据集审计与 manifest、外观、版本 |
| `#/notes` | 说明 | 工序说明、云端门禁、批量、数据边界、快捷键、故障排查、**全部接口覆盖表** |

支持深链：`#/workbench?pattern=crane&stage=7&compare=1&tile=3`；查询串还支持 `?theme=ink`。

## 已可交互的演示

- 工作台：点工序条或按 `1`–`8` 切工序；`C` 对比；缩放；候选层勾选；提取方式、修复方式、画笔、平铺规格切换；滑块实时显示数值；主按钮模拟执行进度并写入一个演示版本、自动进入下一道工序；云端工序必须先勾选「同意上传」与「确认价格并同意按次付费」。
- 云端调用：模拟完成后写入 `PS.calls` 台账，金额为待补记状态；设置页可补记结算、核对未知结果。
- 修复：云端修复完成后打开候选 A/B，接受会写入 `accepted_repair` 版本，拒绝保留候选但不写入。
- 候选：`重新拆分` 走云端同意；`合成所选` 生成本地版本；`采用本地 / 拒绝` 走流程分支。
- 矢量化：可选中单个图形做位移/删除，应用后写入新的 SVG 版本；整版换色生成新版本。
- 上传：拖入本地图片可预览；「使用示例图片」可走完整流程；上传完成后出现「发现近似版本」抽屉，可改用已有版本或保留新上传（会新增一个原图组）。
- 导出：勾选版本、目录布局、许可确认后打包（模拟进度与结果，不生成真实 ZIP）；单张资产可用浏览器真实下载。
- 批量：创建的新批次会逐图推进；预设可编辑、可删除；等待人工的批次需要选择续接对象。
- 任务：可取消本机任务、重试失败任务、查看参数/步骤/结果/错误，并提交反馈；云端任务取消会提示先核对台账。
- 数据集：设置页与说明页的「下载 manifest.csv」会用演示数据在浏览器内生成真实 CSV；说明页列出全部接口与模板位置。
- 命令面板：`Ctrl / ⌘ + K`，可搜索页面、工序和操作；支持上下键与回车。
- 主题：左下角切换「宣纸 / 夜墨」，只替换令牌。

## 目录

```
design/studio-template/
├─ index.html        外壳、图标集、弹层挂载点
├─ template.css      模板新增组件；基础样式复用 ../frontend-redesign/styles.css
├─ serve.py          只读预览服务（仅暴露模板、原型样式与演示图）
├─ js/
│  ├─ data.js        演示数据：纹样、版本、任务、流程、台账、预设、批次、审计
│  ├─ ui.js          图版、对比、表单、状态、弹层、提示等通用组件
│  ├─ views-home.js
│  ├─ views-workbench.js
│  ├─ views-library.js
│  ├─ views-batch.js
│  ├─ views-tasks.js
│  ├─ views-settings.js
│  ├─ views-notes.js
│  └─ app.js         状态、路由、动作、模拟任务与计时器
└─ README.md
```

普通 `<script>` 按顺序加载，没有模块和构建；`file://` 下可直接运行。

## 与后端功能的对应

完整逐条映射见「说明 → 接口覆盖」。分组概览：

- 基础：`/health`、`/settings`、`/seedream/status|inputs|validations|settlement`
- 图像与资产：`/images`、`/images/{id}`、`/images/{id}/history`、`/assets`、`/assets/{id}`、`preview`、`download`
- 本机任务：`crop`、`prepare`、`working-copy`、`enhance`、`extract`、`lineart`、`vectorize`、`pipelines`、`exports`、`jobs`、`cancel`、`retry`、`feedback`
- 纹样库：`patterns`、`pattern-categories`、`workbench/items`
- 批量：`workflow-presets`、`processing-batches`、`items/{item}/resume`
- SVG：`svg-elements`、`edit-svg`、`recolor-svg`
- 修复/平铺：`repair`、`repairs/{id}`、`decision`、`tile-preview`、`seam-observation`
- 云端辅助：`pipelines/ai`、`layers`、`compose-layers`、`continue`、`rerun`、`cloud-lineart`、`refine-mask`
- 数据集：`datasets/manifest.csv`、`datasets/audit`

## 接入真实服务时

1. 保留 `views-*.js` 的标记与类名，把 `runAction` 中对应的模拟动作替换为 `fetch("/api/v1/...")`。
2. 用 `GET /health`、`/settings`、`/patterns` 等返回值替换 `js/data.js` 的演示数据；分页、revision、blockers 都已按接口字段命名。
3. 云端动作保留「设置门禁 + 每次请求双同意」再发请求；结果未知时只核对台账，不自动重试。
4. 版本、任务、批次等列表继续以服务端返回为准；这些页面已经按服务端状态字段（`state`、`revision`、`progress`、`items`）渲染。
5. 真实 ZIP 与下载走 `/exports` 与 `/assets/{id}/download`；模板里只有单资产下载是真实的。

## 已知限制

- 演示数据与模拟进度，不代表真实算法、云端费用或素材质量验收。
- 没有构建步骤，也没有第三方依赖；只使用本机字体（Noto Serif SC / Noto Sans SC / Bahnschrift / Cascadia Code），缺字体时观感会变。
- 工作台以桌面为主；≤900px 改为单栏滚动、工序条横向滚动，参数栏在画布下方，未做完整触摸手势与屏幕阅读器走查。
- `file://` 下浏览器可能限制剪贴板与部分下载；不影响页面浏览与演示。
- 原型的 README 与评审截图不受本模板影响。

## 验证记录

- Chrome（headless，1440×900、1280×800、1024×768、820×900、390×844）逐页检查：无横向溢出、无控制台报错、无网络请求（仅 `file://` 本地资源）。
- 已跑通：工作台八道工序切换与模拟执行、云端双同意门禁、修复候选接受/拒绝、候选合成、SVG 编辑/换色、平铺、导出许可、上传与近似版本、批量创建与推进、人工续接、任务取消/重试/反馈、设置保存、云端自检与结算、manifest 下载、命令面板搜索与跳转、夜墨主题。
- 未做：真实接口联调、真实云端质量与费用实验、完整键盘/屏幕阅读器走查。

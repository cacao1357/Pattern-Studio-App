# 前端接入说明（新版工作台）

日期：2026-11-10（2026-11-11 合并到 `main`；同日接入「蜜蜡 · 沉褐」配色）
状态：新版工作台已接入本机服务并纳入版本库（提交 `016197b`）；旧前端文件原地保留并通过 `/legacy/` 只读访问。
配色接入见第 8 节，配色参数与评审记录见 [配色决定记录](palette-review.md)。

## 1. 服务与目录

| 路径 | 内容 | 说明 |
| --- | --- | --- |
| `/` | `frontend/next-v2/index.html` | 正式界面；hash 路由（`#/home`、`#/workbench`…） |
| `/css/*`、`/js/*`、`/assets/*` | `frontend/next-v2/` 下的静态资源 | 只允许预期后缀，禁止目录穿越 |
| `/legacy/` | `frontend/index.html` 等旧前端文件 | 原文件未改动；用于对照与回退，新界面不链接它 |
| `/api/v1/*` | 本机 FastAPI | 旧前端同样调用这套接口 |

- 挂载代码：`backend/app/api/frontend.py`；`backend/app/api/workbench.py` 不再负责页面文件。
- 文档级 CSP 只对两个 HTML 文档生效：
  - 新界面：`script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'`（内联样式用于裁切框、蒙版笔触等真实几何；脚本仍只允许同源）。
  - 旧界面：沿用原来的严格策略（无内联样式、无 `data:` 图片）。
- 测试：`tests/test_shell.py` 覆盖根路径、旧路径、CSP 与目录穿越。

## 2. 前端结构

| 文件 | 职责 |
| --- | --- |
| `js/app.js` | 外壳：hash 路由、视图挂载、状态条、提示、抽屉、命令面板、上传入口、全局快捷键 |
| `js/api.js` | `/api/v1` 薄客户端：统一错误、幂等键、`X-Pattern-Studio` 写标记、任务轮询 `waitForJob` |
| `js/store.js` | 服务端数据：健康、设置、云端状态、数据集、最近资产/任务、工作会话、纹样库查询 |
| `js/format.js` | 后端英文枚举 → 中文文案、时间/尺寸/字节格式化、HTML 转义 |
| `js/views/*.js` | 首页、工作台、纹样库、设置、使用说明 |
| `js/data.js` | 只剩静态工序定义（编号、名称、标题、说明） |
| `js/samples.js` | 七道工序的样例图定义（`assets/demo` 下的缠枝莲团花，首页工序卡与导览共用） |

视图契约不变：`{ id, title, flush, render(state, api, params), mount(root, state, api, params), unmount() }`。
异步数据变化由视图自己在 `mount` 中订阅 `store` 并调用 `api.refresh()`，避免全局重绘打断输入。

## 3. 工作会话模型

- `store.session`：`imageId`、`image`（`GET /api/v1/images/{id}`）、`assets[]`（本次会话出现过的资产）、`currentAssetId`、`jobs[]`、`busy`。
- 上传：`POST /api/v1/images`（FormData，带幂等键）→ 用返回的 `original` / `normalized` 初始化会话。
- 打开已有资产：`store.openAsset(assetId)` → `GET /assets/{id}` + 同图原件/规范输入；URL 参数 `#/workbench?image=<imageId>&asset=<assetId>&stage=<1-7>`。
- 任务：`store.runJob(() => http.xxx(...))` 在提交前捕获会话归属，再每 1.2s 轮询 `GET /jobs/{id}`，返回 `{ job, owned }`。切换会话后停止该页面的旧任务轮询，不取消服务端任务，不向新会话写产物、进度或成功回调；失败/取消已发布的产物仍保留。
- 会话只存在内存里；刷新页面通过 URL 或纹样库重新进入（不写浏览器存储，与旧前端行为一致）。

## 4. 工序与接口

| 工序 | 真实接口 | 产物 |
| --- | --- | --- |
| 01 来源 | `POST /images`、`GET /images/{id}` | original、normalized_input |
| 02 裁切 | `POST /jobs/crop`、`POST /jobs/working-copy` | crop、working_copy |
| 03 处理 | 默认 `POST /pipelines`（`recipe: model_lineart`）；可选 `color`、`POST /jobs/lineart`（model/opencv）、`POST /jobs/vectorize` | foreground_mask、transparent_png、contour_line_art、lineart、svg |
| 04 候选 | `POST /pipelines/ai`、`GET /jobs/{id}/layers`、`POST /jobs/compose-layers` | 云端候选层、合成候选 |
| 05 蒙版 | `POST /jobs/refine-mask` | 修正后的 transparent_png |
| 06 修复 | `POST /jobs/repair`、`GET /repairs/{id}`、`POST /repairs/{id}/decision` | 修复候选、接受/拒绝记录 |
| 07 平铺 | `POST /jobs/tile-preview`、`PUT /assets/{id}/seam-observation` | tile_preview、接缝观察 |
| 导出 | `POST /exports`、`GET /assets/{id}/download` | ZIP 包（含清单） |

云端相关接口只在设置满足 `api_key_configured`、付费开关、价格确认与预算后可用；未满足时界面显示 blockers 并保持本地流程可用。所有写请求由 `js/api.js` 自动带 `X-Pattern-Studio: local` 与一次性 `Idempotency-Key`。

## 5. 已知限制

- 模型入口由 `/health` 的 `capabilities.lineart_model` 判断前置条件；未通过时说明原因，旧后端缺字段时按未知处理。前置检查不证明推理或 GPU 一定成功，真实任务仍展示后端错误。必须把模型依赖安装在启动服务的同一个 Python 环境。
- 接近 100 万像素的图在部分环境下矢量化可能触及 worker 内存上限（1024 MiB）；先创建工作副本更稳。
- 前端没有构建步骤；修改后刷新即可，静态资源使用 `Cache-Control: no-store`。
- 颜色用 `color-mix()` 派生明暗与透明层，需要 Chrome 111+ / Safari 16.2+ / Firefox 113+；更旧的浏览器会丢这些半透明层。
- 页面按 Chrome 验证；Safari/Firefox 与完整屏幕阅读器走查未做。
- `frontend/tests/next-v2-integration.test.mjs` 覆盖新版 API/store 及工作台请求/产物语义；旧的 30 项模块测试仍针对 `frontend/` 根目录。新版 DOM 与真实 worker 的定向检查见 `scripts/validate_v2_integration.mjs`。

## 6. 回退

- 只回退页面：把 `backend/app/api/frontend.py` 的挂载点改回旧路由，或直接使用 `/legacy/` 作为日常对照（无需改文件）。
- 回退整个版本：`git revert 016197b`，恢复旧工作台入口并移除新界面；该提交同时把 `limit_concurrency` 调回 8。
- 新前端不再依赖未跟踪目录：`frontend/next-v2/` 已提交，克隆仓库即可运行。`frontend/next/` 与 `frontend/next-v2-backup-20261110/` 是仅保留在本机的旧版草稿，已写入 `.gitignore`，不属于仓库内容。

## 7. 提交与验证记录

- 提交 `016197b`：`feat(frontend): serve the integrated studio UI at / and the legacy UI at /legacy`，2026-11-11 合并到 `main`。
- 后端全量测试：`python -B -m pytest -q` → 77 passed、2 subtests；其中 `tests/test_shell.py` 覆盖根路径与静态资源、`/legacy/` 入口、两套 CSP、目录穿越与测试模块不可达。
- 旧前端模块测试：`node --test frontend/tests/settings.test.mjs frontend/tests/workbench-regressions.test.mjs` → 30 passed（旧模块未改）。
- 新前端模块：`node --check` 全部通过；页面无构建步骤。
- 浏览器（Chrome，1440×900 与 390 宽）：首页、工作台七道工序、纹样库分页/筛选/抽屉、设置读写与 409/422、`?image/asset/stage` 深链、`/legacy/` 无报错；53 个请求全部同源，未写 `localStorage`/`sessionStorage`。
- 已知环境限制见上文第 5 节；真实云端候选与局部修复仍需配置密钥和费用门禁后单独验收。

## 8. 配色接入（蜜蜡 · 沉褐，2026-11-11）

评审期的隔离预览目录 `frontend/next-v3/` 与 `PATTERN_STUDIO_UI_PREVIEW` 脚手架已删除，配色直接落在正式前端，
`/` 就是新配色；没有 `/preview/` 这类双入口。

- `frontend/next-v2/css/tokens.css`：令牌换成「蜜蜡 · 沉褐」，并补 `--on-accent`、`--action-bg/-bg-hi/-fg/-edge`、
  `--paper-ink-3`；线改为旧金混色、阴影改为暖褐黑、焦点环改用 `--cinnabar-hi`。
- 视图样式里的硬编码色号改为令牌派生（`color-mix(in srgb, var(--token) n%, transparent)`），去掉彩色光晕与霓虹阴影；
  主操作由「暗红实心 + 米白字」改为「琥珀实心 + 墨字」（`--action-*`）。
- 评审覆盖层里的结构规则折进对应文件，不在运行时追加第三张样式表：
  `.ambient` 顶部灯光与四角暗角（base.css）、`.hero__stage::before` 与 `.specimen` 的展台光（home.css）、
  品牌印与图版印（shell.css / home.css）、`.compare__grip` 与工作台对比滑柄（home.css / workbench.css）、
  纸白按钮与抽屉／命令面板的暖影（base.css / shell.css）、`::selection` 反白墨字（base.css）。
- 错误语义从强调色剥离：琥珀在方案里只表示「当前 / 主操作 / 强调」，新增 `--error` / `--error-line` 砖红令牌，
  纹样库与设置页的错误态、以及轻提示的 warn/error 图标改用砖红（通过用铜绿），不再和「当前」同色。
- 对比度工具从评审目录迁到 `scripts/check_contrast.py`（默认解析 `frontend/next-v2/css/tokens.css`）；
  评审记录、参数表与遗留问题迁到 [配色决定记录](palette-review.md)。
- 后端口径不变：`mount_frontend` 仍只挂 `/`、`/css`、`/js`、`/assets` 与 `/legacy/`；`/` 的 CSP 未放宽。
  预览路由与 `PATTERN_STUDIO_UI_PREVIEW` 一起删除，`/preview/` 现在按未知路径处理。
- 没有新增依赖、没有构建步骤；颜色派生依赖 `color-mix()`（Chrome 111+ / Safari 16.2+ / Firefox 113+）。

## 9. 2026-11-11 第一批可靠性对接

- 会话使用身份令牌，加载使用顺序号；晚到的资产/图片/上传响应不替换新会话。首页和纹样库消费者同步处理已失效的加载结果。
- 新版默认模型一键，单独线稿支持模型与 OpenCV；取消环境写死判断。健康轮询仅更新模型能力，不重置用户参数。
- 接受修复后根据 `decision.accepted_asset_id` 读取新资产并加入原会话，可继续选择、平铺和导出；读取失败不会声称资产已可用。
- 深链由外壳在 URL 改变时加载一次；工作台重绘不重复选回深链原输入，避免新线稿或手动选择立即被重置。
- 本批保留已有设计、配色评审内容及旧前端；当时没有提交、推送或重启生产服务，已在 2026-11-12 的整理提交入库并推送到 `main`。

本次验证：Python 定向 19 项通过；前端 45 项通过（其中新版 15 项）；隔离合成图真实 CUDA PNG→SVG 冒烟通过；Chrome 1440×900 / 390×844 通过默认模型入口、任务产物采纳与跨图晚到轮询隔离检查，页面异常 0、云端生成请求 0。夹具内原有一条模拟归档调用，不是真实计费调用。Edge 调试端口启动曾超时，改用已安装 Chrome 完成验证，不视为 Edge 已通过。

复现：

```powershell
node --test frontend/tests/next-v2-integration.test.mjs frontend/tests/settings.test.mjs frontend/tests/workbench-regressions.test.mjs
python -B -m pytest -q -p no:cacheprovider tests/test_lineart_capabilities.py tests/test_lineart.py tests/test_dataset_api.py::test_model_pipeline_traces_lineart_without_color_extraction tests/test_api_p0.py::test_health_reports_versions
node scripts/validate_v2_integration.mjs D:/CondaEnvs/pattern-studio/python.exe
```

`python` 须指向已安装项目依赖的 Python 3.11。浏览器脚本需要已安装的模型、CUDA、Node 22 与 Chrome；可用 `PATTERN_STUDIO_TEST_BROWSER` 指定其他 Chromium 浏览器。脚本使用现有隔离夹具，结果保存在被忽略的 `storage/validation/v2-reliability/`。模型验证仅用合成图，不能证明真实素材保真质量。

本批没有实现 `/continue`、`/rerun` 的新版云端工作流闭环、按图恢复完整历史、裁切图云端输入或坐标对齐对比；这些是下一批工作。修复接纳采用模拟响应回归，真实云端修复仍需在明确样例和费用上限后验收。非任务型接缝保存等异步交互的跨会话状态保护尚待补齐。

新版界面与旧版页面依然共享 `/api/v1`，静态挂载的只读对照不等于业务数据只读；测试应使用隔离数据目录。


## 10. 第二批接口准备（前端尚未接入）

后端现提供 `/api/v1/images/{image_id}/history`，按 `collection=assets|jobs|flows` 分别分页；字段及边界见接口合同。恢复不能只取首页近期任务，也不能把分页中途失败当作完整恢复。排队和执行中的任务只能按已有 job ID 查询，不能重新提交云端请求。

新版前端第二批尚未实施：DSH 委派被自动审批阻止，需明确批准外部 DeepSeek 源码处理后继续。当前页面仍使用第一批的内存会话与独立合成逻辑，不能宣称已接通 `/continue`、`/rerun` 或完整历史恢复。本阶段后端离线验证共 17 项及 2 个子测试通过，当时未重启生产服务；代码已在 2026-11-12 的整理提交入库并推送到 `main`。

## 11. 配色接入的验证记录（2026-11-11）

- 前端模块测试：`node --test frontend/tests/next-v2-integration.test.mjs frontend/tests/settings.test.mjs frontend/tests/workbench-regressions.test.mjs` → 45 passed。
- 对比度：`python scripts/check_contrast.py` → 解析 `next-v2/css/tokens.css` 的 33 个字面量令牌，22 组配对全部达标（明细见 [配色决定记录](palette-review.md) 第 6 节）。
- 后端挂载（隔离实例，独立存储目录，不动已在运行的服务）：`/` 200 且仍是 studio CSP，`/preview/` 404，`/assets/favicon.svg` 200，`/legacy/` 200，`/api/v1/health` 200。
- 后端测试：`tests/` 69 passed（`PYTHONPATH=backend`）。本机 DSH 沙箱会把 `0o700` 目录变成不可列目录的对象，pytest 的 `tmp_path` 需一次性 shim；`backend/tests/` 大量用例直接用 `tempfile.TemporaryDirectory()`，在该沙箱下不可运行，本批未执行，不能据此判定通过或失败。
- 浏览器（Chrome，真实本机数据）：首页、工作台（含资产与空态）、纹样库、设置、使用说明共 5 页 + 七道工序导览浮层，1440×900 与 390×844 均无横向溢出、控制台无报错、请求全部同源；Lighthouse 无障碍逐页 100（设置页首轮 96 由警示面板金色标签 4.07:1 引起，已修）。
- 截图：`frontend/next-v2/review/` 已按新配色重出 8 张（清单见 [next-v2/README.md](../frontend/next-v2/README.md) 的「截图」一节）。本批没有重拍「对比」：现有素材只有原件与规范输入，工作台如实提示没有可对比的另一版本。
- 未做：Safari / Firefox、屏幕阅读器、超宽屏暗角复核；未重启已在运行的 8765 服务；未做真实素材质量、真实云端与第二批前端验收。



## 12. 2026-11-13 工序样例图、首页进度高亮与工作台资产分组

纯前端改动，未改接口、参数版本、后端与 `docs/a-interface-contract.md`：

- 首页：七道工序卡与导览浮层各配一张 `assets/demo` 的缠枝莲团花样例（同一张纹样从原图走到无缝平铺），
  `js/samples.js` 提供 `sampleFor(stage)`；工序高亮不再写死第 3 道，按「正在跑的任务 → `store.lastStage`（用户刚停下的工序）
  → 当前资产类型 → 最近成果」推断「已完成 / 最近一步」（`format.js` 新增 `stageForJobKind` / `stageForJob`）。
- 工作台左栏：会话资产按**工序分组**（`01 来源 / 02 裁切 / 03 处理 …`），组头显示数量并可折叠，组内两列纸面缩略图；
  同一步同一类型跑过多次时按生成时间编号 `v1…vN`，当前资产琥珀描边 +「当前」角标，切图后自动滚进视野（折叠组会先展开）。
  分组与排序是纯函数 `groupAssets`，在 `frontend/tests/next-v2-integration.test.mjs` 覆盖。
- 蒙版笔迹：一笔改渲染为**一条圆头描边路径**（半透明宽带 + 一条细中线），采样点按笔刷半径抽稀后再记录；
  提交给后端的仍是 `{mode, radius, points[]}`，接口不变。
- 两次布局尝试（三栏宽度改按图版高度分配、参数栏改三段式）按反馈**已回退**，三栏仍为 `264px | 1fr | 368px`，
  面板仍是「标题 + 控件 + 行内说明」；回退后逐档宽度复测与原版一致。

验证：

- 前端模块测试：`node --test frontend/tests/next-v2-integration.test.mjs frontend/tests/settings.test.mjs frontend/tests/workbench-regressions.test.mjs`
  → 47 passed（新增分组/参数摘要 2 项）。
- 浏览器（Chrome，真实本机数据）：首页、纹样库、设置、使用说明与工作台七道工序逐页核对；
  视口 1081 / 1150 / 1200 / 1280 / 1300 / 1366 / 1440 / 1512 / 1680 / 1920 / 2560，以及 1080 / 1024 / 900 / 820 / 390
  均无横向溢出、控制台无报错；工作台三栏宽度、图版边长与原版逐档一致。
- 未做：`frontend/next-v2/review/` 截图未重拍（首页、导览、工作台两张已过时）；未做真实素材质量、真实云端与 Safari/Firefox 验收。

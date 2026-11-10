# 前端接入说明（新版工作台）

日期：2026-11-10（2026-11-11 合并到 `main`）
状态：新版工作台已接入本机服务并纳入版本库（提交 `016197b`）；旧前端文件原地保留并通过 `/legacy/` 只读访问。

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

视图契约不变：`{ id, title, flush, render(state, api, params), mount(root, state, api, params), unmount() }`。
异步数据变化由视图自己在 `mount` 中订阅 `store` 并调用 `api.refresh()`，避免全局重绘打断输入。

## 3. 工作会话模型

- `store.session`：`imageId`、`image`（`GET /api/v1/images/{id}`）、`assets[]`（本次会话出现过的资产）、`currentAssetId`、`jobs[]`、`busy`。
- 上传：`POST /api/v1/images`（FormData，带幂等键）→ 用返回的 `original` / `normalized` 初始化会话。
- 打开已有资产：`store.openAsset(assetId)` → `GET /assets/{id}` + 同图原件/规范输入；URL 参数 `#/workbench?image=<imageId>&asset=<assetId>&stage=<1-7>`。
- 任务：`store.runJob(http.xxx(...))` 提交后每 1.2s 轮询 `GET /jobs/{id}`，终态后把 `result.assets` 并入会话；失败展示 `job.error.message`。
- 会话只存在内存里；刷新页面通过 URL 或纹样库重新进入（不写浏览器存储，与旧前端行为一致）。

## 4. 工序与接口

| 工序 | 真实接口 | 产物 |
| --- | --- | --- |
| 01 来源 | `POST /images`、`GET /images/{id}` | original、normalized_input |
| 02 裁切 | `POST /jobs/crop`、`POST /jobs/working-copy` | crop、working_copy |
| 03 处理 | `POST /pipelines`（`recipe: color` / `model_lineart`）、`POST /jobs/lineart`、`POST /jobs/vectorize` | foreground_mask、transparent_png、contour_line_art、lineart、svg |
| 04 候选 | `POST /pipelines/ai`、`GET /jobs/{id}/layers`、`POST /jobs/compose-layers` | 云端候选层、合成候选 |
| 05 蒙版 | `POST /jobs/refine-mask` | 修正后的 transparent_png |
| 06 修复 | `POST /jobs/repair`、`GET /repairs/{id}`、`POST /repairs/{id}/decision` | 修复候选、接受/拒绝记录 |
| 07 平铺 | `POST /jobs/tile-preview`、`PUT /assets/{id}/seam-observation` | tile_preview、接缝观察 |
| 导出 | `POST /exports`、`GET /assets/{id}/download` | ZIP 包（含清单） |

云端相关接口只在设置满足 `api_key_configured`、付费开关、价格确认与预算后可用；未满足时界面显示 blockers 并保持本地流程可用。所有写请求由 `js/api.js` 自动带 `X-Pattern-Studio: local` 与一次性 `Idempotency-Key`。

## 5. 已知限制

- 本机运行环境若未安装 torch / 分割模型库，`recipe: model_lineart` 与 `lineart method=model` 会失败；界面显示后端错误，不伪装成功。
- 接近 100 万像素的图在部分环境下矢量化可能触及 worker 内存上限（1024 MiB）；先创建工作副本更稳。
- 前端没有构建步骤；修改后刷新即可，静态资源使用 `Cache-Control: no-store`。
- 页面按 Chrome 验证；Safari/Firefox 与完整屏幕阅读器走查未做。
- 旧的 Node 前端测试仍针对 `frontend/` 根目录模块，不覆盖新版视图。

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

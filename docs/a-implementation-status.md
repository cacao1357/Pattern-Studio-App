# A 实施与交接记录

基础交接日期为 2026-11-01。2026-11-08 工作台更新记录见下文。

## 完成范围

已完成当前可独立交付的 A 基础实现，并接通现有提取与矢量化链路。B/C 的新算法与真实素材最终质量验收仍按原分工推进。

| 责任 | 已落地行为 |
| --- | --- |
| 设置与设置界面 | 顶部“设置”入口；密钥保留/替换/清除；模型/官方端点、付费开关、价格确认；保存后新任务生效 |
| 设置安全 | 密钥不回显、不写浏览器持久化；新旧密钥用于防止备注、文件名、请求标识泄露；原子保存、失败保留原配置、修订冲突提示复核 |
| 公共云端接口 | `ImageProvider` 协议；沿用 Seedream 单次调用；模拟提供者可独立验证对接，不引入运行时依赖 |
| 工作流编排 | 预设标识/版本；提交时固定模型、端点、输入、分辨率、矢量参数、提示词版本和实际文本；调用记录保存提交时的付费开关与价格确认快照 |
| 选层衔接 | 单个协调器接收 B 的选层结果；校验后可自动继续；当前没有已验证规则，默认停在人工确认 |
| 局部恢复 | 复用图层重新合成；复用 PNG 或蒙版修正后代重新矢量化；旧结果不覆盖，分支记录父任务；刷新后可恢复所属流程 |
| 费用与异常 | 关闭付费可阻止未开始的调用；云端超时/中断保留未知结果，不自动重试；本地失败保留已发布 PNG |

字段与响应以 [接口合同](a-interface-contract.md) 为准。

## 使用与生效

使用现有 Python 环境运行 `python -B scripts/serve_api.py`，在工作台顶部打开“设置”。更新代码后，已有服务需正常停止并重新启动以加载本次代码；此后在设置页保存配置无需重启服务。

配置优先级为项目 `.env`、进程环境变量、`storage/settings.json`，后者优先。设置页不改写 `.env`。私有文件被 Git 忽略，位于 `storage/api/` 备份范围之外；正常备份不携带其中的密钥。

保存只做本地验证，不验证密钥在供应商处是否有效，也不生成图片。付费开关与价格确认是本地闸门；预算、单次预留和调用次数不再是门槛，实际费用仍需供应商账单核对。进行中的请求保持启动配置；排队任务模型和提示词沿用提交快照，但检查启动时的当前密钥与付费开关。

## B/C 并行接入

- B 在 `backend/app/providers/prompts.py` 增加不可变提示词版本，实验明确指定版本；保留旧版本，未实测模板不替换默认。API 使用 `prompt` 字段，没有额外的 `system` 角色。
- B 在 `backend/app/services/workflow.py` 的 `select_candidate_layers` 返回 `layer_ids`、`policy_version`、简短 `reason`；空列表表示人工确认，不在这里增加云端调用。流程验证图层归属并记录自动/人工来源。
- B 的蒙版修正沿用现有接口，产生的 PNG 通过来源关系成为可选矢量化输入。
- C 保持 `backend/app/services/vector.py` 和 `VectorOptions` 契约；PNG 来源、SVG 结果、步骤失败及恢复已接通，可独立调试。
- 修改共享前端文件或参数合同前协调归属。本次沿用 B/C 负责的提取及矢量算法。

## 验证

### 2026-11-13 新线稿模型接入

- 将交付包 `model-package-2026-11-13/weights/` 的权重与推理配置部署到既有 `model/`；原交付包保留，不分发其中的私有样例。旧权重历史仍由 Git 管理，本次未提交或推送。
- 模型版本 `lineart-gts2-tex-seed42-alpha0-tiled-v1`，权重标识 `e63084fb76094a0f3e9e4623f733e9351450e8c077475f97c81197bd3928cdc6`。固定部署 α=0、阈值 0.5，512 窗口 / 256 步长、渐变加权重叠融合、边缘复制填充并裁回原尺寸。输出沿用透明底黑线 PNG 和既有 SVG 接口。
- `backend/app/services/texture_gated_net.py` 包含部署结构，完整严格载入线稿与门控权重，但 α=0 时只执行线稿分支；不依赖训练目录或下载预训练编码器。与训练项目原始 α=0 实现比较，512 样例的最大概率差为 `5.96e-8`，二值结果一致。
- 使用现有 `D:/CondaEnvs/pattern-studio/python.exe`，Torch `2.9.1+cu128` / SMP `0.5.0` / RTX 5070 Laptop 验证：包内 `new200_B_191.png` 的墨量 7.35%；通过隔离 HTTP 服务和受限 worker 完成上传 → CUDA 线稿 → SVG，约 6.14 秒。
- 包内 `pattern1600/p15.png`（1600×1600）分块推理约 3.39 秒，墨量 6.34%；该验证进程记录的 CUDA 峰值分配约 431 MiB（不代表系统总显存）。输出在忽略目录 `storage/validation/model-20261113/`。
- 模型、能力发现与模型流水线定向回归：`python -B -m pytest tests/test_lineart.py tests/test_lineart_capabilities.py tests/test_dataset_api.py -q`，25 项通过。新增 4 个参数化场景覆盖原尺度坐标、边缘复制、小图、非整步长及狭长图拼接。
- 用户选择本次暂缓真实云端验收；当前项目尚无云端密钥及费用配置。本地推理验证不等于真实照片保真或云端模型质量验收。

### 2026-11-13 云端候选生命周期前端接入

- 新版工作台已接入按图 `flows` 历史恢复、首次 `continue` 与后续 `rerun` 本地重合成；关闭付费或缺少密钥时归档候选仍可读、可选，恢复和轮询只读已有任务，不重发云端请求。
- 验证：后端 `tests/` 73 项、`backend/tests/` 23 项及 2 个子测试通过（本机沙箱对 `0o700` 临时目录不可列，使用一次性 shim，未改仓库测试）；前端 25 + 8 + 22 项通过。隔离夹具 live HTTP 完成 health → 上传 → 新模型 CUDA 线稿 + SVG → 平铺 → ZIP 导出 → 历史/设置读取；Chrome 完成归档层 → `continue` → 刷新恢复 → `rerun` 分支，云端调用计数保持 1、页面异常 0。`scripts/validate_v2_integration.mjs` 因本机沙箱 `spawn EPERM` 未整脚本执行，未计为自动化通过。
- 未接入 `assets`/`jobs` 历史页与修复候选的刷新恢复。接口与细节见 [前端接入说明第 10 节](frontend-integration.md)。

### 2026-11-13 设置简化与费用门槛移除

- 设置页的 API Key 改为单一输入框 + 行内「保存密钥」，粘贴后直接保存，不再需要先找底部保存；清除密钥仍为独立次要操作。
- 移除预算上限、单次预留、最大调用次数及相关拦截；服务端不再按金额或次数拒绝云端调用。保留付费开关、价格确认和每次调用前的上传/调用勾选。
- 首页、工作台、使用说明移除费用与预算文案；云端卡片只显示调用次数和配置状态。旧客户端提交的预算字段仍被接受但不生效，实际费用以服务商账单为准。
- 验证：前端 25 + 8 + 22 项、后端 `tests/` 73 项、`backend/tests/` 23 项及 2 个子测试通过；隔离夹具 Chrome 中完成「粘贴密钥 → 保存 → 开启付费/价格确认」并确认设置页无预算字段、首页/使用说明无费用文案；live HTTP 冒烟仍通过模型 CUDA 线稿、平铺与 ZIP 导出。

### 2026-11-13 设置保存报错排查（Seedream 5.5）

- 现象：在设置页保存云端配置时返回 422，页面只显示「设置校验未通过，请检查填写内容。」，无法判断是哪一项被拒。
- 原因：`Settings` 的模型白名单只允许 `doubao-seedream-5-0-pro/flash-*` 或 `ep-*`；方舟 Seedream 5.5 的官方 Model ID 是 `doubao-seedream-5-5-261028`，因此连同密钥、端点一起提交时整次保存被拒。前端 `api.js` 又把 422 的 `message` 统一替换为通用中文，掩盖了具体字段。
- 修复：`backend/app/config.py` 的白名单增加 `doubao-seedream-5-5-\d{6}`；`api.js` 的 `ApiError` 保留服务端 `detail`；设置页按 `SEEDREAM_MODEL`、`ARK_BASE_URL`、`API_KEY` 映射为中文提示，并在模型输入框标注可用的 Model ID 示例。
- 验证：`backend/tests/test_runtime_settings.py` 7 项通过（新增 5.5 接受、未登记型号拒绝）；隔离 `PUT /api/v1/settings` 探测中，5.5 + 完整端点 + 新密钥返回 200，端点归一化为 `/api/v3`，未登记型号返回 422 且 `message` 指明 `SEEDREAM_MODEL`。未使用真实密钥发起云端调用，5.5 的实际出图质量与计费仍未验收。

### 2026-11-13 云端编辑去水印与输入尺寸对齐

- `backend/app/providers/seedream.py` 的请求改为 `watermark: false`，调用快照同步记录；5.5 输出不再带右下角「AI生成」水印。
- 编辑/修复请求不再固定发送 `1K`，而是发送显式 `宽x高`：输入总像素在方舟允许的 `921600..4624220` 内时直接请求输入尺寸；低于下限时按原比例取最近的合法尺寸。服务端收到候选后，若与输入尺寸不同且宽高比误差在 2% 内，用预乘 RGBA Lanczos 缩回输入尺寸，并在资产元数据记录 `requested_size` 与 `geometry_transform`；比例不符则保持原尺寸，由既有 `CANDIDATE_SPACE_MISMATCH` 拒绝合成。
- `edit_candidate` 算法版本更新为 `seedream-edit-v2-input-geometry`。分层流程仍使用 `1K/1.5K/2K` 档位，basemap 定义坐标空间；去水印同样生效。
- 真实 5.5 修复验证：输入 973×730，请求 `1112x834`，返回 1112×834 后缩回 973×730；候选与本地合成均为 973×730，修复任务 `waiting_user`、无 `CANDIDATE_SPACE_MISMATCH`，画面上方缺口已补全，未见水印。本次共 2 次真实调用（含此前一次对照），没有自动重试，费用以服务商账单为准。
- 单元测试新增 `edit_output_size` 的尺寸/比例边界检查；`tests/test_api_p0.py` 8 项通过。效果图保存在忽略目录 `storage/validation/takeover/cloud-20261113/`。

### 2026-11-13 本地模型与云端提取的线稿测试

- 本地模型路线（`recipe: model_lineart`）：同一张 973×730 云纹图在提高 worker 内存上限后成功产出 `lineart` PNG（973×730）和 `svg`（973×730）；512×512 图同样成功。此前 973×730 在 4 GiB 模型上限下完成线稿后、矢量化阶段触发 `WORKER_MEMORY_LIMIT`。
- 云端路线（Seedream 5.5，单次真实分层调用）：返回 basemap 1182×887 和 1 个候选层；选层合成后得到 `composed_candidate` 1182×887、`contour_line_art` 1182×887。颜色矢量化在 1 MP 时会稳定触发 vtracer 崩溃，改为 25 万像素 `working_copy`（577×433）后合成任务成功并产出 SVG（577×433），变换记录在 `working_copy` 的 `transform`。
- 资源上限调整：`LOCAL_MEMORY_MIB` 1024→6144，`LINEART_MODEL_MEMORY_MIB` 4096→6144；新增 `max_color_vector_pixels = 250_000`。当前机器可用内存约 16 GB，worker 串行运行，未观察到系统内存压力。
- 质量观察：本地 TGS 线稿保留云纹内部螺旋和细线；云端 `contour_line_art` 只勾出选中层的轮廓（外轮廓），不含内部细节，属掩膜轮廓而非生成式线稿；云端 `composed_candidate` 的颜色与结构完整，可作为后续本地线稿的输入。
- 证据与效果图：`storage/validation/takeover/lineart-20261113/`（`lineart-compare.png` 为输入、本地线稿、云端提取、云端轮廓四联图）；本地任务 `235a66c8-8533-49e0-b4f7-3553339dd194`，云端合成任务 `1e2e6b0d-98dd-4243-b04b-73e66bc41db3`。真实云调用累计 3 次，未自动重试。
- 回归：`tests/test_api_p0.py`、`tests/test_vector_c.py` 与 `backend/tests/test_a_workflow.py` 共 38 项及 2 个子测试通过。

### 2026-11-08 工作台回归

工作台默认使用 GPU 优先的一键模型路线，并按标签页记录撤销、重做和清空。处理结果进入现有资产与任务历史。纹样库可加载透明图的关联蒙版，平铺复用处理后的 PNG，并按结果保存接缝观察。操作说明见 [README](../README.md#工作台操作)，接口见 [接口合同](a-interface-contract.md#本地一键处理)。

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 后端定向回归 | 24 项及 2 个子测试通过 | 一键模型产物与来源关系、旧接口兼容、蒙版与工作流恢复、平铺接缝及 ZIP |
| 前端模块回归 | 30 项通过 | 标签页编辑状态、预览、来源与导出保护、设置 |
| 隔离 Edge 与真实 CUDA | 20 项检查通过 | 默认模型一键产物、按页清空与重做、失败浮窗、裁切历史、关联蒙版、平铺规格及已有候选流程 |

在仓库根目录使用现有 Python 环境运行以下命令。Edge 脚本运行归档候选回归，GPU 一键和标签页操作是在同一隔离夹具中另外验证的。

```powershell
python -B -m pytest -q -p no:cacheprovider tests/test_dataset_api.py tests/test_api_p0.py tests/test_vector_c.py::test_local_rerun_preview_download_recolor_and_zip backend/tests/test_a_workflow.py
node --test frontend/tests/workbench-regressions.test.mjs frontend/tests/settings.test.mjs
node scripts/validate_a_browser.mjs (Get-Command python).Source
```

GPU 推理使用当前部署的模型权重和合成图。云端候选使用隔离归档夹具。真实素材保真、外部 SVG 编辑器验收和实际云端调用仍按协作计划验证。

### 2026-11-11 前端接入并合并 main

新版前端（`frontend/next-v2/`）已接入本机服务并纳入版本库：`backend/app/api/frontend.py` 把新界面挂在 `/`，旧前端原文件未改、通过 `/legacy/` 只读对照；接口映射、CSP 与回退方式见 [前端接入说明](frontend-integration.md)。接入提交为 `016197b`，已于 2026-11-11 合并到 `main`。

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 后端全量测试 | 77 项及 2 个子测试通过 | 新增 `tests/test_shell.py`：根路径与资源、`/legacy/`、两套 CSP、目录穿越与测试模块不可达 |
| 旧前端模块回归 | 30 项通过 | `frontend/tests/*.test.mjs`（旧模块未改） |
| 浏览器端到端 | 通过 | 上传 → 裁切 → 颜色提取 → 蒙版修正 → 2×2 平铺 → 导出 ZIP 下载；纹样库真实资产分页/筛选/抽屉；设置读取、保存、409 冲突；`?image/asset/stage` 深链；390 窄屏；`/legacy/` 无报错 |
| 服务并发 | 修正 | 新版页面并行请求较多，`limit_concurrency` 从 8 调到 32，避免静态资源被 503 |

复现：

```powershell
python -B -m pytest -q
node --test frontend/tests/settings.test.mjs frontend/tests/workbench-regressions.test.mjs
.\.venv\Scripts\python.exe -B scripts/serve_api.py
```

浏览器打开 <http://127.0.0.1:8765/> 走七道工序；旧版对照 <http://127.0.0.1:8765/legacy/>。本机环境无 torch 时「模型线稿」会如实失败，512 图在颜色管线矢量化阶段可能触发 worker 内存上限；这些属于已知环境限制，不是接口失败。真实云端候选与局部修复仍需配置密钥和付费开关后单独验收。

### 2026-11-11 配色评审 → 接入（「蜜蜡 · 沉褐」）

按「现在这版配色偏 AI 味」的反馈，先在 `frontend/next-v3/` 隔离副本里做评审（正式前端当时零改动）：先只换强调色（被否：像没改）→ 再做浅底/中调三个整屏方案绢白、靛蓝、青瓷（被否：都不如原版）→ 最终把中性近黑整体换成黄橙家族「蜜蜡」，再压一档褐、调暗，定为「蜜蜡 · 沉褐」，方向认可。

评审通过后按「接入新版前端，做好适配」并入 `frontend/next-v2/`，`/` 即为新配色；隔离预览目录与 `/preview/` 脚手架已删除，评审记录迁到 [配色决定记录](palette-review.md)，接入动作见 [前端接入说明](frontend-integration.md) 第 8 节。

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 对比度核算 | 通过 | `python scripts/check_contrast.py` 解析 `next-v2/css/tokens.css` 算 22 组配对：正文 13.26:1、次要 8.53:1、弱化 7.26:1、极弱 5.53:1、主按钮 7.73:1、纸面正文 12.79:1、砖红错误 7.11:1 |
| Lighthouse 无障碍 | 通过 | 首页 / 工作台（含资产与空态）/ 纹样库 / 设置均为 100；设置页首轮 96（警示面板内金色标签 4.07:1），改暗标签底后复跑 100 |
| 截图核对 | 通过 | 五个页面 + 390 宽 + 七道工序导览，1440×900 / 780×1688 无头 Chrome 实拍，重出 `next-v2/review/` |
| 页面复核 | 通过 | Chrome 1440×900 与 390×844：无横向溢出、控制台无报错、请求全部同源 |
| 后端挂载 | 通过 | 隔离实例 `/` 200（studio CSP 不变）、`/preview/` 404、`/legacy/` 200 |
| 前端模块测试 | 通过 | `next-v2-integration` + 旧版 `settings` / `workbench-regressions` 共 45 项 |

### 2026-11-01 基础交接

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 后端定向测试 | 18/18 | 设置持久化/清除/冲突/原子失败/并发；同源边界；密钥轮换；实际提示词冻结；局部重跑及归属；蒙版后代；未知云端结果；重启恢复；真实本地子进程 |
| 前端模块测试 | 8/8 | 元分换算、密钥操作、HTTP 及错误、流程/恢复/分支解析、PNG 输入列表 |
| 真实 Edge 对接 | 10/10 | 设置读写/冲突/清除；390px；归档图层合成；SVG 重跑；合成重跑；分支恢复；页面异常与云端请求检查 |
| 静态检查 | 通过 | JavaScript 语法、HTML ID/DOM 引用、Git diff 空白、文档链接 |

后端测试使用临时目录和 `httpx.MockTransport`；Edge 使用合成图层归档、假密钥、关闭付费的隔离服务。真实本地子进程执行了合成与矢量化。这些结果不代表真实云端模型质量或 30 张固定素材已通过验收。

在项目根目录、现有环境中复现：

```powershell
$env:PYTHONPATH = 'backend'
& D:/CondaEnvs/pattern-studio/python.exe -B -m unittest discover -s backend/tests -v
node frontend/tests/settings.test.mjs
node --experimental-default-type=module --check frontend/workbench.js
node --experimental-default-type=module --check frontend/settings.js
node scripts/validate_a_browser.mjs D:/CondaEnvs/pattern-studio/python.exe
```

Edge 结果：`storage/validation/a/browser-checks.json`；同目录保存桌面和窄屏设置截图。产物不提交 Git。脚本结束时仅清理本次创建的临时浏览器配置与测试数据。

## 协作追溯与后续验收

前端通过 Harness Relay 技能委派 DSH，后端实现和最终集成由 Codex 负责；原生辅助 Agent 完成设置服务切片及只读审查。

- 执行后端 `harness`；provider `deepseek-official`，model `deepseek-flash`，reasoning `high`。
- runId：`413a1f1c-4877-411f-820c-6b724afa0d4f`。
- sessionId：`session-02cbd6e3-eacb-4af5-a20b-56539a7f4ae8`。
- [DSH 会话](http://127.0.0.1:3080/?sessionId=session-02cbd6e3-eacb-4af5-a20b-56539a7f4ae8) 已成功结束；Codex 独立检查差异并执行 Edge 对接。审查发现的分支恢复归属缺口已修复补测。

后续共同确定固定样本、质量阈值和真实提示词实验预算，完成 B/C 交付后由 A 做最终真实素材集成验收。实现与验证使用隔离数据，没有付费模型调用，没有读取或改写实际私有配置；既有 README 定位说明保留。代码、测试、脚本和文档按现有目录组织；生成截图与检查结果留在被 Git 忽略的 `storage/validation/a/`，不随源码提交。

### 2026-11-11 新版可靠性对接（第一批）

本批完成模型前置能力接口、默认模型一键与分步入口、上传/加载/任务会话隔离、接受修复的新资产衔接、失败及取消保留产物说明。独立浏览器验收发现并修复深链在页内重绘时重置当前结果的问题。接口与复现命令见 [前端接入说明第 9 节](frontend-integration.md#9-2026-11-11-第一批可靠性对接)。

- 后端定向：19 passed。健康探测不加载 ML 运行时或权重；模型缺失不影响其他本地工具健康状态。
- 前端：45 passed，含新版 15 项行为回归；语法及差异检查通过。
- 隔离合成图：真实 CUDA 线稿 PNG→SVG 成功（单独后端冒烟约 16.7 秒），云端调用 0。
- Chrome：真实页面按钮提交、产物采纳、跨图旧任务隔离与桌面/窄屏访问通过，页面异常及云端生成请求均 0。Edge 的本轮调试端口启动超时，没有将其计为通过。
- 已有 `D:/CondaEnvs/pattern-studio/python.exe` 是具备模型依赖的 Python 3.11；本次检查时 8765 服务使用另一套 Python 3.12，缺少分割模型库。本批未重启该服务或改装依赖。

前端通过 Harness Relay 的 `delegate-to-deepseek-harness` 技能 委派，backend=harness，provider=deepseek-official，model=deepseek-flash，reasoning=high；runId=e7af3c23-d2a9-4d34-9050-101ff5d79b69，sessionId=session-759261cc-29ac-4577-bd7e-97b16b74ca74，状态 succeeded。Codex 完成后端、消费者兼容、深链结果采纳修复及独立验证。

本批当时保留了配色评审的本地文件，没有提交或推送；配色随后在「配色接入与适配」中并入正式前端，并于 2026-11-12 的整理提交入库（见文末「整理与推送」）。本批验证不代表真实素材质量、真实云端修复或完整历史恢复验收；下一批仍按原分工完善云端续接/局部重跑和恢复契约。


## 2026-11-11 第二批：历史查询后端已完成，前端待授权

- 增加按图分页历史 API，复用现有资产、任务及 AI 流程记录；保留失败部分产物和分支关系，兼容旧云端资产 `source_asset_id` 来源链。接口语义见接口合同“按图恢复历史”。
- 新增 `backend/tests/test_image_history.py` 四个离线集成用例，覆盖三类分页、多流程、任务及分支、重复上传隔离、旧来源链、校验和缺失图片、查询无新增任务或云端调用。
- 验证：设置 `PYTHONPATH=backend` 后运行 `python -B -m pytest -q -p no:cacheprovider backend/tests/test_image_history.py backend/tests/test_a_workflow.py`，17 passed、2 subtests passed。测试使用临时存储及 MockTransport，不访问生产素材或真实云端。首次缺少模块路径导致收集失败；补路径后旧来源链用例暴露兼容缺口，补齐后通过。
- 前端委派未获准启动：Harness workspace-write 请求被自动审批拒绝，要求用户明确批准项目源码发送至外部 DeepSeek 服务。本次未产生运行 ID、未切换其他后端或绕过委派；现有第一批前端保留，第二批前端尚未修改。
- 本批当时未提交、未推送、未重启生产服务；已在 2026-11-12 的整理提交入库（见文末「整理与推送」）。未做第二批浏览器验证、真实云端或素材质量验收。余下工作是新版历史消费、已有任务轮询、continue/rerun 对接与浏览器验收，需上述委派授权后继续。相关前端接入已于 2026-11-13 完成，见上文「云端候选生命周期前端接入」。

## 2026-11-11 配色接入与适配（「蜜蜡 · 沉褐」）

正式前端 `frontend/next-v2/` 接入评审定稿的配色，并完成配套适配：

- 令牌换成蜜蜡 · 沉褐，补 `--on-accent`、`--action-*`、`--paper-ink-3`；视图样式里的硬编码色号改为 `color-mix()` 派生，去掉彩色光晕与霓虹阴影，主操作改为「琥珀实心 + 墨字」。
- 评审覆盖层的结构规则折进 `base/shell/home/workbench/library/settings` 的对应选择器；错误态从强调色剥离（砖红 `#e2a07f`）。
- 删除 `frontend/next-v3/`、`/preview/` 路由、`PREVIEW_ROOT_NAME`/`PREVIEW_ENABLED`、`js/palette.js` 与 `.gitignore` 的预览条目；对比度工具迁到 `scripts/check_contrast.py`，评审记录迁到 [配色决定记录](palette-review.md)。
- 设置页警示面板里的金色标签在琥珀底上只有 4.07:1（Lighthouse 首轮 96），已把该面板内标签底改为暗底（6.7:1），复跑 100。
- 保留 `next-v2` 第一批的 JS 改动（会话身份令牌、深链只加载一次、修复接纳等），配色只动样式与令牌。

验证：`tests/` 69 passed；前端 3 个测试文件 45 passed；`python scripts/check_contrast.py` 22 组全部达标；隔离实例 `/` 200、`/preview/` 404、`/legacy/` 200；Chrome 五页 + 390 宽 + 导览浮层通过，Lighthouse 无障碍逐页 100；`review/` 截图重出。错误态（纹样库、设置页、工作台失败步骤与表单提示、轻提示 warn/done）已统一改用 `--error` / 铜绿，不再复用琥珀。

环境说明：本机 DSH 沙箱把 `0o700` 目录变成创建者自己也无法列目录的对象，pytest 的 `tmp_path` 因此不可用；`tests/` 这轮用了一次性 shim（`storage/validation/v3-integration/pytest_tmpfix.py`，未入库）把 `tmp_path` 指到工作区普通目录。`backend/tests/` 里大量用例直接用 `tempfile.TemporaryDirectory()`，在本沙箱下无法运行，本轮未执行，不能据此判定它们通过或失败。没有重启已在运行的 8765 服务，也没有做真实素材质量、真实云端与第二批前端验收。

## 2026-11-12 整理与推送

把此前积压的三批改动按逻辑拆成四个提交，推到远端 `main`（本机开发分支 `zgx`，与 `main` 同一提交）：

| 提交 | 范围 |
| --- | --- |
| `feat(backend): expose line-art capability and per-image history` | 健康能力字段、按图分页历史、对应测试与接口合同 |
| `feat(frontend): isolate workbench sessions and adopt model capability` | 新版前端第一批可靠性改动、模块测试与浏览器验证脚本 |
| `feat(frontend): apply the amber palette and retire the preview sandbox` | 蜜蜡 · 沉褐令牌与样式、错误语义迁移、`theme-color`、重出截图、对比度工具、`next-v3` 与 `/preview/` 清理 |
| `docs: record the palette decision and delivery status` | 配色决定记录、前端接入说明、实施记录与根 README |

整理时清理了本机预览目录、临时探针与忽略目录中的检查脚本；`storage/`（含素材、数据库、验证产物）与旧版草稿仍按原样不入库。推送前后重复执行了对比度核算（22 组）、前端 45 项与 `tests/` 69 项。没有重启生产服务；真实素材质量、真实云端调用与第二批前端仍待后续验收。

## 2026-11-12 前端文案精简（功能与价值导向）

按「不要过多强调本机/云端，从功能和价值上描述，少堆小字」的反馈，修改新版前端的可见文案与首屏信息密度，不改页面结构、接口和交互：

- 首屏改为「上传纹样，导出可编辑 SVG。」加两行功能说明；删除处理版本、云端配置、费用三栏状态条与图版上的浮动统计卡，并移除 `home.css` 中随之失效的 meta / float / vdot 样式。
- 工序区、费用区、收尾、纹样库、使用说明和设置页的标题、引导语改为描述功能与结果；工序 04「挑一层」改为「选候选层」、06「局部重跑」改为「局部修复」，`data.js`、首页与工作台三处同步。
- 文档：[新版设计说明](../frontend/next-v2/DESIGN.md) 补充文案原则并更新首页 5.4 段；本条记录。
- 旧前端 `/legacy/`、后端、接口合同、数据与既有任务记录均未改。

验证：`node --check` 6 个改动的 JS 文件通过；三个前端测试文件直接以 `node <file>` 运行，共 45 项通过（本机沙箱下 `node --test` 因 `spawn EPERM` 不可用，改为直接执行测试文件）；Chrome 1440 / 1280 / 501 宽核对首页、纹样库、使用说明、设置、工作台和工序导览，无横向溢出。未做真实素材质量与云端调用验收。

## 2026-11-13 工序样例图、首页进度高亮、工作台资产分组

前端（`frontend/next-v2/`）三条改动，接口、参数版本、后端与接口合同均未变：

- 七道工序配样例图：`assets/demo/lotus-*.svg` 四张同源衍生图 + `js/samples.js`，首页工序卡与导览浮层共用；首页高亮改为跟随真实进度
  （`store.lastStage` 记用户刚停下的工序，`format.js` 的 `stageForJob` 按任务与已发布产物算走到第几道）。
- 工作台左栏资产按工序分组：组头可折叠、组内按生成时间编号 `v1…vN`、当前资产描边 + 自动滚进视野；`groupAssets` 为纯函数并有测试。
- 蒙版笔迹改一条圆头描边路径（宽带 + 细中线），采样按笔刷半径抽稀；提交结构仍是 `{mode, radius, points[]}`。
- 另有两次布局尝试（三栏宽度按图版高度分配、参数栏三段式）**已按反馈回退**：三栏仍是 `264px | 1fr | 368px`，参数栏仍是「标题 + 控件 + 行内说明」。

文档：新版设计说明 5.1 / 5.4 与 README 的文件表、路由表、截图说明已同步；本条与 [前端接入说明](frontend-integration.md) 第 12 节为本次记录。

验证：`node --test` 三个前端测试文件 47 项通过；无头 Chrome 逐页核对首页、纹样库、设置、使用说明与工作台七道工序，
视口 1081–2560 及 1080 / 1024 / 900 / 820 / 390 均无控制台报错、无横向溢出；回退后三栏宽度与图版尺寸逐档与原版一致。

遗留：`frontend/next-v2/review/` 截图已过时（首页、导览、工作台两张）；真实素材质量、真实云端调用仍按既定验收流程单独进行。`assets/demo/` 里另有 13 张自集成提交起就存在、当前没有引用的样例（宝相/云纹/仙鹤/回纹/海水各两张、lotus-candidate-1/2、lotus-vector），归属与去留待作者确认，本批未删。

## 2026-11-13 云端提取后的完整线稿

反馈「云端提示词没设好、提取的线稿不完整」后核对：云端拆分提示词只决定候选层内容，`contour_line_art` 由选中层前景掩膜经 `cv2.findContours` 生成，只画外轮廓，改提示词不会补出内部线条。

- 候选合成后新增「生成完整线稿」入口：对 `composed_candidate` 再走 `recipe:"model_lineart"`，超过本地输入上限时由 `working_max_pixels` 生成显式工作副本并记录 `transform`；不新增云端调用、不改提示词版本。
- `contour_line_art` 中文名改为「外轮廓线稿」，处理页说明同步；界面不再把它当作完整线稿。
- 实测：云端 5.5 提取的 1182×887 纹样 → 1154×866 工作副本 → 本地 TGS 线稿 PNG（`0744181f`）+ SVG（`9f198df9`），内部螺旋与颜色边界完整。对比图 `storage/validation/takeover/lineart-20261113/cloud-lineart-compare.png`。
- 验证：`node --check` 两个改动模块通过；Chrome 在 8765 工作台选中「候选合成 v7」后点击「生成完整线稿」，任务成功并提示「模型一键线稿完成」，控制台无报错；`next-v2-integration` 25 项通过。
- 本次仍只有 3 次云端调用，未自动重发；改动随本次整理提交入库。

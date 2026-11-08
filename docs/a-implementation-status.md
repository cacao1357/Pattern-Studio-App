# A 实施与交接记录

基础交接日期为 2026-11-01。2026-11-08 工作台更新记录见下文。

## 完成范围

已完成当前可独立交付的 A 基础实现，并接通现有提取与矢量化链路。B/C 的新算法与真实素材最终质量验收仍按原分工推进。

| 责任 | 已落地行为 |
| --- | --- |
| 设置与设置界面 | 顶部“设置”入口；密钥保留/替换/清除；模型/官方端点、付费开关、价格确认、预算、单次预留和调用数；保存后新任务生效 |
| 设置安全 | 密钥不回显、不写浏览器持久化；新旧密钥用于防止备注、文件名、请求标识泄露；原子保存、失败保留原配置、修订冲突提示复核 |
| 公共云端接口 | `ImageProvider` 协议；沿用 Seedream 单次调用；模拟提供者可独立验证对接，不引入运行时依赖 |
| 工作流编排 | 预设标识/版本；提交时固定模型、端点、输入、分辨率、矢量参数、提示词版本和实际文本；调用记录保存实际预算闸门与预留依据 |
| 选层衔接 | 单个协调器接收 B 的选层结果；校验后可自动继续；当前没有已验证规则，默认停在人工确认 |
| 局部恢复 | 复用图层重新合成；复用 PNG 或蒙版修正后代重新矢量化；旧结果不覆盖，分支记录父任务；刷新后可恢复所属流程 |
| 费用与异常 | 关闭付费可阻止未开始的调用；云端超时/中断保留未知结果，不自动重试；本地失败保留已发布 PNG |

字段与响应以 [接口合同](a-interface-contract.md) 为准。

## 使用与生效

使用现有 Python 环境运行 `python -B scripts/serve_api.py`，在工作台顶部打开“设置”。更新代码后，已有服务需正常停止并重新启动以加载本次代码；此后在设置页保存配置无需重启服务。

配置优先级为项目 `.env`、进程环境变量、`storage/settings.json`，后者优先。设置页不改写 `.env`。私有文件被 Git 忽略，位于 `storage/api/` 备份范围之外；正常备份不携带其中的密钥。

保存只做本地验证，不验证密钥在供应商处是否有效，也不生成图片。预算与预留是本地闸门估算，实际费用仍需供应商账单核对。进行中的请求保持启动配置；排队任务模型和提示词沿用提交快照，但检查启动时的当前密钥、付费开关和预算。

## B/C 并行接入

- B 在 `backend/app/providers/prompts.py` 增加不可变提示词版本，实验明确指定版本；保留旧版本，未实测模板不替换默认。API 使用 `prompt` 字段，没有额外的 `system` 角色。
- B 在 `backend/app/services/workflow.py` 的 `select_candidate_layers` 返回 `layer_ids`、`policy_version`、简短 `reason`；空列表表示人工确认，不在这里增加云端调用。流程验证图层归属并记录自动/人工来源。
- B 的蒙版修正沿用现有接口，产生的 PNG 通过来源关系成为可选矢量化输入。
- C 保持 `backend/app/services/vector.py` 和 `VectorOptions` 契约；PNG 来源、SVG 结果、步骤失败及恢复已接通，可独立调试。
- 修改共享前端文件或参数合同前协调归属。本次沿用 B/C 负责的提取及矢量算法。

## 验证

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

GPU 推理使用已安装的 Stage D 权重和合成图。云端候选使用隔离归档夹具。真实素材保真、外部 SVG 编辑器验收和实际云端调用仍按协作计划验证。

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

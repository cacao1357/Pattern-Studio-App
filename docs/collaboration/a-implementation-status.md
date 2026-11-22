# A 实施与交接记录

当前整理、文件去向及验证见 [2026-11-22 整理记录](maintenance-2026-11-22.md)。

## 2026-11-22 一键处理与全流程复核

批次提交后在底部状态条显示「处理批次」，用户可继续操作工作台，点状态条查看进度、处理待确认图片或导出结果。已修复取消勾选后无法重选、切换批次时迟到的响应覆盖当前详情、按当前来源和原图组编号搜不到纹样的问题。设置与使用说明已区分本地推理、云端上传及计费。

隔离 Chrome 实测桌面 1440×900、1080×720 及窄屏 390×844。提交、收起和刷新后可继续操作，查看详情和导出 ZIP 通过。人为延迟第一批的真实详情响应后，第二批仍保持选中。人工裁切实测从批次进入工作台、保存裁切、返回确认同一版本，随后自动完成颜色提取和矢量化。本机证据在 `storage/validation/usability-20261122/`，包括遮挡对照 `before/` 与 `after/`、切换批次 `switching/`、人工裁切 `manual/` 及各模块的浏览器记录。

前端协作使用 DSH `harness / wb / deepseek-v4.1-flash`，运行 `8eb90153-709e-4ed2-9c8a-dc36da60845d`，会话 `session-979a5bc7-0743-4ad4-a4c0-68ac0e51f8b1`。Relay 在改动落盘后中断。Codex 经用户授权完成余下修复及独立验收。导出清单保留各版本生成时的来源；如需附加后续编辑的整组资料，应先确定清单契约。

提交前复核通过前端 173 项、后端定向测试 35 项及 8 个子测试。在仓库根目录使用项目 Python 环境可复跑以下检查。最后一条用临时素材库和 Chrome 验证批次提交、收起、刷新与 ZIP 导出。

```powershell
node --test --test-concurrency=2 frontend/tests/*.test.mjs
$env:PYTHONPATH = (Resolve-Path backend).Path
python -B -m pytest -q backend/tests/test_a_workflow.py backend/tests/test_batch_workbench.py backend/tests/test_pattern_library.py
node scripts/validate_v2_integration.mjs (Get-Command python).Source --batch-only
```

## 2026-11-22 工作台功能与模型实测

单图工作台已接通线稿、透明蒙版、画笔修正和矢量化。批次可从同一前景蒙版的人工修正版继续。重开同图版本后可以选用另一块已保存的裁切作为 LeftRefill 参考。缩放后的合成工作副本有独立坐标空间，SVG 继承实际矢量输入的空间。接口和模型权重沿用现有版本。

在独立 Chrome 与临时素材库中，实测指针补线、选层恢复、本地重合成、SVG 图形编辑、刷新重开及叠加。两张有标注的电子留出样本在实际 CUDA 推理下的像素级 F1 分别为 0.967 和 0.974。褪色金纹仅提取出 187 个线像素。另一张有标注的合成淡线图经 1.5 倍和 2 倍对比度处理，F1 均下降，保留现有默认参数。对禽纹照片使用独立参考图块修复人为遮挡的 64×64 区域，回填 1080×810 整图后区外 RGBA 变化为 0，局部装饰细节仍有偏差。本轮云端分支使用模拟或已归档的图层。

本机证据目录为 `storage/validation/workflow-20261122-1795329928275/`。线稿指标与效果图在 `lineart/`，实拍素材的遮挡实验在 `relic-repair/`。DSH 前端后端路由为 `harness / wb / deepseek-v4.1-flash`。蒙版衔接会话 `session-e296d96d-b630-4c0c-8ec7-a4f841b53a99` 的首次运行 `3f555678-6be6-47e4-bc73-5ac0d2417390` 中断，同会话续跑 `5137ea0b-da5d-4afc-b5a2-596ebbce636c` 完成。同图恢复会话 `session-63cf544f-e094-43a8-9f10-fd4f0400e73d` 的运行 `fa26b03d-9b78-4835-8a9d-751229fac55c` 完成。Codex 负责后端、集成修正、像素检查和浏览器验收。

## 2026-11-16 本地修复图块回填整图

用户反馈裁切修复只得到局部图，本次补齐 A 负责的接受结果与整图集成，不修改成员模型或生成算法。新增 `services/repair_restore.py`，按原尺寸裁切链累计坐标，在接受本地候选时仅回填编辑蒙版内像素，保留完整画布的其余 RGBA；接受资产使用完整尺寸与坐标系，记录来源与局部框，现有前端采纳后自动切到整图。支持连续裁切，来源含旋转/缩放或无效坐标时在提交前明确拒绝，不消耗推理；外部裁切且未上传完整原图的输入无法回填。候选预览保持局部图，原图与旧结果不覆盖。

验证：`PYTHONPATH=backend` 下运行 `python -B -m pytest backend/tests/test_local_repair.py backend/tests/test_image_history.py -q`，35 项通过；合入前在隔离导出目录连同 SVG 图形与矢量模块共 61 项通过，前端全部模块 167 项通过。新增覆盖候选/合成两种接受、连续裁切、透明 RGBA/蒙版孔洞/羽化、重复接受幂等、按图历史、整图 ZIP 导出及非法来源提前拒绝。Codex 原生辅助 Agent 独立只读审查发现的无裁切缩小工作副本边界，以及完整尺寸透明/合成/预处理/工作副本的输入兼容性，均已修复并回归。真实受限 GPU 验证 `python -B scripts/validate_local_repair.py --output storage/validation/local-repair-backfill-20261116` 成功，约 14.48 秒，512×512 图块接受后生成 768×640 整图，回填逐像素符合预期、区外变化 0、云调用 0；产物与报告在上述忽略目录。合成样本用于流程验证，不代表真实文物素材修复质量通过。提交、推送及合入状态以 Git / PR 记录为准。

## 2026-11-16 中期报告对应的系统改进

本轮用户确认兼顾效果与演示完整性，仅改系统，沿用现有模型及矢量生成算法。SVG 视觉独立图形选择、移动、删除、撤销重做、保存新版本、按图历史重开及同坐标透明叠加已实现，契约见 [SVG 编辑与核验](../contracts/svg-editing-contract.md)。原图、既有结果及未跟踪中期报告保留，未提交、推送或合并。

后端新增组件归属和受控编辑服务、GET svg-elements 与 edit-svg 本地任务，复用原有存储、来源链、幂等、历史和 ZIP。曲线仅采样用于归属分析，保存保留原命令与精度；同源同变换的组件合并绘制以保留抗锯齿结果。人工几何编辑明确重置 geometry_verified=false，记录 manual_geometry_edit=true。过于复杂或无法安全拆分的重叠 evenodd 子路径明确拒绝，不改原文件。新增 svg.path 7.0 与 shapely 2.1.2；现有依赖未替换，pip check 通过。

前端由 Harness Relay / DSH `wb/deepseek-v4.1-flash` 实现，runId `4b81c080-21c9-4e9f-89c7-160a6e1371dd`，sessionId `session-de9cf941-16c3-4020-b0ff-9cc6aa9a17ca`，已读取终态结果并独立审查。Codex 负责后端、接口、精度、绘制一致性和最终浏览器验收；原生辅助 Agent 完成后端只读审查、依赖诊断及隔离浏览器入口。独立审查发现的几何已验证标记继承问题已修复。

实际验证：

- 新增后端 SVG 编辑回归 9 项通过；既有矢量、按图历史、本地修复回归 40 项通过。前端完整模块测试 167 项通过；最终精度与提示调整后，编辑、叠加、引导和集成 88 项定向复测通过。
- `node scripts/validate_system_editing.mjs D:/CondaEnvs/pattern-studio/python.exe`：独立临时 API/Chrome 验证复合路径两图形一孔洞、真实指针选择/拖动、孔洞空白不误选、删除、撤销重做、不可变保存、来源继承、刷新重开，以及 fit/100%/200% 叠加画布一致。11 项检查通过，无浏览器错误、外网流量、修复任务或云端调用。
- 三张交付电子纹样 GT 经现有黑白矢量化后，组件数分别 558、455、45；实际前端绘制层重组与原 SVG 的 Chrome 栅格结果逐像素一致。这只验证编辑拆分/绘制未改变既有结果，不代表模型在文物照片上的准确率。报告与截图在被忽略的 `storage/validation/system-improvements-20261116/`。
- Python 复现：设置 `PYTHONPATH=backend` 后运行 `python -B -m pytest backend/tests/test_svg_elements.py tests/test_vector_c.py backend/tests/test_image_history.py backend/tests/test_local_repair.py -q`；前端使用 `node --test frontend/tests/*.test.mjs`。本轮没有以训练或付费调用替代系统测试。

本地修复环境与验证（2026-11-16 续）：成员 Release 的七个 SD2 基础模型文件已下载至被忽略的 `model/leftrefill/base/` 并逐文件校验通过，许可与来源说明保留，下载压缩包已清理。用户明确同意补齐现有 Conda `D:/CondaEnvs/pattern-studio` 环境并接受 huggingface-hub 2.4.0→0.36.2；已安装 diffusers 0.35.2、transformers 4.49.0、accelerate 1.4.0 及解析出的依赖。PyTorch 2.9.1+cu128、NumPy 2.4.6、Pillow 13.0.0 保持不变，修复类导入与 pip check 通过。

首次真实 worker 在加载 UNet 时触及 6144 MiB 内存保护；受限诊断将提交额度设为 10240 MiB 后约 11 秒完成同一模型推理，进程提交峰值约 8.6 GiB、驻留峰值约 3.7 GiB，PyTorch 显存分配峰值约 3061 MiB、保留峰值 3734 MiB。只将 LEFTREFILL_MEMORY_MIB 调为 10240，其他任务额度、串行运行、180 秒超时和模型算法保持不变；没有关闭资源保护或修改系统页文件。

新增显式 GPU 验证入口 `python -B scripts/validate_local_repair.py --output storage/validation/local-repair-NEW`（新输出目录），使用临时 API 存储及合成重复圆纹，运行真实受限子进程；验证候选/合成结果蒙版外逐像素不变、蒙版内存在变化、AI/未核验标记及参考图来源、waiting_user→accepted、云调用数为零。最终证据在忽略目录 `storage/validation/local-repair-20261116-final/`；最初超限和 10 GiB 诊断记录另存于 `storage/validation/local-repair-20261116/`。安装后相关回归 49 项通过，额度调整后本地修复 19 项通过。真实文物素材质量尚未验收，合成样本推理成功不代表质量达标。未提交、推送、修改模型或发起付费调用。

范围收尾核对：已确认的 SVG 图形编辑、保存重开/来源追溯、同坐标叠加、修复条件引导和现有模型本地接入均有实现与验证证据。本次核对仅修正一处引导与实际请求不符的问题：前端当前提交修复框，并不自动传入发现的损伤蒙版，提示改为如实说明；不新增蒙版选择功能。引导及既有集成定向测试 64 项通过，差异格式检查通过。尚未完成的验收是报告所述真实典型文物案例的保真、孔洞/细线及修复合理性的人工核对；不据此自动启动模型优化、数据集整理或新增格式。多格式范围保持现有 PNG/SVG，未新增 DXF/PDF。Git 提交、推送及合并未获本次授权，不计作遗漏开发项。

## 2026-11-14 批量工作台改进

已本地整合批量导入、按原图分组、多分类、批量导出浮窗、可保存预设与持久批次。用户最终选择仅提高本地线稿和已验证 Otsu 上限，不增加 SVG 试验档；原图与工作副本来源保留。接口、测试和 DSH 追溯见[前端接入第 15 节](../guides/frontend-integration.md#15-2026-11-14-批量纹样导出与处理浮窗)与[上限实测](../guides/local-processing-limits.md)。本批已拆成后端 `2f9ab95`、前端 `f0a4dbb` 和文档提交，推送到 `origin/zgx`，未合并 `main`；未发起付费调用。

复跑命令（仓库根目录，`D:\CondaEnvs\pattern-studio\python.exe` 与 Node 26）：

```powershell
$env:PYTHONPATH = "backend"
python -B -m pytest -q -p no:cacheprovider backend/tests tests
node --test --test-isolation=none frontend/tests/<file>.test.mjs   # 逐个文件执行
node scripts/validate_v2_integration.mjs D:/CondaEnvs/pattern-studio/python.exe --batch-only
```

- 后端 `backend/tests` 78 项及 2 个子测试、`tests` 85 项通过；前端 7 个测试文件共 128 项通过。`--test-isolation=none` 下同进程连续跑多个文件会互相干扰，需逐个执行；`--batch-only` 浏览器验收结果见前端接入第 15 节，非本次复跑。
- DSH 沙箱会把 `0o700` 临时目录变成自身也无法访问的对象，`pytest` 的 `tmp_path` 因此报 `PermissionError`。本机复跑把 `TMP`/`TEMP` 指到普通目录，并用一次性 shim 放宽 `tempfile.mkdtemp` 与 `os.mkdir` 的权限（沙箱内另加 `-p tmpfix`，shim 目录加入 `PYTHONPATH`）；shim 留在被忽略的 `storage/validation/`，不入库，也不作为正式测试设施。

## 2026-11-13 远程合入记录

- 模型分流、修复前置、Windows DPAPI 密钥保存及此前 Seedream 5.5 / TGS 模型交付，已通过 [PR #4](https://github.com/cacao1357/Pattern-Studio-App/pull/4) 合入远程 `main`，合并提交 `e28d1644fdcf762d4fe8f8c1f6eb078fcb3130b2`。
- 提交前由非作者独立审查关键差异；与原远程开发分支 `3b58947` 对照，保留已有有效行为。使用账号在仓库规则中已有的管理员合并权限，没有修改规则。
- 本地继续沿用 `zgx`，已快进同步合并提交；密钥、私有素材、验证产物和交付包不在提交中。后续资产布局调整作为独立提交交付，布局、断点及验证见[前端接入说明第 14 节](../guides/frontend-integration.md#14-2026-11-13-独立资产列与工序高度)。

## 当前补充：2026-11-13 模型选择、修复前置与安全配置

- 用户选择新增真正的云端线稿和 Windows 当前用户加密存储，并授权合理真实调用测试。新增 `POST /jobs/cloud-lineart`，复用现有供应商、任务、资产及费用同意；提示词 `lineart-seedream-v1`，不自动重试或矢量化。
- 新版改为八步，修复前置且可跳过，提取与 SVG 分开；云端输入支持裁切和已接受修复，刷新恢复修复候选及旧框。另修复同图换工序重复加载导致会话/选层丢失、晚到恢复覆盖勾选等问题。
- 服务端密钥用 DPAPI 保存，可保持密钥不变迁移旧配置；本机实际设置已加密，重启后读取一致（修订 19），当前服务健康正常。未变更模型权重；保留开始时已有修改。
- 前端定向 70 项、后端相关 47 项与 2 子测试通过；Chrome 完整本地流程及归档候选闭环、1440/390 宽八步页面检查通过。真实祥云样例执行两次云端调用（修复 + 线稿）；最终内容检查补齐云端白底 → 透明线稿的适配，归档结果本地重矢量化为 69 条路径，无新增云端调用。未作固定数据集全面质量结论。
- 具体接口、复现入口、DSH 运行追溯与限制见 [接口合同](../contracts/a-interface-contract.md) 和 [前端接入说明第 13 节](../guides/frontend-integration.md#13-2026-11-13-模型分流修复前置与密钥持久化)。真实产物位于被忽略的 `storage/validation/cloud-lineart-20261113/`。本批不进行模型训练；提交及远程合入状态以 Git / PR 记录为准。

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

字段与响应以 [接口合同](../contracts/a-interface-contract.md) 为准。

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
- 该模型交付阶段用户暂缓真实云端验收，当时尚无云端密钥配置；后续两次真实调用见顶部当前补充。本地推理验证不等于真实照片保真或云端模型质量验收。

### 2026-11-13 云端候选生命周期前端接入

- 新版工作台已接入按图 `flows` 历史恢复、首次 `continue` 与后续 `rerun` 本地重合成；关闭付费或缺少密钥时归档候选仍可读、可选，恢复和轮询只读已有任务，不重发云端请求。
- 验证：后端 `tests/` 73 项、`backend/tests/` 23 项及 2 个子测试通过（本机沙箱对 `0o700` 临时目录不可列，使用一次性 shim，未改仓库测试）；前端 25 + 8 + 22 项通过。隔离夹具 live HTTP 完成 health → 上传 → 新模型 CUDA 线稿 + SVG → 平铺 → ZIP 导出 → 历史/设置读取；Chrome 完成归档层 → `continue` → 刷新恢复 → `rerun` 分支，云端调用计数保持 1、页面异常 0。`scripts/validate_v2_integration.mjs` 因本机沙箱 `spawn EPERM` 未整脚本执行，未计为自动化通过。
- 未接入 `assets`/`jobs` 历史页与修复候选的刷新恢复。接口与细节见 [前端接入说明第 10 节](../guides/frontend-integration.md)。

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

工作台默认使用 GPU 优先的一键模型路线，并按标签页记录撤销、重做和清空。处理结果进入现有资产与任务历史。纹样库可加载透明图的关联蒙版，平铺复用处理后的 PNG，并按结果保存接缝观察。操作说明见 [README](../../README.md#工作台操作)，接口见 [接口合同](../contracts/a-interface-contract.md#本地一键处理)。

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

新版前端（`frontend/next-v2/`）已接入本机服务并纳入版本库：`backend/app/api/frontend.py` 把新界面挂在 `/`，旧前端原文件未改、通过 `/legacy/` 只读对照；接口映射、CSP 与回退方式见 [前端接入说明](../guides/frontend-integration.md)。接入提交为 `016197b`，已于 2026-11-11 合并到 `main`。

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

评审通过后按「接入新版前端，做好适配」并入 `frontend/next-v2/`，`/` 即为新配色；隔离预览目录与 `/preview/` 脚手架已删除，评审记录迁到 [配色决定记录](../guides/palette-review.md)，接入动作见 [前端接入说明](../guides/frontend-integration.md) 第 8 节。

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

本批完成模型前置能力接口、默认模型一键与分步入口、上传/加载/任务会话隔离、接受修复的新资产衔接、失败及取消保留产物说明。独立浏览器验收发现并修复深链在页内重绘时重置当前结果的问题。接口与复现命令见 [前端接入说明第 9 节](../guides/frontend-integration.md#9-2026-11-11-第一批可靠性对接)。

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
- 删除 `frontend/next-v3/`、`/preview/` 路由、`PREVIEW_ROOT_NAME`/`PREVIEW_ENABLED`、`js/palette.js` 与 `.gitignore` 的预览条目；对比度工具迁到 `scripts/check_contrast.py`，评审记录迁到 [配色决定记录](../guides/palette-review.md)。
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
- 文档：[新版设计说明](../../frontend/next-v2/DESIGN.md) 补充文案原则并更新首页 5.4 段；本条记录。
- 旧前端 `/legacy/`、后端、接口合同、数据与既有任务记录均未改。

验证：`node --check` 6 个改动的 JS 文件通过；三个前端测试文件直接以 `node <file>` 运行，共 45 项通过（本机沙箱下 `node --test` 因 `spawn EPERM` 不可用，改为直接执行测试文件）；Chrome 1440 / 1280 / 501 宽核对首页、纹样库、使用说明、设置、工作台和工序导览，无横向溢出。未做真实素材质量与云端调用验收。

## 2026-11-13 工序样例图、首页进度高亮、工作台资产分组

前端（`frontend/next-v2/`）三条改动，接口、参数版本、后端与接口合同均未变：

- 七道工序配样例图：`assets/demo/lotus-*.svg` 四张同源衍生图 + `js/samples.js`，首页工序卡与导览浮层共用；首页高亮改为跟随真实进度
  （`store.lastStage` 记用户刚停下的工序，`format.js` 的 `stageForJob` 按任务与已发布产物算走到第几道）。
- 工作台左栏资产按工序分组：组头可折叠、组内按生成时间编号 `v1…vN`、当前资产描边 + 自动滚进视野；`groupAssets` 为纯函数并有测试。
- 蒙版笔迹改一条圆头描边路径（宽带 + 细中线），采样按笔刷半径抽稀；提交结构仍是 `{mode, radius, points[]}`。
- 另有两次布局尝试（三栏宽度按图版高度分配、参数栏三段式）**已按反馈回退**：三栏仍是 `264px | 1fr | 368px`，参数栏仍是「标题 + 控件 + 行内说明」。

文档：新版设计说明 5.1 / 5.4 与 README 的文件表、路由表、截图说明已同步；本条与 [前端接入说明](../guides/frontend-integration.md) 第 12 节为本次记录。

验证：`node --test` 三个前端测试文件 47 项通过；无头 Chrome 逐页核对首页、纹样库、设置、使用说明与工作台七道工序，
视口 1081–2560 及 1080 / 1024 / 900 / 820 / 390 均无控制台报错、无横向溢出；回退后三栏宽度与图版尺寸逐档与原版一致。

遗留：`frontend/next-v2/review/` 截图已过时（首页、导览、工作台两张）；真实素材质量、真实云端调用仍按既定验收流程单独进行。`assets/demo/` 里另有 13 张自集成提交起就存在、当前没有引用的样例（宝相/云纹/仙鹤/回纹/海水各两张、lotus-candidate-1/2、lotus-vector），归属与去留待作者确认，本批未删。

## 2026-11-13 云端提取后的完整线稿

反馈「云端提示词没设好、提取的线稿不完整」后核对：云端拆分提示词只决定候选层内容，`contour_line_art` 由选中层前景掩膜经 `cv2.findContours` 生成，只画外轮廓，改提示词不会补出内部线条。

- 候选合成后新增「生成完整线稿」入口：对 `composed_candidate` 再走 `recipe:"model_lineart"`，超过本地输入上限时由 `working_max_pixels` 生成显式工作副本并记录 `transform`；不新增云端调用、不改提示词版本。
- `contour_line_art` 中文名改为「外轮廓线稿」，处理页说明同步；界面不再把它当作完整线稿。
- 实测：云端 5.5 提取的 1182×887 纹样 → 1154×866 工作副本 → 本地 TGS 线稿 PNG（`0744181f`）+ SVG（`9f198df9`），内部螺旋与颜色边界完整。对比图 `storage/validation/takeover/lineart-20261113/cloud-lineart-compare.png`。
- 验证：`node --check` 两个改动模块通过；Chrome 在 8765 工作台选中「候选合成 v7」后点击「生成完整线稿」，任务成功并提示「模型一键线稿完成」，控制台无报错；`next-v2-integration` 25 项通过。

## 2026-11-14 成员分支整合与本地修复适配

- 在 `zgx` 上先合入 `origin/hmy`（`e8807ca`），再合入 C 的 `32d82ec`，合并点 `27a8d55`，保留全部历史、无 Git 冲突。下面为同批适配记录，最终提交与合入状态以 Git 历史为准。
- A 负责后端适配、资源边界、集成审查和验收；未重训或替换 C 的修复算法。LeftRefill 复用现有 repair 任务、不可变资产、候选确认及历史，没有另建存储体系。
- 云端仍为兼容默认；新增本地路线明确要求 512×512 目标和已保存参考图。后端校验类型、尺寸及损伤坐标，保留蒙版外 RGBA 像素，记录参考变换、种子和模型版本，结果必须人工接受。本地取消与重试不进入云端逻辑，旧云端全图候选的确认要求保留。
- 模型发现仅检查文件和依赖，不加载权重或初始化 CUDA；完整性校验和 GPU 推理留在单任务受限 worker，6 GiB 主机内存、至少 180 秒超时、顺序 CFG 降低显存峰值。不自动下载模型、安装依赖或回退云端。
- 前端由 Harness Relay / DSH `wb/deepseek-v4.1-flash` 完成，runId `ff0d5ea7-f748-4ac0-a7cd-6d8ddbc4f79a`，sessionId `session-6f6b5e99-4416-4b5a-b251-8c8fe5f269db`。Codex 独立审查，统一了前后端输入白名单及本地候选接受语义。
- 修复任务中心轮询丢分页、筛选后残留详情、响应正文读取缺少超时保护、清空后同链接不能重开四项问题；工作台只增加本地修复所需入口和说明。

验证与复现：

- `node --test frontend/tests/*.test.mjs`：94 passed（本机可正常使用隔离模式；DSH 沙箱使用 `--test-isolation=none`）。
- 现有 `D:/CondaEnvs/pattern-studio/python.exe`、`PYTHONPATH=backend`：`backend/tests/test_local_repair.py`、`backend/tests/test_cloud_lineart.py`、`backend/tests/test_a_workflow.py`、`backend/tests/test_image_history.py`、`tests/test_lineart_capabilities.py` 的主回归 50 passed、2 subtests passed；随后新增两种候选接受/导出及旧云端确认保护后，相关 7 项与新增 1 项分别通过。模型原交付检查也已通过。
- 本地修复集成以替代生成验证区域保护、显式接受、SVG 与 ZIP、来源和历史；另用真实受限子进程验证缺少基础模型时本地失败，未创建云端调用。
- `node scripts/validate_v2_integration.mjs D:/CondaEnvs/pattern-studio/python.exe`：真实 CUDA 线稿、独立矢量化、切图隔离、候选继续与重合成，以及修复入口缺失状态、清空重开通过。追加任务中心检查后以 `--archive-only` 定向复测通过。报告在 `storage/validation/v2-reliability/browser-checks.json`，后一次运行会覆盖同路径前一次报告。
- 旧版 `scripts/validate_a_browser.mjs` 使用现有 Chrome（`PATTERN_STUDIO_TEST_EDGE` 指定）全部通过。原先历史加载超时是 reload 后误读旧文档健康状态，现已等待新文档完成；Edge 的本机启动限制未改系统配置解决。

剩余限制：本机没有匹配的 SD2 基础模型，且服务环境缺少 diffusers、transformers、accelerate；本轮未安装依赖或修改运行环境。`pyproject.toml` 提供不替换主项目 NumPy/Pillow 的 `[leftrefill]` 可选依赖，基础模型路径及使用方式见 README。真实 LeftRefill GPU 修复、该组合的运行兼容性与真实素材质量仍待基础模型到位后验收，模拟生成不得当作质量成功。本轮只使用隔离临时实例，未启动正式 8765 服务、未触发真实付费调用。
- 本次仍只有 3 次云端调用，未自动重发；改动随本次整理提交入库。

## 2026-11-22 工作台入口与说明精简

- 空工作台保留「上传纹样」「从库选图」「批量导入」三个入口。修复面板在尺寸不符、缺少参考或操作失败时给出相应提示。同步精简新版导航页面和旧版操作说明。
- 前端 173 项测试通过。隔离浏览器在 1440 和 390 像素宽度下实际完成库中选图、单张上传和两张批量导入。新版页面、八个工序、归档恢复和旧版工作流验证通过。本轮云端生成调用为 0。
- 前端委派 DSH（harness），run `603c4dbb-3326-4413-880b-af4d91c7a9a5`，session `session-f9171999-9bfd-442a-8c18-869d014827c6`。Codex 集成并独立验证。浏览器记录位于本机 `storage/validation/copy-entry-20261122/`。

## 2026-11-22 表单对齐与自动选择来源

- 修正裁切和修复面板的坐标字段间距。Chrome 在 1440 和 390 像素宽度下原可复现 14 像素高差，修复后两处均为 0。新版六个主页面和八个工序在 1440、1080、390 像素下通过布局回归。另检查旧版四个页面在 360 至 1440 像素间的五个宽度，未发现页面横向溢出。
- 本地修复优先采用同图的规范输入。规范输入超过参考图像素上限且仅有一个合格裁切时，直接使用该裁切。已验证同图重载保留手动选择，切换纹样使用新图来源。浏览器截获并核对实际提交参数，本轮没有运行修复模型推理。
- 平铺仅有一个单元时直接显示来源。实际生成 2×2 和 3×3 预览，切换单元、规格和历史版本后核对了显示结果与接缝保存目标。同单元同规格的旧版本及移出单元后的预览另有回归测试。
- 前端 174 项测试通过。浏览器复现记录和截图位于本机 `storage/validation/layout-sources-20261122/`。DSH（harness）run `67a04a22-58cf-4510-b93e-2c3d4d7e5445`，session `session-83613b1e-06c5-4d36-93b1-29999351c65b`。Codex 完成边界修复与独立验收。

# Pattern Studio

> 项目处于多人协作开发阶段。已验证本地工作流和 GPU 推理，真实素材的保真度和可编辑性仍按固定样本验收。

本地运行的图案提取与矢量化工作台。包含透明背景提取、全局/局部阈值、GrabCut、蒙版画笔、图像增强、旋转纠偏、轮廓图、SVG 矢量化与调色、预览/应用/放弃、撤销重做、取消、本地历史和导出。

## 安装与启动

基础工作台需要 **Python 3.11（64 位）**和现代浏览器。Windows 为当前验证平台。可以复用现有 Python 环境，运行工作台无需 Node.js。默认一键路线使用本地模型，依赖见[本地线稿模型](#本地线稿模型)。

克隆仓库后，在项目根目录创建虚拟环境：

    python -m venv .venv

Windows PowerShell：

    .\.venv\Scripts\python.exe -m pip install -e .
    .\.venv\Scripts\python.exe -B scripts/serve_api.py

macOS / Linux（未实机验证）：

    .venv/bin/python -m pip install -e .
    .venv/bin/python -B scripts/serve_api.py

浏览器打开 **http://127.0.0.1:8765**。关闭时在启动终端按 Ctrl+C。保持仓库目录结构完整；此程序通过源码目录读取前端资源，不支持只复制 Python 安装包运行。

当前页面是接入本机服务的新版工作台（`frontend/next-v2/`），配色为「蜜蜡 · 沉褐」（令牌在 `frontend/next-v2/css/tokens.css`，改动后可用 `python scripts/check_contrast.py` 复核对比度）。旧的浅色前端文件仍在 `frontend/` 根目录保留，可通过 **http://127.0.0.1:8765/legacy/** 只读打开对照；接入与回退说明见 [docs/frontend-integration.md](docs/frontend-integration.md)。

本地处理无需配置密钥。更新源码后，请在原启动终端按 Ctrl+C 停止服务，用同一个 Python 环境重新启动，再刷新浏览器。

## 工作台操作

1. 按「来源 → 裁切 → 修复 → 候选 → 提取 → 蒙版 → 矢量 → 平铺」操作。裁切、修复和云端候选均可按素材实际情况跳过；缺损纹样先修复并接受结果，再提取线稿。
2. 「提取」可选择本地模型、云端模型、OpenCV 线稿或颜色提取，只生成 PNG。云端线稿使用当前输入，需明确同意上传和付费调用，不自动重试。
3. 「蒙版」可修正透明 PNG，随后在「矢量」单独生成 SVG。切换工序保留当前输入、选层与会话；修改参数可复用已有 PNG，无需再次调用云端。
4. 已保存产物和任务记录可在纹样库或历史中找回；未接受的修复候选不会自动进入后续处理。旧版前端保留原有一键路线、应用/放弃和会话撤销行为。
5. 在「平铺」选择有效 PNG 生成 2×2 或 3×3 排列，检查接缝后导出。接缝观察写入相应结果和后续 ZIP 清单。

### 批量纹样与流程预设

批量导入的各张原图独立登记，处理结果按原图分组，跨图切换保留各自历史。工作台「纹样」列只显示用户自己选入的组：第一次使用点「添加纹样」从纹样库勾选，之后上传或批量导入成功的原图会自动加入；加入与移出只改工作台选择，不删除纹样库记录。纹样库支持处理类型筛选和自建多分类，同一组纹样可加入多个题材分类；移除分类不删除图片。纹样库组头和工作台「纹样」列都提供「删除整组」：确认后永久删除该原图、全部处理版本、文件与这张纹样的任务记录；两处也都支持多选、全选与「删除选中」，逐个执行并汇总失败原因。运行中的任务或批次会阻止对应组的删除。

流程预设复用已有本地模型、云端线稿和颜色提取，提交批次时保存参数快照。裁切、修复、候选选层和蒙版确认按图暂停，其余图片继续；进度保存在本机服务，关闭浮窗不会停止后台处理。大图可在预设中显式设置工作副本像素上限，未设置时不会自动缩放。云端预设需在运行前确认上传和费用，失败或未知结果不会自动重发。

批量导出选择已有原始文件、PNG 和 SVG，按原图目录打包 ZIP；支持逐项、整组和同处理类型选择，总文件上限为 128 MiB。接口及限制见[批量工作台契约](docs/batch-workbench-contract.md)。

本地模型线稿已实测开放到 2500 万像素，Otsu 提取开放到 400 万像素，SVG 保持现有限制；原图不自动缩小。测试数据与分环节边界见[本地处理上限](docs/local-processing-limits.md)。

## 数据体检、去重与来源登记（P0）

上传时会额外完成四件事，全部只作提示，不改变坐标、尺寸或本地处理能力：

- **质量分级**：在 512 px 参考画布上测清晰度/对比度，给出 A/B/C 提示；C 级仍可继续处理。
- **近似去重**：aHash 粗筛 + 32×32 NCC 复核；命中时提示可切换到已有版本，不自动合并。
- **来源登记**：可填来源类型/名称/链接、授权、采集日期、批次，写入资产元数据与导出清单。
- **算法版本**：每个资产记录 `algorithm_version`，导出清单升级为 `local-s1-v2`。

未登记授权或标记“未确认”的版本，在打包 ZIP 前需要一次显式确认；本地预览与处理不受影响。
旧数据库可直接打开；旧图片可用 `scripts/backfill_metrics.py` 补算指标。

契约与字段说明见 [docs/data-contract-p0.md](docs/data-contract-p0.md)。测试：

    .\.venv\Scripts\python.exe -m pytest -q

## 线稿、轮廓与数据集清单（P1）

- **线稿 v0.2**：处理页新增“线稿”组，生成透明背景黑色墨线 PNG；全局强轮廓与局部分块路径取并集，结果可继续矢量化。
- **轮廓单线 SVG**：矢量化模式新增“轮廓单线”，按 alpha 掩膜保留孔洞并简化为 even-odd 闭合路径；适合蒙版/线稿。
- **数据集清单与审计**：顶部“数据集”按钮查看 A/B/C/U、划分、授权、重复 content_id 与批次汇总，并下载 `manifest.csv`。

接口、字段、限制与验证命令见 [docs/p1-lineart-dataset.md](docs/p1-lineart-dataset.md)。

### 本地线稿模型

当前部署模型为 2026-11-13 交付的 TGS-Net（`gts2-tex-seed42`、HRNet-W18 + U-Net++）。权重通过 Git LFS 分发，项目根目录的 `model/` 保存 `model.pt` 和配套的 `inference.json`。有仓库访问权限的成员切换到包含模型的分支后，在项目根目录运行以下命令。

```powershell
git lfs version
git lfs pull --include="model/model.pt" --exclude=""
```

如果 `git lfs version` 提示命令不存在，请先安装 [Git LFS](https://docs.github.com/en/repositories/working-with-files/managing-large-files/installing-git-large-file-storage)，再运行 `git lfs install --local` 和上面的拉取命令。只下载了源码压缩包或恢复了离线备份时，可以从已拉取权重的工作副本复制这两个文件到 `model/`。

模型依赖安装在运行工作台的同一个 Python 3.11 环境。下面以项目虚拟环境的 CPU 版为例。如果该环境已有匹配硬件的 GPU 版 PyTorch 和 torchvision，只需补装缺失的分割模型库。

```powershell
.\.venv\Scripts\python.exe -m pip install torch==2.9.1 torchvision==0.24.1 --index-url https://download.pytorch.org/whl/cpu
.\.venv\Scripts\python.exe -m pip install segmentation-models-pytorch==0.5.0 timm==1.0.31
```

重启工作台后，新版「提取」可选择本地模型生成线稿 PNG，再进入「矢量」；旧版保留本地模型一键路线。CUDA 可用时优先用 GPU 推理；CUDA 不可用时使用 CPU。显存分配失败会明确报错，释放竞争任务后再重试，不自动切换设备。产物记录实际推理设备。

模型按原始像素使用 512×512 窗口、256 步长推理，重叠区域用渐变权重融合概率；不足 512 的边用边缘复制填充，输出裁回输入尺寸，不拉伸图像。以 0.5 阈值生成透明底黑线 PNG，再可继续矢量化。部署固定 `gate_alpha=0`，覆盖 `inference.json` 中的训练导出值 1.0；推理结构内只执行线稿分支，完整权重仍严格校验和加载。含模型的任务串行运行，worker 内存上限为 6 GiB，默认超时 90 秒。淡线、低对比照片及实心粗条的轮廓语义仍受模型本身限制。

### LeftRefill 参考图引导修复

`model/leftrefill/` 提供纹样微调的 1108 步提示向量、命令行推理实现、SHA-256 校验清单和固定 63 张验证图的指标。完整基础 SD2-inpainting 权重通过 [仓库 Release](https://github.com/cacao1357/Pattern-Studio-App/releases/tag/leftrefill-textile-step1108) 的两个 ZIP 提供，解压后从离线目录加载。安装、输入约定和权重选择依据见 [LeftRefill 使用说明](model/leftrefill/README.md)。

工作台「局部修复」已提供本地 LeftRefill 路线，复用候选确认、历史及后续处理。目标须为显式 512×512 裁切，并选择已保存参考图；缺少模型时入口显示不可用，不会自动改用云端。

应用服务使用现有 Python 3.11 环境和 CUDA PyTorch。需要时在该服务环境安装 `pip install -e ".[leftrefill]"` 补齐可选依赖；不要把独立 CLI 的 `requirements.txt` 安装到主环境，以免替换项目的 NumPy/Pillow。GPU 版 PyTorch 仍按本机硬件单独准备，不由此选项安装。此可选组合尚未完成 LeftRefill 真实推理验收。

另行取得成员交付的匹配基础模型后，放在被忽略的 `model/leftrefill/base/`，或在启动服务的 PowerShell 设置 `$env:PATTERN_STUDIO_LEFTREFILL_BASE_MODEL='D:/models/leftrefill-sd2'` 后启动服务。基础权重不会自动下载；健康检查只确认前置条件，真实任务才校验完整性和 CUDA。当前资源限制为单任务、6 GiB 主机内存及至少 180 秒超时，显存不足会明确失败，不回退 CPU 或云端。

## 数据与限制

- 上传及结果保存于自动创建的 storage/api/，包含 SQLite 历史；保留该目录即可保留本地数据。
- 常规处理工作图上限为 100 万像素；大图先创建工作副本。批量预设里的本地模型线稿放宽到 2500 万像素、Otsu 提取放宽到 400 万像素，其余环节仍按原限制，见[本地处理上限](docs/local-processing-limits.md)。单任务有内存及超时限制。
- 撤销与重做记录保留在当前页面会话。已保存的预览产物和任务历史可跨刷新查阅，重新载入后按来源标识查找。
- 本地取消与云端请求的停止及计费状态不同；已发出的云端调用需要核对结果和账单。
- 只监听本机，不提供远程登录及多人服务部署。

## 可选云端功能

推荐在启动后的工作台顶部打开“设置”，配置自己的 API Key、模型，并按需开启付费开关与价格确认。模型填方舟控制台的 Model ID，例如 `doubao-seedream-5-5-261028` 或 `doubao-seedream-5-0-pro-260628`。Windows 使用当前用户 DPAPI 加密保存密钥，只有该 Windows 用户可解密；页面不回显密钥，也不写入浏览器持久存储。保存只做本地检查，不发起调用。设置保存后对新任务生效，无需重启服务。

页面设置保存在被 Git 忽略的 `storage/settings.json`，优先于进程环境变量和 `.env`；清除密钥后也不会自动回退到环境变量中的旧密钥。进行中的云端请求保持启动配置，排队任务的模型和提示词沿用提交快照，并检查启动时的当前付费开关。

以下 `.env` 命令是可选的命令行配置方式；更改 `.env` 后需重启，且已有页面设置的同名字段仍优先。

Seedream 云端线稿、图层分解和局部修复需要用户自己的火山方舟账号、可用模型权限及付费开关，默认关闭，不影响本地功能。云端输出不加水印；局部修复按输入尺寸请求，输入低于方舟最小输出像素时会在本地缩回输入尺寸并记录变换，分层结果仍由所选 1K/1.5K/2K 档位定义。云端合成矢量化在颜色模式下把工作副本限制在 25 万像素以内，并记录缩放变换。

使用虚拟环境的 Python 执行：

    python -B scripts/seedream_validate.py init-config

命令创建私有 .env，不覆盖已有文件。参照 .env.example 填写自己的 API Key、模型；明确开启付费及价格确认开关后重启程序。密钥只在后端使用。不再设置预算、单次预留或调用次数门槛；不自动重试不确定的付费调用。

## 协作与开发

- [三人协作行动方案](docs/collaboration-action-plan.md)：阶段安排、A/B/C 职责与验收边界。
- [A 实施与交接记录](docs/a-implementation-status.md)：已完成能力、验证结果和 B/C 接入位置。
- [接口合同](docs/a-interface-contract.md)：设置、工作流、局部重跑、一键处理与平铺记录。
- [批量工作台契约](docs/batch-workbench-contract.md)：纹样分组、工作台选入、手动分类、流程预设、持久批次与批量导出接口。
- [本地处理上限](docs/local-processing-limits.md)：本次实测提高的像素上限、失败边界与未验证范围。
- [前端接入说明](docs/frontend-integration.md)：新版工作台的服务路径、会话模型、工序接口与回退方式。
- [配色决定记录](docs/palette-review.md)：当前「蜜蜡 · 沉褐」配色的参数、被否方案、验证与遗留问题。

A 的基础实现已完成。真实提示词实验、自动选层策略、矢量质量改进和固定素材验收继续按计划推进。最新定向验证及复现命令见交接记录。前端测试和 Edge 验证脚本需要 Node.js 22 或更新版本。

运行代码位于 `frontend/next-v2/`、`frontend/`（旧前端，只读对照）和 `backend/app/`，测试沿用 `frontend/tests/`、`backend/tests/` 与 `tests/`，验证入口在 `scripts/`。设计交接材料归在 `design/`，本地运行数据和验证产物归在被 Git 忽略的 `storage/`。

## 离线备份与恢复

页面私有设置 `storage/settings.json` 与 `.env` 均不包含在备份中。恢复后需在“设置”重新填写密钥及费用配置；任务、资产和工作流分支记录随数据库恢复。

先停止程序，再用虚拟环境的 Python 执行：

    python -B scripts/backup_restore.py backup --output ../pattern-backup
    python -B scripts/backup_restore.py verify --backup ../pattern-backup
    python -B scripts/backup_restore.py restore --backup ../pattern-backup --target ../pattern-restored

输出和恢复路径应为尚不存在的独立目录。备份包含运行源码和项目数据。恢复后需重新安装依赖，从有仓库权限的工作副本补齐 `model/` 中的模型文件，并按需配置云端密钥。程序需手动启动。

源码、开发文档和测试夹具随仓库提供。个人素材、密钥、虚拟环境和运行产物各自在本机保存。算法效果取决于素材，需人工检查预览和导出结果。

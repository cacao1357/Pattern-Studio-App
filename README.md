# Pattern Studio

> 当前定位（2026-11-01）：这是多人协作前的地基实验基线。已有本地功能及隔离技术验证，真实素材质量、全新环境安装和多人协作流程仍待验证。后续开发以本仓库为起点，按具体变更建立评审和验收约定。

本地运行的图案提取与矢量化工作台。包含透明背景提取、全局/局部阈值、GrabCut、蒙版画笔、图像增强、旋转纠偏、轮廓图、SVG 矢量化与调色、预览/应用/放弃、撤销重做、取消、本地历史和导出。

## 安装与启动

需要 **Python 3.11（64 位）**和现代浏览器。Windows 为当前验证平台；其他平台尚未实机验证。无需 Node.js、Conda 或本地 AI 模型。

克隆仓库后，在项目根目录创建虚拟环境：

    python -m venv .venv

Windows PowerShell：

    .\.venv\Scripts\python.exe -m pip install -e .
    .\.venv\Scripts\python.exe -B scripts/serve_api.py

macOS / Linux（未实机验证）：

    .venv/bin/python -m pip install -e .
    .venv/bin/python -B scripts/serve_api.py

浏览器打开 **http://127.0.0.1:8765**。关闭时在启动终端按 Ctrl+C。保持仓库目录结构完整；此程序通过源码目录读取前端资源，不支持只复制 Python 安装包运行。

本地功能不需要配置密钥，不调用云端。导入图片后，根据提示创建工作副本、选择区域、提取并预览，确认后应用；随后可精修、矢量化或导出。透明 PNG 优先选已有透明度；照片可先选区域再用 GrabCut。局部阈值适合线稿，可能掏空大面积实心区域，应比较预览。

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

### 可选的本地线稿模型

把 Stage D 模型包的 `model.pt` 和 `inference.json` 放在项目根目录的 `model/` 下。依赖要安装到运行工作台的同一个 Python 3.11 环境。下面以项目虚拟环境安装 CPU 版为例。如果该环境已有匹配的 GPU 版 PyTorch 和 torchvision，只需补装缺失的分割模型库。

```powershell
.\.venv\Scripts\python.exe -m pip install torch==2.9.1 torchvision==0.24.1 --index-url https://download.pytorch.org/whl/cpu
.\.venv\Scripts\python.exe -m pip install segmentation-models-pytorch==0.5.0
```

重启工作台后，在「线稿」组选择本地模型。OpenCV 仍是默认选项。CUDA 可用时直接在 GPU 上推理，CUDA 不可用或运行时显存分配失败时回退到 CPU。产物记录实际推理设备。模型将所选图像缩放到 512×512 推理，再把概率图映射回所选图像尺寸，以 0.5 阈值生成透明底黑线 PNG。模型任务串行运行，系统内存限额为 4 GiB，默认超时 90 秒。预览并应用线稿后，可选「轮廓单线」转为 SVG。长宽比悬殊或细节密集的素材可先裁出纹样单元。

## 数据与限制

- 上传及结果保存于自动创建的 storage/api/，包含 SQLite 历史；保留该目录即可保留本地数据。
- 常规处理工作图上限为 100 万像素；大图先创建工作副本。单任务有内存及超时限制。
- 临时撤销栈和未应用预览不跨刷新保存；已生成版本和任务历史会保留。
- 本地取消与云端请求的停止及计费状态不同；已发出的云端调用需要核对结果和账单。
- 只监听本机，不提供远程登录及多人服务部署。

## 可选云端功能

推荐在启动后的工作台顶部打开“设置”，配置自己的 API Key、模型、付费开关、价格确认、预算、单次预留和调用数。密钥不会回显；保存只做本地检查，不发起收费测试。设置保存后对新任务生效，无需重启服务。

页面设置保存在被 Git 忽略的 `storage/settings.json`，优先于进程环境变量和 `.env`；清除密钥后也不会自动回退到环境变量中的旧密钥。进行中的云端请求保持启动配置，排队任务的模型和提示词沿用提交快照，并检查启动时的当前费用闸门。

以下 `.env` 命令是可选的命令行配置方式；更改 `.env` 后需重启，且已有页面设置的同名字段仍优先。

Seedream 图层分解和局部修复需要用户自己的火山方舟账号、可用模型权限及费用配置，默认关闭，不影响本地功能。

使用虚拟环境的 Python 执行：

    python -B scripts/seedream_validate.py init-config

命令创建私有 .env，不覆盖已有文件。参照 .env.example 填写自己的 API Key、模型和已核实的预算、单次最高预留费用；明确开启付费及价格确认开关后重启程序。密钥只在后端使用。预算预留值须覆盖整次请求的最坏费用，图层分解一次可能产生多张图片。不自动重试不确定的付费调用。

## 协作与开发

- [三人协作行动方案](docs/collaboration-action-plan.md)：阶段安排、A/B/C 职责与验收边界。
- [A 实施与交接记录](docs/a-implementation-status.md)：已完成能力、验证结果和 B/C 接入位置。
- [接口合同](docs/a-interface-contract.md)：设置、工作流、局部重跑和恢复字段。

A 的基础实现已完成；真实提示词实验、自动选层策略、矢量质量改进和固定素材验收继续按计划推进。离线验证当前通过后端 53 项、前端 23 项及 Edge 10 项检查；云端使用模拟响应，不代表真实模型质量已通过验收。复现命令见交接记录；日常使用不需要 Node.js，前端测试和 Edge 验证脚本需要 Node.js 22 或更新版本。

## 离线备份与恢复

页面私有设置 `storage/settings.json` 与 `.env` 均不包含在备份中。恢复后需在“设置”重新填写密钥及费用配置；任务、资产和工作流分支记录随数据库恢复。

先停止程序，再用虚拟环境的 Python 执行：

    python -B scripts/backup_restore.py backup --output ../pattern-backup
    python -B scripts/backup_restore.py verify --backup ../pattern-backup
    python -B scripts/backup_restore.py restore --backup ../pattern-backup --target ../pattern-restored

输出和恢复路径应为尚不存在的独立目录。备份包含运行源码和项目数据，排除 .env。恢复后需重新安装依赖，自行配置云端密钥；程序不会自动启动。

这是可运行的源码仓库，不包含开发文档、测试素材、个人数据、密钥、虚拟环境或预编译安装包。算法效果取决于素材，需人工检查预览和导出结果。

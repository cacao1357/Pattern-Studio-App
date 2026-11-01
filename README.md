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

A 的基础实现已完成；真实提示词实验、自动选层策略、矢量质量改进和固定素材验收继续按计划推进。离线验证已通过后端 18 项、前端 8 项及 Edge 10 项检查；云端使用模拟响应，不代表真实模型质量已通过验收。复现命令见交接记录；日常使用不需要 Node.js，前端测试和 Edge 验证脚本需要 Node.js 22 或更新版本。

## 离线备份与恢复

页面私有设置 `storage/settings.json` 与 `.env` 均不包含在备份中。恢复后需在“设置”重新填写密钥及费用配置；任务、资产和工作流分支记录随数据库恢复。

先停止程序，再用虚拟环境的 Python 执行：

    python -B scripts/backup_restore.py backup --output ../pattern-backup
    python -B scripts/backup_restore.py verify --backup ../pattern-backup
    python -B scripts/backup_restore.py restore --backup ../pattern-backup --target ../pattern-restored

输出和恢复路径应为尚不存在的独立目录。备份包含运行源码和项目数据，排除 .env。恢复后需重新安装依赖，自行配置云端密钥；程序不会自动启动。

这是可运行的源码仓库，不包含开发文档、测试素材、个人数据、密钥、虚拟环境或预编译安装包。算法效果取决于素材，需人工检查预览和导出结果。

# Pattern Studio · 纹样工作台

在本机把平面纹样照片处理成透明线稿 PNG 和可编辑 SVG。可以从整张图开始，裁取局部、修正蒙版、移动或删除 SVG 色块，最后平铺检查接缝，按原图分组导出。原图、已保存版本和任务历史保存在自己的电脑上。

## Windows 快速开始

1. 在 [v0.2.0 下载页](https://github.com/cacao1357/Pattern-Studio-App/releases/tag/v0.2.0) 的 **Assets** 中选择 **Pattern-Studio-0.2.0-windows-x64.zip**。这是完整的 Windows 64 位便携包，内置 Python 3.11、CPU 推理环境、TGS-Net 线稿权重和 LeftRefill 微调提示向量。GitHub 的 **Source code** 是供开发用的源码快照。
2. 将 ZIP **完整解压**到路径较短、当前用户可写的目录，例如 `D:\Apps`。进入 `Pattern-Studio`，双击 **Start.cmd** 并保持终端打开。
3. 用浏览器打开 [本地工作台](http://127.0.0.1:8765/)。点「添加纹样」或上传自己的 PNG/JPEG。第一次可用一张背景干净的小图，在「提取」选「本地模型」，生成线稿后进入「矢量」，保存并导出 SVG。

便携包的本地流程可离线使用，无需另装 Python、Node.js、Git LFS 或配置 API Key。关闭服务时在启动终端按 Ctrl+C。默认端口被其他程序占用时，在解压目录打开 PowerShell，执行 `.\Start.cmd --port 8876`，再打开 [备用端口地址](http://127.0.0.1:8876/)。服务仅监听本机。

## 工作台操作

| 目标 | 操作 |
| --- | --- |
| 提取纹样 | 在「来源」导入原图，可先裁切。直接进入「提取」可选本地模型、OpenCV 或颜色提取。模型输出保持输入尺寸的透明底黑线 PNG。 |
| 修复破损 | 在「修复」选择路线。本地 LeftRefill 使用 512×512 裁切、缺损框和已保存的参考图，安装见下节。检查候选后点接受，局部结果回填原画布。 |
| 修改线稿与 SVG | 在「蒙版」修正透明 PNG，再到「矢量」生成 SVG。按填色连通区域选择、移动或删除，保存产生新版本。滑动对照和透明叠加用于核对原图。 |
| 检查并导出 | 在「平铺」做 2×2 或 3×3 接缝预览。批量导出可选原图、PNG、SVG，ZIP 按原图分组并保留来源和已登记的许可。 |
| 继续或批量处理 | 首页可恢复上次工作，也可开始新的选入列表。纹样库保存各图与版本。批次在需裁切、修复或人工确认处暂停，进度可在任务中心查阅。 |

批量导出每次最多 500 个版本、合计 128 MiB。不同工序有独立像素和时间限制，大图可先显式创建工作副本。处理质量请结合原图检查，尤其是实物照片中的细线、孔洞和低对比区域。[各工序实测上限](https://github.com/cacao1357/Pattern-Studio-App/blob/v0.2.0/docs/guides/local-processing-limits.md)

## 本地线稿模型

主包中的 `model/model.pt` 与 `model/inference.json` 对应 TGS-Net（HRNet-W18 + U-Net++）。模型以 512×512 窗口、256 像素步长重叠推理，阈值为 0.5，部署参数为 `gate_alpha=0`。便携包默认使用 CPU。下面是可选的 NVIDIA GPU 路线。

### GPU 加速与 LeftRefill 局部修复

使用兼容 CUDA 12.8 的 NVIDIA 驱动，在便携包根目录打开 PowerShell。以下命令用内置 Python 创建独立的 GPU 环境，首次安装需要联网和数 GB 可用磁盘空间。

```powershell
.\python\python.exe -m venv .venv-gpu
.\.venv-gpu\Scripts\python.exe -m pip install torch==2.9.1 torchvision==0.24.1 --index-url https://download.pytorch.org/whl/cu128
.\.venv-gpu\Scripts\python.exe -m pip install ".[leftrefill]" segmentation-models-pytorch==0.5.0 timm==1.0.31
.\.venv-gpu\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

结果显示 `True` 后即可用该环境加速线稿。要启用 **LeftRefill**，从[完整基础权重发布页](https://github.com/cacao1357/Pattern-Studio-App/releases/tag/leftrefill-textile-step1108) 下载 **leftrefill-sd2-unet.zip** 和 **leftrefill-sd2-components.zip**，按该页的 SHA256SUMS 核对。将两个 ZIP 解压到同一父目录，会得到 `leftrefill-sd2`。其中应同时有 `scheduler`、`text_encoder`、`unet`、`vae` 四个目录以及许可和转换说明。两个包合计约 2.4 GiB，微调提示向量已随主包提供。

停止 CPU 服务后，用同一 PowerShell 指向解压目录并启动 GPU 服务。下次新开终端需重新设置该变量，也可将上述四个子目录和许可文件直接放在 `model/leftrefill/base/`。

```powershell
$env:PATTERN_STUDIO_LEFTREFILL_BASE_MODEL = 'D:\Models\leftrefill-sd2'
.\.venv-gpu\Scripts\python.exe -B scripts/serve_api.py
```

LeftRefill 使用 CUDA FP16，显存不足会报告错误。SD2 基础权重适用随权重分发的 CreativeML Open RAIL++-M 许可。模型输入、微调和评估说明见 [LeftRefill 文档](model/leftrefill/README.md)。

## 数据、升级与云端设置

- **工作数据**位于解压目录下的 `storage/api/`。升级时先完成或取消活动批次，再停止旧服务。将新版本解压到独立目录，复制旧版完整的 `storage/api/` 到新目录的同一位置后启动。先保留旧目录，核对纹样库、历史和导出结果。备份和离线校验也可运行 `scripts/backup_restore.py --help`。
- **个人设置**位于 `storage/settings.json`。Windows 下保存的密钥由当前用户的 DPAPI 保护。换机或换账户后，在「设置」重新配置自己的密钥。空白便携包首次启动使用新素材库。
- **云端功能**可用于线稿、候选分层和局部修复。在「设置」填写自己的火山方舟模型 ID 与 API Key，并在需要时开启「允许云端计费调用」。提交会上传所选素材并可能产生费用。遇到结果未知的任务，请先在任务中心和服务商账单核对。
- **排查启动问题**时先看启动终端，再打开 [默认端口健康检查](http://127.0.0.1:8765/api/v1/health)。它报告数据库、写入、worker 和模型前置条件；一次实际提取可检验推理是否成功。

## 从源码运行

需要 64 位 Python 3.11。Windows 是本项目验证的平台。安装 Git LFS 后，克隆仓库并在根目录执行以下命令。这里使用 CPU 版 PyTorch，GPU 用户可采用上面的 CUDA 版本。

```powershell
git lfs pull --include="model/model.pt" --exclude=""
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install torch==2.9.1 torchvision==0.24.1 --index-url https://download.pytorch.org/whl/cpu
.\.venv\Scripts\python.exe -m pip install . segmentation-models-pytorch==0.5.0 timm==1.0.31
.\.venv\Scripts\python.exe -B scripts/serve_api.py
```

运行代码位于 `backend/app/` 与 `frontend/next-v2/`。旧版对照页位于 [本机 /legacy/](http://127.0.0.1:8765/legacy/)。开发者可安装 `.[dev]` 并运行 `python -m pytest -q`，前端测试使用 Node.js 22+ 执行 `node --test frontend/tests/*.test.mjs`。[项目文档与接口索引](https://github.com/cacao1357/Pattern-Studio-App/blob/v0.2.0/docs/README.md)

发布包使用 [python-build-standalone 20261110](https://github.com/astral-sh/python-build-standalone/releases/tag/20261110) 的 CPython 3.11.18 Windows x64 运行时及项目依赖的二进制发行包。Python 和依赖的许可文件随运行时保留。维护者在 Windows 上备好 Git LFS 权重与 uv 后，可用 `python scripts/package_windows.py <运行时.tar.gz>` 从工作区构建便携包，产物位于 `dist/`。

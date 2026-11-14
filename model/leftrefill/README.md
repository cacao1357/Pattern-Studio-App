# LeftRefill 纹样修复

本目录交付参考图引导修复的 Diffusers 实现和累计 **1108 步**的纹样微调提示向量。参考图放左侧，待修复图放右侧，组成 1024×512 画布。训练只更新 50×1024 个提示向量参数，SD2 的 UNet、VAE 和文本编码器冻结。

## 文件与来源

- `inference.py` 提供可复用的 `LeftRefill` 类和单图命令行入口。
- `prompt.safetensors` 保存全部 51,200 个微调参数，大小 205,040 字节。由 `epoch-03.ckpt` 安全转换，已用 `torch.equal` 验证张量逐元素相同。
- `inference.json` 记录提示向量、基础模型全部文件的 SHA-256、推理参数及训练来源。
- `evaluation.json` 保存原有固定 63 张验证图的汇总结果和可比检查点排名。
- `LICENSE`、`NOTICE` 记录上游 Apache-2.0 代码许可、版本与本次修改。

原始研究及代码见 [LeftRefill 官方仓库](https://github.com/ewrfcas/LeftRefill)，本次实现基于本地训练已使用的 Diffusers 适配路线。来源版本为 `893c3220ffefba7158c1b5c688d344a8a0e3ff80`。参考图、掩码、原始纹样训练素材的许可需按各自来源核实。

## 基础模型

训练及推理实际使用的 **SD2-inpainting Diffusers 转换目录**已作为两个 ZIP 附件发布在 [完整基础权重 Release](https://github.com/cacao1357/Pattern-Studio-App/releases/tag/leftrefill-textile-step1108)。7 个必需文件合计约 2.4 GiB。微调提示向量 `prompt.safetensors` 随源码提供，运行时还需下载并解压两个基础权重 ZIP。

| Release 附件 | 大小（字节） | 内容 |
| --- | --- | --- |
| `leftrefill-sd2-unet.zip` | 1731935096 | UNet 权重和配置 |
| `leftrefill-sd2-components.zip` | 848188933 | 文本编码器、VAE、调度器、相应配置和模型许可 |
| `SHA256SUMS` | 188 | 两个 ZIP 的 SHA-256 |

在包含本 PR 提交的项目根目录运行以下 PowerShell 命令。需要 GitHub CLI，也可在 Release 页面手动下载两个 ZIP 和 `SHA256SUMS`，完成校验后解压。

```powershell
$downloadDir = Join-Path $PWD "leftrefill-downloads"
New-Item -ItemType Directory -Path $downloadDir -ErrorAction Stop | Out-Null
gh release download leftrefill-textile-step1108 --repo cacao1357/Pattern-Studio-App --pattern "leftrefill-sd2-*.zip" --pattern "SHA256SUMS" --dir $downloadDir
if ($LASTEXITCODE -ne 0) { throw "基础模型下载失败" }
Get-Content (Join-Path $downloadDir "SHA256SUMS") | ForEach-Object {
    $expected, $filename = $_ -split '\s+', 2
    $actual = (Get-FileHash -LiteralPath (Join-Path $downloadDir $filename) -Algorithm SHA256).Hash
    if ($actual -ne $expected) { throw "基础模型 ZIP 校验失败 $filename" }
}
Expand-Archive -LiteralPath (Join-Path $downloadDir "leftrefill-sd2-components.zip") -DestinationPath model/leftrefill
Expand-Archive -LiteralPath (Join-Path $downloadDir "leftrefill-sd2-unet.zip") -DestinationPath model/leftrefill
```

两个 ZIP 解压到同一个父目录后，目录结构如下。文件级 SHA-256 保存在 `inference.json`，推理加载前逐一校验。

```text
model/leftrefill/leftrefill-sd2/
  scheduler/scheduler_config.json
  text_encoder/config.json
  text_encoder/model.fp16.safetensors
  unet/config.json
  unet/diffusion_pytorch_model.fp16.safetensors
  vae/config.json
  vae/diffusion_pytorch_model.fp16.safetensors
  BASE_MODEL_LICENSE
  BASE_MODEL_NOTICE
  SD2_MODEL_CARD.md
```

文本编码器使用训练转换保留的 **23 层、1024 维、49408 词表**，UNet 输入为 9 通道。基础模型源于原 `stabilityai/stable-diffusion-2-inpainting` 的 `512-inpainting-ema.ckpt`，转换为 Diffusers、FP16 权重及 safetensors，并保留 23 层文本编码器。逐文件修改和来源说明随包提供。

基础模型及其派生模型适用 [CreativeML Open RAIL++-M License 全文](BASE_MODEL_LICENSE)，使用者和再分发者均须遵守第 5 条与 Attachment A 的用途限制，并按许可要求保留许可及修改说明。发布包包含本地训练和推理已经使用的转换文件，包内文件已逐一与训练清单核验。原模型说明的保留副本见包内 `SD2_MODEL_CARD.md`。

已有同一份基础模型时，也可将 `--base-model` 指向其他位置的 `leftrefill-sd2/`。

## 安装

在项目根目录创建独立 Python 3.11 环境。

```powershell
py -3.11 -m venv .venv-leftrefill
.\.venv-leftrefill\Scripts\python.exe -m pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cu124
.\.venv-leftrefill\Scripts\python.exe -m pip install -r model/leftrefill/requirements.txt
```

上述版本对应原训练 L40S 环境。较新 GPU 需要支持其计算架构的 PyTorch/CUDA 组合，例如本地 RTX 5060 的交付检查使用 PyTorch 2.8.0+cu128。安装合适的 GPU 版 PyTorch 后再补装 `requirements.txt`。本实现使用 CUDA FP16 推理。

## 单图运行

待修复图和掩码均为 512×512。掩码为严格二值图，白色 255 表示缺损，黑色 0 表示保留。参考图应来自完整、相关的纹样区域，入口将其以双三次插值缩放到 512×512。建议从同图未受损区域裁取参考块，原验证集采用内容区内不与缺损相交的最高方差正方形，边长最多 128 像素。

```powershell
.\.venv-leftrefill\Scripts\python.exe model/leftrefill/inference.py `
  --base-model model/leftrefill/leftrefill-sd2 `
  --target D:/samples/target.png `
  --mask D:/samples/mask.png `
  --reference D:/samples/reference.png `
  --output D:/results/restored.png `
  --seed 23407
```

固定 DDIM 20 步、CFG 2.5、eta 1.0。默认批量计算无条件与有条件分支。显存较小时可加 `--sequential-guidance` 逐个计算两个分支，浮点舍入可能变化。输出 PNG 直接复制缺损区以外的原图像素，输出路径须为新文件。

复用模型时，可在项目根目录使用下面的 Python 入口。

```python
from PIL import Image
from model.leftrefill.inference import LeftRefill

pipeline = LeftRefill("model/leftrefill/leftrefill-sd2")
with Image.open("target.png") as target, Image.open("mask.png") as mask, Image.open("reference.png") as reference:
    result = pipeline.restore(target, mask, reference, seed=23407)
result.save("restored.png")
```

## 权重选择与验证范围

按可比训练记录中固定 63 张验证图的**平均缺损区 PSNR**选择 1108 步，三类掩码各 21 张，参考图、掩码和随机种子相同。PSNR 越高越好，MAE 按 0–255 计算，越低越好。

| 分组 | 700 步 PSNR | 1108 步 PSNR | 700 步 MAE | 1108 步 MAE |
| --- | ---: | ---: | ---: | ---: |
| 全部 63 张 | 14.6942 | **14.7630** | **29.4742** | 29.6274 |
| 孔洞 | 14.4101 | **14.4232** | **32.5577** | 32.9555 |
| 窄撕裂 tears | 14.4280 | **14.5585** | **27.0415** | 27.2931 |
| 敦煌 | 15.2446 | **15.3072** | 28.8235 | **28.6336** |

1108 步相对 700 步平均提升 0.0688 dB，32 张提升、31 张下降，配对 bootstrap 95% 区间为 [-0.0074, 0.1490] dB。孔洞与敦煌合计提升 0.0379 dB。改善幅度较小，区间跨过零，整体 MAE 以 700 步较好。多个检查点反复使用这套验证集选优，结果受选优偏差影响，独立测试集泛化仍待验证。

最近一次训练由 700 步继续 3 轮至 1108 步，542 张训练图，每轮随机选掩码并在内容范围内随机平移最多 15%。采用筛过的孔洞、窄撕裂 tears 和敦煌三类，剔除 `loss` 大面积撕裂类别。累计增加 408 次更新、1626 个图像掩码组合。

本目录汇总指标来自原 L40S 训练验证记录。本次交付另做权重转换一致性、校验清单、掩码处理及本地单图 GPU 链路检查，具体环境、命令与结果见 PR 验证记录。

运行便携检查的命令如下。

```powershell
python -m pytest tests/test_leftrefill_delivery.py -q
```

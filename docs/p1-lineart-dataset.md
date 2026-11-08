# P1：线稿分支、轮廓矢量与数据集清单

P1 在 P0 的数据质量与来源层之上，增加三个可独立验证的本地能力。全部只在本机执行，不新增云端调用。

## 1. 数据集清单与审计

- `GET /api/v1/datasets/manifest.csv`：一行一张已登记图片，带 UTF-8 BOM，可直接用 Excel 打开。
- `GET /api/v1/datasets/audit`：与清单同源的汇总，不重新读取像素。
- 顶部“数据集”按钮打开只读审计面板，并提供清单下载。

清单字段：

```
image_id, content_id, grade, grade_version, split, license,
provenance_status, source_type, source_name, source_url,
collected_at, batch_id, width, height, sha256,
original_asset_id, normalized_asset_id, source_note, created_at,
label_status, missing_meta
```

口径：

- `content_id` 来自原图字节 SHA-256 前 16 位；同一图片的不同处理版本不会重复成行。
- 旧图片没有 `image_meta` 时仍出现在清单中，`missing_meta=true`，质量/划分字段为空。
- `label_status` 当前统一为 `not_reviewed`；本阶段没有审核表，不伪造人工审核结果。
- 审计汇总包括 A/B/C/U/missing、train/val/test、授权覆盖、重复 content_id、来源类型与批次。

## 2. 线稿分支 v0.2

- 入口：处理页“线稿”组，`POST /api/v1/jobs/lineart`。
- 算法：全局 CLAHE + Sobel/Canny 分位数路径，加局部对比度归一化 + 8×8 分块阈值路径，两路取并集；中值核与连通域门槛随长边缩放。
- 输出：透明背景、黑色墨线的 RGBA PNG，`kind=lineart`，可继续作为矢量化输入。
- 元数据：`ink_ratio`、`ink_bright`、`local_gain`、`edges_px`、`components`、`med`、`min_area` 与算法版本 `lineart-global-local-v2`。
- 说明：这是可编辑线稿草稿，不替代人工修线；实验中的 Zhang-Suen 骨架化因断线问题未开放。
- 同一接口可提交 `{"input_asset_id":"…","method":"model"}` 启用本地模型，安装方式见 [README](../README.md#可选的本地线稿模型)。模型模式只接收输入资产和方法。省略 `method` 或提交 `"opencv"` 均走传统算法。模型成果保持输入坐标系，记录模型版本、权重标识、缩放方式、阈值和实际推理设备 `inference_device`（`cuda` 或 `cpu`），供人工预览与复核。

已知限制：

- Canny 天然产生双边缘，输出仍可能在粗笔画上出现两条边；更干净的 1 px 中心线需要后续专门的细化/拟合阶段。
- 透明输出适合继续矢量化；若需要白底线稿，应在导出阶段合成白底，而不是改变资产本身。

## 3. 轮廓单线矢量模式

- `VectorOptions.mode = "contour"`，处理页“轮廓单线”单选项。
- 使用可见 alpha 阈值生成掩膜，`cv2.findContours(RETR_CCOMP)` 保留外轮廓与孔洞，`approxPolyDP` 简化后写入 `fill-rule="evenodd"` 的闭合路径。
- 细节等级控制简化 epsilon：低 2.0、中 1.0、高 0.5，并按短边缩放。
- 固定墨色 `#1B2B54`，适合线稿/蒙版轮廓；不按 `max_colors` 做调色板量化。
- 适用输入是透明前景蒙版或线稿；对完全不透明的生活照片直接使用会得到整幅外轮廓，应先提取前景。

## 验证

```text
.\.venv\Scripts\python.exe -m pytest -q
node frontend/tests/workbench-regressions.test.mjs
node frontend/tests/settings.test.mjs
node scripts/validate_a_browser.mjs .venv\Scripts\python.exe
```

P1 新增测试覆盖：

- 线稿输出尺寸、透明背景、算法元数据、平坦图与参数校验。
- 轮廓模式保留孔洞、空 alpha 拒绝、细节等级改变简化量。
- 数据集 CSV 表头/BOM/行数、审计授权覆盖、批次、`label_status`。
- 线稿任务真实 worker 执行并发布 `lineart` 资产。

本机浏览器夹具截图（不入库）：`_qa/p1-ui/`。

## 2026-11-04 集成修复

- AI 决策操作独立于候选面板；缺少拆分结果或候选层读取失败时仍可使用本地恢复入口。
- 轮廓 SVG 在路径上显式记录填色，可识别调色板并换色；本地与辅助流程按实际适配器记录算法版本。
- 数据集审计正确计入旧图片的 `grades.missing`。
- 集成后后端定向验证 48 项通过（另有 2 个 subtest），现有前端测试 23 项通过。浏览器回归新增两类失败恢复场景，并检查原有设置、合成与局部重跑流程。
- 以上使用合成夹具及本地处理，不代替真实云端、固定素材保真或外部 SVG 编辑器验收。

# P0 数据契约：体检、去重、来源与清单 v2

> 对应实现：`image_meta`、`/api/v1/images` 上传字段、导出 `manifest.json` v2。
> 目标是与 `CV-Datatext-Pipeline` 的数据层对齐，同时不改变 Pattern Studio 现有的
> 坐标语义、处理上限和付费闸门。

## 1. 身份：content_id 与 CV 的 image_id 一致

```text
content_id = sha256(original file bytes)[:16]
```

- 只跟上传文件的原始字节有关；重新编码、改文件名都会得到新的 `content_id`。
- CV 仓库的 `image_id = sha256(raw bytes)[:16]`，因此两边可以直接对上号。
- Studio 内部仍使用 UUID 作为资产主键；`content_id` 是跨仓库的公共身份。

## 2. `image_meta`（新增表，不修改旧表）

| 字段 | 含义 |
|---|---|
| `image_id` | Studio 的图像记录主键 |
| `content_id` | 见上，16 位十六进制 |
| `grade` / `grade_version` | A / B / C / U（指标失败） |
| `short_side` | 原图短边像素 |
| `sharpness` / `contrast` | 在 512 参考画布上测得的 Laplacian 方差 / 灰度标准差 |
| `ref_size` / `ref_fit` | `512` / `letterbox_reflect` |
| `ahash` / `fingerprint_version` | 64 位均值哈希（十进制字符串） |
| `split` | `train` / `val` / `test`，由 content_id 决定 |
| `source_type` / `source_name` / `source_url` | 人工登记，可为空 |
| `license` | 默认“未确认” |
| `collected_at` / `batch_id` | `YYYY-MM-DD` / 批次标识 |
| `provenance_status` | `unverified` / `declared` |
| `normalization_version` | `normalize-image-v1` |

根资产（original / normalized_input）和所有派生资产都会继承
`image_id, content_id, grade, grade_version, split, license, source_type,
source_name, source_url, collected_at, batch_id, provenance_status,
normalization_version`，以及各自的 `algorithm_version`。

## 3. 质量分级（仅提示，不淘汰）

在 512 px letterbox（镜像填充）参考画布上测量；透明图先合成白底。
阈值沿用 CV 仓库 v0.1 的标定：

```text
A: short_side >= 512 且 sharpness >= 300 且 contrast >= 35
C: short_side < 300 或 sharpness < 100 或 contrast < 22
B: 其余
```

- C 级只提示“建议换素材或先放大”，**不阻止**本地处理。
- 指标计算失败时 `grade = U`，上传继续（fail-open）。
- 参考画布只用于测量，不落盘、不替换工作图、不改变坐标空间。

## 4. 近似去重（只提示）

1. 一级：`ahash` 汉明距离 ≤ 4（粗筛，宁可多报）。
2. 二级：原图 32×32 零均值单位向量 NCC。
   - `>= 0.98`：`confirmed`
   - `0.90–0.98`：`suspect`
   - `< 0.90`：不返回
3. 上传响应带 `duplicates`；前端可切换已有版本，**不自动合并、不删除新上传**。

## 5. 来源/授权

- 上传表单可选：`source_type, source_name, source_url, license, collected_at, batch_id`。
- 空值默认“未确认”；`source_url` 只接受 http(s)，不抓取。
- `provenance_status = declared` 当任一来源字段被实际填写（授权不是“未确认”）。
- 导出 ZIP 时，未确认授权的版本需要一次显式 `license_acknowledged: true`；
  本地处理、预览、下载不受影响。

## 6. API 变化

```http
POST /api/v1/images
  file, source_note,
  source_type, source_name, source_url, license, collected_at, batch_id

GET /api/v1/images/{image_id}       # 读取记录，供“使用已有版本”切换
```

上传响应新增：

```json
{
  "meta": { "content_id": "...", "grade": "B", "split": "train", "...": "..." },
  "duplicates": [
    { "image_id": "...", "ncc": 1.0, "status": "confirmed",
      "grade": "B", "original_asset_id": "...", "normalized_asset_id": "..." }
  ]
}
```

错误码：

- `INVALID_PROVENANCE` 422
- `LICENSE_REVIEW_REQUIRED` 409

## 7. 导出清单 v2

`manifest.json`：

```json
{
  "schema_version": "local-s1-v2",
  "versions": {
    "manifest": "local-s1-v2", "grade": "p0-v1", "fingerprint": "p0-v1",
    "pattern_score": "p0-v1", "normalization": "normalize-image-v1",
    "provenance": "p0-v1", "extraction": "local-extraction-v2",
    "vector": "vtracer-0.6-rgba-v4"
  },
  "dataset": {
    "content_id": "sha256(original file bytes)[:16]",
    "split_policy": "sha256[:8] mod 100 -> 80/10/10"
  },
  "selected_assets": ["每个版本带 image_id/content_id/grade/split/license/algorithm_version"],
  "referenced_ancestors": ["..."],
  "content_ids": ["..."],
  "license_acknowledged": true
}
```

## 8. 蒙版“纹样性”评分

- 对 `foreground_mask` / `transparent_png` / `composed_candidate` / AI 候选层计算。
- 规则来自 CV `pattern_score`：面积占比 0.5%–45%、贴边 ≤1.2、bbox 填充率 ≤0.85、
  长宽比 ≤5；通过时 `pattern_score = 1 - bbox_fill`。
- 只作复核提示，不自动拒绝、不自动改标签。
- 用户手画/提取蒙版覆盖过大时会出现“候选存疑”，这是提示“可能选中背景”，不是错误。

## 9. 兼容与回填

- 旧数据库直接打开：`image_meta` 用 `CREATE TABLE IF NOT EXISTS` 追加，旧图片 `meta = null`。
- 旧资产仍可预览、处理、导出；未登记授权的旧版本导出时同样需要一次确认。
- 可为旧图片补算指标（只新增 `image_meta`，不改资产）：

```powershell
.\.venv\Scripts\python.exe -B scripts/backfill_metrics.py --dry-run
.\.venv\Scripts\python.exe -B scripts/backfill_metrics.py
```

## 10. 测试

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

覆盖：分级边界、aHash/NCC、pattern_score、来源字段校验、`image_meta`、
上传/重复/导出闸门、旧库兼容、manifest v2。

### 2026-11-03：zgx 分支修复验证

- 普通矢量化及本地一键流程生成的 SVG 继承来源、授权、内容标识和分级字段，并记录矢量化算法版本；AI 合成后的 SVG 使用矢量化版本，不再继承合成算法版本。
- 浏览器验收夹具已适配上传函数的三项返回值；隔离初始化检查通过，能够生成模拟云端归档并到达服务启动入口。
- 使用现有 `D:/CondaEnvs/pattern-studio/python.exe` 执行 `python -B -m pytest -q -p no:cacheprovider tests/test_api_p0.py backend/tests/test_a_workflow.py`：19 项通过，另有 2 个子场景通过；没有真实云端调用。
- 本次 Edge 验收持续无输出，手动中止，未产生新的结果记录，不能视为通过；旧的 `storage/validation/a/` 记录不代表本次验证。
- DSH 恢复连接后已修复前端：重复图切换加入忙碌状态、未应用预览及未保存画笔/框选保护，并防止异步读取覆盖变化后的工作区；平铺 ZIP 复用来源授权确认，取消不提交，确认后携带 `license_acknowledged`，提交前复查任务和所选资产。
- 前端定向回归 `node frontend/tests/workbench-regressions.test.mjs`：15 项通过；现有设置模块测试：8 项通过；工作台模块语法检查和 `git diff --check` 通过。本轮未重跑浏览器，交互验收仍未完成。
- 合并前补充检查 `tests/test_quality.py`、`tests/test_provenance.py` 和 `tests/test_store_meta.py`：20 项通过。
- 前端委派：Harness `wb/cn:deepseek-v4.1-flash`，runId `4b86c873-572d-4cba-a591-1f7b78f0f92a`，sessionId `session-5f412772-79a0-4b85-bf60-5da7b3d04a23`；已完成，Codex 独立审查差异并复跑上述前端检查。

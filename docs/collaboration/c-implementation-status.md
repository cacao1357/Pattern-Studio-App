# C 矢量化实施与交接记录

更新：2026-11-04。负责人已按本次用户授权在 `zgx` 集成 C 与候选/P1 分支，准备验证后合入 `main`。集成保留 main 的来源继承修复，并按实际适配器记录 SVG 算法版本。以下 2026-11-03 记录中的 `hmy` PR 目标及“不合并”限制仅描述原交付阶段。

日期：2026-11-03。范围：透明 PNG → SVG、本地换色与预览导出追溯。开发与验证没有真实云端调用。按用户后续授权，Git 交付固定使用 `codex/member-c-vectorization` 分支及其同一个 PR；本轮不合并。

PR 目标分支为 `hmy`：本轮基线的 P0 提交 `5a8072c` 已在远端 `hmy`，尚未进入远端 `main`。以 `hmy` 为目标可只审查 C 的改动，避免把已有 P0 工作混入本 PR；P0 合入 main 后由负责人协调调整目标分支。

## 开工与职责边界

开工 Git 状态干净，基于 `5a8072cb28da6bcad60e8c3d0186fb44cf4a042c`；使用 `G:/CondaEnvs/pattern-studio/python.exe`。已阅读 AGENTS、行动方案、A 接口和交接、P0 契约。当前基线重新运行：Python 44/44、前端模块 8/8。

未修改 VectorOptions、公共配置、云端适配器、提示词、选层和蒙版算法，也未修改共享前端入口。现有参数、预览/应用、局部重跑和导出接口可继续消费本次结果。`assisted_workbench.py` 仅修改 SVG 发布时的算法版本，未修改 B 的合成逻辑。

## 发现及实现

1. VTracer spline 对独立 1×1 颜色组件输出空路径，旧适配器随后删除它；小元素因此消失。面积不超过 4 像素的四连通同色组件现在从 tracer 输入中分离，以精确像素并集路径追加；相同水平区间沿纵向合并为矩形子路径，减少重复节点。每种颜色一个路径，多个独立结构可为其子路径。不会按面积删除噪声或有效元素。
2. 补充实验发现，封闭的单像素孔洞也会被样条拟合填平。现在检测每种颜色的单像素内部补集组件，将其相邻颜色组件整体改用精确像素并集，保持孔洞。只有涉及这一拓扑风险的组件放弃样条平滑。边界补集像素不当作内部孔洞。
3. 现有前景 MEDIANCUT、无抖动、VTracer 填色映射已满足这些样例的颜色上限；没有证据支持再加颜色阈值。保留这些规则，新增实际选中色板记录。透明/低于阈值区隐藏 RGB 不参与量化。
4. 本地 SVG 发布原先遗漏 P0 字段，导致 image_id/content_id/授权追溯断链；现继承现有 `INHERITED_META_KEYS`、来源备注及证据状态，显式记录矢量算法版本。
5. 合成后 SVG 原先继承 PNG 算法标识；现改用 adapter_version。换色资产显式记录 `safe-svg-palette-v1`，几何来源通过父 SVG 追溯。
6. 修正现有浏览器夹具对 upload 三返回值的旧解包方式，使其能够继续到浏览器启动阶段。

实现：`backend/app/services/vector.py`、`local_workbench.py` 的矢量发布区域、`svg_edit.py` 的版本字段、`assisted_workbench.py` 的一个 SVG 版本字段、`backend/app/versions.py`。测试：`tests/test_vector_c.py`、`backend/tests/test_a_workflow.py`。工具：`scripts/validate_c_vector.py`、`scripts/compare_c_vector.py`。

## 版本、参数和兼容

- 算法由 `vtracer-0.6-rgba-v3` 更新为 `vtracer-0.6-rgba-v4`，集中定义 `VECTOR_VERSION`；健康状态/清单通过既有 versions.snapshot 获取。P0 文档示例同步更新。旧资产、旧文件和旧参数不回写。
- VectorOptions 字段和默认值不变：color、max_colors=8（2/4/8/16）、detail=medium；高级 length/corner/splice 覆盖值仍按原合同应用。
- low：length=8、corner/splice=90、precision=2；medium：4/60/3；high：1/45/4。档位控制普通样条的简化强度；受保护的小组件和单像素孔洞走精确路径，不承诺提高档位能恢复任意丢失结构。
- alpha≥128 仍转为不透明前景，小于 128 仍排除；PNG 的原 alpha 不改。SVG 继续二值透明，无背景矩形。不调整画布、viewBox、坐标或裁切。
- metadata 保存 options、实际 tracer_parameters、selected_palette、实际输出色板、alpha 策略、adapter_version；另保存 small_component_policy/pixels_preserved、singleton_hole_policy/holes_preserved、exact_component_pixels。孔洞计数为逐颜色拓扑诊断，彩色内部标记也可能计入，不能直接当作整张图透明孔洞数。
- SVG 仍只含真实 path；精确路径使用现有允许的 M/h/v/Z，不新增 SVG 标签或属性。安全检查及字节/路径/像素上限继续执行。一个 path 可含多个子路径，path_count 不等于元素数或节点复杂度。

## 固定独立开发基线与效果

七张由脚本原创、确定性生成的 96×96 透明 PNG；隐藏 RGB 使用种子 20261103。无外部素材许可依赖；均为合成开发样例，未使用或冒充共同 30 张真实验收集。输入逐字节可复现；保留 before/after PNG、SVG、实际参数、耗时和独立渲染 PNG。

以下为 color/medium；组件/孔洞由独立 resvg 渲染后 alpha≥128 掩膜测量（八连通组件、CCOMP 孔洞）。IoU 比较输入的二值 alpha，而非原始半透明外观。

| 样例 | 输入组件/孔洞 | 修改前→后组件/孔洞 | IoU 前→后 | path 数前→后 | 字节前→后 |
| --- | --- | --- | --- | --- | --- |
| 单色实心圆 | 1/0 | 1/0 → 1/0 | .98948 → .98948 | 1→1 | 381→381 |
| 1px 细线、35px 与 2px 孔洞 | 2/2 | 2/2 → 2/2 | 1 → 1 | 2→2 | 614→614 |
| 1/2/3/4px 独立方块及主体 | 5/0 | 4/0 → 5/0 | .99916 → 1 | 4→4 | 684→600 |
| 相邻近红/近蓝色块 | 1/0 | 1/0 → 1/0 | 1 → 1 | 2→2 | 399→399 |
| 半透明边缘、随机隐藏 RGB | 3/0 | 3/0 → 3/0 | 1 → 1 | 3→3 | 551→551 |
| 锯齿边界及独立微点 | 12/0 | 1/0 → 12/0 | .99032 → .99254 | 1→2 | 259→451 |
| 单像素孔洞 | 1/1 | 1/0 → 1/1 | .99983 → 1 | 1→1 | 261→201 |

color/medium 本次单次运行耗时约 34–39ms，旧版约 29–57ms；详见 metrics.json。这些小图和单次耗时不能支持性能提升结论。最终版本一次 1000×1000 单色圆探针约 5.2 秒，仅用于上限内运行检查，未做多色/噪声极端性能标定；见 `storage/validation/c/final-probes.json`。

相邻近色样例仍归为两色 `#2040B0/#B02030`，可见重叠区 RGB 平均绝对误差 0.5/255，前后相同；没有声称改善色差。半透明样例二值化外观差异是既有合同。圆和锯齿的大轮廓误差仍存在，细节档位不保证完全像素保真。

## 验证证据

| 检查 | 结果与边界 |
| --- | --- |
| C 新增回归 | 17 项通过；黑白三档单像素结构、三档单像素孔洞、隐藏 RGB/127/128 边界、2/4/8/16 色板、换色几何不变、输出上限、空前景 |
| HTTP/存储集成 | 新增测试实际运行本地任务，重复使用同一 PNG 产生不同 SVG；旧字节不变、父资产/坐标/P0 字段不丢；预览/下载同字节；换色和 ZIP 文件/祖先/清单匹配；provider MockTransport 为禁止调用断言，调用数为零 |
| A 流程集成 | 既有模拟归档云端层→合成/矢量化→失败恢复/局部重跑继续通过；增加合成 SVG 和重跑 SVG 版本及来源断言。模拟云端不计为真实实验 |
| 全 Python 回归 | 61 项通过（44 基线 + 17 新增）；一个既有 Starlette/httpx 弃用提示 |
| 前端模块 | 8 项通过；未改前端生产代码 |
| 独立栅格比较 | 7×2模式×3档=42 个新输出，组件及孔洞匹配输入，IoU≥.98；旧版42个结果同样保留。这是开发样例门槛，不是共同真实验收门槛 |
| 人工视觉检查 | 已查看原图/旧结果/新结果三列比较图；大轮廓仍有平滑误差 |
| Edge 交互验证 | 尝试失败：先修复旧 upload 解包夹具，随后浏览器子进程退出码21；另一次直接启动无 DevTools 信号超时。不能宣称当前页面交互验证通过 |
| 矢量编辑器 | 未验证；未发现 Inkscape 可执行文件。真实路径与换色几何已由 XML/服务验证，但没有在编辑器中执行选路径、改节点 |
| Git 检查 | diff 空白检查通过；提交与推送按后续用户授权在上述固定分支/PR 进行，不合并；产物及临时验证依赖均位于忽略的 storage/ |

## 复现

在项目根目录执行（项目已可编辑安装）：

```powershell
$py = 'G:/CondaEnvs/pattern-studio/python.exe'
& $py -B -m pytest -q
node frontend/tests/settings.test.mjs
& $py -B scripts/validate_c_vector.py before --baseline-ref 5a8072cb28da6bcad60e8c3d0186fb44cf4a042c
& $py -B scripts/validate_c_vector.py after
# 仅独立验收工具需要；安装到忽略目录，不改变项目环境/依赖合同。
& $py -m pip install --target storage/validation/c/tools resvg-py==0.5.0
& $py -B scripts/compare_c_vector.py
git diff --check
```

baseline-ref 只读取并运行指定可信 Git 版本中的 adapter，不 checkout、不覆盖源码。比较工具断言新结果的组件/孔洞/IoU 并输出 `storage/validation/c/comparison.json`、`comparison.txt`、`comparison.png`；图中每行左为输入、中为旧 SVG、右为新 SVG。各轮目录内 `metrics.json` 保存有效参数/色板/耗时，`render-metrics.json` 保存栅格测量。`pytest.txt`、`frontend-tests.txt` 保存本轮结果。baseline 的源码快照也保存在 before/vector-source.py，方便审计。重新执行同名 label 会更新这些开发证据文件；生产资产不受影响。

## 限制与 A/B 协调事项

- 本轮未做真实素材、真实云端调用、共同30图验收或编辑器人工验收；不能据此宣布 C 最终质量验收完成。需要 A/B 提供有许可台账的 PNG，协商质量门槛和编辑器后再做固定集验收。
- 精确路径保留所有小结构，也保留小噪声。带单像素孔洞的大组件可能产生较多矩形子路径；其轮廓呈像素阶梯。复杂噪声图可能触及 SVG 字节限制，此时明确失败，不自动降质或删有效结构。矩形子路径在编辑器中的便利性待验证。
- 更大的孔洞、细曲线、密集多色边界仍由 VTracer 处理，七图不能证明任意拓扑均保真。渐变及细微颜色关系仍可能量化合并。
- B 继续交付完整画布透明 PNG及来源父关系，无需更改 alpha 合同；蒙版修改复用云端结果。若 B 的上游 PNG 已丢结构，C 无法恢复。
- A 合入时重点审查 SVG 发布的 P0 继承、合成输出的版本覆盖及换色版本字段。共享文件改动仅以上列矢量输出区域为范围；未并发修改前端。需由非作者完成关键差异审查后再按当次 Git 授权集成。
- 本轮独立开发与证据交接到此停止，不接管 A/B 工作包、不新增训练/供应商/通用工作流设施。

# A 部分接口与协作边界

本文件描述本次实现的接口。B 负责选择策略及提示词实测，C 负责矢量算法；A 保持现有算法并提供可恢复的执行基础。

## 设置

- `GET /api/v1/settings`：仅返回非敏感字段、`api_key_configured`、`revision` 和 `blockers`。
- `PUT /api/v1/settings`：需 `X-Pattern-Studio: local`；JSON 含当前 `revision`，以及待修改字段。
- 字段：`model`、`base_url`、`paid_calls_enabled`、`pricing_confirmed`。旧客户端的 `budget_cents`、`reservation_cents`、`max_calls` 仍可提交以兼容，但不再作为调用门槛。
- `model` 只接受方舟文档中的 Model ID（`doubao-seedream-5-0-pro/flash-*`、`doubao-seedream-5-5-*`）或 `ep-*` 接入点；`base_url` 只接受北京区 `/api/v3` 根地址或其 `/images/generations` 完整地址，保存时归一化为根地址。
- 密钥字段：`api_key_action` 为 `keep`（默认）、`replace` 或 `clear`；仅 `replace` 携带 `api_key`。不回显密钥。
- 成功返回完整非敏感状态；409 表示修订冲突，422 表示验证失败。422 的 `message` 指明被拒字段（型号、端点或密钥），客户端据此给出中文提示。保存不发起云端请求。
- 服务端私有设置保存在被 Git 忽略的 `storage/settings.json`，原子保存；优先于进程环境与 `.env`。不修改 `.env`。Windows 保存时将密钥以当前用户 DPAPI 加密写入 `api_key_protected`，不再写入明文 `api_key`；其他平台沿用权限为 0600 的私有文件。旧明文配置仍可读取，下次主动保存时迁移。DPAPI 解密失败直接报错，不回退环境密钥；复制到另一账户/设备不保证可解密。
- 公开设置新增 `api_key_storage`：`windows_dpapi`、`private_file` 或 `not_saved`，表示实际持久化形式；不返回密文。只有环境密钥时显示未保存，点击保存后才写入私有设置；保存和重启恢复不代表密钥已通过服务商验证。
- `RuntimeSettings.current()` 返回不可变设置，`.public()` 返回无密钥状态，`.update(SettingsUpdate)` 原子保存并发布新修订；`.secrets()` 供当前进程拒绝将新旧密钥写入备注或请求标识。异常 `RuntimeSettingsConflict` 对应 409，其余 `ConfigurationError` 对应 422。
- 保存后新任务使用新设置；已经执行中的云端请求保持启动时配置。关闭付费会阻止尚未开始的云端请求；预算、单次预留与调用次数不再是门槛，实际费用以服务商账单为准。任务模型、端点、提示词在提交时形成无密钥快照。

## 工作流与恢复

- 保留 `POST /api/v1/pipelines/ai` 和 `POST /api/v1/pipelines/{id}/continue`。
- AI 提交新增可选 `prompt_version`（默认既有版本），`selection_policy` 默认 `auto_or_confirm`；没有经验证的选层规则时进入人工确认。
- `GET /api/v1/pipelines/{id}` 增加 `workflow`（标识/版本/快照）、`recovery`、`branches`；不移除既有字段。
- `POST /api/v1/pipelines/{id}/rerun`：需写标记和随机 `Idempotency-Key`，创建保留旧结果的新本地任务，不发起云端调用。
- `action: compose`：`revision`、`layer_ids`、可选 `vector`；复用已归档云端图层重新合成。
- `action: vectorize`：`revision`、`input_asset_id`、`vector`；输入必须是本流程产生的 PNG（含蒙版修正的后代）。
- 局部重跑返回标准 job，可继续使用既有任务轮询和预览/应用机制。`branches` 保留重跑任务与父关系。
- 分支任务和历史记录包含 `ai_pipeline_id`、`parent_job_id`、`workflow_action`；刷新后通过任务记录也能恢复原流程。原流程状态保留，分支分别展示自己的状态，不覆盖原成功或失败记录。
- 调整提示词、模型或云端输入需创建新 AI 流程，继续要求上传/付费确认。超时与未知结果不自动重试。
- 云端输出不加水印（`watermark: false`）。编辑/修复请求按输入尺寸请求显式 `WxH`；输入低于方舟最小输出像素时，按原比例取最近的合法尺寸，再在本地缩回输入尺寸，并在资产记录 `requested_size` 与 `geometry_transform`。局部合成仍要求候选与输入同尺寸，不做隐式拉伸。
- 云端合成后的矢量化：`color` 模式工作副本不超过 250,000 像素，超出时发布 `working_copy` 并记录 `transform`，SVG 的 `source_asset_id` 指向该副本；`monochrome` 模式仍以 1,000,000 像素为上限。

## 素材库与平铺观察

平铺单元可选已保存的裁切图、透明 PNG、线稿 PNG 或已接受的修复图。每个生成结果独立保存接缝观察。

- `GET /api/v1/assets` 按登记顺序从新到旧返回 `items` 和 `next_cursor`。`limit` 默认 20，最大 50。`q` 在整个素材库匹配登记名称、资产 ID、类型和评级，可重复传 `kind` 匹配本地化类型名。结果包含上传和历史任务保存的预览，使用 `generated_by_job_id`、`repair_job_id` 或 `provider_call_id` 标记来源。旧记录无法区分预览是否曾被应用。
- `PUT /api/v1/assets/{asset_id}/seam-observation` 接收 `seam_observation` 和 `revision`，返回更新后的平铺资产元数据。旧结果没有 `seam_observation_revision` 时用 0。修订冲突返回 409，客户端可重新读取资产。更新同步历史任务成果和之后生成的 ZIP 清单，平铺图像及已导出的文件保留原版本。

## 按图恢复历史

- `GET /api/v1/images/{image_id}/history`：只读分页查询，不提交任务、不推进流程、不重试或核销云端调用。
- `collection` 为 `assets`（默认）、`jobs` 或 `flows`；`limit` 默认 50，范围 1..50；`cursor` 使用上页的 `next_cursor`，与现有历史分页格式一致。
- 响应为 `items`、`next_cursor`，按登记顺序从新到旧。客户端须分别读完三类分页；一次读取不是跨页原子快照，任务继续运行时应在终态后刷新。
- 资产返回完整元数据；任务保留失败/取消的部分产物及 `ai_pipeline_id`、分支父关系；流程返回既有 `get_ai_flow` 结构及恢复信息。
- 归属按原图资产、复制的 `image_id`、登记的父子关系及旧 `source_asset_id` 来源链查询，不按内容哈希合并重复上传。缺少所有来源信息的孤立旧资产无法可靠归属，不猜测其原图。
- 图片不存在返回 404；非法集合、数量或游标返回 422。此接口未新增秘密、私有配置或独立资产存储。
- 新版前端消费、活动任务状态轮询、选层续接及局部重跑尚未在本批后端交付中完成；不得据接口存在宣称页面已恢复完整历史。

## 本机模型能力

`GET /api/v1/health` 新增 `capabilities.lineart_model`，保留已有健康字段和状态码语义。

- `available`：仅表示当前服务 Python 环境可发现模型依赖，模型文件和推理配置通过轻量前置检查。
- `checked`：固定为 `prerequisites_only`；不导入 torch、不初始化 CUDA、不加载或校验整个权重，也不发起推理或云端调用。
- `reason`：可用时为 `null`；不可用时为 `dependencies_missing`、`model_files_missing`、`model_config_invalid` 或 `model_check_failed`。不返回本机路径、异常详情或凭据。
- Git LFS 占位文件不视为已安装模型。真实任务仍执行原有权重完整性检查，并可能报告推理或资源错误。
- 模型不可用不使其他本地工具的健康状态降级。旧后端没有此字段时，客户端应按能力未知处理，不能断言缺少 torch。
- 能力取决于启动服务的 Python 环境；换用另一个浏览器或刷新页面不会改变后端依赖。应按 README 复用项目 Python 3.11 环境。

## 本地一键处理

- `POST /api/v1/pipelines` 使用现有本地写标记和 `Idempotency-Key`。请求携带 `input_asset_id` 和可选的 `vector`、`working_max_pixels`。
- 兼容旧客户端的 `recipe: "model_lineart"` 路线直接处理输入或显式工作副本，拒绝 `extract` 和 `enhance` 字段，并将 SVG 模式设为黑白。任务依次发布 `lineart` PNG 和 SVG。SVG 的矢量输入指向该 PNG。新版工序将提取与矢量化分开，使用 `POST /jobs/lineart` 和 `POST /jobs/vectorize`，给中间人工检查和蒙版修正留出位置。
- 线稿资产记录模型版本、权重标识和实际推理设备。矢量化失败时，任务历史和纹样库仍可查阅已发布的线稿 PNG。
- API 省略 `recipe` 或显式选择 `"color"` 时，沿用前景提取、可选轻增强及矢量化的旧请求语义。

## 云端候选后的线稿

- 选层合成的 `contour_line_art` 是选中层前景掩膜的外轮廓（OpenCV `findContours`），不是生成式线稿；拆分提示词只影响候选层内容，不能让它补出掩膜内部的线条。
- 需要内部细节时，对 `composed_candidate` 再提交 `recipe: "model_lineart"`；`working_max_pixels` 可在超过本地处理上限时生成显式工作副本，并记录 `transform`。这条路线不新增云端调用。
- 前端把 `contour_line_art` 显示为「外轮廓线稿」，候选合成后提供「生成完整线稿」入口，避免把外轮廓误认为完整线稿。

## 云端线稿与处理顺序（2026-11-13）

- `POST /api/v1/jobs/cloud-lineart`：使用现有本地写标记与随机幂等键，JSON 为 `input_asset_id`、严格布尔 `consent_to_upload: true`、`consent_to_charge: true`；返回 202 标准任务。不传本地模型参数，不创建拆分图层，不自动矢量化。
- 固定新增提示词 `lineart-seedream-v1`，与拆分/修复提示词分开；模型、端点、提示词形成提交时快照，密钥通过 worker 私有 stdin 管道传递。执行前仍检查当前付费开关；超时/未知结果保留调用记录，普通任务重试和取消不会重新生成或掩盖可能的费用。
- 产物为既有 `lineart` PNG，记录 `method: cloud`、`provider_call_id`、`prompt_version`、模型和原输入 `source_asset_id`；`ai_inferred: true`、`needs_user_review: true`、`geometry_verified: false`。输出按原比例请求；合法比例的缩回记录 `geometry_transform`，不承诺几何保真。核对后可交给现有本地矢量化。
- 云端白底黑线结果经 `cloud-lineart-luminance-alpha-v1` 将反相亮度乘以原透明度，转成透明底黑线，与本地线稿的 alpha 契约一致；保留抗锯齿，不重新检测边缘。资产适配器版本 `seedream-lineart-v2-transparent`，参数记录转换策略。否则黑白矢量化会把不透明白底误当整幅前景。
- 云端线稿、拆分与修复接受 `normalized_input`、`cropped`、`working_copy`、`prepared`、`enhanced`、`accepted_repair`、`composed_candidate`、`transparent_png`。不自动换回规范原图，不接受未接受的修复候选。新调用输入仍须满足 262,144..25,000,000 像素和 1/16..16 比例，修复另保留 1,048,576 像素上限；小图不会悄悄放大上传。
- 新版工序按「来源 → 裁切 → 可选修复 → 可选候选拆分 → 提取（本地/云端/OpenCV/颜色）→ 必要蒙版修正 → 矢量化 → 平铺/导出」组织。完整纹样可跳过修复，不发起调用；接受修复后使用接受资产，蒙版修改后应重新矢量化。
- 新增云端提示词完成模拟链路及单张现有祥云纹样的真实调用验证（用户授权合理调用测试）：局部修复一次、线稿一次，随后本地生成 SVG；无自动重试。验证记录在 `storage/validation/cloud-lineart-20261113/report.json`（私有、Git 忽略）。这不是固定样本集的全面保真验收；其他真实实验仍按当次授权执行。

## B/C 接入

选层策略通过 `app.services.workflow.select_candidate_layers` 接入。默认返回需要人工确认及原因；B 可实现确定性的选择规则并给出所选 layer IDs、策略版本与理由，A 不以图层数量代替判断。

提示词放入 `app.providers.prompts` 版本表。每次运行记录实际文本及版本；尚未实测的模板不替代当前默认。

PNG 与 SVG 沿用既有资产、坐标系和来源字段。局部重跑只保存引用及参数，不复制资产存储系统。A 的模拟云端集成测试用于验证流程与费用边界，不代表图像质量已通过验收。

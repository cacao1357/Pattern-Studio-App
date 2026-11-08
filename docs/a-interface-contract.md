# A 部分接口与协作边界

本文件描述本次实现的接口。B 负责选择策略及提示词实测，C 负责矢量算法；A 保持现有算法并提供可恢复的执行基础。

## 设置

- `GET /api/v1/settings`：仅返回非敏感字段、`api_key_configured`、`revision` 和 `blockers`。
- `PUT /api/v1/settings`：需 `X-Pattern-Studio: local`；JSON 含当前 `revision`，以及待修改字段。
- 字段：`model`、`base_url`、`paid_calls_enabled`、`pricing_confirmed`、`budget_cents`、`reservation_cents`、`max_calls`。
- 密钥字段：`api_key_action` 为 `keep`（默认）、`replace` 或 `clear`；仅 `replace` 携带 `api_key`。不回显密钥。
- 成功返回完整非敏感状态；409 表示修订冲突，422 表示验证失败。保存不发起云端请求。
- 服务端私有设置保存在被 Git 忽略的 `storage/settings.json`，原子保存；优先于进程环境与 `.env`。不修改 `.env`。
- `RuntimeSettings.current()` 返回不可变设置，`.public()` 返回无密钥状态，`.update(SettingsUpdate)` 原子保存并发布新修订；`.secrets()` 供当前进程拒绝将新旧密钥写入备注或请求标识。异常 `RuntimeSettingsConflict` 对应 409，其余 `ConfigurationError` 对应 422。
- 保存后新任务使用新设置；已经执行中的云端请求保持启动时配置。关闭付费会阻止尚未开始的云端请求。任务模型、端点、提示词在提交时形成无密钥快照。

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

## 素材库与平铺观察

平铺单元可选已保存的裁切图、透明 PNG、线稿 PNG 或已接受的修复图。每个生成结果独立保存接缝观察。

- `GET /api/v1/assets` 按登记顺序从新到旧返回 `items` 和 `next_cursor`。`limit` 默认 20，最大 50。`q` 在整个素材库匹配登记名称、资产 ID、类型和评级，可重复传 `kind` 匹配本地化类型名。结果包含上传和历史任务保存的预览，使用 `generated_by_job_id`、`repair_job_id` 或 `provider_call_id` 标记来源。旧记录无法区分预览是否曾被应用。
- `PUT /api/v1/assets/{asset_id}/seam-observation` 接收 `seam_observation` 和 `revision`，返回更新后的平铺资产元数据。旧结果没有 `seam_observation_revision` 时用 0。修订冲突返回 409，客户端可重新读取资产。更新同步历史任务成果和之后生成的 ZIP 清单，平铺图像及已导出的文件保留原版本。

## 本地一键处理

- `POST /api/v1/pipelines` 使用现有本地写标记和 `Idempotency-Key`。请求携带 `input_asset_id` 和可选的 `vector`、`working_max_pixels`。
- 工作台默认发送 `recipe: "model_lineart"`。模型路线直接处理输入或显式工作副本，拒绝 `extract` 和 `enhance` 字段，并将 SVG 模式设为黑白。任务依次发布 `lineart` PNG 和 SVG。SVG 的矢量输入指向该 PNG。
- 线稿资产记录模型版本、权重标识和实际推理设备。矢量化失败时，任务历史和纹样库仍可查阅已发布的线稿 PNG。
- API 省略 `recipe` 或显式选择 `"color"` 时，沿用前景提取、可选轻增强及矢量化的旧请求语义。

## B/C 接入

选层策略通过 `app.services.workflow.select_candidate_layers` 接入。默认返回需要人工确认及原因；B 可实现确定性的选择规则并给出所选 layer IDs、策略版本与理由，A 不以图层数量代替判断。

提示词放入 `app.providers.prompts` 版本表。每次运行记录实际文本及版本；尚未实测的模板不替代当前默认。

PNG 与 SVG 沿用既有资产、坐标系和来源字段。局部重跑只保存引用及参数，不复制资产存储系统。A 的模拟云端集成测试用于验证流程与费用边界，不代表图像质量已通过验收。

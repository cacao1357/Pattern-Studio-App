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

## B/C 接入

选层策略通过 `app.services.workflow.select_candidate_layers` 接入。默认返回需要人工确认及原因；B 可实现确定性的选择规则并给出所选 layer IDs、策略版本与理由，A 不以图层数量代替判断。

提示词放入 `app.providers.prompts` 版本表。每次运行记录实际文本及版本；尚未实测的模板不替代当前默认。

PNG 与 SVG 沿用既有资产、坐标系和来源字段。局部重跑只保存引用及参数，不复制资产存储系统。A 的模拟云端集成测试用于验证流程与费用边界，不代表图像质量已通过验收。

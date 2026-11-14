# 批量工作台与纹样分类接口

本文定义新版工作台将使用的批量素材、手动分类、流程预设和批次接口。纹样分组沿用已有 `images`、`assets`、来源关系和 `image_id`，不创建第二份素材存储。

## 纹样分页

`GET /api/v1/patterns?limit=20&cursor=&q=&kind=&category_id=`

- `limit` 为 1..50，默认 20；`cursor` 只能使用前页返回的 `next_cursor`。
- `q` 在组内任一版本的登记名、来源名、类型和资产 ID 中匹配。`kind` 精确匹配某个资产类型。筛选只决定哪些原图组入选，返回时仍包含组内所有版本，便于对照原图和处理结果。
- `category_id` 限定为该手动分类中的原图组；不传表示全部。类型筛选、搜索和分类可组合。
- 筛选后按原图登记顺序从新到旧分页，游标表示最后返回的原图组。后端必须先确定哪些**组**匹配，再分页，不能先分页资产后临时分组。
- 响应：`{ "items": [...], "next_cursor": string | null }`。
- 每个组：`image_id`、`original_asset_id`、`normalized_asset_id`、`name`、`created_at`、`assets`、`categories`、`category_ids`、`revision`。`assets` 包含原图、规范输入以及现有按图来源/父子关系找到的所有衍生资产元数据；`categories` 项为 `{category_id,name,revision}`；`revision` 是该组分类集合修订号，初值 0。
- 缺少来源链且没有 `image_id` 的孤立旧资产不会被猜测归属。此接口只列出已登记的 `images` 原图组。

`GET /api/v1/patterns/{image_id}` 返回同一组结构。不存在时 404。

## 手动分类

`GET /api/v1/pattern-categories` 返回 `{ "items": [{"category_id", "name", "revision"}] }`，按名称稳定排序。

`POST /api/v1/pattern-categories` JSON：`{"name":"祥云"}`，成功 201。名称去首尾空格、Unicode NFKC 规范化，1..60 个字符；大小写折叠后不允许重名。最多 200 个分类。响应为 `{category_id,name,revision:1}`。

`PUT /api/v1/pattern-categories/{category_id}` JSON：`{"name":"传统纹样","revision":1}`。修订匹配时重命名并将分类 `revision` 加一；过期修订返回 409 `STALE_REVISION`，重名返回 409 `CATEGORY_EXISTS`。

`DELETE /api/v1/pattern-categories/{category_id}?revision=1` 需要当前修订号。成功返回 `{category_id,deleted:true}`。删除只解除该分类的成员关联，不删除原图或其任何版本。修订过期返回 409。

`PUT /api/v1/patterns/{image_id}/categories` JSON：`{"category_ids":["..."],"revision":0}`。这是该组全部分类的替换操作，允许空列表；不同分类可同时包含同一原图组。成功返回 `{image_id,category_ids,revision}`，修订号递增。重复分类 ID、未知分类或过期修订分别返回 422、404、409。保存时用 SQLite 事务与修订比较避免并发覆盖。

所有写请求沿用本机边界要求的 `X-Pattern-Studio: local`；不接收文件、不上传、不调用云端。

## 批量导出

继续使用 `POST /api/v1/exports`，请求含显式 `asset_ids`（1..500 个不同资产）、`license_acknowledged` 和可选 `layout`。`layout: "flat"` 为兼容默认；`layout: "by_image"` 在 ZIP 中按 `images/{image_id}/{kind}-{asset_id}.{原后缀}` 分目录。不猜测孤立旧资产的原图归属，独立放入对应 `unlinked` 目录。`manifest.json` 中的 `archive_name` 对应实际文件名并保留来源链。

只打包所选的现有原始文件、PNG 或 SVG，不自动生成缺失格式，不加入未选择的祖先文件，不嵌套 ZIP。总输入上限仍为 128 MiB；来源许可未确认时仍需明确确认。前端“全选”必须标明作用于当前已载入的纹样，按处理类型及整组选择均转成显式资产列表。

## 流程预设

预设固定依次执行可选裁切门、可选修复门、可选候选合成门、图像提取、（线稿路线可选的蒙版准备）、可选蒙版修正门、可选矢量化和可选平铺。四个“门”暂停当前图片，要求在工作台完成该步骤后选取新生成的版本续接；候选层是否应选择、修复框/参考图和蒙版编辑均保留现有工作台决策，不由批处理猜测。待确认图片暂停时，同批其他图片继续处理。

`GET /api/v1/workflow-presets` 返回 `{items:[...]}`。每项含 `preset_id`、`name`、`options`、`revision`、`builtin`、`created_at`、`updated_at`。服务首次初始化时播种三个可复制的内置预设：本地模型线稿转 SVG、云端线稿转 SVG、颜色提取转 SVG。内置 UUID 稳定，重复启动不重置用户修改。

`options` 的严格字段为：

- `recipe`: `model_lineart`、`cloud_lineart` 或 `color`。
- `extract`: 现有 `ExtractOptions`（颜色提取参数）。
- `vector`: 现有 `VectorOptions`。
- `working_max_pixels`: 可选 10,000..25,000,000；设置后在自动提取前显式创建工作副本。实际取用户设置与所有开启环节的较低上限，并记录在该步骤中；低于所选上限时跳过副本。模型线稿可到 25 MP、Otsu 到 4 MP；同时开启蒙版、矢量或平铺时还需满足对应限制。未设置时不会缩放，大图按相应服务像素限制失败。
- `crop`、`repair`、`candidates`、`mask`、`vectorize`、`tile`: 布尔值。默认关闭人工门，默认开启矢量化；可同时关闭矢量化与平铺，仅保留提取的 PNG。

初始内置预设的 `extract` 使用现有默认值；本地/云端线稿使用黑白矢量化；颜色提取使用颜色矢量化。预设默认不缩放大图；用户可显式设定工作副本像素上限，系统会在配置的步骤中生成并记录副本。每一步通过现有作业队列执行并保存产物，超过既有像素上限时该图片明确失败。

各路线的实测上限与未验证范围见[本地处理上限](local-processing-limits.md)。SVG 维持原有限制，不提供高分辨率试验档。

`POST /api/v1/workflow-presets` JSON 为 `{"name":"...","options":{...}}`，成功返回预设对象。`PUT /api/v1/workflow-presets/{preset_id}` 使用相同字段并附 `revision`，成功后修订加一；旧修订返回 409。`DELETE /api/v1/workflow-presets/{preset_id}?revision=...` 删除用户预设，不能删除内置预设。修改或删除预设不会改动已提交批次的配置快照。

## 持久批次

`POST /api/v1/processing-batches` JSON：

```json
{
  "preset_id": "...",
  "input_asset_ids": ["..."],
  "consent_to_upload": false,
  "consent_to_charge": false
}
```

必须提供随机 `Idempotency-Key`；重复键及相同请求恢复既有批次，不创建重复作业。每批选择 1..100 个已登记纹样所属的处理资产，不接受跨图片产物。云端线稿预设要求本次请求的两个同意字段都显式为 `true`；批次快照记录待上传图片数与预计调用数（每图一次）。本地预设不产生云端调用。

返回 202 的批次含 `batch_id`、`preset_id`、预设配置快照 `snapshot`、`revision`、`state`、`items`、`progress` 及时间戳。快照含 `planned_provider_calls`、`images_uploaded_to_provider` 和逐批次同意。每项含 `item_id`、`image_id`、`input_asset_id`、`current_asset_id`、`steps`、`cursor`、`state`、`job_id`、`results`、`waiting_for` 和错误码。步骤的人工等待/失败/成功以单图状态显示，其他图片继续。网络或进程中断后的云端结果不自动重新发起；已有 job 与幂等键保留用于状态核对。

对可继续的人工门，`POST /api/v1/processing-batches/{batch_id}/items/{item_id}/resume` JSON 为 `{"revision":1,"input_asset_id":"..."}`。输入必须具有相同 `image_id`、是该人工步骤要求的类型，并且从该图片当前版本派生：裁切要求 `cropped`，修复要求已接受的 `accepted_repair`，候选要求 `composed_candidate`，蒙版修正要求 `transparent_png`。颜色提取已产生蒙版和透明 PNG，线稿路线会先执行 `prepare_mask`，以 alpha 提取方式发布配对的 `foreground_mask` 与 `transparent_png`，保留原透明像素，再开放人工蒙版步骤。成功后当前步骤完成并继续队列。跨图、旧分支和错误种类返回 422。过期批次修订返回 409。

`POST /api/v1/processing-batches/{batch_id}/cancel` JSON：`{"revision":1}`。等待确认的图片及未启动任务可取消；已启动云端作业不能撤回，取消请求会停止该图片后续步骤，并在作业终态后保留其结果和调用状态。其它可安全停止的图片继续取消。过期修订返回 409。

`GET /api/v1/processing-batches?limit=20&cursor=` 分页列批次，`limit` 为 1..100；`GET /api/v1/processing-batches/{batch_id}` 返回完整进度。进度在服务端持久保存，由后台协调循环推进，不依赖进度浮窗保持打开。批次最多选择 100 个输入，底层现有作业队列仍最多同时容纳 20 个 queued/running 作业；队列满时批次保留当前步骤为 queued，协调循环停止本轮后续提交，空位出现后继续，不会把合法批量误记为失败。批次只保存对既有输入资产和 local job 的引用，不新建另一套图片/任务资产库。

# 纹样工作台 · 新版前端

这是本机工作台的正式前端，由 `backend/app/api/frontend.py` 挂载在
**http://127.0.0.1:8765/**；旧前端原文件保留在 `frontend/` 根目录，同一服务下通过
**http://127.0.0.1:8765/legacy/** 只读对照。接入架构、接口映射与回退方式见
[docs/guides/frontend-integration.md](../../docs/guides/frontend-integration.md)。

本目录于 2026-11-11 作为接入提交合并到 `main`。`frontend/next/` 与
`frontend/next-v2-backup-20261110/` 是仅保留在本机的旧版草稿，已写入 `.gitignore`，
不属于仓库内容。

## 运行

在仓库根目录用项目虚拟环境启动（见根目录 README）：

```powershell
.\.venv\Scripts\python.exe -B scripts/serve_api.py
```

浏览器打开 **http://127.0.0.1:8765/**。页面没有构建步骤：改完静态文件刷新即可；
静态资源由后端带 `Cache-Control: no-store` 返回。

## 前端结构

| 文件 | 职责 |
| --- | --- |
| `js/app.js` | 外壳：hash 路由、视图挂载、状态条、提示、抽屉、命令面板、上传入口、快捷键 |
| `js/api.js` | `/api/v1` 客户端：统一中文错误、幂等键、写标记、任务轮询 |
| `js/store.js` | 服务端数据：健康、设置、云端状态、数据集、最近纹样/任务、工作会话、纹样库 |
| `js/format.js` | 后端枚举 → 中文、时间/尺寸/字节格式化、HTML 转义 |
| `js/motion.js` | 动效工具箱（reveal / magnetic / spotlight / counter / parallax / line-draw） |
| `js/motifs.js` | 程序化生成的装饰纹样（纯 SVG） |
| `js/icons.js` | 图标集合（`<symbol>` 注入） |
| `js/data.js` | 静态工序定义（编号、名称、标题、说明） |
| `js/samples.js` | 八道工序的样例图（`assets/demo` 里的缠枝莲团花，首页与导览共用） |
| `js/views/*.js` | 首页 / 工作台 / 任务 / 纹样库 / 设置 / 使用说明 |

视图契约：

```js
export default {
  id: "home",
  title: "首页",
  flush: false,                          // true：视图自行管理滚动（工作台）
  render(state, api, params) { return "<div>…</div>"; },
  mount(root, state, api, params) {},    // 绑定事件、触发数据加载
  unmount() {},                          // 离开时清理订阅与全局监听
};
```

视图的异步数据由视图自己在 `mount` 里订阅 `store` 并调用 `api.refresh()` 更新；
`api.patch(partial)` 改变外壳状态并重绘当前视图。

## 页面与快捷键

| 路由 | 页面 |
| --- | --- |
| `#/home` | 首页：最近成果、接着上次、八道工序（配样例图、高亮跟随真实进度）、云端与本机流程 |
| `#/workbench?image=<id>&asset=<id>&stage=<1-8>&v=2` | 工作台：来源、裁切、可选修复、候选、提取、蒙版、矢量化、平铺/导出；独立左侧纹样列与自适应工序行高，无 v 参数的旧链接按旧编号兼容 |
| `#/tasks?job=<id>` | 任务：本机任务索引与详情；失败可重试、运行中可取消，可跳回工作台 |
| `#/library?open=<assetId>` | 纹样库：真实纹样分页、筛选、档案抽屉 |
| `#/settings` | 设置：云端 API Key、本机状态与版本 |
| `#/notes` | 使用说明：工序、快捷键、数据边界、故障排查 |

快捷键：`1`–`8` 切工序、`[` / `]` 在会话纹样间切换、`C` 开关对比、
`Ctrl/⌘ + K` 命令面板、`Esc` 关闭弹层。深链还支持 `?compare=1`、`?tile=2x2|3x3`、`?tour=1`。
上传完成后若本机已有高度相似纹样，会先打开“发现近似版本”抽屉：可直接改用已有版本，或保留新上传继续。

## 界面查看

启动服务后打开当前工作台。2026-11-11 的视觉评审截图可从 Git 历史中的 `9dc0613:frontend/next-v2/review/` 查阅。

## 设计

视觉依据见 [DESIGN.md](DESIGN.md)：配色为「蜜蜡 · 沉褐」——焦褐底暗房 + 放旧的绢样张 + 陈年琥珀，
琥珀只给主操作、当前工序、A 级与焦点环，错误另用砖红；所有纹样都放在纸本图版上；
动效只服务进入、对比、确认，并受 `prefers-reduced-motion` 关闭。
中文界面、可见文字最小 12px、正文 14px。

配色令牌集中在 `css/tokens.css`（全部颜色来自令牌，视图样式里不写死色号）；
改完令牌在仓库根目录跑 `python scripts/check_contrast.py` 复核 WCAG 对比度。
配色过程与参数见 [docs/guides/palette-review.md](../../docs/guides/palette-review.md)。

## 数据与边界

- 真实数据来自 `/api/v1`，图片、任务、纹样与 SQLite 历史保存在本机 `storage/api/`。
- 当前操作会话在内存里。浏览器本地存储仅记录上次打开的工作台位置，供恢复纹样、版本和工序；工作台选入列表保存在服务端。
- 云端候选与局部修复需要配置密钥并打开设置里的「允许云端计费调用」；未配置时界面显示原因，本地流程照常可用。
- 旧前端（`frontend/index.html` 等）连接同一份本机数据；旧版入口与正式界面共用云端计费开关，改动会写入同一配置。

## 已知限制

- 没有构建步骤、没有第三方依赖；只在 Chrome 验证过，Safari / Firefox 与完整屏幕阅读器走查未做。
- 颜色用 `color-mix()` 派生明暗与透明层，需要 Chrome 111+ / Safari 16.2+ / Firefox 113+；更旧的浏览器会丢这些半透明层。
- 「本地线稿模型」依赖本机 torch、分割模型库与 `model/` 权重；缺少时请用 OpenCV 线稿或颜色提取。
- 大图在矢量化阶段可能触及 worker 内存上限，先创建工作副本更稳。
- 字体依赖本机 `Noto Serif SC` / `Noto Sans SC` / `Bahnschrift` / `Cascadia Code`，缺失时观感会变。

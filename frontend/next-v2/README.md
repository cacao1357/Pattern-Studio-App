# 纹样工作台 · 新版前端

这是本机工作台的正式前端，由 `backend/app/api/frontend.py` 挂载在
**http://127.0.0.1:8765/**；旧前端原文件保留在 `frontend/` 根目录，同一服务下通过
**http://127.0.0.1:8765/legacy/** 只读对照。接入架构、接口映射与回退方式见
[docs/frontend-integration.md](../../docs/frontend-integration.md)。

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
| `js/store.js` | 服务端数据：健康、设置、云端状态、数据集、最近资产/任务、工作会话、纹样库 |
| `js/format.js` | 后端枚举 → 中文、时间/尺寸/字节格式化、HTML 转义 |
| `js/motion.js` | 动效工具箱（reveal / magnetic / spotlight / counter / parallax / line-draw） |
| `js/motifs.js` | 程序化生成的装饰纹样（纯 SVG） |
| `js/icons.js` | 图标集合（`<symbol>` 注入） |
| `js/data.js` | 静态工序定义（编号、名称、标题、说明） |
| `js/samples.js` | 八道工序的样例图（`assets/demo` 里的缠枝莲团花，首页与导览共用） |
| `js/views/*.js` | 首页 / 工作台 / 纹样库 / 设置 / 使用说明 |

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
| `#/workbench?image=<id>&asset=<id>&stage=<1-8>&v=2` | 工作台：来源、裁切、可选修复、候选、提取、蒙版、矢量化、平铺/导出；无 v 参数的旧链接按旧编号兼容 |
| `#/library?open=<assetId>` | 纹样库：真实资产分页、筛选、档案抽屉 |
| `#/settings` | 设置：云端 API Key、本机状态与版本 |
| `#/notes` | 使用说明：工序、快捷键、数据边界、故障排查 |

快捷键：`1`–`8` 切工序、`[` / `]` 在会话资产间切换、`C` 开关对比、
`Ctrl/⌘ + K` 命令面板、`Esc` 关闭弹层。深链还支持 `?compare=1`、`?tile=2x2|3x3`、`?tour=1`。

## 截图

`review/` 是接入真实后端后的页面截图（1440×900 与 390 宽视口，无头 Chrome 实拍），只为方便快速翻看；
页面本身可直接访问，截图不是交付物，可整目录删除：

```
review/01-home.jpg              首页（1440×900）
review/02-workbench.jpg         工作台 · 03 处理（1440×900）
review/03-library.jpg           纹样库 · 网格（1440×900）
review/04-settings.jpg          设置（1440×900）
review/05-notes.jpg             使用说明（1440×900）
review/06-narrow-home.jpg       首页 · 390 宽
review/07-narrow-workbench.jpg  工作台 · 390 宽
review/08-tour.jpg              首页 · 七道工序导览浮层
```

截图批次为 2026-11-11「蜜蜡 · 沉褐」配色接入后重出；本批没有重拍「对比」，因为现有素材只有原件与规范输入，
工作台对这两个版本如实提示无可对比对象。2026-11-12 给七道工序配上样例图、首页高亮改为跟随真实进度，
并做了一轮文案精简（去掉「不上传云端」「不写入浏览器存储」这类保证句，见 DESIGN.md 文案规则），
`review/` 没有跟着重拍（首页与导览两张已过时，只作版式参考）。2026-11-13 工作台的资产区改为按工序分组，
`review/02-workbench.jpg` 与 `07-narrow-workbench.jpg` 同样过时。

## 设计

视觉依据见 [DESIGN.md](DESIGN.md)：配色为「蜜蜡 · 沉褐」——焦褐底暗房 + 放旧的绢样张 + 陈年琥珀，
琥珀只给主操作、当前工序、A 级与焦点环，错误另用砖红；所有纹样都放在纸本图版上；
动效只服务进入、对比、确认，并受 `prefers-reduced-motion` 关闭。
中文界面、可见文字最小 12px、正文 14px。

配色令牌集中在 `css/tokens.css`（全部颜色来自令牌，视图样式里不写死色号）；
改完令牌在仓库根目录跑 `python scripts/check_contrast.py` 复核 WCAG 对比度。
配色过程与参数见 [docs/palette-review.md](../../docs/palette-review.md)。

## 数据与边界

- 真实数据来自 `/api/v1`，图片、任务、资产与 SQLite 历史保存在本机 `storage/api/`。
- 不写浏览器存储；会话在内存里，刷新后通过 URL 或纹样库重新进入。
- 云端候选与局部修复需要配置密钥、付费开关与价格确认；未配置时界面显示原因，本地流程照常可用。
- 旧前端（`frontend/index.html` 等）一行未改；接入前静态评审版的本地备份不纳入 Git。

## 已知限制

- 没有构建步骤、没有第三方依赖；只在 Chrome 验证过，Safari / Firefox 与完整屏幕阅读器走查未做。
- 颜色用 `color-mix()` 派生明暗与透明层，需要 Chrome 111+ / Safari 16.2+ / Firefox 113+；更旧的浏览器会丢这些半透明层。
- 「本地线稿模型」依赖本机 torch、分割模型库与 `model/` 权重；缺少时请用 OpenCV 线稿或颜色提取。
- 大图在矢量化阶段可能触及 worker 内存上限，先创建工作副本更稳。
- 字体依赖本机 `Noto Serif SC` / `Noto Sans SC` / `Bahnschrift` / `Cascadia Code`，缺失时观感会变。
- `review/` 是接入真实数据后的视口截图，可整目录删除，不影响运行。

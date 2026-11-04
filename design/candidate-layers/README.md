# 候选图层页（stage 04）· 静态原型与 React 骨架

本目录是 Pattern Studio 工作台第 4 阶段「候选」页的**设计参考**，不是生产代码。
范围：一个页面、五种状态、零业务逻辑。详见 [handover.md](./handover.md)。

## 打开 HTML 原型

直接用浏览器打开 `prototype/index.html`（无需构建、无需服务）：

```
design/candidate-layers/prototype/index.html
```

通过 URL 查询参数切换状态：

| 地址 | 状态 |
| --- | --- |
| `index.html?state=empty` | 无候选，空状态 + 「生成候选」占位按钮 |
| `index.html?state=loading` | 骨架屏 + 「正在生成候选」 |
| `index.html?state=ready` | 5 个候选，默认全部未选 |
| `index.html?state=selected` | 5 个候选，默认已选 1、2 层 |
| `index.html?state=error` | 错误信息 + 「重试生成」占位按钮 |

不带参数或参数非法时按 `ready` 处理。
纯前端可交互项：选择/取消候选、切换筛选（全部/已选/待复核）、画布缩放。
「生成候选 / 重试 / 合成 / 拒绝 / 改用本地流程」均为占位，无任何请求。

## 运行 React 骨架

需要 Node.js 18+（已在 Node 24 验证）：

```
cd react-skeleton
npm install
npm run dev      # 开发预览，Vite 默认 http://localhost:5173
npm run build    # 产物输出到 dist/
```

状态切换同样使用 `?state=` 查询参数（开发服务器下如 `http://localhost:5173/?state=selected`）。

## 目录说明

```
design/candidate-layers/
├─ README.md            本文件
├─ handover.md          交接文档：令牌、结构、组件、交互、集成说明
├─ tokens.json          机器可读设计令牌
├─ prototype/
│  └─ index.html        单文件静态原型（Tailwind Play CDN），视觉基准
└─ react-skeleton/      React 18 + TS + Vite 5 + Tailwind 3.4 组件骨架
```

`prototype/index.html` 是视觉唯一基准；`react-skeleton` 必须与之保持一致。
Tailwind Play CDN 与 React 骨架仅用于设计评审，**不得带入生产**；生产集成方式见 handover.md 第 5 节。

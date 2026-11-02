<div align="center">

<img src="./assets/icon-180.png" width="88" alt="dsh-grok-buddy icon">

<img src="./docs/hero.png" alt="dsh-grok-buddy — DSH 侧栏会话列表：左边是默认圆点，右边是 Grok Bot 的脸" style="max-width: 860px; width: 100%">

# dsh-grok-buddy

**把 Grok Bot 本人那张脸，装进 DeepSeek Harness 的会话列表。**

每个会话（任务）在侧栏的那一行，原来的彩色小圆点换成一只会呼吸的 GrokBot 头像：
它在思考、在输出、在跑工具、在等你点确认、失败了、还是刚干完 —— **看脸就知道**。

<img src="./docs/effect.gif" alt="dsh-grok-buddy 实际效果：侧栏会话行里的 GrokBot 头像在眨眼、转动眼珠" style="max-width: 560px; width: 100%">

[![DSH Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f7cff)](https://github.com/topics/dsh-plugin)
[![release](https://img.shields.io/github/v/release/devzer0o0/dsh-grok-buddy)](https://github.com/devzer0o0/dsh-grok-buddy/releases)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-blue)](./LICENSE)

</div>

## 这是什么

一句话：**DSH 侧栏里每个会话的状态，由 Grok Bot 那张脸来演。**

它没有另画一套图标，也不是随便找个 emoji 顶上去 —— 用的是 Grok Bot 自己的头像和表情：
一颗圆滚滚的 blob，两只眼睛贴在球面上，转头时会跟着透视变形、转到背面会消失；
表情切换是带弹簧的形变，平时还会随机眨眼。

<p align="center"><img src="./docs/faces.png" width="720" alt="八种状态：安静 / 思考中 / 输出中 / 执行工具 / 等你确认 / 重试中 / 失败 / 刚完成"></p>

## 为什么是这张脸

Grok Bot 的设计文章把这件事讲得很清楚：他们要解决的不是「怎么再塞一个进度指示器」，
而是「怎么让头像本身承担状态」。

> We could have represented each state with a separate indicator, but that would
> have added another layer of UI for the user to interpret. Instead, we explored
> how much of the lifecycle the avatar itself could carry.

所以这里也照做：**不新增任何 UI 元素**，只把侧栏原本那个彩色小圆点换成一个会呼吸的头像。
位置、尺寸（18px）、行高全都不变 —— 它就在原来那个位置，只是开始有表情了。

## 状态映射

官方生命周期是六个：Idle / Working / Waiting / Blocked / Thinking / Done
（见 [Designing Grok Bot](https://x.ai/news/designing-grok-bot)）。
**颜色只表示生命周期，动作只表示这一刻在干嘛** —— 和官方一致：同一个阶段不会因为
「正在吐字」还是「正在跑工具」换颜色，换的是脸上的小动作。

墨色全部取自 x.ai 站点里 Grok Bot 头像的 `ink` 值和状态徽章配色，一字不改：

| DSH 相位 | 触发条件 | 官方生命周期 | 墨色（官方来源） | 小动作 |
| --- | --- | --- | --- | --- |
| `idle` | 没有活动 | Idle | `#9A9A9A` / `#777777`（`--fig-gray`） | 平静地眨眼 |
| `thinking` | 已发请求、等首 token | Thinking | `#9159FE`（hex Bot 的 ink） | 眼珠来回游移 |
| `streaming` | 模型正在吐字 | Working | `#1084FE`（主角 blob 的 ink） | 专注 |
| `tool` | 工具执行中 | Working | `#1084FE`（同上，**同色**） | `searching`：找、读、敲 |
| `waiting` | 审批挂起，轮到你 | Waiting | `#FF9800`（徽章 warn） | `bored`：等得有点无聊 |
| `retry` | 请求失败、正在退避重试 | Waiting | `#FF9800`（同上，**同色**） | `curious`：歪头看着下一次 |
| `error` | 本轮以错误收场 | Blocked | `#FF263C`（徽章 error） | `alerting`：警觉 |
| `completed` | 刚做完、还没被看过 | Done | `#00C972`（徽章 done） | `celebrate`：开心 |

眼睛和官方一样填**背景色**（官方 `.head{fill:var(--fg)}` / `.eye{fill:var(--bg)}`）。
插件没有 DSH 的主题变量，所以直接从状态位背后量出实际底色再填 —— 亮色、暗色、
以及任何自定义侧栏色，眼睛都对得上。

鼠标悬停能看到具体细节（在读哪个工具、失败代号、重试次数）。

## 安装

复制下面这段，直接贴给 DSH 里的助手，它会替你装好并验证：

```text
安装 dsh-grok-buddy 插件到我的 DSH profile（没说的话先问我用哪个 profile）。
装的是 GitHub 上的 `devzer0o0/dsh-grok-buddy`（尚未发布到 npm）。

步骤：
1. 加依赖：`dsh plugin --profile <PROFILE> add github:devzer0o0/dsh-grok-buddy`
   （它还没发布到 npm，所以装 GitHub 源；Release 上有预构建 tarball 也行）
2. 确认 node_modules/dsh-grok-buddy 里有构建产物 lib/index.js 和 lib/widget.js；
   缺了就在插件目录跑一次 `npm run build`，再重新装。
3. 确认 profile 的 package.json 里 dsh.profile.bundles 包含 `dsh-grok-buddy` ——
   本包自带 cordis.patch.yml，只要在 bundles 列表里，启动时那一行会自动插进配置树。
4. 不要启动 profile，装完验证即可，然后告诉我你改了什么。
```

然后重启 `dsh web`（或让 HMR 生效）并刷新页面。

也可以从 [dsh-market](https://dshmarket.com) 插件市场里搜索 `dsh-grok-buddy` 一键安装 ——
预构建 tarball 挂在 GitHub Release 上，市场会优先用它，跳过源码构建。

想从源码装：

```bash
cd ~/.dsh/profiles/<PROFILE>
pnpm add github:devzer0o0/dsh-grok-buddy
```

## 工作原理

宿主半侧（`lib/index.js`）：

* 订阅 `session/event`：turn/step 边界、`tool/call`、`tool/result`、`approval/asked`、
  `llm/retry`、`turn/end`、标题与工作目录
* 订阅 `agent/assistant-stream`：只看有没有开始吐字
* 订阅 `agent/status` 与 `agent/error`：agent 是否在跑、有没有崩
* 把这些折叠成每个会话一个相位（`lib/derive.js`，纯函数，可单测）
* 暴露 `GET /dsh-grok-buddy/state.json`，并在页面 head 注入 `/dsh-grok-buddy/widget.js`

注入走两条路：`webserver/index-inject` 结构化注入行（桌面版唯一受支持的方式），
外加 `webServer.tapIndex` 兜底（Host 自己渲染 index.html 时）。

页面半侧（`src/widget/` → 构建成 `lib/widget.js`）：

* 轮询 state.json，在每一行 `[data-row-key^="session:"]` 的 18px 状态位里放一只头像
* 隐藏框架自带的圆点和转圈（只针对状态位内部，不碰其它插件的座位）
* 头像实例按 DOM 槽位索引，同一会话同时出现在列表和搜索里也不会互相抢节点
* 眼睛的底色**从状态位背后量**（`surfaceOf`，逐级往上找到第一个不透明背景），
  主题一变就重刷 —— 这样跟随系统 / 手动切深浅 / 自定义侧栏色都能对上

**只读观测**：不写会话、不改模型请求、不注册投影。卸载后把挂上去的节点全部摘掉。

无需任何构建依赖，Node 22+ 即可；`lib/widget.js` 是构建产物，仓库里已带。

## 开发

```bash
node scripts/build.mjs            # src/ → lib/widget.js（单文件 IIFE）
node --test "test/*.test.mjs"     # 11 个相位推导单测
```

打开 `preview.html`（需要起个静态服务，因为用了 ES module）可以看八种状态的实时效果，
`docs/faces.html` 是同一套的静态版，`docs/palette-check.html` 把八只脸并排放进
暗色与亮色两种侧栏底色里，专门用来核对「墨色对不对、眼睛和底色对不对得上」。
它跑的是构建产物本身，不依赖 DSH。

## 致谢与许可

BSD-3-Clause。头像几何、表情与体形数据来自
[nasawz/GrokBot](https://github.com/nasawz/GrokBot)（BSD-3-Clause），
经 [dsh-thought-buddy](https://github.com/dsh-plugins/dsh-thought-buddy) 的移植版转写。
详见 [LICENSE](LICENSE)。

本项目与 xAI 无隶属关系，只是用了 Grok Bot 这个公开形象。

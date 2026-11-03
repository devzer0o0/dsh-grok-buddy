<div align="center">

<img src="./assets/icon-180.png" width="88" alt="dsh-grok-buddy icon">

<img src="./docs/hero.png" alt="dsh-grok-buddy — DSH 侧栏会话列表：左边是默认圆点，右边是 Grok Bot 的脸" style="max-width: 860px; width: 100%">

# dsh-grok-buddy

**把 Grok Bot 本人那张脸，装进 DeepSeek Harness 的会话列表。**

每个会话（任务）在侧栏的那一行，原来的彩色小圆点换成一只会呼吸的 GrokBot 头像：
它在思考、在跑工具、在等你点确认、失败了、还是刚干完 —— **看脸就知道**。

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

<p align="center"><img src="./docs/states.png" width="720" alt="六种运行状态：空闲 / 正在处理 / 正在等待 / 已阻止 / 思考 / 完成"></p>

## 为什么是这张脸

Grok Bot 的设计文章把这件事讲得很清楚：他们要解决的不是「怎么再塞一个进度指示器」，
而是「怎么让头像本身承担状态」。

> We could have represented each state with a separate indicator, but that would
> have added another layer of UI for the user to interpret. Instead, we explored
> how much of the lifecycle the avatar itself could carry.

所以这里也照做：**不新增任何 UI 元素**，只把侧栏原本那个彩色小圆点换成一个会呼吸的头像。
位置、尺寸（16px，和原生状态点同宽）、行高全都不变 —— 它就在原来那个位置，只是开始有表情了。

## 三层分开：状态 / 动作 / 表情

这是本插件最容易被误解的地方，先讲清楚：

| 层 | 是什么 | 出现在哪里 |
| --- | --- | --- |
| **运行状态**（runtimePhase / displayPhase） | **只有六种**：idle / working / waiting / blocked / thinking / done | 接口、文档、读屏标签、data-dsgb-phase |
| **动作预设**（motionPreset） | 内部动画资源名：idle / working / bored / alerting / thinking / celebrate | data-dsgb-motion（明确标注是动画资源） |
| **表情素材**（expression） | 25 张眼型，按动作的表情池取用 | 只在渲染引擎内部 |

所以：

* **动作预设库有多少条,不等于插件有多少种状态。** 素材库里还有 proud、excited、
  curious、sleeping 等二十多个动作，它们**不是**运行状态。
* **表情图里的名字,不等于运行状态。** docs/faces.html 里那些 sleeping / waking /
  searching / curious / proud 只是 idle 的表情素材参考，不参与会话状态判定。
* 事实与标志位（selected / seen / consumed / stale）也不是状态。

## 六态判定（唯一语义）

实现在 src/decision.js，宿主与页面**共用这一份**，没有第二套优先级。

| 状态 | 中文 | 判定条件 |
| --- | --- | --- |
| idle | 空闲 | 默认；没有在途任务；或完成展示已结束/已被消费 |
| working | 正在处理 | 会话活跃，且**当前任务还有未结束的工具调用** |
| waiting | 正在等待 | 会话活跃，且有未解决的**审批、提问或计划评审** |
| blocked | 已阻止 | 当前任务或需处理的交互仍活跃，且存在**有效**错误 |
| thinking | 思考 | 会话活跃，处于模型请求/推理/生成阶段，且无更高优先级事实 |
| done | 完成 | 当前轮有明确的**成功**终态，且完成展示仍活跃、未被消费 |

### 判定顺序（不可交换）

1. **终态优先**。当前轮已有明确终态时：
   completed → done（若已消费/已失活则 idle，**完成事实不删除**）；
   error / blocked → blocked；aborted / max-tokens / 未知 → idle。
2. **未结束任务**：有效错误 → blocked；挂起交互 → waiting；未结束工具 → working；
   模型阶段 → thinking；其余 → thinking（刚起步）。
3. **静默只降级为 idle**，且只在没有任何在途证据时生效。**永远不拿沉默冒充成功。**

几条明确的边界：

* **仅模型输出、仅 agent running、仅等网络响应，都不等于 working。** working 只留给
  真正在运行的工具调用。模型吐字属于 thinking。
* **致命错误压过挂起交互**：DSH 里 agent/error 表示 agent 已崩，此时挂起的审批/提问
  已经没有回答方，留成 waiting 会把「等人」误导成「还能答」。
* **历史工具错误不会永久 blocked**：后续成功的工具结果、新一轮开始、agent 恢复运行，
  都会清掉同轮的旧错误。
* **重试不是独立状态**，按当前错误或恢复执行事实归入六态。
* **完成展示失活,不等于忘记**：终态事实与展示状态分开保存。

### waiting 覆盖的真实来源

不是只支持审批。DSH 里「等人」有两类**互补**的真实来源，本插件两处都接：

| 来源 | 真实宿主契约 | 覆盖什么 |
| --- | --- | --- |
| 审批 | `approval/asked` ↔ `approval/decided` 事件对（带 `id`） | 所有需要批准的调用 |
| `userQuestions` 投影 | `sessionProjections.stateOf(session, 'userQuestions')` | **带 timeout** 的 `ask_user_question` 和计划评审 |
| 未结束的交互式工具调用 | `tool/call` 名为 `ask_user_question` / `exit_plan_mode` 且结果未回 | **阻塞式**提问与评审（它们根本不进投影） |

⚠️ **投影的 raw state ≠ wire view**。这是踩过的坑：

```text
stateOf() 返回     { inheritedEventCount, timed, questions: { active, settled } }
曾经的误读         state.active            ← 永远 undefined，挂起提问被算成 working
正确路径           state.questions.active
```

`active` 里两种状态都算「还要人回答」：`open`（正在等）与 `continued`
（带 timeout 的提问超时返回 pending，用户仍可回答）。

三种结果必须分开，不能都当「已解决」：

* 明确有挂起交互 → waiting
* 明确没有（投影返回空）→ 清掉投影来源
* 投影不可用或读取失败 → **保留**现有事实，不凭空清空

交互的解决事件必须匹配**当前有效交互的身份**（`id` / `callId` / 轮次），
不能只按事件类型清空 —— 旧轮的 `approval/decided` 曾把当前轮的新审批清掉。

### 完成展示（用户确认的规则）

> **活跃时持续庆祝；查看并切走或失活后变为灰色 idle。**

所以 done 路径上：

* 活跃完成期间**一直** celebrate，**没有**固定 2.6 秒退回；
* 同一完成周期只初始化一次，持续播放期间不重复重启动画；
* 用户查看期间仍显示 done + 项目色；
* 查看后切走，或完成展示活跃期结束 → idle、灰、停止庆祝；
* 新一轮真实开始 → 进入新任务对应状态；
* 同一完成记录被消费后，旧 DOM / 旧快照的 done **不能**让它重新复活；
* 新一轮完成可以建立**新的**展示周期（completionKey 不同）。

完成身份按 completionKey（sessionId#turn）记，**不是**按会话 id 一刀切。
缺 completedAt 时用页面的「首次观测时刻」作稳定锚点，所以「无法标记已查看、
永远活跃」不会发生。

#### 「查看」与「消费」是两件事

踩过的坑：选中就立刻写 consumed，下一次同步就把 done 判成 idle ——
用户看到的是一闪而过的庆祝。现在严格分开：

| 事实 | 何时写入 | 效果 |
| --- | --- | --- |
| `viewedAt` | 该完成进入展示且该行**被选中** | 记录「用户在看了」，**不消费**，仍是 done + 项目色 |
| `consumedAt` | 已经 `viewedAt` 过，**且现在不再选中** | 这才是「查看后切走」→ 退出展示 → idle、灰 |

「查看」的证据是侧栏的选择状态（`aria-selected`，DSH 自带的选中契约），
不是 CSS 外观。悬停、搜索高亮、DOM 卸载、虚拟列表回收**都不算**查看或切走。

同一会话可能同时出现在多个表面：生命周期在**会话**粒度算一次，再投影到各表面，
所以遍历顺序不会让第一个表面把完成消费掉、第二个表面立刻看到不同状态。

#### 兜底完成周期

插件可能漏掉 `turn/end`，或者它比页面启动更早。这时没有宿主 completionKey，
需要一条兜底身份。条件是**「缺少可靠完成身份」**，而不是「插件不认识这个会话」——
已知会话也可能 idle + 原生 done。

兜底身份形如 `native:<sessionId>#<generation>`，代数只在观察到真实的
「活跃 → 完成」转换时加一：

* 同一轮完成不会被重复消费；
* 真实的新一轮完成能建立新周期、重新庆祝；
* DOM 消失后重现、网络恢复、状态暂时缺失，都**不会**被当作新一轮；
* 兜底完成同样受失活阈值约束，超时后退出 done（不是一直灰色庆祝）。

**限制**：`generation` 是页面内存里的保守计数。页面重载或宿主重启后它从零开始，
因此跨重启的严格去重**不成立**；本插件不把生命周期元数据写入磁盘，也就不需要
版本与清理机制，但也拿不到跨重启的完成身份。这是已知边界，不宣称更强保证。

### 两个阈值（实现参数，集中在 src/decision.js）

| 常量 | 值 | 用途 |
| --- | --- | --- |
| TURN_SILENCE_TTL_MS | 3 分钟 | 一个 turn 开着却既无工具、无交互、无新事件时，**降级为 idle**。长工具与长等待不受影响。 |
| DONE_DISPLAY_TTL_MS | 5 分钟 | 完成展示的活跃期上限。用户仍选中查看时按选中规则处理。 |

两者**都不是**官网规定，也不是用户指定的时长；它们只在这里定义一次，别处不许重写。

## 颜色是身份，动作是状态

官方那个 lifecycle 演示里，Idle / Working / Waiting / Blocked / Thinking / Done
**六个标签共用同一个 --gb-ink** —— 切状态时头像颜色一个像素都不变，变的全是动作。
颜色回答的是「这是哪只 Bot」，不是「它在干嘛」。

* **颜色 = 项目**（DSH Workspace）。一个项目一个色，与状态无关
* **动作 = 这一刻在干嘛**

### 颜色

8 个官方身份墨色，取自 x.ai 站点包里 Grok Bot 头像的 ink 值，一字不改：

| 名字 | 墨色 | 原型 |
| --- | --- | --- |
| 蓝 | #1084FE | blob（主角） |
| 紫 | #9159FE | hex |
| 橙 | #FF9800 | cloud |
| 粉 | #FF309B | wedge |
| 橙红 | #FF6700 | pebble |
| 赭 | #97683D | teardrop |
| 青 | #00BCA6 | squircle |
| 红 | #FF263C | tablet |

* 项目没设过颜色 → workspaceId 哈希到 8 色之一（FNV-1a，稳定、跨机器一致）
* 设过颜色 → 用你选的那个
* 对比度不够时**只调明度、不动色相**

**什么时候是灰的**（src/widget/activity.js）：

| 情况 | 颜色 |
| --- | --- |
| 被选中 | 当前项目的颜色（永远，空闲也一样） |
| working / waiting / blocked / thinking | 项目色 |
| done 且活跃、未被消费 | 项目色 |
| done 已被消费、或展示失活 | **灰** |
| idle | **灰** |

「点开看过」按**完成身份**记：选中期间显示项目色，切走之后才变灰。

* 眼睛仍然填状态位背后的实际底色（官方 .eye{fill:var(--bg)}），
  亮色 / 暗色 / 自定义侧栏色都对得上

**在哪改**：项目行右侧的「⋯」菜单里，和「重命名 / 删除工作区」并列，多一项「颜色」。
点开是调色板：8 个官方色块 + 自定义 hex 输入 + 恢复默认。

<p align="center"><img src="./docs/project-palette-light.png" width="720" alt="项目行的 ⋯ 菜单 → 颜色 → 调色板（亮色）"></p>

改完**立刻**生效：该项目下所有已挂载的头像当场换色，不用等轮询、不用刷新。
写入失败会回滚并给出可观察提示；连续写入与轮询不会出现「旧响应覆盖新选择」。

**持久化**：写在 $DSH_HOME/dsh-grok-buddy/colors.json（默认 ~/.dsh/dsh-grok-buddy/colors.json），
按 workspaceId 存，顺手记一份目录路径作可读备份。

```json
{ "version": 1, "projects": { "proj-alpha": "#9159fe" },
  "paths": { "proj-alpha": "/Users/space/IdeaProjects/demo" } }
```

不用 localStorage —— 桌面端和 dsh web 的来源会变，重启就丢。写盘是「写 tmp 再 rename」
的原子写；文件损坏、字段缺失、非法颜色一律不崩，退回哈希默认色并打一条 warn。

### 动作

六个状态各对一个动作预设（**预设名不是状态名**）：

| 状态 | 动作预设 | 看得出来的动作 |
| --- | --- | --- |
| idle | idle | 平静地眨眼，9–16s 才换一次脸 |
| thinking | thinking | 眼珠游移，2.0–3.6s 换脸 |
| working | working | 专注，1.8–3.2s（最快） |
| waiting | bored | 等得有点无聊，3.5–6.0s（最慢） |
| blocked | alerting | **不眨眼**、表情池只有 2 张（定住） |
| done | celebrate | 持续庆祝，直到查看切走或失活 |

blocked 的「不眨眼」是最好认的一条：其它动作都会眨，它定住不动。

**prefers-reduced-motion**：**不启动持续动画**——不是只关掉转头和视线偏移。
眨眼、随机换脸、弹簧形变与 RAF 全部停掉，直接画一帧该状态的静态姿态；
六态的区分靠姿态本身加可访问文案（aria-label 跟着状态更新，中英各一套）。
系统偏好在运行时变化时会重画静态姿态或恢复动画，**不改变任何业务状态**：
done 在 reduced-motion 下仍是 done。诊断里的 `animating` 依据引擎真实运行
状态，而不是「有没有 dispose 函数」。

鼠标悬停能看到具体细节（在读哪个工具、失败代号）。

## 界面适配：不是只有侧栏那一种行

DSH 的会话在不同表面的 DOM **结构不同**，不能假设都是 [data-row-key^="session:"]：

| 表面 | 结构 | 身份来源 | 本插件 |
| --- | --- | --- | --- |
| 侧栏会话行 | div[data-row-key="session:<id>"][role=treeitem] | `data-row-key` | **支持**（含 HoverCard 包装、嵌套 groupSection、虚拟列表复用） |
| 搜索结果行 | div[role=treeitem]，**无 data-row-key** | 只有标题文本 | **不猜身份**，记 `unidentifiableSearch` |
| 悬停卡片 | HoverCard 用 `createPortal` 挂到 body；正文由 `renderSlot("sidebar.session.row.hover", { sessionId })` 渲染 | sessionId 是 **React 参数**，不进 DOM | **不挂头像**（卡片自身已显示标题与状态行） |

搜索行的 16px 槽位是嵌套结构（`searchResultHeading > slot`），**不是**「首个窄于
20px 的子节点」。缺稳定身份时宁可不上头像，也不按标题或顺序猜 —— 那会张冠李戴到
同名会话上，比不显示更糟。

要覆盖这两种表面，需要一个**公开的稳定身份入口**，二选一：

1. 在搜索结果行上暴露 `data-row-key="session:<id>"`（最小改动，本插件已能自动识别，
   见 `test/surface-adapters.test.mjs` 的 S8）；或
2. 提供 `sidebar.workspaces.search.result.leading` 之类的 leading 槽位。

这两条都需要宿主改动，或用 `dsh.client` 模块 + `ctx.slots` 注册（本插件当前走
head 注入，不是 client 模块）。本插件不修改安装包、不依赖 React Fiber 等私有结构
绕过这一条。

同一 session 在多个表面同时显示时，**共享事实与完成消费**，但各自拥有独立的 DOM
动画实例。

## 安装

```text
安装 dsh-grok-buddy 插件到我的 DSH profile（没说的话先问我用哪个 profile）。

步骤：
1. 加依赖：dsh plugin --profile <PROFILE> add github:devzer0o0/dsh-grok-buddy
2. 确认 node_modules/dsh-grok-buddy 里有 lib/index.js 和 lib/widget.js；
   缺了就在插件目录跑一次 npm run build，再重新装。
3. 确认 profile 的 package.json 里 dsh.profile.bundles 包含 dsh-grok-buddy。
4. 不要启动 profile，装完验证即可。
```

## 刷新、重启与验收（三件事不一样）

| 动作 | 生效范围 | 说明 |
| --- | --- | --- |
| **重新加载 renderer 页面** | 只换**页面脚本** | lib/widget.js 是每次请求现读磁盘的，页面脚本改完刷新就生效；**不**加载宿主侧改动 |
| **重启宿主** | 宿主侧 lib/index.js、lib/derive.js、lib/fold.js、lib/probe.js、路由 | 事件处理、状态折叠、HTTP 路由的改动**必须**重启宿主才生效 |
| **重新安装插件文件** | 磁盘上的包 | profile 里的 node_modules 是拷贝不是软链；改源码要重新装或手动同步，**再**重启宿主 |

**判据（不要只看版本字符串）**：

1. `curl -s <host>/dsh-grok-buddy/widget.js | md5` 与工作区 lib/widget.js 一致 → 页面脚本层已更新
2. `curl -s <host>/dsh-grok-buddy/state.json` 里每行**有 reason 与 completionKey 字段** → 宿主层已加载新版
3. 页面里 `__dshGrokBuddy.version` 与构建标识一致 → 页内实例是新的

第 2 条不过，说明宿主还没重启 —— 此时页面即使刷了小版本也拿不到新语义。

## 诊断（默认关闭）

不复默认无限期后台采样。诊断是一个**一次性窗口**：

```bash
# 1) 打开一个采样窗口（最长 60 秒）
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"action":"arm","ms":10000}' \
  http://127.0.0.1:<port>/dsh-grok-buddy/probe-control.json

# 2) 页面上触发采样：window.__dshGrokBuddy.armProbe(5000)

# 3) 取回样本
curl -s http://127.0.0.1:<port>/dsh-grok-buddy/probe.json

# 4) 关掉
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"action":"disarm"}' \
  http://127.0.0.1:<port>/dsh-grok-buddy/probe-control.json
```

样本里有：build、pageId、采样时间与接收时间、是否过期（stale / ageMs）、
每行的身份、原始相位、判定理由、最终状态、完成消费状态、槽位矩形、
display / visibility / opacity、动画是否在跑、aria-label。

**不会**上传会话标题、正文、工具参数、路径或凭据（服务端还有一层白名单兜底）。
GET 返回 200 但 probe 为 null **不算**链路通 —— 那表示没开窗口或没有样本。

## 工作原理

宿主半侧（lib/index.js）：

* 订阅 session/event：turn/step 边界、tool/call、tool/result、approval/asked、
  llm/retry、turn/end、标题与工作目录
* 订阅 agent/assistant-stream：只看有没有开始吐字
* 订阅 agent/status 与 agent/error：agent 是否在跑、有没有崩
* 读 sessionProjections 的 userQuestions：挂起的提问与计划评审
* lib/fold.js 把这些折成**事实**（不产出状态名）
* src/decision.js 用事实 + 展示输入算出**六态**（唯一决策表）
* 暴露 GET /dsh-grok-buddy/state.json，并在页面 head 注入 /dsh-grok-buddy/widget.js
* 暴露 GET/POST /dsh-grok-buddy/colors.json、probe.json、probe-control.json

注入走两条路：webserver/index-inject 结构化注入行（桌面版唯一受支持的方式），
外加 webServer.tapIndex 兜底（Host 自己渲染 index.html 时）。

页面半侧（src/widget/ → 构建成 lib/widget.js）：

* 轮询 state.json，在侧栏会话行的 16px 前导位里放一只头像
* 状态位改成**按内容撑开**（只剩头像时仍是 16px）：DSH 会往同一格再塞自己的标记
  （例如定时任务的时钟，同样 16px），定宽格子必然溢出、时钟压到标题上
* 头像实例按 DOM 槽位索引；同一槽位被复用于另一个会话时**重新绑定身份**
* 节点离开 DOM 后动画会停，挂回来时重新起循环（不是留守静止 SVG）
* 眼睛的底色**从状态位背后量**，主题一变就重刷
* 项目归属：向上找最近的 .groupSection 再取项目行 key

  ⚠️ **不能用 `:scope >` 直接取项目行**。DSH 的 HoverCard 把每一行都包进一层
  span.hc-root，项目行不是分区的直接子节点 —— `:scope >` 会返回 0 个，
  所有会话都掉进「未分组」。现在的做法是在分区内找项目行，再用「最近的
  .groupSection 是不是我自己」排除嵌套分区里的那些。
* 改色入口：项目行「⋯」菜单是 DSH 前端硬编码的，没有开放 slot，所以在菜单容器
  [data-menu-material] 里补一项「颜色」。容器会复用，所以归属在**点击那一刻**重新算
* 项目行**不放**任何额外装饰：文件夹前面只留 DSH 自己的图标

**只读观测**：不写会话、不改模型请求。卸载后把节点、监听、定时器、样式、
全局对象全部清掉，并恢复宿主自己的属性。

## 开发

```bash
node scripts/build.mjs            # src/ → lib/widget.js（单文件 IIFE）
node --test "test/*.test.mjs"     # 单元 / 决策 / 路由 / 构建产物集成测试
```

测试分三层：

* test/decision.test.mjs、test/derive.test.mjs：六态判定与事件身份
* test/probe-route.test.mjs、test/colors-route.test.mjs：真实 HTTP 路由
* test/widget-integration.test.mjs：**把构建产物真的跑起来**（boot / fetch / sync /
  mount / 动画 / observer / dispose），不是复制一份实现重测

preview.html 与 docs/*.html 跑的都是构建产物本身，不依赖 DSH。

## 未完成与已知边界

**功能缺口（需宿主改动，本插件不猜）**

* **搜索结果行**：当前 DSH 的 `SearchResultItem` 只渲染 `role/aria-selected`，
  不写 `data-row-key`；16px 槽位嵌在 `searchResultHeading > slot` 里。
  本插件如实记账（`unidentifiableSearch`）但不挂头像。
  最小公开契约是两种之一：搜索结果行暴露 `data-row-key="session:<id>"`
  （本插件已能自动识别），或提供 leading 槽位。
* **悬停卡片**：`HoverCard` 用 `createPortal` 挂到 `document.body`，
  `sessionId` 只是 `renderSlot("sidebar.session.row.hover", { sessionId })` 的
  React 参数，不进 DOM。不挂独立头像（卡片自身已显示标题与状态行）。
* 上述两条都可用 `dsh.client` 模块 + `ctx.slots` 注册解决，但本插件当前走
  head 注入架构，不是 client 模块。改造它超出「修复六态」的范围，
  也**不修改安装包**来绕过。

**证据边界（不要过度解读）**

* HTTP `/dsh-grok-buddy/widget.js` 返回的 hash 一致，只证明**服务端在提供新 bundle**；
  它**不**证明宿主进程加载了新逻辑，也**不**证明当前 renderer 实例执行了新 bundle。
  三层要分别核验（见「刷新、重启与验收」）。
* 兜底完成周期的 `generation` 是页面内存计数，**跨重启严格去重不成立**。
* `prefers-reduced-motion` 的静态姿态只保证六态在素材层可区分；
  16px 下的可辨识度以真实侧栏截评为准，不以放大预览为准。

## 致谢与许可

BSD-3-Clause。头像几何、表情与体形数据来自
[nasawz/GrokBot](https://github.com/nasawz/GrokBot)（BSD-3-Clause），
经 [dsh-thought-buddy](https://github.com/dsh-plugins/dsh-thought-buddy) 的移植版转写。
详见 [LICENSE](LICENSE)。

本项目与 xAI 无隶属关系，只是用了 Grok Bot 这个公开形象。
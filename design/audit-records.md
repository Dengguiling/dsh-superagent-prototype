# 记录页前端审计（Trigger / Eval / Execution / Ticket / Thread / 会话）

审计对象：`dsh-superagent-prototype` 的客户端「记录与详情」页面。
目的：为改版提供证据基线——指出问题、说明代价、给出可执行的修复方向。

审计范围与方法：

- 读取 `src/client/{trigger,thread,eval,execution,ticket,conversation,draft,text,markdown}.tsx|ts`
  以及共享组件 `rows.tsx`、`widgets.tsx`、`controls.tsx`、`marks.ts`、`api.ts`、`route.ts`、`provider.tsx`、
  `client.css`（514 行），和服务端视图 `src/app/views/{threads,tickets,records,text,pms}.ts`。
- 对照 `docs/005-panel.md`（面板自身的设计原则，特别是「Reading individual records」与「Principles」）
  与 `docs/011-interaction-scenarios.md`（真实走查场景，含第一轮发现的三个问题）。
- 每条结论都标注了 `文件:行号`；凡是**无法**在代码里核实的猜测，都不写进来。

> **一处范围修正**：任务里把 `src/client/draft.tsx` 描述为「回复工单的输入框」。实际不是。
> `draft.tsx` 是**设置项草稿状态机**（`merge3` 三路合并 + `SaveBar` 保存条，203 行），
> 只在 Settings 组里被用到；真正的工单回复输入框在 `src/client/conversation.tsx:84-91`。
> 本报告按**实际代码**审计，并把 `draft.tsx` 作为「设置页保存条」的参照物记录在 §3。

---

## 1. 页面清单

路由定义在 `src/client/route.ts:13-20`，页面分发在 `src/client/app.tsx:147-161`。
所有页面共用同一外壳：`dt-page`（单列，`max-width: 960px`）→ `dt-head`（标题 + 全局搜索 + 术语表）→
`dt-tabs`（7 个顶级 Tab）→ `dt-main`。

| # | 页面 | 路由 | 展示内容 | 信息区（自上而下） | 主要动作 | 次要动作 |
|---|------|------|---------|-------------------|---------|---------|
| P1 | **Trigger 列表** | `trigger`（无 id） | 按订阅/评估状态过滤的 Thread 列表 | `StatusHead`「状态」标题 + (?) 提示 → 4 个过滤 Pill（已被订阅 / 评估中 / 24 小时内有新触发 / 全部线程）→ Thread 行列表 → 「加载更多」 | 打开某个 Thread（行标题） | 切换过滤条件；加载更多（`trigger.tsx:16-26`） |
| P2 | **Thread 详情** | `trigger?id=&trigger=` | 一个 Thread 的完整来龙去脉 | `PageHead`（Thread 标题 + 「打开原文」）→ 状态行（来源 / 最近 / 创建）→ 「评估进行中」横幅 → **订阅此线程的工单**（Section）→ **决定**（Disclosure，默认折叠）→ **关联**（Section）→ **时间线**（Section，触发事件流）→ 底部「取消订阅」危险区 | 打开某条 Trigger 对应的工单；展开折叠层 | 「重新评估」（`dt-reveal`，hover 才可见）；「加载更早的触发」；取消订阅（带确认）（`thread.tsx:128-175`） |
| P3 | **Decisions 列表（Eval）** | `eval?filter=&window=` | Eval 的决定流水 | `StatusHead` + 「暂停」横幅 → 5 个 kind Pill（接单与续做 / 停止 / 忽略 / 未完成 / 全部）+ 1 个「仅过去 24 小时」Pill → Decision 行列表 → 「加载更多」 | 打开决定对应的工单（或 Thread） | 切换 kind / 时间窗；加载更多（`eval.tsx:22-40`） |
| P4 | **Execution 列表** | `execution?filter=` | 执行器状态 + Ticket 列表 | `StatusHead` → 状态行（运行 / 排队中 + 「暂停处理 / 恢复处理」按钮）→ 5 个 Ticket Pill（进行中 / 待处理 / 执行中 / 等待新触发 / 已结束）→ Ticket 行列表 → 「加载更多」 | 打开某个 Ticket | 暂停/恢复处理（带确认）；行内「去 X 回答 / 重试 / 打开 Session / 停止」（**仅 `person` 阶段**）（`execution.tsx:27-50`） |
| P5 | **Ticket 详情** | `execution?id=` | 一个工单的授权、输入、订阅、派工 | `PageHead`（工单标题 + 「打开 X 原文」 + 「重试」 + 「打开 Session」）→ 状态行（阶段 / 授权强度 / 发起人 / 更新时间）→ 「待人工决定」横幅 → 受阻/失败横幅 → **授权详情**（Section：触发 / 决定 / 范围 / 事实 / 策略版本）→ **未送达的输入**（Section）→ **订阅的线程**（Section）→ 折叠组（派工 / 执行环境 / 渠道 / 已送达的输入 / 标识）→ 底部「停止」危险区 | 回答问题（跳到来源系统）；重试 | 打开 Thread；打开 Session；展开 4–5 个折叠层；停止（带确认）（`ticket.tsx:128-197`） |
| P6 | **会话（Workbench 右栏）** | `pms?id=` | 任务系统里某个任务的完整对话 | 头部（返回 / 标题 / #号 / 项目 / 状态 / 经办人 / 更新时间 + 「打开工单 / 归档 / 删除」）→ 该任务持有的 Ticket 条 → 任务状态（待分析 / 未处理 / 分析中 / 等你处理 / 已完成）→ 拒绝原因 → **对话**（h3 + 消息气泡列表）→ **回复框** | 发送回复（写入 Redmine 事务，立刻送达 agent） | 归档/取消归档、删除、打开工单、打开 Session（`conversation.tsx:54-93`） |
| P7 | **Thread 行 / Ticket 行 / Decision 行**（跨页复用组件） | — | 列表中的单行 | `rows.tsx:10-102` | 行标题打开详情 | 行内操作、Thread chip 外部链接、折叠的自动消息批次 |

**不在本次范围内但被引用**：`overview.tsx`（Overview 仪表盘与「系统问题」列表）、`source.tsx`（来源状态）、
`pms.tsx`（Workbench 左栏任务列表）。

---

## 2. 问题清单

严重度定义：**High** = 直接让操作者答不出面板的三个问题之一，或让一次操作失败且无反馈；
**Medium** = 让操作者付出额外的寻找/滚动/记忆成本；**Low** = 一致性、措辞、可访问性上的瑕疵。

### 2.1 信息架构

---

**F-01｜Thread 详情把时间线放在最后，页面主角被压在最底下** — High

- **位置**：`src/client/thread.tsx:140-168`。渲染顺序是「订阅此线程的工单」(140) → 「决定」(144) → 「关联」(150) → 「时间线」(156) → 「取消订阅」(169)。
- **发生了什么**：这个页面的存在理由是「追踪一件工作的历史」（`docs/005-panel.md:11`）。但真正的时间线排在四个区块之后，打开页面第一屏看到的是工单列表，而不是触发流。
- **为什么疼**：`docs/005-panel.md:22` 自己写的是「Each Thread shows its **Triggers newest first**, Decisions and Subscriptions」——文档的顺序是 Triggers → Decisions → Subscriptions，代码的顺序是 Subscriptions → Decisions → Correlated → Triggers。文档与实现不一致，而且实现把主角排到了第 4 位。
- **严重度**：High
- **建议修复**：把时间线提到详情页第一位（或做成「时间线 / 决定 / 订阅」三个并列 Tab），让文档顺序与代码顺序一致。

---

**F-02｜Ticket 详情在只有一个派工时完全不显示派工** — High

- **位置**：`src/client/ticket.tsx:167` — `{data.assignments.length > 1 && <Details icon="queue" ...>}`。注释写「A single Assignment adds nothing beyond the status line」。
- **发生了什么**：一次派工是**最常见**的情况。此时派工区整个不渲染，操作者在页面上看不到：哪个 worker 在跑、什么时候开始的、上一次报告是什么、为什么停了。
- **为什么疼**：状态行（`ticket.tsx:137-142`）只有阶段、授权强度、发起人、更新时间，**没有任何派工信息**——注释的前提是错的。而 `docs/011-interaction-scenarios.md:131-134` 记录的第一个走查失败正是「assignment 一直显示『运行中』」：合并通知丢包后，工单卡在「等你处理」，只有派工记录能说明「这一轮其实已经结束了但没人接手」。这条信息恰好是本页唯一能解释故障的证据，而它被藏起来了。
- **严重度**：High
- **建议修复**：派工区恒显示；只有一条时用单行（状态 + 时间跨度 + 报告），多条时用列表。

---

**F-03｜Decisions 列表丢掉了「不匹配的规则」和它们的原因** — Medium

- **位置**：`src/client/rows.tsx:80` — `const matched = decision.rules.filter(rule => rule.matched).map(rule => rule.name)`，第 97 行只渲染 `matched`。
- **发生了什么**：决定的数据里带着每条规则是否匹配、以及理由（`views/records.ts:205`）。列表页只保留**命中**的规则名，**不匹配**的规则和全部理由都被丢弃。
- **为什么疼**：`docs/005-panel.md:23` 说 Eval 页展示「Decisions with their reason and matched rules」，但操作者真正要回答的是「为什么没接」——而那通常恰恰是**没命中**的规则加**准入原因**。这些信息只能在 Ticket 详情页看到（`ticket.tsx:91-92`），而很多 Decision 根本没有 Ticket，于是完全看不到。
- **严重度**：Medium
- **建议修复**：Decision 行加一个可展开的「为什么」层，展示命中/未命中规则 + 理由 + 方向判断（direction）。

---

**F-04｜取消订阅这个动作排在整条时间线之后** — Medium

- **位置**：`src/client/thread.tsx:169-174`（`.dt-danger-zone` 在 `<Section title={t('timeline')}>` 之后）。
- **发生了什么**：线程可能有 50 条触发（`PAGE = 50`，`thread.tsx:67`）。想取消订阅必须滚过全部触发。
- **为什么疼**：`docs/011-interaction-scenarios.md:109` 把「取消订阅一个线程」列为面板动作 6.7，操作者做这件事的路径长度和线程长度成正比。
- **严重度**：Medium
- **建议修复**：把「取消订阅」提到 `PageHead` 的动作区，或在时间线顶部放一个常驻的订阅状态胶囊（点击即取消）。

---

**F-05｜Eval 页能看到「未完成」的决定，却不能「不再提示」它** — Medium

- **位置**：`src/app/api.ts:38` 定义了 `POST decisions/:id/dismiss`；客户端只在 `src/client/overview.tsx:53-54` 用了它。`src/client/eval.tsx:37-38` 的 Decision 行没有任何 dismiss 入口。
- **发生了什么**：`decisionFilter.unavailable`（未完成）这个过滤项存在的唯一理由，就是这些「评估没跑完」的决定——正是 Overview 的「系统问题」列表里带「不再提示」按钮的那些。
- **为什么疼**：同一个对象有两个处置入口，一个在 Overview（不在本次审计的页面清单里、也不在 Eval 页面里）。操作者在 Eval 里看到 20 条「未完成」，必须切到 Overview 去找对应的「系统问题」条目才能消音。两处违反 `docs/005-panel.md:71` 的「One place per concept」。
- **严重度**：Medium
- **建议修复**：Decision 行在 `unavailable` 时带一个行内「不再提示」按钮，直接调用同一接口。

---

**F-06｜所有列表页都不显示总数，操作者无法判断列表是否被截断** — High

- **位置**：服务端 `src/app/views/records.ts:14` 的 `page()` 返回 `{ items, total, next_offset }`；客户端 `src/client/{trigger,eval,execution}.tsx` 只读 `items` 和 `next_offset`，`total` 在整个 `src/client/` 里**一次都没被使用**（全仓 grep `\.total\b` 在 `src/client/` 下零命中）。
- **发生了什么**：列表底部只有一个「加载更多」按钮（`widgets.tsx:118-121`）。操作者不知道还有多少条、也不知道当前 20 条是不是全部。
- **为什么疼**：`docs/005-panel.md:73` 的原则 5 是「A count equals the length of the list it links to」——Overview 仪表盘上的工单计数就是从这里来的。列表页自己却给不出计数，导致「Overview 说 47 个待处理，Eval 列表只有 20 条」这种情况无法判断是分页还是数据不一致。对 `docs/011-interaction-scenarios.md` 里「这个任务为什么没被接」这类问题尤其致命。
- **严重度**：High
- **建议修复**：每个过滤 Pill 带上该过滤下的计数（Overview 的管道图已经会算这个数），列表底部改成「已显示 20 / 共 47」+ 加载更多。

---

**F-07｜过滤条件互不排斥，操作者无法算覆盖关系** — Medium

- **位置**：`src/app/views/threads.ts:16-20` 与 `src/app/views/tickets.ts:35-42`。
  - Thread：`all` 包含全部；`subscribed` = 有活跃工单订阅；`evaluating` = `!!thread.evaluating || awaitingEval(...)` —— **正在评估** ∪ **排队等评估**。
  - Ticket：`open` = `liveTicket(ticket)`（未结束的全部），而 `person` / `working` / `idle` 是 `open` 的**子集**。
- **发生了什么**：过滤条件层层包含，没有一个是排他的。`docs/005-panel.md:70` 的原则 2 明确要求「Categories have checkable definitions, are **mutually exclusive** and cover every case」。
- **为什么疼**：操作者无法回答「这 5 个过滤条件加起来是不是等于全部」。例如「执行中」是 12 条、「进行中」是 12 条、「待处理」是 0 条——「进行中」明显是「执行中」的父集，但 UI 把它们并排画成同级 Pill，没有任何从属提示。
- **严重度**：Medium
- **建议修复**：把 `open` 改成「全部未结束」并在 UI 上标明它包含另外三个；`evaluating` 拆成「评估中 / 排队待评估」两项或改名。

---

**F-08｜「待人工决定」把操作者踢出面板，而面板其实能自己回复** — Medium

- **位置**：`src/client/ticket.tsx:144-148` — 横幅里只有一个外链「去{source}回答」；而 `src/client/conversation.tsx:84-91` 里已经有一个能直接写 Redmine 事务并立刻送达 agent 的回复框。
- **发生了什么**：Ticket 处于「待回答」时，面板不给回复入口，只给一个跳到 Redmine 的链接。
- **为什么疼**：面板的第一个问题是「Does anything need me now?」（`docs/005-panel.md:9`）。需要人回答时，面板把人送走，代价是切窗口、找那条工单、记住回来。工作台（Workbench）路径上有现成的回复能力却没接到这里，两条路径能力不一致。
- **严重度**：Medium
- **建议修复**：Ticket 详情的「待人工决定」横幅内嵌一个与 Workbench 相同的回复框，直接调 `POST pms/:id/reply`。

---

**F-09｜Ticket 详情底部那组折叠层没有自己的标题** — Low

- **位置**：`src/client/ticket.tsx:165` — `<div className="dt-details">` 直接装 4–5 个 `Details`，没有 Section 标题。
- **发生了什么**：从「授权详情 / 未送达的输入 / 订阅的线程」之后，出现一组无名的折叠行。
- **为什么疼**：操作者无法一眼判断「下面这一堆是什么」；`docs/005-panel.md:74` 的原则 6 要求「Keep page explanations to one sentence」，但这里连一个名词都没有。
- **严重度**：Low
- **建议修复**：加一个「详细信息 / Details」Section 标题，或让折叠组成为一张卡片。

---

### 2.2 层级与扫读

---

**F-10｜列表行永远看不到完整标题** — High

- **位置**：`src/client/rows.tsx:21-22`（Ticket 标题）、`rows.tsx:90-91`（Decision 标题）、`rows.tsx:60-61`（Thread 标题）。
- **发生了什么**：`.dt-open` 的样式是 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`（`client.css:101`、`:392`），标题被截成一行；而这三个按钮**都没有 `title` 属性**（Thread 行只挂了 `title={thread.pollError}`，Decision 行只挂了 `title={reason}`）。没有换行、没有展开、没有 tooltip。
- **为什么疼**：工单标题是 `docs/011-interaction-scenarios.md` 里每个场景的主语（「工单只说『用起来很慢』」）。两个长标题只在第 40 个字之后不同的工单，在列表里长得一模一样，操作者只能逐个点开确认——而「哪一条是我要的那个」正是列表页要回答的问题。
- **严重度**：High
- **建议修复**：给所有行标题加 `title`（原生 tooltip），并允许标题最多两行 + 省略号。`.dt-open-wrap`（`client.css:104`，`white-space: normal`）已经存在，Overview 的问题条目（`overview.tsx:18`）已经在用，记录页的行标题还没跟上。

---

**F-11｜Ticket 行的元信息行永不换行，Thread chip 会被静默裁掉** — Medium

- **位置**：`src/client/client.css:393-394` — `.dt-ticket-meta { flex-wrap: nowrap; overflow: hidden; white-space: nowrap; }` 与 `.dt-ticket-meta .dt-chip { flex: none; }`。
- **发生了什么**：一个工单订阅了 3 个线程、chip 里有来源名和事实标签时，meta 行不换行、chip 也不收缩，内容被 `overflow: hidden` 直接切掉，**没有任何视觉提示**。
- **为什么疼**：chip 里装的是「这个工单连着哪个系统的哪条记录」（`rows.tsx:104-116`），是操作者判断工单归属的唯一线索；Thread 行（`rows.tsx:67` 用的是 `.dt-row-meta.dt-line`）里 chip 反而可以收缩、于是变成 chip 内部折叠。两种行、两种裁切方式、两种结果。
- **严重度**：Medium
- **建议修复**：meta 行允许换行，chip 允许收缩并以 `+N` 收尾（显示总数）。

---

**F-12｜Ticket 的「为什么接了这个单」被降级成灰色小字** — Medium

- **位置**：`src/client/ticket.tsx:88-97` — 决定的理由、每条规则的匹配/不匹配理由、方向判断，全部用 `<Hint>` 渲染（`widgets.tsx:36` → `.dt-hint` = 13px + `--dsw-alias-label-tertiary`）。
- **发生了什么**：这些内容在「授权详情」表里以 `dt-kv-stack` 排列，但每个值都是灰色提示文字，和它上方的 `dt-kv dt` 标签（`.dt-kv dt { color: label-tertiary }`）**颜色完全一样**。读起来像标签，不像答案。
- **为什么疼**：`docs/005-panel.md:49` 说「Ticket details show the originating Trigger, Decision and reason」。理由恰恰是这里最该被看见的东西，却被做成了「附注」。
- **严重度**：Medium
- **建议修复**：把理由/规则/方向提到 Section 主体，用正文色 + 左侧标记（类似 `docs/005-panel.md` 里的 `Hint` 但提高一级对比度），键值表只留「范围 / 策略版本 / 授权事实」这类结构化字段。

---

**F-13｜Thread 时间线里「谁说的」比「说了什么」更弱** — Medium

- **位置**：`src/client/thread.tsx:40-42` — 先渲染 `<div className="dt-event-foot"><strong className="dt-event-actor">{actorName(...)}</strong><When at={...}/></div>`，再渲染正文。
- **发生了什么**：`.dt-event-foot` 是 12px + tertiary（`client.css:140`），`.dt-event-actor` 只是把颜色提到 secondary（`client.css:130`）；正文 `.dt-event-text` 是 13px + primary（`client.css:129`）。
- **为什么疼**：追踪「一件工作的历史」时，操作者要的是「谁在什么时候说了什么」。现在这一页里，作者和时间是这两行里最不显眼的信息，而内容本身是唯一醒目的元素。而且 actor / time 与下面的标签行用的是**同一个** `.dt-event-foot` 样式，视觉上无法区分「这是元信息」和「这是状态」。
- **严重度**：Medium
- **建议修复**：作者 + 时间合并成一行 13px 的引言式头部（`张三 · 2 小时前`），标签行单独降级。

---

**F-14｜「重试」在页头，「停止」在页尾；列表里两者又并排** — Medium

- **位置**：`src/client/ticket.tsx:131-134`（Retry 在 `PageHead`）与 `ticket.tsx:192-196`（Stop 在页面最底部的 `.dt-danger-zone`）；而列表行 `src/client/rows.tsx:34-40` 把 Retry 和 Stop 并排放在同一行。
- **发生了什么**：同一个 Ticket 的两个处置动作，在详情页分居首尾，在列表页却并排。列表页只在 `person` 阶段才给这两个按钮（`execution.tsx:46-48` 决定传不传 `onChanged`），所以「执行中」的工单在列表里**连停止都没有**，必须进详情页滚到底才停得了。
- **为什么疼**：操作者在列表里停一个正在跑的工单，要多走两步；进了详情页又要滚过授权详情、输入、订阅、4–5 个折叠层才看到「停止」。
- **严重度**：Medium
- **建议修复**：统一把处置动作放在页面头部的一行里（重试 / 停止 / 打开 Session），停止仍带确认但不再独占页尾。

---

**F-15｜Ticket 详情的四个关键事实全是 12px 灰字** — Low

- **位置**：`src/client/ticket.tsx:137-142` — 授权强度、发起人、更新时间都在 `.dt-row-meta`（12px + `--dsw-alias-label-caption`，`client.css:106`）。
- **发生了什么**：这四个是「授权详情」的摘要，却比页面里任何一个提示文字都小、都淡。
- **为什么疼**：操作者判断「这个工单是谁授权的、授权有多强」只需要扫这一行；现在必须放大或仔细看。
- **严重度**：Low
- **建议修复**：状态行提升到 13px + secondary，或改成一行标签/值的表格。

---

### 2.3 交互与状态反馈

---

**F-16｜「重新评估」这个按钮在静止状态下完全不可见** — High

- **位置**：`src/client/thread.tsx:50-53` — 按钮带 `dt-reveal` 类；`src/client/client.css:135-139` — `.dt-reveal { opacity: 0 }`，只在 `:hover` 或 `:focus-visible` 时 `opacity: 1`；`@media (hover: none)` 才常显。
- **发生了什么**：「重新评估」（Evaluate again）是一个**唯一**能让未决的触发重新进入 Eval 的动作（`views/records.ts:98` 计算 `actions.requeue`），但它默认透明，鼠标不动就完全看不见。触屏设备靠 `@media (hover:none)` 兜住了，键盘用户靠 `:focus-visible` 兜住了——**只有用鼠标扫视的正常操作者看不到它**。
- **为什么疼**：`docs/005-panel.md:47` 把「Evaluate again」列为 Reading individual records 的核心能力（一条没有有效判断的触发可以重试）。一个主路径动作藏在 hover 里，意味着大多数操作者根本不知道它存在。
- **严重度**：High
- **建议修复**：把 hover 显形降级为「次要强调」，按钮本身常驻；或者只对**没有**任何状态的触发常驻。

---

**F-17｜决定区默认折叠，且展开状态不在 URL 里** — Medium

- **位置**：`src/client/thread.tsx:110`（`const [decisionsOpen, setDecisionsOpen] = useState(false)`）与 `thread.tsx:144-149`。
- **发生了什么**：Thread 页面第一次打开时「决定」是折叠的；展开状态是纯组件内 state，不进路由。
- **为什么疼**：这个页面的主题是「一件工作的历史」，决定是其中一环，而它默认看不见、需要点一下才知道里面有什么。返回上一页再进来，展开状态丢失（`route.ts` 只序列化 route 与 stack）。
- **严重度**：Medium
- **建议修复**：决定区默认展开（它的条目通常不多），并把展开状态写进路由 query。

---

**F-18｜面板自己发的回复和人手写的回复长得一模一样** — Medium

- **位置**：`src/client/conversation.tsx:10-12` — `authorName` 只区分 `agent` / `you` / `other`；`src/app/views/pms.ts:252` — `panelNote(notes)` 判定的面板笔记也被标成 `role: 'you'`。
- **发生了什么**：在 Redmine 里手写的笔记、和在面板回复框里发的笔记，服务端都标成 `role: 'you'`，在 UI 里都是右对齐 + 品牌色气泡。
- **为什么疼**：`docs/005-panel.md:41` 明确写「the Source tells its own notes and the panel's notes from a person's by the markers they carry」——这个区分对系统有意义（共享账号时，未标记的人写的是真人输入）。但**面板自己抹掉了这个区分**：操作者看完一段对话，分不清哪句是自己刚在面板里发的、哪句是自己昨天在 Redmine 里写的。
- **严重度**：Medium
- **建议修复**：给面板发出的笔记单独的 role（如 `panel`），气泡角标写「经面板发送」。

---

**F-19｜换页之后焦点落在文档顶部，键盘用户丢失位置** — Medium

- **位置**：`src/client/app.tsx:141-171`（`Pages` 只做 `scrollIntoView` 滚 Tab 条，不移动焦点）；`src/client/widgets.tsx:131-137`（`PageHead` 的返回按钮是页面第一个可聚焦元素）。
- **发生了什么**：操作者激活某行标题 → 路由切换 → 详情页渲染，但焦点仍停留在已被卸载的按钮上，浏览器把焦点重置到 `<body>`。下一次按 Tab 从文档最开头重新走起。
- **为什么疼**：会话（`conversation.tsx`）、Thread、Ticket 三类页面都需要键盘遍历多个动作（重试、展开、回复），每次换页都要重新「进场」。
- **严重度**：Medium
- **建议修复**：路由变化时把焦点移到新页面的 `PageHead` 标题（`tabIndex={-1}` + `focus()`），并用 `aria-live` 播报页面标题。

---

**F-20｜分页不告诉你还剩多少** — Medium

- **位置**：`src/client/trigger.tsx:25`、`eval.tsx:39`、`execution.tsx:49`（`LoadMore`）、`src/client/thread.tsx:162-167`（「加载更早的触发」）。
- **发生了什么**：四处分页入口全部只有一个按钮，没有任何数量。
- **为什么疼**：与 F-06 同源但独立——在 Thread 页上，操作者点「加载更早的触发」之后不知道这条时间线到底有多长，也就无法判断自己看到的「最老的一条」是不是真的第一条。
- **严重度**：Medium
- **建议修复**：按钮文案改成「加载更早的 50 条」/「还有 N 条」。

---

**F-21｜「现在不能回复」这个分支永远不会出现** — Low

- **位置**：`src/client/conversation.tsx:91`（`data.canReply ? <form>… : <p>{t('pmsNoReply')}</p>`）；`src/app/views/pms.ts:278` 永远 `canReply: true`。
- **发生了什么**：服务端的 `canReply` 是常量 `true`，`pmsNoReply`（"这个任务现在不能回复：任务系统未配置或无法访问"）永远不会显示。
- **为什么疼**：不是功能缺失，而是**假分支**——读代码的人会以为这里处理了「来源不可用」，但实际上来源挂了的时候，`pms.ts:144-146` 是把 source error 显示在左栏（`pms.tsx:58`），回复框照样渲染、点了就报错。
- **严重度**：Low
- **建议修复**：要么让 `canReply` 真正跟随 `source.connected`，要么删掉这个分支并在来源错误时禁用发送。

---

**F-22｜派工行里的「打开 Session」按钮永远不渲染** — Low

- **位置**：`src/client/ticket.tsx:64-65` — `{item.ref && item.ref !== ticket.sessionId && <SessionButton …/>}`。
- **发生了什么**：`src/app/views/tickets.ts:79` 给每个已启动的派工写入 `ref: workerSessionId(ticket.id)`（= `` `worker-${ticket.id}` ``，`src/executor/dsh.ts:24`）；而 `src/app/views/records.ts:127` 的 `ticket.sessionId` 也是同一个 `workerSessionId(ticket.id)`。两者恒等，条件恒为假。
- **为什么疼**：死代码。而且它掩盖了一个真实缺口：一个 Ticket 曾经被多个 worker 跑过时（换了 Session），页面只有 Ticket 级的一个 Session 按钮，看不到历史 Session。
- **严重度**：Low
- **建议修复**：删掉这个分支，或者在派工记录上真正显示它当时用的 Session。

---

**F-23｜合并后的时间线只用时间戳排序，丢掉了服务端的同秒排序键** — Low

- **位置**：`src/client/thread.tsx:59-60` — `byTime` 按 `a.at.localeCompare(b.at)` 排序。
- **发生了什么**：服务端 `src/app/views/threads.ts:35` 明确说明游标是 `(at, id)` 成对的，「so triggers sharing the same second (such as the whole seconds of a task system) page deterministically」。客户端合并新旧分页时只按 `at` 排，重排序后同一秒内的顺序可能与数据库顺序不同，且在「已合并」与「未合并」两种状态下可能不同。
- **为什么疼**：Redmine 的记录常常整秒写入，同一秒内的多条触发在时间线上的先后会跳变，而时间戳显示出来完全一样——操作者看不出哪条先到。
- **严重度**：Low
- **建议修复**：合并排序键改为 `(at, id)`。

---

### 2.4 布局与响应式

---

**F-24｜窄容器规则没有覆盖记录页自己的布局** — Medium

- **位置**：`src/client/client.css:237-253`（唯一的 `@container (max-width: 640px)` 块）与 `:419-422`。
- **发生了什么**：窄容器规则只处理了 Tab 条、`.dt-kv`（键值表改单列）、`.dt-grid3`、`.dt-prompt`、`.dt-settings`、`.dt-list > .dt-ticket`（改单列）。Thread 时间线、授权详情里的触发链接、聊天气泡**没有**窄屏适配规则。
- **为什么疼**：`.dt-list > .dt-ticket` 在窄容器下变成单列（`:420`），行内的动作按钮组和标题挤在一列；而 Thread 的时间线仍然是三段式（actor 脚注 → 正文 → 脚注），在 400px 宽的面板里正文被压到很窄的一行。
- **严重度**：Medium
- **建议修复**：为 `.dt-timeline`、`.dt-kv-stack`、`.dt-taskview` 补一套 ≤640px 的容器查询规则。

---

**F-25｜Ticket 详情是一条没有分栏的长单列** — Medium

- **位置**：`src/client/ticket.tsx:128-197`（整页一个 `.dt-main` 列，`.dt-page > .dt-column { max-width: 960px }`，`client.css:7`）。
- **发生了什么**：问题横幅、授权详情、未送达输入、订阅线程、5 个折叠组、停止按钮全部纵向堆叠，面板最宽 960px 也只用一条。
- **为什么疼**：在 960px 宽的面板上，操作者要在一个 960px 宽的列里读 13px 的字，而左右各留 400px 空白。「问题 → 授权 → 输入 → 派工」这四段之间的纵向距离随工单长度线性增长，找「派工跑了几轮」要滚很久。
- **严重度**：Medium
- **建议修复**：详情页改成两栏：左栏「现在要做什么 / 为什么」（问题、阶段、授权），右栏「证据与历史」（输入、派工、订阅、标识）。

---

**F-26｜Workbench 行操作同样 hover 才出现，且窄屏用「返回」代替列表** — Low

- **位置**：`src/client/client.css:468-469`（`.dt-task-actions { opacity: 0 }`，hover/selected/focus-within 才显）、`:505-511`（≤640px 时 `.dt-inbox[data-selected] .dt-inbox-list { display: none }`）。
- **发生了什么**：任务行的归档/删除按钮默认透明；窄屏下选中任务后整个左栏列表被隐藏，只能靠「← 返回列表」回来。
- **为什么疼**：与 F-16 同源，但这里更弱——归档是 `docs/011-interaction-scenarios.md:104` 的动作 6.2，是工作台的主要操作之一。
- **严重度**：Low
- **建议修复**：行操作常驻（图标按钮本就小），或至少在触屏与键盘下常显。

---

### 2.5 文案与术语

---

**F-27｜中文里「工单」同时指 Redmine 问题和 agent 的 Ticket** — High

- **位置**：`src/client/locales.ts:703` — `'term.ticket': ['工单', 'Ticket']`；而工作台那一侧的任务也是 Redmine 工单：`src/client/pms.tsx:64` 渲染 `#{id} {project} {status}`，会话标题 `conversation.tsx:63` 是 Redmine 的 subject。
- **发生了什么**：面板里有两个完全不同的实体，中文都叫「工单」：Redmine 上的 issue（人提的需求）和 agent 内部持有的 Ticket（一次执行）。`docs/011-interaction-scenarios.md:14` 也说「代理接到的每一个工单（指派给 dev 的）」——指的是 Redmine issue；而 `docs/005-panel.md:24` 的「Ticket」也是工单。
- **为什么疼**：操作者在「执行中」标签下看到「工单 #42」，点进去是 agent 的 Ticket；回到工作台看到「工单 #42」，又是 Redmine 的 issue。同一个词，两个 ID 空间，`#42` 长得一样。搜索框的 placeholder 也写「搜索工单、线程、触发或链接」（`locales.ts:104`）。
- **严重度**：High
- **建议修复**：中文里把 agent 的 Ticket 改叫「执行单 / 任务单」或「代理工单」，把 Redmine 的叫「问题 / 需求」，并同步改 `term.ticket`、`pmsTicket`、`searchPlaceholder`。

---

**F-28｜Eval 页的「24 小时」按钮写的是「触发」，过滤的却是决定** — Medium

- **位置**：`src/client/eval.tsx:34` 用了 `t('lastDayOnly')`；`src/client/locales.ts:320` — `lastDayOnly: ['仅过去 24 小时到达的触发 ✕', 'Triggers from the last 24 hours only ✕']`。
- **发生了什么**：这个 Pill 出现在 **Decisions** 页，和 kind 过滤并排，却说着「触发」。更细一层：它传给服务端的 `window=24h` 最终变成 `since`（`src/app/views/threads.ts:90` → `src/app/store-read.ts:62`），过滤条件是「这条决定所依据的**触发**到达于 24 小时内」。
- **为什么疼**：两个问题。第一，字面与所在页面不符；第二，语义比字面还窄——一条**今天**做出的、针对**三天前**触发的决定会被这个过滤藏掉。操作者以为在看「今天的决定」，实际看到的是「今天处理的、其触发在 24 小时内的决定」。
- **严重度**：Medium
- **建议修复**：改成「仅最近 24 小时的决定」并按决定的 `at` 过滤；若确实要按触发过滤，措辞必须写明「其触发在 24 小时内」。

---

**F-29｜「评估中」这个过滤实际还包含「排队等评估」** — Medium

- **位置**：`src/app/views/threads.ts:17` — `filter === 'subscribed' ? live(thread) : !!thread.evaluating || awaitingEval(view, thread).length > 0`；标签 `src/client/locales.ts:285` — `'threadFilter.evaluating': ['评估中', 'Evaluating']`。
- **发生了什么**：`evaluating` 过滤的集合是「正在评估」∪「有触发排队等评估但还没有 owner」。
- **为什么疼**：一个卡在等待评估的线程（`awaitingEval`，`views/records.ts:74-78`）会被标成「评估中」，而它其实**什么都没在跑**。这正是 `docs/011-interaction-scenarios.md:52` 的场景 2.9（模型或服务不可用 → 工单留在待分析）——那种卡住的线程会伪装成正在被处理。违反 `docs/005-panel.md:70` 的原则 2（可检查的定义）。
- **严重度**：Medium
- **建议修复**：拆成「评估中 / 等待评估」两个过滤，或把标签改成「评估中与待评估」。

---

**F-30｜「进行中」和「执行中」在中文里几乎同义，却是两个不同的过滤器** — Medium

- **位置**：`src/client/locales.ts:467` — `ticketFilter.open: ['进行中', 'Open']`；`:469` — `ticketFilter.working: ['执行中', 'Working']`；而 `stage.working`（`:429`）也是「执行中」。
- **发生了什么**：「进行中」(open) = 所有未结束的工单（含待处理、执行中、等待新触发）；「执行中」(working) = 其中 worker 正在跑的那些。两个 Pill 并排，词义重叠。
- **为什么疼**：中文里「进行中」和「执行中」几乎无法区分，操作者点「执行中」看到 3 条，点「进行中」看到 3 条，可能以为点错了。`docs/005-panel.md:24` 的英文表述是 "Open, Pending, Working, Waiting for a Trigger or Ended"，其中 Open 是父集。
- **严重度**：Medium
- **建议修复**：把 open 改称「全部未结束」或「未结束」，并在视觉上标出它包含另外三项。

---

**F-31｜三张列表页用了三种空状态文案，没有一条说清是哪个过滤** — Low

- **位置**：`src/client/trigger.tsx:24` — `t('threadsNone')`（"没有符合条件的线程。"）；`src/client/eval.tsx:38` 与 `src/client/execution.tsx:48` — `t('none')`（"暂无。"）。
- **发生了什么**：三张列表页、两套文案、零个提及当前过滤条件。「已结束」过滤下没有工单，和「已结束」过滤下有 3 条但页面加载失败，屏幕上都是「暂无。」
- **为什么疼**：空状态本来是「解释为什么这里空着」的唯一机会。「忽略」过滤下空，意思和「未完成」过滤下空完全不同，UI 却一样。
- **严重度**：Low
- **建议修复**：空状态写成「{当前过滤} 下没有记录」并给一个切换到「全部」的按钮。

---

**F-32｜「仅过去 24 小时」的标签自带一个 ✕，但它是一个开关** — Low

- **位置**：`src/client/locales.ts:320` — 标签文本结尾是 `✕`；`src/client/eval.tsx:34` 无论激活与否都显示同一段文字。
- **发生了什么**：`✕` 在 UI 里是「清除 / 关闭」的符号，而这是一个可点击的开关；`Pill` 的激活态是靠背景色区分的（`client.css:276`），文字里再放一个 ✕ 只会让人以为它已经生效或可以关掉某些东西。
- **严重度**：Low
- **建议修复**：去掉字面里的 ✕，激活与否交给 Pill 自身的高亮；或改成「24 小时 ✕」并只在激活时显示 ✕。

---

### 2.6 视觉系统一致性

---

**F-33｜两套状态词汇互相矛盾：灰点配红标签** — High

- **位置**：`src/client/marks.ts:49-56`。
- **发生了什么**：`Mark` 同时带 `dot`（5 态：`done|warning|ongoing|error|idle`）和 `tone`（7 态标签色），两者**独立赋值**。结果：
  - `stop`（停止）= `dot: 'idle'`（灰）+ `tone: 'danger'`（红）
  - `wouldAccept`（观察模式下本会接单）= `dot: 'idle'`（灰）+ `tone: 'warning'`（琥珀）
  - `ignore`（忽略）= `dot: 'idle'`（灰）+ `tone: 'neutral'`（灰底）
  - `ticketMark` 的 `ended` = `dot: 'idle'` + `tone: 'neutral'` + `icon: 'stop'`
  - `ticketMark` 的 `person/answer` = `dot: 'warning'` + `tone: 'warning'`，但 `person/failed` = `dot: 'error'` + `tone: 'danger'`——**只有 failed 这一档两个系统才一致**。
- **为什么疼**：一个「停止」的决定，在列表行左侧画一个灰色圆点（.dt-state-dot[data-state=idle]，`client.css:299`），标题旁却挂一个红标签。灰色 = 「无事发生」，红色 = 出事了。操作者看到的是矛盾信号，必须先读懂文本才能决定信哪个。
- **严重度**：High
- **建议修复**：把 `dot` 与 `tone` 绑成一张表（一个语义状态 → 一组 {dot, tone, icon}），`mark()` 只做一次查表，禁止两处独立赋值。

---

**F-34｜状态由 8 个不同颜色令牌承担，其中 3 个不是状态色** — Medium

- **位置**：`src/client/client.css`。
- **发生了什么**：在这几页里承担状态语义的颜色有 8 个：
  1. `--dsw-alias-state-success-primary`（301、407、466）
  2. `--dsw-alias-state-warn-primary`（302、388、407）
  3. `--dsw-alias-state-error-primary`（303、389、408）
  4. `--dsw-alias-state-business-primary`（409、463、495）
  5. `--dsw-alias-state-idle-primary`（299）
  6. `--dsw-alias-label-tertiary`（`.dt-task-state[data-state='declined']`，465）
  7. `--dsw-alias-label-secondary`（`.dt-taskview-ticket-stage` 默认态，483）
  8. `--dsw-alias-brand-primary`（`.dt-chat-msg[data-role='you']` 气泡，497；`.dt-rule-dot[data-enabled]`，170）
- **为什么疼**：`state-*` 这一族是 5 个语义色，但「未处理（declined）」用灰 tertiary、「工作阶段的 Ticket」用灰 secondary、「你自己说的话」用品牌蓝。同一屏里状态色与品牌色、状态色与中性灰混用，操作者无法建立「这个颜色 = 这类状态」的稳定映射。
- **严重度**：Medium
- **建议修复**：定义 5 个状态色到语义的唯一映射，所有状态只从这 5 个里取；品牌蓝只用于「可点击/归属你」，不用于状态。

---

**F-35｜这几页用了 8 种字号，其中 5 种挤在 11–13px** — Medium

- **位置**：`src/client/client.css` 全量 `font-size` 取值：`11, 12, 13, 14, 15, 16, 17, 20, 22, 28px`。
- **发生了什么**：在本审计范围内的页面上实际出现的是 **8 种**：11（`.dt-tag` 266、`.dt-chip` 348、`.dt-chat-meta` 493、`.dt-chat-link` 498、`.dt-chat-hint` 504、`.dt-task-*` 460-467）、12（`.dt-event-foot` 140、`.dt-row-meta` 106、`.dt-stage` 405、`.dt-mono` 150、`.dt-pill` 274、`.dt-table` 378、`.dt-btn-sm` 259、`.dt-taskview-*` 480-487）、13（`.dt-hint` 23、`.dt-event-text` 129、`.dt-row-quote` 107、`.dt-kv` 122、`.dt-chat-text` 496、`.dt-disclosure-row` 310、`.dt-plain-list` 203 等）、14（`.dt-btn` 255、`.dt-row-title` 100、`.dt-open` 101、`.dt-tab` 278、`.dt-input input` 290）、15（`.dt-title` 13、`.dt-status-title` 339）、16（`.dt-taskview-subject` 479、`.dt-block-title` 18）、17（`.dt-page-title h2` @640px，242）、20（`.dt-page-title h2`，201）。22/28px 只在 Overview 仪表盘，不在范围内。
- **为什么疼**：同一屏上出现 11/12/13/14 四档正文级字号，差 1px 的层级没有语义差别却制造视觉噪音；中文在 11px 下可读性明显下降。另外页面标题在宽窄两种布局下是 20px / 17px 两个值（201 与 242），字号随容器变化而不是随层级变化。
- **严重度**：Medium
- **建议修复**：正文收敛到 3 档（13 / 14 / 16）+ 1 档辅助（12）；标签与元信息统一 12；去掉 11px。

---

**F-36｜标签有 7 种 tone，其中 3 种在视觉上都是「很安静的灰」** — Low

- **位置**：`src/client/controls.tsx:62` — `TagTone = 'outline' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'`；`src/client/client.css:267-273`。
- **发生了什么**：`outline`（描边 + tertiary）、`neutral`（模块底色 + secondary）、`quiet`（纯 tertiary 文字）三种都属于「不强调」，但需要记住哪条对应哪个。
- **为什么疼**：`thread.tsx:17` 用 `neutral` 表示「已过滤」，`thread.tsx:22` 用 `info` 表示「已送达」，`rows.tsx:48` 用 `quiet` 表示「仅作上下文」——三个语义完全不同的状态，用了三种视觉近似的标签，操作者很难在扫读时区分。
- **严重度**：Low
- **建议修复**：把 `outline`/`neutral`/`quiet` 合并成两个（实心/描边），或者给「仅作上下文」这类真正需要区分的标签一个专属形状。

---

### 2.7 可访问性

---

**F-37｜三张列表页的过滤条没有分组语义（工作台做对了）** — Medium

- **位置**：`src/client/trigger.tsx:18-21`、`eval.tsx:28-35`、`execution.tsx:39-43` 都是裸的 `<div className="dt-filters">`；对照 `src/client/pms.tsx:61` — `<div className="dt-inbox-filters" role="group" aria-label={t('pmsFilters')}>`。
- **发生了什么**：Pill 本身有 `aria-pressed`（`controls.tsx:68`），这点是对的；但 Trigger/Eval/Execution 的过滤组没有 `role="group"` 和可访问名。
- **为什么疼**：屏幕阅读器用户在这三个页面听到的是一串互不相关的按钮（「已被订阅」「评估中」「24 小时内有新触发」「全部线程」），不知道它们是一组互斥选项、也不知道当前选中的是哪个语义位置。工作台的同一模式做对了，说明这是遗漏而不是设计。
- **严重度**：Medium
- **建议修复**：给三处 `.dt-filters` 加 `role="group"` + `aria-label`，并改用 `role="tablist"`/`aria-selected`（它们本来就是互斥视图切换）。

---

**F-38｜截断的标题没有可访问的完整名字** — Medium

- **位置**：`src/client/rows.tsx:21-22`（Ticket 标题）、`rows.tsx:90-91`（Decision 标题）——按钮内只有被 CSS 截断的文本，没有 `title`、没有 `aria-label`。
- **发生了什么**：视觉上标题被 `text-overflow: ellipsis` 截断（F-10），辅助技术读到的也是被截断的那份文本。
- **为什么疼**：这是 F-10 的可访问性半边——不只是鼠标用户看不到全名，屏幕阅读器用户也拿不到。
- **严重度**：Medium
- **建议修复**：按钮加 `title={fullTitle}`（原生 tooltip 同时服务视觉与辅助技术），并允许两行显示。

---

**F-39｜被裁掉的 Thread chip 没有任何替代读取途径** — Medium

- **位置**：`src/client/client.css:393-394`（F-11）。
- **发生了什么**：chip 里的来源名与事实标签被 `overflow: hidden` 裁掉；`.dt-chip` 内部 `flex-wrap: wrap` + `overflow: hidden`（348），内容也是直接裁的，没有 title 属性兜底。
- **为什么疼**：读屏用户能读到被裁掉的 DOM（因为它还在文档树里），但视觉用户完全拿不到——两种用户看到的信息量不同，恰好是「视觉优先」产品最常出问题的地方。
- **严重度**：Medium
- **建议修复**：chip 加 `title`（完整 facts），或改为「+N」徽标并在 tooltip 里列全。

---

**F-40｜折叠层的标题不是标题，无法用标题导航到达** — Medium

- **位置**：`src/client/controls.tsx:154-169` — `DisclosureRow` 渲染 `<div className="dt-disclosure-row" role="button" tabIndex={0} aria-expanded={open}>`，标题是一个 `<span className="dt-disclosure-title">`。
- **发生了什么**：本页所有「决定」（`thread.tsx:144`）、「派工 / 执行环境 / 渠道 / 已送达的输入 / 标识」（`ticket.tsx:167-190`）的标题都不是 heading。而 `Section` 的标题**是** `<h2>`（`widgets.tsx:28`）。
- **为什么疼**：屏幕阅读器用户用「按标题跳转」来扫页面，在 Thread 页只能跳到「授权详情 / 订阅的线程 / 时间线」，跳不到「决定」；在 Ticket 页跳不到任何一条折叠项。同时 `role="button"` 的 div 被读成一个按钮，标题语义完全丢失。
- **严重度**：Medium
- **建议修复**：`DisclosureRow` 的标题改成 `<h3>`（或加 `role="heading" aria-level="3"`），按钮语义放在里面的 `<button>` 上。

---

**F-41｜11px 的正文级文字出现在 13 个元素上** — Low

- **位置**：`src/client/client.css` 的 266、348、460、461、462、467、493、498、504、53、167、431、440 行。
- **发生了什么**：11px 被用在标签、chip、会话元信息与链接、任务行元信息、任务状态、规则预览等处。
- **为什么疼**：11px 的中文（尤其带灰度低的 tertiary 前景色）在 2× 缩放或笔记本上基本不可读，而这些元素恰好承载「谁说的 / 什么时候 / 什么状态」。
- **严重度**：Low
- **建议修复**：元信息统一 12px；真正需要更小的地方（如 chip 内的次要标签）保留 11 但换用更高对比度的前景色。

---

**F-42｜回复框只有 placeholder 当名字** — Low

- **位置**：`src/client/conversation.tsx:85` — `aria-label={t('pmsReplyPlaceholder')} placeholder={t('pmsReplyPlaceholder')}`。
- **发生了什么**：placeholder（"回复会作为备注发到 Redmine…"）同时充当可访问名。
- **为什么疼**：placeholder 一旦有输入就消失，且它是祈使句不是名词短语；读屏用户听到的是一个指令而不是「回复框」。
- **严重度**：Low
- **建议修复**：加一个可见或视觉隐藏的 `<label>`（如「回复」），placeholder 只留示例。

---

### 2.8 空状态与错误状态

---

**F-43｜列表页的错误只是一行红字，没有重试入口** — Medium

- **位置**：`src/client/widgets.tsx:113-117` — `LoadState` 只渲染 `<p className="dt-error" role="alert">{error.message}</p>`；调用点 `trigger.tsx:22`、`eval.tsx:36`、`execution.tsx:45`。
- **发生了什么**：因为 `usePoll`（`api.ts:81-84`）在出错时**保留上一次的数据**，页面会同时显示「一行红字错误」和「一份可能已经过期的列表」，两者中间没有任何分隔或时间说明，也没有「重新加载」按钮。
- **为什么疼**：操作者分不清红字是在说「整页失败」还是「某一条失败」，更不知道列表里的数据是刚才的还是几分钟前的。`docs/005-panel.md:74` 的原则 6 说「Problems must be actionable」。
- **严重度**：Medium
- **建议修复**：错误时给一个「重新加载」按钮，并在有陈旧数据时标注「数据更新于 X」。

---

**F-44｜「找不到记录」不说是哪一条找不到** — Low

- **位置**：`src/client/ticket.tsx:112-114`、`thread.tsx:116-118`。
- **发生了什么**：Ticket 不存在时，页面标题是通用的「工单」（`t('term.ticket')`），正文是「工单不存在」。
- **为什么疼**：操作者是从深链进来的（从 Overview 或搜索结果），此时页面既不回显他点的那个 id，也没有「回到列表」的按钮（只有 `PageHead` 的返回箭头，标签是上一个页面的名字）。
- **严重度**：Low
- **建议修复**：标题回显 id（`工单 #42`），正文给出「回到工单列表」按钮。

---

**F-45｜Thread 的轮询错误夹在页头和状态行之间，像一条孤立的红字** — Low

- **位置**：`src/client/thread.tsx:139` — `<p className="dt-error dt-clamp">{t('pollFailed', { error: data.pollError })}</p>`，位于 `dt-status-line`（131-134）之后、订阅工单之前。
- **发生了什么**：这是「Source 收不到这个会话的消息了」这件事——在 `docs/005-panel.md:45` 里被定义为必须解释清楚的状态（「The Source page explains whether its conversation disappeared or the Source stopped listening to it」）。但这里只有一行 3 行截断的红字。
- **为什么疼**：操作者无法区分「源暂时轮询失败」和「这个对话已经死了」。后者意味着这个 Thread 永远不会再有新触发——是一个需要人工处理的终态。
- **严重度**：Low
- **建议修复**：把轮询失败提升成带说明的横幅，写清「这不会影响已送达的消息 / 源停止监听后新触发不再到达」。

---

## 3. 做得好的地方（改版要保留）

1. **状态映射集中在纯函数模块** — `src/client/marks.ts`（57 行）把 Ticket / Thread / Decision / Source 的状态统一映射成 `{label, tone, dot, icon}`。改版应该保留这个结构，但按 F-33 把 `dot` 与 `tone` 合成一张表。
2. **状态从不只靠颜色表达** — `StageMark`（`widgets.tsx:109-111`）永远是「图标 + 文字」，`Dot` 带 `role="img"` + `aria-label`（`controls.tsx:149-152`）。色觉障碍用户不丢信息。
3. **破坏性操作一律走确认弹窗** — `ConfirmButton`（`widgets.tsx:75-95`）→ `Modal`（`controls.tsx:183-215`）带焦点陷阱、Esc 关闭、关闭后焦点归位。暂停处理、重试、停止、取消订阅、删除任务全走这一条路径，符合 `docs/005-panel.md:74`「Destructive actions require confirmation」。
4. **`When` 的时间显示** — `widgets.tsx:12-15` 用 `<time dateTime>` + 相对时间 + 绝对时间 tooltip，同时照顾扫读与精确查询。
5. **`DisclosureRow` 的键盘可达性** — `controls.tsx:158-159` 支持 Enter/Space，`aria-expanded` 正确。（标题不是 heading 的问题见 F-40。）
6. **自动消息成批折叠** — `rows.tsx:120-128` 的 `automatedRuns` 把同一来源的连续自动消息收成一条，并保留「更早的 N 条」展开（`rows.tsx:129-140`）。这是这批页面里最有效的降噪手段。
7. **Thread 时间线的连续性合并** — `thread.tsx:63-107`：轮询、深链 `target`、手动翻页三种来源的触发会被去重、按时间归并，并在发现空洞时自动补页。这段逻辑相当扎实，改版应保留。
8. **深链定位与高亮** — `thread.tsx:34-39`：被指向的触发会 `scrollIntoView` 并加 `dt-highlight`，配合 `id={trigger-${id}}` 可直接外链到某一条触发。
9. **`MarkdownLite` 安全渲染** — `widgets.tsx:51-60` + `src/client/markdown.ts` 只解析标题/列表/加粗/行内代码/链接，**从不解释原始 HTML**。
10. **标记清洗** — `src/app/views/text.ts:4-6` 的 `withoutHtml` 会剥掉 HTML 注释与标签，agent 的 `<!-- dsh-superagent:… -->` 内部标记不会漏进面板（`docs/011-interaction-scenarios.md:135` 记录的 Gerrit 侧泄漏是另一条链路）。
11. **动作反馈统一** — `useAction`（`provider.tsx:42-56`）给每个异步动作统一的 busy 态、失败 toast 和可选的 reload；`usePoll`（`api.ts:67-98`）保留上一次成功数据、文档隐藏时退避、丢弃过期响应。
12. **轮询不打断输入** — `usePoll` 在响应未变化时跳过 setState（`api.ts:81`），会话页 4 秒轮询不会打断正在输入的回复。
13. **整行可点但只有一个焦点** — `.dt-open::after` 覆盖整行（`client.css:102`），点击别处也能打开，但键盘 Tab 只有一个落点。
14. **上下文订阅被显式标注** — `rows.tsx:46-49` 的 `ContextTag` + `contextOnlyHint` 明确区分「只看不授权」的线程订阅。
15. **单条动作有防抖** — `useAction` 用 `running` ref 防重入（`provider.tsx:49-50`），连点「重新评估」不会重复提交。

---

## 4. 量化指标

### 4.1 过滤状态数

| 页面 | 过滤器 | 状态数 | 依据 |
|------|--------|--------|------|
| Trigger 列表 | 已被订阅 / 评估中 / 24 小时内有新触发 / 全部线程 | **4** | `src/app/api.ts:14`（`THREAD_FILTERS`） |
| Eval 列表 | 接单与续做 / 停止 / 忽略 / 未完成 / 全部 | **5** | `src/client/api.ts:100`（`DECISION_FILTERS`） |
| Eval 列表 | ×（无 24 小时窗口 / 有 24 小时窗口） | **×2** | `src/client/eval.tsx:34`；窗口与 kind 正交，两者可组合 |
| Execution 列表 | 进行中 / 待处理 / 执行中 / 等待新触发 / 已结束 | **5** | `src/app/api.ts:13`（`TICKET_FILTERS`） |
| **合计（这三页）** | | **19** | 4 + 5×2 + 5 |

补充：这三个过滤集合**都不互斥**（F-07）：`all` ⊇ 其它、`open` ⊇ `person`/`working`/`idle`。
另外，工作台左栏另有 3 个（待处理 / 未处理 / 已归档，`route.ts:11`），不在本次范围内，合计则为 22。

### 4.2 详情页的折叠层级

| 页面 | 第 1 层折叠 | 第 2 层折叠 | 最大嵌套深度 | 折叠项总数 |
|------|-----------|-----------|-----------|-----------|
| Thread 详情 | 1（决定，`thread.tsx:144`，默认关） | 每个自动消息批次 1 个「更早的 N 条」（`rows.tsx:129`）+ 每条长文本 1 个「展开」（`widgets.tsx:61`） | **2** | 1 + （触发条数） |
| Ticket 详情 | 4–5（派工 / 执行环境 / 渠道 / 已送达的输入 / 标识，`ticket.tsx:165-191`） | 「已送达的输入」内每个自动批次 1 个「更早的 N 条」 | **2** | 4–5 + （输入条数） |
| Eval 列表 | 0 | — | **0** | 0 |
| Execution 列表 | 0 | — | **0** | 0 |
| 会话 | 0（回复框常驻） | — | **0** | 0 |

最大嵌套深度 = **2 层**。但第 2 层的数量随记录条数线性增长，且 Thread 页的「决定」默认折叠（F-17）。

### 4.3 状态颜色编码数

- **Dot 状态（`controls.tsx:140`）**：5 — `done` / `warning` / `ongoing` / `error` / `idle`
- **标签色（`controls.tsx:62`）**：7 — `outline` / `neutral` / `quiet` / `success` / `info` / `warning` / `danger`
- **阶段色（`client.css`）**：3 种命名空间，4 套取值 — `.dt-stage[data-state]` 3 个（warning/error/ongoing）、`.dt-task-state[data-state]` 4 个（working/waiting/declined/ended）、`.dt-taskview-ticket-stage[data-state]` 1 个（person）、`.dt-live[data-state]` 4 个（running/paused/down/unconfigured）
- **实际承担状态语义的颜色令牌**：**8 个**（F-34 列表）
- **不一致处**：6 个决定结果中有 **2 个** 的 dot 与 tone 互相矛盾（`stop` 灰点红标、`wouldAccept` 灰点琥珀标）——见 F-33

### 4.4 字号数

- 全量 CSS 中出现的 px 字号：**10 种** — 11 / 12 / 13 / 14 / 15 / 16 / 17 / 20 / 22 / 28
- **本次审计范围内出现的：8 种** — 11 / 12 / 13 / 14 / 15 / 16 / 17 / 20（22 与 28 仅用于 Overview 仪表盘的 `.dt-station-count`、`.dt-live-figure`）
- 其中 11–13px 共 **3 档**、承载了绝大多数正文与元信息；11px 被 **13 个** 元素使用
- 等宽字体另有一档：`.dt-mono` 12px、`.dt-code` 12px、`.dt-pre` 12px

### 4.5 每行的内联操作按钮数

| 位置 | 可交互控件数 | 其中行内动作按钮 | 备注 |
|------|------------|--------------|------|
| Execution 列表 · `person` 阶段 Ticket 行 | 标题 1 + Thread chip 0–N + **4** | **4** | 去 X 回答 / 重试 / 打开 Session / 停止（`rows.tsx:31-41`） |
| Execution 列表 · `working`/`idle` 阶段 Ticket 行 | 标题 1 + chip 0–N + **0** | **0** | `onChanged` 未传 → 整个动作块不渲染（`execution.tsx:46-48`） |
| Eval 列表 · Decision 行 | 标题 1 + **0** | **0** | 无行内动作；「不再提示」只在 Overview（`rows.tsx:86-101`） |
| Trigger 列表 · Thread 行 | 标题 1 + 外部 chip 1 + **0** | **0** | 无行内动作 |
| Thread 详情 · 触发条目 | **2** | **2** | 查看工单 / 重新评估（后者 hover 才显，`thread.tsx:46-54`） |
| Ticket 详情 · 头部 + 尾部 | 头部 **3** + 尾部 **1** | **4** | 打开原文 / 重试 / 打开 Session ‖ 停止（`ticket.tsx:129-135`、`:192-196`） |
| Ticket 详情 · 派工行 | **1**（死代码） | **1** | `ref !== sessionId` 恒为假，永不渲染（F-22） |
| 工作台 · 任务行 | **2**（hover 才显） | **2** | 归档 / 删除（`pms.tsx:26-31`） |
| 会话 · 头部 | **3 + 2** | **3** | 打开工单 / 归档 / 删除 ＋ 返回 / 打开 Session（`conversation.tsx:59-74`、`:76`） |

**峰值：单个列表行最多 4 个行内动作按钮**（Execution 的 `person` 阶段 Ticket），加上标题按钮与 N 个 chip，该行共有 5+N 个可交互控件。

### 4.6 其他

- **触发列表初始批量**：20（`trigger.tsx:12`）；Eval 决策列表 30（`eval.tsx:17`）；Ticket 列表 20（`execution.tsx:18`）；Thread 时间线 50（`thread.tsx:67`）
- **轮询间隔**：列表/详情 5000ms（`api.ts:67`），会话 4000ms（`conversation.tsx:38`）
- **详情页长宽比**：`dt-page > .dt-column` 最大 960px（`client.css:7`），**始终单列**
- **断点**：唯一的容器断点 `@container (max-width: 640px)`（`client.css:237`、`:419`、`:505`）+ 两个 `@media (hover:none)`（`:137`、`:512`）+ 两个 `@media (prefers-reduced-motion)`（`:91`、`:332`）。**没有任何按宽度重排记录页内部的规则**（F-24）

---

## 5. 改版时优先处理的 8 件事（按严重度）

1. **F-33 / F-34** — 把 dot 与 tone 合成一张状态表，状态色收敛到 5 个语义令牌。
2. **F-27** — 中文术语里把「工单」拆成 Redmine 问题与 agent Ticket 两个词。
3. **F-02 / F-16** — Ticket 恒显示派工；「重新评估」不再 hover 才现。
4. **F-06 / F-07** — 过滤 Pill 带上计数，并让过滤互斥或显式标注包含关系。
5. **F-01 / F-10 / F-11** — Thread 时间线提到首位；行标题完整可见；meta 行可换行。
6. **F-12 / F-28 / F-30** — 把「为什么」抬成正文级内容；统一 24 小时与「进行中/执行中」的措辞。
7. **F-37 / F-38 / F-40 / F-19** — 过滤条分组语义、标题完整可访问、折叠标题变 heading、换页移动焦点。
8. **F-08 / F-25** — Ticket 详情改两栏，并把「待回答」直接接上面板的回复能力。

# 005 Panel

Open **Superagent** in the DeepSeek Harness Web sidebar to supervise the agent. The panel prioritizes work that needs a person, then system health and history. This document builds on [000 Philosophy](000-philosophy.md) through [004 Prompts](004-prompts.md).

## Three questions

Opening the panel answers three questions, in this order:

1. Does anything need me now?
2. Is the system healthy and doing the right things?
3. What is the history of one piece of work, from Trigger through Eval to Ticket?

## Tabs

The panel has three destinations, and each opens one page: **任务工作台** (the operator's own tasks), **流水线** (the flow of the agent's work) and **设置**. The flow page holds its sections below the chart — **来源**, **触发**, **评估** and **执行** — so a station of the chart and the list it opens share one page instead of a row of tabs.

| Destination | Shows |
| --- | --- |
| 任务工作台 Task workbench | The task inbox of the operator: the task system's issues assigned to the bound account, filtered as 等你处理, 处理中, 未处理 or 已归档, with the state of each task, the Ticket the agent holds and the conversation about the issue. Archive and delete manage this list, never the task system |
| 流水线 Flow | The pipeline of the agent's work: every station's count, what it counts and the window it covers. Below it, the section the station names, and the system problems, each with the step that fixes it |
| 来源 Source | Source state, setup problems and non-zero counts. Filtered Triggers and dropped messages cover the same 24-hour window as the pipeline |
| 触发 Trigger | Threads filtered by Subscribed, Evaluating, New Triggers in 24 h, or All Threads. Each Thread shows its Triggers newest first, Decisions and Subscriptions |
| 评估 Eval | Decisions with their reason and matched rules |
| 执行 Execution | Executor state, Pause processing, and Tickets filtered by Open, Pending, Working, Waiting for a Trigger or Ended. Ticket details show actions, authorization, waiting Inputs, Subscriptions and Assignments |
| 设置 Settings | Sources, Eval, Execution, Prompts and Deployment. Each group includes its save history |

The panel has three destinations, and each opens one page: **任务工作台** (the task inbox), **流水线** (the flow) and **设置**. None of them carries a row of tabs. The task inbox says which tasks wait for a person, so a second list beside it would only repeat itself; the flow page says where the work is, so its chart is the map and the section a station names appears below it.

The page follows the browser: the column takes the width it is given, with 16 to 32 pixels of margin on each side, so the work in the middle fills the window instead of sitting in a narrow column with wide margins.

### The command palette

⌘K (Ctrl K elsewhere) opens a palette from anywhere in the panel. It holds the panel's destinations — the three
groups and their pages — and the actions an operator reaches for most: **暂停处理** / **恢复处理** and **打开主 Session**.
Typing filters by the label; ↑ and ↓ move the selection, Enter runs it, Escape closes it. The one number it shows is
the work that waits for a person, read from the same snapshot as the rail, and it is left out entirely when that
snapshot could not be read — a stale count is worse than no count. The panel's global search field in the header
still searches work; the palette moves you there.

### The signal rail

Above every page stands the rail, which answers the first two questions at a glance. It shows the live state — **运行中**, **已暂停**, **有问题** or **还没有配置** — the work that waits for a person (**4 等你处理**, which opens the list that holds it), the queue, the Executor's worker slots (**2/4 个工作槽**) with their pips, and the switch that stops the agent (**暂停处理** / **恢复处理**). The rail and the Overview read one snapshot of the system, so the two never show different numbers; when the last read failed, the rail says the data may be out of date.

### The task inbox

The Inbox is the operator's task inbox: the task system's issues assigned to the bound account. Its filters are the states a task stands in and never overlap — **等你处理** (the Ticket waits for a person), **处理中** (the agent holds it), **未处理** (the route declined it, with its reason) and **已归档** (the operator's own list). Every row carries the state anyway, so the filter and the row never disagree.

It is the panel's first page, and the rail's **等你处理** count opens its 等你处理 filter — the count is the number of tasks in that list, so the two can never disagree. The Tickets themselves are listed in the 执行 section of the flow page, which is where the work of the agent is.

The pipeline chart, on the 流水线 page, has seven stations, 来源 → 触发 → 评估中 → 工单 → 执行中 → 等人 → 完成. Each station says **what it counts** and **the window it covers**, because the stations measure different things and their numbers are not comparable: the 来源 the panel listens to, the 会话 the Triggers became, the 会话 under evaluation, the 工单 that are open, the 工单 the agent is working on, the 工单 that need a person, and the 工单 ended in the last 24 hours. Its head carries the legend **进行中**、**等人**、**已完成** and **更新于 现在**; the connectors between stations animate while the upstream station has work and processing runs.

Every station opens the section that holds the work it counts, and the section appears below the chart — the chart stays where it is, and the name of the station is the name of the section: **来源** the Sources, **触发** the Threads, **评估中** the Threads under evaluation, and **工单**、**执行中**、**等人** and **完成** the Tickets. The number on a station is the number of rows the section below it lists, so the two can be checked against each other. The 触发 section says how many Threads it holds, the number the chart shows, so the two can be checked against each other. The sections are reached from anywhere with ⌘K, which lists each of them.

Below the chart and its section, the system problems — a setup that failed, a Source that is down, an Eval that never decided, a message that keeps failing — each with the step that fixes it.

### The workbench

The workbench is the operator's task inbox. It lists the task system's issues assigned to the bound account — the work the agent takes — as **待处理** (waiting for the judgement, worked on, or waiting for the person), **未处理** (the route judged the task and did not take it, with the reason it gave) and **已归档** (the operator's own list), each row showing its id, its project, its status and the state the task stands in. A row the agent holds a Ticket for is marked with the Ticket. **归档** moves a task out of 待处理, **删除** hides it from every list, and both change only what the workbench shows: the task system is untouched, and a Ticket that works on the task continues.

The state of a task comes from what the agent did with it: a task nobody judged yet is **待分析**, a task the route declined is **未处理**, a task with an open Ticket is **分析中** or **等你处理** (the Ticket waits for a person), and a finished Ticket is **已完成**. The state is read from the Ticket the agent holds and from the last decision of the issue's thread, so it says why a task was not taken.

The page opens the first task of the current view by itself, so coming back to it costs no click; changing the filter opens the first task of that view. A task the operator closed stays closed, so the list can be read on its own.

Selecting a task opens the conversation about it: the issue's description and journals, rendered as Markdown rather than as its source, with their authors and times. It reads like a chat: the agent speaks on the left, the people on the issue and the operator on the right, so the exchange is easy to follow. The head shows the task's project, status and assignee, and the one link into the task system — no message carries a link of its own.

The messages sit in a well of their own — a ground deeper than the surface around them, with a hairline at its edge — so a long exchange reads as one box that scrolls, not as text floating on the page. The bubble of a message takes a little of the theme's own text colour, so it reads as a bubble in the dark theme and in the light one alike.

The conversation is a box of its own, with its own scroll: the head, and with it the link into the task system, stays where it is while the messages scroll, and the reply box stays at the bottom of the box. The task inbox fills the page, so nothing above the conversation ever moves out of reach. A Ticket the agent holds shows its stage, its change and a button that opens the agent's Session. The task's own state is on its row in the list, so the detail does not repeat it; only where the list is out of sight — a narrow window — does the detail say the state itself. The composer sends a reply as a note on the issue, and the Source delivers it to the agent at once, so the work continues without waiting for the next poll; when that hand-off fails, the note stays a note and the Source delivers it on the next poll, so an instruction is never lost. Because the agent and the operator may share one account, the Source tells its own notes and the panel's notes from a person's by the markers they carry: on a shared account the operator's unmarked notes are human input.

### Reading individual records

A dropped message links to its Ticket, or to its Thread when it has no Ticket. The Source page explains whether its conversation disappeared or the Source stopped listening to it.

A human follow-up still owned by an Executor is marked **Delivered to Ticket**, without an Eval. The Thread also shows hand-back reasons and context-only Subscriptions. **Evaluate again** can send that follow-up to Eval, or retry a Trigger with no effective judgement: one filtered by its Source, an unavailable Eval, or a delivered message with neither a non-stop Decision nor an Executor acknowledgement.

Ticket details show the originating Trigger, Decision and reason, scope and Policy version. Assignments and secondary details are folded below the immediate actions. **Retry** is available for failed Input delivery or a Ticket waiting for a person after a blocked or failed Report. Ended Tickets show outcomes such as **Change submitted** or **Stopped by a person**.

## Settings groups

- **Sources:** one card per Source with its switch, fields and verified account facts, in the order the work arrives: **Redmine** first, the task system that carries the work, then **Gerrit**, the review server, then Feishu. Redmine offers receive-all switches for new issues and for their discussion, and Gerrit for review comments and change messages. Polling and read limits are under Advanced. Redmine's card asks for the address and the API key alone — the account the key belongs to is read from the task system itself, and every project that account can see is watched. Gerrit's card asks for the web address, the account, the commit email and the SSH private key, in that order: the SSH address the agent pushes to follows from the web address, the branch the patches go to is the branch of the change the ticket works on, and the HTTP credential the review comments are read with belongs in the environment variable `DSH_SUPERAGENT_GERRIT_TOKEN`.
- **Eval:** the Policy version and rules, followed by **On each Source** and the Eval settings. Feishu keeps its allowed list, membership sync and bot list; Redmine and Gerrit admit by relation and keep no list — their tabs show only the explicit-request description and an admission table whose rows decide what a message that does not speak to the agent becomes. Sync runs at startup and on **Sync now**. Eval settings select the accept mode, timeout and assessment model.
- **Execution:** worker model, concurrency, directory root, prepare command and blocked commands. Clicking an available variable inserts it into the prepare command.
- **Prompts:** **Edit** changes team sections, built-in parts and skills. **Full prompt** shows the assembled text and compares it with saved text or defaults. **History** lists versions. Edited built-in parts are marked changed and can be reset; templates list their required placeholders.

  An upgrade that changes an overridden default marks it **Default updated** (默认内容已更新). The panel compares the old and new defaults above the team's text. If the old default was not recorded, it compares the team's text with the new default instead. Choose **Keep my text** or **Use the new default**. Overrides for removed parts are listed below the tab bar and dropped on the next save.
- **Deployment:** startup problems with **Check again**, the state directory and machine limits. Saved limits apply without restart. The DeepSeek Harness Plugin Manager exposes the same page.

## Search

The header search finds Triggers by text, id, Feishu message id or a stored link, such as a Redmine issue URL. A Feishu link missing from the original message becomes searchable only after the host reads it during the current process lifetime.

Search also finds Threads by references such as `#12` or a task system URL, and Tickets by title or a matching Thread.

## Principles

1. **Focus on what matters.** Every element answers one of the three questions, or it is removed. A number appears only when it changes what the supervisor does.
2. **Precise definitions.** Categories have checkable definitions, are mutually exclusive and cover every case, as the Ticket stages do. A label says whom a row waits for and what it needs, not an internal status code.
3. **One place per concept.** Source state belongs in Source; Threads and Triggers in Trigger; Decisions in Eval; Tickets in Execution; the tasks of the task system in Workbench, which manages only the operator's own list and never changes the task system. Settings are grouped by the concept they configure. Overview leads with the live state of the system and otherwise summarizes these pages and links to them instead of becoming another detailed view.
4. **Domain structure.** The panel uses the domain terms. Internal identifiers appear only in folded details, and names replace identifiers where they can be resolved.
5. **Honest state.** A count equals the length of the list it links to, and no state contradicts another fact.
6. **Quiet by default.** Healthy states take no extra space. Problems must be actionable; a one-off network error is not enough. Rows needing a person offer their action directly. Keep page explanations to one sentence and put further detail in the (?) tooltip. Destructive actions require confirmation.
7. **Consistent controls.** Use DeepSeek Harness design tokens and control behavior. The same information should look the same throughout the panel. Each settings block has one save bar, visible only while changes exist, a save runs or a save fails.

# 005 Panel

Open **Superagent** in the DeepSeek Harness Web sidebar to supervise the agent. The panel prioritizes work that needs a person, then system health and history. This document builds on [000 Philosophy](000-philosophy.md) through [004 Prompts](004-prompts.md).

## Three questions

Opening the panel answers three questions, in this order:

1. Does anything need me now?
2. Is the system healthy and doing the right things?
3. What is the history of one piece of work, from Trigger through Eval to Ticket?

## Tabs

The panel opens on **Overview**, with **Workbench**, **Source**, **Trigger**, **Eval**, **Execution** and **Settings** after it. The source tabs follow the workflow; Overview leads with the live state of the system and Workbench holds the operator's own tasks. Until the account setup succeeds, Overview shows what is missing and links to the relevant setting.

| Tab | Shows |
| --- | --- |
| Overview | The live pipeline dashboard: the system's state, the workers running and every station's count and flow. Below it, Tickets needing action and system problems |
| Workbench | The task inbox of the operator: the task system's issues assigned to the bound account, filtered as 待处理, 未处理 or 已归档, with the state of each task, the Ticket the agent holds and the conversation about the issue. Archive and delete manage this list, never the task system |
| Source | Source state, setup problems and non-zero counts. Filtered Triggers and dropped messages cover the same 24-hour window as Overview |
| Trigger | Threads filtered by Subscribed, Evaluating, New Triggers in 24 h, or All Threads. Each Thread shows its Triggers newest first, Decisions and Subscriptions |
| Eval | Decisions with their reason and matched rules |
| Execution | Executor state, Pause processing, and Tickets filtered by Open, Pending, Working, Waiting for a Trigger or Ended. Ticket details show actions, authorization, waiting Inputs, Subscriptions and Assignments |
| Settings | Sources, Eval, Execution, Prompts and Deployment. Each group includes its save history |

### Overview

Overview answers the first two questions from one view. Its live banner leads with a green pulsing beacon and **运行中**, the tasks in flight now of those the Executor may run (**2 / 4 个任务在跑**) with their slot pips, the queued and waiting counts, and the line **任务系统 已连接**. A pause turns the beacon amber and the banner says **已暂停**; a task system that is not configured or unreachable turns it grey or red and shows the reason, with the error below.

The pipeline chart beneath the banner has seven stations, 任务 → 触发 → 评估 → 工单 → 执行中 → 等人 → 完成, each with its count and a note: the tasks with the ones taken, the triggers of the last 24 hours, the evaluations running, the open tickets, the workers running with their queue, the tickets waiting for a person, and the tickets done in the last 24 hours. Its head carries the legend **进行中**、**等人**、**已完成** and **更新于 现在**; the connectors between stations animate while the upstream station has work and processing runs. Every station opens the page that holds the work it counts: the inbox, the Source, the Evals, the Tickets.

Below the dashboard comes what needs a person: Tickets needing action and system problems, each linking to its detailed page.

### The workbench

The workbench is the operator's task inbox. It lists the task system's issues assigned to the bound account — the work the agent takes — as **待处理** (waiting for the judgement, worked on, or waiting for the person), **未处理** (the route judged the task and did not take it, with the reason it gave) and **已归档** (the operator's own list), each row showing its id, its project, its status and the state the task stands in. A row the agent holds a Ticket for is marked with the Ticket. **归档** moves a task out of 待处理, **删除** hides it from every list, and both change only what the workbench shows: the task system is untouched, and a Ticket that works on the task continues.

The state of a task comes from what the agent did with it: a task nobody judged yet is **待分析**, a task the route declined is **未处理**, a task with an open Ticket is **分析中** or **等你处理** (the Ticket waits for a person), and a finished Ticket is **已完成**. The state is read from the Ticket the agent holds and from the last decision of the issue's thread, so it says why a task was not taken.

Selecting a task opens the conversation about it: the issue's description and journals, with their authors and times, the agent's replies on one side and the operator's own on the other, each linking to its place in the issue. The head shows the task's project, status and assignee and links to the task system; a Ticket the agent holds shows its stage, its change and a button that opens the agent's Session. The composer sends a reply as a note on the issue, and the Source delivers it to the agent at once, so the work continues without waiting for the next poll; when that hand-off fails, the note stays a note and the Source delivers it on the next poll, so an instruction is never lost. Because the agent and the operator may share one account, the Source tells its own notes and the panel's notes from a person's by the markers they carry: on a shared account the operator's unmarked notes are human input.

### Reading individual records

A dropped message links to its Ticket, or to its Thread when it has no Ticket. The Source page explains whether its conversation disappeared or the Source stopped listening to it.

A human follow-up still owned by an Executor is marked **Delivered to Ticket**, without an Eval. The Thread also shows hand-back reasons and context-only Subscriptions. **Evaluate again** can send that follow-up to Eval, or retry a Trigger with no effective judgement: one filtered by its Source, an unavailable Eval, or a delivered message with neither a non-stop Decision nor an Executor acknowledgement.

Ticket details show the originating Trigger, Decision and reason, scope and Policy version. Assignments and secondary details are folded below the immediate actions. **Retry** is available for failed Input delivery or a Ticket waiting for a person after a blocked or failed Report. Ended Tickets show outcomes such as **Change submitted** or **Stopped by a person**.

## Settings groups

- **Sources:** one card per Source with its switch, fields and verified account facts. Redmine offers receive-all switches for new issues and for their discussion, and Gerrit for review comments and change messages. Polling and read limits are under Advanced.
- **Eval:** the Policy version and rules, followed by **On each Source** and the Eval settings. Each Source tab contains its allowed list, membership sync, admission table and bot list. Sync runs at startup and on **Sync now**. The admission table distinguishes receiving scope, sender membership and whether the message addresses the agent. Eval settings select the accept mode, timeout and assessment model.
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

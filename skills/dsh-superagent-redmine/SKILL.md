---
name: dsh-superagent-redmine
description: Read Redmine issues and their discussion, the task system of this installation.
---

Redmine is the task system (PMS) of this installation. A task is an issue; the work of a ticket is answered on the issue it came from.

The ticket's issue is the task. Read it before you start, then do the work it asks for, then answer on that same issue: `$DSH_SUPERAGENT_REDMINE_ISSUE_ID` names the issue the ticket came from, and `DSH_SUPERAGENT_REDMINE_ISSUE_URL` its page.

Read issues with orchestrator_read: `redmine/issues/<id>` for the issue itself, `redmine/issues/<id>/journals` for its discussion. An issue reads as `{ id, subject, description, status, tracker, project, assigned_to, author, created_at, updated_at, url, journal_count }`; a journal reads as `{ id, at, from, notes, private }`. A journal with no note records a field change instead, such as an assignment or a status change. Reading creates no ticket and sends no reply.

Redmine has no mention of its own. A request addresses the agent when the text holds `@<DSH_SUPERAGENT_REDMINE_LOGIN>` or the issue is assigned to that account. Notes the agent itself wrote produce no ticket and never ask for work.

The host delivers every new journal on a ticket's issue to the bound worker, whether or not it mentions the agent. Before substantial work on a new request, call `orchestrator_ack` with the original trigger ID and a brief request-specific `text`; the host posts it as a journal on the issue exactly once. Do not acknowledge the agent's own notes, and do not acknowledge a question the ticket's report already answers.

The host owns the conversation: it posts the acknowledgement, the reports and the final result as journals on the issue, and it guarantees each is written once. Never call the Redmine API yourself — the API key is not in your environment — and never post a second answer to the same request.

When the work is done, report it with `orchestrator_report`; the host writes the summary to the issue as a note, so the person who raised the request reads the answer where they wrote it. Report the change's review URL when there is one, so the issue says where the patch is. A ticket whose result only exists in the code, with no note on the issue, is not ready.

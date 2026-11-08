# SETUP

Instructions for an agent that sets up dsh-superagent with its operator. If you are a person, ask your coding agent to read this file and follow it.

## How to run the setup

The setup follows [docs/000-philosophy.md](docs/000-philosophy.md): it takes as little of the operator's attention as possible.

- **Before the first question,** read only this file and `docs/000-philosophy.md`, and run the probe below once. Read nothing else until every answer is collected.
- **Ask one question per message,** about one thing. Wait for the answer before the next one. Skip a question the probe already answers.
- **Keep each message under 300 words,** unless the operator asks for more. Give each question a recommended answer the operator can accept with one word, and one sentence on why it matters.
- **Do not execute while asking.** Collect every answer, then send one message with the full plan, and execute only after the operator confirms it.
- **Never ask for a secret in the chat.** Steps that need the operator's hands, such as creating an account, signing a CLI in or entering an app secret, go into one message with the exact commands to run in their own terminal.
- **Teach the philosophy through the questions,** one sentence at a time, not as a lecture.

## 1. Probe

Run from this checkout, once, and keep the result to yourself:

```sh
node -v; pnpm -v; git --version; tmux -V; python3 --version; dsh --version
command -v lark-cli
grep -l -E 'id: dsh-superagent\b' "${DSH_HOME:-$HOME/.dsh}"/profiles/*/cordis.patch.yml 2>/dev/null
```

- **Prerequisites:** Node.js 22.19+ or 24+, pnpm, git 2.32+, tmux, Python 3.8+, and DSH within the `engines.dsh` range of `package.json`. A missing one becomes an item of the plan, not a question. DSH also needs a model provider; if the operator has never run DSH with a model, configuring one is an operator step.
- **Existing profile:** a profile with a `dsh-superagent` entry is an earlier setup: ask whether to continue it, keep its configuration, and read Upgrade in `docs/006-deployment.md`.

## 2. Questions

Ask in this order, one per message, following the flow of work in [docs/001-domain.md](docs/001-domain.md): first where Triggers come from, then — for Feishu, the one Source with a roster — who may ask for work there, then what the Executor does with a Ticket. Recommendations are in brackets.

**Sources: where requests come from.**

The tasks of the team live in a task system, and the patches are reviewed on a review server. Ask these questions, and skip the rest of the section:

1. **Task system.** Which Redmine instance holds the tasks? [The URL of the company's Redmine.] Which account does the agent work as? [Your own account: the agent binds to it and takes the issues assigned to it, so there is no separate agent account to create.] Which API key? [That account's key, created under *My account* → *API access key*.] Which projects? [Empty, to receive the issues of every project the account sees; otherwise their identifiers.]
2. **Review server.** Which Gerrit instance holds the patches? [Its web URL; there is no SSH address or branch to configure — the SSH address the agent pushes to follows from the web URL, and a patch proposes against the branch of the change it belongs to.] Which repositories? [Empty, so the agent tracks the issue-referencing patches of every repository; otherwise one name to restrict it.] Which account, and which SSH key? [The operator's own Gerrit account, as with the task system — the agent binds to it — and the private key whose public half that account holds.]
3. With Feishu: **which chats,** by name, and **who may ask there?** The agent looks up their ids after the bot is configured.

Redmine and Gerrit keep no list of who may ask: a request is anything that addresses the agent there — an issue assigned to its account or a mention of its login on Redmine, a review comment on one of its own changes on Gerrit — and the admission table under *On each Source* governs only the work nobody asked for. Feishu's roster is the one list there is, and question 3 covers it.

**Execution: what the agent does with a Ticket.**

4. **Commit identity.** Who should the agent's commits name as author? [The agent account, so its work is visibly its own.] Another identity, such as the operator's, goes into the Delivery requirements prompt section.

Do not ask about values with a good default; list them in the plan instead:

- profile `superagent`, a copy of DSH's Web profile kept apart from the profile the operator works in, so it restarts without closing their Sessions; port `3082`; state directory `<home>/.dsh/state/superagent` as an absolute path;
- an hourly check from the operator's own profile, which repairs dsh-superagent when it is not running;
- branch prefix `agent/`;
- accept mode `auto`, so the agent takes the work it is allowed to take, and the default rules and prompt sections;
- with Feishu: the bot reads only mentions, and direct messages are on;
- the workbench lists the Redmine issues assigned to the bound account, and archive or delete changes only that list, never Redmine;
- the agent pushes its patches to the review ref of the branch its change belongs to, names the issue it answers in the change's commit message with an `Issue:` trailer, tracks its changes in every repository by that trailer, and answers a review on the change itself. It never merges a change: the merge is a person's act.

## 3. Plan

Send one message, under 300 words: what will be installed, the accounts and CLIs, the settings to save, the operator steps, and the defaults. Ask for one confirmation.

## 4. Execute

1. **Operator steps first.** Read the Accounts section of `docs/006-deployment.md`, then send one message with what only the operator can do: bind the agent to their own Redmine account with its API key and to their own Gerrit account by registering the public half of its SSH key with it — no separate agent account in either system —, and for Feishu create and publish the bot app and run the `config init` command with its secret. Wait until the operator says it is done, then check the Redmine key with a read of `GET /users/current.json` and the Gerrit account with a read of `GET /a/accounts/self`.
2. **Install and start.** Follow the Install, Machine configuration, and Start and stop sections of `docs/006-deployment.md`. Skip the `git clone` of this repository: you are in its checkout. With an existing profile, skip the `dsh superagent --from-default-profile` command, which would replace the profile and delete its `cordis.patch.yml`, and edit that file instead of replacing it.
3. **Settings.** Save them through the Management API of `docs/006-deployment.md`, in this order: the `redmine` Source, the `gerrit` Source, the `feishu` Source if used, the `policy` block — the admission tables, and the Feishu roster if used (look up the chat ids with the bot's CLI first) —, and the `executor` block. Then save the prompts with the commit identity of question 4 in Delivery requirements. A save that returns `restarting: true` restarts dsh-superagent: wait until `scripts/dsh-superagent status` no longer exits 1 before the next request, and read the revisions again from `GET settings`.
4. **Failures.** A refused save names the setup problem in its response body. Find it in the Troubleshooting table of `docs/006-deployment.md`, fix it, and continue. Ask the operator only for what you cannot fix yourself.

## 5. Verify and hand over

`scripts/dsh-superagent status` exits 0 with no setup problem. If you run in the operator's own DSH profile, create the hourly check of the Hourly check section of `docs/006-deployment.md` with your schedule tool; otherwise give the operator its prompt to schedule there. Then send one message, under 300 words:

- The panel URL, and that the **Superagent** entry in the sidebar is where to look.
- How to try it: from any account, open an issue in the task system and assign it to the bound account, or mention its login in the issue. The task appears in the workbench and a Ticket on Overview within about a minute, and the patch arrives on the review server a few minutes later. The workbench is also where you continue the task: reply in the issue's conversation and the agent picks it up at once.
- Three rules for the operator, from the Responsibility section of `docs/000-philosophy.md`: start narrow, tune for less noise, own what the agent says.
- Where to read more: the numbered documents in `docs/`, in order.

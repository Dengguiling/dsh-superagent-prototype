# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for a task system and a code review server, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to **Redmine** for the work and, optionally, Feishu. When a task is assigned to it or someone mentions it, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a patch for review. A web panel leads with a live dashboard of the pipeline, and a workbench is the operator's task inbox: the Redmine issues assigned to their account, each with the conversation with the agent that continues the work.

The company setup is the point of it: a person opens an issue in Redmine, the agent takes it, solves it, pushes the patch to **Gerrit** for review, and answers on the issue. One Redmine account is enough — the agent binds to the operator's own account and takes the issues assigned to it — and the company's many repositories need no configured project: the agent tracks every patch set whose commit message names an issue. [docs/010-corporate-redmine-gerrit.md](docs/010-corporate-redmine-gerrit.md) describes that installation, and The repository `dsh-superagent-env`, next to this one, holds a Docker stack that runs it locally.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## What this fork changes

This repository is a fork of [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), seventeen commits ahead of its publication snapshot, and rebased onto it so the histories stay in sync. The changes are two groups of work:

**A full code review, and the fixes it produced.** The review covered the plugin and its companion test environment; every finding came with a regression test where one could be written.

- The Sources deliver reliably: a hidden marker counts only when the agent's own account wrote it, so nobody can forge one to silence a comment; the panel's reply and its poll backstop share one trigger id, so a crash between them delivers once; a round that cannot read an issue keeps its poll window, so no update is lost; Redmine and Gerrit lists page past their first page; the first Gerrit round records what it saw instead of receiving it; a stale-object conflict is a retry, not a `gone`.
- The core and its plumbing keep working when one record is broken: one failing thread no longer stops a whole pass; a deadline an older version wrote in another form expires instead of wedging every Eval; the state-directory lock waits out the stale window of a crashed process; notice injection retries a transient failure; settled receipts are pruned; the worker's git checks the review server's host key after the first connection.
- The executor no longer cancels a worker's own `ready` report when its last Input landed in the same millisecond.
- The panel fixes what an operator touches: the pause switch reflects at once, the flow page reads the panel's one task poll, the prompt preview is debounced and keeps its last result on a failure, fetches time out, and a garbled wording is repaired.
- Authorization is unchanged in design and re-verified: the gate admits by relation and by the admission table, and no path lets an unlisted sender gain strength. The documents (SETUP, [006](docs/006-deployment.md), [010](docs/010-corporate-redmine-gerrit.md), [011](docs/011-interaction-scenarios.md)) now describe that design as the code builds it, and a gray list keeps the retired instructions out. Both repositories run their checks in CI.

**The development history the snapshot predates.** The publication snapshot stops before the panel became a workbench, a pipeline and settings with the signal rail above every page; before the interaction walkthrough ([011](docs/011-interaction-scenarios.md)); before the companion [`dsh-superagent-env`](https://github.com/Dengguiling/dsh-superagent-env) repository, which runs the corporate scenario on real Redmine and Gerrit containers and keeps its ports on the loopback, generates its keys instead of committing them, and leaves the merge with the leader.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 Redmine and Gerrit integration](docs/009-redmine-gerrit-integration.md): the task system and the review server, their APIs and their quirks
- [010 Corporate Redmine and Gerrit](docs/010-corporate-redmine-gerrit.md): running the agent where Redmine holds the tasks and Gerrit holds the patches
- [011 交互场景清单](docs/011-interaction-scenarios.md): the situations the agent meets, one by one

## Design

The panel redesign: what the pages got wrong, the improvement plan, and an interactive prototype.

- [Redesign plan](design/redesign-plan.md): the problems, the batches, and what each batch changed (see §4.5)
- [Audit · Overview and Workbench](design/audit-ops.md)
- [Audit · Record pages](design/audit-records.md)
- [Audit · Settings and design system](design/audit-settings.md)
- [Prototype](prototype/redesign.html): open it in a browser

The panel now has three destinations — **任务工作台** (the task inbox), **流水线** (the
flow of the work and its stages) and **设置** — with the pages of each below them. A rail above every page
carries the live state, the work that waits for a person, the Executor's load and the switch that stops it.

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)

# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for a task system and a code review server, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to **Redmine** for the work and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a patch for review. A web panel leads with a live dashboard of the pipeline, and a workbench is the operator's task inbox: the Redmine issues assigned to their account, each with the conversation with the agent that continues the work.

The company setup is the point of it: a person opens an issue in Redmine, the agent takes it, solves it, pushes the patch to **Gerrit** for review, and answers on the issue. One Redmine account is enough — the agent binds to the operator's own account and takes the issues assigned to it — and the company's many repositories need no configured project: the agent tracks every patch set whose commit message names an issue. [docs/010-corporate-redmine-gerrit.md](docs/010-corporate-redmine-gerrit.md) describes that installation, and `env/` holds a Docker stack that runs it locally.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

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

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)

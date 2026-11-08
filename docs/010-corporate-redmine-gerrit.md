# 010 Corporate Redmine and Gerrit

This is the deployment of dsh-superagent in a company whose tasks live in Redmine and whose code is reviewed in Gerrit, in many repositories. The flow is:

1. The leader writes the issue in Redmine and assigns it to the developer.
2. The Redmine Source reads it, the Eval accepts it, and a Ticket opens.
3. A worker Session works in the Ticket's directory, and clones the repository named by the issue's Redmine project identifier.
4. The worker commits, names the issue in the commit message with an `Issue:` trailer, pushes the patch to `refs/for/<branch>` as the developer, and reports the change number.
5. The Gerrit Source finds that change by the trailer, in whichever repository it lives, and hands the review comments on it to the same worker.
6. The developer, or the leader, reviews the change in the web UI of the review server, in the page the push printed; the leader gives it Code-Review +2 and merges it. The Ticket ends, and the outcome is written back to the Redmine issue as a note.

In Gerrit the author of a change may not merge it: the review server asks for a review by somebody else. The merge is the leader's work.

The Sources, the prompt sections and the skills of this deployment are the built-in ones; only the account settings differ from the general deployment of [006 Deployment](006-deployment.md).

## The three roles

The company has three roles, and both systems know them:

| Role | Redmine | Gerrit |
| --- | --- | --- |
| `admin` — the system administrator | "System Administrator", the system manager: the highest rights, kept out of the tests | the system manager: the highest rights, kept out of the tests |
| `lead` — the leader | "Team Leader", the leader: assigns the work to the developer | the team leader: reviews the patches and merges them, and holds the merge right on the repositories |
| `dev` — the developer | "Software Developer", the developer: takes the tasks and starts the superagent | the developer: submits the patches and hands them to the leader for review |

The passwords, the API keys and the addresses of the local environment are in the `.env` of the repository `dsh-superagent-env`; its README describes the stack in full.

## What this deployment uses

| | Redmine | Gerrit |
| --- | --- | --- |
| The task | An issue, and its discussion | — |
| The work | — | A patch pushed to `refs/for/<branch>` |
| The review | — | Comments on the change |
| The end | The result is written back as a note on the issue | The change is submitted |
| The agent's identity | The developer's account, bound through its API key; no separate agent account | The developer's account, with the SSH key of the superagent and an HTTP password |

## The account of the superagent

The superagent binds to the developer and to nobody else:

- the Redmine account is `dev`, "Software Developer", and the Redmine Source takes the issues assigned to it;
- the Gerrit account is `dev`, and the SSH address of the Source is `ssh://dev@localhost:29418`;
- there is no account of the agent's own, in neither system.

The developer does the work and the superagent helps the developer, so the superagent works in the developer's name: its notes on the issue, its commits and its pushes carry the developer's identity. The Source still tells the agent's notes and the panel's notes from a person's by markers, so the developer's own notes on an issue reach the agent as human input even though the account is shared.

The Redmine and Gerrit Sources are inserted disabled, as Feishu is; enable them in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-superagent-redmine
      name: dsh-superagent/redmine-watch
      disabled: false
    - id: dsh-superagent-gerrit
      name: dsh-superagent/gerrit-watch
      disabled: false
```

## The settings

Both Sources are configured under *Settings* → *Sources*.

**Redmine**

| Field | Meaning |
| --- | --- |
| Address | `http://redmine.example.com`, without a trailing slash |
| API key | The REST web services key of the bound account; a credential, never in the agent's environment |
| Login | The bound account's login, here `dev`; empty uses the account of the API key |
| Project | An optional project filter; empty reads every project the account sees, which is the usual setting here |
| Receive new issues | Whether an issue that does not mention the agent is received at all |
| Receive discussion | Whether a journal that does not mention the agent is received at all |

**Gerrit**

| Field | Meaning |
| --- | --- |
| Address | `http://gerrit.example.com:8080`, the HTTP address of the review server |
| SSH address | `ssh://dev@gerrit.example.com:29418`, without the project; the agent appends the repository the issue names |
| Project | An optional single-repository override; empty, the recommended setting, tracks the issue-referencing patches of every repository |
| Account | The user name on Gerrit, here `dev`; a change belongs to the agent when this account owns it |
| HTTP password | The account's HTTP password, used to read review comments; a credential |
| SSH private key | The path of the key whose public key is registered with the account |
| Commit email | The email Gerrit accepts; commit as it when the ticket names no author |
| Target branch | The branch patches are pushed to, such as `main` |

Saving either Source restarts dsh-superagent, which checks the accounts: the Redmine key against `/users/current.json`, and the Gerrit account against the review server, with the project checked too when one is set. A Source whose account does not answer stays off, and the panel says why.

## Many repositories

The company has many repositories, so one configured project cannot name the work. A change belongs to a task when its commit message names the task's Redmine issue in an `Issue:` trailer (`Bug:` and `Feature:` are accepted too), and the Gerrit Source tracks such changes across every repository: on each poll it lists the open changes, keeps those that name an issue, and binds each one to the Ticket that works that issue. A change without the trailer is ignored, whatever repository it is in. The optional Gerrit project narrows tracking to that one repository, which a small installation may want; the company leaves it empty.

The repository of a task is the identifier of the Redmine project the issue belongs to. A Redmine project identifier and a Gerrit project name are the same string, so the issue itself says where its patch goes.

A review comment on another person's patch for the same issue binds to that issue's Ticket too: the comment's Trigger carries both the Gerrit change and the Redmine issue as its Threads, so the issue's worker receives it.

## The prepare command

The Execution settings carry the command that prepares a Ticket's directory. It runs in the Ticket's parent directory with the Ticket's environment variables, so it clones the repository the Ticket works on:

```sh
git clone "$DSH_SUPERAGENT_GERRIT_SSH_URL" "$DSH_SUPERAGENT_DIR"
```

`DSH_SUPERAGENT_GERRIT_SSH_URL` follows the issue: it is the Gerrit Source's SSH address with the issue's Redmine project identifier appended, so the same command checks out the right repository whichever project the task belongs to. A configured Gerrit project overrides it. The clone uses the key the Gerrit Source names, because dsh-superagent writes `core.sshCommand` into the worker's isolated git configuration.

The prepare command is optional. Without one, the Ticket's directory stays empty and the worker clones the repository itself, which the Gerrit skill shows.

## The Policy

Under *Settings* → *Policy* → *Eval → On each Source*, the Redmine Source lists the people whose issues and journals may start work, and the Gerrit Source lists the people whose review comments may. In this company both lists name the leader:

| Source | The allowed entry | What it allows |
| --- | --- | --- |
| Redmine | `Team Leader`, the display name Redmine shows | the issues and the journals of the leader start the work |
| Gerrit | `lead`, the user name Gerrit reports | the review comments of the leader start the follow-up work |

Redmine's API reports the **display name** of an author beside its id, and no login, so the Redmine list holds the names Redmine shows. The Gerrit list holds the user names of Gerrit, which is what its API reports.

The leader is on the list and the developer is not, because the leader assigns the work and merges the patches. The developer does the work, and the superagent helps the developer; a request of the developer starts no new work, it is input on the ticket the superagent already works.

A Redmine request addresses the agent when the issue is assigned to the bound account, or when the text holds `@<login>`. A Gerrit request addresses it when the review comment holds `@<account>`. Both are the conventions those systems have, not mentions of their own.

An issue that arrives while the agent works reaches the worker as a follow-up, whether or not it mentions the agent, as long as the person who wrote it is on the list.

## What the worker does

The worker Session loads the `dsh-superagent-redmine` and `dsh-superagent-gerrit` skills. The Gerrit skill holds the exact commands of the clone and the push:

```sh
git clone "$DSH_SUPERAGENT_GERRIT_SSH_URL" .
git switch -c "agent/$DSH_SUPERAGENT_NAME"
CHANGE_ID="I$(openssl rand -hex 20)"
git commit -m "Fix the login redirect" -m "Issue: $DSH_SUPERAGENT_REDMINE_ISSUE_ID" -m "Change-Id: $CHANGE_ID"
git push --push-option="topic=agent/$DSH_SUPERAGENT_NAME" origin "agent/$DSH_SUPERAGENT_NAME:$DSH_SUPERAGENT_GERRIT_PUSH_REF"
```

The `Issue:` trailer is what names the ticket on the change: it is how the change is tracked and bound to the Ticket, in whatever repository it lives. The change's topic, which the push option sets, carries the ticket's branch name and is kept for installations that already rely on it. The `Change-Id` trailer is what Gerrit itself requires.

A later patch set **amends** the commit; it never adds a second commit. Gerrit refuses a push that carries one `Change-Id` in two commits, and a second commit would become a change of its own:

```sh
git commit --amend -m "Fix the login redirect" -m "Issue: $DSH_SUPERAGENT_REDMINE_ISSUE_ID" -m "Change-Id: $CHANGE_ID"
```

The push output names the change, in the form Gerrit 2.15 uses: `remote:   http://<host>/#/c/<project>/+/<number>`.

The worker reports the change number the push printed:

```
orchestrator_report(state: progress, summary: "Pushed the patch for review", change_number: 1003)
```

The host binds that change to the Ticket, so the review comments on it reach the same worker, and the merge ends the Ticket.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The panel says the Redmine Source waits for the deployment check | The account did not answer. Check the address and the API key; *Administration* → *Settings* → *Authentication* must have *REST web services* on |
| The panel says Gerrit refused the account | The HTTP password is wrong, or the account may not read the server. Gerrit answers `/a/` only with the account's HTTP password |
| The panel says Gerrit has no project named … | The optional Gerrit project is set. The project name does not exist, or the account may not read it; empty the field to track every repository |
| No issue is ever received | The issue does not mention the bound account and is not assigned to it, and *Receive new issues* is off. The cursor starts when the Source is switched on: earlier issues are not read |
| The push fails with `remote: Change-Id header is missing` | The commit has no `Change-Id` trailer. The Gerrit skill shows how to add one |
| The push fails with `Permission denied (publickey)` | The key path in the Gerrit Source is wrong, or its public key is not registered with the account |
| The push fails with `Permission denied (publickey)` although the key is registered | The key is an RSA key: it is signed with SHA-1, which OpenSSH 8.8 and later refuse by default. dsh-superagent adds `-o PubkeyAcceptedKeyTypes=+ssh-rsa` by itself when the configured key is an RSA key |
| The Gerrit web UI answers with a **Configuration Error** page | Two causes. First, Gerrit 2.15 in `auth.type = HTTP` mode looks the user up as the external id `gerrit:<login>`, and only the HTTP login flow creates that external id: an account created over the REST API can never be used in the browser, because Gerrit tries to create a second account with the same user name and refuses with `name already in use`. The account a person uses must therefore be created by signing in over HTTP. Second, Gerrit 2.15 has no sign-in form of its own — it expects a web server in front of it that asks the browser for the credentials and hands the identity over in the `Authorization` header. A browser answers such a challenge on a page but never on a background request, and the web UI reads all of its data in the background, so the challenge has to come from that front end |
| The push fails with `Too many authentication failures` | The worker offers the keys of the SSH agent before the configured one. dsh-superagent writes `-o IdentitiesOnly=yes`, so the configured key is the only one offered |
| The change is not bound to the Ticket | Its commit message names no issue and its topic does not carry the ticket's name. Add the `Issue:` trailer with the Redmine issue number, or push under the ticket's topic; a configured Gerrit project also hides the repository if it names another one |
| The review comments do not reach the worker | The comments are on a change whose commit message names no issue, or the author is not on the Gerrit list. Both must hold |
| The developer may not merge the patch | Gerrit asks for a review by somebody else: the author of a change may not submit it. The leader reviews the change, gives it Code-Review +2 and merges it |
| The push is refused with `same Change-Id in multiple changes` | The branch carries a second commit with the same `Change-Id`. Amend the commit instead of adding one |
| The worker's git asks for a host key | dsh-superagent writes `core.sshCommand` with `StrictHostKeyChecking=no`; a worker that pushes outside its Ticket directory does not use it |
| The sign-in page does not open a system | The role has no account yet, or the stack is not up. `accounts.sh` of the environment provisions the roles of the company, and its README lists the addresses |

## The local environment

The repository `dsh-superagent-env`, next to the plugin, holds a Docker Compose stack that runs this environment locally: Redmine 4.2 with PostgreSQL, and Gerrit 2.15.13 behind an nginx proxy, and a sign-in page on `http://localhost:3001/` that opens either system with one click per role, in a new tab. It carries two repositories — a small demo SDK and its CLI — seeded with real defects, and the Redmine issues that describe them are written by the leader and assigned to the developer.

Its `accounts.sh` provisions the three roles on a running stack, and its `seed.sh` calls it before it seeds the projects and the issues. Its `verify.sh` checks the roles and with them the whole flow of the company: the developer pushes a patch to a scratch repository, may not merge it, and the leader reviews it and merges it. Its README has every address, account, API key and SSH key of that stack, and its `.env` the credentials themselves.

`scripts/live/redmine.ts` and `scripts/live/gerrit.ts` check the two Sources against a running Redmine and Gerrit: they list the changed issues and the open changes, read one with its journals and its comments, post a note and a review message, and run a poll round that must turn an issue, a journal and a review comment into Triggers. Run them with `npx vite-node scripts/live/redmine.ts` and the addresses and credentials of the environment as `REDMINE_URL`, `REDMINE_KEY`, `REDMINE_LOGIN`, `REDMINE_NAME`, `REDMINE_ID`, `REDMINE_PROJECT`, `GERRIT_URL`, `GERRIT_USER`, `GERRIT_PASS`, `GERRIT_PROJECT` and `GERRIT_BRANCH`.

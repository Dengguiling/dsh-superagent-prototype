# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **One Redmine account, bound to the Source.** In a company that is the operator's own account, and no separate agent account is needed: the agent reads the issues assigned to it, posts notes on them and takes work as that account, through a Redmine REST API key. In a deployment where the agent has an identity of its own, that account is the bound one. In the local environment of this repository it is the developer's account, `dev`.
- **An agent Gerrit account.** The agent clones the ticket's repository, pushes patches for review and answers reviewers as this account, through an SSH key and an HTTP password. In the local environment it is the developer's account as well, `dev`.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the accounts, Policy for allowed lists, and Execution for worker directories and commands.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. The Redmine key and the Gerrit password stay in the host's environment and never reach a worker; the SSH key does, through the worker's own git configuration. These are defaults, not an isolation boundary: a worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+ and tmux
- A Redmine 4.2 task system with its REST web services enabled, and a Gerrit 2.15 code review server. The accounts and the flow of a patch through them are described in `docs/010-corporate-redmine-gerrit.md`.
- git and curl, which reach the review server over SSH and HTTP. A Source CLI field must point to a wrapper; the host relies on its subcommands and output formats.
- A model provider configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot

## Accounts

### Redmine account

The Redmine Source binds to one account. In a company that is the operator's own account, which already exists: no separate agent account is required, and the work is the issues assigned to that account.

1. Use the operator's account, or create one if the agent should have an identity of its own. Its login is the name a person mentions in an issue (`@login`), so a readable one helps.
2. Give that account an API key: *My account* → *API access key*. Enable *REST web services* in *Administration* → *Settings* → *Authentication* first.
3. Give the account a project role that may read the issues it works and write notes on them. It needs no rights beyond that: the agent posts the notes it owes the issue through the Redmine Source, with that key.
4. Put the key in the Redmine Source's settings, together with the account's login. Neither goes in the prompt or a ticket directory: the key is a credential, and dsh-superagent keeps it out of the agent's environment.

### Gerrit account

1. Create a Gerrit account for the agent with an SSH key and an HTTP password:

   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/dsh-superagent-gerrit -C 'dsh-superagent'
   ```

   Register the public key under *Settings* → *SSH keys* of that account, and set an HTTP password under *Settings* → *HTTP password*.
2. Give the account *Developer* (or better) on the repositories it works in, and *Submit* on the target branch. A person submits the change: the agent never merges its own work. In the company of `docs/010-corporate-redmine-gerrit.md` this account is the developer's, and the merge right belongs to the leader, because Gerrit asks for a review by somebody else.
3. Put the key's path in the Gerrit Source's settings. dsh-superagent writes it into the worker's git configuration, so a worker's `git push` reaches the review server without a host key prompt.

   ```sh
   git config --global core.sshCommand "ssh -i ~/.ssh/dsh-superagent-gerrit -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
   ```

   dsh-superagent writes this itself into its own isolated git configuration; the line above is only what a person needs for their own pushes to the same server.

### The accounts of the local environment

The Docker Compose stack in `env/` runs this deployment locally. It carries the three roles of the company in both systems, and the superagent binds to the developer in both of them:

| Role | Redmine, `http://localhost:3000` | Gerrit, `http://localhost:8080` |
| --- | --- | --- |
| `admin` | "System Administrator", the system manager: the highest rights, kept out of the tests | the system manager: the highest rights, kept out of the tests |
| `lead` | "Wang Lei", the leader: assigns the work to the developer | the team leader: reviews the patches and merges them, and holds the merge right on the repositories |
| `dev` | "Zhang Wei", the developer: takes the tasks and starts the superagent | the developer: submits the patches and hands them to the leader for review |

The passwords, the API keys and the addresses are in `env/.env`, which is the source of truth for the stack; `env/README.md` describes it in full.

`env/accounts.sh` provisions the role system on a running stack, and it is idempotent: running it again only applies what is missing. `env/seed.sh` calls it before it seeds the projects and the issues.

- The Redmine accounts come from the `redmine-init` job of the stack, because the Redmine REST API cannot create users. The script checks that each role exists and that its API key answers.
- The `dev` account of the review server is created over the REST API, and it carries the SSH key of the superagent: a push over SSH needs nothing else.
- The `lead` account of the review server is created by signing in over HTTP, with `curl -u <login>:<password> <address>/login`. Only that flow gives an account the external id `gerrit:<login>` that the HTTP authentication mode looks the user up by, so only that account works in the browser.
- The groups `Developers` and `Reviewers` carry the rights of the roles. The REST API of Gerrit 2.15 cannot create groups, so `env/accounts.sh` creates them over SSH, with `gerrit create-group`.

`env/verify.sh` checks the role system, and with it the whole flow of the company: the developer pushes a patch to a scratch repository, may not merge it, and the leader reviews it and merges it.

### The sign-in page of the environment

The stack serves a sign-in page on `http://localhost:3001/`. It lists the two systems and, for each of them, the three roles; one click signs the role in and opens the system **in a new tab**, so the page stays open. The page shows which role is signed in for each system, and it asks the browser every few seconds, so a sign-in that happened in the other tab shows up here. Signing in as another role replaces the session of that system only.

The service is `env/login/server.py`, a program of the Python standard library. It keeps two sessions:

| System | What the page stores | How the session lasts |
| --- | --- | --- |
| Gerrit | the cookie `dsh_auth`, the credential of the role in base64 | the front end of the review server, `env/gerrit/nginx.conf`, hands that credential over to Gerrit instead of challenging the browser |
| Redmine | the cookie `_redmine_session`, the session of Redmine itself | the service signs in against the login form of Redmine and hands its session cookie to the browser; the session of Redmine lasts 30 days |

The cookie `dsh_auth` carries the credential of the role in base64: a convenience of this local mock, not a secret store. `GET /whoami` answers with the role that is signed in per system.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

## Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-feishu` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories in `work`. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

## Start and stop

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Set the Redmine address, the API key and login of the bound account; its project filter is optional, and empty reads every project the account sees. Set the Gerrit HTTP address, SSH address, account, HTTP password, key path, commit email and target branch; the Gerrit project is optional, and empty tracks the issue-referencing patches of every repository. A Redmine request arrives on the next poll: an issue assigned to the bound account, or one that mentions it, opens a Ticket. A Gerrit request arrives as a review comment on a change whose commit message names an issue. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the Redmine, Gerrit and Feishu accounts who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The directory root and a prepare command. To give each Ticket a checkout of its repository, clone it into the Ticket's directory:

   ```sh
   git clone "$DSH_SUPERAGENT_GERRIT_SSH_URL" "$DSH_SUPERAGENT_DIR"
   ```

   The Gerrit SSH address follows the issue's Redmine project, so the same command checks out the repository the task names when the company keeps many. The worker may also clone it itself, when the directory is empty. List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team sections: the disclosure line, the review bots, the commit author and the reviews a change asks for.

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

A task system that stops answering does not hold the panel: every request to it is abandoned after 30 seconds, and the page says the task system did not answer.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `redmine`, `gerrit`, `feishu`, `history` | Source polling, events and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:redmine`, `source:gerrit`, `source:feishu`: `{"enabled": true, "config": {…}}`. Redmine's config has `baseUrl`, `apiKey`, `login` (the bound account; empty uses the account of the API key) and `project` (an optional filter; empty reads every project the account sees), and the switches `observeIssues` and `observeJournals`, off by default, which receive every new issue and every journal that does not mention the agent; Gerrit's has `httpUrl`, `sshUrl`, `project` (an optional single-repository override; empty tracks every repository), `user`, `password`, `keyPath`, `email` and `branch`, and the switches `observeComments` and `observeMessages`, off by default; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
- `policy`: `{"rules": […], "sources": {"redmine": {"allowed": [{"id": "Alice Smith"}]}, "gerrit": {"allowed": [{"id": "bob"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, by `issue` or `journal` for Redmine, and by `comment` or `message` for Gerrit; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `directory`, `prepare` and `blockedCommands`. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing an account runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "redmine") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:redmine \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"baseUrl\": \"http://redmine.example.com\", \"apiKey\": \"$REDMINE_KEY\"}}, \"revision\": $rev}"
```

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the Redmine account against `/users/current.json`, the Gerrit account against the review server, and the Gerrit project too when one is configured, writes the worker environment, and checks that the worker's git reaches the review server with the agent's own key. A failure in one Source disables only that Source.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It sets `core.sshCommand` so that the review server is reached with the agent's key alone, and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, and git never prompts for credentials.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an account on the allowed list, open an issue in the task system that mentions the bound account (`@<login> <request>`) or assign it to the bound account. Within a polling interval (30 seconds by default), Overview should show a Ticket and the workbench should list the task. The agent acknowledges the request, works in its own Session and directory, and writes the result back as a note on the issue. For Feishu, mention the bot in a configured chat.

In the local environment, the sign-in page opens the task system as the leader or as the developer with one click, and the leader's issue, assigned to the developer, is the request that starts the work.

## Upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/dsh-superagent restart` and inspect its status.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The Redmine Source names no address.` | Set the Redmine address on the Redmine card |
| `The Redmine Source has no API key.` | Give the bound account an API access key and set it on the Redmine card |
| `Redmine refused the API key of …` | The key is wrong, or its account may not use the REST API; check *My account* → *API access key* |
| `Redmine at … did not answer.` | The address is wrong, or the server is not reachable from this machine |
| `Redmine at … did not report the account of the API key.` | The key belongs to no account, or the account is locked |
| `The Gerrit Source names no address.` | Set the Gerrit HTTP address on the Gerrit card |
| `Gerrit refused the account of …` | The HTTP password is wrong, or the account may not read the server |
| `Gerrit at … did not answer.` | The address is wrong, or the server is not reachable from this machine |
| `Gerrit has no project named …` | The optional Gerrit project is set, but the project does not exist or the account may not read it; empty the field to track every repository |
| `No source is configured. Set up Redmine or Gerrit.` | Configure at least one of the two Sources |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| The worker's `git push` fails with `Permission denied (publickey)` | The key path on the Gerrit card is wrong, or its public key is not registered with the account |
| The worker's `git push` fails with `Permission denied (publickey)` although the key is registered | The key is an RSA key, which OpenSSH 8.8 and later refuse by default; dsh-superagent allows the old signature for such a key |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. In Redmine, a mention added by editing an issue's description is not received as a new trigger; write a new note instead |

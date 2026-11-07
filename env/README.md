# dsh-superagent — mock corporate development environment

A self contained Docker Compose stack that imitates the two systems the
`dsh-superagent` plugin talks to:

| service    | what it is                    | host URL                     |
|------------|-------------------------------|------------------------------|
| **Redmine** 4.2.10 | task tracker ("PMS")      | <http://localhost:3000>      |
| **Gerrit** 2.15.13  | code review server        | <http://localhost:8080>      |
| nginx 1.31  | the front end of the review server | <http://localhost:8080> |
| PostgreSQL 13      | database behind Redmine   | not published (internal only) |

The stack is **real**, not mocked: Redmine is migrated, has a working REST API
and real users, Gerrit is a real code review server with real SSH pushes,
real changes and a real web UI.

---

## 1. Quick start

```bash
cd env
docker compose up -d      # starts everything, initialises and authenticates
docker compose ps         # wait until redmine/gerrit report "healthy"
./seed.sh                 # seeds project + issues + the first gerrit commit
./verify.sh               # proves that the whole thing works
```

`docker compose up -d` is enough to get an **authenticated** stack:

* the `redmine-init` service loads the Redmine default configuration data
  (trackers, statuses, priorities, roles), enables *Administration ▸ Settings ▸
  Authentication ▸ REST web services*, pins the API keys of the `admin` and the
  `dev` account, and gives the administrator the display name of the project
  manager,
* the `gerrit` service bootstraps its own site on the first start (see
  `gerrit/start.sh`): it creates the `agent` account, registers the SSH public
  keys, sets the HTTP passwords and switches Gerrit to
  `[auth] type = HTTP`.

Both initialisations are idempotent — restarting the stack keeps them.

Stop / remove:

```bash
docker compose stop          # stop, keep the data
docker compose down          # stop and remove the containers, keep the volumes
docker compose down -v       # stop and remove everything, including the data
```

> The first `up` takes **2–5 minutes** on an Apple Silicon host: the Gerrit
> image is amd64 only and therefore runs through qemu emulation (see
> [Caveats](#6-caveats)).

---

## 2. Ports and URLs

| what                     | host                                   | inside the compose network |
|--------------------------|----------------------------------------|----------------------------|
| Redmine UI + REST API    | `http://localhost:3000`                | `http://redmine:3000`      |
| Redmine REST API         | `http://localhost:3000/projects.json`  | `http://redmine:3000/projects.json` |
| Gerrit UI + REST API     | `http://localhost:8080`                | `http://proxy:8080`        |
| Gerrit REST API          | `http://localhost:8080/a/...`          | `http://gerrit:8080/a/...` |
| Gerrit SSH (git)         | `ssh://agent@localhost:29418/demo`     | `ssh://agent@gerrit:29418/demo` |
| PostgreSQL               | –                                      | `postgres://redmine:redmine@pg:5432/redmine` |

Compose service names: `pg`, `redmine`, `redmine-init`, `gerrit`, `proxy`.
The compose network is called `dsh-superagent-env`.

The Gerrit context path is **`/`** (not the Gerrit default `/gerrit/`), so the
canonical URL is `http://localhost:8080/` and the REST prefix is `http://localhost:8080/a/`.

### The front end of the review server

Gerrit 2.15 in `auth.type = HTTP` mode expects a web server **in front of it**
that authenticates the person and hands the identity over in the `Authorization`
header; it has no sign-in form of its own, and its own error page says so:

> Configuration Error — Check the HTTP server's authentication settings.

The `proxy` service is that web server: it asks the browser for the credentials
and passes the header to Gerrit, which checks the password of the account and
looks the person up as the external id `gerrit:<login>`. A browser answers such
a challenge on a page, but never on a background request — and the web UI reads
all of its data in the background — so the challenge has to come from the
front end.

The proxy asks for the credentials itself and keeps two password files, which
[`gerrit/proxy-start.sh`](gerrit/proxy-start.sh) writes from the accounts of
[`.env`](.env) at every start:

| path              | accounts          | serves            |
|-------------------|-------------------|-------------------|
| `/etc/nginx/htpasswd.ui`  | `alice`   | the web UI        |
| `/etc/nginx/htpasswd.api` | `alice`, `agent`, `admin` | the REST API `/a/` |

Gerrit checks the password of the account again on every request of its REST
API, so the password files of the front end only decide **who may talk to
which part** of the review server. The split matters for the browser: the
accounts that were created over the REST API carry no `gerrit:<login>` external
id, so Gerrit refuses them with "name already in use" — a dead end, because the
browser keeps the refused credential and sends it again, and a *403* never asks
for the credentials again. The front end therefore accepts only `alice` on the
web UI: a browser that holds any other credential gets the challenge again and
can sign in.

---

## 3. Credentials

All values live in [`.env`](.env) and are consumed by `docker-compose.yml`,
`seed.sh` and `verify.sh`.

### Redmine

Two people, and no account of the agent's own: **the superagent binds to the
account of the developer** (`dev`), and recognizes the issues assigned to it.

| account | login   | name    | role                     | password   | API key |
|---------|---------|---------|--------------------------|------------|---------|
| admin   | `admin` | Li Na   | the project manager (PM) | `admin12345` | `a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4` |
| dev     | `dev`   | Zhang Wei | the developer ("you"), the bound account | `agent12345` | `0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c` |

Older revisions of this environment created the developer's account as
`agent`; `redmine/init.rb` renames it once, keeping its user id and its API key.

API access (both work):

```bash
curl -H "X-Redmine-API-Key: a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4" \
     http://localhost:3000/issues.json
curl -u "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4:x" \
     http://localhost:3000/issues.json          # basic auth, key as user name
```

> `apikey:<key>` is **not** supported by Redmine 4.2 (returns 401).

### Gerrit

| account | login   | e-mail               | HTTP password | used for |
|---------|---------|----------------------|---------------|----------|
| admin   | `admin` | `admin@example.com`  | `admin12345`  | the bootstrap and the scripts of `verify.sh` |
| agent   | `agent` | `agent@example.com`  | `agent12345`  | the agent: the REST API, the SSH push, its commits |
| alice   | `alice` | `alice@example.com`  | `alice12345`  | **the web UI**: the person who reviews the changes |

```bash
curl -u admin:admin12345 http://localhost:8080/a/projects/
curl -u agent:agent12345 http://localhost:8080/a/accounts/self
```

Open <http://localhost:8080/> and sign in as **`alice` / `alice12345`**.

> **The browser remembers the credential.** Chrome and Firefox keep the answer to
> a Basic challenge and send it again on every later request, without asking.
> If that credential is refused, the browser never shows the dialog again — it
> only repeats the failure, and a *403* (“您未获授权”) is the symptom. The front
> end answers a refused credential with a challenge again (see
> [the front end](#the-front-end-of-the-review-server)), so a reload is enough.
> To start over: clear the saved password of `localhost:8080` in
> `chrome://settings/passwords`, or open the address in a private window.


> **Why the web account is a separate one.** Gerrit 2.15 in `auth.type = HTTP`
> mode takes the identity from the `Authorization` header of the request and
> looks it up as the external id `gerrit:<login>`. Only the HTTP login flow
> ever creates that external id — an account created over the REST API carries
> only `username:` and `mailto:` ids, so Gerrit tries to create a *second*
> account with the same user name, refuses with `name already in use`, and the
> web UI answers with a **“Configuration Error”** page. The user name of an
> existing account can never be changed (`realm does not allow editing
> username`) and the REST API of 2.15 cannot add an external id either, so
> the account a person uses in the browser is created by signing in over HTTP
> (`gerrit/start.sh`, `web_accounts()`), and is then given its password and its
> rights. The built-in `admin` of the bootstrap keeps its name and cannot be
> used in the browser.

### SSH keys of the agent account

| file (on the host)                     | type                    | notes |
|---------------------------------------|-------------------------|-------|
| `env/keys/agent_id_ecdsa`              | ECDSA nistp256          | **default key**, works with every current SSH client |
| `env/keys/agent_id_ecdsa.pub`          |                         | registered for the `agent` account |
| `env/keys/agent_id_rsa`                | RSA 3072                | alternative, registered as well; needs the option below |
| `env/keys/agent_id_rsa.pub`            |                         | |

Both public keys are registered for the `agent` account through the Gerrit
REST API (`POST /a/accounts/agent/sshkeys`, the key is sent as raw body).

```bash
export GIT_SSH_COMMAND="ssh -i $PWD/keys/agent_id_ecdsa -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
git clone ssh://agent@localhost:29418/demo
git push origin HEAD:refs/for/main
```

> **RSA caveat:** an RSA key is signed with SHA-1, and OpenSSH 8.8 and later
> refuse the `ssh-rsa` algorithm by default, so the push is answered with
> `Permission denied (publickey)` although the key is registered.  Add
> `-o PubkeyAcceptedAlgorithms=+ssh-rsa` (`PubkeyAcceptedKeyTypes` on OpenSSH
> < 8.5) to the SSH command.  dsh-superagent writes that option by itself when
> the configured key is an RSA key.
>
> **Ed25519 works.**  Gerrit 2.15 runs on Java 8, but its SSH server does not
> rely on the JDK for key types: it bundles `eddsa`, and accepts `ssh-ed25519`
> user keys.  Verified against this stack: a push with an Ed25519 key created
> a change.

---

## 4. Seeded data

The story of the environment: the PM assigns concrete defects in the company's
SDK to the developer, the superagent takes the issues assigned to that
developer, fixes them in the repository the issue names, and pushes a patch
for review.

### Redmine

| project identifier | project name       | members                        |
|--------------------|--------------------|--------------------------------|
| `sdk`              | `Demo SDK`         | `dev` (Developer), `admin` (Manager) |
| `sdk-cli`          | `Demo SDK CLI`     | `dev` (Developer), `admin` (Manager) |
| `demo`             | `Demo Project`     | kept for compatibility; its issues are closed |

The project identifier is the name of the Gerrit repository, so an issue names
the repository its fix belongs to.

Issues (created by `seed.sh`; the ids are read from the API, never hard coded):

| project | subject | tracker | priority | status | assigned to |
|---------|---------|---------|----------|--------|-------------|
| `sdk` | `Paginator drops the last page of a collection whose size is not a multiple of the page size` | Bug | High | New | **dev** |
| `sdk` | `RetryPolicy retries 400/404 answers and slows down every failing request` | Bug | Normal | New | **dev** |
| `sdk` | `Access token is not refreshed before it expires: requests fail with 401 near the expiry time` | Bug | High | New | **dev** |
| `sdk-cli` | `--timeout is accepted but ignored: requests still use the 30 second default` | Bug | Normal | New | **dev** |
| `sdk` | `Document the 1.0 migration guide of the demo SDK` | Feature | Low | New | admin (the negative case: not the operator's task) |

```bash
curl -H "X-Redmine-API-Key: $REDMINE_ADMIN_API_KEY" \
     "http://localhost:3000/issues.json?assigned_to_id=me&status_id=open&include=project"
```

### Gerrit

| project | branch  | push URL | change URL |
|---------|---------|----------|------------|
| `sdk` | `main` (HEAD points at `refs/heads/main`) | `ssh://agent@localhost:29418/sdk` | `http://localhost:8080/#/c/sdk/+/<change-number>` |
| `sdk-cli` | `main` | `ssh://agent@localhost:29418/sdk-cli` | `http://localhost:8080/#/c/sdk-cli/+/<change-number>` |
| `demo` | `main` | `ssh://agent@localhost:29418/demo` | kept for compatibility |

The `sdk` project holds a small Python SDK (`demo_sdk`: client, pagination,
retry, auth) with a pytest suite, the `sdk-cli` project a command line front
end of it. Both carry the defect of their issue in the seeded snapshot, so the
agent has something real to fix:
`demo_sdk/pagination.py` rounds the page count down and drops the last
partial page, and `sdk_cli/main.py` does not forward the parsed `--timeout` to
the API client.

---

## 5. The scripts

### `seed.sh`

Idempotent. It

1. creates the Redmine projects `sdk` and `sdk-cli` (if missing),
2. adds the `dev` account as a Developer member and the PM as its Manager,
3. creates the defect issues, authored by the PM and assigned to `dev`, plus
   the negative case assigned to the PM (skipping the ones that already exist),
4. closes the issues of the old `demo` project,
5. creates the Gerrit projects `sdk` and `sdk-cli`, makes the agent an
   administrator,
6. clones each project over SSH and pushes the initial commit to
   `refs/heads/main` (skipped when the branch already exists),
7. points the project HEAD at `refs/heads/main`.

```bash
./seed.sh
```

### `verify.sh`

Exits non-zero when a check fails and prints one `PASS`/`FAIL` line per check.
It proves:

* Redmine answers on `http://localhost:3000` and the admin API key works,
* the seeded issues are listed by `GET /issues.json`, the defect issues are
  assigned to `dev` and the negative case to somebody else,
* the developer API key is accepted,
* `PUT /issues/<id>.json` with `{"issue":{"notes":"..."}}` returns `204` and
  the note shows up in `GET /issues/<id>.json?include=journals`,
* the `updated_on=><ISO8601>` filter of `GET /issues.json` works,
* `GET /a/projects/` (basic auth) lists the Gerrit project and the responses
  carry the `)]}'` prefix,
* `git push origin HEAD:refs/for/main` (as `agent`, over SSH) creates a change
  in `sdk` and in `sdk-cli`,
* the new change is readable through `GET /a/changes/<n>/detail` (with the
  `)]}'` prefix, status `NEW`), belongs to the agent, is in the right project
  and keeps its `Issue: #<id>` trailer, and is listed by
  `GET /a/changes/?q=project:sdk+status:open`.

```bash
./verify.sh
```

---

## 6. API notes (verified against this stack)

### Redmine 4.2

* Every write payload is **wrapped**: `{"project": {...}}`,
  `{"issue": {...}}`, `{"membership": {...}}`.  An unwrapped body is ignored
  (`PUT /issues/<id>.json` with `{"notes":"..."}` returns 204 but writes **no**
  journal).
* `GET /issues.json?updated_on=><ISO8601>` **does not work** — the operator has
  to be spelled `>=`:
  `?updated_on=>=2020-01-01T00:00:00Z` (second precision, `Z` suffix; a
  single `>` returns nothing, other formats are rejected with
  `422 "Updated is invalid"`).  The explicit syntax works as well:
  `?f[]=updated_on&op[updated_on]=>=&v[updated_on][]=2020-01-01T00:00:00Z`.
* `status_id` must **not** be sent when creating an issue (the request fails
  with 500).  Create the issue and set the status afterwards with
  `PUT /issues/<id>.json` `{"issue":{"status_id":5}}`.
* The assignee is returned as `{"id":..,"name":..}` — there is **no** `login`
  field.  Use `GET /users/current.json` (with the API key of the account) to
  map an account to its user id.
* A project created through the API has **no trackers** until they are
  enabled: `PUT /projects/<id>.json` `{"project":{"tracker_ids":[1,2,3]}}`.
  Without a tracker no issue can be created at all.
* The membership payload uses `role_ids`, not `roles`:
  `{"membership":{"user_id":5,"role_ids":[4]}}`.

### Gerrit 2.15

* In `auth.type = HTTP` mode Gerrit takes the identity from the `Authorization`
  header and looks it up as the external id `gerrit:<login>`.  Only the HTTP
  login flow creates that external id, so an account created over the REST API
  can never be used in the browser — Gerrit tries to create a second account
  with the same user name and answers `name already in use`, which the web UI
  shows as a *Configuration Error*.  The user name of an account cannot be
  changed (`realm does not allow editing username`), and the REST API of 2.15
  cannot add an external id either (`GET` and `POST .../external.ids:delete`
  only).  The account a person uses in the browser is therefore created by
  signing in over HTTP, and is then given its password and its rights.
* The account that the HTTP login flow creates has **no** password of its own:
  `PUT /a/accounts/<id>/password.http` (with the credentials of an
  administrator) sets one, and the REST API checks it from then on.
* Every JSON response starts with the anti hijacking prefix `)]}' followed by
  a newline — strip the first line before parsing.
* `status` is upper case (`NEW`, `MERGED`, `ABANDONED`).
* The web UI url of a change is the **new** form
  `http://localhost:8080/#/c/<project>/+/<number>` (the old `/c/<number>` form
  does not exist in 2.15).  `git push` prints it as
  `remote:   http://localhost:8080/#/c/demo/+/1001`.
* `revisions` are only part of the change detail when they are requested:
  `GET /a/changes/<n>/detail?o=ALL_REVISIONS`.  `revisions[].fetch` is an
  object, not a string.
* A **second patch set** of a change is a `git commit --amend --no-edit`
  (this keeps the `Change-Id`), followed by another push to
  `refs/for/<branch>`; the push answers `Processing changes: updated: 1`.
  A commit that re-uses the `Change-Id` of an existing change is folded into
  that change as another patch set; gerrit refuses it with
  `same Change-Id in multiple changes` as soon as the `Change-Id` would end up
  in two different changes.
* The `Change-Id` footer is added by Gerrit's commit-msg hook:
  `curl -u admin:admin12345 http://localhost:8080/tools/hooks/commit-msg -o .git/hooks/commit-msg`
  (then `chmod +x .git/hooks/commit-msg`).

---

## 7. Caveats

* **amd64 emulation.** `gerritcodereview/gerrit:2.15.13` is an amd64 only
  image.  On the arm64 host it is started with `platform: linux/amd64` and
  therefore runs through qemu user mode emulation.  Two consequences:
  * Gerrit needs **1–3 minutes** to start instead of a few seconds.
  * The JIT of the JVM must be limited to C1, otherwise the optimising
    compiler can stall the start-up for many minutes under emulation.  The
    compose file therefore sets
    `container.javaOptions = -Djava.security.egd=file:/dev/./urandom -XX:TieredStopAtLevel=1`
    (in `gerrit/start.sh`).
* **Gerrit start-up.** The site is bootstrapped inside the `gerrit` container
  (one short-lived instance in development authentication mode, then the real
  instance with `[auth] type = HTTP`).  A marker file
  (`/var/gerrit/etc/.dsh-superagent-bootstrapped`) remembers that this already
  happened, so later restarts go straight to the HTTP instance.  Delete the
  volume (`docker compose down -v`) to bootstrap again.
* **Gerrit context path** is `/` (the Gerrit default would be `/gerrit/`).
  The canonical URL is `http://localhost:8080/`.
* **Redmine default data.** The official image only runs `rake db:migrate`,
  which leaves the database without trackers, statuses, priorities and roles.
  `redmine/init.rb` loads them (`Redmine::DefaultData::Loader`) before it
  touches the users — without them no issue can be created at all.
* **H2 database.** Gerrit stores its metadata in an embedded H2 database inside
  the `gerrit_db` volume.  Only one Gerrit instance may use it at a time,
  which is why the bootstrap runs inside the `gerrit` container itself.
* **Seed data only.** The keys in `env/keys/` and all passwords in `.env` are
  checked into the repository on purpose — this is a local mock environment,
  never use these credentials anywhere else.

---

## 8. File layout

```
env/
├── .env                     # ports, credentials, API keys (source of truth)
├── docker-compose.yml       # the stack
├── README.md                # this file
├── seed.sh                  # idempotent seeding
├── verify.sh                # end to end verification (exit code != 0 on failure)
├── gerrit/
│   └── start.sh             # gerrit site bootstrap + start (runs in the container)
├── redmine/
│   └── init.rb              # redmine bootstrap (runs via `rails runner`)
├── scripts/
│   └── common.sh            # shared helpers of seed.sh / verify.sh
└── keys/
    ├── agent_id_ecdsa(.pub) # agent ssh key (default)
    ├── nginx.conf          # the front end of the review server
    └── agent_id_rsa(.pub)   # agent ssh key (alternative, needs +ssh-rsa)
```

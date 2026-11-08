# 009 Redmine and Gerrit APIs

**Status:** implementation-ready reference for the Redmine and Gerrit APIs that `dsh-superagent` uses.
**Target versions:** Redmine **4.2.x** (API v1, `application/json`), Gerrit Code Review **2.15.13** (REST API 2.x).

---

## 0. How to read this document

### 0.1 Verification legend

Every non-obvious claim in this document carries one of these markers:

| Marker | Meaning |
|---|---|
| **[L]** | **Verified live** against a real Redmine 4.2 container and a real Gerrit 2.15.13 container (command + observed output reproduced below). |
| **[S]** | **Verified against the 2.15.13 / 4.2 source or the version-pinned official documentation** (link given). |
| **[VERIFY]** | Could not be settled with the evidence available; **must be confirmed against the corporate stack before coding against it**. Every `[VERIFY]` item is repeated in Appendix C with the exact test to run. |

### 0.2 Evidence base

* Redmine: official container `redmine:4.2` (Rails 5.2.8.1, Redmine 4.2.x, SQLite) plus the **4.2-stable source tree** (`config/routes.rb`, `app/controllers/*`, `app/views/**/*.api.rsb`, `app/models/*`).
  Doc: <https://www.redmine.org/projects/redmine/wiki/Rest_api> (the version-pinned `https://www.redmine.org/docs/4.2/api/` currently returns HTTP 404 — the wiki page above is the live official document; the 4.2 behaviour differences are flagged inline below).
* Gerrit: official container `gerritcodereview/gerrit:2.15.13` plus the **v2.15.13 documentation tree** (`Documentation/*.txt` at tag `v2.15.13`).
  Doc: <https://gerrit-review.googlesource.com/Documentation/> (current) and the pinned 2.15.13 sources, e.g.
  <https://raw.githubusercontent.com/GerritCodeReview/gerrit/v2.15.13/Documentation/rest-api-changes.txt>.

### 0.3 Environment used for the live checks

The checks below ran against local Redmine 4.2 and Gerrit 2.15.13 containers. In the corporate deployment one Redmine account is bound to the Source (the operator's own account, `agent` in the checks below) and a separate Gerrit account is the one the agent pushes with; The repository `dsh-superagent-env`, next to this one, holds that scenario as a Docker Compose stack, with the demo SDK seeded in it, and its README has every address, account, API key and SSH key of it.

| Component | Address | Credentials used |
|---|---|---|
| Gerrit 2.15.13 HTTP | `http://127.0.0.1:8081` | `admin` / `secret` (docker image default), `agent` / `agentpass` (the account the agent pushes with) |
| Gerrit 2.15.13 SSH | `ssh://agent@127.0.0.1:29419` | key `/tmp/gkey/id_ed25519` (registered on the `agent` account) |
| Redmine 4.2 HTTP | `http://127.0.0.1:3001` | API key `c5d6cec28f97f242c103902e46c6d16d123d2f90` (admin), `2210edcf04981ef412d424e0602fec38997e7bf7` (user `agent`, the bound account) |

---

# Part A — Redmine 4.2.x REST API

## A.1 Preconditions

| Item | Value | Notes |
|---|---|---|
| Admin switch | `Administration → Settings → API → Enable REST web service` | Stored as `Setting.rest_api_enabled` (DB `settings` table, default `0`). **[S]** `config/settings.yml:311`. With it off, every `*.json` request is **not** API-authenticated and the request falls through to the HTML stack → 403/404. **[L]** |
| API key | 40 hex chars, one per user | In 4.2 the key is **not** a column on `users`; it lives in the `tokens` table (`action = 'api'`, `Token.find_active_user('api', key)`). `User#api_key` lazily creates it. **[S]** `app/models/user.rb:446`, `app/models/token.rb`. **[L]** |
| No REST route to create/rotate a key | — | `POST /users/1/api_key.json` → `ActionController::RoutingError` in 4.2. **[L]** Only the web UI (`/my/account`, `POST /my/api_key`) or direct DB access can mint a key. Provision the agent's key out of band. |
| Content type on writes | `Content-Type: application/json` | Mandatory on `POST`/`PUT` even though the URL ends in `.json`. **[S]** official doc: “Specify Content-Type on POST/PUT requests”. |

## A.2 Authentication

### A.2.1 The four accepted forms (4.2 behaviour)

Redmine 4.2 resolves the caller in `ApplicationController#find_current_user` **[S]** `app/controllers/application_controller.rb:125`:

```ruby
if user.nil? && Setting.rest_api_enabled? && accept_api_auth?
  if (key = api_key_from_request)                       # (a) ?key=  or  X-Redmine-API-Key
    user = User.find_by_api_key(key)
  elsif /\ABasic /i.match?(request.authorization.to_s)  # (b) HTTP Basic
    authenticate_with_http_basic do |username, password|
      user = User.try_to_login(username, password) || User.find_by_api_key(username)
    end
    if user && user.must_change_password?
      render_error :message => 'You must change your password', :status => 403
      return
    end
  end
  ...
end
```

| # | Form | Exact request | Result in 4.2 **[L]** |
|---|---|---|---|
| (a1) | API key as query parameter | `GET /issues.json?key=<APIKEY>` | **200**, authenticated as the key owner |
| (a2) | API key as header | `GET /issues.json` + `X-Redmine-API-Key: <APIKEY>` | **200**, authenticated as the key owner |
| (b1) | Basic, **key as username** | `curl -u "<APIKEY>:<anything>"` | works **only if** the account has `must_change_passwd = false` and its password is not expired; otherwise **403 with an empty body** |
| (b2) | Basic, login/password | `curl -u "login:password"` | same `must_change_password?` gate as (b1) |

`api_key_from_request` **[S]** (`application_controller.rb:706`):

```ruby
def api_key_from_request
  if params[:key].present?
    params[:key].to_s
  elsif request.headers["X-Redmine-API-Key"].present?
    request.headers["X-Redmine-API-Key"].to_s
  end
end
```

### A.2.2 Header form (exact bytes)

```
Authorization: Basic <base64(APIKEY:)>
X-Redmine-API-Key: <APIKEY>
```

```bash
# recommended: header form, no password anywhere
curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" \
     -H 'Content-Type: application/json' \
     http://127.0.0.1:3001/issues.json
```

### A.2.3 Two traps that will burn the implementation

1. **`apikey` as the Basic *username* does not work in 4.2.** `User.try_to_login("apikey", key)` fails (no such login) and the fallback is `User.find_by_api_key(username)` — i.e. it looks up a user *named* `apikey`. Result: **HTTP 401**. **[L]**
   The documented 4.2 form is *“API key as username with a random password”*: `curl -u "<APIKEY>:x"`. **[S]** official doc §Authentication.
2. **`must_change_passwd` produces a 403 with an EMPTY body.** The `render_error` path for a non-HTML format is `head @status` **[S]** (`application_controller.rb:560-573`), so the response has **no JSON, no message**. The stock `redmine:4.2` docker image creates `admin` with `must_change_passwd = true`, so *every* Basic-auth request to that instance returns 403 with an empty body. **[L]**
   The `?key=` / `X-Redmine-API-Key` branch sits *before* that check and is therefore unaffected — which is exactly why the header form is the recommended one. **[L]**

### A.2.4 Other authentication-adjacent behaviour

* **Impersonation**: `X-Redmine-Switch-User: <login>` works only for admin keys; invalid/unknown login → **412**. **[S]** official doc §User Impersonation.
* **Invalid key ≠ 401.** With a wrong key the request simply stays anonymous and returns whatever the anonymous user may see (usually `{"issues":[], ...}` with HTTP 200). **[L]** → *always* assert on the payload, never on "we got 200".

## A.3 Issue endpoints

### A.3.1 `GET /issues.json` — list issues

Request:

```bash
curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" \
  "http://redmine.example.com/issues.json?project_id=demo&status_id=*&sort=updated_on:desc&limit=25&offset=0"
```

Response envelope (JSON) **[L]**:

```json
{
  "issues": [
    {
      "id": 1,
      "project": {"id": 1, "name": "Demo"},
      "tracker": {"id": 1, "name": "Bug"},
      "status": {"id": 1, "name": "New"},
      "priority": {"id": 2, "name": "Normal"},
      "author": {"id": 1, "name": "Redmine Admin"},
      "assigned_to": {"id": 6, "name": "Alice Liddell"},
      "parent": {"id": 7},
      "subject": "Agent: implement login",
      "description": "Please fix the login flow.\r\n\r\ncc @agent",
      "start_date": "2026-11-05",
      "due_date": null,
      "done_ratio": 0,
      "is_private": false,
      "estimated_hours": null,
      "total_estimated_hours": null,
      "created_on": "2026-11-05T13:49:25Z",
      "updated_on": "2026-11-05T13:49:25Z",
      "closed_on": null
    }
  ],
  "total_count": 2,
  "offset": 0,
  "limit": 25
}
```

> `parent` is only rendered when the issue has a parent; `assigned_to` only when assigned; `category`, `fixed_version` only when set. **[S]** `app/views/issues/index.api.rsb`.

**Parameters we use**

| Parameter | Type | 4.2 semantics | Notes |
|---|---|---|---|
| `project_id` | id or identifier | restrict to project | `demo` (identifier) and `1` (id) both work **[L]** |
| `status_id` | int, `*`, or comma list | restrict by status; `*` = all (incl. closed) | `status_id=1` → only *New* **[L]**; `status_id=open` is **not** a 4.2 value (that is Redmine 5+) **[VERIFY]** |
| `updated_on` | date / datetime with operator | "changed since" filter — see below | |
| `sort` | `field:dir` | e.g. `updated_on:desc`, `id:desc`, `created_on:asc` | multiple sorts comma-separated **[S]** |
| `limit` | int | default **25**, **hard-capped at 100** | `limit > 100` is silently clamped to 100 **[S]** `api_offset_and_limit`; **[L]** |
| `offset` | int | row offset, `< 0` clamped to 0 | `offset` wins over `page` **[S]** |
| `page` | int | 1-based page; `page=3&limit=10` ≡ `offset=20&limit=10` | |
| `include` | csv | see A.3.2 | values: `attachments`, `relations` (index); `children`, `attachments`, `relations`, `changesets`, `journals`, `watchers` (show) **[S]** |
| `cf_<id>` | value | filter by custom field value | **silently ignored unless the custom field has “Filter” (`is_filter`) enabled** **[L]** |
| `nometa` | `1` | drop `total_count`/`limit`/`offset` | also `X-Redmine-Nometa: 1` header **[S]** |
| `issue_id` | csv | explicit id list | |
| `parent_id` | id | children of an issue | |
| `assigned_to_id` | id / `me` | | |

**“What changed since” semantics (`updated_on`)** — the critical filter for the polling loop.

| Value passed | 4.2 behaviour **[L]** |
|---|---|
| `updated_on=2026-01-01` | issues updated on that calendar day (server timezone) |
| `updated_on=>=2026-11-05T13:49:00Z` | issues with `updated_on >= 2026-11-05 13:49:00 UTC` → matched |
| `updated_on=<=2020-01-01` | issues updated on/before that day → correctly returned **none** |
| `updated_on=2026-11-05` | day granularity (matches everything from that day) |

Format rules (Redmine 4.2 `IssueQuery#build_from_params` → `add_short_filter`/`date_clause`) **[S]**:
* Value is `>=<datetime>` / `><<datetime>` / `=<datetime>` / `<datetime>` / `>=*` / `>*` / `<*`.
* Date-only values are interpreted at **00:00:00 in the instance timezone** (`Setting.time_zone`).
* Datetimes **with an explicit offset** (`Z`, `+08:00`) are honoured.
* The comparison is against `issues.updated_on`, which is bumped by *any* change to the issue **including a note/journal** — so a reply written by a human also moves the timestamp. **[L]**

> **Recommended polling filter:** `GET /issues.json?project_id=<p>&status_id=*&updated_on=>=<ISO8601 UTC>&sort=updated_on:asc&limit=100&offset=<n>`
> Use `>=` (not `>`) and store the **last seen `updated_on` + the last seen issue id** as the cursor, because several issues can share the same second. `sort=updated_on:asc` plus `limit=100` + `offset` paging is the stable way to drain a burst. **[L]**

### A.3.2 `GET /issues/<id>.json` — one issue

```bash
curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" \
  "http://redmine.example.com/issues/123.json?include=journals,attachments,relations,children,watchers"
```

Field set (4.2 `app/views/issues/show.api.rsb`) **[S]**:
`id, project, tracker, status, priority, author, assigned_to, category, fixed_version, parent, subject, description, start_date, due_date, done_ratio, is_private, estimated_hours, total_estimated_hours, spent_hours, total_spent_hours, created_on, updated_on, closed_on` **plus** `custom_fields` (rendered by `render_api_custom_values` whenever the value is visible) **plus** the `include`-gated arrays `attachments`, `relations`, `changesets`, `journals`, `watchers`, and `children` (via `render_api_issue_children`). **[L]**

> ### ⚠ `include=journal_details` is **not** a 4.2 value
> In 4.2 the include key is **`journals`**; the journal `details` array is **always** rendered inside each journal. `include=journal_details` is silently ignored → the response contains **no `journals` key at all** (HTTP 200). **[L]**
> Valid 4.2 `include` values: `attachments`, `relations`, `changesets`, `journals`, `watchers`, `children`. `journal_details` became a thing only in later Redmine versions. **[VERIFY]** (4.2 source shows no such key; the value is treated as an unknown include name and ignored).

### A.3.3 `POST /issues.json` — create

Body **must** be wrapped in an `issue` object (4.2 reads `params[:issue]`) **[S]** `issues_controller.rb:525`; an unwrapped body is silently ignored and yields `{"errors":["Subject cannot be blank", ...]}` with 422. **[L]**

```bash
curl -sS -X POST \
  -H "X-Redmine-API-Key: $REDMINE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
        "issue": {
          "project_id": "demo",
          "subject": "Agent: implement login",
          "description": "Please fix the login flow.\n\ncc @agent",
          "tracker_id": 1,
          "priority_id": 2,
          "assigned_to_id": 6,
          "parent_issue_id": 7,
          "custom_fields": [{"id": 1, "value": "pending"}],
          "watcher_user_ids": [5]
        }
      }' \
  http://redmine.example.com/issues.json
```

* Response: **HTTP 201** with the created issue object (`{"issue": {...}}`). **[L]**
* `project_id` may be the numeric id or the identifier. **[L]**
* `assigned_to_id` must reference a user **assignable in that project** (i.e. a project member with a role that permits assignment) — otherwise `422 {"errors":["Assignee is invalid"]}`. **[L]**
* `parent_issue_id` sets the parent/child relation; the response then contains `"parent": {"id": N}`. **[L]**
* `watcher_user_ids` adds watchers (members of the project). **[L]**
* `custom_fields` is an array of `{id, value}` objects. Unknown ids are **silently ignored** (204/201, no error). **[L]**

### A.3.4 `PUT /issues/<id>.json` — update

```bash
curl -sS -X PUT \
  -H "X-Redmine-API-Key: $REDMINE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
        "issue": {
          "notes": "Agent reply: implemented.\n\n<!-- superagent:run-1234 -->",
          "private_notes": false,
          "status_id": 2,
          "assigned_to_id": 5,
          "subject": "Agent: implement login (updated)",
          "custom_fields": [{"id": 1, "value": "done"}],
          "watcher_user_ids": [6],
          "uploads": [{"token": "4.a661266ea852d7e1ac4c2385f0d337a76b10e34b169c6318aeb3f50afe19839f"}]
        }
      }' \
  http://redmine.example.com/issues/123.json
```

**Response: HTTP 204 No Content with an empty body on success.** **[L]** (`render_api_ok` → `head :no_content`, `application_controller.rb:732`.)

Attribute table for 4.2 (`Issue#safe_attributes`) **[S]**:

| Key | Type | Notes |
|---|---|---|
| `notes` | string | creates a journal (see A.3.5). Empty/absent → no journal. |
| `private_notes` | bool | `true` → journal hidden from users without `view_private_notes`. **[L]** |
| `status_id` | int | must be reachable in the workflow for the current role. **An unknown `status_id` is silently ignored** (204, status unchanged) — not an error. **[L]** |
| `assigned_to_id` | int / `"me"` | `"me"` is resolved to the current user. Unknown id → **422 `{"errors":["Assignee is invalid"]}`**. **[L]** |
| `subject`, `description`, `start_date`, `due_date`, `done_ratio`, `estimated_hours`, `priority_id`, `category_id`, `fixed_version_id` | | normal attributes |
| `custom_fields` | `[{id, value}]` | unknown ids silently ignored **[L]** |
| `parent_issue_id` | int | set/change the parent; must be in the same project |
| `watcher_user_ids` | int[] | **replaces** the watcher set |
| `is_private` | bool | |
| `uploads` | `[{token}]` | attach previously uploaded files (A.3.7) |
| `last_journal_id` | int | optimistic-lock / conflict control, see below |
| `conflict_resolution` | `overwrite` \| `add_notes` \| `cancel` | conflict resolution strategy |
| `lock_version` | int | optimistic locking; stale value → `ActiveRecord::StaleObjectError` → conflict path |

**Conflict semantics (4.2)** **[S]** `issues_controller.rb:183-228`:
If another client updated the issue after you read it, `@issue.save` raises `StaleObjectError`; the controller catches it, sets `@conflict = true`, collects `@issue.journals_after(params[:last_journal_id])` and then **falls into the validation-error branch** → the API responds **422** (not 409) with the issue's validation messages (possibly `{"errors":[]}`). Recovery: re-read the issue, re-apply, and send `conflict_resolution: "add_notes"` (keeps both note sets) or `"overwrite"` (drops `lock_version`). **[L]** (422 path confirmed; the `409` that the task brief mentions is **not** what 4.2 emits — see A.9.)

### A.3.5 Journals (4.2 shape)

`GET /issues/<id>.json?include=journals` → the `journals` array, each entry **[L]**:

```json
{
  "id": 1,
  "user": {"id": 1, "name": "Redmine Admin"},
  "notes": "Agent reply: implemented.\n\n<!-- superagent-id:run-1234 -->",
  "created_on": "2026-11-05T13:49:25Z",
  "private_notes": false,
  "details": [
    {"property": "attr", "name": "subject",        "old_value": "Agent: implement login",            "new_value": "Agent: implement login (updated)"},
    {"property": "attr", "name": "status_id",      "old_value": "1",                                 "new_value": "2"},
    {"property": "attr", "name": "assigned_to_id", "old_value": "6",                                 "new_value": "5"}
  ]
}
```

> ### ⚠ Field names are `_on`, not `_at`
> Redmine 4.2 uses **`created_on` / `updated_on`** (ISO-8601 UTC, `"2026-11-05T13:49:25Z"`). There is **no `created_at` / `updated_at`** in the Redmine API. **[L]**
> `property` is `"attr"` for attribute changes; detail entries also use `"attachment"`, `"relation"`, `"issue"` in other flows. `old_value`/`new_value` are **strings**. **[L]**
> A journal whose only change is the note has `"details": []`. **[L]**

### A.3.6 `GET /issues/<id>.json` — no `spent_time` / `journals` API endpoints in 4.2

* There is **no `GET/POST /journals.json`** in 4.2 — the *Journals* API resource was introduced in **Redmine 5.0**. `journals_controller.rb` in 4.2 has **no** `accept_api_auth` declaration, so its API routes are not API-authenticated. **[S]** `app/controllers/journals_controller.rb`, `accept_api_auth` inventory (A.3.8). → In 4.2 notes are written **only** via `PUT /issues/<id>.json` with `notes`. **[L]**
* `spent_time` is **not** an issue attribute in 4.2; time is logged with `{"time_entry": {"hours": 1.5, "comments": "..."}}` inside the same `PUT /issues/<id>.json` body. **[S]** `issues_controller.rb:620-635`.
* `GET /issues/<id>.json` has no `spent_time` field; use `spent_hours` / `total_spent_hours` (present only if the caller may view time entries). **[L]**

### A.3.7 Attachments & uploads (4.2)

> ### ⚠ `POST /uploads.json` is **raw body**, not multipart, in 4.2
> `AttachmentsController#upload` **[S]** `app/controllers/attachments_controller.rb:100-124`:
> ```ruby
> def upload
>   unless request.content_type == 'application/octet-stream'
>     head 406
>     return
>   end
>   @attachment = Attachment.new(:file => raw_request_body)
>   @attachment.author = User.current
>   @attachment.filename = params[:filename].presence || Redmine::Utils.random_hex(16)
>   @attachment.content_type = params[:content_type].presence
>   ...
> end
> ```
> A `multipart/form-data` upload returns **HTTP 406 Not Acceptable**. **[L]**

Correct call **[L]**:

```bash
curl -sS -X POST \
  -H "X-Redmine-API-Key: $REDMINE_API_KEY" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @./build-report.txt \
  "http://redmine.example.com/uploads.json?filename=build-report.txt&content_type=text/plain"
```

Response (**201**):

```json
{"upload": {"id": 4, "token": "4.a661266ea852d7e1ac4c2385f0d337a76b10e34b169c6318aeb3f50afe19839f"}}
```

Attach it to an issue (note: an **array of objects** with a `token` key — a bare string array is silently ignored) **[L]**:

```json
{"issue": {"notes": "with attachment", "uploads": [{"token": "4.a661266ea852d7e1ac4c2385f0d337a76b10e34b169c6318aeb3f50afe19839f"}]}}
```

`GET /attachments/<id>.json` (200) **[L]**:

```json
{
  "attachment": {
    "id": 4,
    "filename": "note.txt",
    "filesize": 25,
    "content_type": "text/plain",
    "description": "",
    "content_url": "http://localhost:3001/attachments/download/4/note.txt",
    "author": {"id": 1, "name": "Redmine Admin"},
    "created_on": "2026-11-05T13:50:26Z"
  }
}
```

Downloading the bytes — use the `content_url`, not `/attachments/<id>`:

```bash
curl -sS -D - -o out.txt "http://redmine.example.com/attachments/download/4/note.txt"
```

```
HTTP/1.1 200 OK
Content-Type: text/plain
Content-Disposition: attachment; filename="note.txt"
Content-Length: 25
```

> `GET /attachments/<id>` (no `/download/`) returns the **HTML preview page** (`Content-Type: text/html`), not the file. **[L]**
> `Content-Type` is whatever was stored in `attachments.content_type`; `Content-Disposition` is `attachment; filename="<stored filename>"`. **[L]**

### A.3.8 Which 4.2 actions accept API auth

`accept_api_auth` declarations in the 4.2 tree **[S]** (this is the authoritative list of API-usable actions):

| Controller | API-enabled actions |
|---|---|
| `issues` | `index, show, create, update, destroy` |
| `projects` | `index, show, create, update, destroy` |
| `users` | `index, show, create, update, destroy` |
| `members` (project memberships) | `index, show, create, update, destroy` |
| `trackers` | `index` |
| `issue_statuses` | `index` |
| `enumerations` | `index` |
| `custom_fields` | `index` |
| `attachments` | `show, download, thumbnail, upload, update, destroy` |
| `watchers` | `create, destroy` (**no `index`**) |
| `journals` | **none** (no Journals API in 4.2) |
| `my` | `account` |

## A.4 Users

```bash
curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" "http://redmine.example.com/users.json?limit=100"
curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" "http://redmine.example.com/users/5.json"
```

`GET /users.json` **[L]**:

```json
{
  "users": [
    {
      "id": 1, "login": "admin", "admin": true,
      "firstname": "Redmine", "lastname": "Admin", "mail": "admin@example.net",
      "created_on": "2026-11-05T13:32:54Z",
      "updated_on": "2026-11-05T13:47:06Z",
      "last_login_on": "2026-11-05T13:46:53Z",
      "passwd_changed_on": "2026-11-05T13:47:06Z",
      "twofa_scheme": null
    },
    {"id": 5, "login": "agent", "admin": false, "firstname": "Super", "lastname": "Agent", "mail": "agent@example.com", "...": "..."}
  ],
  "total_count": 4, "offset": 0, "limit": 100
}
```

`GET /users/<id>.json` returns the same object **plus `api_key`** (the key itself is exposed to admins and to the owner) **[L]**:

```json
{"user": {"id": 5, "login": "agent", "admin": false, "firstname": "Super", "lastname": "Agent",
          "mail": "agent@example.com", "created_on": "...", "updated_on": "...", "last_login_on": null,
          "passwd_changed_on": "2026-11-05T13:46:36Z", "twofa_scheme": null,
          "api_key": "2210edcf04981ef412d424e0602fec38997e7bf7", "status": 1}}
```

> ### ⚠ `status=active` is **not** a valid 4.2 filter
> `UsersController#index` does `@status = params[:status] || 1` and then `User.logged.status(@status)` — the value must be the **numeric** status id. `status=active` matches nothing and returns `{"users":[],"total_count":0}` with HTTP 200. **[L]** `status=1` (active) or omitting `status` gives the active users. **[L]**
> Numeric statuses in 4.2: `1 = active`, `2 = registered`, `3 = locked`, `5 = locked by the system`. **[VERIFY]** (constants `User::STATUS_*`).
> `GET /users/current.json` is the cheapest authenticated self-check (200 → auth works; 403 empty body → not authenticated). **[L]**

## A.5 Projects and memberships

```bash
curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" "http://redmine.example.com/projects/demo.json"
curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" "http://redmine.example.com/projects.json?limit=100"
curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" "http://redmine.example.com/projects/1/memberships.json"
```

`GET /projects/<identifier>.json` **[L]**:

```json
{"project": {"id": 1, "name": "Demo", "identifier": "demo", "description": null,
             "homepage": "", "status": 1, "is_public": true, "inherit_members": false,
             "created_on": "2026-11-05T13:45:14Z", "updated_on": "2026-11-05T13:45:14Z"}}
```

`GET /projects/<id>/memberships.json` **[L]**:

```json
{
  "memberships": [
    {"id": 1, "project": {"id": 1, "name": "Demo"}, "user": {"id": 6, "name": "Alice Liddell"},
     "roles": [{"id": 4, "name": "Developer"}]},
    {"id": 2, "project": {"id": 1, "name": "Demo"}, "user": {"id": 5, "name": "Super Agent"},
     "roles": [{"id": 4, "name": "Developer"}]}
  ],
  "total_count": 2, "offset": 0, "limit": 25
}
```

> `GET /projects/<id>/memberships.json` requires the caller to be a member/admin of that project; otherwise 403. **[VERIFY]** (not exercised live).

## A.6 Trackers, statuses, priorities

```bash
curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" "http://redmine.example.com/trackers.json"
curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" "http://redmine.example.com/issue_statuses.json"
curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" "http://redmine.example.com/enumerations/issue_priority.json"
```

**[L]**:

```json
{"trackers": [
  {"id": 1, "name": "Bug",     "default_status": {"id": 1, "name": "New"}, "description": null},
  {"id": 2, "name": "Feature", "default_status": {"id": 1, "name": "New"}, "description": null},
  {"id": 3, "name": "Support", "default_status": {"id": 1, "name": "New"}, "description": null}
]}

{"issue_statuses": [
  {"id": 1, "name": "New",         "is_closed": false},
  {"id": 2, "name": "In Progress", "is_closed": false},
  {"id": 3, "name": "Resolved",    "is_closed": false},
  {"id": 4, "name": "Feedback",    "is_closed": false},
  {"id": 5, "name": "Closed",      "is_closed": true},
  {"id": 6, "name": "Rejected",    "is_closed": true}
]}

{"issue_priorities": [
  {"id": 1, "name": "Low",       "is_default": false, "active": true},
  {"id": 2, "name": "Normal",    "is_default": true,  "active": true},
  {"id": 3, "name": "High",      "is_default": false, "active": true},
  {"id": 4, "name": "Urgent",    "is_default": false, "active": true},
  {"id": 5, "name": "Immediate", "is_default": false, "active": true}
]}
```

The enumeration route is `GET /enumerations/<type>.json`; `type` is `issue_priority` or `time_entry_activity`. **[S]**

## A.7 Custom fields

```bash
curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" "http://redmine.example.com/custom_fields.json"
```

**[L]**:

```json
{"custom_fields": [
  {"id": 1, "name": "Agent", "customized_type": "issue", "field_format": "string",
   "regexp": "", "min_length": null, "max_length": null,
   "is_required": false, "is_filter": false, "searchable": false, "multiple": false,
   "default_value": null, "visible": true,
   "trackers": [{"id": 1, "name": "Bug"}], "roles": []}
]}
```

Shape of `custom_fields` inside an issue (rendered by `render_api_custom_values` for every visible custom field with a value) **[L]**:

```json
"custom_fields": [
  {"id": 1, "name": "Agent", "value": "done", "field_format": "string"}
]
```

> `GET /custom_fields.json` returns only the fields the caller may see (admins see all; role-scoped fields are filtered). **[VERIFY]**
> `is_filter: false` ⇒ the `cf_<id>` **query filter is silently ignored** (all issues are returned). Set “Filter” on the custom field (Administration → Custom fields) if the agent is supposed to filter by it. **[L]**

## A.8 Errors and status codes (4.2)

| Situation | Status | Body | Notes |
|---|---|---|---|
| Validation failure on create/update | **422** | `{"errors":["Subject cannot be blank","Project cannot be blank","Tracker cannot be blank","Status cannot be blank"]}` | `render_api_errors` → `common/error_messages.api`. **[L]** |
| Unknown issue id (`GET /issues/99999.json`) | **404** | **empty** | `render_404` → `head :forbidden`-style empty body for non-HTML formats. **[L]** |
| Unknown project (`GET /issues.json?project_id=nosuchproject`) | **404** | empty | **[L]** |
| Not authenticated / not permitted | **401** | empty | `authorize_global`/`require_login` → `head :unauthorized`. **[L]** |
| Authenticated but not allowed (e.g. `GET /users.json` as a non-admin) | **403** | empty | `render_403` → `head :forbidden`. **[L]** |
| `must_change_password?` on Basic auth | **403** | **empty** | A.2.3. **[L]** |
| Wrong `X-Redmine-Switch-User` | **412** | empty | **[S]** |
| Concurrent update conflict | **422** | `{"errors":[...]}` (possibly empty list) | `StaleObjectError` path, A.3.4. **[L]** |
| `POST /uploads.json` with wrong content type | **406** | empty | A.3.7. **[L]** |
| Invalid JSON body | **400** | `{"status":400,"error":"Bad Request"}` | Rails-level parse error (not a Redmine body). **[L]** |
| `POST /issues.json` with an unwrapped body | **422** | `{"errors":["Subject cannot be blank", ...]}` | A.3.3. **[L]** |

**There is no `409` in the Redmine 4.2 REST API.** If your client expects 409 for "conflict", map it to 422 + empty `errors`. **[L]**

**Error-body rule of thumb:** only *validation* failures produce `{"errors":[...]}`. Every other error status has an **empty body** — so the client must branch on the status code, never try to parse the body of an error. **[L]**

## A.9 Idempotency: posting a reply exactly once

Redmine 4.2 has **no** idempotency-key support, no `Idempotency-Key` header, no conditional-request support on writes, and **no de-duplication of identical notes** — issuing the same `PUT` twice creates two journals. **[L]** (journals 6 and 7 both contained `"same text"`).

### A.9.1 Options considered

| Option | How it works | Verdict |
|---|---|---|
| **(1) Hidden marker in the note body** | Put a machine-readable token in an HTML comment at the end of `notes`; before posting, `GET /issues/<id>.json?include=journals` and scan every journal's `notes` for the token. | **Primary.** Works on a stock 4.2 with zero server configuration; the marker is invisible in the web UI; the token can encode the run id + content hash. Costs one extra GET per reply. |
| **(2) Dedicated custom field** | Store the reply id in a custom field (e.g. `Agent Reply Id`) and read it back. | **Fallback.** Needs a custom field provisioned per project (and the field must be visible to the agent). A field holds only one value, so it can only guard *one* pending reply per issue — good enough when the agent posts at most one reply per ticket at a time. |
| **(3) Journal id + `last_journal_id`** | `PUT` returns 204 with **no** body, so the new journal id is **not** returned. You must re-read the issue and take the highest journal id. | Not an idempotency mechanism — it is a *conflict* mechanism. Useful in combination with (1) to avoid clobbering a concurrent human edit. |

### A.9.2 Recommended scheme (primary) — marker token in the note body

**Marker format used by the implementation** (HTML comment; Redmine renders it as text but the HTML is escaped in the web UI, so it is invisible in practice): the note ends with the outbound message's id, `<!-- dsh-superagent:<message id> -->`. A note the operator posts from the panel carries a marker of its own, `<!-- dsh-superagent-panel:<token> -->`; see A.9.5.

**Exact request the superagent sends** (this is the canonical call in the implementation):

```bash
# 1) compute the marker
BODY="Implemented the login flow; see the Gerrit change 1001."
MESSAGE_ID="reply-000123"
MARKER="<!-- dsh-superagent:${MESSAGE_ID} -->"

# 2) pre-flight: has this exact reply already been posted?
curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" \
  "http://redmine.example.com/issues/123.json?include=journals" \
| python3 -c '
import json,sys
marker = sys.argv[1]
d = json.load(sys.stdin)["issue"]
hit = [j for j in (d.get("journals") or []) if marker in (j.get("notes") or "")]
print("ALREADY_POSTED" if hit else "NOT_POSTED", [j["id"] for j in hit])
' "$MARKER"

# 3) post (only if NOT_POSTED)
curl -sS -X PUT \
  -H "X-Redmine-API-Key: $REDMINE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c '
import json,sys
print(json.dumps({"issue": {"notes": sys.argv[1] + "\n\n" + sys.argv[2]}}))
' "$BODY" "$MARKER")" \
  http://redmine.example.com/issues/123.json
```

**Why this is safe**

* The marker is stable for a message id → a retried message produces the *same* marker → the pre-flight finds it → no second journal. **[L]** (marker round-trip through `notes` → journal `notes` confirmed: journal 5 contained `"reply body\n\n<!-- dsh-superagent:run-abc123 -->"`).
* The marker survives round-trips: Redmine stores `notes` verbatim (CRLF is normalised to `\n` in the JSON body, the marker itself has no newlines). **[L]**
* `include=journals` returns the full journal list of the issue, so a scan is O(n) but complete. **[L]**
* Redmine escapes the raw text of notes in HTML output, so the comment is not rendered as a comment. **[S]** (notes are rendered with `h()`/`simple_format`).

**Rules for the implementer**

* Put the marker on the **last line** of `notes`, separated by a blank line.
* Never change the body text of a retry; keep `runId` stable for the whole run.
* Scan **all** journals, including private ones — the agent’s own journals are visible to the agent.
* If the pre-flight GET fails (network), **do not** post; retry the GET. Posting blind creates duplicates.

### A.9.3 Fallback scheme — dedicated custom field

1. Provision a custom field `Agent Reply Id` (string, visible to the agent's role) on the trackers the agent works on.
2. Before replying, `GET /issues/<id>.json` → read `custom_fields` → if the value already equals the intended reply id, skip.
3. Post the reply, then `PUT /issues/<id>.json` with `{"issue": {"custom_fields": [{"id": <cfId>, "value": "<replyId>"}]}}` to record it.

This costs two writes instead of one and only guards one in-flight reply per issue, but it survives note editing by humans and is greppable from the issue list. **[L]** (custom-field write path verified; the write is ignored only for *unknown* field ids.)

### A.9.4 Fallback when the agent must not touch notes twice — `last_journal_id`

When updating an issue the agent did not create, include the journal id it based the update on:

```json
{"issue": {"notes": "...", "last_journal_id": 42}}
```

If another writer updated the issue in the meantime, Redmine returns **422** instead of silently overwriting; re-read, merge, retry. **[S]** `issues_controller.rb:196-207`; **[L]** 422 path.

### A.9.5 One shared account: telling the agent's notes from a person's

In the company the operator cannot create a separate agent account, so the Source binds to the operator's own account, and that account writes both the agent's replies and the operator's notes. The markers above are what tells them apart:

- A note carrying `<!-- dsh-superagent:<message id> -->` is an agent reply, already delivered through the Outbox; the polling Source skips it.
- A note carrying `<!-- dsh-superagent-panel:<token> -->` is a reply the operator posted from the workbench, which was delivered to the agent immediately as a human Trigger; the polling Source skips it too.
- Every other journal on an issue the agent works is human input, whatever account wrote it — including the operator's own note written in the Redmine web UI, which is how the operator continues the task without mentioning the agent.

The markers are a convention, not a security boundary: anyone who can write a note could copy one. The Policy still decides what a journal means — a journal that reassigns the issue to the agent or mentions it is an explicit request from whoever wrote it, and the admission table governs the rest.

## A.10 Detecting “addressed to the agent”

Redmine has **no** `@mention` feature and no notification parser for `@login` in 4.2 (the "tribute" JS library in the web UI is only client-side autocomplete). **[S]**

Real mechanisms, in the order the agent should rely on them:

| Mechanism | Where it lives | Detection rule |
|---|---|---|
| **Plain-text `@login` convention** | Issue `description`, journal `notes` | regex over the issue text: `(?:^|[^\w])@([A-Za-z0-9_.-]+)` → match the agent's `login` (`agent`) case-insensitively. Accept `@agent`, `@Agent`, and `cc @agent` / `cc: @agent`. Do **not** match `@agentxyz` — require a word boundary after the login. |
| **`assigned_to_id`** | issue attribute | `issue.assigned_to.id == <agentUserId>` or `issue.assigned_to.name == "Super Agent"`. Strongest signal; use it as the primary trigger. |
| **`watcher_user_ids`** | issue watchers | the agent is a watcher → interested party. In the API, watchers appear only with `include=watchers` **[L]**; the *set* is writable with `PUT` (`watcher_user_ids`). |
| **Issue note addressed to nobody in particular** | journal `notes` | fallback: any new journal on an issue where the agent is assigned/watching. |
| **Custom field “Agent”** | `custom_fields` | an explicit workflow field (`value` = `pending` / `done`) — the cleanest corporate convention; see A.7. |

In the corporate deployment the bound account is the operator's own account and there is no separate `superagent` account, so the receipt rule is `assigned_to_id=me`: the Source lists the issues assigned to the bound account, and such an issue is the agent's. A journal is human input unless it carries one of the markers of A.9.5, because the operator's own notes and the agent's replies are written by the same account. The workbench reads the same list with `assigned_to_id=me&status_id=open`.

**Concrete detection rule for login `agent`:**

```python
import re
AGENT_LOGIN = "agent"

def mentions_agent(text: str) -> bool:
    if not text:
        return False
    # @login, optionally prefixed by cc/attn/to
    for m in re.finditer(r'(?:^|[^\w@])@([A-Za-z0-9_][A-Za-z0-9_.-]*)', text):
        if m.group(1).lower() == AGENT_LOGIN.lower():
            return True
    return False

def is_for_agent(issue: dict, agent_user_id: int) -> bool:
    if (issue.get("assigned_to") or {}).get("id") == agent_user_id:
        return True
    if mentions_agent(issue.get("description") or ""):
        return True
    return False
```

For journals (the “@agent replied in a comment” case), scan `journals[].notes` with the same regex — requires `include=journals`. **[L]**

> ### ⚠ Custom-field values do not render inside `notes`
> A field with `field_format = string` renders as its **value** (`done`), not as `cf_1`; a `text` field renders the value in a `<pre>`. So `@agent` inside a custom field is *not* a mention. **[S]** `app/models/field_format.rb`.

## A.11 Rate limits, sessions and long-running clients

* **No API throttling in Redmine 4.2 core.** There is no `rack-attack`, no per-user request counter, no API rate limiter anywhere in the 4.2 source. **[S]** — the only limits are the *pagination* limits (25 default / 100 max) and the underlying DB. **[L]**
  → If the corporate deployment puts a reverse proxy in front of Redmine, that proxy may impose limits: **[VERIFY]** (check nginx/`haproxy` config for `limit_req`).
* **`Setting.rest_api_enabled` must be `1`.** When it is `0`, API requests are not authenticated as API calls and the endpoint behaves like the HTML UI (403/404/redirect). **[S]** **[L]**
* **Sessions do not apply to API-key requests.** API auth does not create a session and needs no CSRF token; `Setting.session_lifetime` (default 20 minutes) is irrelevant to the agent. **[S]** The API-key path never touches `session[:user_id]`.
* **What *does* affect long-running clients:**
  * `must_change_passwd` on the API account → every Basic-auth call fails with a 403/empty body. Keep `must_change_passwd = false` for the agent account. **[L]**
  * `Setting.password_max_age` (days; `0` = never expires) → `password_expired?` → same 403 failure for Basic auth. **[L]**
  * `user.locked` / `user.active == false` → `User.find_by_api_key` returns `nil` (the token lookup requires an **active** user) → the request degrades to **anonymous**, i.e. HTTP 200 with an empty/filtered list, **not** an error. **[S]** `Token.find_active_user`; **[L]** (observed with an invalid key).
  * TCP/HTTP keep-alive: reuse a single `requests.Session` / `undici` agent; Redmine (Puma) closes idle keep-alive connections after ~5 s of inactivity by default — set a read timeout ≥ 30 s and a retry policy. **[VERIFY]** (Puma/Rack defaults; depends on the image's Puma config).
  * Set `Content-Type: application/json` on every write, otherwise Rails may not parse the body and the attributes are silently ignored (see A.3.3).

---

# Part B — Gerrit 2.15.13

## B.1 Push flow (SSH)

### B.1.1 SSH URL forms

Gerrit's SSH daemon listens on **29418** by default. **[S]**

| Form | Example | When to use |
|---|---|---|
| Explicit URI (**use this**) | `ssh://agent@gerrit.example.com:29418/demo` | always — unambiguous, port is explicit |
| scp-like | `agent@gerrit.example.com:demo` | **implies port 22** → only works if Gerrit's sshd is on 22. Do not use for `gerrit.example.com:29418`. |
| `git@host:project` (the “Gerrit convention”) | `git@gerrit.example.com:demo` | the *display* convention used in the web UI; it is **not** a runnable URL unless the sshd is on 22. Use `ssh://git@host:29418/project`. |

Working clone / push URL (verified live) **[L]**:

```bash
git clone ssh://agent@127.0.0.1:29419/demo
# equivalently, with an explicit port and no scheme ambiguity:
git clone ssh://agent@gerrit.example.com:29418/demo
```

Gerrit's own documentation for the push URL **[S]** (`user-upload.txt`):

```
git push ssh://sshusername@hostname:29418/projectname HEAD:refs/for/branch
```

### B.1.2 Host key handling (CI)

Gerrit's SSH daemon presents a host key; the client will refuse the first connection unless the key is known.

```bash
# CI / ephemeral containers — do not persist known_hosts
export GIT_SSH_COMMAND="ssh -i /tmp/gkey/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

# or, per-invocation
GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" git push ...
```

Security note: `StrictHostKeyChecking=no` disables host-key verification (MITM risk). For a corporate deployment, prefer pinning the host key:

```bash
mkdir -p ~/.ssh && ssh-keyscan -p 29418 gerrit.example.com >> ~/.ssh/known_hosts
# then use the default StrictHostKeyChecking=yes
```

The Gerrit 2.15.13 image ships its own SSH host keys under `/var/gerrit/etc/ssh_host_*_key`; `ssh-keyscan` against the container yields the same key. **[L]** (keys present in the image; `[VERIFY]` that `ssh-keyscan` output matches the key the sshd uses in the target deployment).

### B.1.3 Refspecs

| Refspec | Meaning |
|---|---|
| `HEAD:refs/for/<branch>` | create a **new change** for review on `<branch>` (`master`, `main`, `release/1.2`, …) |
| `HEAD:refs/for/<branch>%topic=<topic>` | same, and set the topic on the created change |
| `HEAD:refs/heads/<branch>` | push directly to the branch (bypasses review) — only if the user has “Push” on that ref and the project is not read-only |
| `HEAD:refs/for/<branch>^2` | create a **merge** in review (parent = branch tip, second parent = HEAD) |

`refs/for/<branch>` is **not** a real ref: Gerrit intercepts it. **[S]** “The remote ref `refs/for/experimental` is not actually created by Gerrit, even though the client's status messages may say otherwise.”

### B.1.4 Push options that exist in **2.15.13**

From `Documentation/user-upload.txt` at tag `v2.15.13` **[S]**:

| Option | Aliases | Example | Notes |
|---|---|---|---|
| `topic` | — | `HEAD:refs/for/master%topic=redmine-123` | also `-o topic=redmine-123` |
| `hashtag` | `t` | `HEAD:refs/for/master%hashtag=redmine-123` | case-insensitive match in the `hashtag:` query operator |
| `notify` | — | `%notify=NONE` | `NONE`, `OWNER`, `OWNER_REVIEWERS`, `ALL` (default `ALL`) |
| `notify-to` / `notify-cc` / `notify-bcc` | — | `%notify=NONE,notify-to=a@a.com` | email addresses |
| `work-in-progress` | `wip` | `%wip` | |
| `private` / `remove-private` | — | `%private` | |
| `message` | `m` | `%m=This_is_a_rebase_on_master%21` | `_`/`+` encode spaces; percent-encode ` %^@.~-+_:/!` |
| `publish-comments` / `no-publish-comments` | `np` | `%publish-comments` | publishes stored draft comments |
| `label` | `l` | `%l=Code-Review+1,l=Verified+1` | **review labels**; may be repeated |
| `reviewer` | `r` | `%r=a@a.com` | **email address only** |
| `cc` | — | `%cc=b@o.com` | email address only |
| `edit` | `e` | `%edit` | push a change edit |

> ### ⚠ Options that do **not** exist in 2.15.13
> * **`%(trailer:key=...)`** — the generic trailer push option (`%(trailer:key=Change-Id)`, `%(trailer:key=Signed-off-by)`) is **absent** from the 2.15.13 documentation and was introduced in a later release. Do not use it; add trailers with the `commit-msg` hook or by hand. **[S]** (no occurrence of `trailer` in `user-upload.txt` at `v2.15.13`) **[VERIFY]** (exact first release: 2.16 or 3.x).
> * **Reviewers by username** — in 2.15 `%r=`/`%cc=` take an **email address**; the “username without email” form arrived in later releases. **[S]**
> * **`-o reviewers=` (plural)** — not a 2.15 option; only `reviewer`/`r` and `cc`. **[S]**

### B.1.5 The Change-Id trailer

**Requirement:** every commit uploaded to `refs/for/*` must carry a `Change-Id: I<40-hex>` trailer in the **footer** (last paragraph) of the commit message. Gerrit groups patch sets of one change by `(project, branch, Change-Id)`. **[S]** `user-changeid.txt`.

Exact trailer format (note the capital `I` and 40 hex characters) **[S]**:

```
Change-Id: Ic8aaa0728a43936cd4c6e1ed590e01ba8f0fbf5b
```

Footer layout (the hook inserts `Change-Id` *before* `Signed-off-by`/`Acked-by`, and after `Bug:`/`Depends-on:`/`Issue:`/`Test:`/`Feature:`/`Fixes:`/`Fixed:` trailers — see `CHANGE_ID_AFTER` in the hook) **[S]**:

```
Improve foo widget by attaching a bar.

We want a bar, because it improves the foo by providing more
wizbangery to the dowhatimeanery.

Bug: #42
Change-Id: Ic8aaa0728a43936cd4c6e1ed590e01ba8f0fbf5b
Signed-off-by: A. U. Thor <author@example.com>
```

**How the hook generates it:** it builds a *virtual* commit object and takes its SHA-1:

```
tree <git write-tree>
parent <HEAD^0>            # omitted for the first commit
author <git var GIT_AUTHOR_IDENT>
committer <git var GIT_COMMITTER_IDENT>

<the commit message without the Change-Id>
```

and runs `git hash-object -t commit --stdin`; the resulting SHA-1 becomes the Change-Id (prefixed with `I`). **[S]** `cmd-hook-commit-msg.txt` §IMPLEMENTATION.

**Install the hook (from the Gerrit server):**

```bash
curl -Lo .git/hooks/commit-msg http://gerrit.example.com:8080/tools/hooks/commit-msg
chmod u+x .git/hooks/commit-msg
# or over SSH:
scp -p -P 29418 agent@gerrit.example.com:hooks/commit-msg .git/hooks/
```

**The exact 2.15.13 hook** (served at `http://<host>/tools/hooks/commit-msg`, 4781 bytes, first line `# From Gerrit Code Review 2.15.13`) **[S]** **[L]**:

```sh
#!/bin/sh
# From Gerrit Code Review 2.15.13
#
# Part of Gerrit Code Review (https://www.gerritcodereview.com/)
#
# Copyright (C) 2009 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

unset GREP_OPTIONS

CHANGE_ID_AFTER="Bug|Depends-On|Issue|Test|Feature|Fixes|Fixed"
MSG="$1"

# Check for, and add if missing, a unique Change-Id
#
add_ChangeId() {
	clean_message=`sed -e '
		/^diff --git .*/{
			s///
			q
		}
		/^Signed-off-by:/d
		/^#/d
	' "$MSG" | git stripspace`
	if test -z "$clean_message"
	then
		return
	fi

	# Do not add Change-Id to temp commits
	if echo "$clean_message" | head -1 | grep -q '^\(fixup\|squash\)!'
	then
		return
	fi

	if test "false" = "`git config --bool --get gerrit.createChangeId`"
	then
		return
	fi

	# Does Change-Id: already exist? if so, exit (no change).
	if grep -i '^Change-Id:' "$MSG" >/dev/null
	then
		return
	fi

	id=`_gen_ChangeId`
	T="$MSG.tmp.$$"
	AWK=awk
	if [ -x /usr/xpg4/bin/awk ]; then
		# Solaris AWK is just too broken
		AWK=/usr/xpg4/bin/awk
	fi

	# Get core.commentChar from git config or use default symbol
	commentChar=`git config --get core.commentChar`
	commentChar=${commentChar:-#}

	# How this works:
	# - parse the commit message as (textLine+ blankLine*)*
	# - assume textLine+ to be a footer until proven otherwise
	# - exception: the first block is not footer (as it is the title)
	# - read textLine+ into a variable
	# - then count blankLines
	# - once the next textLine appears, print textLine+ blankLine* as these
	# aren't footer
	# - in END, the last textLine+ block is available for footer parsing
	$AWK '
	BEGIN {
		if (match(ENVIRON["OS"], "Windows")) {
			RS="\r?\n" # Required on recent Cygwin
		}
		# while we start with the assumption that textLine+ is a footer,
		# the first block is not.
		isFooter = 0
		footerComment = 0
		blankLines = 0
	}

	# Skip lines starting with commentChar without any spaces before it.
	/^'"$commentChar"'/ { next }

	# Skip the line starting with the diff command and everything after it,
	# up to the end of the file, assuming it is only patch data.
	# If more than one line before the diff was empty, strip all but one.
	/^diff --git / {
		blankLines = 0
		while (getline) { }
		next
	}

	# Count blank lines outside footer comments
	/^$/ && (footerComment == 0) {
		blankLines++
		next
	}

	# Catch footer comment
	/^\[[a-zA-Z0-9-]+:/ && (isFooter == 1) {
		footerComment = 1
	}

	/]$/ && (footerComment == 1) {
		footerComment = 2
	}

	# We have a non-blank line after blank lines. Handle this.
	(blankLines > 0) {
		print lines
		for (i = 0; i < blankLines; i++) {
			print ""
		}

		lines = ""
		blankLines = 0
		isFooter = 1
		footerComment = 0
	}

	# Detect that the current block is not the footer
	(footerComment == 0) && (!/^\[?[a-zA-Z0-9-]+:/ || /^[a-zA-Z0-9-]+:\/\//) {
		isFooter = 0
	}

	{
		# We need this information about our current last comment line
		if (footerComment == 2) {
			footerComment = 0
		}
		if (lines != "") {
			lines = lines "\n";
		}
		lines = lines $0
	}

	# Footer handling:
	# If the last block is considered a footer, splice in the Change-Id at the
	# right place.
	# Look for the right place to inject Change-Id by considering
	# CHANGE_ID_AFTER. Keys listed in it (case insensitive) come first,
	# then Change-Id, then everything else (eg. Signed-off-by:).
	#
	# Otherwise just print the last block, a new line and the Change-Id as a
	# block of its own.
	END {
		unprinted = 1
		if (isFooter == 0) {
			print lines "\n"
			lines = ""
		}
		changeIdAfter = "^(" tolower("'"$CHANGE_ID_AFTER"'") "):"
		numlines = split(lines, footer, "\n")
		for (line = 1; line <= numlines; line++) {
			if (unprinted && match(tolower(footer[line]), changeIdAfter) != 1) {
				unprinted = 0
				print "Change-Id: I'"$id"'"
			}
			print footer[line]
		}
		if (unprinted) {
			print "Change-Id: I'"$id"'"
		}
	}' "$MSG" > "$T" && mv "$T" "$MSG" || rm -f "$T"
}
_gen_ChangeIdInput() {
	echo "tree `git write-tree`"
	if parent=`git rev-parse "HEAD^0" 2>/dev/null`
	then
		echo "parent $parent"
	fi
	echo "author `git var GIT_AUTHOR_IDENT`"
	echo "committer `git var GIT_COMMITTER_IDENT`"
	echo
	printf '%s' "$clean_message"
}
_gen_ChangeId() {
	_gen_ChangeIdInput |
	git hash-object -t commit --stdin
}


add_ChangeId
```

**Manual alternative** (no hook): write the trailer yourself and keep it stable across rebases/amends:

```bash
COMMIT_SHA=$(git rev-parse HEAD)
CHANGE_ID="I$(git hash-object -t commit --stdin <<EOF
tree $(git write-tree)
parent $(git rev-parse HEAD^0 2>/dev/null || true)
author $(git var GIT_AUTHOR_IDENT)
committer $(git var GIT_COMMITTER_IDENT)

$(git log -1 --format=%B)
EOF
)"
git commit --amend -m "$(git log -1 --format=%B)

Change-Id: $CHANGE_ID"
```

**How Gerrit rejects a change without a Change-Id** (verbatim push output, 2.15.13) **[L]**:

```
remote: 
remote: Processing changes: refs: 1        
remote: Processing changes: refs: 1, done            
remote: commit b008816: ERROR: missing Change-Id in message footer        
remote: 
remote: Hint: to automatically insert a Change-Id, install the hook:        
remote:   gitdir=$(git rev-parse --git-dir); scp -p -P 29418 agent@localhost:hooks/commit-msg ${gitdir}/hooks/        
remote: and then amend the commit:        
remote:   git commit --amend        
remote: 
To ssh://localhost:29419/demo
 ! [remote rejected] HEAD -> refs/for/master (commit b008816: missing Change-Id in message footer)
error: failed to push some refs to 'ssh://localhost:29419/demo'
```

`git push` exit code: **1**. **[L]**

### B.1.6 Push output and how to parse the change number

Successful push (2.15.13, new Angular UI) — **stderr**, verbatim **[L]**:

```
remote: 
remote: Processing changes: new: 1 (|)         ...
remote: Processing changes: new: 1, done            
remote: 
remote: New Changes:        
remote:   http://localhost:8081/#/c/demo/+/1001 Add greeting        
remote: 
To ssh://localhost:29419/demo
 * [new reference]   HEAD -> refs/for/master
```

* The change URL in **2.15** uses the new UI form **`http://<host>/#/c/<project>/+/<change-number>`**. Older 1.x/2.0–2.14 used `http://<host>/<change-number>`. **[L]**
* The `remote:` lines contain **progress-spinner artefacts** (carriage returns, `(\)`, `(|)`, padding spaces) — parse defensively. **[L]**
* Git writes the ref status (`To …` / `* [new reference]`) and the `remote:` lines to **stderr**; stdout is empty for `git push`. **[L]** → always capture **both** streams (`2>&1`).

**Robust parsing (recommended order):**

1. **Preferred — ask the server.** The change number is the authoritative source; the push output is only a hint.

   ```bash
   CHANGE_ID=$(git log -1 --format=%B | sed -n 's/^Change-Id: //p')
   curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" \
        "http://gerrit.example.com:8080/a/changes/?q=project:${PROJECT}+change:${CHANGE_ID}" \
     | tail -c +6 \
     | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[0]["_number"] if d else "")'
   ```

   The `change:` operator accepts the **40-hex Change-Id without** the `I` prefix — verified live with `q=change:Idfb135961c5ac8351b3de04b2ed4c95ec5ec80b3` → 200. **[L]** The `I`-prefixed form (`change:I<hex>`) is accepted by Gerrit's Change-Id parser **[VERIFY]**; prefer the form that is echoed back by `ChangeInfo.change_id` minus the `I`.
2. **Fallback — regex the push output.**

   ```python
   import re
   PUSH_URL_RE = re.compile(r'^\s*remote:\s+(https?://\S+/#/c/[^/\s]+/\+/(\d+))', re.M)
   LEGACY_RE   = re.compile(r'^\s*remote:\s+(https?://\S+?/(\d+))\s*$', re.M)

   def parse_change_number(push_output: str):
       m = PUSH_URL_RE.search(push_output)
       if m:
           return int(m.group(2)), m.group(1)
       m = LEGACY_RE.search(push_output)          # pre-2.15 UI
       if m:
           return int(m.group(2)), m.group(1)
       return None, None
   ```

   Normalise the captured text first: strip `\r`, drop the progress lines (`Processing changes: …`), and keep only lines starting with `remote:`.

### B.1.7 `git push` exit codes and the 2.15.13 error catalogue

`git push` exit codes are git's, not Gerrit's: **0** = success, **1** = the remote rejected at least one ref, **128** = transport failure (auth, host key, connection refused). **[S]** git documentation.

| Failure | Verbatim remote output (2.15.13) **[L]** | git exit |
|---|---|---|
| Missing `Change-Id` | `remote: commit <sha>: ERROR: missing Change-Id in message footer` + `! [remote rejected] HEAD -> refs/for/master (commit <sha>: missing Change-Id in message footer)` | 1 |
| Target branch does not exist | `! [remote rejected] HEAD -> refs/for/nosuchbranch (branch nosuchbranch not found)` | 1 |
| Committer e-mail not registered on the pushing account | `remote: error: commit <sha>: email address <mail> is not registered in your account, and you lack 'forge committer' permission.` + `remote: The following addresses are currently registered:` + `remote:    <mail>` + `remote: To register an email address, visit:` + `remote: http://<host>/#/settings/contact` → `! [remote rejected] … (commit <sha>: invalid committer)` | 1 |
| Push rejected by Gerrit policy (e.g. missing submit requirement) | `remote: ERROR: …` with the policy reason | 1 |
| Ref is locked | `remote: error: branch <name> is locked` **[VERIFY]** (no REST lock endpoint in 2.15 — locking is done in the admin UI / by policy; the exact 2.15 message not observed live) | 1 |
| User lacks “Push” on the target ref | `remote: ERROR: You do not have 'Push' permission …` **[VERIFY]** (not reproduced live: the verification project inherited a permissive `All-Projects` access list; run the test with a project that has an explicit access list) | 1 |
| SSH auth failure | `Permission denied (publickey)` from the ssh client | 255 (git) |
| Host key unknown | `Host key verification failed.` | 255 (git) |
| Change already uploaded (same Change-Id) | `! [remote rejected] … (no new changes)` — happens when pushing a commit that already exists as a change owned by someone else. **[L]** | 1 |

> **Always configure the committer identity to match the Gerrit account.** The `invalid committer` rejection is the most common first-push failure in a fresh container. Set `git config user.email "<the e-mail registered in the Gerrit account>"` and `user.name "<full name>"` **before** committing. **[L]**

## B.2 Gerrit 2.15.13 REST API

### B.2.1 Base URL, authentication, and the magic prefix

* Base: `http://<host>:8080` (the container's HTTP port).
* **Authenticated endpoints are prefixed with `/a/`**: `http://<host>:8080/a/changes/?q=…`. **[S]**
* Auth for `/a/` endpoints: **HTTP Basic with the account's HTTP password** (the “HTTP password” set on the Gerrit account page, *not* the SSH key). **[S]**
  Alternatives in 2.15: an `access_token` query parameter (no XSRF needed) **[S]**, or a cookie + `X-Gerrit-Auth` header (XSRF) — the latter is for browsers, not for an agent.
* **Magic prefix:** every JSON response body starts with the four bytes `)]}'` followed by a newline; the rest is the JSON document. This is an anti-XSSI guard and must be stripped before parsing. **[S]** **[L]**

  ```python
  def gerrit_json(resp_text: str):
      # the prefix is exactly ")]}'" + "\n"
      assert resp_text.startswith(")]}'")
      return json.loads(resp_text[5:])          # 4 bytes + newline
  ```

  ```bash
  curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" \
       "http://gerrit.example.com:8080/a/changes/?q=project:demo+status:open" \
    | tail -c +6 \
    | python3 -m json.tool
  ```

  Notes: **[L]**
  * The prefix is present on **successful** responses of every `/a/` endpoint (including `/a/projects/`, `/a/accounts/self`, `/a/changes/<id>/detail`).
  * **Error responses are `text/plain` and have NO prefix** — e.g. `Unauthorized`, `Not found: messages`, `Forbidden`, `change is merged`. Do not blindly strip 5 bytes from an error body. **[L]**
  * Content type of a JSON response: `application/json; charset=UTF-8`. **[S]**
  * Compact (non-pretty) JSON: send `Accept: application/json` or add `pp=0`. **[S]**

### B.2.2 Endpoint inventory (2.15.13)

| Purpose | Endpoint (2.15.13) | Notes |
|---|---|---|
| Query changes | `GET /a/changes/?q=<query>&n=<limit>&S=<start>` | returns an **array** of `ChangeInfo`; `n` limits, `S`/`start` skips; the last element may carry `"_more_changes": true`. **[S]** **[L]** |
| One change (summary) | `GET /a/changes/<change-id>` | `<change-id>` may be the **numeric legacy id** (`1001`) or `project~branch~Change-Id` (URL-encoded). **[L]** |
| One change (detail) | `GET /a/changes/<change-id>/detail` | includes labels, reviewers, messages. **[L]** |
| Change messages | **not available as a separate endpoint in 2.15** | `GET /a/changes/<id>/messages` → **404 `Not found: messages`** **[L]**. Use `GET /a/changes/<id>/detail?o=MESSAGES` — the `messages` array then carries `{id, tag, author, real_author, date, message, _revision_number}`. **[L]** |
| Inline comments | `GET /a/changes/<change-id>/comments` | map of file path → list of `CommentInfo` (`patch_set`, `id`, `line`, `in_reply_to`, `message`, `updated`, `author`). **No pagination parameters in 2.15** — it returns the published comments of *all* revisions. **[S]** **[L]** (returns `{}` when there are none) |
| Robot comments | `GET /a/changes/<change-id>/robotcomments` | exists in 2.15 **[S]** |
| Drafts | `GET /a/changes/<change-id>/drafts` (and `POST`/`DELETE` variants) | exists in 2.15; returns `{}` when empty **[L]** |
| Review (read) | `GET /a/changes/<change-id>/revisions/<rev>/review` | returns `ChangeInfo` **[L]** |
| Review (write) | `POST /a/changes/<change-id>/revisions/<rev>/review` | `ReviewInput` body, see B.2.5 **[L]** |
| Submit | `POST /a/changes/<change-id>/submit` | body optional (`{"on_behalf_of": <accountId>}`); returns `ChangeInfo` with `"status":"MERGED"`; 409 with a plain-text reason when the submit rules block it **[S]** |
| Abandon | `POST /a/changes/<change-id>/abandon` | body optional (`{"message": "..."}`); returns `ChangeInfo` with `"status":"ABANDONED"`; 409 `"change is merged"` when not abandonable **[S]** |
| Restore | `POST /a/changes/<change-id>/restore` | **[S]** |
| Rebase | `POST /a/changes/<change-id>/rebase` | **[S]** |
| Topic | `GET/PUT/DELETE /a/changes/<change-id>/topic` | **[S]**; verified live (`PUT` → `)"redmine-123"`) **[L]** |
| Assignee | `GET/PUT/DELETE /a/changes/<change-id>/assignee` | **[S]** |
| Hashtags | `GET/PUT /a/changes/<change-id>/hashtags` | **[S]** |
| Commit message | `PUT /a/changes/<change-id>/message` | **[S]** |
| Projects | `GET /a/projects/` (map), `GET /a/projects/<project>` | **[L]** |
| Project branches | `GET /a/projects/<project>/branches/` | `[{ref, revision, web_links…}]` **[L]** |
| Project tags (git refs) | `GET /a/projects/<project>/tags/` | **git tags**, not review tags **[L]** |
| Project labels | **does not exist in 2.15** | `GET /a/projects/demo/labels` → **404 `Not found: labels`** **[L]** |
| Access list | `GET /a/projects/<project>/access`, `PUT …/access` | **[L]** |
| Accounts | `GET /a/accounts/self`, `GET /a/accounts/?q=…`, `PUT /a/accounts/<username>` | account creation in 2.15 is `PUT /accounts/<username>` with `AccountInput` (`name`, `email`, `http_password`, `ssh_key`, `groups`) **[S]** **[L]** (201 + `)]}'` prefix) |
| Groups | `GET /a/groups/<group>/members`, `POST /a/groups/<group>/members.add` | **[L]** |
| Server version | `GET /a/config/server/version` | **the 2.15 path is `/config/server/version`** — the modern `/config/server-version` returns **404** in 2.15. The 2.15 body is a bare JSON **string**: `)]}' "2.15.13"` (not an object). **[L]** **[S]** |
| Server info / capabilities | `GET /a/config/server/info`, `GET /a/config/server/capabilities` | **[S]** |

### B.2.3 The `q=` query syntax (2.15.13)

Operators **[S]** (`user-search.txt` at `v2.15.13`):

| Operator | Meaning | Example |
|---|---|---|
| `project:` / `p:` | project (regex if it starts with `^`) | `project:demo` |
| `projects:` | project prefix | `projects:de` |
| `branch:` | target branch (`refs/heads/` prefix optional; regex with `^`) | `branch:main` |
| `status:` | `open` (alias `pending`), `closed`, `merged`, `abandoned`, `reviewed` | `status:open` |
| `owner:` / `o:` | change owner; `owner:self` | `owner:agent` |
| `reviewer:` / `cc:` | reviewer / cc (`self` allowed) | `reviewer:alice@example.com` |
| `assignee:` | assignee | `assignee:agent` |
| `change:` | legacy numeric id **or** Change-Id | `change:I1234…` / `change:1001` |
| `after:` / `since:` | updated **after** (inclusive) `YYYY-MM-DD[ hh:mm:ss[.ffffff][ ±hhmm]]` | `after:2026-01-01` |
| `before:` / `until:` | updated **before** (inclusive) | `before:2026-01-01` |
| `topic:` | exact topic match | `topic:redmine-123` |
| `intopic:` | full-text topic search | `intopic:redmine` |
| `hashtag:` | hashtag (case-insensitive) | `hashtag:redmine-123` |
| `message:` | full-text search of the commit message | `message:"redmine-123"` |
| `comment:` | full-text search of comments | |
| `is:` | `open`, `closed`, `merged`, `abandoned`, `wip`, `private`, `watched`, `owner`, `reviewer`, `cc`, `starred`, `submittable`, `mergeable`, `ignored`, `reviewed`, `unassigned`, `assigned` | `is:open` |
| `label:` | label vote | `label:Code-Review=1` |
| `has:` | `has:star`, `has:stars`, `has:message` | |
| `tr:` / `bug:` | tracked-issue id (see B.5) | `tr:123` |
| `file:` / `path:` | file path in the change | `path:src/` |
| `age:` | time since last update (`age:2d`) | |

Boolean operators **[S]**: operators are ANDed by default; `AND`, `OR`, `NOT` (all caps) are supported; any operator can be negated with a leading `-` (e.g. `-is:starred`); parentheses group expressions; **OR has higher precedence than AND**. Quoted values: `message:"the value"` or `message:{the value}`.

> ### ⚠ There is **no** `updated:` operator in 2.15.13
> `GET /a/changes/?q=updated:2020-01-01` → **HTTP 400 `Unsupported operator updated:2020-01-01`** **[L]**.
> Use **`after:` / `since:`** (and `before:` / `until:`) — “updated since X” is `after:X`. **[S]** **[L]**

**Worked examples**

```bash
# 1) all open changes of project demo
curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" \
  "http://gerrit.example.com:8080/a/changes/?q=project:demo+status:open" | tail -c +6

# 2) changes updated since a date (use after:, not updated:)
curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" \
  "http://gerrit.example.com:8080/a/changes/?q=project:demo+after:2026-01-01" | tail -c +6

# 3) with a space encoded as %20 (equivalent to '+')
curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" \
  "http://gerrit.example.com:8080/a/changes/?q=project:demo%20owner:agent%20status:open" | tail -c +6

# 4) the agent's open changes in a project, with the current revision
curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" \
  "http://gerrit.example.com:8080/a/changes/?q=project:demo+owner:agent+is:open&o=CURRENT_REVISION&n=50" | tail -c +6

# 5) everything the agent should look at, by topic (the Redmine correlation key)
curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" \
  "http://gerrit.example.com:8080/a/changes/?q=project:demo+topic:redmine-123" | tail -c +6
```

> **URL-encoding rule:** in a `q=` value, a space is `+` or `%20`; a literal `+` must be `%2B`. Quote values containing spaces: `message:"redmine-123"`. **[L]** (both `+` and `%20` verified).

### B.2.4 Change detail JSON shape (2.15.13)

`GET /a/changes/1001/detail` — live response from Gerrit 2.15.13 **[L]** (abridged; field names are the 2.15 ones):

```json
)]}'
{
  "id": "demo~master~Idfb135961c5ac8351b3de04b2ed4c95ec5ec80b3",
  "project": "demo",
  "branch": "master",
  "topic": "redmine-123",
  "hashtags": [],
  "change_id": "Idfb135961c5ac8351b3de04b2ed4c95ec5ec80b3",
  "subject": "Add greeting",
  "status": "NEW",
  "created": "2026-11-05 13:37:20.000000000",
  "updated": "2026-11-05 13:37:20.000000000",
  "submit_type": "MERGE_IF_NECESSARY",
  "mergeable": true,
  "insertions": 1,
  "deletions": 0,
  "unresolved_comment_count": 0,
  "has_review_started": true,
  "_number": 1001,
  "owner": {
    "_account_id": 1000001,
    "name": "Super Agent",
    "email": "agent@example.com",
    "username": "agent",
    "avatars": [ ... ]
  },
  "labels": {
    "Code-Review": {
      "values": {"-2": "This shall not be merged", "-1": "…", " 0": "No score", "+1": "…", "+2": "Looks good to me, approved"},
      "default_value": 0,
      "all": [ {"value": 0, "_account_id": 1000001, "name": "Super Agent", "email": "agent@example.com", "username": "agent"} ]
    }
  },
  "permitted_labels": { "Code-Review": ["-2", "-1", " 0", "+1", "+2"] },
  "reviewers": { "REVIEWER": [ {"_account_id": 1000001, "name": "Super Agent", "email": "agent@example.com", "username": "agent"} ] },
  "current_revision": "054707217028e92ced27ce5eb23c1d65e3a4b5c4",
  "revisions": {
    "054707217028e92ced27ce5eb23c1d65e3a4b5c4": {
      "kind": "REWORK",
      "_number": 1,
      "created": "2026-11-05 13:37:20.000000000",
      "uploader": {"_account_id": 1000001, "name": "Super Agent", "email": "agent@example.com", "username": "agent"},
      "ref": "refs/changes/01/1001/1",
      "fetch": {
        "ssh": {"url": "ssh://agent@localhost:29418/demo", "ref": "refs/changes/01/1001/1"},
        "anonymous http": {"url": "http://localhost:8081/demo", "ref": "refs/changes/01/1001/1"}
      },
      "commit": { "commit": "0547072…", "parents": [ {"commit": "c3bbff7…", "subject": "Initial commit"} ], "author": {…}, "committer": {…}, "subject": "Add greeting", "message": "…", "uploader": {…} }
    }
  },
  "messages": [
    {"id": "cee9d0d6…", "tag": "autogenerated:gerrit:newPatchSet",
     "author": {"_account_id": 1000001, "name": "Super Agent", "email": "agent@example.com", "username": "agent"},
     "date": "2026-11-05 13:37:20.000000000",
     "message": "Uploaded patch set 1.", "_revision_number": 1}
  ]
}
```

Field notes:

* `id` = `<project>~<branch>~<Change-Id>` (URL-encode `~` as `%7E` if you build URLs by hand; the plain form works in practice). **[S]**
* `status` ∈ `NEW`, `MERGED`, `ABANDONED`. **[S]**
* Timestamps are **UTC strings** `"yyyy-mm-dd hh:mm:ss.nnnnnnnnn"` (space separator, 9 fractional digits) — *not* ISO-8601. **[S]**
* `_number` is the legacy numeric change id (the `1001` in the web URL). **[S]**
* `current_revision` is the **40-hex commit sha of the current patch set** — this is the `<rev>` you must use for the review endpoint. **[S]** **[L]**
* `revisions` is a **map keyed by commit sha**; each `RevisionInfo` has `kind`, `_number` (patch-set number), `created`, `uploader`, `ref`, `fetch` (`git`/`http`/`ssh` map → `{url, ref}`), `commit`, `files`, `actions`, `description`. **[S]**
* `labels` / `permitted_labels` / `reviewers` / `removable_reviewers` are present **on `/detail` by default**; on `GET /changes/?q=…` they only appear with `o=DETAILED_LABELS` (or `o=LABELS` for the summary). **[S]**
* `o=` options available in 2.15 (add to the query string, repeatable): `LABELS`, `DETAILED_LABELS`, `CURRENT_REVISION`, `ALL_REVISIONS`, `DOWNLOAD_COMMANDS`, `CURRENT_COMMIT`, `ALL_COMMITS`, `CURRENT_FILES`, `ALL_FILES`, `DETAILED_ACCOUNTS`, `REVIEWER_UPDATES`, `MESSAGES`, `ACTIONS`, `CHANGE_ACTIONS`, `REVIEWED`, `SUBMITTABLE`, `WEB_LINKS`, `CHECK`, `COMMIT_FOOTERS`, `PUSH_CERTIFICATES`, `TRACKING_IDS`. **[S]**
* ⚠ In a container, `fetch.ssh.url` contains the **container-internal** port (`29418`) unless `gerrit.canonicalWebUrl` and the SSH port are configured to match the published port — do not use `fetch` URLs verbatim from the agent. **[L]**

### B.2.5 Review input (2.15.13)

`POST /a/changes/<change-id>/revisions/<rev>/review` — body is a `ReviewInput` **[S]**:

```json
{
  "message": "Reviewed by superagent for Redmine #123",
  "labels": {
    "Code-Review": 1,
    "Verified": 1
  },
  "tag": "superagent",
  "reviewers": [
    {"reviewer": "jane.roe@example.com"},
    {"reviewer": "john.doe@example.com", "state": "CC"}
  ],
  "comments": {
    "src/main/java/Foo.java": [
      {"line": 23, "message": "[nit] trailing whitespace"},
      {"range": {"start_line": 50, "start_character": 0, "end_line": 55, "end_character": 20},
       "message": "Incorrect indentation"}
    ]
  },
  "notify": "ALL",
  "omit_duplicate_comments": true,
  "work_in_progress": false,
  "ready": false
}
```

| Field | 2.15 notes |
|---|---|
| `message` | the review comment; published as a change message |
| `labels` | map `label name → integer score` (e.g. `"Code-Review": 1`, `"Verified": -1`). Use the **exact label names of the project** (default Gerrit labels are `Code-Review` and `Verified`). |
| `tag` | free-form tag applied to the message/votes; the `autogenerated:<tag>` prefix is the convention for CI comments |
| `reviewers` | list of `ReviewerInput`: `{"reviewer": "<email or group>", "state": "REVIEWER"|"CC"}` |
| `comments` | inline comments keyed by file path |
| `notify` | `NONE` \| `OWNER` \| `OWNER_REVIEWERS` \| `ALL` (default `ALL`) |
| `drafts` | `DELETE` \| `PUBLISH` \| `PUBLISH_ALL_REVISIONS` \| `KEEP` — how to treat stored draft comments not mentioned in this input |
| `on_behalf_of` | account id the review is posted for (requires the `labelAs-*` capability) |
| `work_in_progress` / `ready` | flip the WIP state (mutually exclusive) |

**Response** (200) **[L]**:

```json
)]}'
{
  "labels": {
    "Code-Review": 1
  }
}
```

> ### ⚠ The `<rev>` must be the 40-char commit sha
> `POST /a/changes/1001/revisions/<sha>/review` — the `<rev>` path segment is the **current revision's commit sha** (from `current_revision` or the `revisions` map key), *not* the change number and *not* the patch-set number. Posting to a stale patch set’s sha is rejected. **[S]** **[L]**
> Posting a review with only `{"message": "..."}` (no labels) is accepted in 2.15 and returns `{}`-ish JSON. **[L]**

### B.2.6 POST authentication notes

* All mutating endpoints live under `/a/` and require the **HTTP password** of the account (Basic auth). **[S]**
* If you use the `access_token` form (`?access_token=<token>`), no Basic auth header is needed and no XSRF token is required. **[S]**
* Gerrit does **not** accept the SSH key for HTTP auth. The account must have an **HTTP password** set (Gerrit: account page → “HTTP Password”). **[S]**
* `POST` bodies must be `Content-Type: application/json`; unknown JSON fields are ignored by Gerrit (no error). **[S]**

## B.3 Gerrit 2.15.13 limitations that a modern implementer gets wrong

| Topic | Gerrit 2.15.13 reality | Modern Gerrit (3.x) | Consequence for the agent |
|---|---|---|---|
| Change messages | **no** `GET /changes/<id>/messages` endpoint (404). Messages come from `o=MESSAGES` in the change detail. | `/changes/<id>/messages` exists | never call `/messages` on 2.15 |
| Review labels vs tags | **no** `/labels/` endpoint at all (404). Review labels appear inside `ChangeInfo.labels`. `/projects/<p>/tags/` lists **git tag refs** (`refs/tags/*`), *not* review tags. | 3.0 introduced the Tags API (`/changes/<id>/tags`) | do not model “tags” as review labels on 2.15 |
| Query operator `updated:` | **not supported** (400 `Unsupported operator`). Use `after:`/`since:`. | still not a Gerrit operator | “updated since” = `after:` |
| Change URL in push output | new-UI form `http://host/#/c/<project>/+/<number>` | same since 2.14 | parse both forms anyway |
| Server version endpoint | `GET /a/config/server/version` | `GET /a/config/server-version` | use the 2.15 path |
| Push options | no `%(trailer:key=…)`; reviewers must be **e-mail** addresses | trailer option and username reviewers exist | add trailers via the hook |
| Branch locking | **no** REST lock/unlock endpoints in 2.15 | `POST /projects/<p>/lock` exists | lock state can only be read from push errors |
| Drafts | `GET/POST/DELETE /changes/<id>/drafts` exist; the review body’s `drafts` field accepts `DELETE`/`PUBLISH`/`PUBLISH_ALL_REVISIONS`/`KEEP` | same | use `KEEP` if the agent must not touch human drafts |
| WIP state | `work_in_progress` boolean on `ChangeInfo`; `is:wip` query operator | same | — |
| `o=` options | the 21 options listed in B.2.4 | a few more (`CURRENT_COMMIT` etc. unchanged) | — |
| Submit/abandon bodies | `submit` takes `{"on_behalf_of": id}`; `abandon` takes an optional message; both answer with `ChangeInfo` | `submit` body gained `submit_type` in 3.x | send `{}` (or nothing) for abandon |
| Comments pagination | **no** pagination parameters; the response contains all published comments of all patch sets | `/comments` still unpaginated, but file/dir queries exist | fine for small changes |
| `Change-Id` trailer | still mandatory; the `commit-msg` hook is unchanged in spirit | same | — |

## B.4 “The agent submits a patch” — exact recipe

> The agent will run `git` and `curl` as **shell commands** (not as libraries). The sequence below is copy-pasteable and was executed end-to-end against the live 2.15.13 container. **[L]**

### Step 0 — environment

```bash
export GERRIT_SSH_URL="ssh://agent@gerrit.example.com:29418"
export GERRIT_PROJECT="sdk"             # the issue's Redmine project identifier, which names the Gerrit repository
export GERRIT_BRANCH="master"          # 2.15's default branch is "master"; use the real target branch
export GERRIT_HTTP="http://gerrit.example.com:8080"
export GERRIT_USER="agent"
export GERRIT_HTTP_PASSWORD="..."       # the account's HTTP password
export REDMINE_URL="http://redmine.example.com"
export REDMINE_API_KEY="..."            # the key of the bound account, the operator's own
export REDMINE_ISSUE_ID="123"
export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
```

In the company the repository is not configured anywhere: it is the identifier of the Redmine project the issue belongs to, which equals the Gerrit project name, so `GERRIT_PROJECT` above is read from the issue rather than from the deployment.

### Step 1 — clone

```bash
git clone "$GERRIT_SSH_URL/$GERRIT_PROJECT" /workspace/$GERRIT_PROJECT
cd /workspace/$GERRIT_PROJECT
git config user.name  "Super Agent"
git config user.email "agent@example.com"     # MUST match the e-mail registered in Gerrit
```

### Step 2 — branch + install the Change-Id hook

```bash
git checkout -b feature/redmine-${REDMINE_ISSUE_ID}
curl -Lo .git/hooks/commit-msg "$GERRIT_HTTP/tools/hooks/commit-msg"
chmod u+x .git/hooks/commit-msg
```

### Step 3 — commit (the hook injects the Change-Id)

```bash
git add -A
git commit -m "Fix login flow

Implements the fix requested in Redmine issue #${REDMINE_ISSUE_ID}.

Issue: ${REDMINE_ISSUE_ID}
Redmine-Issue: #${REDMINE_ISSUE_ID}
Signed-off-by: Super Agent <agent@example.com>"

git log -1 --format='%H%n%B'     # verify the Change-Id trailer is present
```

Expected output (shape verified live) **[L]**:

```
dc615be59044ed112a32e47ee5e92cea2e82aff7
Clean nobody commit

Change-Id: I03a7476ec183e9f746e7c6dc3990131f6b2315fc
```

*No Change-Id?* install the hook and amend: `git commit --amend --no-edit` — the hook then injects the trailer. **[L]**

### Step 4 — push to `refs/for/<branch>` (with the Redmine topic)

```bash
TOPIC="redmine-${REDMINE_ISSUE_ID}"
git push origin "HEAD:refs/for/${GERRIT_BRANCH}%topic=${TOPIC}"
# equivalently:
git push origin "HEAD:refs/for/${GERRIT_BRANCH}" -o topic="${TOPIC}"
```

Observed successful push output (stderr) **[L]**:

```
remote: 
remote: Processing changes: new: 1 (|)         ...
remote: Processing changes: new: 1, done            
remote: 
remote: New Changes:        
remote:   http://gerrit.example.com:8080/#/c/demo/+/1001 Add greeting        
remote: 
To ssh://gerrit.example.com:29418/demo
 * [new reference]   HEAD -> refs/for/master
```

### Step 5 — resolve the change number (server-authoritative)

```bash
CHANGE_ID=$(git log -1 --format=%B | sed -n 's/^Change-Id: //p')
CHANGE_NUMBER=$(curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" \
  "$GERRIT_HTTP/a/changes/?q=project:${GERRIT_PROJECT}+change:${CHANGE_ID}" \
  | tail -c +6 \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[0]["_number"] if d else "")')
echo "change number = $CHANGE_NUMBER"
```

### Step 6 — verify the change

```bash
curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" \
  "$GERRIT_HTTP/a/changes/${CHANGE_NUMBER}/detail?o=CURRENT_REVISION&o=MESSAGES" \
  | tail -c +6 | python3 -m json.tool
```

### Step 7 — optional: post a review comment referencing the Redmine issue

```bash
REV=$(curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" \
  "$GERRIT_HTTP/a/changes/${CHANGE_NUMBER}/detail?o=CURRENT_REVISION" \
  | tail -c +6 | python3 -c 'import json,sys; print(json.load(sys.stdin)["current_revision"])')

curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d "{\"message\":\"Implemented for Redmine issue #${REDMINE_ISSUE_ID}; see topic ${TOPIC}.\",\"labels\":{\"Verified\":1}}" \
  "$GERRIT_HTTP/a/changes/${CHANGE_NUMBER}/revisions/${REV}/review" \
  | tail -c +6
```

Response: `{"labels": {"Verified": 1}}` (200). **[L]**

### Step 8 — report back to Redmine (with idempotency, see A.9)

```bash
BODY="Implemented in Gerrit change ${CHANGE_NUMBER}: ${GERRIT_HTTP}/#/c/${GERRIT_PROJECT}/+/${CHANGE_NUMBER}"
MARKER="<!-- superagent:v1:${RUN_ID}:$(printf '%s' "$BODY" | shasum -a 256 | cut -c1-16) -->"

# pre-flight
curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" \
  "$REDMINE_URL/issues/${REDMINE_ISSUE_ID}.json?include=journals" \
| python3 -c 'import json,sys; m=sys.argv[1]; d=json.load(sys.stdin)["issue"]; print("ALREADY" if any(m in (j.get("notes") or "") for j in (d.get("journals") or [])) else "NEW")' "$MARKER"

# post (only if NEW)
curl -sS -X PUT -H "X-Redmine-API-Key: $REDMINE_API_KEY" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"issue":{"notes":sys.argv[1]+"\n\n"+sys.argv[2]}}))' "$BODY" "$MARKER")" \
  "$REDMINE_URL/issues/${REDMINE_ISSUE_ID}.json"
```

## B.5 Linking Change-Id ↔ Redmine issue

### B.5.1 Gerrit’s own tracking-id mechanism (2.15)

Gerrit can index “tracked issue” ids found in the commit message. The `trackingid` sections live in `gerrit.config` **[S]**:

```
[trackingid "jira"]
  bug = JIRA
  issue = JIRA
```

(the section name is the *issue system name*; the keys are the trailer names Gerrit recognises). With such a section configured, Gerrit exposes the ids in `ChangeInfo.tracking_ids` (when `o=TRACKING_IDS` is requested) and the `tr:`/`bug:` query operators can find them. **[S]**

> Redmine is **not** one of Gerrit’s built-in issue systems (JIRA, Bugzilla, TRAC, Gitiles…). A Redmine id can only be picked up by configuring a `trackingid` section whose pattern matches, e.g. **[VERIFY]**:
> ```
> [trackingid "redmine"]
>   issue = redmine
> ```
> The exact regex semantics of the `trackingid` section differ between Gerrit versions — confirm on the target instance before relying on `tr:` queries. The *reliable* correlation in 2.15 is the **topic** and the **commit message body** (B.5.2).

### B.5.2 The practical correlation (recommended)

The implementation tracks a change by the task it names, in whatever repository it lives: the `Issue:` trailer of the commit message (`Bug:` and `Feature:` are accepted too, with or without a `#`) carries the Redmine issue id. A change without such a trailer is not a task's change, and a review comment on a change that has one binds to that issue.

| Where | How | Why |
|---|---|---|
| **Standard trailer (required)** | `Issue: 123` / `Bug: 123` / `Feature: 123` | the correlation the Gerrit Source reads: on each poll it lists the open changes, keeps those whose commit message names an issue, and binds them to the issue's Ticket, across every repository. Gerrit's own hook places `Change-Id` *after* these (`CHANGE_ID_AFTER="Bug\|Depends-On\|Issue\|Test\|Feature\|Fixes\|Fixed"`) **[S]** |
| **Change topic (compatibility)** | `git push … HEAD:refs/for/<branch>%topic=agent/<ticket name>` | the old correlation, kept for installations that relied on it; also visible in the UI and in `ChangeInfo.topic` **[L]** |
| **Commit message body** | `Redmine-Issue: #123` (free text, in the body) | humans and grep see it; Gerrit’s `message:` query finds it **[S]** |

**Canonical commit message for a ticket-driven change:**

```
Fix login flow for corporate SSO

Redmine-Issue: #123
Issue: 123
Signed-off-by: Super Agent <agent@example.com>
Change-Id: I03a7476ec183e9f746e7c6dc3990131f6b2315fc
```

**Finding the changes of a Redmine ticket:** Gerrit 2.15 has no query for a trailer unless a `trackingid` section is configured (B.5.1), so the implementation lists the open changes and reads their commit messages:

```bash
# every open change, in every repository; keep those whose message carries "Issue: <id>"
curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" \
  "$GERRIT_HTTP/a/changes/?q=status:open&o=CURRENT_REVISION&o=CURRENT_COMMIT" | tail -c +6

# by topic, the compatibility correlation (exact)
curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" \
  "$GERRIT_HTTP/a/changes/?q=project:${GERRIT_PROJECT}+topic:agent/${TICKET_NAME}" | tail -c +6
```

**Storing the link back in Redmine:** put the Gerrit change URL into the issue with an idempotent note (A.9) and/or into a dedicated custom field (“Gerrit Change” = `1001`), so the ticket shows the review state.

---

# Appendix A — End-to-end superagent flow

```
 1. poll   GET  {redmine}/issues.json?status_id=*&updated_on=>={cursor}&sort=updated_on:asc
 2. filter for the bound account: assigned_to.id == BOUND_USER_ID  OR  @login mentioned in description/notes
 3. work   clone {gerrit ssh url}/{issue's Redmine project identifier} — the issue's project names the repository
 4. commit commit-msg hook ⇒ Change-Id; the commit message carries the Issue: trailer with the Redmine issue id
 5. push   git push origin HEAD:refs/for/{branch}%topic=agent/{ticket name}
 6. find   GET  {gerrit}/a/changes/?q=status:open  → keep the change whose commit message names the issue
 7. bind   the change becomes the ticket's change (own when the agent account owns it)
 8. read   review comments on the change and change messages become triggers carrying the change thread and the issue thread
 9. reply  PUT  {redmine}/issues/{id}.json  {"issue":{"notes":"...\n\n<!-- dsh-superagent:<message id> -->"}}
10. end    a merged or abandoned change ends the ticket; the outcome is written back as a note on the issue
```

A reply the operator posts from the panel takes the same path with the panel marker (A.9.5) and enters as a human Trigger, so the agent receives it at once; the polling Source skips the note because of its marker.

**Configuration surface the implementation will need**

| Env var | Meaning | Example |
|---|---|---|
| `REDMINE_URL` | Redmine base URL | `http://redmine.corp.internal` |
| `REDMINE_API_KEY` | 40-hex API key of the bound account | `c5d6…` |
| `REDMINE_USER_ID` | numeric user id of the bound account, for the assignment filter | `5` |
| `REDMINE_LOGIN` | login of the bound account, used for `@mention` detection | `dev` |
| `GERRIT_HTTP` | Gerrit HTTP base | `http://gerrit.corp.internal:8080` |
| `GERRIT_USER` / `GERRIT_HTTP_PASSWORD` | HTTP Basic credentials for `/a/` | `agent` / `…` |
| `GERRIT_SSH_URL` | SSH base URL | `ssh://agent@gerrit.corp.internal:29418` |
| `GERRIT_PROJECT` / `GERRIT_BRANCH` | the issue's Redmine project identifier (or an optional override), and the target branch | `sdk` / `main` |
| `GERRIT_SSH_KEY_PATH` | private key | `/run/secrets/gerrit_ssh_key` |

---

# Appendix B — Copy-paste helpers

## Helper 1 — Redmine client (bash)

```bash
#!/usr/bin/env bash
# rm-api.sh — thin Redmine 4.2 REST client
REDMINE_URL="${REDMINE_URL:-http://127.0.0.1:3001}"
REDMINE_API_KEY="${REDMINE_API_KEY:?set REDMINE_API_KEY}"

rm_get()  { curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" "$REDMINE_URL$1"; }
rm_post() { curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" -H 'Content-Type: application/json' -X POST -d "$2" "$REDMINE_URL$1"; }
rm_put()  { curl -sS -H "X-Redmine-API-Key: $REDMINE_API_KEY" -H 'Content-Type: application/json' -X PUT  -d "$2" "$REDMINE_URL$1"; }

rm_get "/issues.json?project_id=demo&status_id=*&updated_on=%3E=2026-01-01&sort=updated_on:asc&limit=100"
rm_get "/issues/123.json?include=journals"
rm_put "/issues/123.json" '{"issue":{"notes":"hello"}}'
```

## Helper 2 — Gerrit client (bash) — note the 5-byte prefix strip

```bash
#!/usr/bin/env bash
# gr-api.sh — thin Gerrit 2.15 REST client
GERRIT_HTTP="${GERRIT_HTTP:-http://127.0.0.1:8081}"
GERRIT_USER="${GERRIT_USER:-agent}"
GERRIT_HTTP_PASSWORD="${GERRIT_HTTP_PASSWORD:?set GERRIT_HTTP_PASSWORD}"

gr_get()  { curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" "$GERRIT_HTTP/a$1" | tail -c +6; }
gr_post() { curl -sS -u "$GERRIT_USER:$GERRIT_HTTP_PASSWORD" -H 'Content-Type: application/json' -X POST -d "${2:-{\}}" "$GERRIT_HTTP/a$1" | tail -c +6; }

gr_get "/changes/?q=project:demo+status:open"
gr_get "/changes/1001/detail?o=CURRENT_REVISION"
gr_post "/changes/1001/revisions/$(gr_get '/changes/1001/detail?o=CURRENT_REVISION' | python3 -c 'import json,sys;print(json.load(sys.stdin)["current_revision"])')/review" '{"message":"hello"}'
```

> `tail -c +6` strips `)]}'` **plus the newline** (5 bytes). If the server is behind a proxy that rewrites the body, prefer a JSON-aware stripper:
> ```python
> body = resp.read().decode()
> if body.startswith(")]}'"):
>     body = body[4:].lstrip("\n")
> ```

---

# Appendix C — Open items to verify against the corporate stack

| # | Item | Why it matters | How to verify |
|---|---|---|---|
| C1 | Gerrit **HTTP password** for the agent account exists and is known to the agent runtime | `/a/` endpoints need it | `curl -u agent:<pw> http://host:8080/a/accounts/self` → 200 with `)]}'` prefix |
| C2 | Exact Gerrit push-permission rejection message in 2.15.13 | error-mapping table (B.1.7) | create a project with an explicit access list, push with a user lacking “Push” |
| C3 | Exact “ref is locked” push message in 2.15.13 | error-mapping table | lock `refs/heads/<branch>` in the admin UI, then push to `refs/for/<branch>` |
| C4 | `%(trailer:key=…)` push option — first release that supports it | avoid shipping an unsupported option | grep `Documentation/user-upload.txt` of the target tag |
| C5 | Redmine `trackingid` section semantics for Redmine ids in 2.15 | `tr:` query operator | configure `[trackingid "redmine"]`, then `GET /a/changes/?q=tr:123` |
| C6 | Redmine `User::STATUS_*` numeric values on the target instance | `GET /users.json?status=N` | `curl -sS "…/users.json?status=1"` vs `status=2` |
| C7 | Reverse proxy rate limiting in front of Redmine | polling loop pacing | inspect nginx/haproxy config; measure with a burst |
| C8 | Puma/Rack keep-alive and timeout behaviour of the Redmine container | long-polling clients | observe `Connection: close` behaviour after idle periods |
| C9 | Whether the corporate Gerrit allows `agent` to push to `refs/for/*` without “Submit” | review flow | push once, check `GET /a/changes/<n>/detail` → `status` |
| C10 | Whether the corporate Redmine exposes `include=journals` for the agent’s role (private notes visibility) | reply verification | `GET /issues/<id>.json?include=journals` as the agent user |
| C11 | Gerrit write latency under the corporate network | client timeouts | measure `POST …/review` round-trip; set the HTTP client timeout ≥ 30 s |
| C12 | Whether `settings["id"]` names in Redmine are `created_on`/`updated_on` (yes in 4.2) vs the corporate fork | cursor logic | assert on a live response |

---

# Appendix D — Reference links

**Redmine**
* REST API (official, live): <https://www.redmine.org/projects/redmine/wiki/Rest_api>
* 4.2 source (authoritative for behaviour): <https://github.com/redmine/redmine/tree/4.2-stable>
  * `app/controllers/application_controller.rb` (auth, pagination)
  * `app/controllers/issues_controller.rb` (create/update/conflict)
  * `app/controllers/attachments_controller.rb` (upload)
  * `app/controllers/users_controller.rb` (user filters)
  * `app/views/issues/show.api.rsb`, `app/views/issues/index.api.rsb` (response shapes)
  * `lib/plugins/acts_as_attachable/lib/acts_as_attachable.rb` (`uploads` tokens)
  * `app/models/token.rb`, `app/models/user.rb` (API keys, `must_change_passwd`)
* Historical version-pinned doc (currently 404, may exist on the corporate mirror): `https://www.redmine.org/docs/4.2/api/`

**Gerrit 2.15.13**
* REST API (changes): <https://raw.githubusercontent.com/GerritCodeReview/gerrit/v2.15.13/Documentation/rest-api-changes.txt>
* REST API (projects): <https://raw.githubusercontent.com/GerritCodeReview/gerrit/v2.15.13/Documentation/rest-api-projects.txt>
* REST API (accounts): <https://raw.githubusercontent.com/GerritCodeReview/gerrit/v2.15.13/Documentation/rest-api-accounts.txt>
* REST API (overview, auth, magic prefix): <https://raw.githubusercontent.com/GerritCodeReview/gerrit/v2.15.13/Documentation/rest-api.txt>
* Search operators: <https://raw.githubusercontent.com/GerritCodeReview/gerrit/v2.15.13/Documentation/user-search.txt>
* Push options / SSH: <https://raw.githubusercontent.com/GerritCodeReview/gerrit/v2.15.13/Documentation/user-upload.txt>
* Change-Id: <https://raw.githubusercontent.com/GerritCodeReview/gerrit/v2.15.13/Documentation/user-changeid.txt>
* commit-msg hook: <https://raw.githubusercontent.com/GerritCodeReview/gerrit/v2.15.13/Documentation/cmd-hook-commit-msg.txt>
* Live hook download endpoint: `http://<host>:8080/tools/hooks/commit-msg`
* Current docs root (version-pinned pages): <https://gerrit-review.googlesource.com/Documentation/>

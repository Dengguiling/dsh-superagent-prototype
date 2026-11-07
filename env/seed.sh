#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Seed the dsh-superagent corporate development environment.  Idempotent:
# running it again does not duplicate accounts, projects, issues, repositories
# or commits.
#
#   Redmine : projects `sdk` and `sdk-cli` (their identifiers are the names of
#             the Gerrit repositories), `dev` as Developer and the project
#             manager (admin) as Manager; the defect issues of the scenario,
#             authored by the PM and assigned to `dev`; one issue assigned to
#             the PM as the negative case of the workbench; the old `demo`
#             project (kept for compatibility, its issues are closed)
#   Gerrit  : projects `sdk` and `sdk-cli` with the initial commits of the demo
#             SDK and its CLI (pushed over SSH with the agent key), branch
#             `main` set as HEAD; the old `demo` project is kept
# ---------------------------------------------------------------------------
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/common.sh"

echo "=============================================================="
echo " dsh-superagent corporate environment seeding"
echo "=============================================================="

# ===========================================================================
# Redmine
# ===========================================================================
echo
echo "--- the accounts of the company ---"
"${ENV_DIR}/accounts.sh" || exit 1
echo

echo "--- Redmine ---"

# --- lookup helpers --------------------------------------------------------
redmine_id_of() { # <json-endpoint> <field> <name>
  python3 -c '
import json,sys
data = json.load(sys.stdin)
if isinstance(data, dict):
    for value in data.values():
        if isinstance(value, list):
            data = value
            break
field, name = sys.argv[1], sys.argv[2]
for item in data:
    if isinstance(item, dict) and str(item.get(field, "")).lower() == name.lower():
        print(item["id"]); break
' "$2" "$3" < <(redmine_api GET "$1")
}

TRACKER_BUG=$(redmine_id_of "/trackers.json" name Bug)
TRACKER_FEATURE=$(redmine_id_of "/trackers.json" name Feature)
PRIO_NORMAL=$(redmine_id_of "/enumerations/issue_priorities.json" name Normal)
PRIO_LOW=$(redmine_id_of "/enumerations/issue_priorities.json" name Low)
PRIO_HIGH=$(redmine_id_of "/enumerations/issue_priorities.json" name High)
STATUS_CLOSED=$(redmine_id_of "/issue_statuses.json" name Closed)
ROLE_MANAGER=$(redmine_id_of "/roles.json" name Manager)
ROLE_DEVELOPER=$(redmine_id_of "/roles.json" name Developer)

DEV_ID=$(redmine_user_id "${REDMINE_DEV_LOGIN}")
LEAD_ID=$(redmine_user_id "${REDMINE_LEAD_LOGIN}")
if [ -z "$DEV_ID" ] || [ -z "$LEAD_ID" ]; then
  echo "the Redmine accounts are missing (dev='${REDMINE_DEV_LOGIN}' lead='${REDMINE_LEAD_LOGIN}')." >&2
  echo "run 'docker compose up -d' first: the redmine-init job creates/renames them." >&2
  exit 1
fi
info "dev ${REDMINE_DEV_LOGIN} id=${DEV_ID}, the leader ${REDMINE_LEAD_LOGIN} id=${LEAD_ID}"

# all trackers of the installation: a project created through the API has none
# until they are enabled, and without a tracker no issue can be created
ALL_TRACKER_IDS=$(redmine_api GET "/trackers.json" | python3 -c '
import json,sys
print(json.dumps([t["id"] for t in json.load(sys.stdin).get("trackers", [])]))
')

# --- projects --------------------------------------------------------------
ensure_project() { # <identifier> <name> <description>
  local identifier="$1" name="$2" description="$3" code
  if redmine_api GET "/projects/${identifier}.json" | grep -q '"identifier"'; then
    info "redmine project ${identifier} already exists"
  else
    code=$(redmine_api_code POST "/projects.json" "$(
      python3 -c '
import json,sys
print(json.dumps({"project": {
    "name": sys.argv[1],
    "identifier": sys.argv[2],
    "description": sys.argv[3],
    "is_public": True,
    "inherit_members": False,
}}))' "$name" "$identifier" "$description")")
    case "$code" in
      201|200) info "redmine project ${identifier} created" ;;
      *) echo "could not create the Redmine project ${identifier} (http $code)" >&2; exit 1 ;;
    esac
  fi
  code=$(redmine_api_code PUT "/projects/${identifier}.json" \
    "$(python3 -c 'import json,sys; print(json.dumps({"project":{"tracker_ids":json.loads(sys.argv[1])}}))' "$ALL_TRACKER_IDS")")
  case "$code" in
    204|200) info "trackers of ${identifier} enabled" ;;
    *) echo "could not enable the trackers of ${identifier} (http $code)" >&2; exit 1 ;;
  esac
}

ensure_membership() { # <project> <user-id> <role-id> <label>
  local project="$1" user_id="$2" role_id="$3" label="$4" present code
  present=$(redmine_api GET "/projects/${project}/memberships.json?limit=100" | python3 -c '
import json,sys
user_id = int(sys.argv[1])
for membership in json.load(sys.stdin).get("memberships", []):
    if membership.get("user", {}).get("id") == user_id:
        print("yes"); break
' "$user_id")
  if [ -n "$present" ]; then
    info "${label} is already a member of ${project}"
    return 0
  fi
  code=$(redmine_api_code POST "/projects/${project}/memberships.json" \
    "{\"membership\":{\"user_id\":${user_id},\"role_ids\":[${role_id}]}}")
  case "$code" in
    201|200) info "${label} added to ${project} (role ${role_id})" ;;
    409) info "${label} already is a member of ${project}" ;;
    *) echo "could not add ${label} to ${project} (http $code)" >&2; exit 1 ;;
  esac
}

ensure_project "${REDMINE_PROJECT_ID}" "${REDMINE_PROJECT_NAME}" \
  "Old single-project demo, kept for compatibility. Its issues are closed so that the workbench only lists the SDK scenario."
ensure_project "${REDMINE_SDK_PROJECT}" "${REDMINE_SDK_PROJECT_NAME}" \
  "Python SDK of the Demo platform API. The identifier names the Gerrit repository, so the agent clones it for an issue of this project."
ensure_project "${REDMINE_SDK_CLI_PROJECT}" "${REDMINE_SDK_CLI_PROJECT_NAME}" \
  "Command line front end of the Demo platform API. The identifier names the Gerrit repository."

ensure_membership "${REDMINE_PROJECT_ID}" "$DEV_ID" "$ROLE_DEVELOPER" "dev"
ensure_membership "${REDMINE_SDK_PROJECT}" "$DEV_ID" "$ROLE_DEVELOPER" "dev"
ensure_membership "${REDMINE_SDK_PROJECT}" "$LEAD_ID" "$ROLE_MANAGER" "the leader"
ensure_membership "${REDMINE_SDK_CLI_PROJECT}" "$DEV_ID" "$ROLE_DEVELOPER" "dev"
ensure_membership "${REDMINE_SDK_CLI_PROJECT}" "$LEAD_ID" "$ROLE_MANAGER" "the leader"

# --- issues ----------------------------------------------------------------
seed_issue() { # <project> <subject> <tracker> <priority> <assignee> <description>
  local project="$1" subject="$2" tracker="$3" priority="$4" assignee="$5" description="$6"
  local existing body code new_id
  existing=$(redmine_issue_id "$project" "$subject")
  if [ -n "$existing" ]; then
    info "issue already present: #${existing} ${subject}"
    # the assignee is kept in shape: the leader assigns the work to the
    # developer, the negative case stays with the leader
    redmine_api_code_as "$REDMINE_LEAD_API_KEY" PUT "/issues/${existing}.json" \
      "{\"issue\":{\"assigned_to_id\":${assignee}}}" >/dev/null
    return 0
  fi
  body=$(python3 -c '
import json,sys
print(json.dumps({"issue": {
    "project_id": sys.argv[1],
    "subject": sys.argv[2],
    "description": sys.argv[3],
    "tracker_id": int(sys.argv[4]),
    "priority_id": int(sys.argv[5]),
    "assigned_to_id": int(sys.argv[6]),
}}))' "$project" "$subject" "$description" "$tracker" "$priority" "$assignee")
  # The leader authors the issue and hands it to the developer.
  code=$(redmine_api_code_as "$REDMINE_LEAD_API_KEY" POST "/issues.json" "$body")
  case "$code" in
    201|200) ;;
    *) echo "could not create issue '${subject}' (http $code)" >&2; exit 1 ;;
  esac
  # the id is assigned by Redmine, so it is read back instead of guessed
  new_id=$(redmine_issue_id "$project" "$subject")
  info "created issue #${new_id}: ${subject} (${project}, assigned to user ${assignee})"
}

# --- the defects of the scenario -------------------------------------------
# Every issue is authored by the PM (the admin API key posts it) and assigned to
# `dev`; the descriptions name the symptoms, the reproduction, the expected and
# the actual behaviour and the file the defect lives in.

seed_issue "${REDMINE_SDK_PROJECT}" \
  "Paginator drops the last page of a collection whose size is not a multiple of the page size" \
  "${TRACKER_BUG}" "${PRIO_HIGH}" "${DEV_ID}" \
  "$(cat <<'EOF'
h3. Symptoms

Iterating a collection with @Client.paginate()@ silently stops after the full pages; the last, partial page is never requested.  For a collection of 250 items with a page size of 100 only 200 items come back and no error is raised.

h3. Steps to reproduce

# @from demo_sdk import Client@ (with a client whose @paginate()@ talks to the projects endpoint)
# @items = list(client.paginate("/projects", page_size=100))@
# request @GET /projects?page=1&per_page=100@ manually and compare the @total@ field with @len(items)@

h3. Expected

Every page is requested: 250 items come back as 100 + 100 + 50.

h3. Actual

Only two pages are requested and 200 items come back; the last 50 items are dropped without a warning.

h3. Pointers

The page count is computed in @demo_sdk/pagination.py@ (@Paginator._fetch_page@).  The API returns the number of items in the @total@ field of every page.  @tests/test_known_bugs.py::test_paginator_returns_the_partial_last_page@ reproduces it.
EOF
)"

seed_issue "${REDMINE_SDK_PROJECT}" \
  "RetryPolicy retries 400/404 answers and slows down every failing request" \
  "${TRACKER_BUG}" "${PRIO_NORMAL}" "${DEV_ID}" \
  "$(cat <<'EOF'
h3. Symptoms

A request that ends in a client error (400, 404, ...) is sent three times with exponential backoff before the error surfaces.  The API is called twice more for a request that can never succeed.

h3. Steps to reproduce

# point the SDK at a path that answers 404, e.g. @GET /projects/does-not-exist@
# a 404 takes about 1.5 seconds to raise instead of failing immediately
# @RetryPolicy.should_retry(0, response=...)@ returns True for a response with status 400 and 404

h3. Expected

Only transient answers are retried: 408, 429, the 5xx family and transport errors.  A 400/404 answer raises @ApiError@ immediately.

h3. Actual

@RETRYABLE_STATUS@ in @demo_sdk/retry.py@ contains 400 and 404, so client errors are retried as well.

h3. Pointers

@demo_sdk/retry.py@, @RETRYABLE_STATUS@ and @RetryPolicy.should_retry@.  @tests/test_known_bugs.py::test_client_errors_are_not_retried@ reproduces it.
EOF
)"

seed_issue "${REDMINE_SDK_PROJECT}" \
  "Access token is not refreshed before it expires: requests fail with 401 near the expiry time" \
  "${TRACKER_BUG}" "${PRIO_HIGH}" "${DEV_ID}" \
  "$(cat <<'EOF'
h3. Symptoms

An access token that expires in less than a minute is still sent with new requests.  If the token expires while a request is in flight, the caller sees a 401 even though a refresh was possible.

h3. Steps to reproduce

# create a @TokenStore@ whose @fetch_token@ returns a token with @expires_in=300@
# advance the clock by 270 seconds (@EXPIRY_SKEW_SECONDS@ is 60)
# @TokenStore.get_token()@ returns the old token instead of fetching a new one

h3. Expected

A token with fewer than @EXPIRY_SKEW_SECONDS@ seconds of validity left is refreshed before it is used.

h3. Actual

The token is cached until its exact expiry; the skew constant is ignored.

h3. Pointers

@demo_sdk/auth.py@, @TokenStore._is_expired@.  @tests/test_known_bugs.py::test_token_is_refreshed_before_it_expires@ reproduces it.
EOF
)"

seed_issue "${REDMINE_SDK_CLI_PROJECT}" \
  "--timeout is accepted but ignored: requests still use the 30 second default" \
  "${TRACKER_BUG}" "${PRIO_NORMAL}" "${DEV_ID}" \
  "$(cat <<'EOF'
h3. Symptoms

Passing @--timeout 5@ to @sdk-cli@ does not change the request timeout.  A slow or hanging API endpoint blocks the CLI for the default of 30 seconds.

h3. Steps to reproduce

# @python3 -m sdk_cli --timeout 5 get /projects@
# point @--base-url@ at a server that accepts the connection and never answers: the CLI waits about 30 seconds

h3. Expected

@--timeout@ bounds a single HTTP request; a value of 5 aborts the call after about 5 seconds.

h3. Actual

@build_client@ in @sdk_cli/main.py@ passes the base URL and the token to @ApiClient@ but not the parsed timeout, so @ApiClient.timeout@ keeps its default.

h3. Pointers

@sdk_cli/main.py@ (@build_client@), @sdk_cli/api.py@ (@ApiClient.timeout@).  @tests/test_known_bugs.py::test_timeout_is_forwarded_to_the_api_client@ reproduces it.
EOF
)"

# --- the negative case: an issue that is NOT assigned to the bound account --
seed_issue "${REDMINE_SDK_PROJECT}" \
  "Document the 1.0 migration guide of the demo SDK" \
  "${TRACKER_FEATURE}" "${PRIO_LOW}" "${LEAD_ID}" \
  "$(cat <<'EOF'
h3. Goal

Write the 1.0 migration guide of the Demo SDK: the renamed modules, the new retry policy defaults and the token refresh behaviour.

h3. Notes

Documentation only; the code of the release is frozen.  The guide is published with the release notes.
EOF
)"

# --- the old demo project: closed so that the workbench is clean ------------
close_issues() { # <project>
  local project="$1" ids id subject code
  ids=$(redmine_api GET "/issues.json?project_id=${project}&status_id=open&limit=100" | python3 -c '
import json,sys
for issue in json.load(sys.stdin).get("issues", []):
    print("%s\t%s" % (issue["id"], issue["subject"]))
')
  if [ -z "$ids" ]; then
    info "no open issues left in ${project}"
    return 0
  fi
  while IFS=$'\t' read -r id subject; do
    [ -z "$id" ] && continue
    code=$(redmine_api_code PUT "/issues/${id}.json" \
      "$(python3 -c 'import json,sys; print(json.dumps({"issue":{"status_id":int(sys.argv[1])}}))' "$STATUS_CLOSED")")
    case "$code" in
      204|200) info "closed old issue #${id}: ${subject} (${project})" ;;
      *) echo "could not close issue #${id} (http $code)" >&2; exit 1 ;;
    esac
  done <<< "$ids"
}
close_issues "${REDMINE_PROJECT_ID}"

# ===========================================================================
# Gerrit
# ===========================================================================
echo
echo "--- Gerrit ---"

# --- the agent must be able to push to the branches of the projects --------
ensure_agent_administrator() {
  local code
  code=$(gerrit_api_code PUT "/a/groups/1/members/${GERRIT_DEV_LOGIN}")
  case "$code" in
    200|201|204) info "the developer is a member of the Administrators group" ;;
    409) info "the developer already is a member of the Administrators group" ;;
    *) echo "could not add the agent to the Administrators group (http $code)" >&2; exit 1 ;;
  esac
}

ensure_gerrit_project() { # <project> <description>
  local project="$1" description="$2" code
  code=$(gerrit_api_code PUT "/a/projects/${project}" "$(
    python3 -c '
import json,sys
print(json.dumps({"description": sys.argv[1], "submit_type": "MERGE_IF_NECESSARY", "owners": ["Administrators"]}))' \
    "$description")")
  case "$code" in
    200|201) info "gerrit project ${project} created" ;;
    409) info "gerrit project ${project} already exists" ;;
    *) echo "could not create the gerrit project ${project} (http $code)" >&2; exit 1 ;;
  esac
}

seed_gerrit_repo() { # <project> <source-dir> <commit-subject> <commit-body>
  local project="$1" source="$2" subject="$3" body="$4"
  local url work code
  url="$(gerrit_project_url "$project")"
  if git ls-remote --exit-code "$url" "refs/heads/${GERRIT_BRANCH}" >/dev/null 2>&1; then
    info "branch ${GERRIT_BRANCH} of ${project} already exists"
  else
    work=$(mktemp -d)
    if ! git clone -q "$url" "${work}/${project}" 2>/dev/null; then
      echo "could not clone the empty gerrit project ${project} (${url})" >&2
      exit 1
    fi
    (
      cd "${work}/${project}"
      git checkout -q -B "${GERRIT_BRANCH}"
      git config user.email "${GERRIT_DEV_EMAIL}"
      git config user.name "Super Agent"
      install_commit_msg_hook "$(git rev-parse --git-dir)"
      cp -R "${source}/." .
      git add -A
      git commit -q -m "${subject}" -m "${body}"
      git push -q origin "HEAD:refs/heads/${GERRIT_BRANCH}"
    )
    rm -rf "$work"
    info "initial commit of ${project} pushed to refs/heads/${GERRIT_BRANCH}"
  fi
  code=$(gerrit_api_code PUT "/a/projects/${project}/HEAD" "{\"ref\":\"refs/heads/${GERRIT_BRANCH}\"}")
  case "$code" in
    200|201) info "HEAD of ${project} points at refs/heads/${GERRIT_BRANCH}" ;;
    409) info "HEAD of ${project} already points at refs/heads/${GERRIT_BRANCH}" ;;
    *) echo "could not set the HEAD of ${project} (http $code)" >&2; exit 1 ;;
  esac
}

ensure_agent_administrator

# the old single-project demo, kept for compatibility
ensure_gerrit_project "${GERRIT_PROJECT}" \
  "Old single-project demo of the dsh-superagent mock environment, kept for compatibility."
seed_gerrit_repo "${GERRIT_PROJECT}" "${ENV_DIR}/repos/demo" \
  "Initial commit of the demo project" \
  "Adds the README and a trivial sample module so that the agent has something to patch."

# the corporate scenario: the project name is the identifier of the Redmine project
ensure_gerrit_project "${REDMINE_SDK_PROJECT}" \
  "Python SDK of the Demo platform API (demo_sdk): client, pagination, retry and auth with a pytest suite."
seed_gerrit_repo "${REDMINE_SDK_PROJECT}" "${ENV_DIR}/repos/sdk" \
  "Initial import of the demo SDK" \
  "Python client of the Demo platform API with the client, pagination, retry and auth modules and their pytest suite.  The defects of the open issues of the Redmine project sdk are seeded in this snapshot."

ensure_gerrit_project "${REDMINE_SDK_CLI_PROJECT}" \
  "Command line front end of the Demo platform API (sdk_cli) with a pytest suite."
seed_gerrit_repo "${REDMINE_SDK_CLI_PROJECT}" "${ENV_DIR}/repos/sdk-cli" \
  "Initial import of the demo SDK CLI" \
  "Command line front end of the Demo platform API with its pytest suite.  The defect of the open issue of the Redmine project sdk-cli is seeded in this snapshot."

# ===========================================================================
# Summary
# ===========================================================================
echo
echo "seeding finished."
echo
echo "  Redmine projects"
echo "    ${REDMINE_URL}/projects/${REDMINE_PROJECT_ID}   (old demo, issues closed)"
echo "    ${REDMINE_URL}/projects/${REDMINE_SDK_PROJECT}"
echo "    ${REDMINE_URL}/projects/${REDMINE_SDK_CLI_PROJECT}"
echo
echo "  Open tasks assigned to ${REDMINE_DEV_LOGIN} (the workbench list):"
redmine_api_as "${REDMINE_DEV_API_KEY}" GET "/issues.json?assigned_to_id=me&status_id=open&limit=100&include=project" \
| python3 -c '
import json,sys
issues = json.load(sys.stdin).get("issues", [])
if not issues:
    print("    (none)")
for issue in issues:
    print("    #%-4s %-10s %s" % (issue["id"], issue.get("project", {}).get("name", "?"), issue["subject"]))
'
echo
echo "  Gerrit repositories"
echo "    ${GERRIT_URL}/q/project:${GERRIT_PROJECT}"
echo "    ${GERRIT_URL}/q/project:${REDMINE_SDK_PROJECT}"
echo "    ${GERRIT_URL}/q/project:${REDMINE_SDK_CLI_PROJECT}"
echo
echo "  push a patch: git push $(gerrit_project_url "${REDMINE_SDK_PROJECT}") HEAD:refs/for/${GERRIT_BRANCH}"

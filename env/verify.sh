#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Verify the dsh-superagent corporate development environment.  Prints one
# PASS/FAIL line per check and exits non-zero as soon as one check failed.
#
#   Redmine : the admin API key answers; the administrator is the PM and the
#             developer account is `dev` (renamed from `agent`, same API key,
#             no separate superagent account); the projects `sdk` and
#             `sdk-cli` exist with `dev` as Developer; the seeded issues are
#             assigned to `dev`, the negative issue to the PM; the dev API key
#             lists exactly the workbench issues with `assigned_to_id=me`,
#             posts a note and uses the `updated_on` filter; the old demo
#             issues are closed
#   Gerrit  : the projects `sdk` and `sdk-cli` are listed; the agent can clone
#             them over SSH and push a change to `refs/for/main` that names a
#             Redmine issue in an `Issue: #<id>` trailer; the trailer survives
#             on the review server, the change belongs to the agent account
#             and is abandoned again so that the review queue stays clean
# ---------------------------------------------------------------------------
set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/common.sh"

# verify.sh collects every failure instead of stopping at the first one,
# the exit code at the end tells whether something went wrong
set +e

# the script has to run to the end, otherwise it fails
WORKDIR=""
COMPLETED=0
cleanup() {
  local rc=$?
  [ -n "$WORKDIR" ] && rm -rf "$WORKDIR" 2>/dev/null
  if [ "$COMPLETED" != "1" ]; then
    printf '\033[0;31mFAIL\033[0m  verify.sh did not run to the end\n'
    rc=1
  fi
  exit $rc
}
trap cleanup EXIT

echo "=============================================================="
echo " dsh-superagent corporate environment verification"
echo "=============================================================="
echo

# ===========================================================================
# 0. the services are up
# ===========================================================================
info "waiting for the services to answer ..."

if wait_for 120 "redmine" curl -fsS -o /dev/null "${REDMINE_URL}/"; then
  pass "redmine is reachable on ${REDMINE_URL}"
else
  fail "redmine is not reachable on ${REDMINE_URL}"
fi

if wait_for 300 "gerrit" curl -fsS -u "${GERRIT_ADMIN_LOGIN}:${GERRIT_ADMIN_PASSWORD}" \
     -o /dev/null "${GERRIT_URL}/a/config/server/version"; then
  pass "gerrit is reachable on ${GERRIT_URL} (basic auth)"
else
  fail "gerrit is not reachable on ${GERRIT_URL}"
fi

# ===========================================================================
# helpers
# ===========================================================================
json_field() { # <file-or-stdin-expression> ... kept as python snippets at the call sites
  cat
}

check_membership() { # <project> <user-id> <role-name> <label>
  local project="$1" user_id="$2" role_name="$3" label="$4"
  local found
  found=$(redmine_api GET "/projects/${project}/memberships.json?limit=100" | python3 -c '
import json,sys
user_id, role_name = int(sys.argv[1]), sys.argv[2].lower()
for membership in json.load(sys.stdin).get("memberships", []):
    if membership.get("user", {}).get("id") != user_id:
        continue
    for role in membership.get("roles", []):
        if role.get("name", "").lower() == role_name:
            print("yes"); raise SystemExit(0)
' "$user_id" "$role_name")
  if [ -n "$found" ]; then
    pass "${label} has the ${role_name} role in ${project}"
  else
    fail "${label} has no ${role_name} role in ${project}"
  fi
}

check_issue() { # <project> <subject> <expected-assignee-id> <label>
  local project="$1" subject="$2" expected="$3" label="$4"
  local issue
  issue=$(redmine_issue_id "$project" "$subject")
  if [ -z "$issue" ]; then
    fail "issue '${subject}' is missing in ${project}"
    return 0
  fi
  redmine_api GET "/issues/${issue}.json" | python3 -c '
import json,sys
issue = json.load(sys.stdin).get("issue", {})
assignee = issue.get("assigned_to") or {}
ok = str(assignee.get("id", "")) == sys.argv[1] and issue.get("status", {}).get("name") != "Closed"
raise SystemExit(0 if ok else 1)
' "$expected"
  if [ $? -eq 0 ]; then
    pass "issue #${issue} is open and assigned to ${label}: ${subject}"
  else
    fail "issue #${issue} is not open and assigned to ${label}: ${subject}"
  fi
}

echo
echo "--- Redmine ---"

# ===========================================================================
# 1. the REST API works with the admin API key
# ===========================================================================
if redmine_api GET "/users/current.json" | python3 -c '
import json,sys
sys.exit(0 if json.load(sys.stdin).get("user", {}).get("login") == sys.argv[1] else 1)
' "${REDMINE_ADMIN_LOGIN}"; then
  pass "GET /users/current.json works with the admin API key (${REDMINE_ADMIN_LOGIN})"
else
  fail "GET /users/current.json with the admin API key failed"
fi

# ===========================================================================
# 2. the administrator is the project manager
# ===========================================================================
PM_ID=$(redmine_user_id "${REDMINE_ADMIN_LOGIN}")
if [ -n "$PM_ID" ]; then
  pass "the PM account exists (login '${REDMINE_ADMIN_LOGIN}', id ${PM_ID})"
else
  fail "the PM account '${REDMINE_ADMIN_LOGIN}' is missing"
fi

redmine_api GET "/users/${PM_ID}.json" | python3 -c '
import json,sys
firstname, lastname, mail = sys.argv[1], sys.argv[2], sys.argv[3]
user = json.load(sys.stdin).get("user", {})
ok = (user.get("firstname") == firstname and user.get("lastname") == lastname
      and user.get("mail") == mail and user.get("admin") is True)
raise SystemExit(0 if ok else 1)
' "${REDMINE_PM_FIRSTNAME}" "${REDMINE_PM_LASTNAME}" "${REDMINE_PM_MAIL}"
if [ $? -eq 0 ]; then
  pass "the administrator is the project manager '${REDMINE_PM_FIRSTNAME} ${REDMINE_PM_LASTNAME}' <${REDMINE_PM_MAIL}>"
else
  fail "the administrator has no PM display name (${REDMINE_PM_FIRSTNAME} ${REDMINE_PM_LASTNAME} <${REDMINE_PM_MAIL}>)"
fi

# ===========================================================================
# 3. the developer account is `dev` (renamed from `agent`), one account only
# ===========================================================================
DEV_ID=$(redmine_user_id "${REDMINE_DEV_LOGIN}")
if [ -n "$DEV_ID" ]; then
  pass "the developer account exists (login '${REDMINE_DEV_LOGIN}', id ${DEV_ID})"
else
  fail "the developer account '${REDMINE_DEV_LOGIN}' is missing - was the `agent` account renamed?"
fi

LEGACY_ID=$(redmine_user_id "${REDMINE_LEGACY_DEV_LOGIN}")
if [ -n "$LEGACY_ID" ]; then
  fail "the old Redmine account '${REDMINE_LEGACY_DEV_LOGIN}' still exists (id ${LEGACY_ID}): init.rb must rename it to '${REDMINE_DEV_LOGIN}'"
else
  pass "no old '${REDMINE_LEGACY_DEV_LOGIN}' Redmine account remains: the bound account is '${REDMINE_DEV_LOGIN}'"
fi

redmine_api GET "/users/${DEV_ID}.json" | python3 -c '
import json,sys
user = json.load(sys.stdin).get("user", {})
firstname, lastname, mail = sys.argv[1], sys.argv[2], sys.argv[3]
ok = (user.get("firstname") == firstname and user.get("lastname") == lastname
      and user.get("mail") == mail and user.get("admin") is False)
raise SystemExit(0 if ok else 1)
' "${REDMINE_DEV_FIRSTNAME}" "${REDMINE_DEV_LASTNAME}" "${REDMINE_DEV_MAIL}"
if [ $? -eq 0 ]; then
  pass "the developer account is a person: '${REDMINE_DEV_FIRSTNAME} ${REDMINE_DEV_LASTNAME}' <${REDMINE_DEV_MAIL}>"
else
  fail "the developer account has no human display name (${REDMINE_DEV_FIRSTNAME} ${REDMINE_DEV_LASTNAME} <${REDMINE_DEV_MAIL}>)"
fi

# ===========================================================================
# 4. the dev API key works and is the key of the same account
# ===========================================================================
redmine_api_as "${REDMINE_DEV_API_KEY}" GET "/users/current.json" | python3 -c '
import json,sys
user = json.load(sys.stdin).get("user", {})
sys.exit(0 if user.get("login") == sys.argv[1] and str(user.get("id")) == sys.argv[2] else 1)
' "${REDMINE_DEV_LOGIN}" "${DEV_ID}"
if [ $? -eq 0 ]; then
  pass "the dev API key (${REDMINE_DEV_API_KEY}) is accepted for the '${REDMINE_DEV_LOGIN}' account"
else
  fail "the dev API key (${REDMINE_DEV_API_KEY}) was rejected or belongs to another account"
fi

# ===========================================================================
# 5. the scenario projects exist; their identifiers name the Gerrit projects
# ===========================================================================
for entry in "${REDMINE_SDK_PROJECT}:${REDMINE_SDK_PROJECT_NAME}" \
             "${REDMINE_SDK_CLI_PROJECT}:${REDMINE_SDK_CLI_PROJECT_NAME}"; do
  project="${entry%%:*}"
  name="${entry#*:}"
  redmine_api GET "/projects/${project}.json" | python3 -c '
import json,sys
project = json.load(sys.stdin).get("project", {})
sys.exit(0 if project.get("identifier") == sys.argv[1] and project.get("name") == sys.argv[2] else 1)
' "$project" "$name"
  if [ $? -eq 0 ]; then
    pass "the Redmine project '${project}' (\"${name}\") exists"
  else
    fail "the Redmine project '${project}' (\"${name}\") is missing or has the wrong name"
  fi
done

# the old demo project stays for compatibility
redmine_api GET "/projects/${REDMINE_PROJECT_ID}.json" | grep -q '"identifier"'
if [ $? -eq 0 ]; then
  pass "the old project '${REDMINE_PROJECT_ID}' is kept for compatibility"
else
  fail "the old project '${REDMINE_PROJECT_ID}' is missing"
fi

# ===========================================================================
# 6. the role memberships of the scenario projects
# ===========================================================================
for project in "${REDMINE_SDK_PROJECT}" "${REDMINE_SDK_CLI_PROJECT}"; do
  check_membership "$project" "$DEV_ID" "Developer" "dev"
  check_membership "$project" "$PM_ID" "Manager" "the PM"
done

# ===========================================================================
# 7. the seeded issues: assigned to dev (the defects) / to the PM (negative)
# ===========================================================================
SDK_PAGINATION_SUBJECT="Paginator drops the last page of a collection whose size is not a multiple of the page size"
SDK_PAGINATION_ID=$(redmine_issue_id "${REDMINE_SDK_PROJECT}" "$SDK_PAGINATION_SUBJECT")
SDK_RETRY_SUBJECT="RetryPolicy retries 400/404 answers and slows down every failing request"
SDK_RETRY_ID=$(redmine_issue_id "${REDMINE_SDK_PROJECT}" "$SDK_RETRY_SUBJECT")
SDK_AUTH_SUBJECT="Access token is not refreshed before it expires: requests fail with 401 near the expiry time"
SDK_AUTH_ID=$(redmine_issue_id "${REDMINE_SDK_PROJECT}" "$SDK_AUTH_SUBJECT")
CLI_TIMEOUT_SUBJECT="--timeout is accepted but ignored: requests still use the 30 second default"
CLI_TIMEOUT_ID=$(redmine_issue_id "${REDMINE_SDK_CLI_PROJECT}" "$CLI_TIMEOUT_SUBJECT")
SDK_NEGATIVE_SUBJECT="Document the 1.0 migration guide of the demo SDK"
SDK_NEGATIVE_ID=$(redmine_issue_id "${REDMINE_SDK_PROJECT}" "$SDK_NEGATIVE_SUBJECT")

check_issue "${REDMINE_SDK_PROJECT}" "$SDK_PAGINATION_SUBJECT" "$DEV_ID" "dev"
check_issue "${REDMINE_SDK_PROJECT}" "$SDK_RETRY_SUBJECT" "$DEV_ID" "dev"
check_issue "${REDMINE_SDK_PROJECT}" "$SDK_AUTH_SUBJECT" "$DEV_ID" "dev"
check_issue "${REDMINE_SDK_CLI_PROJECT}" "$CLI_TIMEOUT_SUBJECT" "$DEV_ID" "dev"
check_issue "${REDMINE_SDK_PROJECT}" "$SDK_NEGATIVE_SUBJECT" "$PM_ID" "the PM (negative case)"

# ===========================================================================
# 8. the workbench list of the bound account is exactly the dev issues
# ===========================================================================
WORKBENCH=$(redmine_api_as "${REDMINE_DEV_API_KEY}" GET "/issues.json?assigned_to_id=me&status_id=open&limit=100")
echo "$WORKBENCH" | python3 -c '
import json,sys
expected = set(arg for arg in sys.argv[1:] if arg)
issues = json.load(sys.stdin).get("issues", [])
ids = set(str(issue["id"]) for issue in issues)
missing = expected - ids
sys.exit(0 if not missing else 1)
' "$SDK_PAGINATION_ID" "$SDK_RETRY_ID" "$SDK_AUTH_ID" "$CLI_TIMEOUT_ID"
if [ $? -eq 0 ]; then
  WORKBENCH_COUNT=$(echo "$WORKBENCH" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("issues", [])))')
  pass "GET /issues.json?assigned_to_id=me&status_id=open returns the ${WORKBENCH_COUNT} dev issues"
else
  fail "the dev workbench query does not return every seeded defect issue (or the dev API key is rejected)"
fi

echo "$WORKBENCH" | python3 -c '
import json,sys
forbidden = sys.argv[1]
for issue in json.load(sys.stdin).get("issues", []):
    if str(issue["id"]) == forbidden:
        sys.exit(1)
' "$SDK_NEGATIVE_ID"
if [ $? -eq 0 ]; then
  pass "the workbench list does not contain the issue assigned to the PM (negative case)"
else
  fail "the workbench list contains the issue assigned to the PM (#${SDK_NEGATIVE_ID})"
fi

# ===========================================================================
# 9. the issue description carries the reproduction the PM wrote
# ===========================================================================
if [ -n "$SDK_PAGINATION_ID" ] && redmine_api GET "/issues/${SDK_PAGINATION_ID}.json" | python3 -c '
import json,sys
description = json.load(sys.stdin).get("issue", {}).get("description", "")
for needle in ("Steps to reproduce", "Expected", "Actual", "Pointers"):
    if needle not in description:
        sys.exit(1)
sys.exit(0)
'; then
  pass "issue #${SDK_PAGINATION_ID} has a defect report (symptom, reproduction, expected, actual, pointers)"
else
  fail "issue #${SDK_PAGINATION_ID} has no complete defect report"
fi

# ===========================================================================
# 10. the old demo issues are closed so that the workbench is clean
# ===========================================================================
DEMO_OPEN=$(redmine_api GET "/issues.json?project_id=${REDMINE_PROJECT_ID}&status_id=open&limit=100")
echo "$DEMO_OPEN" | python3 -c 'import json,sys; sys.exit(0 if not json.load(sys.stdin).get("issues") else 1)'
if [ $? -eq 0 ]; then
  pass "no open issues are left in the old project '${REDMINE_PROJECT_ID}'"
else
  fail "the old project '${REDMINE_PROJECT_ID}' still has open issues"
fi

# ===========================================================================
# 11. a note written as the dev account shows up as a journal (pmsReply path)
# ===========================================================================
NOTE="verification note $(date +%s)"
NOTE_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT \
  -H "X-Redmine-API-Key: ${REDMINE_DEV_API_KEY}" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"issue":{"notes":sys.argv[1]}}))' "$NOTE")" \
  "${REDMINE_URL}/issues/${SDK_PAGINATION_ID}.json")
if [ "$NOTE_CODE" = "204" ]; then
  pass "PUT /issues/${SDK_PAGINATION_ID}.json with a note returns 204 as the dev account"
else
  fail "PUT /issues/${SDK_PAGINATION_ID}.json with a note returned ${NOTE_CODE}"
fi
redmine_api GET "/issues/${SDK_PAGINATION_ID}.json?include=journals" | python3 -c '
import json,sys
note = sys.argv[1]
for journal in json.load(sys.stdin).get("issue", {}).get("journals", []):
    if note in (journal.get("notes") or ""):
        sys.exit(0)
sys.exit(1)
' "$NOTE"
if [ $? -eq 0 ]; then
  pass "the note is returned by GET /issues/${SDK_PAGINATION_ID}.json?include=journals"
else
  fail "the note is missing in GET /issues/${SDK_PAGINATION_ID}.json?include=journals"
fi

# ===========================================================================
# 12. the `updated_on=><iso8601>` filter works (the polling path)
# ===========================================================================
SINCE="2020-01-01T00:00:00Z"
FILTERED=$(curl -sS -G -H "X-Redmine-API-Key: ${REDMINE_DEV_API_KEY}" \
  "${REDMINE_URL}/issues.json" \
  --data-urlencode "project_id=${REDMINE_SDK_PROJECT}" \
  --data-urlencode "status_id=*" \
  --data-urlencode "updated_on=>=${SINCE}")
echo "$FILTERED" | python3 -c '
import json,sys
issues = json.load(sys.stdin).get("issues", [])
sys.exit(0 if issues and all(issue.get("updated_on", "") >= sys.argv[1] for issue in issues) else 1)
' "$SINCE"
if [ $? -eq 0 ]; then
  pass "the updated_on>=${SINCE} filter works for the dev account"
else
  fail "the updated_on>=${SINCE} filter does not work for the dev account"
fi

FUTURE=$(curl -sS -G -H "X-Redmine-API-Key: ${REDMINE_DEV_API_KEY}" \
  "${REDMINE_URL}/issues.json" \
  --data-urlencode "project_id=${REDMINE_SDK_PROJECT}" \
  --data-urlencode "status_id=*" \
  --data-urlencode "updated_on=>=2030-01-01T00:00:00Z")
echo "$FUTURE" | python3 -c 'import json,sys; sys.exit(0 if not json.load(sys.stdin).get("issues") else 1)'
if [ $? -eq 0 ]; then
  pass "the updated_on>= filter really filters (a future date returns nothing)"
else
  fail "the updated_on>= filter does not filter"
fi

echo
echo "--- Gerrit ---"

# ===========================================================================
# 13. the REST API lists the scenario projects (and the kept demo project)
# ===========================================================================
PROJECTS=$(gerrit_api GET "/a/projects/")
for project in "${REDMINE_SDK_PROJECT}" "${REDMINE_SDK_CLI_PROJECT}" "${GERRIT_PROJECT}"; do
  echo "$PROJECTS" | gerrit_body | python3 -c '
import json,sys
sys.exit(0 if sys.argv[1] in json.load(sys.stdin) else 1)
' "$project"
  if [ $? -eq 0 ]; then
    pass "GET /a/projects lists the Gerrit project '${project}'"
  else
    fail "the Gerrit project '${project}' is missing in GET /a/projects"
  fi
done

if echo "$PROJECTS" | head -1 | grep -q ")]}'"; then
  pass "the gerrit responses carry the )]}' prefix"
else
  fail "the gerrit responses do not carry the )]}' prefix"
fi

# ===========================================================================
# 14. a person can sign in to the web UI (kept from the initial environment)
# ===========================================================================
LOGIN_HEADERS=$(curl -sS -m 20 -D - -o /dev/null -u "${GERRIT_WEB_LOGIN}:${GERRIT_WEB_PASSWORD}" \
  "${GERRIT_URL}/login" 2>/dev/null)
if echo "$LOGIN_HEADERS" | grep -qi "^set-cookie: GerritAccount="; then
  pass "the web account '${GERRIT_WEB_LOGIN}' signs in to the web UI"
else
  fail "the web account '${GERRIT_WEB_LOGIN}' cannot sign in to the web UI"
fi

ANON_HEADERS=$(curl -sS -m 20 -D - -o /dev/null "${GERRIT_URL}/" 2>/dev/null)
if echo "$ANON_HEADERS" | grep -qi "^www-authenticate: Basic"; then
  pass "the front end of the review server asks the browser for the credentials"
else
  fail "the front end of the review server does not ask the browser for the credentials"
fi

if curl -sS -m 20 -u "${GERRIT_WEB_LOGIN}:${GERRIT_WEB_PASSWORD}" \
  "${GERRIT_URL}/a/accounts/self/external.ids" 2>/dev/null | grep -q "gerrit:${GERRIT_WEB_LOGIN}"; then
  pass "the web account carries the external id the HTTP mode looks the user up by"
else
  fail "the web account has no 'gerrit:${GERRIT_WEB_LOGIN}' external id and cannot be used in the browser"
fi

# ===========================================================================
# 15. the agent can clone the repositories over SSH
# ===========================================================================
WORKDIR=$(mktemp -d)

for project in "${REDMINE_SDK_PROJECT}" "${REDMINE_SDK_CLI_PROJECT}"; do
  if git clone -q "$(gerrit_project_url "$project")" "${WORKDIR}/${project}" 2>/dev/null; then
    pass "the agent can clone the repository '${project}' over SSH"
  else
    fail "the agent cannot clone the repository '${project}' over SSH"
  fi
done

# ===========================================================================
# 16. the repositories hold the seeded Python code and the pytest suite
# ===========================================================================
check_repo_file() { # <project> <path>
  if [ -f "${WORKDIR}/${1}/${2}" ]; then
    pass "${1}: ${2} is seeded"
  else
    fail "${1}: ${2} is missing"
  fi
}

for path in README.md pyproject.toml \
            demo_sdk/__init__.py demo_sdk/client.py demo_sdk/pagination.py \
            demo_sdk/retry.py demo_sdk/auth.py demo_sdk/errors.py \
            tests/test_pagination.py tests/test_retry.py tests/test_auth.py \
            tests/test_client.py tests/test_known_bugs.py; do
  check_repo_file "${REDMINE_SDK_PROJECT}" "$path"
done

for path in README.md pyproject.toml sdk_cli/__init__.py sdk_cli/__main__.py \
            sdk_cli/main.py sdk_cli/api.py tests/test_api.py tests/test_cli.py \
            tests/test_known_bugs.py; do
  check_repo_file "${REDMINE_SDK_CLI_PROJECT}" "$path"
done

if [ -d "${WORKDIR}/${REDMINE_SDK_PROJECT}" ] && \
   (cd "${WORKDIR}/${REDMINE_SDK_PROJECT}" && python3 -m compileall -q demo_sdk tests) >/dev/null 2>&1; then
  pass "the Python code of the SDK compiles (python3 -m compileall)"
else
  fail "the Python code of the SDK does not compile"
fi

if [ -d "${WORKDIR}/${REDMINE_SDK_CLI_PROJECT}" ] && \
   (cd "${WORKDIR}/${REDMINE_SDK_CLI_PROJECT}" && python3 -m compileall -q sdk_cli tests) >/dev/null 2>&1; then
  pass "the Python code of the CLI compiles (python3 -m compileall)"
else
  fail "the Python code of the CLI does not compile"
fi

# ===========================================================================
# 17. the defects are present in the seeded code (the issues really reproduce)
# ===========================================================================
if [ -d "${WORKDIR}/${REDMINE_SDK_PROJECT}" ] && \
   (cd "${WORKDIR}/${REDMINE_SDK_PROJECT}" && python3 -c '
import sys
sys.path.insert(0, ".")
from demo_sdk.pagination import Paginator

class FakeClient:
    def __init__(self):
        self.pages = {1: ["."] * 100, 2: ["."] * 100, 3: ["."] * 50}
    def get(self, path, params=None):
        return {"items": self.pages.get(params["page"], []), "total": 250}

defect = len(list(Paginator(FakeClient(), "/things", page_size=100))) == 200
raise SystemExit(0 if defect else 1)
') >/dev/null 2>&1; then
  pass "the pagination defect is present in the seeded SDK (200 of 250 items come back)"
else
  fail "the pagination defect is not present in the seeded SDK - the scenario was already fixed?"
fi

if [ -d "${WORKDIR}/${REDMINE_SDK_CLI_PROJECT}" ] && \
   (cd "${WORKDIR}/${REDMINE_SDK_CLI_PROJECT}" && python3 -c '
import sys
sys.path.insert(0, ".")
from sdk_cli.main import build_client, build_parser

args = build_parser().parse_args(["--timeout", "5", "get", "/projects"])
defect = build_client(args).timeout == 30.0
raise SystemExit(0 if defect else 1)
') >/dev/null 2>&1; then
  pass "the --timeout defect is present in the seeded CLI (5 -> default 30.0)"
else
  fail "the --timeout defect is not present in the seeded CLI - the scenario was already fixed?"
fi

# ===========================================================================
# 18. the agent can push a change that names the issue, and the trailer survives
# ===========================================================================
push_issue_change() { # <project> <issue-id>
  local project="$1" issue_id="$2" dir="${WORKDIR}/${1}"
  local change_id push_out changes change_number detail
  if [ -z "$issue_id" ]; then
    fail "cannot push to ${project}: the Redmine issue id is unknown (is the scenario seeded?)"
    return 0
  fi
  (
    cd "$dir" || exit 1
    git checkout -q "${GERRIT_BRANCH}" 2>/dev/null || git checkout -q -B "${GERRIT_BRANCH}"
    git clean -fdq
    git config user.email "${GERRIT_AGENT_EMAIL}"
    git config user.name "Super Agent"
    install_commit_msg_hook "$(git rev-parse --git-dir)"
    echo "# verification $(date +%s)" >> README.md
    git add -A
    git commit -q -m "Verify the ${project} scenario

Issue: #${issue_id}

Temporary change pushed by verify.sh; it is abandoned again after the check."
  )
  change_id=$(cd "$dir" && git log -1 --format=%B | sed -n 's/^Change-Id: //p')
  push_out=$(cd "$dir" && git push origin "HEAD:refs/for/${GERRIT_BRANCH}" 2>&1)
  if echo "$push_out" | grep -q "new reference"; then
    pass "the agent can push to refs/for/${GERRIT_BRANCH} in '${project}'"
  else
    fail "the agent cannot push to refs/for/${GERRIT_BRANCH} in '${project}': ${push_out}"
  fi
  if echo "$push_out" | grep -qE "#/c/${project}/\+/[0-9]+"; then
    pass "the push output of '${project}' contains the new UI change url"
  else
    fail "the push output of '${project}' does not contain the new UI change url: ${push_out}"
  fi

  # read the change back through the review server, found by its Change-Id
  changes=$(gerrit_api GET "/a/changes/?q=change:${change_id}&o=CURRENT_REVISION&o=CURRENT_COMMIT")
  change_number=$(echo "$changes" | gerrit_body | python3 -c '
import json,sys
changes = json.load(sys.stdin)
print(changes[0].get("_number", "") if changes else "")
')
  if [ -z "$change_number" ]; then
    fail "the pushed change of '${project}' cannot be found by its Change-Id ${change_id}"
    return 0
  fi

  detail=$(gerrit_api GET "/a/changes/${change_number}/detail?o=ALL_REVISIONS&o=CURRENT_COMMIT")
  echo "$detail" | gerrit_body | python3 -c '
import json,sys
expected_project, expected_issue, expected_owner = sys.argv[1], "Issue: #" + sys.argv[2], sys.argv[3]
# The review server answers a change detail with the change itself.
change = json.load(sys.stdin)
if change.get("project") != expected_project:
    raise SystemExit(1)
if change.get("status") != "NEW":
    raise SystemExit(1)
owner = change.get("owner") or {}
if owner.get("username") != expected_owner:
    raise SystemExit(1)
' "${project}" "${issue_id}" "${GERRIT_AGENT_LOGIN}"
  if [ $? -eq 0 ]; then
    pass "change ${change_number} of '${project}' is NEW, belongs to the agent and is in the right project"
  else
    fail "change ${change_number} of '${project}' has the wrong project, status or owner"
  fi

  echo "$detail" | gerrit_body | python3 -c '
import json,sys
expected = "Issue: #" + sys.argv[1]
change = json.load(sys.stdin)
revision = change.get("current_revision", "")
message = ((change.get("revisions") or {}).get(revision) or {}).get("commit", {}).get("message", "")
sys.exit(0 if expected in message else 1)
' "${issue_id}"
  if [ $? -eq 0 ]; then
    pass "the 'Issue: #${issue_id}' trailer survives in the commit message of change ${change_number}"
  else
    fail "the 'Issue: #${issue_id}' trailer is missing in the reviewed commit message of change ${change_number}"
  fi

  # keep the review queue clean: the verification change is abandoned again
  ABANDON_CODE=$(gerrit_api_code POST "/a/changes/${change_number}/abandon" \
    '{"message":"verify.sh: temporary verification change"}')
  case "$ABANDON_CODE" in
    200|204) pass "change ${change_number} was abandoned again (the review queue stays clean)" ;;
    *) fail "could not abandon the verification change ${change_number} (http ${ABANDON_CODE})" ;;
  esac
}

push_issue_change "${REDMINE_SDK_PROJECT}" "$SDK_PAGINATION_ID"
push_issue_change "${REDMINE_SDK_CLI_PROJECT}" "$CLI_TIMEOUT_ID"

# ===========================================================================
# Result
# ===========================================================================
COMPLETED=1
echo
echo "=============================================================="
if [ "$FAILED" -eq 0 ]; then
  echo " RESULT: all checks passed"
  echo "=============================================================="
  exit 0
fi
echo " RESULT: ${FAILED} check(s) failed"
echo "=============================================================="
exit 1

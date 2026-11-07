#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Shared helpers for seed.sh / verify.sh.  Sourced, never executed directly.
# ---------------------------------------------------------------------------
set -euo pipefail

ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

set -a
# shellcheck disable=SC1091
source "${ENV_DIR}/.env"
set +a

REDMINE_URL="http://localhost:${REDMINE_PORT}"
GERRIT_URL="http://localhost:${GERRIT_HTTP_PORT}"

GERRIT_SSH_USER="${GERRIT_DEV_LOGIN}"
GERRIT_SSH_HOST="localhost"
GERRIT_SSH_URL="ssh://${GERRIT_SSH_USER}@${GERRIT_SSH_HOST}:${GERRIT_SSH_PORT}"
GERRIT_PROJECT_SSH_URL="${GERRIT_SSH_URL}/${GERRIT_PROJECT}"

KEY_FILE="${ENV_DIR}/${GERRIT_SSH_KEY_FILE}"
# The default key is ECDSA (nistp256).  Gerrit 2.15 runs on Java 8 and cannot
# handle Ed25519 keys, and modern OpenSSH (>= 8.8) refuses "ssh-rsa" (SHA-1)
# unless it is explicitly re-enabled, therefore:
#   * the RSA key needs  -o PubkeyAcceptedAlgorithms=+ssh-rsa
#   * the ECDSA key works with every current client
export GIT_SSH_COMMAND="ssh -i ${KEY_FILE} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o PubkeyAcceptedAlgorithms=+ssh-rsa"

FAILED=0

info() { printf '\033[0;36mINFO\033[0m  %s\n' "$*"; }
pass() { printf '\033[0;32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '\033[0;31mFAIL\033[0m  %s\n' "$*"; FAILED=$((FAILED + 1)); }
warn() { printf '\033[0;33mWARN\033[0m  %s\n' "$*"; }

# Gerrit prefixes every JSON response with the anti-hijacking prefix ")]}'".
# Strip the first line before parsing.
gerrit_body() { tail -n +2; }

# $1 = python expression evaluated against the parsed json in `d`
json_get() {
  python3 -c '
import json,sys
raw = sys.stdin.read()
if raw.startswith(")]}\x27"):
    raw = raw.split("\n", 1)[1] if "\n" in raw else ""
data = json.loads(raw)
print(eval(sys.argv[1], {"d": data, "json": json}))
' "$1"
}

redmine_api() { # <method> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" -H "X-Redmine-API-Key: ${REDMINE_ADMIN_API_KEY}" \
      -H 'Content-Type: application/json' -d "$body" "${REDMINE_URL}${path}"
  else
    curl -sS -X "$method" -H "X-Redmine-API-Key: ${REDMINE_ADMIN_API_KEY}" \
      "${REDMINE_URL}${path}"
  fi
}

redmine_api_as() { # <api-key> <method> <path> [json-body]
  local key="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" -H "X-Redmine-API-Key: ${key}" \
      -H 'Content-Type: application/json' -d "$body" "${REDMINE_URL}${path}"
  else
    curl -sS -X "$method" -H "X-Redmine-API-Key: ${key}" "${REDMINE_URL}${path}"
  fi
}

# The numeric user id of a Redmine login (the issue API returns the assignee as
# {"id":..,"name":..} without the login, so the id is needed to compare).
redmine_user_id() { # <login>
  redmine_api GET "/users.json?limit=100" | python3 -c '
import json,sys
login = sys.argv[1]
for user in json.load(sys.stdin).get("users", []):
    if user.get("login") == login:
        print(user["id"]); break
' "$1"
}

# Echo the id of the issue with exactly this subject in the project, if any.
redmine_issue_id() { # <project> <subject>
  local project="$1" subject="$2"
  redmine_api GET "/issues.json?project_id=${project}&status_id=*&limit=100&subject=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$subject")" \
  | python3 -c '
import json,sys
subject = sys.argv[1]
for issue in json.load(sys.stdin).get("issues", []):
    if issue.get("subject") == subject:
        print(issue["id"]); break
' "$subject"
}

# The SSH URL of a Gerrit project.  A Redmine project identifier names the
# Gerrit repository, so every scenario project has an SSH URL of its own.
gerrit_project_url() { # <project>
  printf '%s/%s' "${GERRIT_SSH_URL}" "$1"
}


redmine_api_code() { # <method> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" \
      -H "X-Redmine-API-Key: ${REDMINE_ADMIN_API_KEY}" \
      -H 'Content-Type: application/json' -d "$body" "${REDMINE_URL}${path}"
  else
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" \
      -H "X-Redmine-API-Key: ${REDMINE_ADMIN_API_KEY}" "${REDMINE_URL}${path}"
  fi
}

# The same call with the API key of a role: the leader authors the issues, the
# developer answers on them.
redmine_api_code_as() { # <api-key> <method> <path> [json-body]
  local key="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" \
      -H "X-Redmine-API-Key: ${key}" \
      -H 'Content-Type: application/json' -d "$body" "${REDMINE_URL}${path}"
  else
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" \
      -H "X-Redmine-API-Key: ${key}" "${REDMINE_URL}${path}"
  fi
}

gerrit_api() { # <method> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" -u "${GERRIT_ADMIN_LOGIN}:${GERRIT_ADMIN_PASSWORD}" \
      -H 'Content-Type: application/json' -d "$body" "${GERRIT_URL}${path}"
  else
    curl -sS -X "$method" -u "${GERRIT_ADMIN_LOGIN}:${GERRIT_ADMIN_PASSWORD}" \
      "${GERRIT_URL}${path}"
  fi
}

gerrit_api_code() { # <method> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" \
      -u "${GERRIT_ADMIN_LOGIN}:${GERRIT_ADMIN_PASSWORD}" \
      -H 'Content-Type: application/json' -d "$body" "${GERRIT_URL}${path}"
  else
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" \
      -u "${GERRIT_ADMIN_LOGIN}:${GERRIT_ADMIN_PASSWORD}" "${GERRIT_URL}${path}"
  fi
}

# download the gerrit commit-msg hook (adds the Change-Id footer)
install_commit_msg_hook() { # <git-dir>
  local gitdir="$1"
  # The hook is served by the API of the review server, which accepts the credentials of the scripts; the web UI in
  # front of it only knows the account of the reviewer.
  curl -sS -u "${GERRIT_ADMIN_LOGIN}:${GERRIT_ADMIN_PASSWORD}" \
    -o "${gitdir}/hooks/commit-msg" "${GERRIT_URL}/a/tools/hooks/commit-msg"
  chmod +x "${gitdir}/hooks/commit-msg"
}

wait_for() { # <seconds> <description> <command...>
  local timeout="$1" what="$2"; shift 2
  local i
  for i in $(seq 1 "$timeout"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "timed out after ${timeout}s waiting for ${what}" >&2
  return 1
}

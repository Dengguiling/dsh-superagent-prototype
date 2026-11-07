#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Provision the three roles of the company in the running stack.  Idempotent:
# running it again only re-applies what is missing.
#
#   Redmine  the accounts come from the `redmine-init` job (the REST API
#            cannot create users), so this script checks that each role exists
#            and that its API key works:
#              admin  the system manager: the highest rights, out of the tests
#              lead   the leader: assigns the work to the developer
#              dev    the developer: the account the superagent binds to
#   Gerrit   the accounts are created here, because the review server knows
#            them best:
#              dev    over the REST API, with the SSH key of the superagent:
#                     it pushes the patches
#              lead   by signing in over HTTP, the only way Gerrit gives an
#                     account the external id its HTTP mode looks it up by:
#                     it reviews and merges the patches
#            The groups "Developers" and "Reviewers" carry the rights of the
#            roles; the leader and the developer administer this mock company,
#            so the reviewer can merge.  The developer cannot merge its own
#            patch: Gerrit asks for a review by somebody else.
#
# Usage: ./accounts.sh
# ---------------------------------------------------------------------------
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/common.sh"

ADMIN_AUTH="${GERRIT_ADMIN_LOGIN}:${GERRIT_ADMIN_PASSWORD}"
KEY="${ENV_DIR}/${GERRIT_SSH_KEY_FILE}"

echo "=============================================================="
echo " dsh-superagent: the accounts of the company"
echo "=============================================================="
echo

# ---------------------------------------------------------------------------
# Redmine
# ---------------------------------------------------------------------------
echo "--- Redmine ---"
check_redmine_role() { # <role> <login> <api key>
  local role="$1" login="$2" key="$3" who
  who=$(redmine_api_as "$key" GET "/users/current.json" | python3 -c '
import json,sys
try:
    user = json.load(sys.stdin)["user"]
except Exception:
    print(""); raise SystemExit(0)
print("%s (%s %s)" % (user.get("login"), user.get("firstname", ""), user.get("lastname", "")))
' 2>/dev/null || true)
  if [ -z "$who" ]; then
    fail "the ${role} account '${login}' does not answer with its API key (run the redmine-init job)"
  else
    info "the ${role} account '${login}' is ${who}"
  fi
}
check_redmine_role "administrator" "$REDMINE_ADMIN_LOGIN" "$REDMINE_ADMIN_API_KEY"
check_redmine_role "leader" "$REDMINE_LEAD_LOGIN" "$REDMINE_LEAD_API_KEY"
check_redmine_role "developer" "$REDMINE_DEV_LOGIN" "$REDMINE_DEV_API_KEY"
echo

# ---------------------------------------------------------------------------
# Gerrit: the accounts
# ---------------------------------------------------------------------------
echo "--- Gerrit ---"

# The uuid of a Gerrit group, which the access rules name.
group_uuid() { # <group name>
  gerrit_api GET "/a/groups/${1}" | json_get 'd.get("id", "")'
}

# The id of a Gerrit account, by its login.
account_id() { # <login>
  gerrit_api GET "/a/accounts/?q=username:${1}" | json_get 'd[0].get("_account_id", "") if d else ""'
}

# A Gerrit command over SSH, as the administrator: the groups are created this
# way, because the REST API of 2.15 cannot.
gerrit_ssh() { # <command...>
  ssh -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o PubkeyAcceptedAlgorithms=+ssh-rsa -p "$GERRIT_SSH_PORT" \
    "${GERRIT_ADMIN_LOGIN}@${GERRIT_SSH_HOST}" gerrit "$@" 2>&1
}

# The administrator needs an SSH key to create the groups of the roles.
ensure_admin_key() {
  local id code
  id=$(account_id "$GERRIT_ADMIN_LOGIN")
  if [ -z "$id" ]; then fail "the administrator account is missing"; return 1; fi
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -u "$ADMIN_AUTH" \
    -H "Content-Type: text/plain" --data-binary "@${KEY}.pub" \
    "${GERRIT_URL}/a/accounts/${id}/sshkeys")
  case "$code" in
    200|201|204) info "the SSH key of the administrator is registered" ;;
    409) info "the SSH key of the administrator is already registered" ;;
    *) fail "could not register the SSH key of the administrator (http $code)"; return 1 ;;
  esac
}

# Creates a group of the roles and adds the account to it.
ensure_group_member() { # <group> <login>
  local group="$1" login="$2" uuid code
  uuid=$(group_uuid "$group")
  if [ -z "$uuid" ]; then
    gerrit_ssh create-group "$group" >/dev/null || true
    uuid=$(group_uuid "$group")
    if [ -z "$uuid" ]; then fail "could not create the group '${group}'"; return 1; fi
    info "the group '${group}' was created"
  fi
  code=$(gerrit_api_code PUT "/a/groups/${uuid}/members/${login}")
  case "$code" in
    200|201|204) info "'${login}' is a member of the group '${group}'" ;;
    409) info "'${login}' already is a member of the group '${group}'" ;;
    *) fail "could not add '${login}' to the group '${group}' (http $code)"; return 1 ;;
  esac
}

# The administrator of the site: the leader reviews and merges, and the
# developer pushes the patches.
ensure_administrator() { # <login>
  local uuid code
  uuid=$(group_uuid "Administrators")
  code=$(gerrit_api_code PUT "/a/groups/${uuid}/members/${1}")
  case "$code" in
    200|201|204) info "'${1}' administers the review server" ;;
    409) info "'${1}' already administers the review server" ;;
    *) fail "could not make '${1}' an administrator (http $code)"; return 1 ;;
  esac
}

# The developer: created over the REST API, which is enough for a push over
# SSH, and it carries the SSH key of the superagent.
ensure_developer() {
  local body code
  body=$(printf '{"name":"Zhang Wei","email":"%s","http_password":"%s","ssh_key":"%s"}' \
    "$GERRIT_DEV_EMAIL" "$GERRIT_DEV_PASSWORD" "$(cat "${KEY}.pub")")
  code=$(gerrit_api_code PUT "/a/accounts/${GERRIT_DEV_LOGIN}" "$body")
  case "$code" in
    200|201) info "the developer account '${GERRIT_DEV_LOGIN}' was created" ;;
    409)
      info "the developer account '${GERRIT_DEV_LOGIN}' exists, refreshing its password"
      gerrit_api_code PUT "/a/accounts/$(account_id "${GERRIT_DEV_LOGIN}")/password.http" \
        "{\"http_password\":\"${GERRIT_DEV_PASSWORD}\"}" >/dev/null
      ;;
    *) fail "could not create the developer account (http $code)"; return 1 ;;
  esac
  # the public key has to be registered for the account explicitly
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -u "$ADMIN_AUTH" \
    -H "Content-Type: text/plain" --data-binary "@${KEY}.pub" \
    "${GERRIT_URL}/a/accounts/${GERRIT_DEV_LOGIN}/sshkeys")
  case "$code" in
    200|201|204) info "the SSH key is registered for '${GERRIT_DEV_LOGIN}'" ;;
    409) info "the SSH key is already registered for '${GERRIT_DEV_LOGIN}'" ;;
    *) fail "could not register the SSH key for '${GERRIT_DEV_LOGIN}' (http $code)"; return 1 ;;
  esac
}

# The leader: signing in over HTTP creates the account with the external id the
# HTTP mode looks it up by; only then can it be used in the browser.
ensure_leader() {
  local code id
  code=$(curl -sS -o /dev/null -w '%{http_code}' -u "${GERRIT_LEAD_LOGIN}:${GERRIT_LEAD_PASSWORD}" \
    "${GERRIT_URL}/login")
  case "$code" in
    200|302|303) info "the leader '${GERRIT_LEAD_LOGIN}' signed in (the account now exists)" ;;
    *) fail "the leader '${GERRIT_LEAD_LOGIN}' could not sign in (http $code)"; return 1 ;;
  esac
  id=$(account_id "${GERRIT_LEAD_LOGIN}")
  if [ -z "$id" ]; then fail "the leader's account was not created"; return 1; fi
  gerrit_api_code PUT "/a/accounts/${id}/password.http" \
    "{\"http_password\":\"${GERRIT_LEAD_PASSWORD}\"}" >/dev/null
  info "the leader's password is set"
}

ensure_admin_key
ensure_developer
ensure_leader
ensure_group_member "Developers" "$GERRIT_DEV_LOGIN"
ensure_group_member "Reviewers" "$GERRIT_LEAD_LOGIN"
ensure_administrator "$GERRIT_LEAD_LOGIN"
ensure_administrator "$GERRIT_DEV_LOGIN"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "  the accounts of the company are in place:"
  echo "    Redmine  ${REDMINE_ADMIN_LOGIN} (administrator) ${REDMINE_LEAD_LOGIN} (leader) ${REDMINE_DEV_LOGIN} (developer)"
  echo "    Gerrit  ${GERRIT_ADMIN_LOGIN} (administrator) ${GERRIT_LEAD_LOGIN} (leader) ${GERRIT_DEV_LOGIN} (developer)"
  echo
  echo "  the developer pushes the patches; the leader reviews and merges them."
  exit 0
fi
echo "  ${FAILED} step(s) failed"
exit 1

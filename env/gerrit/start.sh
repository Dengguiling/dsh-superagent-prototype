#!/bin/bash
# ---------------------------------------------------------------------------
# Start script of the Gerrit 2.15.13 service (runs inside the gerrit image).
#
# The site is bootstrapped on the very first start:
#
#   1. configure etc/gerrit.config (keeping the shipped serverId / db paths)
#   2. start Gerrit once with the development "become any account" auth
#   3. through the REST API: pin the admin HTTP password, create the `agent`
#      account with a fixed HTTP password + the SSH public keys, put the
#      agent into the Administrators group
#   4. switch etc/gerrit.config to [auth] type = HTTP, stop the bootstrap
#      instance and start Gerrit again (foreground, PID 1)
#
# A marker file in the site directory remembers that step 1-4 are done, so
# every later restart goes straight to step 5 (start with HTTP auth).
# ---------------------------------------------------------------------------
set -euo pipefail

SITE="${GERRIT_SITE:-/var/gerrit}"
CFG="${SITE}/etc/gerrit.config"
MARKER="${SITE}/etc/.dsh-superagent-bootstrapped"
HTTP="http://localhost:8080"
COOKIES=/tmp/gerrit-cookies.txt

ADMIN_LOGIN="${GERRIT_ADMIN_LOGIN:-admin}"
ADMIN_EMAIL="${GERRIT_ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${GERRIT_ADMIN_PASSWORD:-admin12345}"
# The developer: the account the superagent pushes the patches with.  It is
# created over the REST API, which is enough for a push over SSH.
DEV_LOGIN="${GERRIT_DEV_LOGIN:-dev}"
DEV_EMAIL="${GERRIT_DEV_EMAIL:-dev@example.com}"
DEV_PASSWORD="${GERRIT_DEV_PASSWORD:-dev12345}"
# The leader: the account a person signs in with in the web UI to review and
# merge the patches.  It is created by Gerrit's own HTTP login flow, because
# that is the only way to give it the external id that the HTTP authentication
# mode looks the user up by (see web_accounts below).
LEAD_LOGIN="${GERRIT_LEAD_LOGIN:-lead}"
LEAD_EMAIL="${GERRIT_LEAD_EMAIL:-lead@example.com}"
LEAD_PASSWORD="${GERRIT_LEAD_PASSWORD:-lead12345}"
CANONICAL_WEB_URL="${CANONICAL_WEB_URL:-http://localhost:8080/}"

# public keys of the agent account
AGENT_PUBKEYS=(/bootstrap/agent_id_ecdsa.pub /bootstrap/agent_id_rsa.pub)

log() { echo "[gerrit] $*"; }
die() { echo "[gerrit] ERROR: $*" >&2; exit 1; }

# --------------------------------------------------------------------------
# 1. configuration
# --------------------------------------------------------------------------
[ -f "$CFG" ] || die "missing $CFG"

# -XX:TieredStopAtLevel=1 keeps the JIT at C1.  The optimising compiler is
# pathologically slow under qemu user-mode emulation (arm64 host running the
# amd64 only image) and can stall the start-up for many minutes.
git config -f "$CFG" container.javaOptions \
  "-Djava.security.egd=file:/dev/./urandom -XX:TieredStopAtLevel=1"
git config -f "$CFG" gerrit.canonicalWebUrl "$CANONICAL_WEB_URL"
# the review server is reached through the proxy in front of it, which asks the
# browser for the credentials and hands the identity over in a header
git config -f "$CFG" httpd.listenUrl "proxy-http://*:8080/"
git config -f "$CFG" sshd.listenAddress "*:29418"
# The HTTP authentication mode takes the e-mail of a new account from this
# format, so the accounts that the login flow creates are complete ones.
git config -f "$CFG" auth.emailFormat '{0}@example.com'
# The "first time redirect" of the shipped image is not wanted once we run
# with real HTTP authentication.
git config -f "$CFG" --unset httpd.filterClass || true
git config -f "$CFG" --unset httpd.firstTimeRedirectUrl || true

# --------------------------------------------------------------------------
# 2. bootstrap (first start only)
# --------------------------------------------------------------------------
bootstrap() {
  # the development login servlet hands out an admin session
  git config -f "$CFG" auth.type DEVELOPMENT_BECOME_ANY_ACCOUNT
  log "starting the bootstrap instance of Gerrit ..."

  "${SITE}/bin/gerrit.sh" run &
  local pid=$!

  log "waiting for the HTTP endpoint ..."
  local ready=0 i
  for i in $(seq 1 120); do
    if curl -fsS -o /dev/null "${HTTP}/login" 2>/dev/null; then ready=1; break; fi
    if ! kill -0 "$pid" 2>/dev/null; then die "Gerrit died during start-up"; fi
    sleep 5
  done
  [ "$ready" = "1" ] || die "Gerrit did not become ready in time"
  log "HTTP endpoint is up"

  rm -f "$COOKIES"
  curl -fsS -c "$COOKIES" -o /dev/null "${HTTP}/login?account_id=1000000" \
    || die "could not open the admin session"
  local token
  token=$(awk '/GerritAccount/ {print $7}' "$COOKIES" | tail -1)
  [ -n "$token" ] || die "no GerritAccount cookie was returned"
  log "admin session acquired"

  set_password() { # <account> <password>
    curl -fsS -X PUT -H "Content-Type: application/json" \
      -d "{\"http_password\":\"$2\"}" \
      "${HTTP}/a/accounts/$1/password.http?access_token=${token}" >/dev/null \
      || die "could not set the HTTP password of account $1"
  }

  set_password 1000000 "$ADMIN_PASSWORD"
  log "admin HTTP password set"

  # --- the agent account ---------------------------------------------------
  local agent_json code
  agent_json=$(printf '{"name":"Zhang Wei","email":"%s","http_password":"%s","ssh_key":"%s"}' \
    "$DEV_EMAIL" "$DEV_PASSWORD" "$(cat "${AGENT_PUBKEYS[0]}")")
  code=$(curl -sS -o /tmp/agent-create.out -w '%{http_code}' -X PUT \
    -u "${ADMIN_LOGIN}:${ADMIN_PASSWORD}" \
    -H "Content-Type: application/json" -d "$agent_json" \
    "${HTTP}/a/accounts/${DEV_LOGIN}")
  case "$code" in
    200|201) log "developer account '${DEV_LOGIN}' created" ;;
    409)
      log "developer account '${DEV_LOGIN}' exists, refreshing credentials"
      set_password "${DEV_LOGIN}" "$DEV_PASSWORD" ;;
    *) die "could not create the agent account (http $code): $(cat /tmp/agent-create.out)" ;;
  esac

  # every public key of the agent has to be registered explicitly
  # (POST /a/accounts/<account>/sshkeys takes the key as raw body)
  local pub keycode
  for pub in "${AGENT_PUBKEYS[@]}"; do
    [ -f "$pub" ] || continue
    keycode=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
      -u "${ADMIN_LOGIN}:${ADMIN_PASSWORD}" \
      -H "Content-Type: text/plain" --data-binary "@${pub}" \
      "${HTTP}/a/accounts/${DEV_LOGIN}/sshkeys")
    case "$keycode" in
      200|201|204) log "ssh key registered: $(basename "$pub")" ;;
      409) log "ssh key already registered: $(basename "$pub")" ;;
      *) die "could not register ${pub} (http $keycode)" ;;
    esac
  done

  # The developer may create projects and push; the leader reviews and merges.
  # Both administer this mock company.
  local mcode
  for member in "${DEV_LOGIN}" "${LEAD_LOGIN}"; do
    mcode=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT \
      -u "${ADMIN_LOGIN}:${ADMIN_PASSWORD}" \
      "${HTTP}/a/groups/1/members/${member}")
    case "$mcode" in
      200|201|204) log "'${member}' added to the Administrators group" ;;
      409) log "'${member}' already is a member of the Administrators group" ;;
      *) die "could not add '${member}' to the Administrators group (http $mcode)" ;;
    esac
  done

  # --- switch to real HTTP authentication ----------------------------------
  git config -f "$CFG" auth.type HTTP
  log "auth.type switched to HTTP"

  log "stopping the bootstrap instance ..."
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "${SITE}"/db/*.lock.db 2>/dev/null || true

  # the leader's account, created by Gerrit itself
  web_accounts

  touch "$MARKER"
  log "bootstrap finished"
}

# --------------------------------------------------------------------------
# 3. the account a person signs in with in the web UI
# --------------------------------------------------------------------------
# Gerrit 2.15 in "auth.type = HTTP" mode takes the identity from the
# Authorization header of the request and looks it up as the external id
# "gerrit:<login>".  Only the HTTP login flow ever creates that external id: an
# account that was created over the REST API carries only "username:" and
# "mailto:" ids, so Gerrit tries to create a second account with the same user
# name and refuses with "name already in use" - which the web UI shows as a
# "Configuration Error" page.  The user name of an existing account can never
# be changed ("realm does not allow editing username"), and the REST API of
# 2.15 cannot add an external id either, so the browser account is created by
# signing in over HTTP and is then given its password and its rights.
web_accounts() {
  log "starting Gerrit with HTTP authentication for the web account ..."
  "${SITE}/bin/gerrit.sh" run &
  local pid=$!

  local ready=0 i
  for i in $(seq 1 120); do
    # the start page answers with 200 in every authentication mode; "/login"
    # answers with the error page of the HTTP mode and would hide the instance
    if curl -sS -o /dev/null "${HTTP}/" 2>/dev/null; then ready=1; break; fi
    if ! kill -0 "$pid" 2>/dev/null; then die "Gerrit died during start-up"; fi
    sleep 5
  done
  [ "$ready" = "1" ] || die "Gerrit did not become ready in time"

  # signing in creates the account with the external id the HTTP mode needs
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' -u "${LEAD_LOGIN}:${LEAD_PASSWORD}" "${HTTP}/login")
  case "$code" in
    200|302|303) log "the leader '${LEAD_LOGIN}' signed in (the account now exists)" ;;
    *) die "the leader '${LEAD_LOGIN}' could not sign in (http $code)" ;;
  esac

  # the account has no password of its own yet: the HTTP login flow does not set
  # one, and the REST API checks the password of the account
  local id
  id=$(curl -fsS -u "${ADMIN_LOGIN}:${ADMIN_PASSWORD}" \
    "${HTTP}/a/accounts/?q=username:${LEAD_LOGIN}" | sed -n 's/.*"_account_id": *\([0-9]*\).*/\1/p' | head -1)
  [ -n "$id" ] || die "the leader's account '${LEAD_LOGIN}' was not created"
  log "the leader's account id is ${id}"

  curl -fsS -o /dev/null -u "${ADMIN_LOGIN}:${ADMIN_PASSWORD}" -X PUT \
    -H "Content-Type: application/json" -d "{\"http_password\":\"${LEAD_PASSWORD}\"}" \
    "${HTTP}/a/accounts/${id}/password.http" || die "could not set the password of the leader's account"
  log "the leader's password set"

  # the leader reviews and merges the changes in the web UI, so the account
  # administers the site
  local mcode
  mcode=$(curl -sS -o /dev/null -w '%{http_code}' -u "${ADMIN_LOGIN}:${ADMIN_PASSWORD}" -X PUT \
    "${HTTP}/a/groups/1/members/${LEAD_LOGIN}")
  case "$mcode" in
    200|201|204) log "the leader was added to the Administrators group" ;;
    409) log "the leader already is a member of the Administrators group" ;;
    *) die "could not add the leader to the Administrators group (http $mcode)" ;;
  esac

  log "stopping the web account instance ..."
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "${SITE}"/db/*.lock.db 2>/dev/null || true
}

if [ -f "$MARKER" ]; then
  log "site already bootstrapped, starting Gerrit with HTTP authentication"
  git config -f "$CFG" auth.type HTTP
else
  bootstrap
fi

# --------------------------------------------------------------------------
# 3. run Gerrit in the foreground
# --------------------------------------------------------------------------
log "starting Gerrit ..."
exec "${SITE}/bin/gerrit.sh" run

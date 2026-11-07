#!/bin/sh
# ---------------------------------------------------------------------------
# Start script of the front end of the review server (runs inside nginx).
#
# Gerrit 2.15 in "auth.type = HTTP" mode has no sign-in form of its own: the
# web server in front of it has to authenticate the person and hand the
# identity over in the Authorization header.
#
# The front end therefore keeps two password files:
#
#   htpasswd.ui   the account of the leader, who reviews and merges the
#                 changes in the browser.  Only this account may open the web
#                 UI, so a browser that still holds a credential of an account
#                 that Gerrit refuses - the accounts that were created over
#                 the REST API carry no "gerrit:<login>" external id and make
#                 Gerrit answer "name already in use" - gets the challenge
#                 again instead of a dead end.
#   htpasswd.api  the accounts of the API clients: the developer, whose patches
#                 the superagent pushes, the leader, and the administrator of
#                 the scripts.
#
# The passwords come from the environment, so the files always match the
# accounts of the stack.  The hashes use the {SHA} scheme of nginx, which needs
# no crypt(3) library.
#
# The sign-in page of the environment (env/login) stores the credential of the
# chosen role in the cookie `dsh_auth`; the front end then hands it over
# instead of asking the browser again, so a session does not expire.
# ---------------------------------------------------------------------------
set -eu

: "${GERRIT_LEAD_LOGIN:?the login of the leader is required}"
: "${GERRIT_LEAD_PASSWORD:?the password of the leader is required}"
: "${GERRIT_DEV_LOGIN:?the login of the developer is required}"
: "${GERRIT_DEV_PASSWORD:?the password of the developer is required}"
: "${GERRIT_ADMIN_LOGIN:?the login of the administrator is required}"
: "${GERRIT_ADMIN_PASSWORD:?the password of the administrator is required}"

# The base64 of the SHA-1 of a password, the {SHA} scheme of nginx.
hash() {
  printf '%s' "$1" | sha1sum | cut -d' ' -f1 | xxd -r -p | base64 | tr -d '\n'
}

umask 022
{
  printf '%s:{SHA}%s\n' "$GERRIT_LEAD_LOGIN" "$(hash "$GERRIT_LEAD_PASSWORD")"
} > /etc/nginx/htpasswd.ui
{
  printf '%s:{SHA}%s\n' "$GERRIT_LEAD_LOGIN" "$(hash "$GERRIT_LEAD_PASSWORD")"
  printf '%s:{SHA}%s\n' "$GERRIT_DEV_LOGIN" "$(hash "$GERRIT_DEV_PASSWORD")"
  printf '%s:{SHA}%s\n' "$GERRIT_ADMIN_LOGIN" "$(hash "$GERRIT_ADMIN_PASSWORD")"
} > /etc/nginx/htpasswd.api
chmod 644 /etc/nginx/htpasswd.ui /etc/nginx/htpasswd.api

exec nginx -g 'daemon off;'

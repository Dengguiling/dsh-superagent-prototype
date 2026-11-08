#!/usr/bin/env python3
"""The sign-in page of the mock environment (env/login/server.py).

The two systems of the environment have no sign-in form of their own:

  * Redmine has one, but a person would have to type the credentials again
    every time the session is gone.
  * The front end of the review server (nginx) answers a request without a
    credential with the challenge of the HTTP basic authentication.  The
    browser asks for it in a dialog, and the web UI of Gerrit reads all of
    its data in the background, where a challenge is never shown.

This service is the way in: one page with one button per role.  A click signs
the person in and opens the system.

  * Gerrit: the credential of the role is stored in the cookie `dsh_auth`
    ("Basic base64(user:password)").  The front end of the review server
    hands that credential over instead of asking the browser again (see
    gerrit/nginx.conf), so the session of the browser does not expire.
  * Redmine: the service signs in against the login form of Redmine, takes
    the session cookie `_redmine_session` out of the answer and hands it to
    the browser.  The session of Redmine is long (30 days, see
    redmine/init.rb).

Only the standard library of Python 3 is used, so the image needs nothing
but `python:3.12-alpine`.
"""

import base64
import html
import json
import os
import re
import string
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# the configuration of the environment
# ---------------------------------------------------------------------------


def read_env_file(path):
    """The values of the .env file of the environment, as a dict.

    The file is the source of truth for the ports and the credentials of the
    stack.  Inside the container the same values arrive in the environment,
    so the file is only the fallback of a run outside of compose.
    """
    values = {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return values


ENV_FILE = read_env_file(os.path.join(HERE, os.pardir, ".env"))


def setting(name, default=""):
    """A setting of the environment: the environment wins over the .env."""
    return os.environ.get(name) or ENV_FILE.get(name, default)


PORT = int(setting("SIGNIN_PORT", "3001"))

# the cookies of the sign-in live as long as the session of Redmine
MAX_AGE = 60 * 60 * 24 * 30

# the addresses the browser uses ...
REDMINE_URL = setting("SIGNIN_REDMINE_URL", "http://localhost:3000").rstrip("/")
GERRIT_URL = setting("SIGNIN_GERRIT_URL", "http://localhost:8080").rstrip("/")
# The address of the review server inside the compose network; the probe asks
# Gerrit itself whether it recognises an account in the browser.
GERRIT_INTERNAL = setting("SIGNIN_GERRIT_INTERNAL_URL", "http://gerrit:8080").rstrip("/")
# ... and the ones the service uses inside the compose network
REDMINE_INTERNAL = setting("SIGNIN_REDMINE_INTERNAL_URL", "http://redmine:3000").rstrip("/")

# the three roles of the environment; the key is used in the URL of the
# sign-in, the label is what the page shows
ROLES = (
    ("admin", "Administrator"),
    ("lead", "Leader"),
    ("dev", "Developer"),
)

# what a role does in a system: the leader assigns the work in the task
# system and merges the patches in the review server, the developer takes the
# work and pushes the patches
ROLE_NOTES = {
    "redmine": {
        "admin": "the system manager, the highest rights",
        "lead": "assigns the work to the developer",
        "dev": "takes the work; the superagent helps",
    },
    "gerrit": {
        "admin": "the system manager, the highest rights",
        "lead": "reviews and merges the patches",
        "dev": "pushes the patches",
    },
}

ROLE_LABELS = {key: label for key, label in ROLES}


def account(prefix, key):
    """The login, the password and the e-mail of a role, from the environment."""
    name = key.upper()
    return (
        setting(f"{prefix}_{name}_LOGIN"),
        setting(f"{prefix}_{name}_PASSWORD"),
        setting(f"{prefix}_{name}_EMAIL"),
    )


REDMINE_ACCOUNTS = {key: account("REDMINE", key) for key, _ in ROLES}
GERRIT_ACCOUNTS = {key: account("GERRIT", key) for key, _ in ROLES}


def role_of(accounts, login):
    """The role of a login, or None when the login is not one of them."""
    if not login:
        return None
    for key, (name, _password, _mail) in accounts.items():
        if name and name == login:
            return key
    # Gerrit identifies an account in the browser by its e-mail address, when
    # the account carries no external id of its own (see gerrit_credential).
    for key, (name, _password, mail) in accounts.items():
        if mail and mail == login:
            return key
    return None


# ---------------------------------------------------------------------------
# the credential the browser uses at the review server
# ---------------------------------------------------------------------------

# Gerrit 2.15 in "auth.type = HTTP" mode takes the identity from the request
# and looks the account up by the external id "gerrit:<login>".  Only the
# accounts that its own login flow created carry that id, so only they are
# recognised in the browser by their login; the other accounts are recognised
# by their e-mail address.  The cookie carries the credential that the browser
# is recognised by, and the front end hands it over (see gerrit/nginx.conf).
GERRIT_CREDENTIALS = {}


def gerrit_credential(login, password, mail):
    """The credential the browser uses for a Gerrit account.

    The answer of the login page tells whether Gerrit recognised the account:
    it sends a browser that is signed in away from the login page, and refuses
    one that it could not look up.
    """
    key = f"{login}:{password}"
    if key not in GERRIT_CREDENTIALS:
        GERRIT_CREDENTIALS[key] = _probe_gerrit(login, password, mail)
    return GERRIT_CREDENTIALS[key]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Keeps the answer of the redirect, so the probe sees its status."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _probe_gerrit(login, password, mail):
    request = urllib.request.Request(f"{GERRIT_INTERNAL}/login/")
    request.add_header("Authorization", "Basic " + base64.b64encode(f"{login}:{password}".encode()).decode())
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=15) as answer:
            code = answer.status
    except urllib.error.HTTPError as error:
        code = error.code
    except OSError:
        # the review server did not answer: keep the credential of the login
        return f"{login}:{password}"
    if code in (200, 301, 302, 303, 307, 308):
        return f"{login}:{password}"
    # Gerrit could not look the account up by its login: the browser uses the
    # e-mail address, which Gerrit accepts as the identity of the account.
    return f"{mail}:{password}" if mail else f"{login}:{password}"


# ---------------------------------------------------------------------------
# the HTTP client (the standard library only)
# ---------------------------------------------------------------------------

USER_AGENT = "dsh-superagent-signin/1.0"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is an answer here, not something to follow.

    The sign-in needs the `Set-Cookie` of the answer of Redmine, and a
    redirect would swallow it.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def request(url, data=None, headers=None, timeout=20):
    """A plain HTTP request; returns (status, headers, body)."""
    req = urllib.request.Request(url, data=data, headers=headers or {})
    req.add_header("User-Agent", USER_AGENT)
    try:
        with OPENER.open(req, timeout=timeout) as answer:
            return answer.status, answer.headers, answer.read()
    except urllib.error.HTTPError as exc:
        # a 3xx is an answer here, not an error
        return exc.code, exc.headers, exc.read()
    except (urllib.error.URLError, OSError) as exc:
        raise RuntimeError(f"{url}: {exc}") from exc


def cookie_value(headers, name):
    """The value of a cookie out of the `Set-Cookie` headers of an answer."""
    for header in headers.get_all("Set-Cookie") or []:
        first = header.split(";", 1)[0].strip()
        key, _, value = first.partition("=")
        if key.strip() == name:
            return value.strip()
    return None


# ---------------------------------------------------------------------------
# Redmine
# ---------------------------------------------------------------------------

AUTHENTICITY_TOKEN = re.compile(r'name="authenticity_token"\s+value="([^"]+)"')
LOGGED_IN_AS = re.compile(r"Logged in as\s*<a[^>]*>([^<]+)</a>")
FLASH_ERROR = re.compile(r'id="flash_error"[^>]*>(.*?)</div>', re.S)


def redmine_sign_in(login, password):
    """Sign in at the login form of Redmine and return its session cookie.

    Redmine has no API for the session of a browser, so the form is used the
    way a person would use it: read the form, send the credentials back.
    The answer carries the session cookie `_redmine_session`, which is the
    session of the person in Redmine.

    Raises RuntimeError when Redmine refuses the credentials.
    """
    status, headers, body = request(REDMINE_INTERNAL + "/login")
    page = body.decode("utf-8", "replace")
    token = AUTHENTICITY_TOKEN.search(page)
    if status != 200 or not token:
        raise RuntimeError(f"Redmine answered the login form with {status}")
    session = cookie_value(headers, "_redmine_session")
    if not session:
        raise RuntimeError("Redmine handed out no session")

    data = urllib.parse.urlencode(
        {
            "username": login,
            "password": password,
            "authenticity_token": token.group(1),
            "back": "/",
        }
    ).encode("utf-8")

    status, headers, body = request(
        REDMINE_INTERNAL + "/login",
        data=data,
        headers={
            "Cookie": f"_redmine_session={session}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": REDMINE_INTERNAL + "/login",
        },
    )
    if status not in (301, 302, 303, 307, 308):
        # a refused credential is answered with the form again and the reason
        # in the flash
        reason = FLASH_ERROR.search(body.decode("utf-8", "replace"))
        if reason:
            raise RuntimeError(re.sub(r"\s+", " ", reason.group(1)).strip())
        raise RuntimeError(f"Redmine answered {status}")

    # the answer of a sign-in carries the new session of the person
    return cookie_value(headers, "_redmine_session") or session


def redmine_login_of(session):
    """The login of the person behind a session cookie of Redmine."""
    if not session:
        return None
    status, _headers, body = request(
        REDMINE_INTERNAL + "/users/current",
        headers={"Cookie": f"_redmine_session={session}"},
    )
    if status != 200:
        # an expired or an unknown session is answered with the login form
        return None
    found = LOGGED_IN_AS.search(body.decode("utf-8", "replace"))
    return found.group(1).strip() if found else None


# ---------------------------------------------------------------------------
# the page
# ---------------------------------------------------------------------------

STYLE = """
:root {
  color-scheme: light dark;
  --bg: #f4f6f8;
  --card: #ffffff;
  --fg: #15191e;
  --muted: #5b6572;
  --line: #dfe4ea;
  --accent: #1f6feb;
  --accent-fg: #ffffff;
  --ok-bg: #e4f6ea;
  --ok-fg: #14683c;
  --warn-bg: #fdecec;
  --warn-fg: #a41f1f;
  --shadow: 0 1px 2px rgba(16,24,40,.06), 0 10px 28px rgba(16,24,40,.07);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216;
    --card: #171b21;
    --fg: #e8ebef;
    --muted: #98a2ae;
    --line: #272e36;
    --accent: #5b9dff;
    --accent-fg: #0a0e13;
    --ok-bg: #14321f;
    --ok-fg: #6fe6a3;
    --warn-bg: #3a1c1c;
    --warn-fg: #ff9d9d;
    --shadow: 0 1px 2px rgba(0,0,0,.45), 0 10px 28px rgba(0,0,0,.35);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: clamp(1rem, 4vw, 2.5rem) 1rem 3rem;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        "Helvetica Neue", Arial, "Noto Sans", sans-serif;
  -webkit-text-size-adjust: 100%;
}
.wrap { max-width: 46rem; margin: 0 auto; }
h1 { font-size: clamp(1.5rem, 5vw, 1.9rem); margin: 0 0 .35rem; letter-spacing: -.01em; }
.lede { margin: 0 0 1.5rem; color: var(--muted); max-width: 38rem; }
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
  padding: 1.1rem 1.1rem 1.25rem;
  margin-bottom: 1.25rem;
}
.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: .5rem 1rem;
  margin-bottom: 1rem;
}
.card-head h2 { font-size: 1.15rem; margin: 0; }
.sub { margin: .15rem 0 0; color: var(--muted); font-size: .9rem; }
.sub a { color: inherit; }
.state { margin: 0; font-size: .9rem; color: var(--muted); }
.state strong { color: var(--fg); }
.state .signout { color: var(--muted); text-decoration: underline; }
.state .signout:hover { color: var(--fg); }
.chip {
  display: inline-block;
  padding: .1rem .5rem;
  border-radius: 999px;
  font-size: .8rem;
  font-weight: 600;
  background: var(--ok-bg);
  color: var(--ok-fg);
}
.chip.off { background: var(--line); color: var(--muted); font-weight: 500; }
.roles { display: grid; gap: .6rem; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); }
.role {
  display: flex;
  flex-direction: column;
  gap: .15rem;
  padding: .7rem .85rem;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: transparent;
  color: var(--fg);
  text-decoration: none;
  transition: border-color .12s ease, background-color .12s ease;
}
.role:hover { border-color: var(--accent); background: rgba(127,127,127,.06); }
.role:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.role-label { font-weight: 650; }
.role-note { color: var(--muted); font-size: .85rem; }
.role-login { color: var(--muted); font-size: .78rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.role.current { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.role.current .role-label::after {
  content: " · signed in";
  color: var(--accent);
  font-weight: 600;
  font-size: .8rem;
}
.banner {
  border-radius: 10px;
  padding: .7rem .9rem;
  margin-bottom: 1.25rem;
  background: var(--warn-bg);
  color: var(--warn-fg);
  border: 1px solid currentColor;
}
footer { color: var(--muted); font-size: .85rem; margin-top: 1.5rem; }
footer a { color: inherit; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
@media (max-width: 30rem) {
  .roles { grid-template-columns: 1fr; }
  .card { padding: .9rem .85rem 1rem; }
}
"""

PAGE = string.Template(
    """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in - dsh-superagent environment</title>
<link rel="icon" href="data:,">
<style>$style</style>
</head>
<body>
<main class="wrap">
  <h1>Sign in</h1>
  <p class="lede">Choose a role and the system opens with it in a new tab, so
  this page stays open. The sign-in is remembered by the browser, so a session
  that is gone does not mean typing a password again.</p>
  $banner
  $cards
  <footer>
    The sign-in of the review server is kept in the cookie
    <code>dsh_auth</code> as <code>Basic base64(user:password)</code> - a
    convenience of this local mock, not a secret store. The sign-in of
    Redmine is its own session cookie
    <code>_redmine_session</code>.
  </footer>
</main>
<script>
  // The systems open in another tab, so this page keeps the state of the
  // sessions: it asks who is signed in and marks the role.
  const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character])

  const stateText = (system, role, label) => role
    ? 'Signed in as <strong>' + escapeHtml(label) + '</strong> <span class="chip">' +
      escapeHtml(role) + '</span> &middot; <a class="signout" href="/signout?system=' +
      escapeHtml(system) + '">sign out</a>'
    : 'Nobody is signed in'

  const refresh = async () => {
    let who
    try {
      const answer = await fetch('/whoami', { headers: { accept: 'application/json' } })
      if (!answer.ok) return
      who = await answer.json()
    } catch { return }
    for (const system of ['redmine', 'gerrit']) {
      const card = document.querySelector('[data-system="' + system + '"]')
      if (!card) continue
      const role = (who[system] && who[system].role) || null
      const label = (who[system] && who[system].role_label) || role
      const state = card.querySelector('.state')
      if (state) {
        const text = stateText(system, role, label)
        // only when it changed, so a click on "sign out" is never in the way
        if (state.dataset.text !== text) { state.dataset.text = text; state.innerHTML = text }
      }
      for (const button of card.querySelectorAll('.role')) {
        button.classList.toggle('current', button.dataset.role === role)
      }
    }
  }

  refresh()
  setInterval(refresh, 5000)
</script>
</body>
</html>
"""
)


def role_button(system, key, label, note, login, current):
    """One role of a system: the button that signs in and opens it.

    The system opens in a new tab, so this page stays open and the person does
    not have to come back to it to switch the role of the other system.
    """
    active = " current" if current == key else ""
    return (
        f'<a class="role{active}" href="/signin/{system}?role={key}" '
        f'data-role="{html.escape(key)}" target="_blank" rel="noopener">'
        f'<span class="role-label">{html.escape(label)}</span>'
        f'<span class="role-note">{html.escape(note)}</span>'
        f'<span class="role-login">{html.escape(login or key)}</span>'
        "</a>"
    )


def state_html(system, role):
    """Who is signed in for a system; the page keeps it in the same shape."""
    if not role:
        return "Nobody is signed in"
    return (
        f"Signed in as <strong>{html.escape(ROLE_LABELS.get(role, role))}</strong>"
        f' <span class="chip">{html.escape(role)}</span>'
        f' &middot; <a class="signout" href="/signout?system={html.escape(system)}">'
        f"sign out</a>"
    )


def system_card(system, title, subtitle, url, accounts, current):
    """One system of the page: its three roles and who is signed in."""
    buttons = "".join(
        role_button(system, key, label, ROLE_NOTES[system][key], accounts[key][0], current)
        for key, label in ROLES
    )
    state = f'<p class="state">{state_html(system, current)}</p>'
    return (
        f'<section class="card" data-system="{html.escape(system)}">'
        '<div class="card-head"><div>'
        f"<h2>{html.escape(title)}</h2>"
        f'<p class="sub">{html.escape(subtitle)} &middot; '
        f'<a href="{html.escape(url)}/">{html.escape(url)}/</a></p>'
        "</div>" + state + "</div>"
        f'<div class="roles">{buttons}</div>'
        "</section>"
    )


def render_page(state, error=None):
    """The page: both systems, their roles and who is signed in."""
    cards = "".join(
        [
            system_card(
                "redmine",
                "Redmine",
                "task tracker",
                REDMINE_URL,
                REDMINE_ACCOUNTS,
                state["redmine"]["role"],
            ),
            system_card(
                "gerrit",
                "Gerrit",
                "code review",
                GERRIT_URL,
                GERRIT_ACCOUNTS,
                state["gerrit"]["role"],
            ),
        ]
    )
    banner = ""
    if error:
        banner = f'<p class="banner">{html.escape(error)}</p>'
    return PAGE.substitute(style=STYLE, banner=banner, cards=cards)


# ---------------------------------------------------------------------------
# the service
# ---------------------------------------------------------------------------


class SignIn(BaseHTTPRequestHandler):
    """The sign-in page and the sign-in itself."""

    server_version = "dsh-signin/1.0"
    protocol_version = "HTTP/1.1"

    # -- the state of the browser ------------------------------------------

    def cookies_of(self):
        """The cookies the browser sent, as a dict."""
        raw = self.headers.get("Cookie") or ""
        cookies = {}
        for part in raw.split(";"):
            key, _, value = part.strip().partition("=")
            if key:
                cookies[key.strip()] = value.strip()
        return cookies

    def state(self):
        """The role that is signed in per system, read from the cookies."""
        cookies = self.cookies_of()

        gerrit_login = None
        raw = cookies.get("dsh_auth")
        if raw:
            payload = raw.split(" ", 1)[-1]
            try:
                padded = payload + "=" * (-len(payload) % 4)
                gerrit_login = (
                    base64.b64decode(padded).decode("utf-8").split(":")[0]
                )
            except (ValueError, UnicodeDecodeError):
                gerrit_login = None
        gerrit_role = role_of(GERRIT_ACCOUNTS, gerrit_login)

        redmine_role = None
        redmine_login = None
        session = cookies.get("_redmine_session")
        if session:
            try:
                redmine_login = redmine_login_of(session)
            except RuntimeError as exc:
                self.log_message("redmine: %s", exc)
            redmine_role = role_of(REDMINE_ACCOUNTS, redmine_login)

        return {
            "redmine": {
                "signed_in": bool(redmine_role),
                "role": redmine_role,
                "role_label": ROLE_LABELS.get(redmine_role),
                "login": redmine_login,
            },
            "gerrit": {
                "signed_in": bool(gerrit_role),
                "role": gerrit_role,
                "role_label": ROLE_LABELS.get(gerrit_role),
                "login": gerrit_login if gerrit_role else None,
            },
        }

    # -- the answers --------------------------------------------------------

    def send_body(self, status, body, content_type, headers=()):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_html(self, status, page, headers=()):
        self.send_body(status, page.encode("utf-8"), "text/html; charset=utf-8", headers)

    def send_json(self, status, data):
        body = json.dumps(data, indent=2).encode("utf-8")
        self.send_body(status, body, "application/json; charset=utf-8")

    def redirect(self, location, headers=()):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()

    # -- the requests -------------------------------------------------------

    def do_GET(self):
        target = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(target.query)
        role = (query.get("role") or [""])[0]

        if target.path == "/":
            self.send_html(200, render_page(self.state(), (query.get("error") or [None])[0]))
        elif target.path == "/whoami":
            self.send_json(200, self.state())
        elif target.path == "/signin/gerrit":
            self.signin_gerrit(role)
        elif target.path == "/signin/redmine":
            self.signin_redmine(role)
        elif target.path == "/signout":
            self.signout((query.get("system") or [""])[0])
        else:
            self.send_html(404, render_page(self.state(), "This page does not exist."))

    # -- the sign-in --------------------------------------------------------

    def system_url(self, base):
        """The address of a system, on the host the person used.

        A cookie belongs to its host, and the browser sends it to every port of
        that host.  The sign-in therefore opens the system on the very host the
        page was opened with, so the cookie of the sign-in is sent there.
        """
        parsed = urllib.parse.urlparse(base)
        host = (self.headers.get("Host") or "").split(":")[0]
        if not host:
            return base
        return f"{parsed.scheme}://{host}:{parsed.port}"

    def signin_gerrit(self, role):
        """Sign in at the review server.

        The credential of the role is put into the cookie `dsh_auth`; the
        front end of the review server hands it over to Gerrit instead of
        asking the browser again (see gerrit/nginx.conf).
        """
        account = GERRIT_ACCOUNTS.get(role)
        if not account or not account[0]:
            self.send_html(404, render_page(self.state(), f"Unknown role: {role}"))
            return
        login, password, mail = account
        # Two cookies: the credential of the role for the API of the review
        # server, and the credential the browser is recognised by for its web
        # UI (see gerrit/nginx.conf).
        value = "Basic " + base64.b64encode(f"{login}:{password}".encode()).decode()
        browser = "Basic " + base64.b64encode(
            gerrit_credential(login, password, mail).encode()
        ).decode()
        self.redirect(
            self.system_url(GERRIT_URL) + "/",
            headers=[
                (
                    "Set-Cookie",
                    f"dsh_auth={value}; Path=/; Max-Age={MAX_AGE}; HttpOnly; SameSite=Lax",
                ),
                (
                    "Set-Cookie",
                    f"dsh_web={browser}; Path=/; Max-Age={MAX_AGE}; HttpOnly; SameSite=Lax",
                ),
            ],
        )

    def signin_redmine(self, role):
        """Sign in at Redmine.

        The service signs in against the login form of Redmine and hands the
        session cookie of the answer to the browser, so the session of the
        person survives.
        """
        account = REDMINE_ACCOUNTS.get(role)
        if not account or not account[0]:
            self.send_html(404, render_page(self.state(), f"Unknown role: {role}"))
            return
        login, password, _mail = account
        try:
            session = redmine_sign_in(login, password)
        except RuntimeError as exc:
            self.log_message("redmine refused the sign-in: %s", exc)
            self.redirect(
                "/?error=" + urllib.parse.quote(f"Redmine refused the sign-in: {exc}")
            )
            return
        self.redirect(
            self.system_url(REDMINE_URL) + "/",
            headers=[
                (
                    "Set-Cookie",
                    f"_redmine_session={session}; Path=/; Max-Age={MAX_AGE}; HttpOnly; SameSite=Lax",
                )
            ],
        )

    def signout(self, system):
        """Forget the session of a system."""
        names = {
            "redmine": ["_redmine_session"],
            "gerrit": ["dsh_auth", "dsh_web"],
        }.get(system, ["_redmine_session", "dsh_auth"])
        headers = [
            ("Set-Cookie", f"{name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
            for name in names
        ]
        self.redirect("/", headers=headers)

    # -- the log ------------------------------------------------------------

    def log_message(self, fmt, *args):
        print(f"[signin] {self.address_string()} {fmt % args}", flush=True)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), SignIn)
    print(f"[signin] listening on :{PORT}", flush=True)
    print(f"[signin] redmine {REDMINE_URL} (internal {REDMINE_INTERNAL})", flush=True)
    print(f"[signin] gerrit  {GERRIT_URL}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

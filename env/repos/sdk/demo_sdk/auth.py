"""Access-token handling of the Demo SDK."""

import time

from .errors import AuthError

# Refresh an access token this many seconds before it expires so that a request
# cannot leave with a token that dies in flight.
EXPIRY_SKEW_SECONDS = 60


class TokenStore:
    """Caches the OAuth access token and fetches a fresh one when needed.

    ``fetch_token`` is a callable returning ``(token, expires_in_seconds)``; the
    store calls it whenever the cached token cannot be used.  ``clock`` is
    replaceable so that the expiry logic is testable without sleeping.
    """

    def __init__(self, fetch_token, clock=time.time):
        self._fetch_token = fetch_token
        self._clock = clock
        self._token = None
        self._expires_at = 0.0

    def get_token(self):
        """The token to send with the next request."""
        if self._token is None or self._is_expired():
            self._refresh()
        token = self._token
        if token is None:
            raise AuthError("the token store holds no token")
        return token

    def invalidate(self):
        """Forget the cached token, e.g. after the API answered 401."""
        self._token = None
        self._expires_at = 0.0

    def _is_expired(self):
        return self._clock() >= self._expires_at

    def _refresh(self):
        token, expires_in = self._fetch_token()
        if not token:
            raise AuthError("the token endpoint returned an empty access token")
        self._token = token
        self._expires_at = self._clock() + float(expires_in)

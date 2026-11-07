import pytest

from demo_sdk.auth import TokenStore
from demo_sdk.errors import AuthError


class Clock:
    def __init__(self, now=0.0):
        self.now = now

    def __call__(self):
        return self.now


def test_fetches_a_token_on_first_use():
    store = TokenStore(lambda: ("token-1", 300), clock=Clock())
    assert store.get_token() == "token-1"


def test_reuses_a_valid_token():
    clock = Clock()
    calls = []

    def fetch():
        calls.append(1)
        return ("token-1", 300)

    store = TokenStore(fetch, clock=clock)
    assert store.get_token() == "token-1"
    clock.now = 120
    assert store.get_token() == "token-1"
    assert len(calls) == 1


def test_refreshes_an_expired_token():
    clock = Clock()
    tokens = iter([("token-1", 10), ("token-2", 300)])
    store = TokenStore(lambda: next(tokens), clock=clock)
    assert store.get_token() == "token-1"
    clock.now = 11
    assert store.get_token() == "token-2"


def test_invalidate_forces_a_refresh():
    tokens = iter([("token-1", 300), ("token-2", 300)])
    store = TokenStore(lambda: next(tokens), clock=Clock())
    assert store.get_token() == "token-1"
    store.invalidate()
    assert store.get_token() == "token-2"


def test_rejects_an_empty_token():
    store = TokenStore(lambda: ("", 300), clock=Clock())
    with pytest.raises(AuthError):
        store.get_token()

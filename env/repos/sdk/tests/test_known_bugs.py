"""Reproduction tests for the defects tracked in the Redmine project `sdk`.

They are marked ``xfail``: the defects are open, so every test fails against the
current code.  Fixing a defect makes its test pass (an ``XPASS``, which the
suite tolerates) and the corresponding issue can be closed.

The module names the file a defect lives in, so it doubles as the reproduction
command of the issue.
"""

import pytest

from demo_sdk.auth import EXPIRY_SKEW_SECONDS, TokenStore
from demo_sdk.pagination import Paginator
from demo_sdk.retry import RetryPolicy

pytestmark = pytest.mark.xfail(reason="known defect, see the Redmine project `sdk`", strict=False)


class FakeClient:
    def __init__(self, pages, total):
        self.pages = pages
        self.total = total

    def get(self, path, params=None):
        page = params["page"]
        return {"items": list(self.pages.get(page, [])), "total": self.total}


class FakeResponse:
    def __init__(self, status_code):
        self.status_code = status_code


def test_paginator_returns_the_partial_last_page():
    # 250 items with a page size of 100: three pages, the last one holds 50 items.
    client = FakeClient({1: ["."] * 100, 2: ["."] * 100, 3: ["."] * 50}, total=250)
    assert len(list(Paginator(client, "/things", page_size=100))) == 250


def test_client_errors_are_not_retried():
    policy = RetryPolicy(max_attempts=3, base_delay=0)
    assert policy.should_retry(0, response=FakeResponse(400)) is False
    assert policy.should_retry(0, response=FakeResponse(404)) is False


def test_token_is_refreshed_before_it_expires():
    now = [0.0]
    fetched = []

    def fetch():
        fetched.append(1)
        return ("token-%d" % len(fetched), 300)

    store = TokenStore(fetch, clock=lambda: now[0])
    assert store.get_token() == "token-1"
    # Fewer than EXPIRY_SKEW_SECONDS seconds of validity left: the cached token
    # must be replaced before a request is sent with it.
    now[0] = 300 - EXPIRY_SKEW_SECONDS + 1
    assert store.get_token() == "token-2"

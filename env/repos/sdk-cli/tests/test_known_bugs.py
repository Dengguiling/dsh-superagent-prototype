"""Reproduction test for the defect tracked in the Redmine project `sdk-cli`.

It is marked ``xfail``: the defect is open, so the test fails against the
current code.  Fixing the defect makes it pass (an ``XPASS``, which the suite
tolerates) and the issue can be closed.
"""

import pytest

from sdk_cli.main import build_client, build_parser

pytestmark = pytest.mark.xfail(reason="known defect, see the Redmine project `sdk-cli`", strict=False)


def test_timeout_is_forwarded_to_the_api_client():
    args = build_parser().parse_args(["--timeout", "5", "get", "/projects"])
    assert build_client(args).timeout == 5.0

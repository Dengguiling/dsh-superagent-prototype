import pytest

from demo_sdk.retry import RetryPolicy


class FakeResponse:
    def __init__(self, status_code):
        self.status_code = status_code


def test_retries_transient_status_codes():
    policy = RetryPolicy(max_attempts=3, base_delay=0)
    for status in (408, 429, 500, 502, 503, 504):
        assert policy.should_retry(0, response=FakeResponse(status)) is True


def test_does_not_retry_a_success():
    policy = RetryPolicy(max_attempts=3, base_delay=0)
    assert policy.should_retry(0, response=FakeResponse(200)) is False


def test_gives_up_after_the_last_attempt():
    policy = RetryPolicy(max_attempts=3, base_delay=0)
    assert policy.should_retry(1, response=FakeResponse(503)) is True
    assert policy.should_retry(2, response=FakeResponse(503)) is False


def test_retries_transport_errors():
    policy = RetryPolicy(max_attempts=2, base_delay=0)
    assert policy.should_retry(0, error=ConnectionError("boom")) is True
    assert policy.should_retry(1, error=ConnectionError("boom")) is False


def test_backoff_doubles_and_is_capped():
    policy = RetryPolicy(max_attempts=5, base_delay=0.25, max_delay=1.0)
    assert [policy.delay_for(attempt) for attempt in range(4)] == [0.25, 0.5, 1.0, 1.0]


def test_rejects_a_useless_policy():
    with pytest.raises(ValueError):
        RetryPolicy(max_attempts=0)

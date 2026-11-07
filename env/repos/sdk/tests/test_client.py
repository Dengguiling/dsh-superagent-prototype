import pytest

from demo_sdk.auth import TokenStore
from demo_sdk.client import Client, Response
from demo_sdk.errors import ApiError, TransportError
from demo_sdk.retry import RetryPolicy


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def send(self, method, url, headers=None, body=None, timeout=None):
        self.calls.append(
            {"method": method, "url": url, "headers": headers or {}, "body": body, "timeout": timeout}
        )
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def make_client(transport, **kwargs):
    kwargs.setdefault("retry_policy", RetryPolicy(max_attempts=3, base_delay=0))
    kwargs.setdefault("sleep", lambda delay: None)
    return Client("https://api.test/v1", transport=transport, **kwargs)


def test_get_returns_the_json_payload():
    transport = FakeTransport(Response(200, body=b'{"items": [], "total": 0}'))
    assert make_client(transport).get("/things") == {"items": [], "total": 0}
    assert transport.calls[0]["url"] == "https://api.test/v1/things"
    assert transport.calls[0]["timeout"] == 30.0


def test_query_parameters_are_encoded():
    transport = FakeTransport(Response(200, body=b"{}"))
    make_client(transport).get("/things", params={"q": "a b", "page": 2})
    assert transport.calls[0]["url"] == "https://api.test/v1/things?q=a+b&page=2"


def test_bearer_token_is_sent():
    transport = FakeTransport(Response(200, body=b"{}"))
    client = make_client(transport, token_store=TokenStore(lambda: ("token-1", 300)))
    client.get("/things")
    assert transport.calls[0]["headers"]["Authorization"] == "Bearer token-1"


def test_retries_a_transient_error():
    transport = FakeTransport(Response(503), Response(200, body=b'{"ok": true}'))
    assert make_client(transport).get("/things") == {"ok": True}
    assert len(transport.calls) == 2


def test_retries_a_transport_failure():
    transport = FakeTransport(TransportError("connection reset"), Response(200, body=b"{}"))
    assert make_client(transport).get("/things") == {}
    assert len(transport.calls) == 2


def test_raises_api_error_on_a_client_error():
    transport = FakeTransport(Response(409, body=b'{"message": "already exists"}'))
    client = make_client(transport)
    with pytest.raises(ApiError) as raised:
        client.get("/things")
    assert raised.value.status_code == 409
    assert raised.value.message == "already exists"
    assert len(transport.calls) == 1

from sdk_cli.api import ApiClient


class FakeResponse:
    def __init__(self, body):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def read(self):
        return self._body


def test_get_forwards_the_timeout(monkeypatch):
    seen = {}

    def fake_urlopen(request, timeout=None):
        seen["timeout"] = timeout
        seen["url"] = request.full_url
        return FakeResponse(b'{"ok": true}')

    monkeypatch.setattr("sdk_cli.api.urllib_request.urlopen", fake_urlopen)
    client = ApiClient("https://api.test/v1", timeout=7.5)
    assert client.get("/projects", params={"page": 2}) == {"ok": True}
    assert seen["timeout"] == 7.5
    assert seen["url"] == "https://api.test/v1/projects?page=2"


def test_bearer_token_is_sent(monkeypatch):
    seen = {}

    def fake_urlopen(request, timeout=None):
        seen["headers"] = dict(request.header_items())
        return FakeResponse(b"{}")

    monkeypatch.setattr("sdk_cli.api.urllib_request.urlopen", fake_urlopen)
    ApiClient("https://api.test/v1", token="secret").get("/projects")
    assert seen["headers"]["Authorization"] == "Bearer secret"

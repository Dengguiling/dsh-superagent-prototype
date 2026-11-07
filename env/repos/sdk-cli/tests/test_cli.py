import json

from sdk_cli.api import ApiClient
from sdk_cli.main import build_client, build_parser, main


class FakeClient:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def get(self, path):
        self.calls.append(path)
        return self.payload


def test_parses_the_get_command():
    args = build_parser().parse_args(["--base-url", "https://api.test/v1", "get", "/projects"])
    assert args.base_url == "https://api.test/v1"
    assert args.path == "/projects"


def test_timeout_has_a_default():
    args = build_parser().parse_args(["get", "/projects"])
    assert args.timeout == 30.0


def test_builds_an_api_client():
    args = build_parser().parse_args(["--token", "secret", "get", "/projects"])
    client = build_client(args)
    assert isinstance(client, ApiClient)
    assert client.base_url == "https://api.demo.example/v1"
    assert client.token == "secret"


def test_prints_the_json_answer(monkeypatch, capsys):
    client = FakeClient({"items": []})
    monkeypatch.setattr("sdk_cli.main.build_client", lambda parsed: client)
    assert main(["--base-url", "https://api.test/v1", "get", "/projects"]) == 0
    assert json.loads(capsys.readouterr().out) == {"items": []}
    assert client.calls == ["/projects"]

from demo_sdk.pagination import Paginator


class FakeClient:
    def __init__(self, pages, total):
        self.pages = pages
        self.total = total
        self.calls = []

    def get(self, path, params=None):
        self.calls.append(dict(params or {}))
        page = params["page"]
        return {"items": list(self.pages.get(page, [])), "total": self.total}


def test_iterates_all_items_of_a_collection():
    client = FakeClient({1: ["a", "b"], 2: ["c", "d"]}, total=4)
    assert list(Paginator(client, "/things", page_size=2)) == ["a", "b", "c", "d"]


def test_stops_after_the_only_page():
    client = FakeClient({1: ["a", "b"]}, total=2)
    assert list(Paginator(client, "/things", page_size=2)) == ["a", "b"]
    assert [call["page"] for call in client.calls] == [1]


def test_forwards_the_base_parameters():
    client = FakeClient({1: []}, total=0)
    list(Paginator(client, "/things", params={"kind": "demo"}, page_size=10))
    assert client.calls[0]["kind"] == "demo"
    assert client.calls[0]["per_page"] == 10


def test_empty_collection():
    client = FakeClient({}, total=0)
    assert list(Paginator(client, "/things")) == []

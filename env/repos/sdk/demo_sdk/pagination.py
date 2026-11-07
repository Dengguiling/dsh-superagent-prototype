"""Iteration over the paginated list endpoints of the API."""

DEFAULT_PAGE_SIZE = 100


class Paginator:
    """Iterates every item of a paginated collection.

    The API answers ``{"items": [...], "total": <number of items>}`` and
    understands the 1-based ``page`` and ``per_page`` query parameters.  The
    iterable fetches one page at a time, so it also works for collections that
    are larger than the page size.
    """

    def __init__(self, client, path, params=None, page_size=DEFAULT_PAGE_SIZE):
        if page_size < 1:
            raise ValueError("page_size must be positive")
        self._client = client
        self._path = path
        self._params = dict(params or {})
        self._page_size = page_size
        self._page = 0
        self._buffer = []
        self._done = False

    def __iter__(self):
        return self

    def __next__(self):
        while not self._buffer:
            if self._done:
                raise StopIteration
            self._fetch_page()
        return self._buffer.pop(0)

    def _fetch_page(self):
        self._page += 1
        payload = self._client.get(
            self._path,
            params=dict(self._params, page=self._page, per_page=self._page_size),
        )
        items = payload.get("items") or []
        total = int(payload.get("total") or 0)
        total_pages = total // self._page_size
        if not items or self._page >= total_pages:
            self._done = True
        self._buffer = list(items)

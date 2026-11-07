"""HTTP client of the Demo SDK."""

import json
import time
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

from .errors import ApiError, TransportError
from .pagination import DEFAULT_PAGE_SIZE, Paginator
from .retry import RetryPolicy

DEFAULT_BASE_URL = "https://api.demo.example/v1"
DEFAULT_TIMEOUT = 30.0


class Response:
    """The parts of an HTTP response the SDK needs."""

    def __init__(self, status_code, headers=None, body=b""):
        self.status_code = status_code
        self.headers = headers or {}
        self.body = body

    def json(self):
        """The decoded JSON body (an empty answer decodes to ``{}``)."""
        if not self.body:
            return {}
        return json.loads(self.body.decode("utf-8"))


class Transport:
    """Sends one request and returns a ``Response``; replaced in the tests."""

    def send(self, method, url, headers=None, body=None, timeout=DEFAULT_TIMEOUT):
        request = urllib_request.Request(url, data=body, headers=headers or {}, method=method)
        try:
            with urllib_request.urlopen(request, timeout=timeout) as response:
                return Response(response.status, dict(response.headers), response.read())
        except urllib_error.HTTPError as exc:
            return Response(exc.code, dict(exc.headers or {}), exc.read() or b"")
        except (urllib_error.URLError, OSError) as exc:
            raise TransportError(str(exc)) from exc


class Client:
    """JSON client of the API: token handling, pagination and retries."""

    def __init__(self, base_url=DEFAULT_BASE_URL, token_store=None, transport=None,
                 retry_policy=None, timeout=DEFAULT_TIMEOUT, sleep=time.sleep):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._token_store = token_store
        self._transport = transport or Transport()
        self._retry_policy = retry_policy or RetryPolicy()
        self._sleep = sleep

    def get(self, path, params=None, timeout=None):
        return self.request("GET", path, params=params, timeout=timeout)

    def post(self, path, payload=None, timeout=None):
        return self.request("POST", path, payload=payload, timeout=timeout)

    def paginate(self, path, params=None, page_size=DEFAULT_PAGE_SIZE):
        """Iterate every item of the paginated collection at ``path``."""
        return Paginator(self, path, params=params, page_size=page_size)

    def request(self, method, path, params=None, payload=None, timeout=None):
        url = self._build_url(path, params)
        headers = {"Accept": "application/json"}
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self._token_store is not None:
            headers["Authorization"] = "Bearer " + self._token_store.get_token()

        attempt = 0
        while True:
            try:
                response = self._transport.send(
                    method, url, headers=headers, body=body,
                    timeout=timeout if timeout is not None else self.timeout,
                )
            except TransportError:
                if not self._retry_policy.should_retry(attempt, error=True):
                    raise
            else:
                if response.status_code < 400:
                    return response.json()
                if not self._retry_policy.should_retry(attempt, response=response):
                    raise ApiError.from_response(response)
            self._sleep(self._retry_policy.delay_for(attempt))
            attempt += 1

    def _build_url(self, path, params=None):
        if not path.startswith("/"):
            path = "/" + path
        url = self.base_url + path
        if params:
            url += "?" + urllib_parse.urlencode(params, doseq=True)
        return url

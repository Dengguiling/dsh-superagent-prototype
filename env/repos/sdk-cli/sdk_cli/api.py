"""Minimal HTTP client used by the CLI."""

import json
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

DEFAULT_TIMEOUT = 30.0


class ApiClientError(Exception):
    """The API could not be reached or answered with an error."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class ApiClient:
    """One JSON REST client; ``timeout`` bounds a single request in seconds."""

    def __init__(self, base_url, token=None, timeout=DEFAULT_TIMEOUT):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def get(self, path, params=None):
        url = self.base_url + path
        if params:
            url += "?" + urllib_parse.urlencode(params, doseq=True)
        request = urllib_request.Request(url, headers=self._headers())
        try:
            with urllib_request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib_error.HTTPError as exc:
            raise ApiClientError("HTTP %s for %s" % (exc.code, url), exc.code) from exc
        except (urllib_error.URLError, OSError) as exc:
            raise ApiClientError("could not reach %s: %s" % (url, exc)) from exc

    def _headers(self):
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        return headers

# demo-sdk

Python client of the Demo platform API.

| module | what it does |
|--------|--------------|
| `demo_sdk.client` | `Client`: JSON requests, bearer token, pagination, retries |
| `demo_sdk.pagination` | `Paginator`: iterates a paginated collection item by item |
| `demo_sdk.retry` | `RetryPolicy`: when to retry and how long to wait |
| `demo_sdk.auth` | `TokenStore`: caches the OAuth access token and refreshes it |
| `demo_sdk.errors` | the exception hierarchy |

```python
from demo_sdk import Client, TokenStore

client = Client("https://api.example.test/v1", token_store=TokenStore(fetch_token))
for project in client.paginate("/projects"):
    print(project["name"])
```

## Development

```bash
python3 -m pip install -e ".[test]"
python3 -m pytest
```

## Known defects

The defects of the open issues of the Redmine project `sdk` are reproduced by
the `xfail` tests in [`tests/test_known_bugs.py`](tests/test_known_bugs.py):

| area | file | symptom |
|------|------|---------|
| pagination | `demo_sdk/pagination.py` (`Paginator._fetch_page`) | the partial last page is dropped |
| retries | `demo_sdk/retry.py` (`RETRYABLE_STATUS`) | 4xx answers are retried as well |
| auth | `demo_sdk/auth.py` (`TokenStore._is_expired`) | a token is used until it expires instead of being refreshed ahead of time |

# sdk-cli

Command line front end of the Demo platform API.  A thin `argparse` wrapper
around a small HTTP client, so operators can query the API from a shell.

```bash
python3 -m sdk_cli --base-url https://api.example.test/v1 --token "$TOKEN" get /projects
```

The options are global, the command comes last: `get` prints the JSON answer of
the path it is given.  `--timeout` bounds one request in seconds (default 30).

## Development

```bash
python3 -m pip install -e ".[test]"
python3 -m pytest
```

## Known defects

The defect of the open issue of the Redmine project `sdk-cli` is reproduced by
the `xfail` test in [`tests/test_known_bugs.py`](tests/test_known_bugs.py):

| area | file | symptom |
|------|------|---------|
| CLI | `sdk_cli/main.py` (`build_client`) | `--timeout` is parsed but never forwarded to the API client |

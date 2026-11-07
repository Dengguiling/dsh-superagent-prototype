"""Command line entry point of the Demo platform API."""

import argparse
import json
import sys

from .api import DEFAULT_TIMEOUT, ApiClient, ApiClientError

DEFAULT_BASE_URL = "https://api.demo.example/v1"


def build_parser():
    parser = argparse.ArgumentParser(prog="sdk-cli", description="Talk to the Demo platform API.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="base URL of the API")
    parser.add_argument("--token", default=None, help="OAuth access token")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT,
                        help="request timeout in seconds (default: %(default)s)")
    commands = parser.add_subparsers(dest="command", required=True)
    get = commands.add_parser("get", help="GET a path and print the JSON answer")
    get.add_argument("path", help="path of the API resource, e.g. /projects")
    return parser


def build_client(args):
    """The API client for the parsed command line."""
    return ApiClient(base_url=args.base_url, token=args.token)


def main(argv=None):
    args = build_parser().parse_args(argv)
    client = build_client(args)
    try:
        payload = client.get(args.path)
    except ApiClientError as error:
        print("sdk-cli: %s" % error, file=sys.stderr)
        return 1
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

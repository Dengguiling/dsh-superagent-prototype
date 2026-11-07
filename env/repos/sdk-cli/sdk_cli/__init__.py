"""Command line front end of the Demo platform API."""

from .api import ApiClient, ApiClientError

__version__ = "0.9.0"

__all__ = ["ApiClient", "ApiClientError"]

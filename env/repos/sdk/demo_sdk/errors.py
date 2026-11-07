"""Exception hierarchy of the Demo SDK."""


class DemoSDKError(Exception):
    """Base class of every error the SDK raises."""


class TransportError(DemoSDKError):
    """The request could not be sent or no response was received."""


class AuthError(DemoSDKError):
    """The SDK could not obtain an access token."""


class ApiError(DemoSDKError):
    """The API answered with a non-success status code."""

    def __init__(self, status_code, message="", payload=None):
        text = "HTTP %s" % status_code
        if message:
            text = "%s: %s" % (text, message)
        super().__init__(text)
        self.status_code = status_code
        self.message = message
        self.payload = payload or {}

    @classmethod
    def from_response(cls, response):
        """Build the error from a ``Response`` of the HTTP layer."""
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        message = payload.get("message", "") if isinstance(payload, dict) else ""
        return cls(response.status_code, message, payload)

"""Retry policy of the Demo SDK."""

DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_BASE_DELAY = 0.5
DEFAULT_MAX_DELAY = 8.0

# The answers that are worth another attempt.  The platform rate-limits with
# 429 and moves shards with 503, both are transient.
RETRYABLE_STATUS = frozenset({400, 404, 408, 429, 500, 502, 503, 504})


class RetryPolicy:
    """Decides whether a failed request is attempted again and how long to wait.

    ``max_attempts`` counts the first request, so a value of 3 means at most two
    retries.  The delay doubles with every attempt and is capped at
    ``max_delay`` seconds.
    """

    def __init__(self, max_attempts=DEFAULT_MAX_ATTEMPTS, base_delay=DEFAULT_BASE_DELAY,
                 max_delay=DEFAULT_MAX_DELAY):
        if max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        if base_delay < 0 or max_delay < 0:
            raise ValueError("the delays must not be negative")
        self.max_attempts = max_attempts
        self.base_delay = base_delay
        self.max_delay = max_delay

    def should_retry(self, attempt, response=None, error=None):
        """True when the request with the zero-based ``attempt`` number may be sent again."""
        if attempt >= self.max_attempts - 1:
            return False
        if error is not None:
            return True
        return response is not None and response.status_code in RETRYABLE_STATUS

    def delay_for(self, attempt):
        """The backoff before the retry that follows the given attempt."""
        return min(self.base_delay * (2 ** attempt), self.max_delay)

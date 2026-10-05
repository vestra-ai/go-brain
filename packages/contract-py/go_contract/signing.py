"""Sign and check the request that opens the socket from go-server to go-brain.

go-server signs GET /v1/socket with this header. Everything after that travels on the open socket
and is not signed again:

    x-go-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, signing string)>

The signing string is four parts joined by a newline:

    <t>\\n<METHOD>\\n<target>\\n<raw body>

METHOD is upper case. target is the path plus the query string exactly as sent. raw body is the
exact bytes sent, or nothing when there is no body (the socket has none). The signature is good for
300 seconds, and go-brain accepts each one once. Both sides share one secret, GO_SIGNING_SECRET.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from dataclasses import dataclass
from typing import Literal

SIGNATURE_HEADER = "x-go-signature"
MAX_SKEW_SECONDS = 300

Reason = Literal["missing", "malformed", "stale", "mismatch"]


@dataclass(frozen=True)
class Verified:
    ok: bool
    reason: Reason | None = None


def _bytes(body: bytes | str) -> bytes:
    return body.encode("utf-8") if isinstance(body, str) else body


def _mac(secret: str, t: int, method: str, target: str, body: bytes) -> bytes:
    if not secret:
        raise ValueError("GO_SIGNING_SECRET is empty")
    message = f"{t}\n{method.upper()}\n{target}\n".encode("utf-8") + body
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).digest()


def sign_request(method: str, target: str, body: bytes | str, secret: str, now: int | None = None) -> str:
    """The value for the x-go-signature header."""
    t = int(time.time()) if now is None else now
    return f"t={t},v1={_mac(secret, t, method, target, _bytes(body)).hex()}"


def verify_request(
    method: str, target: str, body: bytes | str, header: str | None, secret: str, now: int | None = None
) -> Verified:
    if not header:
        return Verified(False, "missing")
    fields = {}
    for part in header.split(","):
        key, sep, value = part.partition("=")
        if sep:
            fields[key.strip()] = value.strip()
    t_raw, v1 = fields.get("t", ""), fields.get("v1", "")
    if not re.fullmatch(r"-?\d+", t_raw) or not re.fullmatch(r"[0-9a-f]{64}", v1):
        return Verified(False, "malformed")
    t = int(t_raw)
    current = int(time.time()) if now is None else now
    if abs(current - t) > MAX_SKEW_SECONDS:
        return Verified(False, "stale")
    expected = _mac(secret, t, method, target, _bytes(body))
    if not hmac.compare_digest(expected, bytes.fromhex(v1)):
        return Verified(False, "mismatch")
    return Verified(True)

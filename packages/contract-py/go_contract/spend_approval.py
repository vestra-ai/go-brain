"""The signed spend approval: the Server's half of the two keys.

The Server runs the spend check and signs the claims with its Ed25519 private key. Go's vault
pays only with a valid, unexpired, unused approval and the payer's own passkey.

Wire format (a compact JWS):
    base64url(header JSON) "." base64url(claims JSON) "." base64url(Ed25519 signature over the first two parts)
with the header exactly {"alg":"EdDSA","typ":"go-spend+jws"}.
"""

from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass
from typing import Any, Literal

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_private_key, load_pem_public_key
from pydantic import ValidationError

from .models import SpendApprovalClaims

MAX_APPROVAL_TTL_SECONDS = 600
ALLOWED_CLOCK_SKEW_SECONDS = 30
HEADER = {"alg": "EdDSA", "typ": "go-spend+jws"}

Reason = Literal["malformed", "bad_signature", "invalid_claims", "expired", "not_yet_valid"]


@dataclass(frozen=True)
class VerifiedApproval:
    ok: bool
    claims: dict[str, Any] | None = None
    reason: Reason | None = None


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _compact(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _claims_problem(claims: dict[str, Any]) -> str | None:
    try:
        SpendApprovalClaims.model_validate(claims)
    except ValidationError as e:
        return str(e)
    if claims["amount_minor"] <= 0:
        return "amount_minor must be more than zero"
    if not (claims["exp"] > claims["iat"] and claims["exp"] - claims["iat"] <= MAX_APPROVAL_TTL_SECONDS):
        return f"exp must be after iat and at most {MAX_APPROVAL_TTL_SECONDS} seconds later"
    return None


def sign_spend_approval(claims: dict[str, Any], private_key_pem: str) -> str:
    """Sign claims (a plain dict, serialised in its own key order) with the Server's Ed25519 key."""
    problem = _claims_problem(claims)
    if problem:
        raise ValueError(problem)
    key = load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("the spend approval key must be Ed25519")
    signing_input = f"{_b64(_compact(HEADER))}.{_b64(_compact(claims))}"
    return f"{signing_input}.{_b64(key.sign(signing_input.encode('ascii')))}"


def verify_spend_approval(token: str, public_key_pem: str, now: int | None = None) -> VerifiedApproval:
    parts = token.split(".")
    if len(parts) != 3 or any(not p or not all(c.isalnum() or c in "-_" for c in p) for p in parts):
        return VerifiedApproval(False, reason="malformed")
    head, body, sig = parts
    try:
        header = json.loads(_unb64(head))
        claims = json.loads(_unb64(body))
        signature = _unb64(sig)
    except ValueError:
        return VerifiedApproval(False, reason="malformed")
    if header != HEADER or not isinstance(claims, dict):
        return VerifiedApproval(False, reason="malformed")
    key = load_pem_public_key(public_key_pem.encode("utf-8"))
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("the spend approval key must be Ed25519")
    try:
        key.verify(signature, f"{head}.{body}".encode("ascii"))
    except InvalidSignature:
        return VerifiedApproval(False, reason="bad_signature")
    if _claims_problem(claims):
        return VerifiedApproval(False, reason="invalid_claims")
    current = int(time.time()) if now is None else now
    if claims["iat"] > current + ALLOWED_CLOCK_SKEW_SECONDS:
        return VerifiedApproval(False, reason="not_yet_valid")
    if claims["exp"] <= current:
        return VerifiedApproval(False, reason="expired")
    return VerifiedApproval(True, claims=claims)

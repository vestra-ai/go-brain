"""The Go contract for Python: models for every body, plus request signing and spend approvals.

    from go_contract import models, sign_request, verify_request
    event = models.Event.model_validate_json(raw_body).root
"""

from . import models
from .card import Card
from .signing import MAX_SKEW_SECONDS, SIGNATURE_HEADER, Verified, sign_request, verify_request
from .spend_approval import (
    MAX_APPROVAL_TTL_SECONDS,
    VerifiedApproval,
    sign_spend_approval,
    verify_spend_approval,
)

CONTRACT_VERSION = "1.0.0"

__all__ = [
    "CONTRACT_VERSION",
    "Card",
    "MAX_APPROVAL_TTL_SECONDS",
    "MAX_SKEW_SECONDS",
    "SIGNATURE_HEADER",
    "Verified",
    "VerifiedApproval",
    "models",
    "sign_request",
    "sign_spend_approval",
    "verify_request",
    "verify_spend_approval",
]

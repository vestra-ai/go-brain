"""The Go contract for Python: models for every body, plus request signing and spend approvals.

    from go_contract import METHODS, models, sign_request
    method = METHODS["open_vote"]            # who sends it, its params and result models
    params = method.params.model_validate(frame["params"])
"""

from . import models
from .card import Card
from .socket_methods import METHODS, Method
from .signing import MAX_SKEW_SECONDS, SIGNATURE_HEADER, Verified, sign_request, verify_request
from .spend_approval import (
    MAX_APPROVAL_TTL_SECONDS,
    VerifiedApproval,
    sign_spend_approval,
    verify_spend_approval,
)

CONTRACT_VERSION = "1.2.0"

__all__ = [
    "CONTRACT_VERSION",
    "Card",
    "METHODS",
    "Method",
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

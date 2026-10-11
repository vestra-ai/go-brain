import base64
import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from go_contract import sign_spend_approval, verify_spend_approval


@pytest.fixture
def v(vectors_dir):
    return json.loads((vectors_dir / "spend-approval.json").read_text())


def test_reproduces_the_shared_token_exactly(v):
    assert sign_spend_approval(v["claims"], v["private_key_pem"]) == v["token"]


def test_verifies_the_shared_token(v):
    r = verify_spend_approval(v["token"], v["public_key_pem"], now=v["verify_at"])
    assert r.ok and r.claims == v["claims"]


def test_refuses_expired_and_future(v):
    assert verify_spend_approval(v["token"], v["public_key_pem"], now=v["claims"]["exp"]).reason == "expired"
    assert verify_spend_approval(v["token"], v["public_key_pem"], now=v["claims"]["iat"] - 31).reason == "not_yet_valid"


def test_refuses_another_key_and_tampering(v):
    other = Ed25519PrivateKey.generate().public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    assert verify_spend_approval(v["token"], other, now=v["verify_at"]).reason == "bad_signature"
    head, _, sig = v["token"].split(".")
    forged = base64.urlsafe_b64encode(json.dumps({**v["claims"], "amount_minor": 99999999}).encode()).rstrip(b"=").decode()
    assert verify_spend_approval(f"{head}.{forged}.{sig}", v["public_key_pem"], now=v["verify_at"]).reason == "bad_signature"


def test_will_not_sign_for_longer_than_ten_minutes(v):
    with pytest.raises(ValueError):
        sign_spend_approval({**v["claims"], "exp": v["claims"]["iat"] + 601}, v["private_key_pem"])


def test_refuses_garbage(v):
    assert verify_spend_approval("not.a.token!", v["public_key_pem"]).reason == "malformed"


# Contract 1.3 (G3): a person's own pick. The Server signs `personal` in place of decision_id; that person pays.
_PICK = {"person_id": "p_meher", "card_id": "c_flights_meher", "option_id": "opt_flight_2"}


def _personal(v, **over):
    claims = {k: x for k, x in v["claims"].items() if k != "decision_id"}
    claims.update({"personal": dict(_PICK), "payer_person_id": "p_meher"})
    claims.update(over)
    return claims


def test_signs_and_verifies_a_personal_approval(v):
    token = sign_spend_approval(_personal(v), v["private_key_pem"])
    r = verify_spend_approval(token, v["public_key_pem"], now=v["verify_at"])
    assert r.ok and r.claims["personal"] == _PICK and r.claims["payer_person_id"] == "p_meher"


def test_will_not_sign_a_personal_approval_another_pays_or_one_naming_a_vote_too(v):
    with pytest.raises(ValueError):
        sign_spend_approval(_personal(v, payer_person_id="p_rahul"), v["private_key_pem"])
    with pytest.raises(ValueError):
        sign_spend_approval(_personal(v, decision_id="d_villa"), v["private_key_pem"])
    with pytest.raises(ValueError):
        sign_spend_approval({k: x for k, x in v["claims"].items() if k != "decision_id"}, v["private_key_pem"])

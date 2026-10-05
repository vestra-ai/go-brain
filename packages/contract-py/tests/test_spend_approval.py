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

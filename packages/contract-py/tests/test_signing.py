import json

from go_contract import sign_request, verify_request


def load(vectors_dir):
    return json.loads((vectors_dir / "signing.json").read_text())


def test_matches_every_shared_vector(vectors_dir):
    v = load(vectors_dir)
    for c in v["cases"]:
        assert sign_request(c["method"], c["target"], c["body"], v["secret"], now=v["t"]) == c["header"], c["name"]
        assert verify_request(c["method"], c["target"], c["body"], c["header"], v["secret"], now=v["t"] + 10).ok


def test_signs_bytes_the_same_as_text(vectors_dir):
    v = load(vectors_dir)
    c = v["cases"][2]
    assert sign_request(c["method"], c["target"], c["body"].encode("utf-8"), v["secret"], now=v["t"]) == c["header"]


def test_refuses_changes_to_body_route_or_method(vectors_dir):
    v = load(vectors_dir)
    c = v["cases"][0]
    s, t = v["secret"], v["t"]
    assert verify_request("POST", c["target"], c["body"] + " ", c["header"], s, now=t).reason == "mismatch"
    assert verify_request("POST", "/v1/links", c["body"], c["header"], s, now=t).reason == "mismatch"
    assert verify_request("PUT", c["target"], c["body"], c["header"], s, now=t).reason == "mismatch"
    assert verify_request("POST", c["target"], c["body"], c["header"], "another-secret", now=t).reason == "mismatch"


def test_refuses_stale_missing_and_malformed(vectors_dir):
    v = load(vectors_dir)
    c = v["cases"][0]
    s, t = v["secret"], v["t"]
    assert verify_request("POST", c["target"], c["body"], c["header"], s, now=t + 301).reason == "stale"
    assert verify_request("POST", c["target"], c["body"], None, s, now=t).reason == "missing"
    assert verify_request("POST", c["target"], c["body"], "t=abc,v1=zz", s, now=t).reason == "malformed"

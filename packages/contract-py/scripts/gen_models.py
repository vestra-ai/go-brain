"""Writes go_contract/models.py from the contract's OpenAPI file.

The zod schemas in packages/contract are the source of truth. This script reads the OpenAPI file
generated from them, relaxes a few constraints that would otherwise turn plain strings and numbers
into wrapper classes in Python (string lengths inside lists, and limits on fields that may be null), and
runs datamodel-code-generator. Go still checks every constraint on its side.

Run from packages/contract-py:  python scripts/gen_models.py
CI runs it and fails if models.py changed.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SOURCE = HERE.parent / "contract" / "openapi" / "go.json"
METHODS = HERE.parent / "contract" / "socket" / "methods.json"
METHODS_OUT = HERE / "go_contract" / "socket_methods.py"
OUT = HERE / "go_contract" / "models.py"
KEEP = {"type", "format", "const", "enum", "description"}
JS_MAX_SAFE = 9007199254740991


def is_plain(node: dict) -> bool:
    return not any(k in node for k in ("$ref", "properties", "anyOf", "oneOf", "items"))


def _loosen(branch: dict) -> dict:
    if is_plain(branch):
        return {k: v for k, v in branch.items() if k in KEEP and not (k == "format" and v == "uri")}
    if branch.get("type") == "array":
        return {k: v for k, v in branch.items() if k in KEEP | {"items"}}
    return branch


def relax(node):
    if isinstance(node, list):
        for item in node:
            relax(item)
        return
    if not isinstance(node, dict):
        return
    if node.get("maximum") == JS_MAX_SAFE:
        del node["maximum"]
    if node.get("format") == "uri":
        # Links stay plain strings in Python (http or https only), not pydantic URL objects.
        del node["format"]
        node["pattern"] = "^https?://"

    items = node.get("items")
    if isinstance(items, dict) and is_plain(items):
        node["items"] = {k: v for k, v in items.items() if k in KEEP}
    any_of = node.get("anyOf")
    if isinstance(any_of, list) and len(any_of) == 2 and {"type": "null"} in any_of:
        node["anyOf"] = [_loosen(branch) for branch in any_of]
    for value in node.values():
        relax(value)


def main() -> None:
    doc = json.loads(SOURCE.read_text())
    relax(doc)
    with tempfile.TemporaryDirectory() as tmp:
        relaxed = Path(tmp) / "go-contract.json"
        relaxed.write_text(json.dumps(doc))
        subprocess.run(
            [
                "datamodel-codegen",
                "--input", str(relaxed),
                "--input-file-type", "openapi",
                "--output", str(OUT),
                "--output-model-type", "pydantic_v2.BaseModel",
                "--target-python-version", "3.11",
                "--use-annotated",
                "--field-constraints",
                "--use-standard-collections",
                "--use-union-operator",
                "--use-double-quotes",
                "--disable-timestamp",
                "--enum-field-as-literal", "all",
                "--use-schema-description",
                "--use-field-description",
                "--collapse-root-models",
                "--formatters", "black", "isort",
                "--custom-file-header", "# Generated from packages/contract/openapi/go.json by scripts/gen_models.py. Do not edit.",
            ],
            check=True,
        )
    table = json.loads(METHODS.read_text())
    lines = [
        "# Generated from packages/contract/socket/methods.json by scripts/gen_models.py. Do not edit.",
        '"""Every socket method: who sends it, its params model and its result model (None for a notification)."""',
        "",
        "from typing import NamedTuple",
        "",
        "from . import models",
        "",
        "",
        "class Method(NamedTuple):",
        "    name: str",
        "    direction: str  # to_go: the server sends it. to_server: Go sends it and the server answers.",
        "    params: type",
        "    result: type | None",
        "    answer_within_seconds: int | None",
        "    sends_event: str | None",
        "",
        "",
        f"PATH = {table['path']!r}",
        "METHODS: dict[str, Method] = {",
    ]
    for x in table["methods"]:
        result = f"models.{x['result']}" if x["result"] else "None"
        lines.append(
            f"    {x['name']!r}: Method({x['name']!r}, {x['direction']!r}, models.{x['params']}, {result}, "
            f"{x['answer_within_seconds']!r}, {x['sends_event']!r}),"
        )
    lines.append("}")
    METHODS_OUT.write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT} and {METHODS_OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()

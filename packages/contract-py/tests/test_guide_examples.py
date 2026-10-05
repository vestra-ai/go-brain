"""Every JSON example in docs/guide marked <!-- schema: Name --> must also load into the Python model."""

import re

from go_contract import models

MARKER = re.compile(r"<!--\s*schema:\s*([A-Za-z]+)\s*-->\s*```json\n(.*?)```", re.S)


def test_every_guide_example_loads_into_its_python_model(guide_dir):
    checked = 0
    for path in sorted(guide_dir.glob("*.md")):
        for name, body in MARKER.findall(path.read_text()):
            model = getattr(models, name)
            model.model_validate_json(body)
            checked += 1
    assert checked > 0

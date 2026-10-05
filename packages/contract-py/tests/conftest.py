from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="session")
def vectors_dir() -> Path:
    return ROOT / "packages" / "contract" / "test-vectors"


@pytest.fixture(scope="session")
def guide_dir() -> Path:
    return ROOT / "docs" / "guide"

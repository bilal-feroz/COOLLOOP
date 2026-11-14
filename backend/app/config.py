"""Runtime settings from environment variables (see `.env.example`)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

from .facility import Location

ROOT = Path(__file__).resolve().parents[2]


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "") or default)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    meteomatics_username: str = ""
    meteomatics_password: str = ""
    meteomatics_base_url: str = "https://api.meteomatics.com"
    meteomatics_source: str = "mix"
    site: Location = field(default_factory=Location)
    forecast_hours: int = 168
    history_hours: int = 24
    forecast_ttl_s: int = 900
    history_ttl_s: int = 3600
    quota_ttl_s: int = 600
    retry_after_error_s: int = 120
    anthropic_api_key: str = ""
    llm_model: str = "claude-opus-5-5"
    data_dir: Path = ROOT / "backend" / "data"

    @property
    def meteomatics_configured(self) -> bool:
        return bool(self.meteomatics_username and self.meteomatics_password)

    @property
    def llm_configured(self) -> bool:
        return bool(self.anthropic_api_key)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    load_dotenv(ROOT / ".env")
    # An empty key in .env must not shadow other Anthropic credential sources.
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        if os.environ.get(name, None) == "":
            del os.environ[name]
    return Settings(
        meteomatics_username=os.getenv("METEOMATICS_USERNAME", "").strip(),
        meteomatics_password=os.getenv("METEOMATICS_PASSWORD", "").strip(),
        meteomatics_base_url=(
            os.getenv("METEOMATICS_BASE_URL", "").strip() or "https://api.meteomatics.com"
        ).rstrip("/"),
        meteomatics_source=os.getenv("METEOMATICS_SOURCE", "").strip() or "mix",
        site=Location(
            name=os.getenv("SITE_NAME", "").strip() or "Abu Dhabi, UAE",
            lat=_float("SITE_LAT", 24.4539),
            lon=_float("SITE_LON", 54.3773),
            utc_offset_hours=_float("SITE_UTC_OFFSET_HOURS", 4.0),
        ),
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", "").strip(),
        llm_model=os.getenv("COOLLOOP_LLM_MODEL", "").strip() or "claude-opus-5-5",
        data_dir=Path(os.getenv("COOLLOOP_DATA_DIR", "") or ROOT / "backend" / "data"),
    )

"""Runtime settings from environment variables (see `.env.example`)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from dotenv import dotenv_values

from .facility import Location

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env"


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


def env_file_mtime() -> float | None:
    try:
        return ENV_FILE.stat().st_mtime
    except OSError:
        return None


def load_settings() -> Settings:
    """Read the settings now. Values in `.env` win over the process
    environment when they are not empty, so the file can be edited while the
    backend runs."""
    file_values = {k: v.strip() for k, v in dotenv_values(ENV_FILE).items() if v and v.strip()}
    env = {**os.environ, **file_values}

    def text(name: str, default: str = "") -> str:
        return (env.get(name) or "").strip() or default

    def number(name: str, default: float) -> float:
        try:
            return float(text(name) or default)
        except ValueError:
            return default

    # The Anthropic SDK reads its credentials from the process environment.
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        if name in file_values:
            os.environ[name] = file_values[name]
        elif os.environ.get(name) == "":
            del os.environ[name]  # an empty key must not shadow other credential sources

    return Settings(
        meteomatics_username=text("METEOMATICS_USERNAME"),
        meteomatics_password=text("METEOMATICS_PASSWORD"),
        meteomatics_base_url=text("METEOMATICS_BASE_URL", "https://api.meteomatics.com").rstrip("/"),
        meteomatics_source=text("METEOMATICS_SOURCE", "mix"),
        site=Location(
            name=text("SITE_NAME", "Abu Dhabi, UAE"),
            lat=number("SITE_LAT", 24.4539),
            lon=number("SITE_LON", 54.3773),
            utc_offset_hours=number("SITE_UTC_OFFSET_HOURS", 4.0),
        ),
        anthropic_api_key=text("ANTHROPIC_API_KEY"),
        llm_model=text("COOLLOOP_LLM_MODEL", "claude-opus-5-5"),
        data_dir=Path(text("COOLLOOP_DATA_DIR") or ROOT / "backend" / "data"),
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return load_settings()

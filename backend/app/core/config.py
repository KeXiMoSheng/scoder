"""应用配置：从环境变量（.env）读取，保持轻量。"""

import os
from dataclasses import dataclass
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    debug: bool
    cors_origins: list[str]


@lru_cache
def get_settings() -> Settings:
    origins = os.environ.get("CORS_ORIGINS", "*")
    return Settings(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "39200")),
        debug=os.environ.get("DEBUG", "true").lower() in {"1", "true", "yes"},
        cors_origins=[o.strip() for o in origins.split(",") if o.strip()] or ["*"],
    )

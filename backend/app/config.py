import os, re
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


ROOT_ENV = Path(__file__).resolve().parents[2] / ".env"


def clean_postgres_url(url: str) -> str:
    if not url:
        return url

    # 1. Convert driver scheme to asyncpg
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+asyncpg://", 1)
    elif url.startswith("postgresql://") and not url.startswith("postgresql+asyncpg://"):
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1)

    # 2. asyncpg rejects 'sslmode', it expects 'ssl'
    url = re.sub(r"([?&])sslmode=([^&]*)", r"\1ssl=\2", url)

    # 3. asyncpg rejects 'channel_binding'
    url = re.sub(r"[?&]channel_binding=[^&]*", "", url)

    # 4. Clean up any broken query string separators
    if "?" not in url and "&" in url:
        url = url.replace("&", "?", 1)
    url = re.sub(r"\?&", "?", url)
    url = url.rstrip("?&")
    return url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT_ENV,
        extra="ignore",
        env_ignore_empty=True,
    )
    environment: str = "production"
    database_url: str = "postgresql+asyncpg://relay:relay@localhost:5432/relay"
    redis_url: str = "redis://localhost:6379/0"
    frontend_origin: str = ""
    secure_cookies: bool = True
    session_days: int = 14
    s3_endpoint: str = "http://localhost:9000"
    s3_access_key: str = "relay-local"
    s3_secret_key: str = "relay-local-secret"
    s3_bucket: str = "relay-private"
    max_upload_bytes: int = 10 * 1024 * 1024
    ai_api_key: str = ""
    gemini_api_key: str = ""
    google_api_key: str = ""
    postgres: str = ""
    rediskey: str = ""
    ai_demo_mode: bool = False
    ai_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai"
    ai_model: str = "gemini-2.5-flash"
    ai_tts_model: str = "gemini-2.5-flash-preview-tts"
    ai_daily_limit: int = 50
    ai_timeout_seconds: int = 60
    ai_context_chars: int = 24000

    def model_post_init(self, __context):
        # Resolve AI API key from AI_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY
        resolved_key = (
            self.ai_api_key
            or self.gemini_api_key
            or self.google_api_key
            or os.environ.get("AI_API_KEY", "")
            or os.environ.get("GEMINI_API_KEY", "")
            or os.environ.get("GOOGLE_API_KEY", "")
        )
        self.ai_api_key = resolved_key.strip()

        # If a real API key is configured, disable demo mode automatically
        if self.ai_api_key:
            self.ai_demo_mode = False

        # Resolve database URL from DATABASE_URL or postgres
        db = (
            self.database_url
            if self.database_url != "postgresql+asyncpg://relay:relay@localhost:5432/relay"
            else (self.postgres or os.environ.get("POSTGRES", "") or self.database_url)
        )
        self.database_url = clean_postgres_url(db)
        if self.database_url:
            os.environ["DATABASE_URL"] = self.database_url

        # Resolve Redis URL from REDIS_URL or rediskey
        if self.rediskey and (not self.redis_url or self.redis_url == "redis://localhost:6379/0"):
            self.redis_url = self.rediskey

        if self.frontend_origin:
            self.frontend_origin = self.frontend_origin.rstrip("/")


settings = Settings()


def ai_available() -> bool:
    return bool(settings.ai_api_key or settings.ai_demo_mode)

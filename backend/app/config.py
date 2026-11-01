from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


ROOT_ENV = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT_ENV, extra="ignore")
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
    ai_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai"
    ai_model: str = "gemini-2.5-flash"
    ai_tts_model: str = "gemini-2.5-flash-preview-tts"
    ai_daily_limit: int = 50
    ai_timeout_seconds: int = 60
    ai_context_chars: int = 24000

    def model_post_init(self, __context):
        if self.database_url.startswith("postgres://"):
            self.database_url = self.database_url.replace(
                "postgres://", "postgresql+asyncpg://", 1
            )
        elif self.database_url.startswith("postgresql://") and not self.database_url.startswith(
            "postgresql+asyncpg://"
        ):
            self.database_url = self.database_url.replace(
                "postgresql://", "postgresql+asyncpg://", 1
            )

        if self.frontend_origin:
            self.frontend_origin = self.frontend_origin.rstrip("/")


settings = Settings()

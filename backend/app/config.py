from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    environment: str = "development"
    database_url: str = "postgresql+asyncpg://relay:relay@localhost:5432/relay"
    redis_url: str = "redis://localhost:6379/0"
    frontend_origin: str = "http://localhost:3000"
    secure_cookies: bool = False
    session_days: int = 14
    s3_endpoint: str = "http://localhost:9000"
    s3_access_key: str = "relay-local"
    s3_secret_key: str = "relay-local-secret"
    s3_bucket: str = "relay-private"
    max_upload_bytes: int = 10 * 1024 * 1024
    ai_api_key: str = ""
    ai_base_url: str = "https://api.openai.com/v1"
    ai_model: str = "gpt-4.1-mini"
    ai_daily_limit: int = 50
    ai_timeout_seconds: int = 60
    ai_context_chars: int = 24000

    def model_post_init(self, __context):
        if self.frontend_origin == "*" or (
            self.environment == "production" and not self.secure_cookies
        ):
            raise ValueError(
                "Explicit origin and production Secure cookies are required"
            )


settings = Settings()

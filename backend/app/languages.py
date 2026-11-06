"""Conversation languages supported by Relay voice.

The browser sends a BCP-47 code; anything unknown falls back to the default so a
crafted value can never reach the model prompt. Keep in sync with
frontend/lib/languages.ts.
"""

from .config import settings

LANGUAGES: dict[str, str] = {
    "en-US": "English",
    "en-GB": "English",
    "es-ES": "Spanish",
    "fr-FR": "French",
    "de-DE": "German",
    "it-IT": "Italian",
    "pt-BR": "Portuguese",
    "nl-NL": "Dutch",
    "ar-XA": "Arabic",
    "hi-IN": "Hindi",
    "tr-TR": "Turkish",
    "ru-RU": "Russian",
    "ja-JP": "Japanese",
    "ko-KR": "Korean",
    "cmn-CN": "Mandarin Chinese",
}

DEFAULT_LANGUAGE = "en-US"


def resolve_language(code: str | None) -> tuple[str, str]:
    """Return a supported (code, name) pair for a requested language code."""
    fallback = settings.ai_voice_language if settings.ai_voice_language in LANGUAGES else DEFAULT_LANGUAGE
    code = code if code in LANGUAGES else fallback
    return code, LANGUAGES[code]

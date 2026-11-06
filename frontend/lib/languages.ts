/** Voice conversation languages. Keep in sync with backend/app/languages.py. */
export const VOICE_LANGUAGES = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "es-ES", label: "Español" },
  { code: "fr-FR", label: "Français" },
  { code: "de-DE", label: "Deutsch" },
  { code: "it-IT", label: "Italiano" },
  { code: "pt-BR", label: "Português" },
  { code: "nl-NL", label: "Nederlands" },
  { code: "ar-XA", label: "العربية" },
  { code: "hi-IN", label: "हिन्दी" },
  { code: "tr-TR", label: "Türkçe" },
  { code: "ru-RU", label: "Русский" },
  { code: "ja-JP", label: "日本語" },
  { code: "ko-KR", label: "한국어" },
  { code: "cmn-CN", label: "中文 (普通话)" },
] as const;

export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number]["code"];

export const DEFAULT_VOICE_LANGUAGE: VoiceLanguage = "en-US";
const STORAGE_KEY = "relay_voice_language";

export function isVoiceLanguage(code: unknown): code is VoiceLanguage {
  return VOICE_LANGUAGES.some((l) => l.code === code);
}

/**
 * The language the user chose for voice. Defaults to English: guessing from the
 * browser locale is what made replies come back in unexpected languages.
 */
export function getVoiceLanguage(): VoiceLanguage {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isVoiceLanguage(saved)) return saved;
  } catch {}
  return DEFAULT_VOICE_LANGUAGE;
}

export function setVoiceLanguage(code: VoiceLanguage) {
  try {
    window.localStorage.setItem(STORAGE_KEY, code);
  } catch {}
}

/** BCP-47 tag for browser speech APIs (Web Speech uses zh-CN, not cmn-CN). */
export function browserSpeechLang(code: VoiceLanguage = getVoiceLanguage()) {
  return code === "cmn-CN" ? "zh-CN" : code === "ar-XA" ? "ar-SA" : code;
}

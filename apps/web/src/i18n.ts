import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "@/locales/en/translation.json";
import zh from "@/locales/zh/translation.json";

const LANGUAGE_STORAGE_KEY = "hina-language";
const supportedLanguages = ["zh", "en"];

function getStoredLanguage(): string {
  const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return stored && supportedLanguages.includes(stored) ? stored : "zh";
}

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: getStoredLanguage(),
  fallbackLng: "en",
  showSupportNotice: false,
  interpolation: {
    escapeValue: false,
  },
});

i18n.on("languageChanged", (lng) => {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, lng);
  document.documentElement.lang = lng;
});

document.documentElement.lang = i18n.language;

export default i18n;

import { LOCALES, type Locale, matchLocale, resources } from '@dojohub/i18n';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const stored = (() => {
  try {
    return localStorage.getItem('dojo.locale') as Locale | null;
  } catch {
    return null;
  }
})();

export const initialLocale: Locale =
  stored && LOCALES.includes(stored) ? stored : matchLocale(navigator.languages ?? [navigator.language]);

i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale,
  fallbackLng: 'en-US',
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  returnNull: false,
});
document.documentElement.lang = initialLocale;

export function setLocale(locale: Locale) {
  try {
    localStorage.setItem('dojo.locale', locale);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = locale;
  void i18n.changeLanguage(locale);
}

export default i18n;

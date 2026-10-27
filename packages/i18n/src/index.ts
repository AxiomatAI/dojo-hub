import enGB from '../locales/en-GB/common.json';
import enUS from '../locales/en-US/common.json';
import pl from '../locales/pl/common.json';

export const LOCALES = ['en-US', 'en-GB', 'pl'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en-US';

export const LOCALE_LABELS: Record<Locale, string> = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  pl: 'Polski',
};

export const resources = {
  'en-US': { common: enUS },
  'en-GB': { common: enGB },
  pl: { common: pl },
} as const;

/** Pick the best supported locale from a list of preferences (e.g. navigator.languages). */
export function matchLocale(preferences: readonly string[]): Locale {
  for (const p of preferences) {
    const lower = p.toLowerCase();
    if (lower === 'en-gb' || lower.startsWith('en-gb')) return 'en-GB';
    if (lower.startsWith('pl')) return 'pl';
    if (lower.startsWith('en'))
      return lower === 'en-us'
        ? 'en-US'
        : ['en-au', 'en-nz', 'en-ie', 'en-in', 'en-za'].includes(lower)
          ? 'en-GB'
          : 'en-US';
  }
  return DEFAULT_LOCALE;
}

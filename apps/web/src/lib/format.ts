import i18n from './i18n';

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return i18n.t('common.never');
  const d = typeof value === 'string' ? new Date(value) : value;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return i18n.t('time.justNow');
  if (diff < 3600) return i18n.t('time.minutesAgo', { count: Math.floor(diff / 60) });
  if (diff < 86400) return i18n.t('time.hoursAgo', { count: Math.floor(diff / 3600) });
  if (diff < 86400 * 30) return i18n.t('time.daysAgo', { count: Math.floor(diff / 86400) });
  return formatDate(d);
}

export function formatDate(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(d);
}

export function formatDateTime(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(i18n.language, { notation: n >= 10000 ? 'compact' : 'standard' }).format(n);
}

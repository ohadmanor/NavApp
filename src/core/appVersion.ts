export const BASE_APP_VERSION = '0.5.0';

export function formatVersionDateTimeTag(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}`;
}

export function getAppVersion(): string {
  if (typeof __APP_VERSION__ !== 'undefined' && typeof __APP_VERSION__ === 'string' && __APP_VERSION__.trim()) {
    return __APP_VERSION__.trim();
  }
  return `${BASE_APP_VERSION}.${formatVersionDateTimeTag()}`;
}

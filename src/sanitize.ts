/** Sensitive fields removed at persistence and presentation boundaries. */
const SECRET_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|session(?:[_-]?(?:id|token))?|client[_-]?secret)$/i;
const REDACTED = '[REDACTED]';

/** Remove URL credentials and secret query values without changing SEO parameters. */
export function sanitizeUrl(value: string): string {
  if (!value.includes('@') && !value.includes('?')) return value;
  try {
    const url = new URL(value);
    let changed = Boolean(url.username || url.password);
    url.username = '';
    url.password = '';
    for (const key of new Set(url.searchParams.keys())) {
      if (SECRET_KEY.test(key)) {
        url.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? url.href : value;
  } catch {
    return value;
  }
}

/** Redact URLs embedded in diagnostics as well as header-style secret assignments. */
export function sanitizeText(value: string): string {
  return value
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi, sanitizeUrl)
    .replace(/\b(authorization|proxy-authorization|set-cookie|cookie)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]')
    .replace(/\b(password|passwd|access_token|refresh_token|api_key|client_secret|token)\s*[=:]\s*[^\s,;&?#<>"']+/gi, '$1=[REDACTED]');
}

/**
 * Copy a JSON-like payload for storage or display. Never sanitize the live
 * AuditContext: rules and authenticated requests need the original values.
 */
export function sanitizeForOutput<T>(input: T): T {
  const active = new WeakSet<object>();
  const strings = new Map<string, string>();
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let clean = strings.get(value);
      if (clean === undefined) { clean = sanitizeText(value); strings.set(value, clean); }
      return clean;
    }
    if (value === null || typeof value !== 'object' || value instanceof Date) return value;
    if (active.has(value)) return '[Circular]';
    active.add(value);
    const result = Array.isArray(value)
      ? value.map(visit)
      : Object.fromEntries((value instanceof Error ? [...Object.entries(value), ['name', value.name], ['message', value.message]] : Object.entries(value)).map(([key, item]) => [
          key, SECRET_KEY.test(key) && item != null ? REDACTED : visit(item),
        ]));
    active.delete(value);
    return result;
  };
  return visit(input) as T;
}

import type { CheerioAPI } from 'cheerio';

/** Resolve against the first HTML base without discarding meaningful path/query differences. */
export function documentBase($: CheerioAPI, url: string): string {
  try { return new URL($('base[href]').first().attr('href') ?? '', url).href; }
  catch { return url; }
}

/** HTTP canonical URL identity; fragments do not select a different canonical document. */
export function resolveDocumentUrl(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.hash = '';
    return url.href;
  } catch { return undefined; }
}

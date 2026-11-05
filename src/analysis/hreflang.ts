import type { AuditContext } from '../types.js';
import { resolveDocumentUrl } from './urls.js';
import { registerResettable } from '../rules/registry.js';

export interface HreflangDeclaration {
  hreflang: string;
  href: string;
  source: 'html' | 'header' | 'sitemap';
}

let sitemapAlternates = new WeakMap<NonNullable<AuditContext['sitemapEntries']>, Map<string, HreflangDeclaration[]>>();
registerResettable(() => { sitemapAlternates = new WeakMap(); });

/** Split Link values without splitting commas inside URLs or quoted parameters. */
export function headerAlternates(header: string): HreflangDeclaration[] {
  const parts: string[] = [];
  let start = 0, angle = false, quoted = false;
  for (let i = 0; i < header.length; i++) {
    const char = header[i];
    if (char === '"' && header[i - 1] !== '\\') quoted = !quoted;
    if (!quoted && char === '<') angle = true;
    if (!quoted && char === '>') angle = false;
    if (char === ',' && !angle && !quoted) { parts.push(header.slice(start, i)); start = i + 1; }
  }
  parts.push(header.slice(start));
  return parts.flatMap((part) => {
    const target = part.match(/^\s*<([^>]*)>/)?.[1];
    const params = new Map<string, string>();
    for (const match of part.matchAll(/;\s*([\w-]+)\s*=\s*(?:"([^"]*)"|([^;\s]+))/g)) params.set(match[1].toLowerCase(), match[2] ?? match[3]);
    if (target === undefined || !params.has('hreflang') || !params.get('rel')?.toLowerCase().split(/\s+/).includes('alternate')) return [];
    return [{ href: target.trim(), hreflang: params.get('hreflang')!.trim(), source: 'header' as const }];
  });
}

/** Read all supported declaration methods; retain sources for validation. */
export function readHreflang(context: AuditContext): HreflangDeclaration[] {
  const $ = context.rendered$ ?? context.$;
  const declarations: HreflangDeclaration[] = [];
  $('link[hreflang]').each((_, el) => {
    if (!($(el).attr('rel') ?? '').toLowerCase().split(/\s+/).includes('alternate')) return;
    declarations.push({ hreflang: ($(el).attr('hreflang') ?? '').trim(), href: ($(el).attr('href') ?? '').trim(), source: 'html' });
  });
  declarations.push(...headerAlternates(Object.entries(context.headers).find(([key]) => key.toLowerCase() === 'link')?.[1] ?? ''));
  if (context.sitemapEntries) {
    let byUrl = sitemapAlternates.get(context.sitemapEntries);
    if (!byUrl) {
      byUrl = new Map();
      for (const entry of context.sitemapEntries) {
        if (!entry.alternates?.length || !/^https?:\/\//i.test(entry.loc)) continue;
        const key = resolveDocumentUrl(entry.loc, entry.loc);
        if (key) byUrl.set(key, [...(byUrl.get(key) ?? []), ...entry.alternates.map((alternate) => ({ ...alternate, source: 'sitemap' as const }))]);
      }
      sitemapAlternates.set(context.sitemapEntries, byUrl);
    }
    declarations.push(...(byUrl.get(resolveDocumentUrl(context.url, context.url) ?? context.url) ?? []));
  }
  return declarations;
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'code' });
const scriptNames = new Intl.DisplayNames(['en'], { type: 'script', fallback: 'code' });
const REGIONS = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));

/** Google's language[-Script][-REGION] syntax is case insensitive. */
export function validHreflang(value: string): boolean {
  if (value.toLowerCase() === 'x-default') return true;
  const match = value.match(/^([a-z]{2})(?:-([a-z]{4}))?(?:-([a-z]{2}))?$/i);
  if (!match) return false;
  const language = match[1].toLowerCase();
  if (languageNames.of(language) === language) return false;
  if (match[2]) {
    const script = match[2][0].toUpperCase() + match[2].slice(1).toLowerCase();
    if (scriptNames.of(script) === script) return false;
  }
  return !match[3] || REGIONS.has(match[3].toUpperCase());
}

import type { CheerioAPI } from 'cheerio';
import type { AuditContext } from '../types.js';

/** A declaration applying to the requested search crawler. */
export interface RobotsDeclaration {
  source: string;
  directives: string[];
}

/** Split robots tokens without interpreting a crawler prefix as a directive. */
export function parseRobotsDirectives(content: string): string[] {
  return content.toLowerCase().split(/[,\s]+/).map((token) => token.trim()).filter(Boolean);
}

const VALUED_DIRECTIVES = new Set(['max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after']);

/** Read common and crawler-specific declarations, retaining header prefix scope. */
export function readRobotsDirectives($: CheerioAPI | undefined, headers: Record<string, string> = {}, crawler = 'googlebot') {
  const declarations: RobotsDeclaration[] = [];
  const agent = crawler.toLowerCase();
  if ($) $('meta[name]').each((_, el) => {
    const name = $(el).attr('name')?.toLowerCase();
    if (name === 'robots' || name === agent) {
      declarations.push({ source: `meta[name="${name}"]`, directives: parseRobotsDirectives($(el).attr('content') ?? '') });
    }
  });
  const header = Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-robots-tag')?.[1] ?? '';
  let scope: string | null = null;
  for (const segment of header.split(',')) {
    let value = segment;
    const prefix = /^\s*([a-z][a-z0-9_*-]*)\s*:(.*)$/i.exec(segment);
    if (prefix && !VALUED_DIRECTIVES.has(prefix[1].toLowerCase())) {
      scope = prefix[1].toLowerCase();
      value = prefix[2];
    }
    if (scope === null || scope === agent || scope === '*') {
      const directives = parseRobotsDirectives(value);
      if (directives.length) declarations.push({ source: 'X-Robots-Tag header', directives });
    }
  }
  const directives = declarations.flatMap((declaration) => declaration.directives);
  return {
    declarations, directives,
    noindex: directives.includes('noindex') || directives.includes('none'),
    nofollow: directives.includes('nofollow') || directives.includes('none'),
  };
}

/** Keep source restrictions: removing source noindex in JS cannot assure indexing. */
export function readIndexingDirectives(context: Pick<AuditContext, '$' | 'headers' | 'rendered$'>, crawler = 'googlebot') {
  const raw = readRobotsDirectives(context.$, context.headers, crawler);
  const rendered = context.rendered$ ? readRobotsDirectives(context.rendered$, context.headers, crawler) : undefined;
  return {
    raw, rendered,
    noindex: raw.noindex || rendered?.noindex === true,
    nofollow: raw.nofollow || rendered?.nofollow === true,
  };
}

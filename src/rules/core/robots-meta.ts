import type { AuditContext } from '../../types.js';
import { defineRule, pass, warn } from '../define-rule.js';

export { parseRobotsDirectives } from '../../analysis/robots.js';
import { readRobotsDirectives } from '../../analysis/robots.js';

/**
 * Rule: Check robots meta tag for indexing directives
 *
 * Detects directives like noindex, nofollow, noarchive that may
 * limit search visibility or indexation.
 */
export const robotsMetaRule = defineRule({
  id: 'core-robots-meta',
  name: 'Robots Meta',
  description: 'Checks robots meta tag for indexing directives',
  category: 'core',
  weight: 5,
  run: async (context: AuditContext) => {
    const { $, headers } = context;

    const issues: string[] = [];
    const allDirectives: { source: string; directives: string[] }[] = [];

    // Restrictive directives that limit visibility
    const restrictiveDirectives = [
      'noindex',
      'nofollow',
      'noarchive',
      'nosnippet', // Also checked by nosnippet rule, but relevant here for completeness
      'noimageindex',
      'none', // Equivalent to noindex, nofollow
    ];

    for (const crawler of ['googlebot', 'bingbot']) {
      const reading = readRobotsDirectives($, headers, crawler);
      for (const declaration of reading.declarations) {
        if (!allDirectives.some((item) => item.source === declaration.source && item.directives.join() === declaration.directives.join())) allDirectives.push(declaration);
        for (const directive of declaration.directives) {
          if (restrictiveDirectives.includes(directive)) {
            const source = declaration.source === 'X-Robots-Tag header' ? 'X-Robots-Tag' : /name="([^"]+)"/.exec(declaration.source)?.[1] ?? crawler;
            const issue = `${source}: "${directive}"`;
            if (!issues.includes(issue)) issues.push(issue);
          }
        }
      }
    }

    if (issues.length > 0) {
      return warn(
        'core-robots-meta',
        `Restrictive indexing directives found: ${issues.join(', ')}`,
        {
          issues,
          allDirectives,
          impact: 'These directives may limit search visibility or prevent indexation',
          recommendation: 'Remove restrictive directives unless intentionally blocking search engines',
        }
      );
    }

    // Check if any robots directives exist at all
    if (allDirectives.length === 0) {
      return pass(
        'core-robots-meta',
        'No robots meta tag found (default: index, follow)',
        { allDirectives: [], defaultBehavior: 'index, follow' }
      );
    }

    return pass(
      'core-robots-meta',
      'Robots directives allow indexing',
      { allDirectives }
    );
  },
});

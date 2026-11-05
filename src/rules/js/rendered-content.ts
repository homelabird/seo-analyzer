import type { AuditContext, RuleResult } from '../../types.js';
import { defineRule, pass, warn, fail, notMeasured } from '../define-rule.js';
import { bodyText } from '../content/utils/visible-text.js';

/**
 * Rule: Rendered Content Check
 *
 * Checks if significant page content is only present after JavaScript rendering.
 * Pages that rely heavily on client-side rendering may not be properly indexed
 * by search engines that do not execute JavaScript or have delayed rendering.
 */
export const renderedContentRule = defineRule({
  id: 'js-rendered-content',
  name: 'Rendered Content Dependency',
  description: 'Checks if significant content is only present after JavaScript rendering',
  category: 'js',
  weight: 8,
  run: async (context: AuditContext) => {
    const rendered$ = context.rendered$;

    if (!rendered$ || context.renderQuality?.state === 'incomplete') {
      return notMeasured(
        'js-rendered-content',
        'Rendered DOM not available - run without --no-cwv to enable JavaScript rendering checks'
      );
    }

    const rawLen = bodyText(context.$).length;
    const renderedLen = bodyText(rendered$).length;
    if (rawLen === 0 && renderedLen === 0) return notMeasured('js-rendered-content', 'Neither raw nor rendered HTML contains readable text; content dependency cannot be determined', { rawContentLength: 0, renderedContentLength: 0 });

    const details = {
      rawContentLength: rawLen,
      renderedContentLength: renderedLen,
      ratio: rawLen > 0 ? (renderedLen / rawLen).toFixed(2) : 'N/A',
    };

    const assessed = (result: RuleResult): RuleResult => ({ ...result, confidence: 'heuristic', severity: 'recommendation',
      evidence: { source: 'rendered-dom', observed: { rawContentLength: rawLen, renderedContentLength: renderedLen }, expected: 'Review whether critical content requires JavaScript; this observation does not prove indexing failure' } });

    // Page is essentially empty without JS but has content after rendering
    if (rawLen < 100 && renderedLen > 500) {
      return assessed(fail(
        'js-rendered-content',
        'Page is essentially empty without JavaScript; all content is client-side rendered',
        {
          ...details,
          impact: 'Search engines that do not execute JavaScript will see an empty page',
          recommendation: 'Implement server-side rendering (SSR) or static generation to include content in raw HTML',
        }
      ));
    }

    // Most content is JS-rendered
    if (renderedLen > rawLen * 3) {
      return assessed(warn(
        'js-rendered-content',
        'Most page content is injected by JavaScript; raw HTML has significantly less content',
        {
          ...details,
          impact: 'Search engines may not index all content if JavaScript rendering is delayed or fails',
          recommendation: 'Consider server-side rendering for critical content to ensure indexability',
        }
      ));
    }

    return assessed(pass(
      'js-rendered-content',
      'Page content is mostly present in raw HTML',
      details
    ));
  },
});

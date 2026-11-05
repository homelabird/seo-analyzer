import type { AuditContext } from '../../types.js';
import { defineRule, pass, warn } from '../define-rule.js';
import { findItemsByType } from './utils.js';

/** Pages a star rating does not belong on. */
const OFF_TOPIC = /\/(privacy|terms|tos|legal|cookie|login|signin|cart|checkout|account)(\/|$)/i;

/**
 * Rule: AggregateRating scope
 *
 * A rating stamped on a privacy or login URL will not be eligible, and a
 * ratingValue the reader cannot see is the self-serving pattern the
 * review-snippet guidelines describe. Pages with no rating pass.
 */
export const ratingScopeRule = defineRule({
  id: 'schema-rating-scope',
  name: 'AggregateRating Scope',
  description:
    'Checks that AggregateRating is not on a legal or account URL and that ratingValue appears in visible text',
  category: 'schema',
  weight: 8,
  run: (context: AuditContext) => {
    const ratings = findItemsByType(context.rendered$ ?? context.$, 'AggregateRating');
    if (ratings.length === 0) {
      return pass('schema-rating-scope', 'No AggregateRating schema', { ratings: 0 });
    }

    let path = '';
    try {
      path = new URL(context.url).pathname;
    } catch {
      path = '';
    }

    const issues: string[] = [];
    if (OFF_TOPIC.test(path)) {
      issues.push(`AggregateRating on ${path}`);
    }

    const body = (context.rendered$ ?? context.$)('body').clone();
    body.find('script, style, noscript').remove();
    const pageText = body.text();
    const invisible = ratings
      .map((rating) => rating.data.ratingValue)
      .filter((value) => value !== undefined && value !== null)
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0 && !pageText.includes(value));

    if (invisible.length > 0) {
      issues.push(`ratingValue ${invisible.join(', ')} is not in the visible text`);
    }

    if (issues.length === 0) {
      return pass('schema-rating-scope', 'AggregateRating is on-topic and visible', {
        ratings: ratings.length,
      });
    }

    return warn('schema-rating-scope', issues.join('; '), {
      ratings: ratings.length,
      recommendation:
        'Put AggregateRating only on the page the rating is about, and show the same ratingValue in the visible text.',
    });
  },
});

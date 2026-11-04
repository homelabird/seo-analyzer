import type { AuditContext } from '../../types.js';
import { defineRule, pass, warn, notMeasured } from '../define-rule.js';
import { findItemsByType, hasField } from './utils.js';

/** WebSite name and URL support site identity; the retired searchbox is not required. */
export const structuredDataWebsiteSearchRule = defineRule({
  id: 'schema-website-search',
  name: 'WebSite Identity Schema',
  description: 'Checks WebSite name and URL metadata without requiring the retired sitelinks searchbox',
  category: 'schema',
  weight: 8,
  run: (context: AuditContext) => {
    const websites = findItemsByType(context.$, 'WebSite');
    let isHomepage: boolean;
    try { isHomepage = new URL(context.url).pathname === '/'; }
    catch { return notMeasured('schema-website-search', 'Page URL unavailable for WebSite scope'); }
    if (!websites.length) {
      return isHomepage
        ? warn('schema-website-search', 'Homepage missing WebSite identity metadata', { isHomepage })
        : pass('schema-website-search', 'WebSite identity metadata is checked on the homepage', { isHomepage });
    }
    const issues = websites.flatMap((site) => ['name', 'url'].filter((key) => !hasField(site, key)).map((key) => `WebSite missing ${key}`));
    if (issues.length) return warn('schema-website-search', issues.join('; '), { issues, websiteCount: websites.length });
    return pass('schema-website-search', 'WebSite name and URL metadata are present', { websiteCount: websites.length });
  },
});

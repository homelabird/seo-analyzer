import type { AuditContext } from '../../types.js';
import { defineRule, pass, warn, notMeasured } from '../define-rule.js';

/** Use observed navigation protocol, rather than inferring it from Alt-Svc. */
export const http2Rule = defineRule({
  id: 'perf-http2', name: 'HTTP/2+ Support',
  description: 'Checks the protocol observed by browser navigation timing',
  category: 'perf', weight: 5,
  run: (context: AuditContext) => {
    const protocol = context.httpProtocol;
    if (!protocol) return notMeasured('perf-http2', 'Navigation protocol was not collected; Alt-Svc alone cannot establish HTTP/2 support');
    if (/^(h2|h3(?:-\d+)?|http\/2|http\/3)$/i.test(protocol)) return pass('perf-http2', `Navigation used ${protocol}`, { protocol });
    return warn('perf-http2', `Navigation used ${protocol}; a multiplexed protocol was not observed`, { protocol });
  },
});

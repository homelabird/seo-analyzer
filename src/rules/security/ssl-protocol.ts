import type { AuditContext } from '../../types.js';
import { defineRule, pass, fail, notMeasured } from '../define-rule.js';

/** Report the negotiated TLS version; HSTS preload is a separate policy. */
export const sslProtocolRule = defineRule({
  id: 'security-ssl-protocol', name: 'TLS Protocol Configuration',
  description: 'Checks the TLS protocol actually negotiated for the page connection',
  category: 'security', weight: 6,
  run: (context: AuditContext) => {
    const protocol = context.tls?.protocol;
    if (!protocol) return notMeasured('security-ssl-protocol', 'Negotiated TLS protocol was not collected');
    if (['TLSv1.2', 'TLSv1.3'].includes(protocol)) return pass('security-ssl-protocol', `Connection negotiated ${protocol}`, { protocol });
    return fail('security-ssl-protocol', `Connection negotiated obsolete protocol ${protocol}`, { protocol });
  },
});

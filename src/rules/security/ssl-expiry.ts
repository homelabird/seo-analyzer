import type { AuditContext } from '../../types.js';
import { defineRule, pass, warn, fail, notMeasured } from '../define-rule.js';

const WARNING_DAYS = 30;
/** Judge the authenticated peer certificate's expiry, independently of HSTS. */
export const sslExpiryRule = defineRule({
  id: 'security-ssl-expiry', name: 'SSL Certificate Expiry',
  description: 'Checks the expiry date of the certificate observed during the HTTPS connection',
  category: 'security', weight: 8,
  run: (context: AuditContext) => {
    const expiry = context.tls?.validTo;
    const timestamp = expiry ? Date.parse(expiry) : NaN;
    if (!Number.isFinite(timestamp)) return notMeasured('security-ssl-expiry', 'TLS certificate expiry was not collected; HSTS does not reveal certificate lifetime');
    const daysRemaining = (timestamp - Date.now()) / 86_400_000;
    const details = { validTo: expiry, daysRemaining: Math.floor(daysRemaining) };
    if (daysRemaining <= 0) return fail('security-ssl-expiry', 'Observed TLS certificate has expired', details);
    if (daysRemaining < WARNING_DAYS) return warn('security-ssl-expiry', `TLS certificate expires in ${Math.floor(daysRemaining)} days`, details);
    return pass('security-ssl-expiry', `TLS certificate is valid for ${Math.floor(daysRemaining)} more days`, details);
  },
});

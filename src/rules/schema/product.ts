import type { AuditContext } from '../../types.js';
import { defineRule, pass, warn, fail } from '../define-rule.js';
import { findItemsByType, getMissingFields, hasField } from './utils.js';

const PRODUCT_TYPES = ['Product', 'ProductGroup'];
const REQUIRED = ['name'];
const RECOMMENDED = ['image', 'description', 'brand', 'sku', 'gtin', 'aggregateRating', 'review'];
const AVAILABILITY = new Set(['BackOrder', 'Discontinued', 'InStock', 'InStoreOnly', 'LimitedAvailability', 'OnlineOnly', 'OutOfStock', 'PreOrder', 'PreSale', 'SoldOut']);

function validPrice(value: unknown): boolean {
  return (typeof value === 'string' && value.trim() !== '' || typeof value === 'number') && Number.isFinite(Number(value)) && Number(value) >= 0;
}

/**
 * Rule: Product Schema
 *
 * Validates Product schema for e-commerce rich results.
 * Checks for required fields and proper offers structure.
 */
export const structuredDataProductRule = defineRule({
  id: 'schema-product',
  name: 'Product Schema',
  description: 'Validates Product schema for e-commerce rich results',
  category: 'schema',
  weight: 12,
  run: (context: AuditContext) => {
    const $ = context.rendered$ ?? context.$;
    const products = findItemsByType($, PRODUCT_TYPES);

    if (products.length === 0) {
      return pass('schema-product', 'No Product schema found (not required)', {
        found: false,
      });
    }

    const issues: string[] = [];
    const warnings: string[] = [];

    for (const product of products) {
      const missing = getMissingFields(product, REQUIRED);
      if (missing.length > 0) {
        issues.push(`Product missing: ${missing.join(', ')}`);
      }

      // Validate offers
      if (hasField(product, 'offers')) {
        const offers = product.data.offers;
        const offerList = Array.isArray(offers) ? offers : [offers];

        for (const offer of offerList) {
          if (typeof offer !== 'object' || offer === null) { issues.push('Offer must be an object'); continue; }
          const o = offer as Record<string, unknown>;
          if (o['@id'] && Object.keys(o).length === 1) {
            warnings.push('Offer is an @id reference; validate the referenced node');
            continue;
          }
          const priceSpecification = typeof o.priceSpecification === 'object' && o.priceSpecification !== null
            ? o.priceSpecification as Record<string, unknown> : {};
          const aggregate = o['@type'] === 'AggregateOffer';
          if (!validPrice(aggregate ? o.lowPrice : o.price ?? priceSpecification.price)) issues.push(`Offer missing or invalid ${aggregate ? 'lowPrice' : 'price'}`);
          const currency = o.priceCurrency ?? priceSpecification.priceCurrency;
          if (!currency) {
            if (aggregate) issues.push('AggregateOffer missing priceCurrency');
            else warnings.push('Offer missing recommended priceCurrency');
          } else if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) issues.push('Offer priceCurrency must be a three-letter currency code');
          // Check valid availability values
          if (o.availability) {
            const avail = String(o.availability).replace(/^https?:\/\/schema\.org\//, '');
            const isValid = AVAILABILITY.has(avail);
            if (!isValid) {
              warnings.push('availability should use schema.org ItemAvailability values');
            }
          }
        }
      } else if (!hasField(product, 'review') && !hasField(product, 'aggregateRating') && !(product.type === 'ProductGroup' && hasField(product, 'hasVariant'))) {
        issues.push('Product snippet requires one of review, aggregateRating, or offers');
      }

      const missingRecommended = getMissingFields(product, RECOMMENDED);
      if (missingRecommended.length > 0) {
        warnings.push(`consider adding ${missingRecommended.join(', ')}`);
      }
    }

    if (issues.length > 0) {
      return fail('schema-product', issues.slice(0, 3).join('; '), {
        productCount: products.length,
        profile: 'product-snippet',
        issues,
        warnings,
      });
    }

    if (warnings.length > 0) {
      return warn('schema-product', 'Product schema valid with suggestions', {
        productCount: products.length,
        profile: 'product-snippet',
        warnings,
      });
    }

    return pass('schema-product', `${products.length} Product schema(s) properly configured`, {
      productCount: products.length,
    });
  },
});

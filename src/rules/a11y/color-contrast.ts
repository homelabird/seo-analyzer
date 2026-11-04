import type { AuditContext } from '../../types.js';
import { defineRule, pass, warn, notMeasured } from '../define-rule.js';

const NORMAL_CONTRAST = 4.5;
const LARGE_CONTRAST = 3;
const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', gray: '#808080', grey: '#808080',
  lightgray: '#d3d3d3', lightgrey: '#d3d3d3', silver: '#c0c0c0', gainsboro: '#dcdcdc',
  red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  cyan: '#00ffff', aqua: '#00ffff', lime: '#00ff00', navy: '#000080',
  darkgray: '#a9a9a9', darkblue: '#00008b',
};

function color(value: string): number[] | undefined {
  const raw = NAMED[value.toLowerCase()] ?? value.toLowerCase();
  const hex = raw.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  }
  const rgb = raw.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgb && rgb.slice(1).every((v) => Number(v) <= 255)) return rgb.slice(1).map(Number);
  return undefined;
}
function luminance(rgb: number[]): number {
  const channels = rgb.map((v) => {
    const srgb = v / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

/** Measure explicit, opaque inline pairs; inherited/computed styles remain unmeasured. */
export const colorContrastRule = defineRule({
  id: 'a11y-color-contrast',
  name: 'Color Contrast',
  description: 'Checks contrast ratios of explicit inline text/background colour pairs',
  category: 'a11y',
  weight: 8,
  run: (context: AuditContext) => {
    const { $ } = context;
    let examined = 0;
    let unavailable = 0;
    const issues: Array<{ element: string; ratio: number; required: number }> = [];
    $('[style]').each((_, el) => {
      const node = $(el);
      if (!node.text().trim()) return;
      const declarations = Object.fromEntries((node.attr('style') ?? '').split(';').map((part) => {
        const colon = part.indexOf(':');
        return [part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim().toLowerCase()];
      }));
      if (!declarations.color) return;
      const foreground = color(declarations.color);
      const background = color(declarations['background-color'] ?? declarations.background ?? '');
      if (!foreground || !background || declarations['background-image'] || declarations.opacity) { unavailable++; return; }
      examined++;
      const a = luminance(foreground), b = luminance(background);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const size = declarations['font-size']?.match(/^([\d.]+)(px|pt)$/);
      const pixels = size ? Number(size[1]) * (size[2] === 'pt' ? 4 / 3 : 1) : 0;
      const bold = /^(bold|[7-9]00)$/.test(declarations['font-weight'] ?? '');
      const required = pixels >= 24 || (bold && pixels >= 18.66) ? LARGE_CONTRAST : NORMAL_CONTRAST;
      if (ratio < required) issues.push({ element: node.attr('id') ? `#${node.attr('id')}` : el.tagName, ratio: Math.round(ratio * 100) / 100, required });
    });
    const details = { examined, unavailable, issues: issues.slice(0, 10), note: 'Inline pairs only; stylesheet, inherited and composited colours need rendered measurement' };
    if (issues.length) return warn('a11y-color-contrast', `${issues.length} inline text colour pair(s) have insufficient contrast`, details);
    if (!examined || unavailable) return notMeasured('a11y-color-contrast', 'No complete contrast verdict: some or all colours require computed styles', details);
    return pass('a11y-color-contrast', `All ${examined} examined inline colour pair(s) meet contrast thresholds; stylesheet colours were not measured`, details);
  },
});

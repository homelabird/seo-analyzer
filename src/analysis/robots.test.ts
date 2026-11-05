import { describe, expect, it } from 'vitest';
import { load } from 'cheerio';
import { readIndexingDirectives, readRobotsDirectives } from './robots.js';

describe('search crawler directives', () => {
  it('merges multiple case-insensitive tags and expands none', () => {
    const reading = readRobotsDirectives(load('<meta name="ROBOTS" content="index"><meta name="Googlebot" content="none">'));
    expect(reading.noindex).toBe(true);
    expect(reading.nofollow).toBe(true);
    expect(reading.declarations).toHaveLength(2);
  });
  it('retains header crawler scope across comma-separated directives', () => {
    const headers = { 'X-Robots-Tag': 'bingbot: nofollow, noindex, googlebot: index, follow' };
    expect(readRobotsDirectives(undefined, headers).noindex).toBe(false);
    expect(readRobotsDirectives(undefined, headers, 'bingbot').noindex).toBe(true);
  });
  it('does not treat valued directives as crawler names', () => {
    expect(readRobotsDirectives(undefined, { 'x-robots-tag': 'max-snippet: -1, noindex' }).noindex).toBe(true);
  });
  it('keeps source restrictions while reporting both stages', () => {
    const reading = readIndexingDirectives({ $: load('<meta name="robots" content="noindex">'), headers: {}, rendered$: load('<meta name="robots" content="index">') });
    expect(reading.raw.noindex).toBe(true);
    expect(reading.rendered?.noindex).toBe(false);
    expect(reading.noindex).toBe(true);
  });
  it('does not create restrictions when no directives were observed', () => {
    expect(readRobotsDirectives(load('<p>Public</p>'))).toMatchObject({ noindex: false, nofollow: false, declarations: [] });
  });
});

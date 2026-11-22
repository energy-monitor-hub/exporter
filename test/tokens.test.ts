import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/ui/tokens.css', import.meta.url), 'utf8');

/** `--name: value` pairs of the first block that starts with `selector {`. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf('}', start));
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] as string, (m[2] as string).trim()]));
}

describe('design tokens', () => {
  const light = block(':root');
  const darkOs = block(":root:not([data-theme='light'])");
  const darkForced = block(":root[data-theme='dark']");

  it('writes the dark values the same way twice', () => {
    expect([...darkForced]).toEqual([...darkOs]);
  });

  it('overrides only tokens that exist in light', () => {
    for (const name of darkOs.keys()) expect(light.has(name), name).toBe(true);
  });

  it('gives every color token a dark value', () => {
    const colors = [...light].filter(([, v]) => /^(#|rgba?\()/.test(v)).map(([k]) => k);
    expect(colors.filter((k) => !darkOs.has(k))).toEqual([]);
  });

  it('does not use names that Tailwind or shadcn/ui own', () => {
    const owned = /^--(text-(xs|sm|base|lg|xl)|radius|font-(sans|mono)|card|muted|border|primary|secondary|accent|background|foreground|ring|input|spacing)/;
    expect([...light.keys()].filter((k) => owned.test(k))).toEqual([]);
  });
});

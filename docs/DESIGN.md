# Design system

*Українською: [uk/DESIGN.md](uk/DESIGN.md)*

Energy Monitor Hub has two interfaces: the dashboard (React, Tailwind, shadcn/ui, in the dashboard repository) and this exporter's local status page (plain HTML, CSS and JS in `src/ui/`, no framework and no build step on purpose). Both draw from one set of design tokens so they look like one product.

## Where the tokens live

[`src/ui/tokens.css`](../src/ui/tokens.css) is the single source of truth. It is plain CSS custom properties on `:root`, with light and dark values.

- **Status page**: served as `/tokens.css` and linked before `app.css`. It is also bundled into the single executable (`scripts/build-sea.mjs`) and checked by `--self-check`.
- **Dashboard**: keeps an identical copy in `web/src/design/tokens.css` and maps the shadcn/ui theme onto it in `web/src/styles.css`. After bumping the exporter submodule, `make design-sync` there copies the file again, and a test there fails while the copy differs. The tokens live in this public repository so the status page never depends on the private one, and the dashboard's build does not need the submodule.

The showcase is the dashboard's `/design` page: brand, every token in the current theme, shadcn components and the patterns below, in light and dark.

## Rules

- Use a token, never a literal color, size or radius, in both interfaces. A new value that is needed in one place goes into `tokens.css` first.
- Token names never collide with Tailwind's theme variables (`--text-*`, `--radius-*`, `--font-*`) or shadcn's (`--card`, `--muted`, `--border`, `--primary`, ...). The dashboard maps shadcn onto the tokens instead. `test/tokens.test.ts` checks this.
- Dark mode follows the OS unless `data-theme="light"` or `"dark"` on `<html>` forces it. The dark values are written twice (media query and `[data-theme='dark']`); `test/tokens.test.ts` checks that both blocks match and that every color has a dark value.
- System fonts only. No web fonts or anything else fetched from a host the user did not configure (see `CLAUDE.md`).

## Tokens

| Group | Tokens | Use |
|---|---|---|
| Brand | `--brand`, `--brand-strong`, `--brand-fg`, `--brand-wash` | primary buttons, links, focus ring, the logo; `--brand-fg` is text on `--brand`; `--brand-wash` is a selection or hover tint |
| Surfaces | `--page`, `--surface-1`, `--surface-2` | page background, cards and popovers, inset areas and secondary buttons |
| Text | `--text-primary`, `--text-secondary`, `--text-muted` | body and values, labels and hints, axis ticks and placeholders |
| Lines | `--line`, `--line-strong` | card and table borders, input and button borders |
| States | `--good`, `--warning`, `--critical` + `--<state>-bg` / `--<state>-fg`, `--info-bg` / `--info-fg`, `--idle-bg` / `--idle-fg` | strong color for dots, icons and chart lines; the soft pair for badges and banners |
| Charts | `--series-1` … `--series-6`, `--series-dim`, `--grid`, `--axis`, `--outage`, `--div-low` / `--div-mid` / `--div-high` | series in this order, context lines, grid and axes, the band for grid outages, diverging scales (cell voltages) |
| Type | `--font-ui`, `--font-code`, `--fs-xs` 12 · `--fs-sm` 13 · `--fs-base` 14 · `--fs-md` 15 · `--fs-lg` 18 · `--fs-xl` 22 · `--fs-stat` 28, `--lh-tight`, `--lh-normal`, `--fw-*` | numbers always use tabular figures |
| Spacing | `--space-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-8` 32 · `-12` 48 | a 4 px scale |
| Corners | `--corner-sm` 6 · `--corner-md` 8 · `--corner-lg` 12 · `--corner-pill` | inputs and small buttons, buttons, cards, badges |
| Elevation | `--shadow-1`, `--shadow-2` | cards, popovers and dialogs |

## States

| State | Means | Examples |
|---|---|---|
| good | working as it should | connected, grid present, queue empty |
| warning | degraded or waiting; it may fix itself | stale data, rows waiting, token expiring |
| critical | broken, or needs the user | disconnected, no grid, write errors, access revoked |
| info | neutral news | update available, new model found |
| idle | off or unknown | not set up yet, grid unknown |

On the status page the badge classes are `ok`, `warn`, `bad` and `idle` (`badge(el, cls, text)` in `app.js`); in the dashboard it is `<StateBadge state="good">`.

## Patterns

Each pattern exists in both interfaces with the same look.

| Pattern | Status page (`src/ui/`) | Dashboard (`web/src/components/`) |
|---|---|---|
| Brand: hexagon mark with a bolt + "Energy Monitor **Hub**" | `.brand` in the header | `BrandMark`, `BrandWordmark` |
| State badge: soft pill with a dot and a short label | `.badge.ok` / `.warn` / `.bad` / `.idle` | `StateBadge` |
| Status card: title, state badge on the right, details | `.card` + `.card-head` | `StatusCard` (shadcn `Card`) |
| Label / value rows: labels keep their width, a long value wraps inside its own column (never letter by letter, never under the label) | `<dl>` | `LabelValueList` |
| Stat tile: big number, small unit, caption | `.tile` | `StatValue` |
| Banner: one line of news in a state's soft colors | `.banner`, `.banner.bad` | a `div` with the state's soft classes |
| Chart: canvas (uPlot), colors from `--series-*`, grey band for outages, dashed thresholds | none | `TimeChart` and the other `charts/` |

## Brand

- Name: **Energy Monitor Hub**, brand and device agnostic.
- Mark: a hexagon (a battery cell, a hub) with a lightning bolt, filled with `--brand`; the bolt is `--brand-fg`. It works from 16 px (favicon) up.
- Accent: blue (`#2671cc` light, `#3f8ce8` dark; white text on it in light, dark ink in dark, both above 4.5:1). It reads well in both themes and is not a state color, so it is never mistaken for "good" or "warning". The `/design` page can preview other candidates.

---
name: tesseron-diagram
description: Create professional technical diagrams (architecture, sequence, state, flow) in the Tesseron docs visual language — dark slate base with a single amber accent, dotted-grid background, gradient cards, Lucide-style icons, Gaussian-blur glow on the emphasized node, and Inter + JetBrains Mono typography. Use when creating docs diagrams for a Tesseron-style project, any Starlight/Astro docs site that wants a restrained monochrome-plus-one-accent aesthetic, or when the user says "use our Tesseron design system".
license: MIT
metadata:
  version: "1.1"
  author: Tesseron / Kenny Vaneetvelde
  based-on: Cocoon-AI/architecture-diagram-generator (methodology)
  changelog:
    - "1.1 — codified hard rules from iterative visual QA: pill-on-arrow, line+polygon arrows (no SVG markers), centered icons, 10×10 arrowheads, ASCII-only content."
---

# Tesseron Diagram Skill

Produce self-contained HTML files with embedded CSS and inline SVG in the Tesseron docs aesthetic.

## Core principle

**One accent color. Everything else is neutral.** Rainbow palettes are the #1 amateur tell. The accent (amber) is reserved for the single "novel" or "featured" node per diagram. Every other node is a neutral slate card.

---

## ⚠️ Hard rules (learned the hard way — do not deviate)

These are non-negotiable conventions established through visual QA. Every rule here exists because breaking it produced a visible bug.

### 1. ASCII-only in all text content

Smartypants-style post-processors (Astro, MDX, many static-site pipelines) silently convert `'` → `'`, `"` → `"`, `...` → `…`. Those characters then get mis-encoded as `â€™`, `â€œ`, `â€¦` by browsers that don't declare UTF-8 cleanly. Avoid the whole class of problem:

- Use `'` (straight apostrophe), never `'`.
- Use `"` (straight double quote), never `"` `"`.
- Use `...` (three dots), never `…`.
- Use `-` (hyphen), never `–` `—`.
- Use `|` or `,` or `+` for decorative separators, never `·`, never `↔`, never `→` inside text labels.

If the host framework does smartypants at build time, disable it (e.g. Astro: `markdown: { smartypants: false }`).

### 2. Arrows: line + polygon, NOT SVG `<marker>`

`<marker>` with `refX`, scaling, and various `markerUnits` modes is a perpetual source of alignment bugs: the line stroke consistently renders a pixel or two past the arrowhead tip due to `refX` vs. viewBox scaling and linecap behavior. **Ditch markers entirely.** Draw each arrow as:

- A **`<line>`** with `stroke-linecap="butt"` whose `x2` is exactly the triangle's **base x-coordinate** (not the tip).
- An **inline `<polygon>`** for the arrowhead, base aligned with the line's end, tip at the real target.

Line and polygon have zero overlap by construction, so the stroke physically cannot render past the tip.

Canonical arrow (right-pointing, tip at `TIP_X`):

```xml
<!-- Arrow tip at TIP_X. Base at TIP_X-10. Body runs from x1 to base. -->
<line x1="X1" y1="Y" x2="TIP_X-10" y2="Y"
      stroke="var(--dgm-line-strong)" stroke-width="1.75" stroke-linecap="butt"/>
<polygon points="TIP_X-10,Y-5  TIP_X,Y  TIP_X-10,Y+5"
         fill="var(--dgm-line-strong)"/>
```

For bidirectional arrows: left triangle, then line between the two base x's, then right triangle — three elements, not one.

### 3. Arrowhead dimensions: 10 × 10

**Width 10, half-height 5** (so triangle is 10 wide and 10 tall overall). Balanced — not stretched, not squat. Larger reads chunky, smaller reads thin.

### 4. Label pill sits ON the arrow line, centered

Pill vertical center = arrow y. Pill width < gap width, so ~20-30 px of arrow stays visible on each side.

- `rect` for pill at `y = arrowY - 11`, `height = 22`.
- `text` baseline at `y = arrowY + 4`.
- `fill = var(--dgm-pill-bg)` (opaque) so it cleanly breaks the line underneath.
- `stroke = var(--dgm-accent)` if the edge is accent-colored, else `var(--dgm-pill-border)`.

The visual reads as `---[ label ]--->`, not a floating tag above the line.

### 5. Icons centered horizontally above the title

Icons are 20 × 20 with their own local origin at `(0,0)`. To center horizontally in a card of width `w` centered at `cx`:

```xml
<g class="dgm-icon" transform="translate(cx - 10, y + 16)"> ... </g>
```

Do **not** scale icons (no `scale(1.15)`) — keeps the 1.5 px stroke width crisp.

### 6. Card vertical layout (120 px tall card)

- `y + 16..36` — icon (20 tall, centered horizontally)
- `y + 50` — title (centered, uppercase, 13.5 px / 600)
- `y + 74` — first sub line (centered, 12.5 px / 400)
- `y + 90` — second sub line (if two-line subtitle)
- `y + 110` — monospace code identifier (if present)

With a single-line sub + code, put sub at `y + 74` and code at `y + 94`.

### 7. Node spacing

For a 4-card horizontal architecture on a ~1200 px canvas:

- `pad = 30`, `card w = 180`, `gap = 140`
- Canvas = `4 × 180 + 3 × 140 + 2 × 30 = 1200`

Gap = 140 is the minimum that gives a centered 88 px pill + ~26 px of visible arrow on each side.

### 8. Glow ellipse dimensions

Behind an accent node (size `w × h`):

- `rx = 0.6 × w`, `ry = 0.7 × h`
- `opacity = 0.33`
- filter `stdDeviation = 14`

Larger `ry` (e.g. 0.95) causes the glow to clip at the top/bottom of a tight SVG viewBox. Keep it contained.

### 9. Z-order (paint order matters)

1. Dotted grid background
2. Accent glow ellipses
3. Arrow lines + arrowhead polygons
4. Node cards (with drop shadow)
5. Icons, titles, subtitles, code identifiers
6. Edge label pills (on top of everything in their row)

### 10. SVG rendering in dev — no `width: 100%` if it scales text down

If you're embedding the SVG in a docs page where CSS forces `width: 100%`, a wide viewBox gets scaled down and every font size shrinks proportionally. Either:

- Set explicit `width` and `height` attrs on `<svg>` equal to the canvas size; wrap parent in `overflow-x: auto` so narrow viewports scroll horizontally, OR
- Widen the host content column (e.g., Starlight: `--sl-content-width: 64rem`).

Never leave `width: 100%` + large viewBox + no scroll container. That's the "tiny text" bug.

---

## Palette

### Background / canvas

| Token | Light | Dark |
|---|---|---|
| `--dgm-bg-figure` | `#ffffff` | `#0b1220` |
| `--dgm-grid` | `rgba(148,163,184,0.35)` | `rgba(51,65,85,0.55)` |
| `--dgm-border` | `#cbd5e1` | `#334155` |

### Neutral card (majority of nodes)

| Token | Light | Dark |
|---|---|---|
| `--dgm-card-neutral-1` (top) | `#ffffff` | `#172033` |
| `--dgm-card-neutral-2` (bottom) | `#f1f5f9` | `#0f172a` |

### Accent card (one per diagram)

| Token | Light | Dark |
|---|---|---|
| `--dgm-card-accent-1` | `#fffdf7` | `#2a1f0a` |
| `--dgm-card-accent-2` | `#fef3c7` | `#1c1407` |
| `--dgm-accent-border-1` | `#fbbf24` | `#fcd34d` |
| `--dgm-accent-border-2` | `#d97706` | `#d97706` |
| `--dgm-accent` | `#f59e0b` | `#f59e0b` |
| `--dgm-accent-text` | `#b45309` | `#fcd34d` |

### Danger card (rejection / error paths only)

| Token | Light | Dark |
|---|---|---|
| `--dgm-card-danger-1` | `#fef2f2` | `#2a0f0f` |
| `--dgm-card-danger-2` | `#fee2e2` | `#1c0a0a` |
| `--dgm-danger` | `#dc2626` | `#dc2626` |
| `--dgm-danger-text` | `#b91c1c` | `#fca5a5` |

### Text + lines

| Token | Light | Dark |
|---|---|---|
| `--dgm-text` | `#0f172a` | `#e2e8f0` |
| `--dgm-text-muted` | `#475569` | `#94a3b8` |
| `--dgm-line` | `#94a3b8` | `#64748b` |
| `--dgm-line-strong` | `#64748b` | `#cbd5e1` |
| `--dgm-icon` | `#64748b` | `#94a3b8` |

### Pills (edge labels)

| Token | Light | Dark |
|---|---|---|
| `--dgm-pill-bg` | `#ffffff` | `#0f172a` |
| `--dgm-pill-border` | `#e2e8f0` | `#334155` |
| `--dgm-pill-text` | `#334155` | `#cbd5e1` |

## Typography

- Sans-serif: `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`
- Mono: `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

| Role | Size | Weight | Letter-spacing |
|---|---|---|---|
| Card title (uppercase) | 13.5 px | 600 | 0.08 em |
| Card subtitle | 12.5 px | 400 | 0 |
| Card code identifier (mono) | 11.5 px | 400 | 0 |
| Edge label pill | 12 px | 500 | 0.02 em |
| Sequence actor title | 15 px | 600 | 0.08 em |
| Sequence message label | 13 px | 500 | 0.01 em |
| Step number (in circle) | 11.5 px | 600 | 0 |
| Note text (italic) | 14 px | 500 | 0 |

## Icons (Lucide-style, 20 × 20)

Each icon is a set of SVG paths inside a group with `fill="none"`, `stroke-width="1.5"`, `stroke-linecap="round"`, `stroke-linejoin="round"`. Stroke color = `var(--dgm-icon)` for neutral, `var(--dgm-accent)` for accent, `var(--dgm-danger)` for danger.

```
user:     <circle cx="10" cy="7" r="3.6"/><path d="M3 20 a7 7 0 0 1 14 0"/>
window:   <rect x="1" y="2" width="18" height="16" rx="2"/><path d="M1 6 H19"/>
          <circle cx="4" cy="4" r="0.7" fill="currentColor" stroke="none"/>
          <circle cx="7" cy="4" r="0.7" fill="currentColor" stroke="none"/>
bridge:   <path d="M3 7 H17"/><path d="M14 4 L18 7 L14 10"/>
          <path d="M17 13 H3"/><path d="M6 10 L2 13 L6 16"/>
agent:    <path d="M10 1.5 L12 8 L18.5 10 L12 12 L10 18.5 L8 12 L1.5 10 L8 8 Z"/>
shield:   <path d="M10 2 L17 5 V10 C17 14 14 17 10 19 C6 17 3 14 3 10 V5 Z"/>
lock:     <rect x="3" y="9" width="14" height="10" rx="2"/>
          <path d="M6 9 V6 a4 4 0 0 1 8 0 V9"/>
cube:     <path d="M10 2 L18 6 V14 L10 18 L2 14 V6 Z"/>
          <path d="M2 6 L10 10 L18 6"/><path d="M10 10 V18"/>
packages: <rect x="1.5" y="1.5" width="7" height="7" rx="1"/>
          <rect x="11.5" y="1.5" width="7" height="7" rx="1"/>
          <rect x="6.5" y="11.5" width="7" height="7" rx="1"/>
server:   <rect x="2" y="3" width="16" height="6" rx="1.5"/>
          <rect x="2" y="11" width="16" height="6" rx="1.5"/>
          <circle cx="6" cy="6" r="0.7" fill="currentColor" stroke="none"/>
          <circle cx="6" cy="14" r="0.7" fill="currentColor" stroke="none"/>
database: <ellipse cx="10" cy="4" rx="8" ry="2.2"/>
          <path d="M2 4 V16 a8 2.2 0 0 0 16 0 V4"/>
          <path d="M2 10 a8 2.2 0 0 0 16 0"/>
```

Place in a card (card center `cx`, card top `y`):

```xml
<g class="dgm-icon" transform="translate(cx - 10, y + 16)"> ... </g>
```

## Visual defs

**Dotted grid** (painted first, full canvas):

```xml
<pattern id="dgm-dots" width="22" height="22" patternUnits="userSpaceOnUse">
  <circle cx="1.2" cy="1.2" r="1.2" fill="var(--dgm-grid)"/>
</pattern>
<rect width="100%" height="100%" fill="url(#dgm-dots)"/>
```

**Card fill gradient** (subtle top → bottom):

```xml
<linearGradient id="dgm-card-neutral" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="var(--dgm-card-neutral-1)"/>
  <stop offset="1" stop-color="var(--dgm-card-neutral-2)"/>
</linearGradient>
```

**Accent border gradient**:

```xml
<linearGradient id="dgm-border-accent" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="var(--dgm-accent-border-1)"/>
  <stop offset="1" stop-color="var(--dgm-accent-border-2)"/>
</linearGradient>
```

**Accent glow filter** (painted BEHIND the accent card as a separate `<ellipse>`):

```xml
<filter id="dgm-glow-accent" x="-30%" y="-60%" width="160%" height="220%">
  <feGaussianBlur stdDeviation="14" result="b"/>
  <feColorMatrix in="b" type="matrix"
    values="0 0 0 0 0.98   0 0 0 0 0.73   0 0 0 0 0.14   0 0 0 0.45 0"/>
</filter>

<ellipse cx="CARD_CX" cy="CARD_CY"
  rx="CARD_W*0.6" ry="CARD_H*0.7"
  fill="var(--dgm-accent)" filter="url(#dgm-glow-accent)" opacity="0.33"/>
```

**Card drop shadow** (two layered feDropShadow — no 90s bevel):

```xml
<filter id="dgm-shadow" x="-10%" y="-10%" width="120%" height="130%">
  <feDropShadow dx="0" dy="4" stdDeviation="6"
    flood-color="var(--dgm-shadow-color)" flood-opacity="0.06"/>
  <feDropShadow dx="0" dy="1" stdDeviation="1.5"
    flood-color="var(--dgm-shadow-color)" flood-opacity="0.04"/>
</filter>
```

## Node card pattern

Neutral:

```xml
<rect x="X" y="Y" width="W" height="H" rx="14"
      fill="url(#dgm-card-neutral)" stroke="var(--dgm-border)" stroke-width="1.25"
      filter="url(#dgm-shadow)"/>
```

Accent (gradient border):

```xml
<rect x="X" y="Y" width="W" height="H" rx="14"
      fill="url(#dgm-card-accent)" stroke="url(#dgm-border-accent)" stroke-width="1.25"
      filter="url(#dgm-shadow)"/>
```

Full card (accent) with icon centered + title + subtitle + code:

```xml
<g>
  <rect x="670" y="90" width="180" height="120" rx="14"
        fill="url(#dgm-card-accent)" stroke="url(#dgm-border-accent)" stroke-width="1.25"
        filter="url(#dgm-shadow)"/>
  <g class="dgm-icon dgm-icon-accent" transform="translate(750,106)"> ... </g>
  <text x="760" y="150" text-anchor="middle" class="dgm-title dgm-title-accent">GATEWAY</text>
  <text x="760" y="174" text-anchor="middle" class="dgm-sub dgm-sub-accent">WebSocket + MCP bridge</text>
  <text x="760" y="194" text-anchor="middle" class="dgm-code dgm-code-accent">@tesseron/mcp :7475</text>
</g>
```

## Edge pattern (full canonical example)

Arrow from `(x1=216, y=150)` to tip at `(x=344, y=150)`, accent-colored:

```xml
<line x1="216" y1="150" x2="334" y2="150"
      stroke="var(--dgm-accent)" stroke-width="1.75" stroke-linecap="butt"/>
<polygon points="334,145 344,150 334,155" fill="var(--dgm-accent)"/>
```

Bidirectional between `TIP_LEFT=536` and `TIP_RIGHT=664`:

```xml
<polygon points="546,145 536,150 546,155" fill="var(--dgm-accent)"/>
<line x1="546" y1="150" x2="654" y2="150"
      stroke="var(--dgm-accent)" stroke-width="1.75" stroke-linecap="butt"/>
<polygon points="654,145 664,150 654,155" fill="var(--dgm-accent)"/>
```

Edge pill (centered at `MID_X=600` on arrow at `y=150`):

```xml
<rect x="556" y="139" width="88" height="22" rx="7"
      fill="var(--dgm-pill-bg)" stroke="var(--dgm-accent)" stroke-width="1"/>
<text x="600" y="154" text-anchor="middle" class="dgm-lbl dgm-lbl-accent">WebSocket</text>
```

## Layout (architecture, 4 cards horizontal)

Canvas 1200 × 310, node midline y=150:

| Node | x | width | center x |
|---|---:|---:|---:|
| 0 | 30 | 180 | 120 |
| 1 | 350 | 180 | 440 |
| 2 | 670 | 180 | 760 |
| 3 | 990 | 180 | 1080 |

Arrow tips sit at the card edges: for node 0→1 the line is `x1 = 216, tip = 344` (leaving 30 px of arrow on each side of an 88 px pill centered at `x = 280`).

## Sequence diagrams

Same design tokens, different layout:

- **Actors** at top, evenly spaced (actor width 220, actor gap 110, card pattern above).
- **Lifelines**: dashed vertical line from actor bottom to row bottom. `stroke="var(--dgm-line)" stroke-width="1.25" stroke-dasharray="3 5" opacity="0.6"`.
- **Messages**: horizontal `<line>` + `<polygon>` arrow at row y. Label pill centered on arrow.
- **Step numbers**: 10 px circle on the source end, border matches arrow stroke, text 11.5 px / 600.
- **Notes**: rounded rect spanning one or more actors, 30 px tall, italic 14 px text.

## Output

Produce a single self-contained `.html` file with:

- Embedded CSS in `<style>`.
- Inline SVG.
- Both light and dark palettes via CSS custom properties and `@media (prefers-color-scheme: dark)`.
- No JavaScript required.

## Starter template

A ready-to-customize template lives at `assets/template.html`. It ships with all `<defs>`, CSS custom properties for light + dark, a three-card summary below the diagram, and an example node pair with a working edge. Duplicate it and fill in.

A fully-worked 4-node architecture example lives at `examples/architecture.html`.

## Anti-patterns (never do these)

- **Multiple saturated colors.** One accent. If you reach for a second color for "visual interest," don't.
- **SVG `<marker>`-based arrows.** Endless refX/linecap alignment bugs. Always line + polygon.
- **Pill above the arrow.** Pill sits ON the arrow. The visual is `---[ label ]--->`.
- **Icons in the top-left when text is centered.** Either both left-aligned or both centered — the mismatch reads amateur.
- **Drop shadows with `dy > 4` or `opacity > 0.1`.** Hard shadows read as 90s bevel.
- **Scaled icons (`scale(1.15)`)** — the 1.5 px stroke gets fuzzy. Draw icons at 20 × 20 native.
- **Mixed icon sets.** Lucide-style only.
- **Non-ASCII in labels.** Smartypants + browser encoding = `â€™`.
- **Rotated text.** Ever.
- **`width: 100%` on a wide SVG with no horizontal scroll.** Kills text readability.

## When NOT to use this skill

- Hand-drawn / Excalidraw aesthetic → use `coleam00/excalidraw-diagram-skill`.
- Diagrams with > 12 nodes or nested hierarchies needing auto-layout at scale → use D2 or Mermaid.
- Cocoon-AI's multi-color semantic palette (cyan/emerald/violet) → use their skill.

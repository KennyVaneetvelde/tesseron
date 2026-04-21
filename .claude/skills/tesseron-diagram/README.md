# Tesseron Diagram Skill

A Claude Code skill that produces technical diagrams in the Tesseron docs visual language.

Matches the aesthetic of the Tesseron docs site — dark slate base with a single amber accent, dotted-grid background, gradient cards, Lucide-style icons, Gaussian-blur glow on the emphasized node, Inter + JetBrains Mono typography.

## Why this and not ...

| Skill | Use when |
|---|---|
| **tesseron-diagram** (this) | You want the monochrome-plus-one-accent aesthetic used by the Tesseron docs. |
| [`Cocoon-AI/architecture-diagram-generator`](https://github.com/Cocoon-AI/architecture-diagram-generator) | You want the Cocoon dark palette with multi-color semantic coding (cyan=frontend, emerald=backend, violet=DB, amber=cloud, rose=security). Good for cloud infrastructure diagrams. |
| [`coleam00/excalidraw-diagram-skill`](https://github.com/coleam00/excalidraw-diagram-skill) | You want the warm hand-drawn Excalidraw aesthetic (Cloudflare engineering blog, Meta engineering blog). |
| [`laurigates/claude-plugins → d2-diagrams`](https://github.com/laurigates/claude-plugins) | You want D2 specifically, with auto-layout for large diagrams. |

## Install

Drop into your project's `.claude/skills/` directory:

```bash
cp -r tesseron-diagram your-project/.claude/skills/
```

Or globally:

```bash
cp -r tesseron-diagram ~/.claude/skills/
```

## Use

Ask your agent:

> "Create a diagram showing the handshake flow between our web app and the gateway. Use the tesseron-diagram skill."

The skill will produce a self-contained `.html` file with embedded CSS + inline SVG that matches the Tesseron aesthetic. For docs sites that already render Astro/Starlight inline SVG, you can also lift just the `<svg>` element out of the generated HTML and embed it directly.

## Files

- `SKILL.md` — the design system (palette, typography, icons, z-order rules, anti-patterns).
- `assets/template.html` — starter HTML with all `<defs>`, CSS custom properties for light + dark, and an example four-node flow diagram.

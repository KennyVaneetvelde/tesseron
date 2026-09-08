# Coding style

*Last Updated: 2026-09-08*

Derived from `biome.json`, `tsconfig.base.json`, and what the source actually does.

## Biome (schema pinned to 1.9.4)

Formatter (`biome.json:14-19`): spaces, width 2, **`lineWidth: 100`** (non-default; Biome ships 80).

JavaScript (`:35-41`): **single quotes** (non-default), `trailingCommas: "all"`,
`semicolons: "always"`.

Linter (`:20-31`): `recommended: true` with exactly **two rules disabled**:

- `style/noNonNullAssertion: "off"` `:25` — `!` is allowed.
- `complexity/useLiteralKeys: "off"` `:28` — bracket access like `obj['sessionId']` is allowed,
  which the code needs because of `noPropertyAccessFromIndexSignature`.

`organizeImports.enabled: true` `:32`.

Ignored (`:3-12`): `dist`, `node_modules`, `.turbo`, **`examples`**, `**/.astro/**`,
`assets/diagrams/**`, `.claude/**`. So example code is neither linted nor formatted, and
plugin-owned artifacts under `.claude/` (the live-rules manifest, this map) are not reformatted by
`pnpm format`.

Run `pnpm format` to write, `pnpm lint` to check. `pnpm lint` is `biome check .` at the root and
does **not** go through turbo.

## Conventions the code actually follows

- **Split type imports.** `verbatimModuleSyntax` forces `import type {…}` separate from value
  imports. Match it.
- **`.js` extensions in relative imports**, even from `.ts` sources (`import … from './client.js'`).
  ESM output requires it.
- **Doc blocks carry the why.** The dense files open with a header explaining a constraint rather
  than narrating the code: `tesseron-typescript/core/src/node.ts:7` on why the main entry stays browser-safe,
  `tesseron-typescript/web/src/reactive-core.ts:1` on why the adapters were collapsed,
  `gateway/src/dialer.ts:33` on why `dial()` must be synchronous,
  `tesseron-typescript/core/src/bind-subprotocol.ts:4` on header-over-query-string. Follow that pattern:
  explain the constraint, not the mechanics.
- **Issue numbers in comments** where a shape exists to fix a specific bug (tesseron#60, #69, #88,
  #92). Keep them; they are the only record of why the guard is there.
- **No `Math.random` for anything security-adjacent.** Two tests assert this by scanning source:
  `tesseron-typescript/core/test/claim-mint.test.ts:19` and `gateway/test/session-tokens.test.ts`. Use the
  mint helpers in `@tesseron/core/node`.
- **Constant-time compares for secrets.** `constantTimeEqual` from `@tesseron/core/internal`, with a
  timing test at `tesseron-typescript/core/test/timing-safe.test.ts:65`.
- **Private files written atomically.** `writePrivateFile` (`node/fs-hygiene.ts:96`) writes to a temp
  with `O_EXCL` at `0o600` then renames. Never hand-roll a write into `~/.tesseron/`.
- **Internal surface goes through `/internal`**, not the main index. If a sibling package needs it
  and users should not, export it from `tesseron-typescript/core/src/internal.ts`.

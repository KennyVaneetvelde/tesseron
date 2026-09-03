# express-prompts

A **prompt library** backend exposed two ways at once:

- **HTTP** — `GET/POST/PATCH/DELETE /prompts` for any HTTP client (curl, another service, an internal dashboard).
- **MCP** — the same state, exposed to Claude via [`@tesseron/server`](../../packages/server), plus sampling and elicitation actions that don't exist on the REST side.

Both channels mutate the same in-memory `Map`. Resource subscribers on the Tesseron side fire when a REST client adds or deletes a prompt, and vice versa.

This is the example to read if you want Claude to operate on a domain that your backend already serves over HTTP — and if you want the agent to be able to **generate, test, and refine content** via `ctx.sample` on the same state.

## Quick start

> One-time MCP-client setup: [examples/README.md](../README.md#one-time-setup).

```bash
pnpm --filter express-prompts dev
```

You'll see something like:

```
[prompts] Express HTTP API on http://localhost:3001
[prompts] connected to gateway. session=s_… claim=ABCD-XY
[prompts] tell Claude: "claim session ABCD-XY"
```

In Claude:

```
claim session ABCD-XY
```

## Try these prompts

- *"What prompt_lab tools do you have?"* — Claude lists `addPrompt`, `listPrompts`, `testPrompt`, `refinePrompt`, `generateVariants`, `importPrompts`, `deletePrompt`, `purgeAll`.
- *"Add a prompt named 'summarize' with template 'Summarize in three bullets: {{text}}'."* — `prompt_lab__addPrompt`. First id is `p1`.
- In another terminal: `curl http://localhost:3001/prompts` — the prompt Claude added is there. Same state, two access channels.
- `curl -X POST -H 'content-type: application/json' -d '{"name":"classify","template":"Classify sentiment: {{text}}"}' http://localhost:3001/prompts` — now Claude's `listPrompts` sees the one you just added over HTTP.
- *"Test prompt p1 with variables { text: 'The weather was perfect.' }."* — `prompt_lab__testPrompt`. Sampling round-trips back through Claude's LLM; the response shows up on `tesseron://prompt_lab/lastTest` AND at `GET /last-test`.
- *"Refine prompt p1."* — `prompt_lab__refinePrompt`. Elicits a refinement instruction from you, then asks the LLM to rewrite the template.
- *"Generate 3 variants of p1."* — `prompt_lab__generateVariants` streams progress; every new variant is visible to REST clients immediately.
- *"Purge all prompts."* — `prompt_lab__purgeAll` requires you to type `DELETE` before anything is removed.

## Tools and resources exposed

| Tool name | Annotations | What it does |
|---|---|---|
| `prompt_lab__addPrompt` | — | Add a prompt template. |
| `prompt_lab__listPrompts` | readOnly | Snapshot, optionally filtered by tag. |
| `prompt_lab__deletePrompt` | destructive, requiresConfirmation | Remove one prompt; gates on `ctx.confirm`. |
| `prompt_lab__testPrompt` | — | Run a prompt through `ctx.sample`; store as `lastTest`. |
| `prompt_lab__refinePrompt` | — | Elicit an instruction; rewrite the template via `ctx.sample`. |
| `prompt_lab__generateVariants` | — | Ask the LLM for N variants; stream progress per variant. |
| `prompt_lab__importPrompts` | — | Bulk import; streams `ctx.progress` per item. |
| `prompt_lab__purgeAll` | destructive, requiresConfirmation | Wipe everything; demands typed confirmation via `ctx.elicit`. |

| Resource URI (subscribable) | What it returns |
|---|---|
| `tesseron://prompt_lab/library` | `Prompt[]` — live library snapshot |
| `tesseron://prompt_lab/lastTest` | `TestResult \| null` — last `testPrompt` output |

| REST endpoint | Behavior |
|---|---|
| `GET /prompts?tag=…` | List prompts, optionally filtered by tag. |
| `POST /prompts {name, template, tags?}` | Create. |
| `PATCH /prompts/:id {name?, template?, tags?}` | Update. |
| `DELETE /prompts/:id` | Remove. |
| `GET /last-test` | Most recent `testPrompt` result. |
| `GET /healthz` | `{ ok: true }`. |

## How it works

[`src/index.ts`](./src/index.ts) is a single file. The Tesseron setup sits next to the Express routes — they share the same `Map<string, Prompt>` and the same subscriber registry:

```ts
import express from 'express';
import { tesseron } from '@tesseron/server';
import { z } from 'zod';

const prompts = new Map<string, Prompt>();
const librarySubs = new Set<(v: Prompt[]) => void>();
function notifyLibrary() { librarySubs.forEach((fn) => fn(Array.from(prompts.values()))); }

// HTTP — mutations go through the same notify() as the Tesseron actions
const app = express();
app.post('/prompts', (req, res) => {
  const p = { id: newId(), name: req.body.name, template: req.body.template, /* ... */ };
  prompts.set(p.id, p);
  notifyLibrary();
  res.status(201).json(p);
});

// Tesseron — on the same map
tesseron.app({ id: 'prompt_lab', name: 'Prompt Lab (Express)', origin: '...' });

tesseron
  .action('testPrompt')
  .input(z.object({ id: z.string(), variables: z.record(z.string(), z.string()).optional() }))
  .handler(async ({ id, variables }, ctx) => {
    const response = await ctx.sample({ prompt: /* ... */ });
    /* store + notifyLibrary(); notifyLastTest(); */
    return { id, response };
  });

tesseron
  .resource<Prompt[]>('library')
  .read(() => Array.from(prompts.values()))
  .subscribe((emit) => { librarySubs.add(emit); return () => librarySubs.delete(emit); });

app.listen(PORT, async () => {
  const welcome = await tesseron.connect();
  console.log(`[prompts] tell Claude: "claim session ${welcome.claimCode}"`);
});
```

`@tesseron/server` connects out to the local MCP gateway over a Node WebSocket (the `ws` package). The builder API, handler context, and JSON-RPC envelope are identical to the browser SDK — the only difference is *where* it runs.

## What each action showcases

- **Dual-write state** — REST mutations call the same `notifyLibrary()` that Tesseron mutations call, so resource subscribers observe HTTP writes in real time.
- **Sampling** — `testPrompt` (free-text reply) and `generateVariants` (Zod-typed JSON reply) both go through `ctx.sample`; no API key lives on this side of the wire.
- **Elicitation** — `refinePrompt` collects a free-text instruction; `purgeAll` demands a typed `DELETE` confirmation.
- **Confirmation** — `deletePrompt` uses `ctx.confirm` for one-off destructive actions.
- **Progress + cancellation** — `importPrompts` and `generateVariants` stream per-item updates and honor `ctx.signal.aborted`.
- **Capability guards** — every sampling action checks `ctx.agentCapabilities.sampling` and throws a clear error if the agent can't sample.

## Troubleshooting

- **`failed to connect to gateway`:** the MCP gateway isn't running. Check your MCP client config (it should spawn it), or run `pnpm --filter @tesseron/mcp start` standalone.
- **`Agent does not support sampling`:** the MCP client you're using doesn't expose `createMessage`. Claude Code, Claude Desktop, and the Cloud agents do. For clients without sampling, stick to the non-sampling actions (`addPrompt`, `listPrompts`, `importPrompts`, `deletePrompt`, `purgeAll`) and the REST endpoints.
- **Port 3001 in use:** override with `PORT=4000 pnpm --filter express-prompts dev`.

## Adapt it

- Swap the `Map` for a real database call (Prisma, Drizzle, raw SQL). Handlers are plain async functions — the Tesseron SDK doesn't care.
- Layer auth on the Express side without touching the Tesseron side: the gateway already authenticated the session when it ran through your MCP client.
- Move any of the sampling-powered actions (`testPrompt`, `refinePrompt`, `generateVariants`) to your own LLM API if you prefer — `ctx.sample` is optional; it's just a convenient way to reuse the agent's model with no extra credentials on the server side.

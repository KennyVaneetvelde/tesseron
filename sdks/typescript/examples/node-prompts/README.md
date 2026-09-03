# node-prompts

A headless **prompt library** exposed to Claude via Tesseron. Claude adds prompts to a shared repository, tests them against its own LLM with `ctx.sample`, asks you (via `ctx.elicit`) how to improve them, then rewrites and stores variants. No HTTP, no browser, no framework — just a Node process and an outgoing WebSocket.

This is the example to read if you want to expose a pure-logic domain from a CLI, daemon, cron worker, or background process, and the domain benefits from **agent-driven sampling and elicitation**.

## Quick start

> One-time MCP-client setup: [examples/README.md](../README.md#one-time-setup).

```bash
pnpm --filter node-prompts dev
```

You'll see something like:

```
[14:12:07] node-prompts starting up
[14:12:07] state: 0 prompts, no test yet
[14:12:07] connected to gateway. session=s_…
[14:12:07] claim code: ABCD-XY
[14:12:07] tell Claude: "claim session ABCD-XY"
[14:12:07] watching for actions. Ctrl-C to exit.
```

In Claude:

```
claim session ABCD-XY
```

Every Claude invocation logs a line so you can correlate prompts with state changes.

## Try these prompts

- *"Add a prompt named 'summarize' with the template 'Summarize the following in three bullets: {{text}}'."* — `prompt_lab__addPrompt`. First id is `p1`.
- *"Test prompt p1 with variables { text: 'The quick brown fox jumps over the lazy dog.' }."* — `prompt_lab__testPrompt`. Calls back into Claude via `ctx.sample`, stores the response as `lastTest`.
- *"Refine prompt p1."* — `prompt_lab__refinePrompt`. Elicits a refinement instruction from you, then asks the LLM to rewrite the template in place.
- *"Generate 3 variants of prompt p1."* — `prompt_lab__generateVariants`. Streams progress as each variant lands in the library.
- *"Read tesseron://prompt_lab/library."* — dumps the whole library.
- *"Read tesseron://prompt_lab/lastTest."* — shows the most recent test response.
- *"Purge all prompts."* — `prompt_lab__purgeAll`. Requires you to type the word `DELETE` before anything is removed.

## Tools and resources exposed

| Tool name | Annotations | What it does |
|---|---|---|
| `prompt_lab__addPrompt` | — | Add a prompt template to the library. |
| `prompt_lab__listPrompts` | readOnly | Snapshot, optionally filtered by tag. |
| `prompt_lab__deletePrompt` | destructive, requiresConfirmation | Remove one prompt; gates on `ctx.confirm`. |
| `prompt_lab__testPrompt` | — | Run a prompt through `ctx.sample`; store as `lastTest`. |
| `prompt_lab__refinePrompt` | — | Elicit a refinement instruction; rewrite via `ctx.sample`. |
| `prompt_lab__generateVariants` | — | Ask the LLM for N variants; stream progress per variant. |
| `prompt_lab__importPrompts` | — | Bulk import; streams `ctx.progress` per item. |
| `prompt_lab__purgeAll` | destructive, requiresConfirmation | Wipe everything; demands typed confirmation via `ctx.elicit`. |

| Resource URI (subscribable) | What it returns |
|---|---|
| `tesseron://prompt_lab/library` | `Prompt[]` — live library snapshot |
| `tesseron://prompt_lab/lastTest` | `TestResult \| null` — last `testPrompt` output |

## How it works

[`src/index.ts`](./src/index.ts) is one file — actions, resources, and a bit of terminal logging. The integration is three moves:

```ts
import { tesseron } from '@tesseron/server';
import { z } from 'zod';

tesseron.app({ id: 'prompt_lab', name: 'Prompt Lab' });

tesseron
  .action('testPrompt')
  .input(z.object({ id: z.string() }))
  .handler(async ({ id }, ctx) => {
    const response = await ctx.sample({ prompt: /* ... */ });
    // store the response, return it to the agent
  });

const welcome = await tesseron.connect();
console.log(`claim code: ${welcome.claimCode}`);
```

Because this is a plain Node script, you can drop the same pattern into **any** Node entrypoint: a CLI built with commander, a BullMQ worker, a systemd-managed daemon, a Lambda that keeps a long-lived WS. The SDK just needs `tesseron.connect()` once the process is alive.

## What each action showcases

- **Plain synchronous handlers** — `addPrompt`, `listPrompts`.
- **Destructive confirmation** — `deletePrompt` via `ctx.confirm`.
- **Typed-confirmation elicitation** — `purgeAll` asks the user to type `DELETE` via `ctx.elicit` with a Zod schema.
- **Structured elicitation + sampling combined** — `refinePrompt` asks the user for a free-text instruction, then asks the agent LLM to apply it.
- **Sampling with a free-text response** — `testPrompt` (no schema → returns a string).
- **Sampling with a typed JSON response** — `generateVariants` (schema → returns a typed object).
- **Capability-guarded handlers** — every sampling action checks `ctx.agentCapabilities.sampling` first and throws a clear error if unavailable.
- **Progress streaming** — `importPrompts`, `generateVariants`, `testPrompt` all emit `ctx.progress`.
- **Cancellation** — `ctx.signal.aborted` is checked inside the per-item loop so stopping the agent mid-run doesn't leave the library half-written.
- **Live resources** — `library` and `lastTest` push updates on every mutation.

## Troubleshooting

- **`failed to connect to gateway`:** the MCP gateway isn't running. Check your MCP client config (it should spawn it), or run `pnpm --filter @tesseron/mcp start` standalone.
- **`Agent does not support sampling`:** the MCP client you're using doesn't expose `createMessage`. Claude Code, Claude Desktop, and the Cloud agents do; some other clients don't. Use `importPrompts` with explicit content instead.
- **Port 7475 already in use:** another example is already holding a connection. That's fine — the gateway multiplexes sessions; you'll just get a different claim code.

## Adapt it

- Swap the in-memory `Map` for SQLite, Redis, or a Postgres table — handlers are plain async functions.
- `generateVariants` shows a typed `ctx.sample({ prompt, schema })` that returns a validated object; reuse that pattern any time you want the LLM to emit structured output.
- Layer this on top of an existing CLI: your `commander`/`yargs` subcommands run as usual, and the Tesseron session runs concurrently on the same process.

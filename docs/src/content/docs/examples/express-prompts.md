---
title: express-prompts
description: REST API + Tesseron on the same Node process, backed by the same state. Sampling-heavy prompt-library domain.
related:
  - sdk/typescript/server
  - examples/node-prompts
---

**What it teaches:** how to expose the same backend operations via two channels at once - HTTP for human or programmatic clients, Tesseron for the agent (with `ctx.sample` and `ctx.elicit` layered on top). Both channels mutate the same state and fire the same resource subscribers.

**Source:** [`examples/express-prompts`](https://github.com/BrainBlend-AI/tesseron/tree/main/examples/express-prompts)

## Run it

```bash
pnpm --filter express-prompts dev
# REST on http://localhost:3001
# @tesseron/server binds its WS endpoint on a random loopback port and writes
# ~/.tesseron/tabs/<tabId>.json; the gateway dials it in. No port to configure.
```

## Domain

A prompt library. REST clients (curl, internal dashboards) can CRUD prompts over `GET/POST/PATCH/DELETE /prompts`. Claude sees the same library via Tesseron, plus four actions that don't exist on the REST side because they depend on the agent's own LLM:

- `testPrompt` - run a prompt through `ctx.sample`, store the response.
- `refinePrompt` - elicit a refinement instruction, rewrite via `ctx.sample`.
- `generateVariants` - ask the LLM for N alternative phrasings, stream progress as they land.
- `purgeAll` - wipe everything; demands a typed `DELETE` confirmation via `ctx.elicit`.

A resource subscription to `tesseron://prompt_lab/library` updates whether the mutation came from REST or from Claude.

## Pattern: shared state, two interfaces

```ts title="src/index.ts (excerpt)"
import express from 'express';
import { tesseron } from '@tesseron/server';
import { z } from 'zod';

const prompts = new Map<string, Prompt>();
const librarySubs = new Set<(v: Prompt[]) => void>();
function notifyLibrary() {
  const v = Array.from(prompts.values());
  librarySubs.forEach((fn) => fn(v));
}

// --- REST ---
const app = express();
app.post('/prompts', (req, res) => {
  const p = { id: newId(), name: req.body.name, template: req.body.template, /* ... */ };
  prompts.set(p.id, p);
  notifyLibrary();                         // <-- also fires Tesseron subscribers
  res.status(201).json(p);
});
// GET /prompts, PATCH /prompts/:id, DELETE /prompts/:id, GET /last-test ...

// --- Tesseron ---
tesseron.app({ id: 'prompt_lab', name: 'Prompt Lab (Express)' });

tesseron.action('testPrompt')
  .input(z.object({
    id: z.string(),
    variables: z.record(z.string(), z.string()).optional(),
  }))
  .handler(async ({ id, variables }, ctx) => {
    const prompt = prompts.get(id)!;
    const response = await ctx.sample({
      prompt: applyTemplate(prompt.template, variables ?? {}),
    });
    // store response, bump timesTested, notifyLibrary(), notifyLastTest()
    return { id, response };
  });

tesseron.resource<Prompt[]>('library')
  .read(() => Array.from(prompts.values()))
  .subscribe((emit) => { librarySubs.add(emit); return () => librarySubs.delete(emit); });

// start both
app.listen(3001);
const welcome = await tesseron.connect();
console.log('Tesseron claim code:', welcome.claimCode);
```

Features exercised: **actions, annotations, subscribable resources, `ctx.confirm` (`deletePrompt`), `ctx.elicit` with schema (`refinePrompt`, `purgeAll`), `ctx.progress` (`importPrompts`, `generateVariants`), `ctx.sample` free-text (`testPrompt`, `refinePrompt`) and `ctx.sample` with Zod schema (`generateVariants`), cancellation via `ctx.signal`, capability gating via `ctx.agentCapabilities.sampling`, coexistence with an HTTP server in one process, unified notification layer that keeps Tesseron subscribers in sync with REST writes**.

## When this pattern fits

- You already have a backend and want Claude to drive it without duplicating business logic.
- You want a single source of truth (the `Map`, in this example - a database, in real life).
- You want the two channels to stay out of each other's way - no HTTP calls pretending to be agent calls, no awkward "AI mode" in your REST routes.
- The agent's own LLM is part of the workflow for at least some operations (`ctx.sample`), and you'd rather not burn an extra API key on the server side.

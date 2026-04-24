---
title: node-prompts
description: Headless Node prompt library - no HTTP, no browser. Shows sampling and elicitation as first-class domain features.
related:
  - sdk/typescript/server
---

**What it teaches:** a pure-Node Tesseron integration whose domain revolves around `ctx.sample` and `ctx.elicit`. No Express, no HTTP server - just a Node script that registers actions and connects. Good when you're building a CLI, a daemon, or a worker that Claude should drive, and the agent's LLM is part of the workflow.

**Source:** [`examples/node-prompts`](https://github.com/BrainBlend-AI/tesseron/tree/main/examples/node-prompts)

## Run it

```bash
pnpm --filter node-prompts dev
# prints the claim code to stdout; no browser
```

## Domain

A library of reusable LLM prompts. Claude can:

- `addPrompt`, `listPrompts`, `deletePrompt`, `importPrompts`, `purgeAll` - CRUD over the library.
- `testPrompt` - fill `{{var}}` placeholders, send the prompt through `ctx.sample`, store the response as `lastTest`.
- `refinePrompt` - elicit a free-text refinement instruction from the user via `ctx.elicit`, then ask the agent LLM via `ctx.sample` to rewrite the template in place.
- `generateVariants` - ask the agent LLM for N alternative phrasings of a prompt, stream progress as each lands, store them as new prompts.

Two subscribable resources push updates on every mutation: `library` (`Prompt[]`) and `lastTest` (`TestResult | null`).

## What's inside

```ts title="src/index.ts (excerpt)"
import { tesseron } from '@tesseron/server';
import { z } from 'zod';

tesseron.app({ id: 'prompt_lab', name: 'Prompt Lab' });

tesseron.action('testPrompt')
  .input(z.object({
    id: z.string(),
    variables: z.record(z.string(), z.string()).optional(),
  }))
  .handler(async ({ id, variables }, ctx) => {
    const prompt = prompts.get(id)!;
    if (!ctx.agentCapabilities.sampling) {
      throw new Error('Agent does not support sampling.');
    }
    const filled = applyTemplate(prompt.template, variables ?? {});
    const response = await ctx.sample({ prompt: filled, maxTokens: 512 });
    // store response as lastTest, bump timesTested, notify subscribers
    return { id, response };
  });

tesseron.action('refinePrompt')
  .input(z.object({ id: z.string() }))
  .handler(async ({ id }, ctx) => {
    const answer = await ctx.elicit({
      question: `What should change?`,
      schema: z.object({ instruction: z.string().min(1) }),
      jsonSchema: { /* ... */ },
    });
    if (answer === null) return { id, refined: false, cancelled: true };
    const rewritten = await ctx.sample({
      prompt: `Rewrite this prompt per instruction: ${answer.instruction}\n\n${prompt.template}`,
    });
    // replace template with rewritten.trim(), notify subscribers
  });

tesseron.resource<Prompt[]>('library')
  .read(() => Array.from(prompts.values()))
  .subscribe((emit) => { librarySubs.add(emit); return () => librarySubs.delete(emit); });

const welcome = await tesseron.connect();
log(`Tesseron ready. Claim code: ${welcome.claimCode}`);
```

Features exercised: **actions, annotations, subscribable resources, `ctx.confirm` (`deletePrompt`), `ctx.elicit` with schema (`refinePrompt`, `purgeAll`), `ctx.progress` (`importPrompts`, `generateVariants`), `ctx.sample` free-text (`testPrompt`, `refinePrompt`) and `ctx.sample` with Zod schema (`generateVariants`), cancellation via `ctx.signal`, capability gating via `ctx.agentCapabilities.sampling`, structured logging via `log()`, signal-aware shutdown**.

Pair with [`express-prompts`](/examples/express-prompts/) to see the same domain served over HTTP.

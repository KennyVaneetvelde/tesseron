/**
 * express-prompts — an Express backend that exposes a prompt library
 * simultaneously to two consumers:
 *
 *   - HTTP clients (any dashboard, CLI, test script) via REST
 *   - Claude via Tesseron (actions, subscribable resources, sampling)
 *
 * Mutations on either side push through the same notification layer, so
 * the Tesseron resource subscribers always reflect REST-driven changes
 * and vice versa.
 */

import express from 'express';
import { tesseron } from '@tesseron/server';
import { z } from 'zod';

interface Prompt {
  id: string;
  name: string;
  template: string;
  tags: string[];
  createdAt: number;
  lastTestedAt?: number;
  timesTested: number;
}

interface TestResult {
  promptId: string;
  promptName: string;
  input: Record<string, string>;
  response: string;
  testedAt: number;
}

let nextId = 1;
const newId = (): string => `p${nextId++}`;

const prompts = new Map<string, Prompt>();
let lastTest: TestResult | null = null;

const HTTP_PORT = Number(process.env['PORT'] ?? 3001);

// --- Subscriber registries — both HTTP + Tesseron mutations go through these --
const librarySubs = new Set<(v: Prompt[]) => void>();
const lastTestSubs = new Set<(v: TestResult | null) => void>();

function librarySnapshot(): Prompt[] {
  return Array.from(prompts.values());
}
function notifyLibrary(): void {
  const v = librarySnapshot();
  librarySubs.forEach((fn) => fn(v));
}
function notifyLastTest(): void {
  lastTestSubs.forEach((fn) => fn(lastTest));
}

function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`Missing variable "${key}" for prompt template`);
    return v;
  });
}

// --- Express HTTP API ---------------------------------------------

const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/prompts', (req, res) => {
  const tag = typeof req.query['tag'] === 'string' ? req.query['tag'] : undefined;
  const all = librarySnapshot();
  res.json(tag ? all.filter((p) => p.tags.includes(tag)) : all);
});

app.post('/prompts', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const template = String(req.body?.template ?? '').trim();
  if (!name || !template) {
    res.status(400).json({ error: 'name and template are required' });
    return;
  }
  const tags: string[] = Array.isArray(req.body?.tags)
    ? req.body.tags.filter((t: unknown): t is string => typeof t === 'string')
    : [];
  const p: Prompt = {
    id: newId(),
    name,
    template,
    tags,
    createdAt: Date.now(),
    timesTested: 0,
  };
  prompts.set(p.id, p);
  notifyLibrary();
  res.status(201).json(p);
});

app.patch('/prompts/:id', (req, res) => {
  const p = prompts.get(req.params.id);
  if (!p) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const next: Prompt = { ...p };
  if (typeof req.body?.name === 'string') next.name = req.body.name;
  if (typeof req.body?.template === 'string') next.template = req.body.template;
  if (Array.isArray(req.body?.tags)) {
    next.tags = req.body.tags.filter((t: unknown): t is string => typeof t === 'string');
  }
  prompts.set(next.id, next);
  notifyLibrary();
  res.json(next);
});

app.delete('/prompts/:id', (req, res) => {
  const existed = prompts.delete(req.params.id);
  if (!existed) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  notifyLibrary();
  res.status(204).end();
});

app.get('/last-test', (_req, res) => {
  res.json(lastTest);
});

// --- Tesseron registration ----------------------------------------

tesseron.app({
  id: 'prompt_lab',
  name: 'Prompt Lab (Express)',
  description:
    'Express backend exposing a prompt library both over REST and to Claude via Tesseron. Sampling and elicitation live on the Tesseron side.',
  origin: `http://localhost:${HTTP_PORT}`,
});

// --- Plain actions -------------------------------------------------

tesseron
  .action('addPrompt')
  .describe('Add a prompt template. Identical state layer as POST /prompts.')
  .input(
    z.object({
      name: z.string().min(1),
      template: z.string().min(1),
      tags: z.array(z.string()).optional(),
    }),
  )
  .handler(({ name, template, tags }) => {
    const p: Prompt = {
      id: newId(),
      name,
      template,
      tags: tags ?? [],
      createdAt: Date.now(),
      timesTested: 0,
    };
    prompts.set(p.id, p);
    notifyLibrary();
    return p;
  });

tesseron
  .action('listPrompts')
  .describe('Snapshot the library, optionally filtered by tag.')
  .input(z.object({ tag: z.string().optional() }))
  .annotate({ readOnly: true })
  .handler(({ tag }) => {
    const all = librarySnapshot();
    return tag ? all.filter((p) => p.tags.includes(tag)) : all;
  });

// --- Confirmation (destructive) ------------------------------------

tesseron
  .action('deletePrompt')
  .describe(
    'Delete a prompt by id. Destructive: asks the user to confirm via ctx.confirm before removing.',
  )
  .input(z.object({ id: z.string() }))
  .annotate({ destructive: true, requiresConfirmation: true })
  .handler(async ({ id }, ctx) => {
    const prompt = prompts.get(id);
    if (!prompt) throw new Error(`No prompt with id "${id}"`);

    const ok = await ctx.confirm({
      question: `Delete prompt "${prompt.name}" (tested ${prompt.timesTested}x)? This cannot be undone.`,
    });
    if (!ok) return { id, deleted: false, cancelled: true };

    prompts.delete(id);
    notifyLibrary();
    return { id, deleted: true };
  });

// --- Sampling (core of the domain) --------------------------------

tesseron
  .action('testPrompt')
  .describe(
    'Run a prompt through the agent LLM via ctx.sample with optional {{var}} substitution, capture the response, and store it as lastTest.',
  )
  .input(
    z.object({
      id: z.string(),
      variables: z.record(z.string(), z.string()).optional(),
    }),
  )
  .handler(async ({ id, variables }, ctx) => {
    const prompt = prompts.get(id);
    if (!prompt) throw new Error(`No prompt with id "${id}"`);
    if (!ctx.agentCapabilities.sampling) {
      throw new Error('Agent does not support sampling; testPrompt requires ctx.sample.');
    }

    const input = variables ?? {};
    const filled = applyTemplate(prompt.template, input);

    ctx.progress({ message: 'asking LLM...', percent: 25 });
    const response = await ctx.sample({ prompt: filled, maxTokens: 512 });
    ctx.progress({ message: 'storing result...', percent: 90 });

    prompt.lastTestedAt = Date.now();
    prompt.timesTested += 1;
    prompts.set(id, prompt);

    lastTest = {
      promptId: id,
      promptName: prompt.name,
      input,
      response,
      testedAt: Date.now(),
    };
    notifyLibrary();
    notifyLastTest();
    return { id, response, timesTested: prompt.timesTested };
  });

// --- Elicitation + sampling combined -------------------------------

tesseron
  .action('refinePrompt')
  .describe(
    'Iteratively improve a prompt. Asks the user (via ctx.elicit) for a refinement instruction, then asks the agent LLM (via ctx.sample) to apply it. Replaces the template in place.',
  )
  .input(z.object({ id: z.string() }))
  .handler(async ({ id }, ctx) => {
    const prompt = prompts.get(id);
    if (!prompt) throw new Error(`No prompt with id "${id}"`);
    if (!ctx.agentCapabilities.sampling) {
      throw new Error('Agent does not support sampling; refinePrompt requires ctx.sample.');
    }

    const answer = await ctx.elicit({
      question: `Refining "${prompt.name}". What should change? (e.g. "make it more concise", "demand JSON output", "add a role")`,
      schema: z.object({ instruction: z.string().min(1) }),
      jsonSchema: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'Free-text refinement instruction.' },
        },
        required: ['instruction'],
      },
    });
    if (answer === null) return { id, refined: false, cancelled: true };

    ctx.progress({ message: 'applying refinement...', percent: 40 });
    const rewritten = await ctx.sample({
      prompt: `You rewrite prompt templates. Return the new template only, no prose.\n\nOriginal template:\n${prompt.template}\n\nInstruction: ${answer.instruction}`,
      maxTokens: 800,
    });

    const previousTemplate = prompt.template;
    prompt.template = rewritten.trim();
    prompts.set(id, prompt);
    notifyLibrary();
    return {
      id,
      refined: true,
      instruction: answer.instruction,
      previousTemplate,
      newTemplate: prompt.template,
    };
  });

// --- Progress + sampling (bulk generation) -------------------------

tesseron
  .action('generateVariants')
  .describe(
    'Ask the agent LLM to produce alternative versions of a prompt (different phrasings, tones, or constraints) and store each as a new prompt. Streams progress as each variant lands.',
  )
  .input(
    z.object({
      id: z.string(),
      count: z.number().int().min(1).max(10).optional(),
    }),
  )
  .handler(async ({ id, count }, ctx) => {
    const source = prompts.get(id);
    if (!source) throw new Error(`No prompt with id "${id}"`);
    if (!ctx.agentCapabilities.sampling) {
      throw new Error('Agent does not support sampling; generateVariants requires ctx.sample.');
    }

    const howMany = count ?? 3;
    ctx.progress({ message: 'requesting variants...', percent: 10 });
    const schema = z.object({ variants: z.array(z.string().min(10)).length(howMany) });
    const reply = await ctx.sample({
      prompt:
        `Produce exactly ${howMany} distinct variations of the prompt below. ` +
        `Vary the phrasing, tone, or structure — but preserve the intent. Return JSON: { variants: string[] }.\n\n` +
        `Prompt:\n${source.template}`,
      schema,
      maxTokens: 1200,
    });

    const added: Prompt[] = [];
    for (let i = 0; i < reply.variants.length; i += 1) {
      await new Promise((r) => setTimeout(r, 40));
      if (ctx.signal.aborted) throw new Error('Cancelled');
      const variant = reply.variants[i]!;
      const p: Prompt = {
        id: newId(),
        name: `${source.name} (variant ${i + 1})`,
        template: variant,
        tags: [...source.tags, 'variant'],
        createdAt: Date.now(),
        timesTested: 0,
      };
      prompts.set(p.id, p);
      added.push(p);
      ctx.progress({
        message: `variant ${i + 1}/${howMany} stored`,
        percent: Math.round(((i + 1) / howMany) * 100),
      });
    }
    notifyLibrary();
    return { sourceId: id, added: added.length, ids: added.map((p) => p.id) };
  });

// --- Pure progress (bulk) ------------------------------------------

tesseron
  .action('importPrompts')
  .describe('Bulk-import prompts from a list. Emits progress notifications as each one lands.')
  .input(
    z.object({
      items: z
        .array(
          z.object({
            name: z.string().min(1),
            template: z.string().min(1),
            tags: z.array(z.string()).optional(),
          }),
        )
        .min(1)
        .max(50),
    }),
  )
  .handler(async ({ items }, ctx) => {
    const total = items.length;
    ctx.progress({ message: 'importing...', percent: 0 });
    const added: Prompt[] = [];
    for (let i = 0; i < total; i += 1) {
      await new Promise((r) => setTimeout(r, 30));
      if (ctx.signal.aborted) throw new Error('Cancelled');
      const item = items[i]!;
      const p: Prompt = {
        id: newId(),
        name: item.name,
        template: item.template,
        tags: item.tags ?? [],
        createdAt: Date.now(),
        timesTested: 0,
      };
      prompts.set(p.id, p);
      added.push(p);
      ctx.progress({
        message: `${i + 1}/${total} imported`,
        percent: Math.round(((i + 1) / total) * 100),
      });
    }
    notifyLibrary();
    return { added: added.length, ids: added.map((p) => p.id) };
  });

// --- Typed-confirmation elicitation (destructive) ------------------

tesseron
  .action('purgeAll')
  .describe(
    'Remove every prompt from the library. Asks the user to type "DELETE" exactly via ctx.elicit to guard against accidental destruction.',
  )
  .annotate({ destructive: true, requiresConfirmation: true })
  .handler(async (_input, ctx) => {
    const count = prompts.size;
    if (count === 0) return { removed: 0 };

    const answer = await ctx.elicit({
      question: `Permanently delete ALL ${count} prompts? Type "DELETE" to confirm.`,
      schema: z.object({ confirmation: z.string() }),
      jsonSchema: {
        type: 'object',
        properties: {
          confirmation: { type: 'string', description: 'Type "DELETE" to proceed.' },
        },
        required: ['confirmation'],
      },
    });
    if (answer === null || answer.confirmation.trim() !== 'DELETE') {
      return { removed: 0, cancelled: true };
    }

    prompts.clear();
    lastTest = null;
    notifyLibrary();
    notifyLastTest();
    return { removed: count };
  });

// --- Resources -----------------------------------------------------

tesseron
  .resource<Prompt[]>('library')
  .describe('Live snapshot of every prompt in the library. Pushed on every change — whether REST or Tesseron initiated it.')
  .read(() => librarySnapshot())
  .subscribe((emit) => {
    librarySubs.add(emit);
    return () => librarySubs.delete(emit);
  });

tesseron
  .resource<TestResult | null>('lastTest')
  .describe('The most recent test result from testPrompt, or null if no prompt has been tested.')
  .read(() => lastTest)
  .subscribe((emit) => {
    lastTestSubs.add(emit);
    return () => lastTestSubs.delete(emit);
  });

// --- Bootstrap -----------------------------------------------------

const httpServer = app.listen(HTTP_PORT, async () => {
  process.stdout.write(`[prompts] Express HTTP API on http://localhost:${HTTP_PORT}\n`);
  try {
    const welcome = await tesseron.connect();
    process.stdout.write(
      `[prompts] connected to gateway. session=${welcome.sessionId} claim=${welcome.claimCode}\n`,
    );
    process.stdout.write(`[prompts] tell Claude: "claim session ${welcome.claimCode}"\n`);
  } catch (error) {
    process.stderr.write(
      `[prompts] failed to connect to gateway: ${(error as Error).message}\n`,
    );
    process.stderr.write(
      '[prompts] is the tesseron MCP plugin running? see https://brainblend-ai.github.io/tesseron/overview/quickstart/\n',
    );
  }
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`[prompts] ${signal} received, shutting down\n`);
  try {
    await tesseron.disconnect();
  } catch {
    // best effort
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

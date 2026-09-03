/**
 * All prompt-lab actions and resources, attached to a passed-in Tesseron client.
 * Pulled out of `src/index.ts` so both the example entrypoint AND a test harness
 * (which needs to inject its own client, gateway, and MCP client with sampling +
 * elicitation capabilities) can share the exact same action definitions.
 */

import type { TesseronClient } from '@tesseron/server';
import { z } from 'zod';

export interface Prompt {
  id: string;
  name: string;
  template: string;
  tags: string[];
  createdAt: number;
  lastTestedAt?: number;
  timesTested: number;
}

export interface TestResult {
  promptId: string;
  promptName: string;
  input: Record<string, string>;
  response: string;
  testedAt: number;
}

export interface PromptLabOptions {
  appId?: string;
  appName?: string;
  description?: string;
  log?: (msg: string) => void;
}

function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`Missing variable "${key}" for prompt template`);
    return v;
  });
}

export function registerPromptLab(client: TesseronClient, opts: PromptLabOptions = {}) {
  const log = opts.log ?? (() => {});
  const appId = opts.appId ?? 'prompt_lab';

  let nextId = 1;
  const newId = (): string => `p${nextId++}`;
  const prompts = new Map<string, Prompt>();
  let lastTest: TestResult | null = null;

  const librarySubs = new Set<(v: Prompt[]) => void>();
  const lastTestSubs = new Set<(v: TestResult | null) => void>();

  const librarySnapshot = (): Prompt[] => Array.from(prompts.values());
  const notifyLibrary = (): void => {
    const v = librarySnapshot();
    librarySubs.forEach((fn) => fn(v));
  };
  const notifyLastTest = (): void => {
    lastTestSubs.forEach((fn) => fn(lastTest));
  };

  client.app({
    id: appId,
    name: opts.appName ?? 'Prompt Lab',
    description:
      opts.description ??
      'A library of reusable LLM prompts. Testing and refining prompts goes through ctx.sample, so sampling is first-class.',
  });

  client
    .action('addPrompt')
    .describe(
      'Add a new prompt template to the library. Templates may include {{var}} placeholders.',
    )
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
      log(`+ addPrompt: "${name}" (id=${p.id})`);
      notifyLibrary();
      return p;
    });

  client
    .action('listPrompts')
    .describe('List every prompt in the library, optionally filtered by tag.')
    .input(z.object({ tag: z.string().optional() }))
    .annotate({ readOnly: true })
    .handler(({ tag }) => {
      const all = librarySnapshot();
      return tag ? all.filter((p) => p.tags.includes(tag)) : all;
    });

  client
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
      if (!ok) {
        log(`- deletePrompt ${id}: cancelled by user`);
        return { id, deleted: false, cancelled: true };
      }

      prompts.delete(id);
      log(`- deletePrompt ${id}: "${prompt.name}"`);
      notifyLibrary();
      return { id, deleted: true };
    });

  client
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
      log(`? testPrompt ${id}: sampling`);
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
      log(`= testPrompt ${id}: ${response.length} chars`);
      notifyLibrary();
      notifyLastTest();

      return { id, response, timesTested: prompt.timesTested };
    });

  client
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
      if (answer === null) {
        log(`~ refinePrompt ${id}: cancelled`);
        return { id, refined: false, cancelled: true };
      }

      ctx.progress({ message: 'applying refinement...', percent: 40 });
      const meta = `You rewrite prompt templates. Return the new template only, no prose.\n\nOriginal template:\n${prompt.template}\n\nInstruction: ${answer.instruction}`;
      const rewritten = await ctx.sample({ prompt: meta, maxTokens: 800 });

      const previousTemplate = prompt.template;
      prompt.template = rewritten.trim();
      prompts.set(id, prompt);
      log(`~ refinePrompt ${id}: "${answer.instruction}"`);
      notifyLibrary();

      return {
        id,
        refined: true,
        instruction: answer.instruction,
        previousTemplate,
        newTemplate: prompt.template,
      };
    });

  client
    .action('generateVariants')
    .describe(
      'Ask the agent LLM to produce alternative versions of a prompt (different phrasings, tones, or constraints) and store each as a new prompt. Streams progress as each variant arrives.',
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
      log(`+ generateVariants: ${added.length} new prompts derived from ${id}`);
      notifyLibrary();
      return { sourceId: id, added: added.length, ids: added.map((p) => p.id) };
    });

  client
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
      log(`+ importPrompts: ${added.length} added`);
      notifyLibrary();
      return { added: added.length, ids: added.map((p) => p.id) };
    });

  client
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
        log(`x purgeAll: cancelled (${count} prompts preserved)`);
        return { removed: 0, cancelled: true };
      }

      prompts.clear();
      lastTest = null;
      log(`x purgeAll: ${count} prompts wiped`);
      notifyLibrary();
      notifyLastTest();
      return { removed: count };
    });

  client
    .resource<Prompt[]>('library')
    .describe('Live snapshot of every prompt in the library. Pushed on every change.')
    .read(() => librarySnapshot())
    .subscribe((emit) => {
      librarySubs.add(emit);
      return () => librarySubs.delete(emit);
    });

  client
    .resource<TestResult | null>('lastTest')
    .describe('The most recent test result from testPrompt, or null if no prompt has been tested.')
    .read(() => lastTest)
    .subscribe((emit) => {
      lastTestSubs.add(emit);
      return () => lastTestSubs.delete(emit);
    });

  return {
    getPrompt: (id: string) => prompts.get(id),
    getLibrary: librarySnapshot,
    getLastTest: () => lastTest,
    size: () => prompts.size,
  };
}

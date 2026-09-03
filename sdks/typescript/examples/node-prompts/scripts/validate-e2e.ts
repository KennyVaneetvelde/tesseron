/**
 * End-to-end validation of the prompt-lab domain (used by examples/node-prompts
 * and examples/express-prompts). Acts as a reference MCP client that speaks the
 * parts of the MCP spec Claude Code currently does not: `sampling/createMessage`
 * and `elicitation/create`.
 *
 * Architecture (matches how Claude Code runs Tesseron in production):
 *
 *   ┌─────────────────── this process ─────────────────┐       ┌────── subprocess ──────┐
 *   │                                                   │       │                         │
 *   │   ServerTesseronClient  (prompt-lab actions)      │       │   tesseron-mcp CLI      │
 *   │           │                                       │       │   (MCP over stdio)      │
 *   │           │ WebSocket (loopback)                  │       │   + TesseronGateway     │
 *   │           ▼                                       │       │                         │
 *   │         ~/.tesseron/tabs/<id>.json  ◀───── watch ─┼──────▶│      dials back         │
 *   │                                                   │       │                         │
 *   │   MCP Client (sampling + elicitation capable)     │       │                         │
 *   │           │ StdioClientTransport ◀───────────────┼──────▶│ StdioServerTransport    │
 *   └──────────────────────────────────────────────────┘       └─────────────────────────┘
 *
 * The MCP client advertises { sampling: {}, elicitation: {} } and routes both
 * request types through scripted handlers so we can deterministically exercise
 * every action the examples expose (including ctx.sample / ctx.elicit /
 * ctx.confirm / ctx.progress).
 *
 * Isolation: tab discovery lives in `$HOME/.tesseron/tabs/`. To avoid racing
 * with Claude Code or Claude Desktop's live gateway, this script overrides
 * `USERPROFILE` / `HOME` to a temp dir for the subprocess AND for this process
 * (before any Tesseron import) so `os.homedir()` points at the sandbox on both
 * sides.
 *
 * Exit code: 0 on pass, 1 on first failure.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Reroute homedir() BEFORE any Tesseron module is loaded.
const sandbox = mkdtempSync(join(tmpdir(), 'tesseron-validate-'));
process.env['USERPROFILE'] = sandbox;
process.env['HOME'] = sandbox;
// On Windows, homedir() falls back to HOMEDRIVE+HOMEPATH if USERPROFILE is
// empty; clearing these makes USERPROFILE unambiguous.
process.env['HOMEDRIVE'] = '';
process.env['HOMEPATH'] = '';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function head(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`);
}
function ok(label: string): void {
  passed += 1;
  process.stdout.write(`  ok ${label}\n`);
}
function bad(label: string, detail: string): void {
  failed += 1;
  failures.push(`${label}: ${detail}`);
  process.stdout.write(`  FAIL ${label}\n    ${detail}\n`);
}

async function main(): Promise<void> {
  // Dynamic imports so the env overrides above take effect before
  // @tesseron/server's transport module captures homedir().
  const [
    { Client },
    { StdioClientTransport },
    types,
    { ServerTesseronClient },
    promptLab,
  ] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/types.js'),
    import('@tesseron/server'),
    import('../src/prompt-lab.js'),
  ]);
  const { registerPromptLab } = promptLab;
  const {
    CallToolResultSchema,
    CreateMessageRequestSchema,
    ElicitRequestSchema,
    ListToolsResultSchema,
    ProgressNotificationSchema,
    ReadResourceResultSchema,
  } = types;

  // --- Spawn the real CLI gateway subprocess -----------------------
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  const mcpPkgCwd = pathResolve(scriptDir, '../../../packages/mcp');
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--import', 'tsx/esm', 'src/cli.ts'],
    cwd: mcpPkgCwd,
    env: {
      ...(process.env as Record<string, string>),
      USERPROFILE: sandbox,
      HOME: sandbox,
      HOMEDRIVE: '',
      HOMEPATH: '',
    },
    stderr: 'pipe',
  });

  // Surface gateway stderr for diagnosis if things go wrong.
  if (transport.stderr) {
    transport.stderr.setEncoding('utf-8');
    transport.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) process.stdout.write(`[gw] ${line}\n`);
      }
    });
  }

  const client = new Client(
    { name: 'prompt-lab-validator', version: '0.0.0' },
    { capabilities: { sampling: {}, elicitation: {} } },
  );

  // Canned sampling handler.
  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    const first = request.params.messages[0];
    const content = first?.content;
    const text =
      content && typeof content === 'object' && 'type' in content && content.type === 'text'
        ? (content as { text: string }).text
        : '';

    if (text.startsWith('Produce exactly ')) {
      const count = Number(text.match(/Produce exactly (\d+)/)?.[1] ?? '3');
      const variants = Array.from(
        { length: count },
        (_, i) => `variant ${i + 1}: rewritten prompt body that is at least ten chars long`,
      );
      return {
        role: 'assistant',
        model: 'stub-model',
        content: { type: 'text', text: JSON.stringify({ variants }) },
      };
    }

    if (text.startsWith('You rewrite prompt templates.')) {
      return {
        role: 'assistant',
        model: 'stub-model',
        content: { type: 'text', text: 'REFINED: concise three-bullet summary of: {{text}}' },
      };
    }

    return {
      role: 'assistant',
      model: 'stub-model',
      content: { type: 'text', text: `LLM response to: ${text.slice(0, 80)}` },
    };
  });

  // Canned elicitation handler.
  let elicitAnswer: Record<string, unknown> = { instruction: 'make it more concise' };
  let elicitCancel = false;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    if (elicitCancel) return { action: 'cancel' };
    return { action: 'accept', content: elicitAnswer };
  });

  await client.connect(transport);

  // --- SDK side (prompt lab app) -----------------------------------
  const sdk = new ServerTesseronClient();
  const lab = registerPromptLab(sdk, {
    appId: 'prompt_lab',
    appName: 'Prompt Lab (validator)',
  });
  const welcome = await sdk.connect();
  const claim = welcome.claimCode!;

  // Claim the session via MCP. Because the CLI gateway defaults to
  // TESSERON_TOOL_SURFACE=both, the SDK's per-app tools appear in the MCP
  // tool list after the claim.
  const claimResult = await client.request(
    {
      method: 'tools/call',
      params: { name: 'tesseron__claim_session', arguments: { code: claim } },
    },
    CallToolResultSchema,
  );
  if (claimResult.isError) {
    throw new Error(`claim_session failed: ${JSON.stringify(claimResult.content)}`);
  }
  // Give the gateway a moment to emit tools/list_changed.
  await delay(100);

  // --- Progress capture --------------------------------------------
  const progressLog: Array<{ progress: number; message?: string }> = [];
  client.setNotificationHandler(ProgressNotificationSchema, (n) => {
    progressLog.push({ progress: n.params.progress, message: n.params.message });
  });

  async function callTool(
    name: string,
    args: unknown,
    opts?: { progressToken?: string },
  ): Promise<{
    text: string;
    isError: boolean;
    progress: Array<{ progress: number; message?: string }>;
  }> {
    const startIdx = progressLog.length;
    const params: {
      name: string;
      arguments?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    } = { name, arguments: (args ?? {}) as Record<string, unknown> };
    if (opts?.progressToken) params._meta = { progressToken: opts.progressToken };
    const result = await client.request({ method: 'tools/call', params }, CallToolResultSchema);
    await delay(50);
    const progress = progressLog.slice(startIdx);
    const text = result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('');
    return { text, isError: result.isError === true, progress };
  }

  async function readResource(uri: string): Promise<unknown> {
    const result = await client.request(
      { method: 'resources/read', params: { uri } },
      ReadResourceResultSchema,
    );
    const txt = result.contents[0];
    if (!txt || !('text' in txt)) throw new Error('resource returned no text content');
    return JSON.parse(txt.text as string);
  }

  // --- Pre-flight: list tools --------------------------------------
  head('tools/list');
  const tools = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
  const names = tools.tools.map((t) => t.name);
  const required = [
    'prompt_lab__addPrompt',
    'prompt_lab__listPrompts',
    'prompt_lab__deletePrompt',
    'prompt_lab__testPrompt',
    'prompt_lab__refinePrompt',
    'prompt_lab__generateVariants',
    'prompt_lab__importPrompts',
    'prompt_lab__purgeAll',
  ];
  for (const n of required) {
    if (names.includes(n)) ok(`tool exposed: ${n}`);
    else bad(`tool exposed: ${n}`, `missing from ${names.join(', ')}`);
  }

  // --- addPrompt ---------------------------------------------------
  head('addPrompt');
  {
    const r = await callTool('prompt_lab__addPrompt', {
      name: 'summarize',
      template: 'Summarize in three bullets: {{text}}',
      tags: ['summary'],
    });
    if (r.isError) bad('addPrompt call', r.text);
    else ok('addPrompt call');
    const parsed = JSON.parse(r.text);
    if (parsed.id === 'p1') ok('id is p1');
    else bad('id is p1', `got ${parsed.id}`);
    if (parsed.template.includes('{{text}}')) ok('template preserved');
    else bad('template preserved', JSON.stringify(parsed));
  }

  // --- listPrompts -------------------------------------------------
  head('listPrompts');
  {
    const r = await callTool('prompt_lab__listPrompts', {});
    const parsed = JSON.parse(r.text);
    if (Array.isArray(parsed) && parsed.length === 1) ok('library has one entry');
    else bad('library has one entry', `got ${r.text}`);

    const tagged = JSON.parse(
      (await callTool('prompt_lab__listPrompts', { tag: 'summary' })).text,
    );
    if (Array.isArray(tagged) && tagged.length === 1) ok('tag filter matches');
    else bad('tag filter matches', JSON.stringify(tagged));

    const other = JSON.parse(
      (await callTool('prompt_lab__listPrompts', { tag: 'nonexistent' })).text,
    );
    if (Array.isArray(other) && other.length === 0) ok('unmatched tag returns empty');
    else bad('unmatched tag returns empty', JSON.stringify(other));
  }

  // --- resource library --------------------------------------------
  head('resources/read tesseron://prompt_lab/library');
  {
    const r = (await readResource('tesseron://prompt_lab/library')) as Array<{ id: string }>;
    if (Array.isArray(r) && r.length === 1 && r[0]?.id === 'p1') ok('library resource matches');
    else bad('library resource matches', JSON.stringify(r));
  }

  // --- importPrompts (progress) ------------------------------------
  head('importPrompts (streams progress)');
  {
    const r = await callTool(
      'prompt_lab__importPrompts',
      {
        items: [
          { name: 'classify', template: 'Classify: {{text}}' },
          { name: 'translate', template: 'Translate to {{lang}}: {{text}}' },
          { name: 'extract', template: 'Extract entities: {{text}}' },
        ],
      },
      { progressToken: 'import-1' },
    );
    if (r.isError) bad('importPrompts call', r.text);
    else ok('importPrompts call');
    const parsed = JSON.parse(r.text);
    if (parsed.added === 3 && parsed.ids.length === 3) ok('added 3');
    else bad('added 3', JSON.stringify(parsed));
    if (r.progress.length >= 3) ok(`progress notifications received (${r.progress.length})`);
    else
      bad(
        'progress notifications received',
        `only ${r.progress.length}: ${JSON.stringify(r.progress)}`,
      );
    const last = r.progress[r.progress.length - 1];
    if (last?.progress === 100) ok('progress reaches 100');
    else bad('progress reaches 100', JSON.stringify(last));
  }

  // --- testPrompt (ctx.sample free-text) ---------------------------
  head('testPrompt (ctx.sample)');
  {
    const r = await callTool('prompt_lab__testPrompt', {
      id: 'p1',
      variables: { text: 'the quick brown fox' },
    });
    if (r.isError) bad('testPrompt call', r.text);
    else ok('testPrompt call');
    const parsed = JSON.parse(r.text);
    if (typeof parsed.response === 'string' && parsed.response.startsWith('LLM response to:'))
      ok('response came from sampling handler');
    else bad('response came from sampling handler', JSON.stringify(parsed));
    if (parsed.timesTested === 1) ok('timesTested bumped');
    else bad('timesTested bumped', JSON.stringify(parsed));

    const lastTest = (await readResource('tesseron://prompt_lab/lastTest')) as {
      promptId: string;
      response: string;
    } | null;
    if (lastTest && lastTest.promptId === 'p1') ok('lastTest resource updated');
    else bad('lastTest resource updated', JSON.stringify(lastTest));
  }

  // --- refinePrompt (ctx.elicit + ctx.sample) ----------------------
  head('refinePrompt (ctx.elicit + ctx.sample)');
  {
    elicitAnswer = { instruction: 'make it more concise' };
    elicitCancel = false;
    const r = await callTool('prompt_lab__refinePrompt', { id: 'p1' });
    if (r.isError) bad('refinePrompt call', r.text);
    else ok('refinePrompt call');
    const parsed = JSON.parse(r.text);
    if (parsed.refined === true) ok('refined=true');
    else bad('refined=true', JSON.stringify(parsed));
    if (parsed.instruction === 'make it more concise') ok('instruction plumbed through');
    else bad('instruction plumbed through', JSON.stringify(parsed));
    if (String(parsed.newTemplate).startsWith('REFINED:'))
      ok('template replaced with sampled output');
    else bad('template replaced with sampled output', JSON.stringify(parsed));
  }

  // --- refinePrompt cancellation -----------------------------------
  head('refinePrompt (user cancels elicitation)');
  {
    elicitCancel = true;
    const r = await callTool('prompt_lab__refinePrompt', { id: 'p1' });
    const parsed = JSON.parse(r.text);
    if (parsed.refined === false && parsed.cancelled === true)
      ok('cancelled path returns gracefully');
    else bad('cancelled path returns gracefully', JSON.stringify(parsed));
    elicitCancel = false;
  }

  // --- generateVariants (ctx.sample with Zod schema + progress) ----
  head('generateVariants (ctx.sample with schema)');
  {
    const r = await callTool(
      'prompt_lab__generateVariants',
      { id: 'p1', count: 3 },
      { progressToken: 'var-1' },
    );
    if (r.isError) bad('generateVariants call', r.text);
    else ok('generateVariants call');
    const parsed = JSON.parse(r.text);
    if (parsed.added === 3 && parsed.ids.length === 3) ok('added 3 variants');
    else bad('added 3 variants', JSON.stringify(parsed));
    if (r.progress.length >= 3) ok(`progress notifications received (${r.progress.length})`);
    else bad('progress notifications received', JSON.stringify(r.progress));

    const library = (await readResource('tesseron://prompt_lab/library')) as Array<{
      tags: string[];
    }>;
    const variants = library.filter((p) => p.tags.includes('variant'));
    if (variants.length === 3) ok('variants tagged correctly');
    else bad('variants tagged correctly', `got ${variants.length}`);
  }

  // --- deletePrompt (ctx.confirm) ----------------------------------
  //
  // `ctx.confirm` is encoded by the SDK as an elicitation request with an
  // empty-object schema. Our handler accepts → confirm returns true; cancel
  // → confirm returns false.
  head('deletePrompt (ctx.confirm accepted)');
  {
    elicitAnswer = {};
    elicitCancel = false;
    const beforeLib = lab.getLibrary().length;
    const r = await callTool('prompt_lab__deletePrompt', { id: 'p1' });
    if (r.isError) bad('deletePrompt (accept) call', r.text);
    else ok('deletePrompt (accept) call');
    const parsed = JSON.parse(r.text);
    if (parsed.deleted === true) ok('deleted=true');
    else bad('deleted=true', JSON.stringify(parsed));
    if (lab.getLibrary().length === beforeLib - 1) ok('library shrunk by 1');
    else bad('library shrunk by 1', `before=${beforeLib} after=${lab.getLibrary().length}`);
  }

  head('deletePrompt (user cancels ctx.confirm)');
  {
    const libraryNow = lab.getLibrary();
    const victim = libraryNow[0];
    if (!victim) {
      bad('deletePrompt cancel', 'no prompt to delete');
    } else {
      elicitCancel = true;
      const r = await callTool('prompt_lab__deletePrompt', { id: victim.id });
      elicitCancel = false;
      if (r.isError) bad('deletePrompt (cancel) call', r.text);
      else ok('deletePrompt (cancel) call');
      const parsed = JSON.parse(r.text);
      if (parsed.cancelled === true && parsed.deleted === false)
        ok('cancel leaves prompt in place');
      else bad('cancel leaves prompt in place', JSON.stringify(parsed));
      if (lab.getPrompt(victim.id)) ok('prompt still present after cancel');
      else bad('prompt still present after cancel', 'victim was removed despite cancel');
    }
  }

  // --- purgeAll (typed-DELETE elicitation) -------------------------
  head('purgeAll (wrong confirmation text)');
  {
    elicitAnswer = { confirmation: 'yes' };
    elicitCancel = false;
    const r = await callTool('prompt_lab__purgeAll', {});
    const parsed = JSON.parse(r.text);
    if (parsed.cancelled === true && parsed.removed === 0) ok("'yes' does not count as 'DELETE'");
    else bad("'yes' does not count as 'DELETE'", JSON.stringify(parsed));
    if (lab.size() > 0) ok('library untouched');
    else bad('library untouched', 'purge succeeded on wrong confirmation');
  }

  head('purgeAll (correct DELETE)');
  {
    const before = lab.size();
    elicitAnswer = { confirmation: 'DELETE' };
    const r = await callTool('prompt_lab__purgeAll', {});
    const parsed = JSON.parse(r.text);
    if (parsed.removed === before) ok(`removed all ${before}`);
    else bad(`removed all ${before}`, JSON.stringify(parsed));
    if (lab.size() === 0) ok('library empty');
    else bad('library empty', `size=${lab.size()}`);
    const lastTest = await readResource('tesseron://prompt_lab/lastTest');
    if (lastTest === null) ok('lastTest cleared to null');
    else bad('lastTest cleared to null', JSON.stringify(lastTest));
  }

  // --- teardown ----------------------------------------------------
  await sdk.disconnect().catch(() => {});
  await client.close().catch(() => {});
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // best effort
  }

  head('summary');
  process.stdout.write(`  passed: ${passed}\n  failed: ${failed}\n`);
  if (failed > 0) {
    process.stdout.write('\nfailures:\n');
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exit(1);
  }
  process.stdout.write('\nall end-to-end checks passed.\n');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[validate] fatal: ${(err as Error).stack ?? (err as Error).message}\n`);
  process.exit(1);
});

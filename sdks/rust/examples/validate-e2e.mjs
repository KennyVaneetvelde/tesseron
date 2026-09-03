import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const examplesDirectory = dirname(fileURLToPath(import.meta.url));
const rustDirectory = resolve(examplesDirectory, '..');
const repositoryDirectory = resolve(rustDirectory, '../..');
const gatewayDirectory = join(repositoryDirectory, 'gateway');
const sandbox = mkdtempSync(join(tmpdir(), 'tesseron-rust-examples-'));
const gatewayRequire = createRequire(join(gatewayDirectory, 'package.json'));
const systemEnvironment = { ...process.env };
const executableSuffix = process.platform === 'win32' ? '.exe' : '';

process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
process.env.HOMEDRIVE = '';
process.env.HOMEPATH = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pass(message) {
  process.stdout.write(`PASS ${message}\n`);
}

async function importFrom(requireFunction, packageName) {
  return import(pathToFileURL(requireFunction.resolve(packageName)).href);
}

function buildExamples() {
  const result = spawnSync(
    'cargo',
    [
      'build',
      '--manifest-path',
      join(rustDirectory, 'Cargo.toml'),
      '-p',
      'tesseron-todo-example',
      '-p',
      'tesseron-prompts-example',
    ],
    { cwd: repositoryDirectory, encoding: 'utf8', env: systemEnvironment },
  );
  if (result.status !== 0) {
    throw new Error(`cargo build failed:\n${result.stdout}\n${result.stderr}`);
  }
  pass('cargo built both Rust examples');
}

function startExample(name) {
  const executable = join(rustDirectory, 'target', 'debug', `${name}${executableSuffix}`);
  const child = spawn(executable, [], {
    cwd: repositoryDirectory,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let standardError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    standardError += chunk;
  });
  const claimCode = new Promise((resolveClaim, rejectClaim) => {
    let standardOutput = '';
    const timeout = setTimeout(() => {
      rejectClaim(new Error(`${name} did not print a claim code. stderr: ${standardError}`));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      standardOutput += chunk;
      const match = standardOutput.match(/^Claim code: (.+)$/m);
      if (match?.[1]) {
        clearTimeout(timeout);
        resolveClaim(match[1].trim());
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectClaim(error);
    });
    child.once('exit', (code) => {
      if (!standardOutput.match(/^Claim code: (.+)$/m)) {
        clearTimeout(timeout);
        rejectClaim(new Error(`${name} exited before claiming (${code}). stderr: ${standardError}`));
      }
    });
  });
  return { child, claimCode, standardError: () => standardError };
}

function createGatewayTransport(StdioClientTransport) {
  return new StdioClientTransport({
    command: 'node',
    args: ['--import', pathToFileURL(gatewayRequire.resolve('tsx/esm')).href, 'src/cli.ts'],
    cwd: gatewayDirectory,
    env: process.env,
    stderr: 'pipe',
  });
}

async function closeHost(host) {
  if (host.child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => host.child.once('exit', resolveExit));
  if (!host.child.killed) host.child.kill();
  await Promise.race([exited, new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000))]);
}

async function callTool(client, CallToolResultSchema, name, arguments_, progressToken) {
  const params = { name, arguments: arguments_ };
  if (progressToken) params._meta = { progressToken };
  const result = await client.request({ method: 'tools/call', params }, CallToolResultSchema);
  const text = result.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('');
  return { isError: result.isError === true, text };
}

async function claim(client, CallToolResultSchema, code) {
  const result = await callTool(client, CallToolResultSchema, 'tesseron__claim_session', { code });
  assert(!result.isError, `claim_session failed: ${result.text}`);
}

async function validateTodo(api) {
  const {
    Client,
    StdioClientTransport,
    CallToolResultSchema,
    ProgressNotificationSchema,
    ReadResourceResultSchema,
    ResourceUpdatedNotificationSchema,
    EmptyResultSchema,
    ListToolsResultSchema,
  } = api;
  const host = startExample('tesseron-todo-example');
  const transport = createGatewayTransport(StdioClientTransport);
  const client = new Client(
    { name: 'rust-todo-validator', version: '0.0.0' },
    { capabilities: {} },
  );
  const progress = [];
  const resourceUpdates = [];
  let resolveResourceUpdate;
  const resourceUpdate = new Promise((resolveUpdate) => {
    resolveResourceUpdate = resolveUpdate;
  });
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
    progress.push(notification.params);
  });
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
    resourceUpdates.push(notification.params.uri);
    resolveResourceUpdate?.(notification.params.uri);
  });

  try {
    await client.connect(transport);
    await claim(client, CallToolResultSchema, await host.claimCode);

    const tools = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
    const names = new Set(tools.tools.map((tool) => tool.name));
    const canonicalActions = [
      'rust_todo__addTodo',
      'rust_todo__toggleTodo',
      'rust_todo__deleteTodo',
      'rust_todo__listTodos',
      'rust_todo__clearCompleted',
      'rust_todo__renameTodo',
      'rust_todo__importTodos',
      'rust_todo__suggestTodos',
    ];
    assert(
      canonicalActions.every((name) => names.has(name)) && !names.has('rust_todo__setFilter'),
      `todo action set was ${[...names].join(', ')}`,
    );
    pass('todo exposes the canonical action set without setFilter');
    const addSchema = tools.tools.find((tool) => tool.name === 'rust_todo__addTodo')?.inputSchema;
    const importSchema = tools.tools.find((tool) => tool.name === 'rust_todo__importTodos')?.inputSchema;
    const suggestSchema = tools.tools.find((tool) => tool.name === 'rust_todo__suggestTodos')?.inputSchema;
    assert(
      addSchema?.properties?.text?.minLength === 1 &&
        importSchema?.properties?.items?.minItems === 1 &&
        importSchema?.properties?.items?.maxItems === 50 &&
        suggestSchema?.properties?.theme?.minLength === 1 &&
        suggestSchema?.properties?.count?.minimum === 1 &&
        suggestSchema?.properties?.count?.maximum === 10,
      'todo input schemas drifted from the canonical contract',
    );
    pass('todo action schemas keep their canonical constraints');

    const listed = await callTool(client, CallToolResultSchema, 'rust_todo__listTodos', {});
    assert(!listed.isError && JSON.parse(listed.text).length === 0, 'listTodos did not return an empty list');
    pass('todo listTodos reads empty in-memory state');

    const added = await callTool(client, CallToolResultSchema, 'rust_todo__addTodo', {
      text: 'write e2e coverage',
      tag: 'rust',
    });
    assert(!added.isError, `addTodo failed: ${added.text}`);
    const todo = JSON.parse(added.text);
    assert(todo.text === 'write e2e coverage' && todo.done === false, `addTodo returned ${added.text}`);
    pass('todo addTodo returns the created todo');

    const progressStart = progress.length;
    const imported = await callTool(
      client,
      CallToolResultSchema,
      'rust_todo__importTodos',
      { items: ['first imported todo', 'second imported todo'], tag: 'batch' },
      'rust-todo-import',
    );
    assert(!imported.isError, `importTodos failed: ${imported.text}`);
    const importProgress = progress.slice(progressStart);
    assert(
      importProgress.length === 2 &&
        importProgress[0]?.message === '1/2 imported' &&
        importProgress[1]?.message === '2/2 imported',
      `importTodos progress was ${JSON.stringify(importProgress)}`,
    );
    pass('todo importTodos emits one progress notification per item');

    const toggled = await callTool(client, CallToolResultSchema, 'rust_todo__toggleTodo', { id: todo.id });
    assert(!toggled.isError && JSON.parse(toggled.text).done === true, `toggleTodo returned ${toggled.text}`);
    pass('todo toggleTodo changes the todo state');

    const todosUri = 'tesseron://rust_todo/todos://all';
    const resource = await client.request(
      { method: 'resources/read', params: { uri: todosUri } },
      ReadResourceResultSchema,
    );
    const todos = JSON.parse(resource.contents[0]?.text ?? 'null');
    assert(
      Array.isArray(todos) && todos.some((item) => item.id === todo.id && item.done === true),
      `todos://all returned ${JSON.stringify(todos)}`,
    );
    pass('todo todos://all reads the current list');

    await client.request({ method: 'resources/subscribe', params: { uri: todosUri } }, EmptyResultSchema);
    const deleted = await callTool(client, CallToolResultSchema, 'rust_todo__deleteTodo', { id: todo.id });
    assert(!deleted.isError && JSON.parse(deleted.text).removed === true, `deleteTodo returned ${deleted.text}`);
    const updatedUri = await Promise.race([
      resourceUpdate,
      new Promise((_, reject) => setTimeout(() => reject(new Error('deleteTodo did not update todos://all')), 3_000)),
    ]);
    assert(updatedUri === todosUri && resourceUpdates.includes(todosUri), 'resource update used the wrong URI');
    pass('todo deleteTodo pushes a todos://all subscription update');

    const missing = await callTool(client, CallToolResultSchema, 'rust_todo__toggleTodo', { id: 'missing' });
    assert(
      missing.isError && missing.text.includes('not_found'),
      `unknown todo did not return not_found: ${missing.text}`,
    );
    pass('todo unknown id returns HandlerError not_found');
  } finally {
    await client.close().catch(() => {});
    await closeHost(host);
  }
}

async function validatePrompts(api) {
  const {
    Client,
    StdioClientTransport,
    CallToolResultSchema,
    CreateMessageRequestSchema,
    ElicitRequestSchema,
    ListToolsResultSchema,
  } = api;
  const host = startExample('tesseron-prompts-example');
  const transport = createGatewayTransport(StdioClientTransport);
  const client = new Client(
    { name: 'rust-prompts-validator', version: '0.0.0' },
    { capabilities: { sampling: {}, elicitation: {} } },
  );
  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    const content = request.params.messages[0]?.content;
    const prompt = content && content.type === 'text' ? content.text : '';
    return {
      role: 'assistant',
      model: 'validator',
      content: { type: 'text', text: `sampled response for: ${prompt}` },
    };
  });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: {} }));

  try {
    await client.connect(transport);
    await claim(client, CallToolResultSchema, await host.claimCode);

    const tools = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
    const names = new Set(tools.tools.map((tool) => tool.name));
    const canonicalActions = [
      'rust_prompts__addPrompt',
      'rust_prompts__listPrompts',
      'rust_prompts__deletePrompt',
      'rust_prompts__testPrompt',
      'rust_prompts__refinePrompt',
      'rust_prompts__generateVariants',
      'rust_prompts__importPrompts',
      'rust_prompts__purgeAll',
    ];
    assert(
      canonicalActions.every((name) => names.has(name)),
      `prompt action set was ${[...names].join(', ')}`,
    );
    pass('prompts exposes the canonical action set');
    const addSchema = tools.tools.find((tool) => tool.name === 'rust_prompts__addPrompt')?.inputSchema;
    const importSchema = tools.tools.find((tool) => tool.name === 'rust_prompts__importPrompts')?.inputSchema;
    const variantsSchema = tools.tools.find((tool) => tool.name === 'rust_prompts__generateVariants')?.inputSchema;
    assert(
      addSchema?.properties?.name?.minLength === 1 &&
        addSchema?.properties?.template?.minLength === 1 &&
        importSchema?.properties?.items?.minItems === 1 &&
        importSchema?.properties?.items?.maxItems === 50 &&
        variantsSchema?.properties?.count?.minimum === 1 &&
        variantsSchema?.properties?.count?.maximum === 10,
      'prompt input schemas drifted from the canonical contract',
    );
    pass('prompt action schemas keep their canonical constraints');

    const added = await callTool(client, CallToolResultSchema, 'rust_prompts__addPrompt', {
      name: 'summarize',
      template: 'Summarize: {{text}}',
      tags: ['summary'],
    });
    assert(!added.isError, `addPrompt failed: ${added.text}`);
    const prompt = JSON.parse(added.text);
    assert(prompt.id === 'p1', `addPrompt returned ${added.text}`);
    pass('prompts addPrompt creates the canonical prompt');

    const tested = await callTool(client, CallToolResultSchema, 'rust_prompts__testPrompt', {
      id: prompt.id,
      variables: { text: 'a Rust gateway test' },
    });
    assert(!tested.isError, `testPrompt failed: ${tested.text}`);
    const testResult = JSON.parse(tested.text);
    assert(
      testResult.response.startsWith('sampled response for: Summarize: a Rust gateway test'),
      `testPrompt did not use the sampling responder: ${tested.text}`,
    );
    pass('prompts testPrompt uses the fake sampling responder');

    const deleted = await callTool(client, CallToolResultSchema, 'rust_prompts__deletePrompt', { id: prompt.id });
    assert(!deleted.isError && JSON.parse(deleted.text).deleted === true, `deletePrompt returned ${deleted.text}`);
    pass('prompts deletePrompt uses the confirm responder');
  } finally {
    await client.close().catch(() => {});
    await closeHost(host);
  }
}

async function main() {
  buildExamples();
  const [clientModule, transportModule, types] = await Promise.all([
    importFrom(gatewayRequire, '@modelcontextprotocol/sdk/client/index.js'),
    importFrom(gatewayRequire, '@modelcontextprotocol/sdk/client/stdio.js'),
    importFrom(gatewayRequire, '@modelcontextprotocol/sdk/types.js'),
  ]);
  const api = { ...clientModule, ...transportModule, ...types };
  await validateTodo(api);
  await validatePrompts(api);
}

main()
  .catch((error) => {
    process.stderr.write(`[validate] ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

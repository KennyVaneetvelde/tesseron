import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const exampleDirectory = resolve(scriptDirectory, '..');
const repositoryDirectory = resolve(exampleDirectory, '../../../..');
const gatewayDirectory = join(repositoryDirectory, 'gateway');
const sandbox = mkdtempSync(join(tmpdir(), 'tesseron-vanilla-todo-'));

process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
process.env.HOMEDRIVE = '';
process.env.HOMEPATH = '';

const gatewayRequire = createRequire(join(gatewayDirectory, 'package.json'));

async function importFrom(requireFunction, packageName) {
  return import(pathToFileURL(requireFunction.resolve(packageName)).href);
}

async function waitForConnection(document) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (document.querySelector('[data-status="open"]')) return;
    await delay(50);
  }
  const card = document.querySelector('.connect-card');
  throw new Error(`Vanilla todo did not connect: ${card?.textContent?.trim() ?? 'no connect card rendered'}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const [{ createServer }, { JSDOM }, wsModule, { Client }, { StdioClientTransport }, types] =
    await Promise.all([
      import('vite'),
      importFrom(createRequire(join(repositoryDirectory, 'sdks/typescript/web/package.json')), 'jsdom'),
      importFrom(gatewayRequire, 'ws'),
      importFrom(gatewayRequire, '@modelcontextprotocol/sdk/client/index.js'),
      importFrom(gatewayRequire, '@modelcontextprotocol/sdk/client/stdio.js'),
      importFrom(gatewayRequire, '@modelcontextprotocol/sdk/types.js'),
    ]);
  const { CallToolResultSchema, ProgressNotificationSchema, ReadResourceResultSchema } = types;
  const WebSocket = wsModule.WebSocket ?? wsModule.default;
  const gatewayTransport = new StdioClientTransport({
    command: 'node',
    args: ['--import', pathToFileURL(gatewayRequire.resolve('tsx/esm')).href, 'src/cli.ts'],
    cwd: gatewayDirectory,
    env: { ...process.env },
    stderr: 'pipe',
  });
  const gatewayClient = new Client(
    { name: 'vanilla-todo-validator', version: '0.0.0' },
    { capabilities: {} },
  );
  const viteServer = await createServer({
    root: exampleDirectory,
    configFile: join(exampleDirectory, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
  });
  let dom;
  const originalGlobals = new Map();

  try {
    await viteServer.listen();
    const serverAddress = viteServer.httpServer?.address();
    assert(serverAddress && typeof serverAddress !== 'string', 'Vite did not expose a TCP address');
    const pageUrl = `http://127.0.0.1:${serverAddress.port}`;
    dom = new JSDOM('<div id="root"></div>', { url: pageUrl });
    for (const [name, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      location: dom.window.location,
      localStorage: dom.window.localStorage,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      HTMLButtonElement: dom.window.HTMLButtonElement,
      Event: dom.window.Event,
      EventTarget: dom.window.EventTarget,
      Node: dom.window.Node,
      WebSocket,
    })) {
      originalGlobals.set(name, globalThis[name]);
      Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    await viteServer.ssrLoadModule('/src/main.ts');
    await waitForConnection(dom.window.document);
    await gatewayClient.connect(gatewayTransport);
    await delay(150);
    const claimCode = dom.window.document.querySelector('.claim-code')?.textContent;
    assert(claimCode, 'Vanilla todo did not render a claim code');

    const claimResult = await gatewayClient.request(
      {
        method: 'tools/call',
        params: { name: 'tesseron__claim_session', arguments: { code: claimCode } },
      },
      CallToolResultSchema,
    );
    assert(!claimResult.isError, `claim_session failed: ${JSON.stringify(claimResult.content)}`);
    await delay(100);

    const progressUpdates = [];
    gatewayClient.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      progressUpdates.push(notification.params);
    });

    const addResult = await gatewayClient.request(
      {
        method: 'tools/call',
        params: {
          name: 'vanilla_todo__addTodo',
          arguments: { text: 'todo from vanilla e2e' },
        },
      },
      CallToolResultSchema,
    );
    assert(!addResult.isError, `addTodo failed: ${JSON.stringify(addResult.content)}`);

    const resourceResult = await gatewayClient.request(
      {
        method: 'resources/read',
        params: { uri: 'tesseron://vanilla_todo/todos://all' },
      },
      ReadResourceResultSchema,
    );
    const resourceText = resourceResult.contents[0]?.text;
    assert(typeof resourceText === 'string', 'todos://all returned no text content');
    const todos = JSON.parse(resourceText);
    assert(
      Array.isArray(todos) && todos.some((todo) => todo?.text === 'todo from vanilla e2e'),
      `todos://all did not contain the todo created by addTodo: ${resourceText}`,
    );

    const importResult = await gatewayClient.request(
      {
        method: 'tools/call',
        params: {
          name: 'vanilla_todo__importTodos',
          arguments: { items: ['first imported todo', 'second imported todo'] },
          _meta: { progressToken: 'vanilla-todo-import' },
        },
      },
      CallToolResultSchema,
    );
    assert(!importResult.isError, `importTodos failed: ${JSON.stringify(importResult.content)}`);
    await delay(50);
    const importMessages = progressUpdates.map((update) => update.message);
    assert(
      importMessages.includes('1/2 imported') && importMessages.includes('2/2 imported'),
      `importTodos did not emit progress for each item: ${JSON.stringify(progressUpdates)}`,
    );

    process.stdout.write('PASS vanilla app connected through the Vite gateway bridge\n');
    process.stdout.write('PASS todos://all resource included the todo created by addTodo\n');
    process.stdout.write('PASS importTodos emitted one progress update per item\n');
  } finally {
    await gatewayClient.close().catch(() => {});
    await viteServer.close().catch(() => {});
    dom?.window.close();
    for (const [name, value] of originalGlobals) {
      Object.defineProperty(globalThis, name, { configurable: true, value });
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`[validate] ${(error instanceof Error ? error.stack : String(error))}\n`);
  process.exitCode = 1;
});

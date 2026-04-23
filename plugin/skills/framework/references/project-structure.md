# Project structure

## Contents
- Stack choices
- Vanilla TypeScript + Vite (browser)
- React + Vite
- Headless Node service
- Express + Tesseron hybrid
- `package.json` templates (with pinned versions)
- `tsconfig.json` baseline
- `.gitignore` baseline
- Multi-package / monorepo layout
- Common mistakes

## Stack choices

Tesseron is framework-agnostic. The four canonical shapes:

| Stack | Package | When |
|---|---|---|
| Vanilla TS + Vite | `@tesseron/web` | Simplest browser app; no framework |
| React + Vite | `@tesseron/react` | Component-scoped actions/resources; hook ergonomics |
| Svelte / Vue + Vite | `@tesseron/web` | Use the web singleton from setup/$effect blocks |
| Headless Node | `@tesseron/server` | Backend service, CLI, daemon, MCP tool provider without a UI |
| HTTP + Tesseron hybrid | `@tesseron/server` + express/fastify | Service that serves HTTP AND exposes Claude-invocable actions |

## Vanilla TypeScript + Vite (browser)

```
my-app/
├── src/
│   ├── index.html
│   └── main.ts
├── package.json
├── tsconfig.json
└── vite.config.ts
```

**`src/index.html`:**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>My Tesseron App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

**`src/main.ts`:**

```ts
import { tesseron } from '@tesseron/web';
import { z } from 'zod';

tesseron.app({
  id: 'my_app',
  name: 'My Tesseron App',
  description: 'A web app driven by Claude.',
});

let counter = 0;

tesseron
  .action('increment')
  .describe('Increment the counter. Returns the new value.')
  .input(z.object({ by: z.number().int().default(1) }))
  .output(z.object({ value: z.number().int() }))
  .handler(({ by }) => ({ value: (counter += by) }));

tesseron
  .resource('counter')
  .describe('Current counter value.')
  .output(z.number().int())
  .read(() => counter);

const welcome = await tesseron.connect();
console.log(`Claim code: ${welcome.claimCode}`);
```

## React + Vite

```
my-react-app/
├── src/
│   ├── index.html
│   ├── main.tsx
│   ├── App.tsx
│   └── Todos.tsx
├── package.json
├── tsconfig.json
└── vite.config.ts
```

**`src/main.tsx`:**

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('app')!).render(<App />);
```

**`src/App.tsx`:**

```tsx
import { useTesseronConnection } from '@tesseron/react';
import { Todos } from './Todos';

export function App() {
  const conn = useTesseronConnection();

  if (conn.status === 'error') return <div>Error: {conn.error?.message}</div>;
  if (conn.claimCode) return <div>Say to Claude: <code>claim session {conn.claimCode}</code></div>;

  return <Todos />;
}
```

**`src/Todos.tsx`:**

```tsx
import { useState } from 'react';
import { useTesseronAction, useTesseronResource } from '@tesseron/react';
import { z } from 'zod';

type Todo = { id: string; text: string; done: boolean };

export function Todos() {
  const [todos, setTodos] = useState<Todo[]>([]);

  useTesseronAction('addTodo', {
    description: 'Add a new todo item.',
    input: z.object({ text: z.string().min(1) }),
    handler: ({ text }) => {
      const todo = { id: crypto.randomUUID(), text, done: false };
      setTodos((c) => [...c, todo]);
      return todo;
    },
  });

  useTesseronResource('todos', () => todos);

  return (
    <ul>
      {todos.map((t) => <li key={t.id}>{t.text}</li>)}
    </ul>
  );
}
```

## Headless Node service

```
my-node-service/
├── src/
│   └── index.ts
├── package.json
└── tsconfig.json
```

**`src/index.ts`:**

```ts
import { tesseron } from '@tesseron/server';
import { z } from 'zod';

tesseron.app({
  id: 'my_service',
  name: 'My Tesseron Service',
  description: 'A headless Node service driven by Claude.',
});

const store = new Map<string, unknown>();

tesseron
  .action('set')
  .describe('Store a value under a key.')
  .input(z.object({ key: z.string().min(1), value: z.unknown() }))
  .handler(({ key, value }) => {
    store.set(key, value);
    return { ok: true, size: store.size };
  });

tesseron
  .action('get')
  .describe('Retrieve a stored value by key.')
  .annotate({ readOnly: true })
  .input(z.object({ key: z.string().min(1) }))
  .handler(({ key }) => ({ key, value: store.get(key) ?? null }));

tesseron
  .resource('keys')
  .describe('All stored keys.')
  .output(z.array(z.string()))
  .read(() => [...store.keys()]);

const welcome = await tesseron.connect();
console.log(`Connected. Claim code: ${welcome.claimCode}`);
```

Run with `node --experimental-strip-types src/index.ts` on Node 22+, or compile with `tsc` and run the JS.

## Express + Tesseron hybrid

Pair an HTTP API with a Tesseron WebSocket surface against the same in-memory state:

```ts
import express from 'express';
import { tesseron } from '@tesseron/server';
import { z } from 'zod';

const todos = new Map<string, { id: string; text: string; done: boolean }>();
const app = express();
app.use(express.json());

// HTTP surface
app.get('/todos', (_req, res) => res.json([...todos.values()]));
app.post('/todos', (req, res) => {
  const id = crypto.randomUUID();
  const todo = { id, text: req.body.text, done: false };
  todos.set(id, todo);
  res.status(201).json(todo);
});

// Tesseron surface — same state
tesseron.app({ id: 'todos', name: 'Todos', description: 'HTTP + Claude todos.' });
tesseron
  .action('addTodo')
  .describe('Add a todo.')
  .input(z.object({ text: z.string().min(1) }))
  .handler(({ text }) => {
    const id = crypto.randomUUID();
    const todo = { id, text, done: false };
    todos.set(id, todo);
    return todo;
  });
tesseron
  .resource('todos')
  .describe('All todos.')
  .read(() => [...todos.values()]);

app.listen(3000, async () => {
  const welcome = await tesseron.connect();
  console.log(`HTTP on :3000. Claim code: ${welcome.claimCode}`);
});
```

## `package.json` templates

### Vanilla browser app

```json
{
  "name": "my-tesseron-app",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@tesseron/web": "^1.0.1",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vite": "^5.4.0"
  }
}
```

### React app

```json
{
  "name": "my-tesseron-react-app",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@tesseron/react": "^1.0.1",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.7.0",
    "vite": "^5.4.0"
  }
}
```

### Node service

```json
{
  "name": "my-tesseron-service",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch --experimental-strip-types src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@tesseron/server": "^1.0.1",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0"
  }
}
```

Pin `@tesseron/*` packages to the same minor version — they're released in lockstep. Zod 3 is the most widely tested; Zod 4 works and unlocks `z.toJSONSchema(...)`.

## `tsconfig.json` baseline

### Browser app

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022", "DOM"],
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
```

Drop `"jsx": "react-jsx"` if you're not using React.

### Node service

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "outDir": "dist",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

## `.gitignore` baseline

```
node_modules/
dist/
.cache/
.env
.DS_Store
```

Never commit `.env` — it may contain a gateway allowlist or downstream API keys. Always keep `.env.example` (with placeholder values) under version control.

## Multi-package / monorepo layout

For a frontend + backend that share Tesseron types or handlers, a small workspace keeps things tidy:

```
my-product/
├── package.json          # workspaces: ["apps/*", "packages/*"]
├── pnpm-workspace.yaml
├── apps/
│   ├── web/              # React app with @tesseron/react
│   └── service/          # Node service with @tesseron/server
├── packages/
│   └── shared/           # shared Zod schemas, types, helpers
└── tsconfig.base.json
```

Both apps announce *different* `app.id` values (`product_web`, `product_service`) so their actions don't collide in the MCP tool list.

## Common mistakes

- **Mixing CommonJS and ESM in the same package.** Tesseron is ESM-first; set `"type": "module"` in `package.json` and let imports resolve cleanly.
- **Forgetting `"jsx": "react-jsx"` in a React project's tsconfig.** Compile errors on every TSX file.
- **Checking in `node_modules/`, `dist/`, or `.env`.** `.gitignore` them.
- **Pinning `@tesseron/*` packages to different minor versions.** They're released in lockstep; mismatches cause subtle protocol drift.
- **Picking Zod version 3 when `z.toJSONSchema(...)` is needed.** Zod 4 exports it directly; on Zod 3, use the `zod-to-json-schema` community package or pass the second argument as a hand-written object.
- **Hardcoding gateway host/port in code instead of reading `DEFAULT_GATEWAY_URL` / env vars.** A future gateway location change requires editing every import.
- **Running a gateway in a CI environment without setting `TESSERON_HOST=127.0.0.1` explicitly.** Some CI runners bind to all interfaces by default — spell out localhost to be safe.

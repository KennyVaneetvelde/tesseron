import starlight from '@astrojs/starlight';
// @ts-check
import { defineConfig } from 'astro/config';
import starlightLlmsTxt from 'starlight-llms-txt';

const site = process.env.DOCS_SITE ?? 'https://eigenwise.github.io';
// In `astro dev`, serve from the root so http://127.0.0.1:4321/ works.
// In `astro build` / CI, publish under `/tesseron` for GitHub Pages.
const isDev = process.argv.slice(2).includes('dev');
const base = isDev ? '/' : (process.env.DOCS_BASE ?? '/tesseron');

// Astro does not auto-prefix `base` to `](/...)` links in Markdown, and
// Starlight's Hero / LinkCard components pass `href` through untouched.
// Prefix site-root-relative markdown links with `base` at build time.
const basePrefix = base.replace(/\/$/, '');
function remarkPrependBase() {
  return (tree) => {
    const visit = (node) => {
      if (
        (node.type === 'link' || node.type === 'definition') &&
        typeof node.url === 'string' &&
        node.url.startsWith('/') &&
        !node.url.startsWith('//') &&
        !node.url.startsWith(`${basePrefix}/`)
      ) {
        node.url = `${basePrefix}${node.url}`;
      }
      if (node.children) node.children.forEach(visit);
    };
    visit(tree);
  };
}

export default defineConfig({
  site,
  base,
  trailingSlash: 'ignore',
  build: { assets: 'assets' },
  markdown: {
    // Don't auto-curl quotes / turn `...` into `…`. Our prose is ASCII-clean
    // on purpose; smartypants was mangling code identifiers and Mermaid text.
    smartypants: false,
    remarkPlugins: [remarkPrependBase],
  },
  integrations: [
    starlight({
      title: 'Tesseron',
      description: 'Expose typed app actions to MCP-compatible agents over WebSocket.',
      logo: {
        light: './src/assets/tesseron-smallcaps-light.png',
        dark: './src/assets/tesseron-smallcaps-dark.png',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/eigenwise/tesseron',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/eigenwise/tesseron/edit/main/docs/',
      },
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 4 },
      lastUpdated: true,
      customCss: ['./src/styles/theme.css'],
      components: {
        Head: './src/components/head.astro',
      },
      head: [
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content: `${site}${base}/og.png`,
          },
        },
      ],
      plugins: [
        starlightLlmsTxt({
          projectName: 'Tesseron',
          description:
            'Tesseron is a protocol and TypeScript SDK for exposing the typed actions a live app already has to MCP-compatible AI agents over WebSocket. Your app - browser, Node, or desktop - declares actions and resources; a local MCP gateway turns them into tools the agent can invoke. The protocol is language-agnostic; the JS/TS SDKs are the reference implementation. No browser automation, no scraping, no Playwright.',
          details: [
            '## For AI agents reading this file',
            '',
            'If you are helping a developer build with Tesseron, prefer the [@tesseron/docs-mcp](https://www.npmjs.com/package/@tesseron/docs-mcp) MCP server over this flat dump: it exposes `list_docs`, `search_docs`, and `read_doc` tools over stdio. This file is the fallback for clients that do not speak MCP.',
            '',
            'Key entry points in this file: the Quickstart page for a 5-minute install, the Protocol overview for the wire contract, and the SDK overview for per-runtime installation.',
          ].join('\n'),
          optionalLinks: [
            {
              label: '@tesseron/docs-mcp on npm',
              url: 'https://www.npmjs.com/package/@tesseron/docs-mcp',
              description: 'Docs as an MCP server: search_docs, read_doc, list_docs over stdio.',
            },
            {
              label: 'GitHub repository',
              url: 'https://github.com/eigenwise/tesseron',
              description: 'Source, issues, and runnable examples.',
            },
          ],
          promote: ['index*', 'overview/**'],
          demote: ['examples/**'],
        }),
      ],
      sidebar: [
        {
          label: 'Overview',
          items: [
            { label: 'What is Tesseron?', link: '/' },
            { label: 'Why Tesseron?', link: '/overview/why/' },
            { label: 'What you can build', link: '/overview/what-you-can-build/' },
            { label: 'Architecture at a glance', link: '/overview/architecture/' },
            { label: 'Quickstart (5 minutes)', link: '/overview/quickstart/' },
          ],
        },
        {
          label: 'Protocol',
          items: [
            { label: 'Protocol overview', link: '/protocol/' },
            { label: 'Wire format (JSON-RPC)', link: '/protocol/wire-format/' },
            { label: 'Transport', link: '/protocol/transport/' },
            {
              label: 'Transport bindings',
              collapsed: true,
              items: [
                { label: 'WebSocket', link: '/protocol/transport-bindings/ws/' },
                { label: 'Unix domain socket', link: '/protocol/transport-bindings/uds/' },
              ],
            },
            { label: 'Handshake & claiming', link: '/protocol/handshake/' },
            { label: 'Compatibility', link: '/protocol/compatibility/' },
            { label: 'Session resume', link: '/protocol/resume/' },
            { label: 'Action model', link: '/protocol/actions/' },
            { label: 'Progress & cancellation', link: '/protocol/progress-cancellation/' },
            { label: 'Sampling', link: '/protocol/sampling/' },
            { label: 'Elicitation', link: '/protocol/elicitation/' },
            { label: 'Resources', link: '/protocol/resources/' },
            { label: 'Errors & capabilities', link: '/protocol/errors/' },
            { label: 'Lifecycle & failure modes', link: '/protocol/lifecycle/' },
            { label: 'Security model', link: '/protocol/security/' },
          ],
        },
        {
          label: 'SDK',
          items: [
            { label: 'SDK overview', link: '/sdk/' },
            {
              label: 'TypeScript SDK',
              collapsed: false,
              items: [
                { label: 'Install & first action', link: '/sdk/typescript/' },
                { label: 'Action builder', link: '/sdk/typescript/action-builder/' },
                {
                  label: 'Standard Schema (Zod, Valibot, ...)',
                  link: '/sdk/typescript/standard-schema/',
                },
                {
                  label: 'Context API (progress, sampling, elicit)',
                  link: '/sdk/typescript/context/',
                },
                { label: 'Resources', link: '/sdk/typescript/resources/' },
                { label: '@tesseron/core', link: '/sdk/typescript/core/' },
                { label: '@tesseron/web', link: '/sdk/typescript/web/' },
                { label: '@tesseron/server', link: '/sdk/typescript/server/' },
                { label: '@tesseron/vite', link: '/sdk/typescript/vite/' },
                { label: '@tesseron/react', link: '/sdk/typescript/react/' },
                { label: '@tesseron/svelte', link: '/sdk/typescript/svelte/' },
                { label: '@tesseron/vue', link: '/sdk/typescript/vue/' },
                { label: '@tesseron/mcp (gateway)', link: '/sdk/typescript/mcp/' },
              ],
            },
            {
              label: 'Python SDK',
              collapsed: false,
              items: [
                { label: 'Overview', link: '/sdk/python/' },
                { label: 'Actions', link: '/sdk/python/actions/' },
                { label: 'Resources', link: '/sdk/python/resources/' },
                { label: 'Context', link: '/sdk/python/context/' },
                { label: 'Errors', link: '/sdk/python/errors/' },
                { label: 'Conformance', link: '/sdk/python/conformance/' },
              ],
            },
            {
              label: 'C++ SDK',
              collapsed: false,
              items: [
                { label: 'Overview', link: '/sdk/cpp/' },
                { label: 'Install & build', link: '/sdk/cpp/installation/' },
                { label: 'Actions', link: '/sdk/cpp/actions/' },
                { label: 'Resources', link: '/sdk/cpp/resources/' },
                { label: 'ActionContext', link: '/sdk/cpp/context/' },
                { label: 'Conformance', link: '/sdk/cpp/conformance/' },
              ],
            },
            {
              label: 'Rust SDK',
              collapsed: false,
              items: [
                { label: 'Overview', link: '/sdk/rust/' },
                { label: 'Actions', link: '/sdk/rust/actions/' },
                { label: 'Resources', link: '/sdk/rust/resources/' },
                { label: 'Context', link: '/sdk/rust/context/' },
                { label: 'Errors', link: '/sdk/rust/errors/' },
                { label: 'Conformance', link: '/sdk/rust/conformance/' },
                { label: 'Tauri', link: '/sdk/rust/tauri/' },
              ],
            },
            {
              label: 'Other SDKs',
              collapsed: false,
              items: [{ label: 'Port Tesseron to your language', link: '/sdk/porting/' }],
            },
          ],
        },
        {
          label: 'Examples',
          items: [
            { label: 'All examples', link: '/examples/' },
            { label: 'vanilla-todo', link: '/examples/vanilla-todo/' },
            { label: 'node-prompts', link: '/examples/node-prompts/' },
            { label: 'express-prompts', link: '/examples/express-prompts/' },
            { label: 'react-todo', link: '/examples/react-todo/' },
            { label: 'svelte-todo', link: '/examples/svelte-todo/' },
            { label: 'vue-todo', link: '/examples/vue-todo/' },
          ],
        },
      ],
    }),
  ],
});

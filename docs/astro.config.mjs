import starlight from '@astrojs/starlight';
// @ts-check
import { defineConfig } from 'astro/config';
import starlightLlmsTxt from 'starlight-llms-txt';

const site = process.env.DOCS_SITE ?? 'https://brainblend-ai.github.io';
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
      description: 'Expose typed web-app actions to MCP-compatible agents over WebSocket.',
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
          href: 'https://github.com/BrainBlend-AI/tesseron',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/BrainBlend-AI/tesseron/edit/main/docs/',
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
            'Tesseron is a TypeScript protocol and SDK for exposing typed web-app actions to MCP-compatible AI agents over WebSocket. Your app declares actions and resources; a local MCP gateway turns them into tools the agent can invoke. No browser automation, no scraping, no Playwright.',
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
              url: 'https://github.com/BrainBlend-AI/tesseron',
              description: 'Source, issues, and runnable examples.',
            },
          ],
          promote: ['index*', 'overview/**'],
          demote: ['examples/**', 'sdk/python/**'],
        }),
      ],
      sidebar: [
        {
          label: 'Overview',
          items: [
            { label: 'What is Tesseron?', link: '/' },
            { label: 'Why Tesseron?', link: '/overview/why/' },
            { label: 'Architecture at a glance', link: '/overview/architecture/' },
            { label: 'Quickstart (5 minutes)', link: '/overview/quickstart/' },
          ],
        },
        {
          label: 'Protocol',
          items: [
            { label: 'Protocol overview', link: '/protocol/' },
            { label: 'Wire format (JSON-RPC)', link: '/protocol/wire-format/' },
            { label: 'Transport (WebSocket)', link: '/protocol/transport/' },
            { label: 'Handshake & claiming', link: '/protocol/handshake/' },
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
                { label: '@tesseron/react', link: '/sdk/typescript/react/' },
                { label: '@tesseron/mcp (gateway)', link: '/sdk/typescript/mcp/' },
              ],
            },
            {
              label: 'Other SDKs',
              collapsed: false,
              items: [
                { label: 'Python SDK (planned)', link: '/sdk/python/' },
                { label: 'Port Tesseron to your language', link: '/sdk/porting/' },
              ],
            },
          ],
        },
        {
          label: 'Examples',
          items: [
            { label: 'All examples', link: '/examples/' },
            { label: 'vanilla-todo', link: '/examples/vanilla-todo/' },
            { label: 'node-todo', link: '/examples/node-todo/' },
            { label: 'express-todo', link: '/examples/express-todo/' },
            { label: 'react-todo', link: '/examples/react-todo/' },
            { label: 'svelte-todo', link: '/examples/svelte-todo/' },
            { label: 'vue-todo', link: '/examples/vue-todo/' },
          ],
        },
      ],
    }),
  ],
});

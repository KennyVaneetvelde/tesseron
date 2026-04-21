// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const site = process.env.DOCS_SITE ?? "https://kennyvaneetvelde.github.io";
// In `astro dev`, serve from the root so http://127.0.0.1:4321/ works.
// In `astro build` / CI, publish under `/tesseron` for GitHub Pages.
const isDev = process.argv.slice(2).includes("dev");
const base = isDev ? "/" : process.env.DOCS_BASE ?? "/tesseron";

export default defineConfig({
  site,
  base,
  trailingSlash: "ignore",
  build: { assets: "assets" },
  markdown: {
    // Don't auto-curl quotes / turn `...` into `…`. Our prose is ASCII-clean
    // on purpose; smartypants was mangling code identifiers and Mermaid text.
    smartypants: false,
  },
  integrations: [
    starlight({
      title: "Tesseron",
      description:
        "Expose typed web-app actions to MCP-compatible agents over WebSocket.",
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        replacesTitle: false,
      },
      favicon: "/favicon.svg",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/KennyVaneetvelde/tesseron",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/KennyVaneetvelde/tesseron/edit/main/docs/",
      },
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 4 },
      lastUpdated: true,
      customCss: ["./src/styles/theme.css"],
      components: {
        Head: "./src/components/head.astro",
      },
      head: [
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: `${site}${base}/og.png`,
          },
        },
      ],
      sidebar: [
        {
          label: "Overview",
          items: [
            { label: "What is Tesseron?", link: "/" },
            { label: "Why Tesseron?", link: "/overview/why/" },
            { label: "Architecture at a glance", link: "/overview/architecture/" },
            { label: "Quickstart (5 minutes)", link: "/overview/quickstart/" },
          ],
        },
        {
          label: "Protocol",
          items: [
            { label: "Protocol overview", link: "/protocol/" },
            { label: "Wire format (JSON-RPC)", link: "/protocol/wire-format/" },
            { label: "Transport (WebSocket)", link: "/protocol/transport/" },
            { label: "Handshake & claiming", link: "/protocol/handshake/" },
            { label: "Action model", link: "/protocol/actions/" },
            { label: "Progress & cancellation", link: "/protocol/progress-cancellation/" },
            { label: "Sampling", link: "/protocol/sampling/" },
            { label: "Elicitation", link: "/protocol/elicitation/" },
            { label: "Resources", link: "/protocol/resources/" },
            { label: "Errors & capabilities", link: "/protocol/errors/" },
            { label: "Lifecycle & failure modes", link: "/protocol/lifecycle/" },
            { label: "Security model", link: "/protocol/security/" },
          ],
        },
        {
          label: "SDK",
          items: [
            { label: "SDK overview", link: "/sdk/" },
            {
              label: "TypeScript SDK",
              collapsed: false,
              items: [
                { label: "Install & first action", link: "/sdk/typescript/" },
                { label: "Action builder", link: "/sdk/typescript/action-builder/" },
                { label: "Standard Schema (Zod, Valibot, ...)", link: "/sdk/typescript/standard-schema/" },
                { label: "Context API (progress, sampling, elicit)", link: "/sdk/typescript/context/" },
                { label: "Resources", link: "/sdk/typescript/resources/" },
                { label: "@tesseron/core", link: "/sdk/typescript/core/" },
                { label: "@tesseron/web", link: "/sdk/typescript/web/" },
                { label: "@tesseron/server", link: "/sdk/typescript/server/" },
                { label: "@tesseron/react", link: "/sdk/typescript/react/" },
                { label: "@tesseron/mcp (gateway)", link: "/sdk/typescript/mcp/" },
              ],
            },
            {
              label: "Other SDKs",
              collapsed: false,
              items: [
                { label: "Python SDK (planned)", link: "/sdk/python/" },
                { label: "Port Tesseron to your language", link: "/sdk/porting/" },
              ],
            },
          ],
        },
        {
          label: "Examples",
          items: [
            { label: "All examples", link: "/examples/" },
            { label: "vanilla-todo", link: "/examples/vanilla-todo/" },
            { label: "node-todo", link: "/examples/node-todo/" },
            { label: "express-todo", link: "/examples/express-todo/" },
            { label: "react-todo", link: "/examples/react-todo/" },
            { label: "svelte-todo", link: "/examples/svelte-todo/" },
            { label: "vue-todo", link: "/examples/vue-todo/" },
          ],
        },
      ],
    }),
  ],
});

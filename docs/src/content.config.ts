import { defineCollection, z } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

// `related:` names adjacent pages by slug (`<section>/<basename>` without
// extension). Used by the UserPromptSubmit docs-injection hook and the
// `@tesseron/docs-mcp` server to surface graph edges alongside each page.
const tesseronExtensions = z.object({
  related: z.array(z.string()).optional(),
});

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({ extend: tesseronExtensions }),
  }),
};

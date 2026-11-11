import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins/remark-mdx-mermaid';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

export const docs = defineDocs({ dir: 'content/docs' });

export default defineConfig({
  // A fenced mermaid block becomes a <Mermaid chart="..." /> element, which mdx-components.tsx maps to the diagram.
  mdxOptions: { remarkPlugins: [remarkMdxMermaid] },
});

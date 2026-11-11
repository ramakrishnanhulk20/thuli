import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { Mermaid } from '@/components/docs/Mermaid';

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return { ...defaultMdxComponents, Mermaid, ...components };
}

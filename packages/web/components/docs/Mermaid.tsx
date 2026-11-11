'use client';

import { useEffect, useId, useRef, useState } from 'react';

type DiagramState = 'drawing' | 'drawn' | 'failed';

// Mermaid reads its colours as literal values, so these are the site's tokens written out.
const THEME_VARIABLES = {
  background: 'transparent',
  primaryColor: '#0b0f16',
  primaryBorderColor: '#7c8693',
  primaryTextColor: '#efeae0',
  lineColor: '#a9b0ba',
  // The grey box mermaid puts behind an arrow's label takes the page colour instead.
  edgeLabelBackground: '#05070b',
};

let drawn = 0;

/**
 * A mermaid diagram drawn in the browser. The mermaid package loads only when a page with a diagram mounts this
 * component. While it loads the wrapper says so, and if drawing fails the diagram's source is shown instead.
 */
export function Mermaid({ chart }: { chart: string }) {
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const holder = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DiagramState>('drawing');

  useEffect(() => {
    let current = true;
    setState('drawing');
    // Two draws of the same id can overlap in development, so every draw gets its own.
    drawn += 1;
    const elementId = `mermaid-${reactId}-${drawn}`;

    async function draw() {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          // The base theme derives its fills from primaryColor. The dark theme fixes its own greys instead.
          theme: 'base',
          themeVariables: { ...THEME_VARIABLES, darkMode: true, fontFamily: getComputedStyle(document.body).fontFamily },
          flowchart: { useMaxWidth: false },
        });
        const { svg } = await mermaid.render(elementId, chart);
        const picture = new DOMParser().parseFromString(svg, 'text/html').body.firstElementChild;
        if (!current || holder.current === null) return;
        if (picture === null) throw new Error('mermaid returned no diagram');
        holder.current.replaceChildren(picture);
        setState('drawn');
      } catch {
        if (current) setState('failed');
      }
    }

    void draw();
    return () => {
      current = false;
    };
  }, [chart, reactId]);

  if (state === 'failed') {
    return (
      <pre className="thuli-mermaid-source">
        <code>{chart}</code>
      </pre>
    );
  }

  return (
    <div className="thuli-mermaid">
      {state === 'drawing' ? <p className="thuli-mermaid-status">Drawing the diagram</p> : null}
      <div ref={holder} className="thuli-mermaid-picture" />
    </div>
  );
}

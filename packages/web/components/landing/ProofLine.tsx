'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import styles from './vaultProof.module.css';

export interface ProofLineStep {
  name: string;
  hash: string;
  shortHash: string;
  href: string;
  gas: string;
}

const DRAW_MS = 1200;
const IN_VIEW = 0.3;
const THRESHOLDS = Array.from({ length: 21 }, (_, step) => step / 20);

function easeOutExpo(progress: number): number {
  return progress >= 1 ? 1 : 1 - Math.pow(2, -10 * progress);
}

/**
 * The five proof steps on a line that draws itself the first time 30% of the proof block is in view. The server HTML
 * and a reduced-motion visit hold the finished line, so nothing depends on the script to be readable.
 */
export function ProofLine({ steps }: { steps: ProofLineStep[] }) {
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list === null || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const nodes = Array.from(list.querySelectorAll<HTMLElement>('[data-node]'));
    const watched = list.closest<HTMLElement>('[data-proof]') ?? list;
    const last = nodes.length - 1;
    let frame = 0;
    let started = false;

    list.style.setProperty('--draw', '0');
    nodes.forEach((node) => node.removeAttribute('data-filled'));

    // The line is a CSS variable and each node a data attribute, so React never renders per frame.
    const play = () => {
      const startedAt = performance.now();
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / DRAW_MS);
        const drawn = easeOutExpo(progress);
        list.style.setProperty('--draw', String(drawn));
        nodes.forEach((node, index) => {
          if (!node.hasAttribute('data-filled') && drawn >= index / last) node.setAttribute('data-filled', 'true');
        });
        if (progress < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry === undefined || started) return;
        // A block taller than three viewports can never show 30% of itself, so 30% of the screen filled counts too.
        const fillsScreen = entry.rootBounds !== null && entry.intersectionRect.height >= IN_VIEW * entry.rootBounds.height;
        if (entry.intersectionRatio >= IN_VIEW || fillsScreen) {
          started = true;
          observer.disconnect();
          play();
        }
      },
      { threshold: THRESHOLDS },
    );
    observer.observe(watched);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      list.style.removeProperty('--draw');
      nodes.forEach((node) => node.setAttribute('data-filled', 'true'));
    };
  }, []);

  return (
    <ol ref={listRef} className={styles.line} style={{ '--count': steps.length, '--last': steps.length - 1 } as CSSProperties}>
      {steps.map((step, index) => (
        <li key={step.hash} className={styles.step} style={{ '--i': index } as CSSProperties} data-step>
          <span className={styles.node} data-node data-filled="true" aria-hidden="true" />
          <p className={styles.stepName}>{step.name}</p>
          <a className={styles.hash} href={step.href} target="_blank" rel="noopener noreferrer" title={step.hash}>
            <span className={styles.hashLabel}>{step.shortHash}</span>
          </a>
          <p className={styles.gas}>{step.gas}</p>
        </li>
      ))}
    </ol>
  );
}

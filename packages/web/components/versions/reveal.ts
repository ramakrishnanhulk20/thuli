const EASE = [0.16, 1, 0.3, 1] as [number, number, number, number];

/** Motion props for a scorecard row: fade and rise 16px, 600ms, once, 80ms after the row above. */
export const rowReveal = (index: number) => ({
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.25 },
  transition: { duration: 0.6, ease: EASE, delay: index * 0.08 },
});

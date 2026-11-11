'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Drop } from '../Drop';
import styles from './landing.module.css';

interface ElevenDotsProps {
  /** v2Action of each verdict, in file order. Anything but "hold" means the wallet is released. */
  afterActions: string[];
  before: string;
  after: string;
}

const SCRUB_QUERY = '(min-width: 768px) and (prefers-reduced-motion: no-preference)';

export function ElevenDots({ afterActions, before, after }: ElevenDotsProps) {
  const blockRef = useRef<HTMLDivElement>(null);
  // Circle number to its place in the order the releases happen.
  const releaseOrder = useMemo(() => {
    const order = new Map<number, number>();
    afterActions.forEach((action, index) => {
      if (action !== 'hold') order.set(index, order.size);
    });
    return order;
  }, [afterActions]);
  const total = releaseOrder.size;
  const stays = afterActions.some((action) => action === 'hold');

  // Starts in the after state, which is what the server HTML, small screens and reduced motion show.
  const [changed, setChanged] = useState(total);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const block = blockRef.current;
    if (block === null) return;
    gsap.registerPlugin(ScrollTrigger);
    const media = gsap.matchMedia();
    media.add(SCRUB_QUERY, () => {
      const count = (progress: number) => (progress <= 0 ? 0 : Math.min(total, Math.ceil(progress * total)));
      const trigger = ScrollTrigger.create({
        trigger: block,
        start: 'top 70%',
        end: 'top 30%',
        scrub: true,
        onUpdate: (self) => setChanged(count(self.progress)),
        onRefresh: (self) => setChanged(count(self.progress)),
      });
      setLive(true);
      setChanged(count(trigger.progress));
      return () => {
        trigger.kill();
        setLive(false);
        setChanged(total);
      };
    });
    return () => media.revert();
  }, [total]);

  const done = changed >= total;

  return (
    <div ref={blockRef} className={styles.dotsBlock}>
      <p className={styles.rowLabel}>DECISIONS REPPO BLOCKED THAT THE RULEBOOK NO LONGER MAKES</p>
      <div className={styles.dots} aria-hidden="true">
        {afterActions.map((_, index) => {
          const place = releaseOrder.get(index);
          const released = place !== undefined && place < changed;
          return (
            <span key={index} className={`${styles.dot} ${released ? styles.dotReleased : ''}`}>
              {live && released ? <Drop width={8} className={styles.dotDrop} /> : null}
            </span>
          );
        })}
      </div>
      <div className={styles.tally}>
        <p className={`${styles.tallyLine} ${done ? '' : styles.tallyOn}`} aria-hidden={done}>
          {before}
        </p>
        <p className={`${styles.tallyLine} ${done ? styles.tallyOn : ''}`} aria-hidden={!done}>
          {after}
        </p>
      </div>
      {stays ? <p className={styles.stillHeld}>Still held: that wallet has a link of its own, which its reason left out.</p> : null}
    </div>
  );
}

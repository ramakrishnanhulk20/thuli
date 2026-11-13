'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { motion } from 'motion/react';
import { countOf, formatInt, formatUsd } from '@/lib/format';
import type { CaseFileData } from '@/lib/replay/caseFile';
import { Drop } from '../Drop';
import styles from './landing.module.css';

interface View {
  step: number;
  local: number;
}

const FINAL_VIEW: View = { step: 5, local: 1 };
const PINNED_QUERY = '(min-width: 768px) and (prefers-reduced-motion: no-preference)';
const WALLET_POINT = { x: 640, y: 470 };
const FUNDER_POINT = { x: 240, y: 230 };
const FAN_RADIUS = 170;
// Only the start of each fan line is fixed by the design, not how long it takes to draw, so each takes a fifth of the step.
const FAN_LINE_SPAN = 0.2;

const reveal = (index: number) => ({
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.25 },
  transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] as [number, number, number, number], delay: index * 0.08 },
});

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function geometry(hops: number, others: number) {
  const nodes = Array.from({ length: hops }, (_, index) => {
    const fraction = (index + 1) / (hops + 1);
    return {
      fraction,
      x: WALLET_POINT.x + (FUNDER_POINT.x - WALLET_POINT.x) * fraction,
      y: WALLET_POINT.y + (FUNDER_POINT.y - WALLET_POINT.y) * fraction,
    };
  });
  // The fan spans -75 to +15 degrees and the trail leaves F at about 31, so the two never share a direction.
  const dots = Array.from({ length: others }, (_, index) => {
    const angle = others === 1 ? -30 : -75 + (90 * index) / (others - 1);
    return {
      x: FUNDER_POINT.x + FAN_RADIUS * Math.cos((angle * Math.PI) / 180),
      y: FUNDER_POINT.y + FAN_RADIUS * Math.sin((angle * Math.PI) / 180),
    };
  });
  return { nodes, dots };
}

function lineTo(from: { x: number; y: number }, to: { x: number; y: number }): string {
  return `M${from.x.toFixed(2)} ${from.y.toFixed(2)}L${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
}

export function CaseStage({ data }: { data: CaseFileData }) {
  const sectionRef = useRef<HTMLElement>(null);
  // Starts in the final state so the stacked layout and the server HTML show the finished drawing.
  const [view, setView] = useState<View>(FINAL_VIEW);
  const shape = useMemo(() => geometry(data.hops, data.others), [data.hops, data.others]);

  useEffect(() => {
    const section = sectionRef.current;
    if (section === null) return;
    gsap.registerPlugin(ScrollTrigger);
    const media = gsap.matchMedia();
    media.add(PINNED_QUERY, () => {
      const apply = (progress: number) => {
        const p = clamp01(progress);
        const step = Math.min(5, Math.floor(p * 5) + 1);
        const local = p * 5 - (step - 1);
        section.style.setProperty('--case', p.toFixed(4));
        section.style.setProperty('--case-local', local.toFixed(4));
        const rounded = Math.round(local * 200) / 200;
        setView((before) => (before.step === step && before.local === rounded ? before : { step, local: rounded }));
      };
      const trigger = ScrollTrigger.create({
        trigger: section,
        pin: true,
        scrub: true,
        start: 'top top',
        end: '+=400%',
        onUpdate: (self) => apply(self.progress),
        onRefresh: (self) => apply(self.progress),
      });
      apply(trigger.progress);
      void document.fonts.ready.then(() => ScrollTrigger.refresh());
      return () => {
        trigger.kill();
        section.style.removeProperty('--case');
        section.style.removeProperty('--case-local');
        setView(FINAL_VIEW);
      };
    });
    return () => media.revert();
  }, []);

  const { step, local } = view;
  const trail = step > 2 ? 1 : step === 2 ? local : 0;
  const fan = step > 3 ? 1 : step === 3 ? local : 0;
  const typed = step > 4 ? 1 : step === 4 ? Math.min(1, local * 1.6) : 0;
  const shownCount = Math.floor(data.reason.length * typed);
  const funderOn = trail >= 1;
  const held = step >= 5;

  const steps = [
    {
      heading: 'It looks like a new wallet.',
      body: `${countOf(data.ageDays, 'day')} old, ${countOf(data.txCount, 'transaction')} before the snapshot, and a claim for ${formatInt(data.robo)} ROBO, about ${formatUsd(data.usd)} at the claim-day price. On its own, nothing here proves anything.`,
    },
    {
      heading: 'Thuli follows the money back.',
      body: `Its first ETH arrived through ${data.hops} wallets that were each used once and never again. Code traces the trail to where it started.`,
    },
    {
      heading: `The same source paid ${data.others} other claim wallets.`,
      body: `All ${data.groupSize} were funded the same way, before the claim opened. That is a pattern code can count.`,
    },
    { heading: 'SERV applies the rulebook and writes the reason.', body: '' },
    {
      heading: 'Held, with a way back.',
      body: 'The reward waits. The wallet can appeal by signing a message, and only the project decides. Every family in this drop opens the same way.',
    },
  ];

  return (
    <section ref={sectionRef} id="case-file" className={`${styles.section} ${styles.case}`} data-step={step} aria-label="Case file">
      <div className={`${styles.inner} ${styles.caseInner}`}>
        <motion.div className={`${styles.caseHead} ${styles.reveal}`} {...reveal(0)}>
          <p className={styles.label}>
            <Drop width={8} className={styles.labelMark} />
            CASE FILE
          </p>
          <p className={styles.caseWallet}>{data.walletShort}</p>
        </motion.div>

        <div className={styles.caseStageWrap}>
          <svg className={styles.caseSvg} viewBox="0 0 800 600" aria-hidden="true">
            <path className={styles.svgCorner} d="M8 22V8H22M778 8H792V22M8 578V592H22M778 592H792V578" />

            <path
              className={`${styles.svgTrail} ${step >= 4 ? styles.svgTrailBright : ''}`}
              d={lineTo(WALLET_POINT, FUNDER_POINT)}
              pathLength={1}
              strokeDasharray="1 1"
              strokeDashoffset={1 - trail}
            />
            {shape.dots.map((dot, index) => {
              const start = (index / data.others) * 0.8;
              return (
                <path
                  key={index}
                  className={styles.svgFanLine}
                  d={lineTo(FUNDER_POINT, dot)}
                  pathLength={1}
                  strokeDasharray="1 1"
                  strokeDashoffset={1 - clamp01((fan - start) / FAN_LINE_SPAN)}
                />
              );
            })}

            {shape.nodes.map((node) => {
              const on = trail >= node.fraction - 1e-9;
              return (
                <g key={node.fraction}>
                  <circle className={`${styles.svgNode} ${on ? styles.svgNodeOn : ''}`} cx={node.x} cy={node.y} r={6} />
                  <text
                    className={`${styles.svgText} ${on ? styles.svgTextOn : ''}`}
                    x={node.x - 12}
                    y={node.y + 18}
                    fontSize={10}
                    textAnchor="end"
                  >
                    USED ONCE
                  </text>
                </g>
              );
            })}

            <circle
              className={`${styles.svgFunder} ${funderOn ? styles.svgFunderOn : ''} ${step >= 4 ? styles.svgFunderBright : ''}`}
              cx={FUNDER_POINT.x}
              cy={FUNDER_POINT.y}
              r={14}
            />
            <text
              className={`${styles.svgText} ${styles.svgTextSoft} ${funderOn ? styles.svgTextOn : ''}`}
              x={216}
              y={222}
              fontSize={11}
              textAnchor="end"
            >
              FUNDER
            </text>
            <text
              className={`${styles.svgText} ${funderOn ? styles.svgTextOn : ''}`}
              x={216}
              y={238}
              fontSize={11}
              textAnchor="end"
            >
              {data.funderShort}
            </text>
            <text
              className={`${styles.svgText} ${styles.svgTextAccent} ${fan > 0.85 ? styles.svgTextOn : ''}`}
              x={216}
              y={262}
              fontSize={12}
              textAnchor="end"
            >
              PAID {data.others + 1} CLAIM WALLETS
            </text>

            {shape.dots.map((dot, index) => {
              const start = (index / data.others) * 0.8;
              const on = fan - start >= FAN_LINE_SPAN - 1e-9;
              return (
                <circle
                  key={index}
                  className={`${styles.svgDot} ${on ? styles.svgDotOn : ''} ${held ? styles.svgHeld : ''}`}
                  style={{ transitionDelay: held ? `0ms, ${(index + 1) * 30}ms` : '0ms' }}
                  cx={dot.x}
                  cy={dot.y}
                  r={5}
                />
              );
            })}

            {step === 1 ? (
              <circle className={styles.svgPulseRing} cx={WALLET_POINT.x} cy={WALLET_POINT.y} r={10} />
            ) : null}
            <circle className={`${styles.svgW} ${held ? styles.svgHeld : ''}`} cx={WALLET_POINT.x} cy={WALLET_POINT.y} r={10} />
            <text
              className={`${styles.svgText} ${styles.svgTextOn}`}
              x={640}
              y={496}
              fontSize={11}
              textAnchor="middle"
            >
              THIS WALLET
            </text>
            <text className={styles.svgFact} x={640} y={520} fontSize={12} textAnchor="middle">
              {data.ageDays} DAYS OLD
            </text>
            <text className={styles.svgFact} x={640} y={538} fontSize={12} textAnchor="middle">
              {data.txCount} TRANSACTIONS BEFORE THE SNAPSHOT
            </text>

            <text
              className={`${styles.svgStamp} ${held ? styles.svgStampOn : ''}`}
              x={400}
              y={520}
              fontSize={56}
              textAnchor="middle"
              dominantBaseline="central"
            >
              HELD
            </text>
          </svg>
        </div>

        <div className={styles.caseSteps}>
          {steps.map((item, index) => {
            const n = index + 1;
            return (
              <div key={n} className={styles.caseStep} data-n={n}>
                <motion.div className={styles.reveal} {...reveal(0)}>
                  <p className={styles.stepCounter}>{`0${n} / 05`}</p>
                  <h3 className={styles.stepHeading}>{item.heading}</h3>
                  {n === 4 ? (
                    <>
                      <div className={styles.reasonCard}>
                        <div className={styles.chips}>
                          <span className={styles.chip}>RULE {data.rule}</span>
                          <span className={`${styles.chip} ${styles.chipHold}`}>HOLD</span>
                        </div>
                        <p className={styles.reasonText} aria-label={data.reason}>
                          <span>{data.reason.slice(0, shownCount)}</span>
                          <span className={styles.reasonRest}>{data.reason.slice(shownCount)}</span>
                        </p>
                        <p className={styles.reasonRow}>
                          <span>CITED TRANSACTION</span>
                          <a href={data.txUrl} target="_blank" rel="noopener noreferrer" className={styles.cardLink}>
                            <span className={styles.cardLinkLabel}>{data.txShort}</span>
                          </a>
                        </p>
                        <p className={styles.reasonRun}>SERV RUN {data.requestId}</p>
                      </div>
                      <p className={styles.stepBody}>
                        {"The reason is the model's own words. Code checks that every transaction it cites is one Thuli fetched for this wallet."}
                      </p>
                    </>
                  ) : (
                    <p className={styles.stepBody}>{item.body}</p>
                  )}
                  {n === 5 ? (
                    <div className={`${styles.linkRow} ${styles.stepLink}`}>
                      <Link href={`/replay?family=${data.group}`} className={styles.link}>
                        <span className={styles.linkLabel}>Open this family in the replay</span>
                        <svg className={styles.linkArrow} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                          <path d="M1 6h9M6.5 2.5L10 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      </Link>
                    </div>
                  ) : null}
                </motion.div>
              </div>
            );
          })}
        </div>

        <p className={styles.caseCounter}>{`0${step} / 05`}</p>
      </div>
    </section>
  );
}

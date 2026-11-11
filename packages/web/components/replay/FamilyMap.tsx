'use client';

import { useEffect, useRef, useState } from 'react';
import { formatInt } from '@/lib/format';
import { familyClusters, loadPoints } from '@/lib/replay/client';
import { OUTCOME_STYLES } from '@/lib/replay/replayTypes';
import type { WebGroup, WebPoints } from '@/lib/replay/types';
import { easeOutExpo, hash, pickSpacing, placeClusters, slotOffset } from '../hero/heroLayout';
import styles from './replay.module.css';

const ENTRANCE_SPREAD_SECONDS = 0.9;
const FLIGHT_SECONDS = 0.7;
const ENTRANCE_END_SECONDS = ENTRANCE_SPREAD_SECONDS + FLIGHT_SECONDS;
const DROP_FROM_PX = 60;
const BREATH_PX = 2.5;
const BREATH_EASE_SECONDS = 1.5;
const DIM_WITH_SELECTION = 0.3;
const DIM_WITH_HOVER = 0.45;
const HOVER_SIZE = 1.25;
const MOON_MARGIN = 24;
const RING_GAP = 4;
const OUTCOME_COUNT = 4;

// The order the map legend reads in, with its label.
const LEGEND = [
  { outcome: OUTCOME_STYLES[2], text: 'HELD' },
  { outcome: OUTCOME_STYLES[3], text: 'EXCLUDED' },
  { outcome: OUTCOME_STYLES[1], text: 'PARTIAL' },
  { outcome: OUTCOME_STYLES[0], text: 'FULL' },
] as const;

interface MapView {
  selectedFamily: number | null;
  selectedWallet: number | null;
  highlightFamily: number | null;
}

interface MapCounts {
  dots: number;
  families: number;
}

interface MapParts {
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  tooltip: HTMLElement;
  tooltipLines: HTMLElement[];
}

interface MapEngine {
  redraw: () => void;
  stop: () => void;
}

interface MapHooks {
  onFamily: (group: number) => void;
  onReady: (counts: MapCounts) => void;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smooth(p: number): number {
  return p * p * (3 - 2 * p);
}

function startMap(parts: MapParts, groups: WebGroup[], readView: () => MapView, hooks: MapHooks): MapEngine {
  const { stage, canvas, context: ctx, tooltip, tooltipLines } = parts;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  const tabletQuery = window.matchMedia('(min-width: 768px)');
  let stopped = false;

  // Canvas drawing cannot read CSS variables, so the tokens are read once from the page.
  const rootStyle = getComputedStyle(document.documentElement);
  const outcomeColour = OUTCOME_STYLES.map((outcome) => rootStyle.getPropertyValue(outcome.token).trim());
  const accentColour = rootStyle.getPropertyValue('--color-accent').trim();

  let W = 0;
  let H = 0;
  let moonRadius = 0;
  let dot = 1.5;

  let ready = false;
  let clusters: ReturnType<typeof familyClusters> = [];
  let clusterCount = 0;
  let dotCount = 0;
  let firstOf = new Int32Array(0);
  let groupOfRank = new Int32Array(0);
  let rankOfGroup = new Int32Array(0);
  let outcomeOf = new Uint8Array(0);
  let dotOfWallet = new Int32Array(0);
  let rankOfDot = new Int32Array(0);
  let drawOrder = new Int32Array(0);
  let runStart = new Int32Array(0);
  let homeX = new Float64Array(0);
  let homeY = new Float64Array(0);
  let radius = new Float64Array(0);
  let slotX = new Float32Array(0);
  let slotY = new Float32Array(0);
  let centreX = new Float64Array(0);
  let centreY = new Float64Array(0);
  let startAt = new Float64Array(0);
  let breath = { w1: new Float64Array(0), w2: new Float64Array(0), f1: new Float64Array(0), f2: new Float64Array(0) };

  let hoverRank = -1;
  let rafId = 0;
  let running = false;
  let onScreen = false;
  let stillQueued = false;
  let resizeTimer = 0;

  // The entrance clock starts the first time the map is on screen with its data, so a map below the fold still plays it.
  let entranceMs = -1;
  const seconds = () => (entranceMs < 0 ? 0 : (performance.now() - entranceMs) / 1000);

  function measure() {
    W = stage.clientWidth;
    H = stage.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, tabletQuery.matches ? 2 : 1.5);
    const pixelsWide = Math.round(W * dpr);
    const pixelsHigh = Math.round(H * dpr);
    if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
      canvas.width = pixelsWide;
      canvas.height = pixelsHigh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    moonRadius = Math.max(40, Math.min(W, H) / 2 - MOON_MARGIN);
  }

  function place() {
    const spacing = pickSpacing(clusters, moonRadius);
    dot = Math.max(1.5, spacing * 0.62);
    for (const cluster of placeClusters(clusters, spacing)) {
      const q = cluster.rank;
      homeX[q] = cluster.homeX;
      homeY[q] = cluster.homeY;
      radius[q] = cluster.r;
      const first = firstOf[q] as number;
      for (let j = 0; j < cluster.members.length; j += 1) {
        const slot = slotOffset(q, j, spacing);
        slotX[first + j] = slot.x;
        slotY[first + j] = slot.y;
      }
    }
  }

  function build(points: WebPoints) {
    clusters = familyClusters(points);
    clusterCount = clusters.length;
    dotCount = clusters.reduce((sum, cluster) => sum + cluster.members.length, 0);
    firstOf = new Int32Array(clusterCount + 1);
    groupOfRank = new Int32Array(clusterCount);
    rankOfGroup = new Int32Array(groups.length).fill(-1);
    outcomeOf = new Uint8Array(dotCount);
    dotOfWallet = new Int32Array(points.count).fill(-1);
    rankOfDot = new Int32Array(dotCount);
    let at = 0;
    clusters.forEach((cluster, q) => {
      firstOf[q] = at;
      groupOfRank[q] = cluster.groupIndex;
      rankOfGroup[cluster.groupIndex] = q;
      for (const wallet of cluster.members) {
        outcomeOf[at] = points.outcome[wallet] ?? 0;
        dotOfWallet[wallet] = at;
        rankOfDot[at] = q;
        at += 1;
      }
    });
    firstOf[clusterCount] = at;

    // Each family's dots are grouped by outcome, so one family is a few fills of one colour each.
    drawOrder = new Int32Array(dotCount);
    runStart = new Int32Array(clusterCount * OUTCOME_COUNT + 1);
    let written = 0;
    for (let q = 0; q < clusterCount; q += 1) {
      for (let outcome = 0; outcome < OUTCOME_COUNT; outcome += 1) {
        runStart[q * OUTCOME_COUNT + outcome] = written;
        for (let k = firstOf[q] as number; k < (firstOf[q + 1] as number); k += 1) {
          if (outcomeOf[k] === outcome) {
            drawOrder[written] = k;
            written += 1;
          }
        }
      }
    }
    runStart[clusterCount * OUTCOME_COUNT] = written;

    homeX = new Float64Array(clusterCount);
    homeY = new Float64Array(clusterCount);
    radius = new Float64Array(clusterCount);
    slotX = new Float32Array(dotCount);
    slotY = new Float32Array(dotCount);
    centreX = new Float64Array(clusterCount);
    centreY = new Float64Array(clusterCount);
    startAt = Float64Array.from({ length: clusterCount }, (_, q) => (ENTRANCE_SPREAD_SECONDS * q) / clusterCount);
    breath = {
      w1: Float64Array.from({ length: clusterCount }, (_, q) => 6.2832 / (7 + 4 * hash(q, 11))),
      w2: Float64Array.from({ length: clusterCount }, (_, q) => 6.2832 / (7 + 4 * hash(q, 12))),
      f1: Float64Array.from({ length: clusterCount }, (_, q) => 6.2832 * hash(q, 13)),
      f2: Float64Array.from({ length: clusterCount }, (_, q) => 6.2832 * hash(q, 14)),
    };
    place();
  }

  function setCentres(t: number) {
    for (let q = 0; q < clusterCount; q += 1) {
      let x = W / 2 + (homeX[q] as number);
      let y = H / 2 + (homeY[q] as number);
      if (!reduced) {
        const formedAt = (startAt[q] as number) + FLIGHT_SECONDS;
        const grow = smooth(clamp01((t - formedAt) / BREATH_EASE_SECONDS));
        x += grow * BREATH_PX * Math.sin(t * (breath.w1[q] as number) + (breath.f1[q] as number));
        y += grow * BREATH_PX * Math.cos(t * (breath.w2[q] as number) + (breath.f2[q] as number));
      }
      centreX[q] = x;
      centreY[q] = y;
    }
  }

  function flightOf(q: number, t: number): number {
    return reduced ? 1 : easeOutExpo((t - (startAt[q] as number)) / FLIGHT_SECONDS);
  }

  function draw(t: number) {
    ctx.clearRect(0, 0, W, H);
    if (!ready) return;
    const view = readView();
    const listRank = view.highlightFamily === null ? -1 : (rankOfGroup[view.highlightFamily] ?? -1);
    const focusRank = hoverRank >= 0 ? hoverRank : listRank;
    const selectedRank = view.selectedFamily === null ? -1 : (rankOfGroup[view.selectedFamily] ?? -1);
    const background = selectedRank >= 0 ? DIM_WITH_SELECTION : focusRank >= 0 ? DIM_WITH_HOVER : 1;

    setCentres(t);
    for (let q = 0; q < clusterCount; q += 1) {
      const p = flightOf(q, t);
      if (p <= 0) continue;
      const lit = q === focusRank || q === selectedRank;
      ctx.globalAlpha = (lit ? 1 : background) * p;
      const size = q === focusRank ? dot * HOVER_SIZE : dot;
      const half = size / 2;
      const cx = centreX[q] as number;
      const cy = (centreY[q] as number) - DROP_FROM_PX * (1 - p);
      for (let outcome = 0; outcome < OUTCOME_COUNT; outcome += 1) {
        const from = runStart[q * OUTCOME_COUNT + outcome] as number;
        const to = runStart[q * OUTCOME_COUNT + outcome + 1] as number;
        if (from === to) continue;
        ctx.fillStyle = outcomeColour[outcome] as string;
        ctx.beginPath();
        for (let m = from; m < to; m += 1) {
          const k = drawOrder[m] as number;
          ctx.rect(cx + (slotX[k] as number) - half, cy + (slotY[k] as number) - half, size, size);
        }
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1;
    ctx.strokeStyle = accentColour;
    if (selectedRank >= 0 && flightOf(selectedRank, t) >= 1) {
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(centreX[selectedRank] as number, centreY[selectedRank] as number, (radius[selectedRank] as number) + RING_GAP, 0, Math.PI * 2);
      ctx.stroke();
    }
    const walletDot = view.selectedWallet === null ? -1 : (dotOfWallet[view.selectedWallet] ?? -1);
    if (walletDot >= 0) {
      const q = rankOfDot[walletDot] as number;
      if (flightOf(q, t) >= 1) {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(
          (centreX[q] as number) + (slotX[walletDot] as number),
          (centreY[q] as number) + (slotY[walletDot] as number),
          dot + 3,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      }
    }
  }

  function redraw() {
    if (!ready || running || stillQueued || stopped) return;
    stillQueued = true;
    requestAnimationFrame(() => {
      stillQueued = false;
      if (!stopped && !running) draw(seconds());
    });
  }

  function frame(now: number) {
    rafId = requestAnimationFrame(frame);
    draw((now - entranceMs) / 1000);
  }

  function syncLoop() {
    const shouldRun = ready && !reduced && onScreen && document.visibilityState === 'visible';
    if (shouldRun && !running) {
      if (entranceMs < 0) entranceMs = performance.now();
      running = true;
      rafId = requestAnimationFrame(frame);
    } else if (!shouldRun && running) {
      running = false;
      cancelAnimationFrame(rafId);
    }
  }

  function interactive(): boolean {
    return ready && (reduced || seconds() >= ENTRANCE_END_SECONDS);
  }

  function familyAt(event: MouseEvent): number {
    const box = canvas.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    for (let q = 0; q < clusterCount; q += 1) {
      const dx = px - (centreX[q] as number);
      const dy = py - (centreY[q] as number);
      const reach = (radius[q] as number) + RING_GAP;
      if (dx * dx + dy * dy <= reach * reach) return q;
    }
    return -1;
  }

  function setHover(next: number) {
    if (next === hoverRank) return;
    hoverRank = next;
    canvas.style.cursor = next >= 0 ? 'pointer' : '';
    const group = next >= 0 ? groups[groupOfRank[next] as number] : undefined;
    tooltip.style.opacity = group === undefined ? '0' : '1';
    if (group !== undefined) {
      const lines = [`Family of ${formatInt(group.size)} wallets`, `${formatInt(group.held)} held`, `${formatInt(group.robo)} ROBO`];
      tooltipLines.forEach((node, index) => {
        node.textContent = lines[index] ?? '';
      });
    }
    redraw();
  }

  function onPointerMove(event: PointerEvent) {
    if (!finePointer || !interactive()) return;
    const found = familyAt(event);
    setHover(found);
    if (found < 0) return;
    const bounds = stage.getBoundingClientRect();
    const sx = event.clientX - bounds.left;
    const sy = event.clientY - bounds.top;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const x = sx + 16 + width > bounds.width ? sx - 16 - width : sx + 16;
    const y = sy + 16 + height > bounds.height ? sy - 16 - height : sy + 16;
    tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function onPointerLeave() {
    setHover(-1);
  }

  function onClick(event: MouseEvent) {
    if (!interactive()) return;
    const found = familyAt(event);
    if (found >= 0) hooks.onFamily(groupOfRank[found] as number);
  }

  function applyLayout() {
    measure();
    if (!ready) return;
    place();
    redraw();
  }

  measure();
  const resizeObserver = new ResizeObserver(() => {
    if (stage.clientWidth === W && stage.clientHeight === H) return;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(applyLayout, 150);
  });
  resizeObserver.observe(stage);

  const intersection = new IntersectionObserver((entries) => {
    const latest = entries[entries.length - 1];
    if (latest === undefined) return;
    onScreen = latest.isIntersecting;
    syncLoop();
    if (onScreen) redraw();
  });
  intersection.observe(stage);

  const onVisibility = () => syncLoop();
  document.addEventListener('visibilitychange', onVisibility);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerleave', onPointerLeave);
  stage.addEventListener('click', onClick);

  loadPoints()
    .then((points) => {
      if (stopped) return;
      build(points);
      ready = true;
      hooks.onReady({ dots: dotCount, families: clusterCount });
      syncLoop();
      redraw();
    })
    .catch(() => undefined);

  return {
    redraw,
    stop() {
      stopped = true;
      cancelAnimationFrame(rafId);
      window.clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('pointerleave', onPointerLeave);
      stage.removeEventListener('click', onClick);
      canvas.style.cursor = '';
      tooltip.style.opacity = '';
    },
  };
}

interface FamilyMapProps {
  groups: WebGroup[];
  /** Index into groups of the family the panel shows, if any. */
  selectedFamily: number | null;
  /** Index into points.json of the wallet the panel shows, if any. */
  selectedWallet: number | null;
  /** The family a hovered list row stands for. */
  highlightFamily: number | null;
  /** True once the shown wallet is known to belong to no linked family. */
  walletHasNoFamily: boolean;
  onSelectFamily: (group: number) => void;
}

export function FamilyMap({ groups, selectedFamily, selectedWallet, highlightFamily, walletHasNoFamily, onSelectFamily }: FamilyMapProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<MapEngine | null>(null);
  const viewRef = useRef<MapView>({ selectedFamily, selectedWallet, highlightFamily });
  const clickRef = useRef(onSelectFamily);
  const [counts, setCounts] = useState<MapCounts | null>(null);

  useEffect(() => {
    clickRef.current = onSelectFamily;
  }, [onSelectFamily]);

  useEffect(() => {
    viewRef.current = { selectedFamily, selectedWallet, highlightFamily };
    engineRef.current?.redraw();
  }, [selectedFamily, selectedWallet, highlightFamily]);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const tooltip = tooltipRef.current;
    const context = canvas?.getContext('2d');
    if (!stage || !canvas || !tooltip || !context) return;
    const engine = startMap(
      { stage, canvas, context, tooltip, tooltipLines: Array.from(tooltip.children) as HTMLElement[] },
      groups,
      () => viewRef.current,
      { onFamily: (group) => clickRef.current(group), onReady: setCounts },
    );
    engineRef.current = engine;
    return () => {
      engine.stop();
      engineRef.current = null;
    };
  }, [groups]);

  return (
    <div className={styles.mapWrap} data-map-wrap>
      {counts !== null ? (
        <p className={styles.mapCount} data-map-count>
          {`${formatInt(counts.dots)} WALLETS IN ${formatInt(counts.families)} LINKED FAMILIES. EACH DOT IS ONE.`}
        </p>
      ) : null}
      <div ref={stageRef} className={styles.map} data-map-stage>
        <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" data-map-canvas />
        <div ref={tooltipRef} className={styles.tooltip} aria-hidden="true" data-map-tooltip>
          <span className={styles.tooltipFirst} />
          <span className={styles.tooltipLine} />
          <span className={styles.tooltipLine} />
        </div>
      </div>
      <div className={styles.mapBottom}>
        {walletHasNoFamily ? (
          <p data-map-no-family>THIS WALLET IS IN NO LINKED FAMILY, SO IT IS NOT ON THE MAP.</p>
        ) : (
          <ul className={styles.mapLegend} aria-label="Dot colours" data-map-legend>
            {LEGEND.map(({ outcome, text }) => (
              <li key={outcome.name} className={`${styles.mapLegendItem} ${styles[outcome.name]}`}>
                <span className={styles.mapSwatch} aria-hidden="true" />
                {text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

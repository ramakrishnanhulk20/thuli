'use client';

import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { formatInt, formatUsd } from '@/lib/format';
import type { WebGroup, WebPoints } from '@/lib/replay/types';
import { buildClusters, easeOutExpo, hash, moonFor, pickSpacing, placeClusters, rainAt, slotOffset, type HeroLayout, type RainPoint } from './heroLayout';
import styles from './hero.module.css';

const FLIGHT_SECONDS = 0.9;
const CATCH_SPREAD_SECONDS = 3.0;
const TURN_PER_SECOND = 6.2832 / 300;
const FLIGHT_STEPS = 12;
const RAIN_STROKE = [0.26, 0.44, 0.62] as const;
const INK = [239, 234, 224] as const;
const HOLD = [167, 139, 250] as const;
const HOLD_FILL = 'rgba(167, 139, 250, 0.92)';
const HOLD_DIM = 'rgba(167, 139, 250, 0.5)';
const HOLD_HOVER = '#c9b8ff';

interface HeroStageProps {
  groups: WebGroup[];
  keptUsd: number;
  heldTotal: number;
}

interface StageParts {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  section: HTMLElement;
  counter: HTMLElement;
  arc: SVGPathElement;
  caption: SVGTextElement;
  tooltip: HTMLElement;
  tooltipLines: HTMLElement[];
  groups: WebGroup[];
  keptUsd: number;
}

function mixColour(p: number, alpha: number): string {
  const channel = (a: number, b: number) => Math.round(a + (b - a) * p);
  return `rgba(${channel(INK[0], HOLD[0])}, ${channel(INK[1], HOLD[1])}, ${channel(INK[2], HOLD[2])}, ${alpha})`;
}

const FLIGHT_FILL = Array.from({ length: FLIGHT_STEPS }, (_, step) => mixColour((step + 0.5) / FLIGHT_STEPS, 0.92));
const FLIGHT_TAIL = Array.from({ length: FLIGHT_STEPS }, (_, step) => mixColour((step + 0.5) / FLIGHT_STEPS, 0.5));

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smooth(p: number): number {
  return p * p * (3 - 2 * p);
}

const DEGREES = Math.PI / 180;
const BREATH_EASE_SECONDS = 1.5;

// The caption runs along the moon's upper right edge, from -72 to +20 degrees, 14px outside it.
function captionArc(moon: { x: number; y: number; r: number }): string {
  const radiusOut = moon.r + 14;
  const point = (degrees: number) =>
    `${(moon.x + radiusOut * Math.cos(degrees * DEGREES)).toFixed(2)} ${(moon.y + radiusOut * Math.sin(degrees * DEGREES)).toFixed(2)}`;
  return `M ${point(-72)} A ${radiusOut.toFixed(2)} ${radiusOut.toFixed(2)} 0 0 1 ${point(20)}`;
}

function startStage(parts: StageParts): () => void {
  const { canvas, context: ctx, section, counter, arc, caption, tooltip, tooltipLines, groups, keptUsd } = parts;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  const wideQuery = window.matchMedia('(min-width: 1024px)');
  const tabletQuery = window.matchMedia('(min-width: 768px)');
  const mountMs = performance.now();
  const pageAgeSeconds = mountMs / 1000;
  const finalText = formatUsd(keptUsd);
  const abort = new AbortController();
  let stopped = false;

  let W = 0;
  let H = 0;
  let layout: HeroLayout = 'wide';
  let moon = { x: 0, y: 0, r: 0 };
  let dot = 1;

  let ready = false;
  let clusterList: ReturnType<typeof buildClusters> = [];
  let clusterCount = 0;
  let heldCount = 0;
  let walletOf = new Int32Array(0);
  let clusterOf = new Int32Array(0);
  let firstOf = new Int32Array(0);
  let groupOf = new Int32Array(0);
  let paidIds = new Int32Array(0);
  let paidTotal = 0;
  let paidSample = new Int32Array(0);
  let homeX = new Float64Array(0);
  let homeY = new Float64Array(0);
  let radius = new Float64Array(0);
  let slotX = new Float32Array(0);
  let slotY = new Float32Array(0);
  let breath = { w1: new Float64Array(0), w2: new Float64Array(0), f1: new Float64Array(0), f2: new Float64Array(0) };
  let centreX = new Float64Array(0);
  let centreY = new Float64Array(0);
  let startAt = new Float64Array(0);
  let endAt = new Float64Array(0);
  let formedAt = new Float64Array(0);
  let arrivals = new Float64Array(0);
  let rainSegments: Float32Array[] = [];
  let flightSlots: Float32Array[] = [];
  const rainCount = [0, 0, 0];
  const flightCount = new Array<number>(FLIGHT_STEPS).fill(0);
  const rain: RainPoint = { x: 0, y: 0, len: 0, alpha: 0 };
  const flightStart: RainPoint = { x: 0, y: 0, len: 0, alpha: 0 };

  let catchStart = 0;
  let catchEnd = Infinity;
  let catchDone = false;
  let lastCatch = -1;
  let arrivedCount = 0;
  let shown = 0;
  let counterDone = false;
  let lastCounterText = '';

  let hoverCluster = -1;
  let rafId = 0;
  let running = false;
  let lastFrame = 0;
  let onScreen = true;
  let resizeTimer = 0;
  let trigger: ScrollTrigger | null = null;

  const stageSeconds = () => (performance.now() - mountMs) / 1000;

  function measure() {
    W = section.clientWidth;
    H = section.clientHeight;
    layout = wideQuery.matches ? 'wide' : tabletQuery.matches ? 'tablet' : 'mobile';
    const dpr = Math.min(window.devicePixelRatio || 1, layout === 'mobile' ? 1.5 : 2);
    const pixelsWide = Math.round(W * dpr);
    const pixelsHigh = Math.round(H * dpr);
    if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
      canvas.width = pixelsWide;
      canvas.height = pixelsHigh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    moon = moonFor(W, H, layout);
    section.style.setProperty('--moon-x', `${moon.x}px`);
    section.style.setProperty('--moon-y', `${moon.y}px`);
    section.style.setProperty('--moon-r', `${moon.r}px`);
    arc.setAttribute('d', captionArc(moon));
  }

  function place(clusters: ReturnType<typeof buildClusters>) {
    const spacing = pickSpacing(clusters, moon.r);
    dot = Math.max(1, spacing * 0.62);
    const placed = placeClusters(clusters, spacing);
    for (const cluster of placed) {
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
    const maxRain = layout === 'mobile' ? 3500 : 9000;
    const step = Math.ceil(paidTotal / maxRain);
    const sample: number[] = [];
    for (let m = 0; m < paidTotal; m += step) sample.push(paidIds[m] as number);
    paidSample = Int32Array.from(sample);
    const segmentFloats = (paidSample.length + heldCount) * 4;
    if (rainSegments.length === 0 || (rainSegments[0] as Float32Array).length < segmentFloats) {
      rainSegments = [0, 1, 2].map(() => new Float32Array(segmentFloats));
    }
  }

  function schedule(tDataReady: number) {
    catchStart = Math.max(tDataReady + 2.2, 2.4 - pageAgeSeconds);
    let latest = 0;
    formedAt.fill(0);
    for (let k = 0; k < heldCount; k += 1) {
      const q = clusterOf[k] as number;
      const clusterStart = catchStart + CATCH_SPREAD_SECONDS * Math.pow(q / clusterCount, 0.6);
      const s = clusterStart + 0.25 * hash(walletOf[k] as number, 5);
      startAt[k] = s;
      endAt[k] = s + FLIGHT_SECONDS;
      if (endAt[k]! > latest) latest = endAt[k] as number;
      if (endAt[k]! > formedAt[q]!) formedAt[q] = endAt[k] as number;
    }
    catchEnd = latest;
    arrivals = Float64Array.from(endAt).sort();
  }

  function setCentres(t: number, moving: boolean) {
    const turn = moving && t > catchEnd ? (t - catchEnd) * TURN_PER_SECOND : 0;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    for (let q = 0; q < clusterCount; q += 1) {
      const hx = homeX[q] as number;
      const hy = homeY[q] as number;
      let x = moon.x + hx * cos - hy * sin;
      let y = moon.y + hx * sin + hy * cos;
      if (moving) {
        // The drift fades in once the cluster's last dot has landed, so no dot jumps.
        const grow = smooth(clamp01((t - (formedAt[q] as number)) / BREATH_EASE_SECONDS));
        x += grow * 2.5 * Math.sin(t * (breath.w1[q] as number) + (breath.f1[q] as number));
        y += grow * 2.5 * Math.cos(t * (breath.w2[q] as number) + (breath.f2[q] as number));
      }
      centreX[q] = x;
      centreY[q] = y;
    }
  }

  function addRainSegment(id: number, t: number) {
    rainAt(id, t, W, H, rain);
    const bucket = rain.alpha < 0.35 ? 0 : rain.alpha < 0.52 ? 1 : 2;
    const buffer = rainSegments[bucket] as Float32Array;
    const at = rainCount[bucket] as number;
    buffer[at] = rain.x;
    buffer[at + 1] = rain.y;
    buffer[at + 2] = rain.x - 0.06 * rain.len;
    buffer[at + 3] = rain.y - rain.len;
    rainCount[bucket] = at + 4;
  }

  function strokeRain(alphaScale: number) {
    ctx.lineWidth = 1;
    for (let bucket = 0; bucket < 3; bucket += 1) {
      const used = rainCount[bucket] as number;
      if (used === 0) continue;
      const buffer = rainSegments[bucket] as Float32Array;
      ctx.strokeStyle = `rgba(${INK[0]}, ${INK[1]}, ${INK[2]}, ${((RAIN_STROKE[bucket] as number) * alphaScale).toFixed(3)})`;
      ctx.beginPath();
      for (let at = 0; at < used; at += 4) {
        ctx.moveTo(buffer[at] as number, buffer[at + 1] as number);
        ctx.lineTo(buffer[at + 2] as number, buffer[at + 3] as number);
      }
      ctx.stroke();
    }
  }

  function drawFlights(t: number) {
    flightCount.fill(0);
    for (let k = 0; k < heldCount; k += 1) {
      const s = startAt[k] as number;
      if (t < s || t >= endAt[k]!) continue;
      const p = easeOutExpo((t - s) / FLIGHT_SECONDS);
      const q = clusterOf[k] as number;
      rainAt(walletOf[k] as number, s, W, H, flightStart);
      const targetX = moon.x + (homeX[q] as number) + (slotX[k] as number);
      const targetY = moon.y + (homeY[q] as number) + (slotY[k] as number);
      const step = Math.min(FLIGHT_STEPS - 1, Math.floor(p * FLIGHT_STEPS));
      const buffer = flightSlots[step] as Float32Array;
      const at = flightCount[step] as number;
      buffer[at] = flightStart.x + (targetX - flightStart.x) * p;
      buffer[at + 1] = flightStart.y + (targetY - flightStart.y) * p;
      buffer[at + 2] = flightStart.len * (1 - p);
      flightCount[step] = at + 3;
    }
    const half = dot / 2;
    for (let step = 0; step < FLIGHT_STEPS; step += 1) {
      const used = flightCount[step] as number;
      if (used === 0) continue;
      const buffer = flightSlots[step] as Float32Array;
      ctx.strokeStyle = FLIGHT_TAIL[step] as string;
      ctx.beginPath();
      for (let at = 0; at < used; at += 3) {
        ctx.moveTo(buffer[at] as number, buffer[at + 1] as number);
        ctx.lineTo(buffer[at] as number, (buffer[at + 1] as number) - (buffer[at + 2] as number));
      }
      ctx.stroke();
      ctx.fillStyle = FLIGHT_FILL[step] as string;
      ctx.beginPath();
      for (let at = 0; at < used; at += 3) {
        ctx.rect((buffer[at] as number) - half, (buffer[at + 1] as number) - half, dot, dot);
      }
      ctx.fill();
    }
  }

  function drawHeld(t: number, everyoneHere: boolean) {
    const half = dot / 2;
    ctx.beginPath();
    for (let q = 0; q < clusterCount; q += 1) {
      if (q === hoverCluster) continue;
      const cx = centreX[q] as number;
      const cy = centreY[q] as number;
      const end = firstOf[q + 1] as number;
      for (let k = firstOf[q] as number; k < end; k += 1) {
        if (!everyoneHere && t < (endAt[k] as number)) continue;
        ctx.rect(cx + (slotX[k] as number) - half, cy + (slotY[k] as number) - half, dot, dot);
      }
    }
    ctx.fillStyle = hoverCluster >= 0 ? HOLD_DIM : HOLD_FILL;
    ctx.fill();
    if (hoverCluster < 0) return;
    const big = dot * 1.25;
    const bigHalf = big / 2;
    const cx = centreX[hoverCluster] as number;
    const cy = centreY[hoverCluster] as number;
    const end = firstOf[hoverCluster + 1] as number;
    ctx.beginPath();
    for (let k = firstOf[hoverCluster] as number; k < end; k += 1) {
      ctx.rect(cx + (slotX[k] as number) - bigHalf, cy + (slotY[k] as number) - bigHalf, big, big);
    }
    ctx.fillStyle = HOLD_HOVER;
    ctx.fill();
  }

  function updateCounter(t: number, seconds: number) {
    if (counterDone) return;
    while (arrivedCount < heldCount && (arrivals[arrivedCount] as number) <= t) arrivedCount += 1;
    const target = (keptUsd * arrivedCount) / heldCount;
    // Frame-rate independent form of "move 18 percent of the way each frame at 60 frames a second".
    shown += (target - shown) * (1 - Math.pow(0.82, seconds * 60));
    if (arrivedCount === heldCount && target - shown < 1) {
      counter.textContent = finalText;
      counterDone = true;
      return;
    }
    const text = formatUsd(Math.round(shown));
    if (text !== lastCounterText) {
      counter.textContent = text;
      lastCounterText = text;
    }
  }

  function updateCatch(t: number) {
    if (catchDone) return;
    const value = Math.round(clamp01((t - catchStart) / (catchEnd - catchStart)) * 1000) / 1000;
    if (value !== lastCatch) {
      section.style.setProperty('--catch', String(value));
      lastCatch = value;
    }
    if (value === 1) {
      catchDone = true;
      caption.style.opacity = '1';
    }
  }

  function drawFrame(t: number, seconds: number) {
    ctx.clearRect(0, 0, W, H);
    const mobile = layout === 'mobile';
    let rainScale = Math.min(1, t / 0.6);
    if (t > catchEnd) rainScale *= 1 - 0.45 * easeOutExpo((t - catchEnd) / 1.2);

    rainCount.fill(0);
    for (let m = 0; m < paidSample.length; m += 1) addRainSegment(paidSample[m] as number, t);
    if (t < catchEnd) {
      for (let k = 0; k < heldCount; k += 1) {
        if (t >= (startAt[k] as number)) continue;
        const id = walletOf[k] as number;
        if (mobile && id % 3 !== 0) continue;
        addRainSegment(id, t);
      }
    }
    strokeRain(rainScale);

    setCentres(t, true);
    if (t < catchEnd) drawFlights(t);
    drawHeld(t, t >= catchEnd);
    updateCounter(t, seconds);
    updateCatch(t);
  }

  function drawStill() {
    ctx.clearRect(0, 0, W, H);
    rainCount.fill(0);
    const step = Math.ceil(paidTotal / 1500);
    for (let m = 0; m < paidTotal; m += step) addRainSegment(paidIds[m] as number, 0);
    strokeRain(0.55);
    setCentres(0, false);
    drawHeld(0, true);
  }

  function frame(now: number) {
    rafId = requestAnimationFrame(frame);
    const t = Math.max(0, (now - mountMs) / 1000);
    const seconds = lastFrame === 0 ? 1 / 60 : Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    drawFrame(t, seconds);
  }

  function syncLoop() {
    const shouldRun = ready && !reduced && onScreen && document.visibilityState === 'visible';
    if (shouldRun && !running) {
      running = true;
      lastFrame = 0;
      rafId = requestAnimationFrame(frame);
    } else if (!shouldRun && running) {
      running = false;
      cancelAnimationFrame(rafId);
    }
  }

  function setHover(next: number) {
    if (next === hoverCluster) return;
    hoverCluster = next;
    canvas.style.cursor = next >= 0 ? 'pointer' : '';
    tooltip.style.opacity = next >= 0 ? '1' : '0';
    if (next >= 0) {
      const groupIndex = groupOf[next] as number;
      const group = groupIndex >= 0 ? groups[groupIndex] : undefined;
      const lines = group
        ? [`${formatInt(group.size)} linked wallets`, `${formatInt(group.held)} held back`, `${formatInt(group.robo)} ROBO claimed`]
        : ['1 wallet held back', 'No linked group'];
      tooltipLines.forEach((node, index) => {
        node.textContent = lines[index] ?? '';
        node.style.display = index < lines.length ? 'block' : 'none';
      });
    }
    if (reduced && ready) drawStill();
  }

  function onPointerMove(event: PointerEvent) {
    if (!finePointer || !ready || (!reduced && stageSeconds() < catchEnd)) return;
    const box = canvas.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    let found = -1;
    for (let q = 0; q < clusterCount; q += 1) {
      const dx = px - (centreX[q] as number);
      const dy = py - (centreY[q] as number);
      const reach = (radius[q] as number) + 4;
      if (dx * dx + dy * dy <= reach * reach) {
        found = q;
        break;
      }
    }
    setHover(found);
    if (found < 0) return;
    const bounds = section.getBoundingClientRect();
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

  function build(points: WebPoints) {
    const clusters = buildClusters(points);
    clusterCount = clusters.length;
    heldCount = clusters.reduce((sum, cluster) => sum + cluster.members.length, 0);
    walletOf = new Int32Array(heldCount);
    clusterOf = new Int32Array(heldCount);
    firstOf = new Int32Array(clusterCount + 1);
    groupOf = new Int32Array(clusterCount);
    let at = 0;
    clusters.forEach((cluster, q) => {
      firstOf[q] = at;
      groupOf[q] = cluster.groupIndex;
      for (const wallet of cluster.members) {
        walletOf[at] = wallet;
        clusterOf[at] = q;
        at += 1;
      }
    });
    firstOf[clusterCount] = at;

    const paid: number[] = [];
    for (let i = 0; i < points.count; i += 1) {
      if ((points.outcome[i] as number) <= 1) paid.push(i);
    }
    paidIds = Int32Array.from(paid);
    paidTotal = paid.length;

    homeX = new Float64Array(clusterCount);
    homeY = new Float64Array(clusterCount);
    radius = new Float64Array(clusterCount);
    centreX = new Float64Array(clusterCount);
    centreY = new Float64Array(clusterCount);
    slotX = new Float32Array(heldCount);
    slotY = new Float32Array(heldCount);
    startAt = new Float64Array(heldCount);
    endAt = new Float64Array(heldCount);
    formedAt = new Float64Array(clusterCount);
    flightSlots = Array.from({ length: FLIGHT_STEPS }, () => new Float32Array(heldCount * 3));
    breath = {
      w1: Float64Array.from({ length: clusterCount }, (_, q) => 6.2832 / (7 + 4 * hash(q, 11))),
      w2: Float64Array.from({ length: clusterCount }, (_, q) => 6.2832 / (7 + 4 * hash(q, 12))),
      f1: Float64Array.from({ length: clusterCount }, (_, q) => 6.2832 * hash(q, 13)),
      f2: Float64Array.from({ length: clusterCount }, (_, q) => 6.2832 * hash(q, 14)),
    };
    clusterList = clusters;
    place(clusters);
  }

  function finishStill() {
    section.style.setProperty('--catch', '1');
    caption.style.opacity = '1';
    counter.textContent = finalText;
    drawStill();
  }

  function applyLayout() {
    measure();
    if (ready) {
      place(clusterList);
      if (reduced) drawStill();
    }
    trigger?.refresh();
  }

  function validPoints(value: unknown): value is WebPoints {
    const points = value as WebPoints;
    return (
      points !== null &&
      typeof points === 'object' &&
      points.schema === 1 &&
      Number.isInteger(points.count) &&
      points.outcome.length === points.count &&
      points.group.length === points.count
    );
  }

  if (!reduced) counter.textContent = '$0';
  lastCounterText = '$0';

  measure();
  const resizeObserver = new ResizeObserver(() => {
    if (section.clientWidth === W && section.clientHeight === H) return;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(applyLayout, 150);
  });
  resizeObserver.observe(section);

  const intersection = new IntersectionObserver((entries) => {
    const latest = entries[entries.length - 1];
    if (latest === undefined) return;
    onScreen = latest.isIntersecting;
    syncLoop();
  });
  intersection.observe(section);

  const onVisibility = () => syncLoop();
  document.addEventListener('visibilitychange', onVisibility);
  section.addEventListener('pointermove', onPointerMove);
  section.addEventListener('pointerleave', onPointerLeave);

  if (!reduced) {
    gsap.registerPlugin(ScrollTrigger);
    trigger = ScrollTrigger.create({
      trigger: section,
      start: 'top top',
      end: 'bottom top',
      scrub: true,
      onUpdate: (self) => section.style.setProperty('--hero-scroll', self.progress.toFixed(4)),
    });
    section.style.setProperty('--hero-scroll', trigger.progress.toFixed(4));
  }

  fetch('/replay/robo/points.json', { signal: abort.signal })
    .then((response) => {
      if (!response.ok) throw new Error(`points.json answered ${response.status}`);
      return response.json() as Promise<unknown>;
    })
    .then((value) => {
      if (stopped) return;
      if (!validPoints(value)) throw new Error('points.json does not match the expected shape');
      build(value);
      ready = true;
      if (reduced) {
        finishStill();
      } else {
        schedule(stageSeconds());
        syncLoop();
      }
    })
    .catch(() => {
      if (stopped) return;
      counter.textContent = finalText;
    });

  return () => {
    stopped = true;
    abort.abort();
    cancelAnimationFrame(rafId);
    window.clearTimeout(resizeTimer);
    resizeObserver.disconnect();
    intersection.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    section.removeEventListener('pointermove', onPointerMove);
    section.removeEventListener('pointerleave', onPointerLeave);
    trigger?.kill();
    section.style.removeProperty('--catch');
    section.style.removeProperty('--hero-scroll');
    caption.style.opacity = '';
    tooltip.style.opacity = '';
    canvas.style.cursor = '';
    counter.textContent = finalText;
  };
}

export function HeroStage({ groups, keptUsd, heldTotal }: HeroStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const arcRef = useRef<SVGPathElement>(null);
  const captionRef = useRef<SVGTextElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const arc = arcRef.current;
    const caption = captionRef.current;
    const tooltip = tooltipRef.current;
    const section = canvas?.closest('section');
    const counter = section?.querySelector<HTMLElement>('[data-hero-counter-number]');
    const context = canvas?.getContext('2d');
    if (!canvas || !arc || !caption || !tooltip || !section || !counter || !context) return;
    const tooltipLines = Array.from(tooltip.children) as HTMLElement[];
    return startStage({ canvas, context, section, counter, arc, caption, tooltip, tooltipLines, groups, keptUsd });
  }, [groups, keptUsd]);

  return (
    <>
      <div className={styles.violet} aria-hidden="true" />
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      <svg className={styles.captionArc} aria-hidden="true">
        <path ref={arcRef} id="hero-caption-arc" fill="none" />
        <text ref={captionRef} className={styles.captionText}>
          <textPath href="#hero-caption-arc">{formatInt(heldTotal)} WALLETS HELD BACK. EACH DOT IS ONE.</textPath>
        </text>
      </svg>
      <div ref={tooltipRef} className={styles.tooltip} aria-hidden="true">
        <span className={styles.tooltipFirst} />
        <span className={styles.tooltipLine} />
        <span className={styles.tooltipLine} />
      </div>
    </>
  );
}

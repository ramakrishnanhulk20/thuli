import type { WebPoints } from '../../lib/replay/types';

const GOLDEN_ANGLE = 2.399963;
const FULL_TURN = 6.2832;
const OUTCOME_HOLD = 2;

/** Held wallets of one linked group, or one held wallet linked to no group (groupIndex -1). Members are wallet indexes. */
export interface Cluster {
  groupIndex: number;
  members: number[];
}

/** home offsets are measured from the moon centre. */
export interface PlacedCluster extends Cluster {
  rank: number;
  r: number;
  homeX: number;
  homeY: number;
}

export interface RainPoint {
  x: number;
  y: number;
  len: number;
  alpha: number;
}

export function hash(i: number, salt: number): number {
  const seed = i * 2654435761 + salt * 40503;
  const a = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function buildClusters(points: WebPoints): Cluster[] {
  const byGroup = new Map<number, Cluster>();
  const clusters: Cluster[] = [];
  for (let i = 0; i < points.count; i += 1) {
    if ((points.outcome[i] ?? 0) < OUTCOME_HOLD) continue;
    const group = points.group[i] ?? -1;
    if (group === -1) {
      clusters.push({ groupIndex: -1, members: [i] });
      continue;
    }
    let cluster = byGroup.get(group);
    if (cluster === undefined) {
      cluster = { groupIndex: group, members: [] };
      byGroup.set(group, cluster);
      clusters.push(cluster);
    }
    cluster.members.push(i);
  }
  clusters.sort((a, b) => b.members.length - a.members.length || (a.members[0] as number) - (b.members[0] as number));
  return clusters;
}

export function discRadius(n: number, d: number): number {
  return 0.564 * d * Math.sqrt(n) + 0.5 * d + 1.5;
}

function formationRadius(clusters: Cluster[], d: number): number {
  let sum = 0;
  for (const cluster of clusters) {
    const r = discRadius(cluster.members.length, d);
    sum += r * r;
  }
  return Math.sqrt(1.6 * sum);
}

/** The widest dot spacing, in px, at which the whole formation still fits inside moonRadius. */
export function pickSpacing(clusters: Cluster[], moonRadius: number): number {
  let lo = 0.6;
  let hi = 6;
  for (let round = 0; round < 24; round += 1) {
    const mid = (lo + hi) / 2;
    if (formationRadius(clusters, mid) <= moonRadius) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** A sunflower of discs: the largest cluster first, each next one on the golden angle at a radius that grows with the area used so far. */
export function placeClusters(clusters: Cluster[], d: number): PlacedCluster[] {
  let used = 0;
  return clusters.map((cluster, rank) => {
    const r = discRadius(cluster.members.length, d);
    used += r * r;
    const rho = Math.sqrt(1.6 * (used - (r * r) / 2));
    const phi = rank * GOLDEN_ANGLE;
    return { ...cluster, rank, r, homeX: rho * Math.cos(phi), homeY: rho * Math.sin(phi) };
  });
}

/** Where member j sits inside its cluster's disc, as an offset from the cluster centre. */
export function slotOffset(rank: number, j: number, d: number): { x: number; y: number } {
  const rad = 0.564 * d * Math.sqrt(j + 0.5);
  const ang = j * GOLDEN_ANGLE + hash(rank, 7) * FULL_TURN;
  return { x: rad * Math.cos(ang), y: rad * Math.sin(ang) };
}

// Whole-number percentages keep results like 0.7 * 1440 exact instead of 1007.9999999999999.
function percent(of: number, pct: number): number {
  return (pct * of) / 100;
}

export type HeroLayout = 'wide' | 'tablet' | 'mobile';

/** The caller names the layout from the same media queries the CSS uses, so the canvas and the CSS cannot disagree. */
export function moonFor(width: number, height: number, layout: HeroLayout): { x: number; y: number; r: number } {
  if (layout === 'wide') {
    return { x: percent(width, 70), y: percent(height, 37), r: Math.min(percent(width, 27), percent(height, 28)) };
  }
  if (layout === 'tablet') {
    return { x: percent(width, 72), y: percent(height, 16), r: Math.min(percent(width, 36), percent(height, 24)) };
  }
  return { x: percent(width, 80), y: 170, r: percent(width, 60) };
}

/** One raining wallet at time t. Pass out to reuse an object when calling this for thousands of wallets per frame. */
export function rainAt(
  i: number,
  t: number,
  width: number,
  height: number,
  out: RainPoint = { x: 0, y: 0, len: 0, alpha: 0 },
): RainPoint {
  const span = height + 40;
  const speed = 260 + 360 * hash(i, 2);
  const shape = hash(i, 3);
  const y = ((hash(i, 4) * span + speed * t) % span) - 20;
  out.x = hash(i, 1) * width + 0.06 * y;
  out.y = y;
  out.len = 8 + 16 * shape;
  out.alpha = 0.18 + 0.5 * shape;
  return out;
}

export function easeOutExpo(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return 1 - Math.pow(2, -10 * p);
}

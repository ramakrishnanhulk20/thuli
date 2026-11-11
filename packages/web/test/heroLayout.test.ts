// Covers the pure layout maths against the real points.json. It does not cover drawing, the entrance timeline,
// hover, the counter or the CSS; those need a real browser on a built page.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildClusters,
  discRadius,
  easeOutExpo,
  hash,
  moonFor,
  pickSpacing,
  placeClusters,
  rainAt,
  slotOffset,
} from '../components/hero/heroLayout';
import type { WebPoints } from '../lib/replay/types';

const points = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'replay', 'robo', 'points.json'), 'utf8'),
) as WebPoints;

const clusters = buildClusters(points);
const MOON_RADIUS = 261;
const spacing = pickSpacing(clusters, MOON_RADIUS);
// The packing factor heroLayout.ts sizes its formation with; it does not export formationRadius, so the test repeats it.
const FORMATION_PACKING = 1.6;

const heldWallets = points.outcome.flatMap((outcome, i) => (outcome === 2 || outcome === 3 ? [i] : []));

describe('buildClusters', () => {
  it('makes one cluster per held linked group and one per held lone wallet, holding every held wallet', () => {
    const groups = new Set(heldWallets.map((i) => points.group[i]).filter((group) => group !== -1));
    const lone = heldWallets.filter((i) => points.group[i] === -1).length;
    expect(clusters).toHaveLength(groups.size + lone);
    expect(clusters.reduce((sum, cluster) => sum + cluster.members.length, 0)).toBe(heldWallets.length);
  });

  it('sorts the largest first and starts with the 50 wallet group', () => {
    expect(clusters[0]?.members).toHaveLength(50);
    for (let q = 1; q < clusters.length; q += 1) {
      expect((clusters[q - 1] as { members: number[] }).members.length).toBeGreaterThanOrEqual(
        (clusters[q] as { members: number[] }).members.length,
      );
    }
  });

  it('keeps only held wallets and gives each group index its own cluster', () => {
    const seen = new Set<number>();
    for (const cluster of clusters) {
      for (const wallet of cluster.members) {
        expect(points.outcome[wallet]).toBeGreaterThanOrEqual(2);
        expect(points.group[wallet]).toBe(cluster.groupIndex);
      }
      if (cluster.groupIndex !== -1) {
        expect(seen.has(cluster.groupIndex)).toBe(false);
        seen.add(cluster.groupIndex);
      } else {
        expect(cluster.members).toHaveLength(1);
      }
    }
  });
});

describe('pickSpacing and placeClusters', () => {
  it("picks the spacing at which the formation's outer edge is within the moon radius and within 2 px of it", () => {
    const area = clusters.reduce((sum, cluster) => sum + discRadius(cluster.members.length, spacing) ** 2, 0);
    const edge = Math.sqrt(FORMATION_PACKING * area);
    expect(edge).toBeLessThanOrEqual(MOON_RADIUS);
    expect(MOON_RADIUS - edge).toBeLessThanOrEqual(2);
  });

  const placed = placeClusters(clusters, spacing);

  it('keeps every pair of discs at least 0.85 of touching distance apart', () => {
    let closest = Infinity;
    for (let a = 0; a < placed.length; a += 1) {
      const first = placed[a] as (typeof placed)[number];
      for (let b = a + 1; b < placed.length; b += 1) {
        const second = placed[b] as (typeof placed)[number];
        const ratio = Math.hypot(first.homeX - second.homeX, first.homeY - second.homeY) / (first.r + second.r);
        if (ratio < closest) closest = ratio;
      }
    }
    expect(closest).toBeGreaterThanOrEqual(0.85);
  });

  it('keeps every disc inside the moon plus 6px', () => {
    for (const cluster of placed) {
      expect(Math.hypot(cluster.homeX, cluster.homeY) + cluster.r).toBeLessThanOrEqual(MOON_RADIUS + 6);
    }
  });

  it('keeps the packing and the fit at every moon radius the page produces', () => {
    for (const radius of [252, 245.76, 225, 201.6]) {
      const gap = pickSpacing(clusters, radius);
      const set = placeClusters(clusters, gap);
      let closest = Infinity;
      for (let a = 0; a < set.length; a += 1) {
        const first = set[a] as (typeof set)[number];
        expect(Math.hypot(first.homeX, first.homeY) + first.r).toBeLessThanOrEqual(radius + 6);
        for (let b = a + 1; b < set.length; b += 1) {
          const second = set[b] as (typeof set)[number];
          closest = Math.min(closest, Math.hypot(first.homeX - second.homeX, first.homeY - second.homeY) / (first.r + second.r));
        }
      }
      expect(closest).toBeGreaterThanOrEqual(0.85);
    }
  });

  it('numbers the ranks in order and sizes each disc from its member count', () => {
    placed.forEach((cluster, q) => {
      expect(cluster.rank).toBe(q);
      expect(cluster.r).toBeCloseTo(discRadius(cluster.members.length, spacing), 10);
    });
  });

  it('never lets a slot leave its disc', () => {
    for (const cluster of placed) {
      for (let j = 0; j < cluster.members.length; j += 1) {
        const slot = slotOffset(cluster.rank, j, spacing);
        expect(Math.hypot(slot.x, slot.y)).toBeLessThanOrEqual(cluster.r);
      }
    }
  });
});

describe('hash', () => {
  it('returns the same number for the same input', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(hash(i, 3)).toBe(hash(i, 3));
    }
  });

  it('stays inside [0, 1) and gives different numbers for different salts', () => {
    let differs = 0;
    for (let i = 0; i < 5000; i += 1) {
      for (let salt = 1; salt <= 14; salt += 1) {
        const value = hash(i, salt);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
      if (hash(i, 1) !== hash(i, 2)) differs += 1;
    }
    expect(differs).toBeGreaterThan(4990);
  });
});

describe('moonFor', () => {
  it('uses the wide numbers at 1440 by 900', () => {
    expect(moonFor(1440, 900, 'wide')).toEqual({ x: 1008, y: 333, r: 252 });
  });

  it('uses the tablet numbers at 768 by 1024', () => {
    const moon = moonFor(768, 1024, 'tablet');
    expect(moon.x).toBeCloseTo(552.96, 2);
    expect(moon.y).toBeCloseTo(163.84, 2);
    expect(moon.r).toBeCloseTo(245.76, 2);
  });

  it('uses the mobile numbers at 375 by 664', () => {
    expect(moonFor(375, 664, 'mobile')).toEqual({ x: 300, y: 170, r: 225 });
  });

  it('follows the layout it is told, not the width', () => {
    expect(moonFor(1023, 800, 'wide').x).toBeCloseTo(716.1, 6);
    expect(moonFor(1024, 800, 'tablet').x).toBeCloseTo(737.28, 6);
    expect(moonFor(767, 1024, 'tablet').x).toBeCloseTo(552.24, 6);
    expect(moonFor(768, 1024, 'mobile').x).toBeCloseTo(614.4, 6);
  });
});

describe('rainAt and easeOutExpo', () => {
  it('keeps a streak inside the section height plus its margin', () => {
    for (let i = 0; i < 500; i += 1) {
      for (const t of [0, 1.7, 9.2]) {
        const drop = rainAt(i, t, 1440, 900);
        expect(drop.y).toBeGreaterThanOrEqual(-20);
        expect(drop.y).toBeLessThan(920);
        expect(drop.len).toBeGreaterThanOrEqual(8);
        expect(drop.len).toBeLessThan(24);
        expect(drop.alpha).toBeGreaterThanOrEqual(0.18);
        expect(drop.alpha).toBeLessThan(0.68);
      }
    }
  });

  it('eases from 0 to 1', () => {
    expect(easeOutExpo(0)).toBe(0);
    expect(easeOutExpo(1)).toBe(1);
    expect(easeOutExpo(0.5)).toBeGreaterThan(0.9);
  });
});

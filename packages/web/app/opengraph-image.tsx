import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { buildClusters, pickSpacing, placeClusters, slotOffset } from '@/components/hero/heroLayout';
import { formatInt } from '@/lib/format';
import { heroFacts } from '@/lib/replay/derive';
import type { WebPoints, WebSummary } from '@/lib/replay/types';

export const alt = 'Thuli: airdrop rewards for real users, not farms';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const NIGHT = '#05070b';
const INK = '#efeae0';
const INK_2 = '#a9b0ba';
const INK_3 = '#7c8693';
const ACCENT = '#ffb01f';
const HOLD = '#a78bfa';

const MOON_RADIUS = 230;
const MOON_CENTRE = { x: 900, y: 315 };

// next/og cannot read variable fonts, so these are static files, each with its licence beside it. The paths are literal so
// the host's file tracing ships them.
const bold = await readFile(join(process.cwd(), 'public', 'fonts', 'HankenGrotesk-Bold.woff'));
const regular = await readFile(join(process.cwd(), 'public', 'fonts', 'HankenGrotesk-Regular.woff'));
const summaryText = await readFile(join(process.cwd(), 'public', 'replay', 'robo', 'summary.json'), 'utf8');
const pointsText = await readFile(join(process.cwd(), 'public', 'replay', 'robo', 'points.json'), 'utf8');

/**
 * Every held wallet, laid out the way the home page hero lays them out, as one path of small squares. One path renders in
 * well under a second where thousands of separate shapes would not.
 */
function moonPath(points: WebPoints): string {
  const clusters = buildClusters(points);
  const spacing = pickSpacing(clusters, MOON_RADIUS);
  const dot = Math.max(1, spacing * 0.62);
  const parts: string[] = [];
  for (const cluster of placeClusters(clusters, spacing)) {
    for (let j = 0; j < cluster.members.length; j += 1) {
      const slot = slotOffset(cluster.rank, j, spacing);
      const x = MOON_RADIUS + cluster.homeX + slot.x - dot / 2;
      const y = MOON_RADIUS + cluster.homeY + slot.y - dot / 2;
      parts.push(`M${x.toFixed(1)} ${y.toFixed(1)}h${dot.toFixed(2)}v${dot.toFixed(2)}h${(-dot).toFixed(2)}z`);
    }
  }
  return parts.join('');
}

export default function Image() {
  const summary = JSON.parse(summaryText) as WebSummary;
  const points = JSON.parse(pointsText) as WebPoints;
  const { sharePct } = heroFacts(summary);
  const { farmKey } = summary;
  const moon = moonPath(points);
  const box = MOON_RADIUS * 2;

  return new ImageResponse(
    (
      <div style={{ position: 'relative', display: 'flex', width: '100%', height: '100%', background: NIGHT, fontFamily: 'Hanken Grotesk' }}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width={box}
          height={box}
          viewBox={`0 0 ${box} ${box}`}
          style={{ position: 'absolute', left: MOON_CENTRE.x - MOON_RADIUS, top: MOON_CENTRE.y - MOON_RADIUS }}
        >
          <path d={moon} fill={HOLD} />
        </svg>

        <div style={{ position: 'absolute', left: 72, top: 64, display: 'flex', alignItems: 'center' }}>
          <svg xmlns="http://www.w3.org/2000/svg" width={20} height={28.7} viewBox="0 0 12 17.2">
            <path d="M6 0C6 0 0 7.2 0 11.2a6 6 0 0 0 12 0C12 7.2 6 0 6 0Z" fill={ACCENT} />
          </svg>
          <div style={{ marginLeft: 16, fontSize: 34, fontWeight: 700, letterSpacing: 4, color: INK }}>THULI</div>
        </div>

        <div style={{ position: 'absolute', left: 72, top: 178, width: 600, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 54, fontWeight: 700, lineHeight: 1.1, color: INK }}>Farm wallets claimed</div>
          <div style={{ display: 'flex', fontSize: 54, fontWeight: 700, lineHeight: 1.1, color: INK }}>
            <span style={{ color: ACCENT }}>{`${sharePct}%`}</span>
            <span style={{ marginLeft: 14 }}>of this airdrop.</span>
          </div>
          <div style={{ display: 'flex', marginTop: 28, fontSize: 28, fontWeight: 400, lineHeight: 1.35, color: INK_2 }}>
            THULI holds them back before you pay, with a reason for every wallet.
          </div>
        </div>

        <div style={{ position: 'absolute', left: 72, bottom: 52, display: 'flex', fontSize: 16, fontWeight: 400, letterSpacing: 2.4, color: INK_3 }}>
          {`REPLAY OF A REAL AIRDROP · ${formatInt(farmKey.held)} OF ${formatInt(farmKey.wallets)} FARM WALLETS HELD`}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Hanken Grotesk', data: bold, weight: 700, style: 'normal' },
        { name: 'Hanken Grotesk', data: regular, weight: 400, style: 'normal' },
      ],
    },
  );
}

import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { display, body, mono } from './fonts';
import { SmoothScroll } from '@/components/SmoothScroll';
import { Grain } from '@/components/Grain';
import { SiteFooter } from '@/components/site/SiteFooter';
import { siteUrl } from '@/lib/siteUrl';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: 'Thuli', template: '%s · Thuli' },
  description: 'Thuli screens an airdrop claim list, holds back farm wallets, and gives a reason for every wallet it holds.',
};

export const viewport: Viewport = {
  themeColor: '#05070b',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // The docs theme provider sets the colour scheme on the html element in the browser, after the server rendered it,
  // so React is told not to report that one element's attributes as a mismatch.
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <SmoothScroll>
          {children}
          <SiteFooter />
        </SmoothScroll>
        <Grain />
      </body>
    </html>
  );
}

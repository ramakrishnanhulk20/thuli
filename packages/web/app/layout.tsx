import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { display, body, mono } from './fonts';
import { SmoothScroll } from '@/components/SmoothScroll';
import { Grain } from '@/components/Grain';
import { SiteFooter } from '@/components/site/SiteFooter';

export const metadata: Metadata = {
  title: { default: 'Thuli', template: '%s · Thuli' },
  description: 'Thuli screens an airdrop claim list, holds back farm wallets, and gives a reason for every wallet it holds.',
};

export const viewport: Viewport = {
  themeColor: '#05070b',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
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

import './docs.css';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import { DocsBrand } from '@/components/docs/DocsBrand';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ forcedTheme: 'dark', defaultTheme: 'dark' }}>
      <div className="thuli-docs">
        <DocsLayout
          tree={source.getPageTree()}
          nav={{ title: <DocsBrand />, url: '/' }}
          links={[
            { text: 'Replay', url: '/replay', active: 'none' },
            { text: 'Check a wallet', url: '/check', active: 'none' },
            { text: 'Versions', url: '/versions', active: 'none' },
          ]}
          themeSwitch={{ enabled: false }}
        >
          {children}
        </DocsLayout>
      </div>
    </RootProvider>
  );
}

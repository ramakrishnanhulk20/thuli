'use client';

// The whole layout failed, so this page brings its own html and body and uses no part of the site.
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#05070b', color: '#efeae0', fontFamily: 'system-ui, sans-serif' }}>
        <main style={{ minHeight: '100vh', boxSizing: 'border-box', padding: '72px 32px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <p style={{ margin: 0, fontSize: 12, letterSpacing: '0.18em', color: '#a9b0ba' }}>SOMETHING BROKE</p>
          <h1 style={{ margin: '24px 0 0', fontSize: 'clamp(2.25rem, 8vw, 4.5rem)', lineHeight: 1.05 }}>That did not work.</h1>
          <p style={{ margin: '14px 0 0', maxWidth: '52ch', fontSize: 18, lineHeight: 1.55, color: '#a9b0ba' }}>
            The page hit an error on our side. Nothing you did caused it.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '16px 32px', marginTop: 32 }}>
            <button
              type="button"
              onClick={reset}
              style={{ height: 52, padding: '0 22px', border: 0, borderRadius: 8, background: '#ffb01f', color: '#05070b', fontSize: 16, fontWeight: 600, cursor: 'pointer' }}
            >
              Try again
            </button>
            <a href="/" style={{ color: '#efeae0', fontSize: 16, fontWeight: 600 }}>
              Home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}

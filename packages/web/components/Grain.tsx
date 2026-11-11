'use client';

import { useEffect, useState } from 'react';

const SIZE = 256;

const css = `
@keyframes grain-shift {
  0% { transform: translate(0, 0); }
  20% { transform: translate(-3%, 2%); }
  40% { transform: translate(2%, -4%); }
  60% { transform: translate(-4%, -1%); }
  80% { transform: translate(3%, 3%); }
  100% { transform: translate(-1%, 4%); }
}
.grain-layer {
  animation: grain-shift 0.9s steps(1) infinite;
}
`;

export function Grain() {
  const [noise, setNoise] = useState<string | null>(null);

  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const context = canvas.getContext('2d');
    if (!context) return;

    const image = context.createImageData(SIZE, SIZE);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const grey = Math.floor(Math.random() * 256);
      data[i] = grey;
      data[i + 1] = grey;
      data[i + 2] = grey;
      data[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    setNoise(canvas.toDataURL('image/png'));
  }, []);

  return (
    <>
      <style>{css}</style>
      <div
        className="grain-layer"
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: '-50%',
          width: '200%',
          height: '200%',
          pointerEvents: 'none',
          zIndex: 50,
          opacity: 0.07,
          mixBlendMode: 'soft-light',
          backgroundImage: noise ? `url(${noise})` : undefined,
          backgroundRepeat: 'repeat',
        }}
      />
    </>
  );
}

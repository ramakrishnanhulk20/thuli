const RATIO = 17.2 / 12;

export function Drop({ width, className }: { width: number; className?: string }) {
  return (
    <svg viewBox="0 0 12 17.2" width={width} height={width * RATIO} className={className} aria-hidden="true">
      <path d="M6 0C6 0 0 7.2 0 11.2a6 6 0 0 0 12 0C12 7.2 6 0 6 0Z" fill="currentColor" />
    </svg>
  );
}

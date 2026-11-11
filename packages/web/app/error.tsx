'use client';

import { ErrorPage } from '@/components/site/NotFound';

// The error and its digest are not read here: a stack or a message from our side is not for the visitor.
export default function ErrorBoundary({ reset }: { reset: () => void }) {
  return <ErrorPage reset={reset} />;
}

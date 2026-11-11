// Every request under /api/x402/ goes to the paid API unchanged; the API's own routes carry their full paths.
import { thuliApi } from '../../../../lib/server/thuliApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A paid request may settle twice, read a receipt and run a 120 second screening, so the platform must allow 300.
export const maxDuration = 300;

export function GET(request: Request): Promise<Response> {
  return thuliApi().fetch(request);
}

export function POST(request: Request): Promise<Response> {
  return thuliApi().fetch(request);
}

// /api/check and everything under it go to the free check unchanged; the API's own routes carry their full paths.
import { thuliApi } from '../../../../lib/server/thuliApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A new check runs a screening of up to 120 seconds; 300 matches the paid route, which shares the same app.
export const maxDuration = 300;

export function GET(request: Request): Promise<Response> {
  return thuliApi().fetch(request);
}

export function POST(request: Request): Promise<Response> {
  return thuliApi().fetch(request);
}

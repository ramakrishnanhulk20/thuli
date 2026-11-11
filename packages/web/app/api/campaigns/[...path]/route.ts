// Every request under /api/campaigns/ goes to the campaign routes unchanged; the API's own routes carry their full paths.
import { thuliApi } from '../../../../lib/server/thuliApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The campaign routes live in the same app as the paid and free routes, so they get the same allowance.
export const maxDuration = 300;

export function GET(request: Request): Promise<Response> {
  return thuliApi().fetch(request);
}

export function POST(request: Request): Promise<Response> {
  return thuliApi().fetch(request);
}

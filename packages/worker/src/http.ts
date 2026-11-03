export class HttpError extends Error {
  override name = 'HttpError';
}

export interface Limits {
  timeoutMs: number;
  maxBytes: number;
}

export interface JsonReply {
  status: number;
  ok: boolean;
  headers: Headers;
  /** The parsed body, or undefined when the body was empty or not JSON. */
  json: unknown;
}

async function readTextCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(`response was larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/**
 * One HTTP call with a hard timeout, a body size cap, and redirects refused, so a provider can neither hang the
 * worker, flood its memory, nor send it to a host we did not configure (threat model C41, C38).
 * Nothing here logs the request or its headers (C40).
 */
export async function fetchJsonCapped(url: string, init: RequestInit, limits: Limits): Promise<JsonReply> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(limits.timeoutMs) });
  const text = await readTextCapped(response, limits.maxBytes);
  let json: unknown;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, ok: response.ok, headers: response.headers, json };
}

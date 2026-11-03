import { z } from 'zod';
import { GRAPH_ANSWER_JSON_SCHEMA, GraphRecord } from '@thuli/core';
import { loadEnv } from '../env.ts';
import { fetchJsonCapped, type JsonReply } from '../http.ts';

export interface ServConnection {
  baseUrl: string;
  apiKey: string;
}

export interface ServReply {
  /** SERV's run id from the x-openserv-request-id header: the audit id for this decision. */
  requestId: string | null;
  rawText: string;
}

export class ServError extends Error {
  override name = 'ServError';
  readonly status: number | null;
  readonly requestId: string | null;

  constructor(message: string, status: number | null, requestId: string | null) {
    super(message);
    this.status = status;
    this.requestId = requestId;
  }
}

export const SERV_TIMEOUT_MS = 120_000;
export const V2_MODEL = 'gpt-6-luna';
const MAX_REPLY_BYTES = 1024 * 1024;
const MAX_RULEBOOK_CHARS = 50_000;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const ResponsesBody = z.object({
  id: z.string().min(1).max(256),
  output: z.array(z.unknown()).max(1000),
  output_text: z.string().optional(),
});
type ResponsesBody = z.infer<typeof ResponsesBody>;

const MessageItem = z.object({
  type: z.literal('message'),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

const ChatBody = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }) }))
    .min(1),
});

export function connectionFromEnv(): ServConnection {
  const env = loadEnv();
  return { baseUrl: env.SERV_BASE_URL, apiKey: env.SERV_API_KEY };
}

function readRequestId(headers: Headers): string | null {
  const value = headers.get('x-openserv-request-id');
  return value !== null && REQUEST_ID.test(value) ? value : null;
}

/** SERV's own error text, made safe to print: one line, short, and with the key removed if it was ever echoed. */
function serverDetail(reply: JsonReply, apiKey: string): string {
  const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(reply.json);
  if (!parsed.success) return '';
  const text = parsed.data.error.message
    .split(apiKey)
    .join('[key removed]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .slice(0, 200);
  return `: ${text}`;
}

// The key goes only into the Authorization header of the outgoing request. Nothing here logs or returns a request
// header, and errors carry only the status, SERV's cleaned message and the request id (threat model C40).
async function postJson(conn: ServConnection, path: string, body: unknown): Promise<{ reply: JsonReply; requestId: string | null }> {
  const reply = await fetchJsonCapped(
    `${conn.baseUrl}${path}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${conn.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    },
    { timeoutMs: SERV_TIMEOUT_MS, maxBytes: MAX_REPLY_BYTES },
  );
  const requestId = readRequestId(reply.headers);
  if (!reply.ok) {
    throw new ServError(`SERV answered with status ${reply.status}${serverDetail(reply, conn.apiKey)}`, reply.status, requestId);
  }
  return { reply, requestId };
}

function parseResponsesBody(json: unknown, requestId: string | null): ResponsesBody {
  const parsed = ResponsesBody.safeParse(json);
  if (!parsed.success) throw new ServError('SERV reply did not match the Responses shape', null, requestId);
  return parsed.data;
}

// SERV documents output_text on the Responses body; if it is ever absent, the same text sits in the message items.
function outputText(body: ResponsesBody): string {
  if (body.output_text !== undefined) return body.output_text;
  const parts: string[] = [];
  for (const item of body.output) {
    const message = MessageItem.safeParse(item);
    if (!message.success) continue;
    for (const part of message.data.content) {
      if (part.type === 'output_text' && part.text !== undefined) parts.push(part.text);
    }
  }
  return parts.join('');
}

/**
 * Runs one wallet through Thuli's rulebook graph on SERV v3. The flat wallet record travels as JSON in
 * `instructions` and nothing else is sent: graph generation fails whenever the prompt names a caller tool, so the
 * graph gets none, and any funder lookup is bought by Thuli's code before the call. The record is checked again here,
 * so a bad one throws before it is sent. Never streams. Each request has a 120 second timeout.
 *
 * @throws ServError on a non-2xx status, a reply in an unexpected shape, or a reply that asks for a tool.
 */
export async function decideViaGraph(record: GraphRecord, opts: ServConnection & { graphId: string }): Promise<ServReply> {
  const instructions = JSON.stringify(GraphRecord.parse(record));
  const { reply, requestId } = await postJson(opts, '/responses', { model: opts.graphId, instructions });
  const body = parseResponsesBody(reply.json, requestId);
  const askedForTool = body.output.some(
    (item) => typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'function_call',
  );
  if (askedForTool) throw new ServError('the graph asked for a tool, and this build gives it none', null, requestId);
  return { requestId, rawText: outputText(body) };
}

/**
 * Runs one wallet through the rulebook on SERV v2: the rulebook is the system message and the flat wallet record is
 * the user message, with the reply held to the same answer schema the graph uses. The record is checked again here,
 * so a bad one throws before it is sent. Each request has a 120 second timeout.
 *
 * No Prompt Guard: the record carries no text a stranger wrote (C14, C34), so the guard has nothing to catch, and
 * live it refused this rulebook outright with "I can't share that." before the model ran (run 075f6409, 3 Nov).
 *
 * @throws ServError on a non-2xx status, an empty or overlong rulebook, or a reply in an unexpected shape.
 */
export async function decideViaV2(
  record: GraphRecord,
  rulebookText: string,
  conn: ServConnection = connectionFromEnv(),
): Promise<ServReply> {
  const recordJson = JSON.stringify(GraphRecord.parse(record));
  if (rulebookText.trim() === '' || rulebookText.length > MAX_RULEBOOK_CHARS) {
    throw new ServError('the rulebook text is empty or too long', null, null);
  }
  const { reply, requestId } = await postJson(conn, '/chat/completions', {
    model: V2_MODEL,
    messages: [
      { role: 'system', content: rulebookText },
      { role: 'user', content: recordJson },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'thuli_answer', strict: true, schema: GRAPH_ANSWER_JSON_SCHEMA },
    },
  });
  const body = ChatBody.safeParse(reply.json);
  if (!body.success) throw new ServError('SERV reply did not match the chat completion shape', reply.status, requestId);
  return { requestId, rawText: body.data.choices[0]?.message.content ?? '' };
}

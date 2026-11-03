import { z } from 'zod';
import { DECISION_JSON_SCHEMA, RunInput } from '@thuli/core';
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
  /** Transaction hashes our own tools returned during the run. Always empty until paid lookups exist. */
  toolTxs: string[];
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
// The graph itself fails a run that asks for an eleventh tool round, so ten answers is the most worth sending.
export const MAX_TOOL_ROUNDS = 10;
export const V2_MODEL = 'gpt-6-luna';
const MAX_REPLY_BYTES = 1024 * 1024;
const MAX_RULEBOOK_CHARS = 50_000;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const FUNDER_HOP_TOOL = {
  type: 'function',
  name: 'buy_funder_hop',
  description: 'Buy one paid lookup of who funded an address. About one cent, from the capped budget.',
  parameters: {
    type: 'object',
    properties: { address: { type: 'string' } },
    required: ['address'],
    additionalProperties: false,
  },
} as const;

const LOOKUPS_DISABLED = JSON.stringify({ error: 'paid lookups are not enabled in this build' });

const ResponsesBody = z.object({
  id: z.string().min(1).max(256),
  output: z.array(z.unknown()).max(1000),
  output_text: z.string().optional(),
});
type ResponsesBody = z.infer<typeof ResponsesBody>;

const FunctionCallItem = z.object({
  type: z.literal('function_call'),
  call_id: z.string().min(1).max(256),
  name: z.string(),
  arguments: z.string(),
});

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

function functionCalls(body: ResponsesBody, requestId: string | null) {
  const asked = body.output.filter(
    (item) => typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'function_call',
  );
  return asked.map((item) => {
    const call = FunctionCallItem.safeParse(item);
    if (!call.success) throw new ServError('the graph asked for a tool in an unexpected shape', null, requestId);
    return call.data;
  });
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
 * Runs one wallet through Thuli's rulebook graph on SERV v3. The run input travels as JSON in `instructions`; any
 * tool call is answered with an error because paid lookups are not built yet, which the rulebook treats as missing
 * and therefore hold. Never streams. Each request has a 120 second timeout.
 *
 * @throws ServError on a non-2xx status, a reply in an unexpected shape, or more than 10 tool rounds.
 */
export async function decideViaGraph(input: RunInput, opts: ServConnection & { graphId: string }): Promise<ServReply> {
  const runInput = RunInput.parse(input);
  const tools = [FUNDER_HOP_TOOL];
  const first = await postJson(opts, '/responses', {
    model: opts.graphId,
    instructions: JSON.stringify(runInput),
    tools,
  });
  const requestId = first.requestId;
  let body = parseResponsesBody(first.reply.json, requestId);

  for (let round = 0; ; round += 1) {
    const calls = functionCalls(body, requestId);
    if (calls.length === 0) break;
    if (round >= MAX_TOOL_ROUNDS) {
      throw new ServError(`the graph asked for tools more than ${MAX_TOOL_ROUNDS} times`, null, requestId);
    }
    const next = await postJson(opts, '/responses', {
      model: opts.graphId,
      previous_response_id: body.id,
      input: calls.map((call) => ({ type: 'function_call_output', call_id: call.call_id, output: LOOKUPS_DISABLED })),
      tools,
    });
    body = parseResponsesBody(next.reply.json, requestId);
  }

  return { requestId, rawText: outputText(body), toolTxs: [] };
}

/**
 * Runs one wallet through the rulebook on SERV v2: the rulebook is the system message and the run input is the user
 * message, with Prompt Guard switched on and the reply held to the decision schema. Each request has a 120 second
 * timeout.
 *
 * @throws ServError on a non-2xx status or a reply in an unexpected shape.
 */
export async function decideViaV2(
  input: RunInput,
  rulebookText: string,
  conn: ServConnection = connectionFromEnv(),
): Promise<ServReply> {
  const runInput = RunInput.parse(input);
  if (rulebookText.trim() === '' || rulebookText.length > MAX_RULEBOOK_CHARS) {
    throw new ServError('the rulebook text is empty or too long', null, null);
  }
  const { reply, requestId } = await postJson(conn, '/chat/completions', {
    model: V2_MODEL,
    messages: [
      { role: 'system', content: rulebookText },
      { role: 'user', content: JSON.stringify(runInput) },
    ],
    tools: [{ type: 'function', function: { name: 'serv_prompt_guard', parameters: { type: 'object', properties: {} } } }],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'thuli_decision', strict: true, schema: DECISION_JSON_SCHEMA },
    },
  });
  const body = ChatBody.safeParse(reply.json);
  if (!body.success) throw new ServError('SERV reply did not match the chat completion shape', reply.status, requestId);
  return { requestId, rawText: body.data.choices[0]?.message.content ?? '', toolTxs: [] };
}

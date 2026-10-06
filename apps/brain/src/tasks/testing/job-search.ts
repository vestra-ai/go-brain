/**
 * What a stay or travel job does first on the trip's computer: it calls one of Go's MCP search tools with the trip token
 * Go armed for it. Go saves what it showed for the trip, so the offer ids the job returns resolve to those checked prices
 * when it finishes. Lane C's end-to-end test and P7's demo kit use this to play the job's search.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { TRIP_TOKEN_SECRET, v1UserIdFor } from '../computer.js';
import type { FakeV1 } from './fake-v1.js';

/** One result as Go's MCP search answers it. */
export interface JobSearchResult {
  offer_id: string;
  title: string;
  when?: string;
  price_minor: number;
  price: string;
  price_note: string;
  /** Stays: the whole stay. */
  total_paise?: number;
  rating?: number;
  image_url?: string;
  area?: string;
  highlights: string[];
}

/** The TRIP_TOKEN Go last put in the trip user's secrets on the fake /v1. */
export function armedToken(fake: Pick<FakeV1, 'secrets'>, tripId: string): string {
  const token = fake.secrets.get(`${v1UserIdFor(tripId)}/${TRIP_TOKEN_SECRET}`);
  if (!token) throw new Error(`Go has armed no ${TRIP_TOKEN_SECRET} for ${tripId} yet`);
  return token;
}

/** Calls one of Go's search tools as the trip's computer does, and answers what Go showed. */
export async function searchAsTheJob(o: {
  goUrl: string;
  token: string;
  tool: 'search_flights' | 'search_trains' | 'search_buses' | 'search_stays';
  args: Record<string, unknown>;
}): Promise<{ checked_at: string; results: JobSearchResult[] }> {
  const client = new Client({ name: 'trip-computer', version: '1.0.0' });
  const url = new URL(`${o.goUrl.replace(/\/+$/, '')}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${o.token}` } } });
  // The transport's sessionId getter is `string | undefined`, which exactOptionalPropertyTypes refuses for Transport.
  await client.connect(transport as Transport);
  try {
    const r = (await client.callTool({ name: o.tool, arguments: o.args })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    const text = r.content.find((c) => c.type === 'text')?.text ?? '{}';
    if (r.isError) throw new Error(`${o.tool} was refused: ${text}`);
    return JSON.parse(text) as { checked_at: string; results: JobSearchResult[] };
  } finally {
    await client.close();
  }
}

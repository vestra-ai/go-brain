/**
 * Go's MCP server for the trip's computer, built per request and locked to the one trip its token names. It offers
 * the trip, people's group-visible facts, recall over this trip's chat, a suggestion of a fact (note, checked by
 * Go's memory), and read-only travel search. It never answers private facts, contact details, budget answers,
 * money or cards. Every call is logged.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Brain } from '../app.js';
import type { Trip } from '../door/methods.js';
import { formatInr, subtitleFor } from '../travel/cards.js';
import { TravelError } from '../travel/mcp-travel.js';
import { toResultOption, type ResultsStore } from '../travel/results.js';
import { FlightsArgs, JourneyArgs, OPTION_KIND, StaysArgs, flightsQuery, journeyQuery, staysQuery } from '../travel/tools.js';
import type { Travel, TravelKind, TravelQuery } from '../travel/travel.js';

type Memory = NonNullable<Brain['memory']>;

export interface GoMcpDeps {
  packs: Pick<Brain['packs'], 'get'>;
  memory: () => Memory | undefined;
  travel: () => Travel | undefined;
  /** Every search is saved as the trip's result set, so a finished job's offer ids resolve to these checked prices. */
  results: Pick<ResultsStore, 'save'>;
  record: (row: { tripId: string; tool: string; args: unknown; ok: boolean; ms: number }) => Promise<void>;
  nowMs?: () => number;
}

export const GO_MCP_TOOLS = ['trip', 'person', 'recall', 'note', 'search_flights', 'search_trains', 'search_buses', 'search_stays'] as const;

const ok = (v: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const refuse = (v: unknown): CallToolResult => ({ ...ok(v), isError: true });
const READ_ONLY = { readOnlyHint: true } as const;
const NOT_READY = { error: 'not_available', note: "Go's memory is not set up yet. Use the job context." };

/** The trip as the group sees it. Left out on purpose: budget answers, money, the invite link, ids, photos. */
export function tripSummary(trip: Trip): Record<string, unknown> {
  return {
    title: trip.title,
    status: trip.status,
    destination: trip.destination?.name ?? null,
    dates: trip.dates ?? null,
    vibe: trip.vibe,
    stay: trip.stay ?? null,
    people: trip.people.map((p) => ({ name: p.name, from_city: p.from_city ?? null, earliest_leave: p.earliest_leave ?? null, said: p.know })),
    decided: trip.record.filter((r) => r.status === 'active' && (r.kind === 'decided' || r.kind === 'agreed' || r.kind === 'booked')).slice(0, 30).map((r) => r.text),
    open: trip.record.filter((r) => r.status === 'active' && (r.kind === 'open' || r.kind === 'doing')).slice(0, 20).map((r) => r.text),
    bookings: trip.bookings.filter((b) => b.status === 'confirmed').map((b) => ({ kind: b.kind, title: b.title, starts_at: b.starts_at ?? null, ends_at: b.ends_at ?? null })),
    open_votes: trip.decisions.filter((d) => d.status === 'open').map((d) => ({ question: d.question, options: d.options.map((o) => o.label) })),
  };
}

function findPerson(trip: Trip, name: string): { person_id: string; name: string } | { candidates: string[] } | null {
  const want = name.trim().toLowerCase();
  const exact = trip.people.filter((p) => p.name.toLowerCase() === want);
  if (exact.length === 1) return exact[0]!;
  const starts = trip.people.filter((p) => p.name.toLowerCase().startsWith(want));
  if (starts.length === 1) return starts[0]!;
  if (starts.length > 1) return { candidates: starts.map((p) => p.name) };
  return null;
}

async function searchFor(tripId: string, kind: TravelKind, q: TravelQuery, d: GoMcpDeps): Promise<CallToolResult> {
  const travel = d.travel();
  if (!travel) return refuse({ error: 'not_available', note: 'Travel search is not set up.' });
  try {
    const found = await travel.search(kind, q, { tripId });
    const shown = found.results.slice(0, 10);
    if (shown.length > 0) {
      await d.results.save({ tripId, optionKind: OPTION_KIND[kind], source: 'search', query: { via: 'trip_computer', kind, ...q }, options: shown.map(toResultOption), checkedAt: found.checkedAt });
    }
    return ok({
      checked_at: found.checkedAt,
      results: shown.map((o) => {
        const when = subtitleFor(toResultOption(o));
        return {
          offer_id: o.offerId ?? null,
          ...(o.sourceUrl ? { source_url: o.sourceUrl } : {}),
          title: o.title,
          ...(when ? { when } : {}),
          price_minor: o.priceMinor,
          price: `${formatInr(o.priceMinor)} ${o.priceNote}`,
          price_note: o.priceNote,
          ...(o.totalMinor !== undefined ? { total_paise: o.totalMinor } : {}),
          ...(o.rating !== undefined ? { rating: o.rating } : {}),
          ...(o.imageUrl ? { image_url: o.imageUrl } : {}),
          ...(typeof o.facts.area === 'string' ? { area: o.facts.area } : {}),
          highlights: o.highlights,
        };
      }),
    });
  } catch (err) {
    if (err instanceof TravelError) return refuse({ error: err.code, note: err.message });
    throw err;
  }
}

export function buildGoMcpServer(tripId: string, d: GoMcpDeps): McpServer {
  const server = new McpServer({ name: 'go-trip', version: '1.0.0' });
  const clock = d.nowMs ?? Date.now;
  /** A throw becomes an isError answer, never a transport error; every call is logged. */
  const guard =
    <A>(tool: string, run: (a: A) => Promise<CallToolResult>) =>
    async (a: A): Promise<CallToolResult> => {
      const started = clock();
      let result: CallToolResult;
      try {
        result = await run(a);
      } catch (err) {
        result = refuse({ error: 'failed', detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
      }
      await d.record({ tripId, tool, args: a ?? {}, ok: result.isError !== true, ms: clock() - started }).catch(() => undefined);
      return result;
    };

  server.registerTool(
    'trip',
    {
      description: 'This trip as the group sees it: destination, dates, who is coming (where they leave from, what they told the group), what was decided or booked, what is still open, and open votes. Read it first when the job needs trip facts.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guard('trip', async () => ok(tripSummary((await d.packs.get(tripId)).trip))),
  );

  server.registerTool(
    'person',
    {
      description: 'What one person in this trip told the group about themselves (food, travel times, likes), one line per fact with the message it came from. Only what the group can see.',
      inputSchema: { name: z.string().min(1).max(80) },
      annotations: READ_ONLY,
    },
    guard('person', async (a: { name: string }) => {
      const memory = d.memory();
      if (!memory) return refuse(NOT_READY);
      const trip = (await d.packs.get(tripId)).trip;
      const found = findPerson(trip, a.name);
      if (!found) return refuse({ error: 'no_such_person', people: trip.people.map((p) => p.name) });
      if ('candidates' in found) return refuse({ error: 'which_person', people: found.candidates });
      return ok({ name: found.name, page: await memory.page(tripId, found.person_id, 'group') });
    }),
  );

  server.registerTool(
    'recall',
    {
      description: "Searches this trip's chat for a question, and answers the matching messages with their numbers. This trip only.",
      inputSchema: { question: z.string().min(2).max(300) },
      annotations: READ_ONLY,
    },
    guard('recall', async (a: { question: string }) => {
      const memory = d.memory();
      if (!memory) return refuse(NOT_READY);
      const hits = await memory.recall(tripId, a.question, 'group');
      return ok({ hits: hits.slice(0, 10).map((h) => ({ text: h.text, message_id: h.messageId, seq: h.seq })) });
    }),
  );

  server.registerTool(
    'note',
    {
      description: 'Suggests a lasting fact about a person in this trip (for example a food need they said), with the id of the message that proves it. Go checks the proof before it keeps it.',
      inputSchema: { person: z.string().min(1).max(80), topic: z.string().min(1).max(40), text: z.string().min(1).max(200), proof_message_id: z.string().min(1).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guard('note', async (a: { person: string; topic: string; text: string; proof_message_id: string }) => {
      const memory = d.memory();
      if (!memory) return refuse(NOT_READY);
      const trip = (await d.packs.get(tripId)).trip;
      const found = findPerson(trip, a.person);
      if (!found || 'candidates' in found) return refuse({ error: 'no_such_person', people: trip.people.map((p) => p.name) });
      const result = await memory.note(tripId, { personId: found.person_id, topic: a.topic, text: a.text, proofMessageId: a.proof_message_id, audience: 'group' });
      return ok({ result });
    }),
  );

  const OFFER_RULE = 'Each result has an offer_id: copy it into your answer when you return that option, so Go can book it.';
  const STAY_RULE = 'A stay also has total_paise, the whole stay: copy it as the pick\'s total_paise.';
  server.registerTool(
    'search_flights',
    { description: `Flights on one date with live prices in paise. ${OFFER_RULE}`, inputSchema: FlightsArgs.shape, annotations: READ_ONLY },
    guard('search_flights', (a: z.infer<typeof FlightsArgs>) => searchFor(tripId, 'flights', flightsQuery(a), d)),
  );
  server.registerTool(
    'search_trains',
    { description: `Trains on one date, one fare per class, with live prices in paise. ${OFFER_RULE}`, inputSchema: JourneyArgs.shape, annotations: READ_ONLY },
    guard('search_trains', (a: z.infer<typeof JourneyArgs>) => searchFor(tripId, 'trains', journeyQuery(a), d)),
  );
  server.registerTool(
    'search_buses',
    { description: `Buses on one date with live prices in paise. ${OFFER_RULE}`, inputSchema: JourneyArgs.shape, annotations: READ_ONLY },
    guard('search_buses', (a: z.infer<typeof JourneyArgs>) => searchFor(tripId, 'buses', journeyQuery(a), d)),
  );
  server.registerTool(
    'search_stays',
    { description: `Villas and hotels for check-in and check-out dates, with nightly and whole-stay prices in paise. ${OFFER_RULE} ${STAY_RULE}`, inputSchema: StaysArgs.shape, annotations: READ_ONLY },
    guard('search_stays', (a: z.infer<typeof StaysArgs>) => searchFor(tripId, 'stays', staysQuery(a), d)),
  );
  return server;
}

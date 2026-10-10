/**
 * The account's saved travellers (ixigo's GET /api/v2/users/traveller, read inside the logged-in page) matched to the
 * people a booking is for, by first name and by kind (adult, child, infant on the day they fly). Keshav, 10 Oct, approved
 * reading them for this. A saved traveller's name and date of birth stay in this run's memory and go only into ixigo's
 * own form: what the model hears is the trip's own name and the outcome ("Meher: matched"), never a saved name.
 */

export type TravellerKind = 'adult' | 'child' | 'infant';

export interface SavedTraveller {
  id: string;
  firstName: string;
  kind: TravellerKind | null;
}

/** Someone the booking is for: their name in the trip and the kind of fare they fly on. */
export interface Wanted {
  personId: string;
  name: string;
  kind: TravellerKind;
}

export type TravellerMatch =
  | { personId: string; name: string; status: 'matched'; travellerId: string }
  /** More than one saved traveller has their first name and kind: they say which, never Go. */
  | { personId: string; name: string; status: 'several'; travellerIds: string[] }
  | { personId: string; name: string; status: 'none' };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** A title before a name: ixigo keeps it apart from the first name. */
const TITLE = /^(mr|mrs|ms|miss|mstr|master|dr)$/;
/** A name's first word, for matching: lower case, no accents, no title ("Dr. Meher Shah" is Meher). */
export const firstNameOf = (name: string): string =>
  name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').trim().split(/\s+/).find((w) => !TITLE.test(w)) ?? '';

/** Whole years from a YYYY-MM-DD birthday to a YYYY-MM-DD day. */
function yearsOn(dob: string, day: string): number | null {
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob);
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!b || !d) return null;
  const years = Number(d[1]) - Number(b[1]);
  return `${d[2]}-${d[3]}` < `${b[2]}-${b[3]}` ? years - 1 : years;
}

/** The kind of fare someone flies on that day: by birthday when ixigo has one (an airline's own ages), else as ixigo files them. */
export function kindOn(t: { dob?: unknown; travellerType?: unknown; age?: unknown }, day: string): TravellerKind | null {
  const years = typeof t.dob === 'string' ? yearsOn(t.dob, day) : typeof t.age === 'number' ? t.age : null;
  if (years !== null) return years >= 12 ? 'adult' : years >= 2 ? 'child' : 'infant';
  const type = typeof t.travellerType === 'string' ? t.travellerType.toLowerCase() : '';
  return type === 'adult' || type === 'child' || type === 'infant' ? type : null;
}

/** The saved travellers in ixigo's answer, as a match needs them: each one's id, first name and kind on the day. */
export function savedTravellers(body: unknown, day: string): SavedTraveller[] {
  const list = isObject(body) && Array.isArray(body['data']) ? body['data'] : Array.isArray(body) ? body : [];
  return list.flatMap((t): SavedTraveller[] => {
    if (!isObject(t)) return [];
    const id = typeof t['id'] === 'string' || typeof t['id'] === 'number' ? String(t['id']) : null;
    const first = typeof t['firstName'] === 'string' ? firstNameOf(t['firstName']) : '';
    return id && first ? [{ id, firstName: first, kind: kindOn(t, day) }] : [];
  });
}

/**
 * Each wanted person's saved traveller: the one whose first name and kind are theirs, each saved traveller once. A saved
 * traveller with no kind on file matches on the name alone.
 */
export function matchTravellers(wanted: Wanted[], saved: SavedTraveller[]): TravellerMatch[] {
  const used = new Set<string>();
  return wanted.map((w): TravellerMatch => {
    const first = firstNameOf(w.name);
    const same = saved.filter((t) => !used.has(t.id) && first !== '' && t.firstName === first && (t.kind === null || t.kind === w.kind));
    if (same.length === 1) {
      used.add(same[0]!.id);
      return { personId: w.personId, name: w.name, status: 'matched', travellerId: same[0]!.id };
    }
    if (same.length > 1) return { personId: w.personId, name: w.name, status: 'several', travellerIds: same.map((t) => t.id) };
    return { personId: w.personId, name: w.name, status: 'none' };
  });
}

/** What the model hears of a match: the trip's own name and the outcome, never a saved traveller's name. */
export function matchSaid(m: TravellerMatch): string {
  if (m.status === 'matched') return `${m.name}: matched`;
  if (m.status === 'several') return `${m.name}: more than one saved traveller with that name, asked them which`;
  return `${m.name}: no saved traveller, asked them`;
}

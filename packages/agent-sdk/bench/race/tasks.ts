/**
 * The race's tasks: 30 real jobs across what Vestra users do, run on both engines (our native
 * engine and the Claude Code engine) on the same model, box and order. Six groups of five:
 * research and summarise, write a file or doc, data wrangling in the box, multi-step tool use,
 * an app action through a test MCP server, and a long-context follow-up.
 *
 * EVERY RUBRIC IS WRITTEN HERE, BEFORE ANY RUN. A blind judge checks each criterion against the
 * run's transcript (the prompts, the tool calls and results, the final reply) without being told
 * which engine ran it. Where the answer is a fact, `mustSay` also checks it mechanically: every
 * value must appear in the last turn's reply (case and thousands separators ignored). The facts
 * are computed in this file from the task's own inline data, so no answer depends on the web or
 * on today's date.
 *
 * Inline data, no seeding: every task brings what it needs in its prompt, so the race needs
 * nothing on the box but the box itself. Two kinds of task need more and say so in `needs`:
 * `web` (research) and `mock-travel-mcp` (the staging travel fixture connected as an MCP server).
 */

export type RaceCategory = 'research' | 'write' | 'data' | 'multistep' | 'app' | 'followup';

export interface RaceTask {
  id: string;
  category: RaceCategory;
  /** One message per turn, sent in order, each after the previous turn ends. */
  turns: readonly string[];
  /** What a correct run does. The judge marks each met or not; the run passes when all are met. */
  rubric: readonly string[];
  /** Facts the last turn's reply must state (case-insensitive, thousands separators ignored). */
  mustSay?: readonly string[];
  /** What the box must offer beyond its own tools. */
  needs?: ReadonlyArray<'web' | 'mock-travel-mcp'>;
  /** The turn whose timing is this task's headline (default: the first). A follow-up names its second. */
  measureTurn?: number;
}

export const RACE_CATEGORIES: readonly RaceCategory[] = ['research', 'write', 'data', 'multistep', 'app', 'followup'];

// ── Inline data, and the answers computed from it ────────────────────────────────────────────

const SALES: ReadonlyArray<[string, number]> = [
  ['North', 1200], ['South', 850], ['East', 430], ['North', 300], ['West', 975], ['East', 610],
  ['South', 220], ['West', 125], ['North', 480], ['East', 90], ['South', 330], ['West', 400],
];
const salesCsv = ['region,amount', ...SALES.map(([r, a]) => `${r},${a}`)].join('\n');
const salesTotals = (): Array<[string, number]> => {
  const t = new Map<string, number>();
  for (const [r, a] of SALES) t.set(r, (t.get(r) ?? 0) + a);
  return [...t.entries()].sort((x, y) => y[1] - x[1]);
};

const PEOPLE: ReadonlyArray<[string, string]> = [
  ['Asha', '1990-05-14'], ['Ben', '1985-12-31'], ['Chen', '2000-01-01'], ['Dara', '1978-07-04'],
  ['Eli', '1995-02-28'], ['Fatima', '2004-11-09'], ['Gus', '1969-03-15'], ['Hana', '1999-01-02'],
];
/** Whole years old on 2026-01-01. */
const ageOn20260101 = (birth: string): number => {
  const [y, m, d] = birth.split('-').map(Number) as [number, number, number];
  return 2026 - y - (m > 1 || (m === 1 && d > 1) ? 1 : 0);
};
const byAge = (): Array<[string, number]> => PEOPLE.map(([n, b]): [string, number] => [n, ageOn20260101(b)]).sort((a, b) => b[1] - a[1]);

const EMAILS = [
  'alice@example.com', 'Bob@Example.com', 'alice@example.com', 'carol@example.org', 'ALICE@example.com',
  'bob@example.com', 'dave@example.net', ' carol@example.org ', 'eve@example.com', 'Dave@example.net',
];
const uniqueEmails = (): string[] => [...new Set(EMAILS.map((e) => e.trim().toLowerCase()))].sort();

const NUMBERS = [12, 15, 7, 22, 9, 30, 18, 11, 25, 14, 8, 19, 27, 16, 10, 21, 13, 24, 17, 20];
const stats = (): { mean: string; median: string; sd: string } => {
  const n = NUMBERS.length;
  const mean = NUMBERS.reduce((a, b) => a + b, 0) / n;
  const s = [...NUMBERS].sort((a, b) => a - b);
  const median = n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
  const sd = Math.sqrt(NUMBERS.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { mean: mean.toFixed(2), median: String(median), sd: sd.toFixed(2) };
};

const SERVICES = ['auth', 'billing', 'search'] as const;
/** 30 log lines; ERROR counts are auth 4, billing 7, search 2 by construction. */
const LOG_LINES: string[] = (() => {
  const errors: Record<(typeof SERVICES)[number], number> = { auth: 4, billing: 7, search: 2 };
  const lines: string[] = [];
  let minute = 0;
  for (const svc of SERVICES) {
    for (let i = 0; i < errors[svc]; i++) lines.push(`2026-09-30T10:${String(minute++).padStart(2, '0')}:00Z ERROR ${svc} request failed (code ${500 + i})`);
  }
  while (lines.length < 30) {
    const svc = SERVICES[lines.length % 3]!;
    lines.push(`2026-09-30T10:${String(minute++).padStart(2, '0')}:00Z INFO ${svc} request ok`);
  }
  // A fixed interleave, so the counts cannot be read off the order.
  return lines.map((l, i) => [l, (i * 17) % 31] as const).sort((a, b) => a[1] - b[1]).map(([l]) => l);
})();

/** 2026: the months with the most weekdays (Mon to Fri). */
const MOST_WEEKDAYS_2026 = ((): string[] => {
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const counts = names.map((_, m) => {
    const days = new Date(Date.UTC(2026, m + 1, 0)).getUTCDate();
    let w = 0;
    for (let d = 1; d <= days; d++) {
      const dow = new Date(Date.UTC(2026, m, d)).getUTCDay();
      if (dow > 0 && dow < 6) w++;
    }
    return w;
  });
  const max = Math.max(...counts);
  return names.filter((_, i) => counts[i] === max);
})();

// ── The long document the follow-ups ask about ─────────────────────────────────────────────

const CITIES = [
  'Lisbon', 'Nairobi', 'Osaka', 'Bogota', 'Tallinn', 'Hanoi', 'Accra', 'Porto', 'Kraków', 'Medellín',
  'Chiang Mai', 'Tbilisi', 'Valletta', 'Cusco', 'Zanzibar', 'Ljubljana', 'Da Nang', 'Mysuru', 'Hobart', 'Reykjavík',
];
const WARDENS = ['Ines Duarte', 'Wanjiru Kamau', 'Haruto Sato', 'Camila Rojas', 'Kristjan Tamm', 'Linh Pham', 'Kofi Mensah'];
interface Office {
  city: string;
  wifi: string;
  leaveWeeks: number;
  warden: string;
  deskCode: string;
  quietFloor: number;
}
const OFFICES: Office[] = CITIES.map((city, i) => ({
  city,
  wifi: `ORBIT-${(i * 37 + 101) % 1000}`,
  leaveWeeks: 12 + ((i * 7) % 14),
  warden: WARDENS[(i * 3) % WARDENS.length]!,
  deskCode: `D${String((i * 491 + 2203) % 9000 + 1000)}`,
  quietFloor: 2 + ((i * 5) % 9),
}));
const office = (city: string): Office => OFFICES.find((o) => o.city === city)!;

/**
 * A fictional company handbook, about 60,000 characters: twenty office sections between long
 * stretches of general policy, each office with a few facts no model can know. Deterministic.
 */
export function handbook(): string {
  const general = (n: number): string =>
    `Section ${n}. General policy. ` +
    Array.from({ length: 14 }, (_, k) =>
      `Rule ${n}.${k + 1}: employees keep shared spaces tidy, book rooms through the portal at least one hour ahead, ` +
      `report broken equipment within a day, and keep visitors with them at all times inside the building.`,
    ).join(' ');
  const parts: string[] = ['ORBIT LABS EMPLOYEE HANDBOOK (fictional, for testing).'];
  OFFICES.forEach((o, i) => {
    parts.push(general(i * 2 + 1));
    parts.push(
      `Section ${i * 2 + 2}. The ${o.city} office. The guest Wi-Fi network is ${o.wifi}. Parental leave at this office is ` +
        `${o.leaveWeeks} weeks at full pay. The fire warden is ${o.warden}. The hot-desk booking code is ${o.deskCode}. ` +
        `The quiet floor is floor ${o.quietFloor}.`,
    );
  });
  parts.push(general(OFFICES.length * 2 + 1));
  return parts.join('\n\n');
}

const READ_FIRST = (doc: string): string =>
  `Here is our company handbook. Read it; I will ask about it next. For now reply only with the word "ready".\n\n${doc}`;

// ── The tasks ───────────────────────────────────────────────────────────────────────────────

const RESEARCH: RaceTask[] = [
  {
    id: 'research-teapot',
    category: 'research',
    needs: ['web'],
    turns: ['Using the web, find what HTTP status code 418 means according to RFC 2324. Answer in two sentences and give the source URL.'],
    rubric: ['Says 418 is "I\'m a teapot".', 'Ties it to RFC 2324 (an April Fools RFC, the Hyper Text Coffee Pot Control Protocol).', 'Gives a source URL.', 'Two sentences or close to it, no padding.'],
    mustSay: ['teapot'],
  },
  {
    id: 'research-python-312',
    category: 'research',
    needs: ['web'],
    turns: ['Look up on python.org when Python 3.12.0 was released, and name two new features from its "What\'s New" page. Cite the page.'],
    rubric: ['Gives the release date as 2 October 2023.', 'Names two real 3.12 features (for example PEP 695 type parameter syntax, PEP 701 f-string changes, PEP 684 per-interpreter GIL, better error messages).', 'Cites a python.org page.'],
    mustSay: ['2023'],
  },
  {
    id: 'research-everest',
    category: 'research',
    needs: ['web'],
    turns: ['From Wikipedia: how tall is Mount Everest in metres per the 2020 survey, and who were the first to reach the summit? Answer in three bullets with the source.'],
    rubric: ['Gives 8,848.86 m (or 8,849 m) from the 2020 survey.', 'Names Edmund Hillary and Tenzing Norgay, 1953.', 'Three bullets.', 'Gives a source link.'],
    mustSay: ['8848', 'Hillary', 'Tenzing'],
  },
  {
    id: 'research-sqlite-vs-postgres',
    category: 'research',
    needs: ['web'],
    turns: ["Research SQLite versus PostgreSQL for a five-person team's internal tool. Give me a five-bullet comparison and a one-line recommendation, citing at least two sources."],
    rubric: ['Five bullets that compare real differences (concurrency or writes, deployment or ops, features, scaling, backups).', 'A one-line recommendation that follows from the bullets.', 'At least two cited sources.', 'No factual errors (for example SQLite is not a server).'],
  },
  {
    id: 'research-node-lts',
    category: 'research',
    needs: ['web'],
    turns: ['Check nodejs.org: which Node.js major version is in Active LTS right now, and when does it reach end of life? One line, with the source.'],
    rubric: ['Names a Node.js major version described as Active LTS.', 'Gives an end-of-life date for it.', 'Cites nodejs.org (the releases page or its schedule).', 'One line.'],
  },
];

const WRITE: RaceTask[] = [
  {
    id: 'write-standup',
    category: 'write',
    turns: ['Write files/standup.md: a Monday standup note about migrating our billing service, with the headings Yesterday, Today and Blockers, three bullets under each.'],
    rubric: ['Writes the file files/standup.md.', 'It has the three headings Yesterday, Today and Blockers.', 'Each heading has three bullets.', 'The content is about migrating a billing service.'],
  },
  {
    id: 'write-decline-email',
    category: 'write',
    turns: ['Draft a polite email declining a proposal from the vendor Northwind for their analytics suite, under 150 words. Save it as files/decline.txt and show me the text.'],
    rubric: ['Writes files/decline.txt.', 'Declines Northwind\'s analytics suite proposal politely.', 'Under 150 words.', 'Shows the text in the reply.'],
    mustSay: ['Northwind'],
  },
  {
    id: 'write-readme',
    category: 'write',
    turns: ["Create files/README.md for a command-line tool named tally that counts words in files: an install section, usage with two examples, and an options table listing --lines and --json."],
    rubric: ['Writes files/README.md.', 'Has an install section.', 'Has usage with two examples of running tally.', 'Has a table that lists --lines and --json with what each does.'],
  },
  {
    id: 'write-budget-csv',
    category: 'write',
    turns: ['Create files/budget.csv with the header month,category,amount and six example rows across three categories for January to March 2026.'],
    rubric: ['Writes files/budget.csv.', 'The header is exactly month,category,amount.', 'Six data rows.', 'Three distinct categories and months only from January to March 2026.'],
  },
  {
    id: 'write-faq-pair',
    category: 'write',
    turns: ['Write files/faq.md with five questions and answers about a coworking space, then files/faq-short.md with the same five questions answered in one line each.'],
    rubric: ['Writes files/faq.md with five Q&As.', 'Writes files/faq-short.md.', 'The short file has the same five questions.', 'Each short answer is one line.'],
  },
];

const DATA: RaceTask[] = [
  {
    id: 'data-sales-by-region',
    category: 'data',
    turns: [`Save this CSV to files/sales.csv, then use a script to total the amount per region, and reply with the totals sorted from highest to lowest.\n\n${salesCsv}`],
    rubric: ['Saves files/sales.csv.', 'Computes the totals with a script (a tool call that runs code), not by eye.', `Totals are ${salesTotals().map(([r, t]) => `${r} ${t}`).join(', ')}.`, 'Sorted highest to lowest.'],
    mustSay: salesTotals().map(([, t]) => String(t)),
  },
  {
    id: 'data-ages',
    category: 'data',
    turns: [
      `Using code, compute each person's age in whole years on 2026-01-01, write files/ages.csv with columns name,age, and tell me the oldest and youngest person with their ages.\n\n${JSON.stringify(PEOPLE.map(([name, birth]) => ({ name, birth })))}`,
    ],
    rubric: ['Writes files/ages.csv with name,age.', 'Ages are computed with code.', `Oldest is ${byAge()[0]![0]} (${byAge()[0]![1]}), youngest is ${byAge().at(-1)![0]} (${byAge().at(-1)![1]}).`, `Birthdays later in the year are handled (for example Ben is ${ageOn20260101('1985-12-31')}).`],
    mustSay: [byAge()[0]![0], String(byAge()[0]![1]), byAge().at(-1)![0], String(byAge().at(-1)![1])],
  },
  {
    id: 'data-unique-emails',
    category: 'data',
    turns: [`How many unique email addresses are in this list, ignoring case and spaces? Write them lowercased and sorted, one per line, to files/unique.txt, and tell me the count.\n\n${EMAILS.join('\n')}`],
    rubric: ['Writes files/unique.txt.', 'Lowercased, trimmed and sorted, one per line.', `The count is ${uniqueEmails().length}.`],
    mustSay: [String(uniqueEmails().length)],
  },
  {
    id: 'data-stats',
    category: 'data',
    turns: [`Using code, give the mean, median and population standard deviation of these numbers, each to two decimal places: ${NUMBERS.join(', ')}`],
    rubric: ['Computes with code.', `Mean ${stats().mean}.`, `Median ${stats().median}.`, `Population standard deviation ${stats().sd}.`],
    mustSay: [stats().mean, stats().median, stats().sd],
  },
  {
    id: 'data-log-errors',
    category: 'data',
    turns: [`Count the ERROR lines per service in this log, and tell me which service has the most errors.\n\n${LOG_LINES.join('\n')}`],
    rubric: ['Counts auth 4, billing 7, search 2.', 'Names billing as the service with the most errors.', 'Counts ERROR lines only, not INFO.'],
    mustSay: ['billing', '7'],
  },
];

const MULTISTEP: RaceTask[] = [
  {
    id: 'multi-fix-test',
    category: 'multistep',
    turns: [
      'Create files/calc/add.js exporting function add(a, b) { return a - b; } and files/calc/add.test.js that asserts add(2, 3) === 5 with node:assert and prints "ok". Run the test, fix add.js so it passes, and run it again to show it passing.',
    ],
    rubric: ['Writes both files.', 'Runs the test and sees it fail first.', 'Fixes add.js to return a + b.', 'Runs the test again and it passes (prints ok).'],
  },
  {
    id: 'multi-primes',
    category: 'multistep',
    turns: ['Write a Python script files/primes.py that prints every prime below 100, run it, and tell me how many there are.'],
    rubric: ['Writes files/primes.py.', 'Runs it (a tool call executing the script).', 'Says there are 25 primes below 100.'],
    mustSay: ['25'],
  },
  {
    id: 'multi-batch-rename',
    category: 'multistep',
    turns: ['Create five files files/batch/note-1.txt to files/batch/note-5.txt, each containing its number, then rename them to files/batch/01.txt to 05.txt and list the folder to show the result.'],
    rubric: ['Creates the five note files with their numbers.', 'Renames them to 01.txt to 05.txt.', 'Lists the folder and the listing shows only 01.txt to 05.txt.'],
  },
  {
    id: 'multi-calendar',
    category: 'multistep',
    turns: ['Using code, make a table of the 12 months of 2026 with the number of days and the number of weekdays (Monday to Friday) in each. Save it as files/calendar-2026.md and tell me which month or months have the most weekdays.'],
    rubric: ['Computes with code.', 'Writes files/calendar-2026.md with 12 rows.', `Names ${MOST_WEEKDAYS_2026.join(' and ')} (23 weekdays each).`],
    mustSay: [...MOST_WEEKDAYS_2026],
  },
  {
    id: 'multi-zip',
    category: 'multistep',
    turns: ['Create a folder files/report with three short text files, zip it into files/report.zip, then tell me the size of the zip in bytes and the files inside it.'],
    rubric: ['Creates three text files in files/report.', 'Creates files/report.zip.', 'Reports a size in bytes read from the file system.', 'Lists the three files inside the zip (read from the archive, not assumed).'],
  },
];

const TRAVEL = 'Use the travel tools (the mock-travel MCP server).';
const APP: RaceTask[] = [
  {
    id: 'app-cheapest',
    category: 'app',
    needs: ['mock-travel-mcp'],
    turns: [`${TRAVEL} Find the cheapest option from Pune to Mumbai on 2026-11-14 and tell me the carrier, the times and the fare.`],
    rubric: ['Calls the travel search tool for Pune to Mumbai on 2026-11-14.', 'Names Deccan Queen as the cheapest.', 'Gives 06:40 to 09:55 and 540 INR.'],
    mustSay: ['Deccan Queen', '540'],
  },
  {
    id: 'app-flight',
    category: 'app',
    needs: ['mock-travel-mcp'],
    turns: [`${TRAVEL} Is there a flight from Bengaluru to Chennai on 2026-12-01? Give its departure time and fare.`],
    rubric: ['Calls the travel search tool for that route and date.', 'Names IndiGo 6E 512.', 'Gives departure 13:05 and fare 4200 INR.'],
    mustSay: ['13:05', '4200'],
  },
  {
    id: 'app-most-seats',
    category: 'app',
    needs: ['mock-travel-mcp'],
    turns: [`${TRAVEL} Which option from Delhi to Jaipur on 2026-11-20 has the most seats left, and how many?`],
    rubric: ['Calls the travel search tool for that route and date.', 'Names Deccan Queen with 12 seats left.'],
    mustSay: ['Deccan Queen', '12'],
  },
  {
    id: 'app-book-cancel',
    category: 'app',
    needs: ['mock-travel-mcp'],
    turns: [
      `${TRAVEL} Book the 09:15 train from Pune to Mumbai on 2026-11-14 for passenger Asha Rao (I confirm the booking and its fare), then cancel that booking and tell me the refund.`,
    ],
    rubric: ['Searches, then books the 09:15 Shatabdi Express for Asha Rao.', 'Cancels the booking it made (same PNR).', 'Reports the refund of 712 INR.'],
    mustSay: ['712'],
  },
  {
    id: 'app-pnr-status',
    category: 'app',
    needs: ['mock-travel-mcp'],
    turns: [`${TRAVEL} Book the cheapest option from Hyderabad to Goa on 2026-12-05 for Ravi Kumar (confirmed), then check that booking's status and tell me the PNR and the status.`],
    rubric: ['Searches, then books the cheapest option (Deccan Queen, 540 INR) for Ravi Kumar.', 'Checks the status with the PNR the booking returned.', 'Reports that PNR and the status confirmed.'],
    mustSay: ['confirmed', 'PNR'],
  },
];

const FOLLOWUP_QUESTIONS: Array<[string, string, (o: Office) => string, string]> = [
  ['followup-wifi', 'Osaka', (o) => o.wifi, 'What is the guest Wi-Fi network at the Osaka office?'],
  ['followup-leave', 'Tbilisi', (o) => `${o.leaveWeeks}`, 'How many weeks of parental leave does the Tbilisi office give?'],
  ['followup-warden', 'Hobart', (o) => o.warden, 'Who is the fire warden at the Hobart office?'],
  ['followup-desk', 'Medellín', (o) => o.deskCode, 'What is the hot-desk booking code at the Medellín office?'],
  ['followup-quiet', 'Reykjavík', (o) => `${o.quietFloor}`, 'Which floor is the quiet floor at the Reykjavík office?'],
];

const FOLLOWUP: RaceTask[] = FOLLOWUP_QUESTIONS.map(([id, city, fact, question]) => ({
  id,
  category: 'followup' as const,
  turns: [READ_FIRST(handbook()), `${question} Answer from the handbook in one sentence.`],
  rubric: ['The first reply is short (it only confirms it read the handbook).', `The second reply gives ${fact(office(city))} for ${city}.`, 'Answers from the handbook in one sentence, without inventing other details.'],
  mustSay: [fact(office(city))],
  measureTurn: 1,
}));

export const RACE_TASKS: readonly RaceTask[] = [...RESEARCH, ...WRITE, ...DATA, ...MULTISTEP, ...APP, ...FOLLOWUP];

/** The tasks named by id (all when none), an unknown id is an error, never a silent skip. */
export function pickRaceTasks(ids: readonly string[] = []): RaceTask[] {
  if (ids.length === 0) return [...RACE_TASKS];
  const unknown = ids.filter((id) => !RACE_TASKS.some((t) => t.id === id));
  if (unknown.length) throw new Error(`race: no task named ${unknown.join(', ')}`);
  return RACE_TASKS.filter((t) => ids.includes(t.id));
}

/**
 * Each slot works in its own folder, `files/race-<slot>/`, so no run finds a file an earlier run
 * left (the 3 Oct dry run: a second run met the first run's files/standup.md, presented it
 * without writing, and failed). The plan rewrites the prompts and the judge the rubric the same way.
 */
export function localizeForSlot(text: string, slot: number): string {
  return text.split('files/').join(`files/race-${slot}/`);
}

/** The mechanical fact check: every `mustSay` value appears in the reply. */
export function checkMustSay(task: RaceTask, reply: string): { pass: boolean; missing: string[] } {
  const norm = (s: string): string => s.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/\s+/g, ' ');
  const text = norm(reply);
  const missing = (task.mustSay ?? []).filter((v) => !text.includes(norm(v)));
  return { pass: missing.length === 0, missing };
}

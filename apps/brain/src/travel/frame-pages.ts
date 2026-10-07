/**
 * The pages Go may show the room a picture of: ixigo.com's search, results and details pages. Never a booking,
 * traveller, payment or sign-in page. Anything else is refused, including every other site: a page earns a picture
 * only by matching one of these patterns, and a word from the never list anywhere in its path or its query's names
 * refuses it even then.
 */

/** In a path, these mean the page is past search: refused whatever else matches. */
const NEVER = /book|pay|checkout|travell?er|passenger|login|signin|sign-in|account|otp|wallet|review/i;
/** The same in a query parameter's name, less "checkout": a hotel search names its dates checkinDate and checkoutDate. */
const NEVER_IN_NAMES = /book|pay|travell?er|passenger|login|signin|sign-in|account|otp|wallet|review/i;

/** ixigo.com's search, results and details pages, by path. */
const IXIGO_PAGES: readonly RegExp[] = [
  /^\/(flights|hotels|trains|buses)\/?$/,
  /^\/search\/result\/flight\/?$/,
  /^\/search\/result\/train\/[A-Za-z]+\/[A-Za-z]+\//,
  /^\/hotels\/search\/result\/?$/,
  /^\/hotels\/\d+\/details\/?$/,
  /^\/buses\/bus_search\//,
  /^\/trains\/\d{4,5}\/?$/,
];

export function isFramePage(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'www.ixigo.com' || u.username !== '' || u.password !== '' || u.port !== '') return false;
  const names = [...u.searchParams.keys()].join(' ');
  if (NEVER.test(u.pathname) || NEVER_IN_NAMES.test(names)) return false;
  return IXIGO_PAGES.some((p) => p.test(u.pathname));
}

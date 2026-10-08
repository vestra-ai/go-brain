/**
 * Go's links live in card actions ("See on ixigo"), never in a chat line: a 300-character ixigo address in the room
 * (demo, 8 Oct) is noise nobody reads, and a link is the one thing a person might tap without Go's card around it.
 * The door takes every http or https link out of a post's text, whatever wrote it, and closes up what is left.
 */
const MARKDOWN_LINK = /\[([^\]\n]+)\]\(https?:\/\/[^)\s]+\)/gi;
const ANGLED_LINK = /<https?:\/\/[^>\s]+>/gi;
/** A link to its last character that isn't closing punctuation: "…details?x=1." leaves the full stop. */
const LINK = /https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/gi;

export function withoutLinks(text: string): string {
  if (!/https?:\/\//i.test(text)) return text;
  return text
    .replace(MARKDOWN_LINK, '$1')
    .replace(ANGLED_LINK, '')
    .replace(LINK, '')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/[,;:]+([.!?])/g, '$1')
    // "book it yourselves on ixigo:" with its link gone ends the sentence instead.
    .replace(/[,;:]+(?=[ \t]*(?:\n|$))/g, '.')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

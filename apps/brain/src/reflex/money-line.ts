/**
 * A line about money, by code alone: someone paid, owes or sent money, or names an amount that is plainly money. Such a
 * line always reaches the model, even when Jev is sure it is not for Go: only a turn records an expense (record_expense)
 * or asks what an unclear one was for ("paid something for the snacks").
 */

// An amount that is plainly money: a currency mark (₹, rs, inr), a unit (k, lakh, rupees), or grouped digits (3,200).
// A bare number is not money: "we're 5 people".
const AMOUNT = /(?:₹|\brs\.?|\binr\b)\s*\d|\d\s*(?:k|thousand|lakh|lac|rupees?|rs\.?|inr)\b|\b\d{1,3}(?:,\d{2,3})+\b/i;
// Paying, owing or sending money, in English and Hinglish ("de diya" and "bhej diya" end in "diya").
const VERB = /\b(?:paid|pay|owe|owes|spent|gave|transferred|diya|bheja|dena|lena|udhaar)\b/i;

export function looksLikeMoney(text: string | null | undefined): boolean {
  return !!text && (AMOUNT.test(text) || VERB.test(text));
}

/** Someone paid, owes or sent money: a line for record_expense, not just a price or a budget ("villa under 8k"). */
export function saysMoneyMoved(text: string | null | undefined): boolean {
  return !!text && VERB.test(text);
}

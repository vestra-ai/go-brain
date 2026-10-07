/**
 * A line about money, by code alone: someone paid, owes or sent money, or names an amount that is plainly money. Such a
 * line always reaches the model, even when Jev is sure it is not for Go: only a turn records an expense (record_expense)
 * or asks what an unclear one was for ("paid something for the snacks").
 *
 * Talk about who will pay ("Who's paying the villa advance?", "yes Rahul pays, we'll UPI him", "split the bar bill 4
 * ways") is not one: nothing has moved yet and there is no amount, so there is nothing to record or ask about. It goes
 * through Jev like any other line; the notes pass still keeps who pays what.
 */

// An amount that is plainly money: a currency mark (₹, rs, inr), a unit (k, lakh, rupees), or grouped digits (3,200).
// A bare number is not money: "we're 5 people".
const AMOUNT = /(?:₹|\brs\.?|\binr\b)\s*\d|\d\s*(?:k|thousand|lakh|lac|rupees?|rs\.?|inr)\b|\b\d{1,3}(?:,\d{2,3})+\b/i;
// Money that moved or is owed, as whole words in their forms, English and Hinglish: paid; owe, owes, owed, owing;
// spent; gave; transferred; reimbursed; "de diya", "bhej diya", "bhej diye" (diya, diye); bheja; dena and lena (owed);
// udhaar; "UPI'd", "UPI kar diya". Bare "pay" is not here: "pay attention", and an arrangement ("I pay for the fuel"),
// moved nothing; payday and PayPal are other words.
const MOVED = /\b(?:paid|ow(?:e|es|ed|ing)|spent|gave|transferred|reimbursed|diya|diye|bheja|bheje|dena|lena|udhaa?r|upi(?:'?d|\s+kar\s+(?:diya|diye|di)))\b/i;

export function looksLikeMoney(text: string | null | undefined): boolean {
  return !!text && (AMOUNT.test(text) || MOVED.test(text));
}

/** Someone paid, owes or sent money: a line for record_expense, not just a price or a budget ("villa under 8k"). */
export function saysMoneyMoved(text: string | null | undefined): boolean {
  return !!text && MOVED.test(text);
}

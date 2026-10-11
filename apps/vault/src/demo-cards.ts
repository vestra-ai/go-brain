/**
 * Demo cards (Keshav, 11 Oct: "we dont have access to stripe in India"). While the vault has no Stripe keys, a card is one
 * of the test cards below. The page matches what the person typed against these numbers, and sends only which test card
 * it is: the vault never receives a card number, and a card that isn't one of these can't even be named to it. It keeps
 * the brand, the last four digits, the expiry and a demo token, sealed like any card's; payments then run on the fake
 * rail, after Face ID and the demo's bank code.
 */
export const DEMO_CARDS = {
  /** 4242 4242 4242 4242: pays. */
  visa_4242: { brand: 'visa', last4: '4242', ref: 'demo_visa_4242' },
  /** 4000 0000 0000 0002: the bank declines it. */
  visa_decline: { brand: 'visa', last4: '0002', ref: 'demo_visa_decline' },
} as const;
export type DemoCardId = keyof typeof DEMO_CARDS;
export const DEMO_CARD_IDS = Object.keys(DEMO_CARDS) as [DemoCardId, ...DemoCardId[]];

/** The demo token the fake rail declines. */
export const DEMO_DECLINE_REF = DEMO_CARDS.visa_decline.ref;
/** The one code the demo's bank step takes, shown on its screen. */
export const DEMO_OTP = '123456';
/** What a card that isn't a test card hears, on the page and from the vault. */
export const DEMO_ONLY = 'This demo takes test cards only.';

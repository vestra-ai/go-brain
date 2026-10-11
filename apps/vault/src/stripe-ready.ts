import type { VaultEnv } from './env.js';

/**
 * Whether the vault can add cards now. The App team's "Save card does nothing" (rev 5 R8, 10 Oct) was the staging vault
 * running on placeholder Stripe keys ("sk_test_…pending_from_keshav"): Stripe refused the card setup with a 401, and its
 * error reached the page in a shape it doesn't read. Placeholder keys pass the env check (it refuses live keys only), and
 * the vault must still start without cards: Face ID approvals on the fake rail need no Stripe. So adding a card is off,
 * said plainly on the page, until the keys are real; and off from the moment Stripe refuses the keys at run time.
 */

/** What the page says while the vault can't add cards. */
export const CARDS_NOT_READY = "Cards can't be added yet on this vault.";
/** What it says when Stripe failed one card call and the keys are fine. */
export const CARDS_DOWN = "Cards can't be added right now. Try again later.";

/** A key that says it is a placeholder: never a real Stripe key. */
const PLACEHOLDER = /pending|placeholder|changeme|replace[_-]?me|your[_-]?key/i;

/** The Stripe settings that hold a placeholder, by name: never their values. */
export function placeholderKeys(env: Pick<VaultEnv, 'STRIPE_SECRET_KEY' | 'STRIPE_PUBLISHABLE_KEY'>): string[] {
  return (['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'] as const).filter((name) => PLACEHOLDER.test(env[name]));
}

export function stripeKeysSet(env: Pick<VaultEnv, 'STRIPE_SECRET_KEY' | 'STRIPE_PUBLISHABLE_KEY'>): boolean {
  return placeholderKeys(env).length === 0;
}

/** An error Stripe's SDK threw (its type names it): its status and words are Stripe's, never the vault's to pass on. */
export function isStripeError(e: unknown): e is { type: string; statusCode?: number; code?: string } {
  const type = (e as { type?: unknown } | null | undefined)?.type;
  return typeof type === 'string' && type.startsWith('Stripe');
}

export interface CardsReady {
  /** Stripe's card form works. */
  ready(): boolean;
  /** No Stripe keys: cards are the demo's test cards (demo-cards.ts), and payments run on the fake rail. */
  demo(): boolean;
  /** For /health: whether adding a card works, and how, never why in a key's words. */
  health(): 'ready' | 'demo' | 'refused_by_stripe';
  /** An error from a card call: when Stripe refused the vault's keys, cards are off from now on. Said once in the log. */
  saw(e: unknown): void;
}

export function cardsReady(env: Pick<VaultEnv, 'STRIPE_SECRET_KEY' | 'STRIPE_PUBLISHABLE_KEY'>, log: { error(obj: object, msg: string): void }): CardsReady {
  const placeholders = placeholderKeys(env);
  const keysSet = placeholders.length === 0;
  let refused = false;
  if (!keysSet) {
    log.error(
      { settings: placeholders },
      `${placeholders.join(' and ')} ${placeholders.length > 1 ? 'are placeholders' : 'is a placeholder'}: cards are the demo's test cards (no money moves) until a Stripe test key is set`,
    );
  }
  return {
    ready: () => keysSet && !refused,
    demo: () => !keysSet,
    health: () => (!keysSet ? 'demo' : refused ? 'refused_by_stripe' : 'ready'),
    saw(e) {
      if (refused || !isStripeError(e)) return;
      if (e.type === 'StripeAuthenticationError' || e.statusCode === 401) {
        refused = true;
        log.error({ type: e.type }, "Stripe refused the vault's keys: adding a card is off until they are set right");
      }
    },
  };
}

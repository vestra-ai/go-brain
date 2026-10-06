import type { ToGoHandler } from '../door/handlers.js';
import type { VaultClient } from './vault-client.js';

/** The Server asks for a link to someone's vault (their You screen). The link is made for that person and lives 5 minutes. */
export function vaultLinkHandler(vault: VaultClient): ToGoHandler<'vault_link'> {
  return async (params) => {
    const link = await vault.homeLink({ personId: params.person_id, start: params.start ?? 'home' });
    return { url: link.url, expires_at: link.expiresAt };
  };
}

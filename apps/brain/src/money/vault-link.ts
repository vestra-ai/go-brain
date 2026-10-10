import type { ToGoHandler } from '../door/handlers.js';
import { SocketCallError } from '../door/rpc.js';
import type { VaultClient } from './vault-client.js';

/** What the Server hears for a vault page Go has not built yet (1.1's add_documents). */
export const NOT_AVAILABLE_YET = 'Adding documents in the vault is not available yet.';
/** 1.3's display "embedded" (rev 5 R8): no vault page allows framing yet, so the App keeps the browser sheet. */
export const EMBEDDED_NOT_YET = 'The vault inside the App is not available yet: open it in the browser sheet.';

/**
 * The Server asks for a link to someone's vault (their You screen). The link is made for that person and lives 5 minutes.
 * add_documents (contract 1.1) is answered 409 conflict, "not available yet", until the vault has the page.
 */
export function vaultLinkHandler(vault: VaultClient): ToGoHandler<'vault_link'> {
  return async (params) => {
    const start = params.start ?? 'home';
    if (start === 'add_documents') throw new SocketCallError(409, NOT_AVAILABLE_YET, 'conflict');
    if (params.display === 'embedded') throw new SocketCallError(409, EMBEDDED_NOT_YET, 'conflict');
    const link = await vault.homeLink({ personId: params.person_id, start });
    return { url: link.url, expires_at: link.expiresAt };
  };
}

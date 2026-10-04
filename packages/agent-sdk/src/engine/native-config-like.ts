/**
 * native-config-like.ts — the minimal structural slice of the product's
 * `NativeConfig` that the SDK engine's native-journal needs.
 *
 * The SDK is the env-free core: it must NOT import the product's full
 * `NativeConfig` (which drags in `@bash/*` + sandbox-only modules). The journal
 * helpers read exactly ONE config field — the injected RuntimeConfig (for the
 * tenant boundary `userId`). Declaring that slice here lets the product pass its
 * richer `HarnessContext<NativeConfig>` (a superset → structurally assignable)
 * while the engine stays dependency-clean.
 */
import type { RuntimeConfig } from '../ports/runtime-config.js';
import type { ProviderTool } from './transport.js';

export interface NativeConfigLike {
  /** The injected per-session runtime values (the env-free port). */
  runtimeConfig?: RuntimeConfig | undefined;
  /** See NativeConfig.onWireTools (read by attachToolSearch). */
  onWireTools?: ((wire: readonly ProviderTool[], model: string) => void) | undefined;
}

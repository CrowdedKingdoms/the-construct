export interface SecurityHeaderOptions {
  /** Every API origin the bundle may dial (configured, or the SDK default). */
  apiOrigins?: Array<string | null | undefined>;
  /** Additional exact origins a fork needs in connect-src. No wildcards. */
  extraConnectSrc?: string[];
  /**
   * Origins that may FRAME this game (the Crowdy Games shell, or a shell of your own).
   * Empty (the default) renders `frame-ancestors 'none'`; the DSH pane always adds
   * `'self'` beside them.
   */
  frameAncestors?: string[];
}

export function tierZoneWildcards(origins: Array<string | null | undefined>): string[];
export function frameAncestorsSource(frameAncestors?: string[]): string;
export function corpFor(options?: SecurityHeaderOptions): 'same-origin' | 'cross-origin';
export function buildCsp(options?: SecurityHeaderOptions): string;
export function buildDshCsp(options?: SecurityHeaderOptions): string;
export function securityHeaders(options?: SecurityHeaderOptions): Record<string, string>;
export function dshSecurityHeaders(options?: SecurityHeaderOptions): Record<string, string>;
export const ISOLATION_HEADERS: readonly string[];

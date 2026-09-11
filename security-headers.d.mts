export interface SecurityHeaderOptions {
  /** Every API origin the bundle may dial (configured, or the SDK default). */
  apiOrigins?: Array<string | null | undefined>;
  /** Additional exact origins a fork needs in connect-src. No wildcards. */
  extraConnectSrc?: string[];
}

export function tierZoneWildcards(origins: Array<string | null | undefined>): string[];
export function buildCsp(options?: SecurityHeaderOptions): string;
export function buildDshCsp(options?: SecurityHeaderOptions): string;
export function securityHeaders(options?: SecurityHeaderOptions): Record<string, string>;
export function dshSecurityHeaders(options?: SecurityHeaderOptions): Record<string, string>;
export const ISOLATION_HEADERS: readonly string[];

export function envFlag(env: Record<string, string | undefined> | undefined, name: string): boolean;

export function stripIsolationHeaders(headers: Record<string, string>): Record<string, string>;

export function constructDevServerOptions(input: {
  proxy?: boolean;
  relaxIsolation?: boolean;
  allowAllHosts?: boolean;
  proxyTarget?: string;
  headers: Record<string, string>;
}): {
  allowedHosts?: true;
  proxy?: {
    '/graphql': { target: string; changeOrigin: true; ws: true };
    '/realtime': { target: string; changeOrigin: true; ws: true };
  };
  headers: Record<string, string>;
};

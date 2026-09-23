/**
 * The local Streamable HTTP port, kept out of `http/main.ts` so the stdio path can name the default
 * in its usage text without dragging the whole OAuth stack into a stdio start.
 */
export const LOCAL_HTTP_PORT = 8765;

/** Environment fallback for `--port`, matching the `MACCABI_CONFIG_DIR` precedent. */
export const PORT_VARIABLE = "MACCABI_MCP_PORT";

export type PortResolution = { readonly port: number } | { readonly error: string };

function parsePort(value: string, source: string): PortResolution {
  if (!/^\d+$/.test(value)) return { error: `${source} needs a whole number between 1 and 65535; got ${JSON.stringify(value)}.` };
  const port = Number(value);
  // A bogus value must never quietly become a surprising bind: 0 would take a random ephemeral port
  // that nothing tells the member about, and anything above 65535 is not a port at all.
  if (port < 1 || port > 65535) return { error: `${source} needs a number between 1 and 65535; got ${value}.` };
  return { port };
}

/** `--port N` beats `MACCABI_MCP_PORT`, which beats the default. An unset or empty variable is ignored. */
export function resolveHttpPort(
  flag: string | undefined,
  environment: Record<string, string | undefined> = process.env,
): PortResolution {
  if (flag !== undefined) return parsePort(flag, "--port");
  const fromEnvironment = environment[PORT_VARIABLE];
  if (!fromEnvironment) return { port: LOCAL_HTTP_PORT };
  return parsePort(fromEnvironment, PORT_VARIABLE);
}

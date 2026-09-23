import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { ReauthenticationRequired } from "@maccabi/core";
import { FileSessionStore, type CredentialStore } from "@maccabi/cli/store";
import { connectSession, serialExecutor, createMaccabiMcpServer, type Executor, type MaccabiMcpOptions, type SessionResolver } from "./tools";

/**
 * Sent only where the session really was rejected upstream, which is also the one path that removes
 * the saved file, so it says both rather than leaving the member wondering what is still on disk.
 */
export const CLI_REAUTHENTICATION_INSTRUCTION =
  "Maccabi rejected the saved session as expired, so it has been removed from local storage; there is nothing left to repair. " +
  "Run `maccabi login` in a terminal (or `maccabi login --id <id>`, then `maccabi login --code <code>`; add `--phone <n>` when several SMS numbers are on file), then retry. " +
  "maccabi_login_start and maccabi_login_verify can sign in from here instead, at the cost of putting the ID number and the SMS code into this conversation.";

/**
 * Loads only the existing CLI's one session file; never reads anything else.
 *
 * Deleting rather than keeping a stale file is deliberate, and was weighed against the
 * alternative. The signal is narrow: the transport raises ReauthenticationRequired only on the one
 * observed F5 expiry shape, and deliberately not on 401/403, which an Imperva challenge can produce
 * against a session that is still alive. By the time it is raised the in-memory jar has already been
 * cleared, so keeping the file would leave disk claiming a credential the running process has
 * already established is dead, and every later run would spend a request rediscovering that. There
 * is also nothing in it to diagnose: it holds cookies and authenticatedAt, and staleness is
 * derivable locally without it. The CLI does the same on the same one condition.
 */
export function localSessionResolver(store: CredentialStore = new FileSessionStore()): SessionResolver {
  return async () => {
    const saved = await store.load();
    if (!saved) return null;
    return {
      session: saved.session, owner: saved.owner,
      save: session => store.save({ session, owner: saved.owner }),
      invalidate: () => store.delete(),
      reauthentication: { instruction: CLI_REAUTHENTICATION_INSTRUCTION },
    };
  };
}

/** Matches the CLI keep-alive default, and is far under the shortest observed idle death. */
export const RENEWAL_INTERVAL_MS = 240_000;

/**
 * Consecutive failed ticks tolerated before renewal gives up for good. At the 240-second interval
 * that is about twelve minutes of uninterrupted failure - far longer than a dropped wifi connection,
 * a DNS hiccup or a single Imperva challenge, and long past the point where a fourth identical
 * attempt would say anything the first three did not. One failure used to be enough to end renewal
 * for the whole process, so a two-second blip four minutes in cost the member an SMS later.
 */
export const RENEWAL_FAILURE_LIMIT = 3;

export interface SessionRenewalOptions {
  resolveSession: SessionResolver;
  /** The same executor the tools use, so a tick never overlaps a tool call on one session. */
  exclusive: Executor;
  connect?: NonNullable<MaccabiMcpOptions["connect"]>;
  fetch?: MaccabiMcpOptions["fetch"];
  intervalMs?: number;
  stderr?: (text: string) => void;
}

/**
 * Maccabi ends an idle session well before its absolute cap, and each CLI invocation is a new process
 * that cannot hold a timer. The stdio server is the one long-lived process here, so renewing from it
 * keeps the session usable between tool calls. Nothing here writes to stdout: that is the MCP channel.
 */
export function startSessionRenewal(options: SessionRenewalOptions): { tick(): Promise<void>; stop(): void } {
  const connect = options.connect ?? ((session, owner) => connectSession(session, owner, options.fetch));
  const report = options.stderr ?? (text => { process.stderr.write(text); });
  let timer: ReturnType<typeof setInterval> | undefined;
  let failures = 0;
  const stop = (): void => { if (timer !== undefined) clearInterval(timer); timer = undefined; };
  const tick = async (): Promise<void> => {
    try {
      await options.exclusive(async () => {
        const lease = await options.resolveSession();
        // Not signed in yet is the ordinary state before the first login, not a failure: try again next tick.
        if (!lease) return;
        const connected = await connect(lease.session, lease.owner);
        await connected.readers.renewSession();
        await lease.save(await connected.exportSession());
      });
      failures = 0;
    } catch (error) {
      // Never invalidate from here. A background timer that deletes the stored session would destroy a
      // credential the member can only replace with a fresh SMS, over a failure they never asked for.
      //
      // A rejected session is final - the transport raises this only on the one observed expiry shape,
      // and no amount of retrying brings it back - so that one stops the timer on the spot. Everything
      // else is very often transient, and the timer absorbs a bounded run of those before giving up.
      if (!(error instanceof ReauthenticationRequired)) {
        failures++;
        if (failures < RENEWAL_FAILURE_LIMIT) return;
      }
      stop();
      report(error instanceof ReauthenticationRequired
        ? "Maccabi MCP background session renewal stopped: Maccabi rejected the saved session as expired. The saved session was left in place; the next tool call reports the real error.\n"
        : `Maccabi MCP background session renewal stopped after ${RENEWAL_FAILURE_LIMIT} consecutive failed renewals. The saved session was left in place; the next tool call reports the real error.\n`);
    }
  };
  timer = setInterval(() => { void tick(); }, options.intervalMs ?? RENEWAL_INTERVAL_MS);
  timer.unref(); // A renewal timer is never a reason for the process to stay alive.
  return { tick, stop };
}

export function startLocalMcp(overrides: Partial<MaccabiMcpOptions> = {}): StdioServerHandle {
  const resolveSession = overrides.resolveSession ?? localSessionResolver();
  // One executor for the tools and the renewal timer, and one bound shared with it, so a stalled
  // renewal is abandoned on the same deadline the tool calls queued behind it are told about.
  const exclusive = overrides.runExclusive ?? serialExecutor(overrides.operationTimeoutMs);
  const handle = serveStdio(() => createMaccabiMcpServer({ ...overrides, resolveSession, runExclusive: exclusive }), {
    onerror: () => process.stderr.write("Maccabi MCP transport error.\n"),
  });
  const renewal = startSessionRenewal({ resolveSession, exclusive, connect: overrides.connect, fetch: overrides.fetch });
  return { close: async () => { renewal.stop(); await handle.close(); } };
}

import { bugs } from "../../../package.json";

/**
 * Where a defect, an unsupported flow or a feature request goes. Taken from the package manifest and
 * exported once, so the CLI help, the MCP server instructions and the read-error guidance cannot drift
 * apart or grow their own copies. Security problems are deliberately not routed here - SECURITY.md
 * sends those to a private advisory instead.
 */
export const ISSUES_URL: string = bugs.url;

/** Safe errors never retain upstream URLs, bodies, headers, or fetch error causes. */
export class MaccabiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ReauthenticationRequired extends MaccabiError {
  constructor(status?: number) {
    super("REAUTHENTICATION_REQUIRED", "Sign in to Maccabi again.", status);
  }
}

export class AuthenticationError extends MaccabiError {
  constructor(code = "AUTHENTICATION_FAILED", status?: number) {
    super(code, "Maccabi sign-in did not complete. Check the login step and try again.", status);
  }
}

export class UpstreamError extends MaccabiError {
  constructor(code = "UPSTREAM_ERROR", status?: number) {
    super(code, "The Maccabi request could not be completed.", status);
  }
}

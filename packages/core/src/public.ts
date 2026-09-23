/**
 * The published surface of `maccabi-health`. Deliberately narrower than `./index`, which is the
 * workspace-internal barrel the CLI and the MCP server import: everything named here is something a
 * library caller constructs, catches, or has to name in a signature. Plumbing that happens to be
 * exported for a sibling package - origin constants, the fetch wrappers, the directory field guard -
 * stays internal, because a name that ships in 0.1.0 cannot be withdrawn without a major bump, while
 * a name left out can be added in 0.2.0 without breaking anyone.
 *
 * `safeClinical` is here for a specific reason. Readers return every field the source sent, including
 * the routing and identity fields listed in `privacy.ts`; the CLI and the MCP server run that filter
 * before anything is printed or put into model context, and the library does not. A caller who logs
 * or forwards a read result needs the same filter, so it is part of the public surface rather than an
 * implementation detail of the two surfaces that happen to use it.
 */
export { MaccabiAuth } from "./auth";
export type { LoginChallenge, LoginPhoneChoice, PendingLogin } from "./auth";

export { MaccabiError, AuthenticationError, ReauthenticationRequired, UpstreamError, ISSUES_URL } from "./errors";

export { safeClinical, OMITTED_KEYS } from "./privacy";

export type { MaccabiSession } from "./session";

export { MaccabiTransport } from "./transport";
export type { TransportOptions } from "./transport";

export { MaccabiReaders, ReadOperationError, READ_ERROR_GUIDANCE } from "./readers";
export type { OwnerIdentity, ReadErrorCode, ReadResult, SourceRecord } from "./readers";

export { MaccabiDirectory } from "./directory";
export type {
  DirectoryCategory, DirectoryDoctor, DirectoryOptions, DirectoryProviderDetails,
  DoctorCity, DoctorSearchOptions, DoctorSearchResult, DoctorSpecialty, ProviderSearchResult,
} from "./directory";

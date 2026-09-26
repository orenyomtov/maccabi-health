/**
 * The MedDream imaging viewer: the eight-hop handoff that turns a portal session into a viewer
 * session, and the four read endpoints that session unlocks.
 *
 * The whole chain is ordinary HTTP. Two hops answer with an auto-submitting HTML form whose hidden
 * inputs are present verbatim in the markup, two hops carry the only copy of a value in `Location`,
 * and the last hop rotates the application cookie, which is the actual authentication event. There is
 * no bearer token anywhere and no JavaScript to run; a cookie jar that keeps cookies per host is the
 * entire runtime requirement. The live run is recorded in `docs/research/LIVE-VALIDATION.md`.
 *
 * Pixel arithmetic is written to be general and to fail loudly rather than to assume one study's
 * numbers. Error status codes are still guesses: the live runs produced no error responses.
 */
import { IMAGING_HANDOFF_PATH, LOGIN_ORIGIN, PORTAL_ORIGIN, VIEWER_ORIGIN, discard, readCappedBody, type TransportRequestInit } from "../transport";

export interface ViewerTransport {
  request(input: string | URL, init?: TransportRequestInit): Promise<Response>;
  /** Optional so a test double need not implement it; the real transport always does. */
  clearViewerCookies?(): Promise<void>;
}
/**
 * The codes this module raises. They are a subset of the reader error codes, so the caller can
 * rethrow them with its own operation name without inventing a vocabulary the guidance map has never
 * heard of. TOKEN_UNAVAILABLE is the handoff failing to produce a viewer session, which is exactly
 * what its guidance already tells a caller to do about it.
 */
export type ImagingViewerErrorCode = "UPSTREAM_HTTP" | "INVALID_RESPONSE" | "TOKEN_UNAVAILABLE" | "UNSUPPORTED_FLOW";
export class ImagingViewerError extends Error {
  constructor(readonly code: ImagingViewerErrorCode, readonly status?: number) {
    super(`imaging viewer: ${code}`);
    this.name = "ImagingViewerError";
  }
}

/** A viewer session, plus the two values every later call has to echo. */
export interface ImagingViewerSession {
  studyInstanceUID: string;
  storageId: string;
  modality: string;
  /** Spring Security advertises it on every response. Not enforced on GET, echoed because the SPA does. */
  csrfToken?: string;
  referer: string;
}
export interface ImagingInstance {
  transferSyntaxUID: string;
  sopInstanceUID: string;
  sopClassUID: string;
  /** Always 0 in the captured /structure while /metadata said 1. Read it as "not populated". */
  numberOfFrames: number;
  [key: string]: unknown;
}
export interface ImagingSeries {
  seriesInstanceUID: string;
  modality: string;
  instances: ImagingInstance[];
  [key: string]: unknown;
}
export interface ImagingStudyStructure {
  studyInstanceUID: string;
  studyDate: string;
  studyTime: string;
  mainModality: string;
  storageId: string;
  series: ImagingSeries[];
  [key: string]: unknown;
}
export interface ImagingImageMetadata {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  sopInstanceUID: string;
  /** The decoded transfer syntax, which is what /pixels serves. /structure reports the stored one. */
  transferSyntaxUID: string;
  rows: number;
  columns: number;
  samplesPerPixel: number;
  bitsAllocated: number;
  numberOfFrames: number;
  [key: string]: unknown;
}
/** Everything a caller needs to interpret the buffer, because the buffer itself carries none of it. */
export interface ImagingPixelGeometry {
  rows: number;
  columns: number;
  samplesPerPixel: number;
  bitsAllocated: number;
  bitsStored?: number;
  pixelRepresentation?: number;
  photometricInterpretation?: string;
  numberOfFrames: number;
  windowCenter?: unknown;
  windowWidth?: unknown;
  transferSyntaxUID: string;
  bytesPerFrame: number;
  expectedBytes: number;
}
export interface ImagingPixels extends ImagingPixelGeometry {
  pixels: Uint8Array;
}

const HTML_LIMIT = 4 * 1024 * 1024;
const JSON_LIMIT = 4 * 1024 * 1024;
const THUMBNAIL_LIMIT = 8 * 1024 * 1024;
/**
 * A cap on the computed frame arithmetic, checked before a single byte is requested. The one measured
 * instance was 1.5 MB; a multi-frame cine series is the shape that would run away, and refusing it
 * with an explicit code beats streaming an unbounded body into memory.
 */
export const PIXEL_BUFFER_LIMIT = 64 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** DICOM allows 64 characters of digits and dots, and the captured UIDs are exactly that. */
const UID = /^\d+(?:\.\d+)*$/;
const STORAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Path segments are interpolated, so a value that is not a DICOM UID never reaches a URL. */
export function assertUid(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || !UID.test(value)) throw new ImagingViewerError("INVALID_RESPONSE");
  return value;
}
function assertStorageId(value: unknown): string {
  if (typeof value !== "string" || !STORAGE_ID.test(value)) throw new ImagingViewerError("INVALID_RESPONSE");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ImagingViewerError("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new ImagingViewerError("INVALID_RESPONSE");
  return value;
}
function count(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new ImagingViewerError("INVALID_RESPONSE");
  return value as number;
}

function headers(session: Pick<ImagingViewerSession, "csrfToken" | "referer">, extra: Record<string, string> = {}): Record<string, string> {
  return { accept: "*/*", referer: session.referer, ...(session.csrfToken ? { "X-CSRF-TOKEN": session.csrfToken } : {}), ...extra };
}
/** Only the entities a server would actually emit inside an attribute value. */
function decodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39|apos);/g, entity =>
    ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" })[entity] ?? entity);
}
/**
 * The two intermediate pages are auto-submitting forms. Reading the hidden inputs out of the markup is
 * the entire "browser" requirement; nothing here executes or needs the page's one inline script.
 */
export function formInputs(html: string): Map<string, string> {
  const inputs = new Map<string, string>();
  for (const [tag] of html.matchAll(/<input\b[^>]*>/gi)) {
    const name = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const key = name?.[1] ?? name?.[2] ?? name?.[3];
    if (key === undefined || inputs.has(key)) continue;
    const value = /\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    inputs.set(key, decodeEntities(value?.[1] ?? value?.[2] ?? value?.[3] ?? ""));
  }
  return inputs;
}

/** Reads Location without following it, because at two hops it holds the only copy of a value. */
async function redirectTarget(response: Response, base: URL | string, origin: string, pathname?: string): Promise<URL> {
  await discard(response);
  if (!REDIRECT_STATUSES.has(response.status)) throw new ImagingViewerError(response.status >= 400 ? "UPSTREAM_HTTP" : "TOKEN_UNAVAILABLE", response.status);
  const location = response.headers.get("location");
  if (!location) throw new ImagingViewerError("TOKEN_UNAVAILABLE", response.status);
  let url: URL;
  try { url = new URL(location, base); } catch { throw new ImagingViewerError("TOKEN_UNAVAILABLE", response.status); }
  if (url.origin !== origin || (pathname !== undefined && url.pathname !== pathname)) throw new ImagingViewerError("TOKEN_UNAVAILABLE", response.status);
  return url;
}
async function html(transport: ViewerTransport, url: URL, init: TransportRequestInit): Promise<string> {
  const response = await transport.request(url, init);
  if (!response.ok) { await discard(response); throw new ImagingViewerError("UPSTREAM_HTTP", response.status); }
  const bytes = await readCappedBody(response, HTML_LIMIT, new ImagingViewerError("INVALID_RESPONSE", response.status));
  try { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); }
  catch { throw new ImagingViewerError("INVALID_RESPONSE", response.status); }
}
async function viewerJson(transport: ViewerTransport, url: URL, init: TransportRequestInit): Promise<unknown> {
  const response = await transport.request(url, init);
  if (!response.ok) { await discard(response); throw new ImagingViewerError("UPSTREAM_HTTP", response.status); }
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) { await discard(response); throw new ImagingViewerError("INVALID_RESPONSE", response.status); }
  const bytes = await readCappedBody(response, JSON_LIMIT, new ImagingViewerError("INVALID_RESPONSE", response.status));
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ImagingViewerError("INVALID_RESPONSE", response.status); }
}

/**
 * Hop 1. The one authenticated portal request whose success is a redirect to the login host, which is
 * also the exact shape of an expired F5 session - hence the transport's single-destination opt-out.
 * The URL embeds member_id_code, member_id and the member's checksum, so it is a credential in itself
 * and is built here rather than handed to or returned to any caller.
 */
export function handoffPath(owner: { memberId: number; memberIdCode: string }, checksumId: string, studyInstanceUID: string): string {
  assertUid(studyInstanceUID);
  if (!/^[A-Za-z0-9]{1,128}$/.test(checksumId)) throw new ImagingViewerError("TOKEN_UNAVAILABLE");
  return `/sonline/TestResultsAPI/webapi/mac/pdf/members/${encodeURIComponent(owner.memberIdCode)}/${owner.memberId}/meddream/token/${encodeURIComponent(studyInstanceUID)}?checksum=${encodeURIComponent(checksumId)}`;
}

/**
 * Hops 1-8. Returns once `/his` has rotated MEDDREAMSESSID to an authenticated one; every later call
 * rides that cookie out of the transport's jar. The chain is re-run per study, because the handoff
 * token is minted per click and nothing in the capture says a viewer session may be reused for a
 * study it was not handed.
 */
export async function openImagingViewer(transport: ViewerTransport, path: string, studyInstanceUID: string): Promise<ImagingViewerSession> {
  // A live viewer F5 session from an earlier run makes the SAML leg answer differently and the token
  // mint fail, so every read after the first returned TOKEN_UNAVAILABLE. Measured live 2026-09-23.
  await transport.clearViewerCookies?.();
  const lobby = `${PORTAL_ORIGIN}/sonline/testsResults/TestsResults/lobby/`;
  const handoff = await transport.request(path, {
    apiAuthorization: false, imagingHandoff: true, redirect: "manual",
    headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", referer: lobby },
  });
  const login = await redirectTarget(handoff, PORTAL_ORIGIN, LOGIN_ORIGIN, IMAGING_HANDOFF_PATH);

  // Hop 2. Stateless: the JWE in the query string is the whole credential, and the page it returns is
  // an auto-submitting form carrying a signed SAML assertion.
  const assertion = formInputs(await html(transport, login, { apiAuthorization: false, headers: { accept: "text/html,application/xhtml+xml", referer: lobby } }));
  const samlResponse = assertion.get("SAMLResponse");
  if (!samlResponse) throw new ImagingViewerError("TOKEN_UNAVAILABLE");
  const acs = new URL("/saml/sp/profile/post/acs", VIEWER_ORIGIN);
  const form = (fields: Record<string, string>, origin: string, referer: string): TransportRequestInit => ({
    method: "POST", redirect: "manual", apiAuthorization: false,
    headers: { "content-type": "application/x-www-form-urlencoded", origin, referer },
    body: new URLSearchParams(fields).toString(),
  });

  // Hops 3-5. The SAML POST establishes the viewer host's own F5 session, which then demands one
  // second leg with an anti-replay nonce echoed back out of a 406-byte page.
  const policy = await redirectTarget(
    await transport.request(acs, form({ SAMLResponse: samlResponse, RelayState: assertion.get("RelayState") ?? "" }, LOGIN_ORIGIN, `${LOGIN_ORIGIN}/`)),
    acs, VIEWER_ORIGIN, "/my.policy");
  const dummy = formInputs(await html(transport, policy, { apiAuthorization: false, headers: { accept: "text/html,application/xhtml+xml", referer: `${LOGIN_ORIGIN}/` } })).get("dummy");
  if (dummy === undefined) throw new ImagingViewerError("TOKEN_UNAVAILABLE");
  const root = await redirectTarget(await transport.request(acs, form({ dummy }, VIEWER_ORIGIN, policy.href)), acs, VIEWER_ORIGIN, "/");

  // Hop 6. The APM appends the HIS token to the URL; this redirect is the only place we can read it,
  // short of parsing the signed assertion that carried it here.
  const shellUrl = await redirectTarget(await transport.request(root, { apiAuthorization: false, redirect: "manual", headers: { referer: `${LOGIN_ORIGIN}/` } }), root, VIEWER_ORIGIN, "/");
  const hisToken = shellUrl.searchParams.get("token");
  if (!hisToken) throw new ImagingViewerError("TOKEN_UNAVAILABLE");

  // Hop 7. The SPA shell issues an anonymous application cookie and the first CSRF token.
  const shell = await transport.request(shellUrl, { apiAuthorization: false, headers: { accept: "text/html,application/xhtml+xml", referer: `${LOGIN_ORIGIN}/` } });
  const csrfToken = shell.headers.get("x-csrf-token") ?? undefined;
  await discard(shell);
  if (!shell.ok) throw new ImagingViewerError("UPSTREAM_HTTP", shell.status);

  // Hop 8. The authentication event: this rotates MEDDREAMSESSID to an authenticated one, and every
  // /studies call fails without the rotated value.
  const referer = shellUrl.href;
  const his = record(await viewerJson(transport, new URL(`/his?token=${encodeURIComponent(hisToken)}`, VIEWER_ORIGIN), { apiAuthorization: false, headers: headers({ csrfToken, referer }) }));
  if (!Array.isArray(his.studyIds)) throw new ImagingViewerError("INVALID_RESPONSE");
  const granted = his.studyIds.map(record).find(entry => entry.studyUid === studyInstanceUID);
  // The viewer answering with a study we did not ask for is the source contradicting itself, not the
  // caller reaching for someone else's row - ownership was already settled before the chain started.
  if (!granted) throw new ImagingViewerError("INVALID_RESPONSE");
  return { studyInstanceUID: assertUid(granted.studyUid), storageId: assertStorageId(granted.storageId), modality: text(granted.modality), csrfToken, referer };
}

function studyPath(session: ImagingViewerSession, suffix: string): URL {
  const url = new URL(`/studies/${encodeURIComponent(session.studyInstanceUID)}${suffix}`, VIEWER_ORIGIN);
  url.searchParams.set("storageId", session.storageId);
  return url;
}
function imagePath(session: ImagingViewerSession, seriesInstanceUID: string, sopInstanceUID: string, suffix: string): URL {
  return studyPath(session, `/series/${encodeURIComponent(assertUid(seriesInstanceUID))}/images/${encodeURIComponent(assertUid(sopInstanceUID))}/${suffix}`);
}

/** The study/series/instance tree. Every UID in it is a path segment of the per-image endpoints. */
export async function readStudyStructure(transport: ViewerTransport, session: ImagingViewerSession): Promise<ImagingStudyStructure> {
  const data = record(await viewerJson(transport, studyPath(session, "/structure"), { apiAuthorization: false, headers: headers(session) }));
  if (assertUid(data.studyInstanceUID) !== session.studyInstanceUID) throw new ImagingViewerError("INVALID_RESPONSE");
  if (!Array.isArray(data.series)) throw new ImagingViewerError("INVALID_RESPONSE");
  for (const value of data.series) {
    const series = record(value);
    assertUid(series.seriesInstanceUID);
    if (!Array.isArray(series.instances)) throw new ImagingViewerError("INVALID_RESPONSE");
    for (const entry of series.instances) assertUid(record(entry).sopInstanceUID);
  }
  return data as unknown as ImagingStudyStructure;
}

/** Per-image DICOM fields. Also the only source of the numbers /pixels needs and does not carry. */
export async function readImageMetadata(transport: ViewerTransport, session: ImagingViewerSession, seriesInstanceUID: string, sopInstanceUID: string): Promise<ImagingImageMetadata> {
  const data = record(await viewerJson(transport, imagePath(session, seriesInstanceUID, sopInstanceUID, "metadata"), { apiAuthorization: false, headers: headers(session) }));
  // The three path segments are echoed in the body; a mismatch means we are reading a different image.
  if (data.studyInstanceUID !== session.studyInstanceUID || data.seriesInstanceUID !== seriesInstanceUID || data.sopInstanceUID !== sopInstanceUID) throw new ImagingViewerError("INVALID_RESPONSE");
  return data as unknown as ImagingImageMetadata;
}

/**
 * The arithmetic the buffer has to satisfy, computed from whatever the metadata actually says rather
 * than from the one modality we have seen. A 16-bit CT doubles bytesPerFrame and a cine series
 * multiplies it; both fall out of this without a special case. A pixel container that is not a whole
 * number of bytes has no defined layout here, and is refused rather than guessed at.
 */
export function pixelGeometry(metadata: ImagingImageMetadata): ImagingPixelGeometry {
  const rows = count(metadata.rows, 1);
  const columns = count(metadata.columns, 1);
  const samplesPerPixel = count(metadata.samplesPerPixel, 1);
  const bitsAllocated = count(metadata.bitsAllocated, 1);
  // /structure reports 0 for every instance while /metadata reported 1 for the same one, so the
  // structure value is "not populated" - but a 0 arriving here would silently zero the arithmetic.
  const numberOfFrames = count(metadata.numberOfFrames, 1);
  if (bitsAllocated % 8 !== 0 || bitsAllocated > 64) throw new ImagingViewerError("UNSUPPORTED_FLOW");
  const bytesPerFrame = rows * columns * samplesPerPixel * (bitsAllocated / 8);
  const expectedBytes = bytesPerFrame * numberOfFrames;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > PIXEL_BUFFER_LIMIT) throw new ImagingViewerError("UNSUPPORTED_FLOW");
  return {
    rows, columns, samplesPerPixel, bitsAllocated, numberOfFrames, bytesPerFrame, expectedBytes,
    transferSyntaxUID: text(metadata.transferSyntaxUID),
    ...(typeof metadata.bitsStored === "number" ? { bitsStored: metadata.bitsStored } : {}),
    ...(typeof metadata.pixelRepresentation === "number" ? { pixelRepresentation: metadata.pixelRepresentation } : {}),
    ...(typeof metadata.photometricInterpretation === "string" ? { photometricInterpretation: metadata.photometricInterpretation } : {}),
    ...(metadata.windowCenter === undefined ? {} : { windowCenter: metadata.windowCenter }),
    ...(metadata.windowWidth === undefined ? {} : { windowWidth: metadata.windowWidth }),
  };
}

/**
 * The raw buffer, with the geometry that makes it readable. There is no header, no magic number and
 * no trailer, so the length check against the metadata arithmetic is the only integrity test a client
 * can perform - which is also why this never returns bytes without the numbers beside them.
 * `content-length` on this response reports the compressed size and is deliberately ignored.
 */
export async function readImagePixels(transport: ViewerTransport, session: ImagingViewerSession, seriesInstanceUID: string, sopInstanceUID: string, metadata: ImagingImageMetadata): Promise<ImagingPixels> {
  const geometry = pixelGeometry(metadata);
  const response = await transport.request(imagePath(session, seriesInstanceUID, sopInstanceUID, "pixels"), { apiAuthorization: false, headers: headers(session) });
  if (!response.ok) { await discard(response); throw new ImagingViewerError("UPSTREAM_HTTP", response.status); }
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/octet-stream") { await discard(response); throw new ImagingViewerError("INVALID_RESPONSE", response.status); }
  const bytes = await readCappedBody(response, PIXEL_BUFFER_LIMIT, new ImagingViewerError("INVALID_RESPONSE", response.status));
  if (bytes.byteLength !== geometry.expectedBytes) throw new ImagingViewerError("INVALID_RESPONSE", response.status);
  return { ...geometry, pixels: bytes };
}

/** A baseline JPEG the server renders itself. Not DICOM, and no size parameter was ever observed. */
export async function readImageThumbnail(transport: ViewerTransport, session: ImagingViewerSession, seriesInstanceUID: string, sopInstanceUID: string): Promise<Uint8Array> {
  const response = await transport.request(imagePath(session, seriesInstanceUID, sopInstanceUID, "thumbnail"), { apiAuthorization: false, headers: headers(session) });
  if (!response.ok) { await discard(response); throw new ImagingViewerError("UPSTREAM_HTTP", response.status); }
  // The captured response declared `image/jpeg;charset=UTF-8`; the charset on a JPEG is a server quirk.
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "image/jpeg") { await discard(response); throw new ImagingViewerError("INVALID_RESPONSE", response.status); }
  const bytes = await readCappedBody(response, THUMBNAIL_LIMIT, new ImagingViewerError("INVALID_RESPONSE", response.status));
  if (bytes.byteLength < 4) throw new ImagingViewerError("INVALID_RESPONSE", response.status);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new ImagingViewerError("INVALID_RESPONSE", response.status);
  return bytes;
}

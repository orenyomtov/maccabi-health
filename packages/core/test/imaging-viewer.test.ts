import { describe, expect, test } from "vitest";
import { MaccabiReaders } from "../src/readers";
import { LOGIN_ORIGIN, MaccabiTransport, PORTAL_ORIGIN, VIEWER_ORIGIN } from "../src/transport";
import { ReauthenticationRequired } from "../src/errors";
import { safeClinical } from "../src/privacy";
import { FIXTURE_MEMBER_ID, testRow } from "./fixtures/test-rows";
import * as fixture from "./fixtures/meddream";

const owner = { member_id: FIXTURE_MEMBER_ID, member_id_code: "0", f_name_hebrew: "דוגמה", l_name_hebrew: "בדיקה", f_name_english: "Example", l_name_english: "Fixture", birth_date: "2000-01-01", sex: "synthetic" };
const bootstrap = (checksum: string | null = fixture.CHECKSUM_ID) => ({
  logged_customer_info: owner,
  current_customer_info: { ...owner, ...(checksum === null ? {} : { checksum_id: checksum }) },
  token: { content: "synthetic", success: true },
});
const testList = () => ({ categories: [], tests: [testRow("lab_result"), testRow("imaging_study", { request_id: fixture.STUDY_UID, doc_id: "synthetic-imaging-doc" })] });

const TOKEN_PATH = `${PORTAL_ORIGIN}/sonline/TokenServerAPI/webapi/mac/v4/members/token/full`;
const TESTS_PATH = `${PORTAL_ORIGIN}/sonline/TestResultsAPI/webapi/mac/v1/members/0/${FIXTURE_MEMBER_ID}/tests`;
const HANDOFF_PATH = `${PORTAL_ORIGIN}/sonline/TestResultsAPI/webapi/mac/pdf/members/0/${FIXTURE_MEMBER_ID}/meddream/token/${fixture.STUDY_UID}`;
const LOGIN_PATH = `${LOGIN_ORIGIN}/imaging/login`;
const ACS_PATH = `${VIEWER_ORIGIN}/saml/sp/profile/post/acs`;
const POLICY_PATH = `${VIEWER_ORIGIN}/my.policy`;
const ROOT_PATH = `${VIEWER_ORIGIN}/`;
const HIS_PATH = `${VIEWER_ORIGIN}/his`;
const STRUCTURE_PATH = `${VIEWER_ORIGIN}/studies/${fixture.STUDY_UID}/structure`;
const image = (suffix: string) => `${VIEWER_ORIGIN}/studies/${fixture.STUDY_UID}/series/${fixture.SERIES_UID}/images/${fixture.SOP_UID}/${suffix}`;

type Handler = (url: URL, init: RequestInit) => Response;
const redirect = (location: string, ...cookies: string[]): Response => {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
};
const page = (body: string) => new Response(body, { headers: { "content-type": "text/html;charset=UTF-8" } });

/**
 * The whole chain against the real transport, because the parts that can go wrong are exactly the
 * parts a stubbed transport would paper over: the per-host cookie jar, the manual redirect reads, and
 * the expiry rule that this flow deliberately walks past once.
 */
class Chain {
  readonly seen: { href: string; method: string; headers: Headers; body: string }[] = [];
  readonly routes: Map<string, Handler>;
  private acsPosts = 0;
  constructor(overrides: Record<string, Handler> = {}, checksum: string | null = fixture.CHECKSUM_ID) {
    this.routes = new Map<string, Handler>([
      [TOKEN_PATH, () => Response.json(bootstrap(checksum))],
      [TESTS_PATH, () => Response.json(testList())],
      [HANDOFF_PATH, () => redirect(`${LOGIN_PATH}?token=${fixture.HANDOFF_TOKEN}`)],
      [LOGIN_PATH, () => page(fixture.samlPage())],
      [ACS_PATH, () => ++this.acsPosts === 1
        ? redirect("/my.policy", "LastMRH_Session=aaaaaaaa; path=/; secure", `MRHSession=${"b".repeat(32)}; path=/; secure`)
        : redirect("/", `MRHSession=${"c".repeat(32)}; path=/; secure`)],
      [POLICY_PATH, () => page(fixture.policyPage())],
      [ROOT_PATH, url => url.searchParams.has("token")
        ? new Response("<html>spa shell</html>", { headers: { "content-type": "text/html;charset=UTF-8", "x-csrf-token": fixture.CSRF_TOKEN, "set-cookie": `MEDDREAMSESSID=${"d".repeat(32)}; Path=/; HttpOnly` } })
        : redirect(`/?token=${fixture.HIS_TOKEN}`)],
      [HIS_PATH, () => new Response(JSON.stringify(fixture.hisResponse()), { headers: { "content-type": "application/json;charset=UTF-8", "set-cookie": `MEDDREAMSESSID=${"e".repeat(32)}; Path=/; HttpOnly` } })],
      [STRUCTURE_PATH, () => Response.json(fixture.studyStructure())],
      [image("metadata"), () => Response.json(fixture.imageMetadata())],
      [image("thumbnail"), () => new Response(fixture.thumbnailJpeg(), { headers: { "content-type": "image/jpeg;charset=UTF-8" } })],
      [image("pixels"), () => new Response(fixture.pixelBuffer(), { headers: { "content-type": "application/octet-stream;charset=UTF-8" } })],
      ...Object.entries(overrides),
    ]);
  }
  readonly fetch = async (input: string | Request | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    this.seen.push({ href: url.href, method, headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : "" });
    const handler = this.routes.get(url.origin + url.pathname);
    if (!handler) throw new Error(`unplanned request: ${method} ${url.origin}${url.pathname}`);
    return handler(url, init);
  };
  paths(): string[] { return this.seen.map(call => new URL(call.href).origin + new URL(call.href).pathname); }
  call(path: string) { return this.seen.filter(entry => entry.href.startsWith(path)); }
}
async function connect(chain: Chain): Promise<{ readers: MaccabiReaders; transport: MaccabiTransport }> {
  const transport = new MaccabiTransport({ fetch: chain.fetch });
  // Authenticated, which is what arms the expiry rule the imaging handoff has to walk past.
  transport.markAuthenticated();
  return { readers: await MaccabiReaders.create(transport), transport };
}

describe("the imaging handoff chain", () => {
  test("walks all eight hops, keeps the portal session alive, and returns the study tree", async () => {
    const chain = new Chain();
    const { readers, transport } = await connect(chain);

    const studies = await readers.listImagingStudies();
    expect(studies.data).toHaveLength(1);
    expect(studies.data[0]!.request_id).toBe(fixture.STUDY_UID);
    expect(studies.source.completeness).toBe("local-filtered-subset");

    const study = await readers.getImagingStudy(fixture.STUDY_UID);
    expect(study.data.studyInstanceUID).toBe(fixture.STUDY_UID);
    expect(study.data.series[0]!.instances).toHaveLength(2);
    expect(study.source.service).toBe("MedDream");

    // The measured hop order, in full. A missing hop means a cookie was never set or never followed.
    expect(chain.paths().slice(-10)).toEqual([
      TESTS_PATH,      // ownership, re-listed fresh before anything leaves the portal
      HANDOFF_PATH,    // 1: mint the JWE, read it out of Location
      LOGIN_PATH,      // 2: JWE -> signed SAML assertion, in an auto-submitting form
      ACS_PATH,        // 3: SAML POST, which mints the viewer host's own F5 session
      POLICY_PATH,     // 4: the APM's second-leg form and its anti-replay nonce
      ACS_PATH,        // 5: echo the nonce back
      ROOT_PATH,       // 6: the APM appends the HIS token to Location
      ROOT_PATH,       // 7: SPA shell, anonymous application cookie and the CSRF token
      HIS_PATH,        // 8: the authentication event - MEDDREAMSESSID is rotated here
      STRUCTURE_PATH,
    ]);

    // The handoff is cookie-authenticated with no bearer, exactly as the capture recorded it.
    const handoff = chain.call(HANDOFF_PATH)[0]!;
    expect(handoff.headers.get("authorization")).toBeNull();
    expect(handoff.headers.get("referer")).toBe(`${PORTAL_ORIGIN}/sonline/testsResults/TestsResults/lobby/`);
    expect(handoff.headers.get("cookie")).toBeNull();

    // Both SAML legs are ordinary form posts of values copied verbatim out of the previous page.
    const [first, second] = chain.call(ACS_PATH);
    expect(first!.method).toBe("POST");
    expect(new URLSearchParams(first!.body).get("SAMLResponse")).toBe("c3ludGhldGlj");
    expect(first!.headers.get("origin")).toBe(LOGIN_ORIGIN);
    expect(second!.body).toBe("dummy=0123456789abcdef0123456789abcdef");
    expect(second!.headers.get("origin")).toBe(VIEWER_ORIGIN);

    // The rotated application cookie is what authorises the study call, and the CSRF token is echoed.
    const structure = chain.call(STRUCTURE_PATH)[0]!;
    expect(structure.headers.get("cookie")).toContain(`MEDDREAMSESSID=${"e".repeat(32)}`);
    expect(structure.headers.get("cookie")).toContain(`MRHSession=${"c".repeat(32)}`);
    expect(structure.headers.get("x-csrf-token")).toBe(fixture.CSRF_TOKEN);
    expect(new URL(structure.href).searchParams.get("storageId")).toBe(fixture.STORAGE_ID);

    // The whole point of the transport opt-out: the portal session is untouched afterwards.
    expect((await transport.exportSession()).authenticatedAt).toBeTruthy();
    expect(await transport.hasPortalSession()).toBe(false);
  });

  test("the viewer host keeps its own cookies, so the two MRHSession values never cross", async () => {
    const chain = new Chain();
    const { readers, transport } = await connect(chain);
    await readers.getImagingStudy(fixture.STUDY_UID);
    const jar = await transport.exportCookies();
    const viewer = jar.cookies.filter(cookie => cookie.key === "MRHSession");
    expect(viewer).toHaveLength(1);
    expect(viewer[0]!.domain).toBe("meddreamy.maccabi4u.co.il");
    // Nothing the viewer set ever reached the portal's jar.
    expect(chain.call(TESTS_PATH)[0]!.headers.get("cookie")).toBeNull();
  });

  test("one viewer session per study serves every later read of it", async () => {
    const chain = new Chain();
    const { readers } = await connect(chain);
    await readers.getImagingStudy(fixture.STUDY_UID);
    await readers.getImagingImage(fixture.STUDY_UID, fixture.SERIES_UID, fixture.SOP_UID);
    expect(chain.paths().filter(path => path === HIS_PATH)).toHaveLength(1);
    expect(chain.paths().filter(path => path === HANDOFF_PATH)).toHaveLength(1);
  });

  test("an expired portal session still dies on the handoff, and the opt-out does not save it", async () => {
    // Same request, same opt-out, but F5 answers with its own expiry shape instead of the viewer.
    const chain = new Chain({ [HANDOFF_PATH]: () => redirect("/my.policy") });
    const { readers, transport } = await connect(chain);
    await expect(readers.getImagingStudy(fixture.STUDY_UID)).rejects.toBeInstanceOf(ReauthenticationRequired);
    await expect(transport.exportSession()).rejects.toBeInstanceOf(ReauthenticationRequired);
    expect(chain.paths()).not.toContain(LOGIN_PATH);
  });

  test("a redirect anywhere else on the login host is still an expiry, not a handoff", async () => {
    const chain = new Chain({ [HANDOFF_PATH]: () => redirect(`${LOGIN_ORIGIN}/login?SAMLRequest=synthetic`) });
    const { readers, transport } = await connect(chain);
    await expect(readers.getImagingStudy(fixture.STUDY_UID)).rejects.toBeInstanceOf(ReauthenticationRequired);
    await expect(transport.exportSession()).rejects.toBeInstanceOf(ReauthenticationRequired);
  });

  test("the handoff needs the member checksum the bootstrap supplies", async () => {
    const chain = new Chain({}, null);
    const { readers } = await connect(chain);
    await expect(readers.getImagingStudy(fixture.STUDY_UID)).rejects.toMatchObject({ code: "TOKEN_UNAVAILABLE", operation: "imaging-study" });
    expect(chain.paths()).not.toContain(HANDOFF_PATH);
  });

  test("a broken hop fails as a missing viewer session rather than a parsing gap", async () => {
    for (const [path, handler] of [
      [LOGIN_PATH, () => page("<html><body>no form here</body></html>")],
      [POLICY_PATH, () => page("<html><body><form method=\"POST\"></form></body></html>")],
      [ROOT_PATH, () => redirect("/?nothing=here")],
    ] as [string, Handler][]) {
      const chain = new Chain({ [path]: handler });
      const { readers } = await connect(chain);
      await expect(readers.getImagingStudy(fixture.STUDY_UID)).rejects.toMatchObject({ code: "TOKEN_UNAVAILABLE" });
    }
  });

  test("the viewer answering with a study we did not ask for is the source contradicting itself", async () => {
    const chain = new Chain({ [HIS_PATH]: () => Response.json({ studyIds: [{ studyUid: "1.2.826.0.1.3680043.8.498.9", storageId: fixture.STORAGE_ID, modality: "CT" }] }) });
    const { readers } = await connect(chain);
    await expect(readers.getImagingStudy(fixture.STUDY_UID)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("owner binding", () => {
  test("a study UID that is not on this owner's own list never reaches the viewer", async () => {
    const chain = new Chain();
    const { readers } = await connect(chain);
    await expect(readers.getImagingStudy("1.2.826.0.1.3680043.8.498.99999")).rejects.toMatchObject({ code: "OWNER_MISMATCH", operation: "imaging-study" });
    // Not one request left the portal: ownership is settled before the chain is allowed to start.
    expect(chain.paths()).not.toContain(HANDOFF_PATH);
    expect(chain.paths().filter(path => path.startsWith(VIEWER_ORIGIN))).toHaveLength(0);
  });

  test("the study UID is the imaging_study row's own request_id, and a lab row's is not accepted", async () => {
    const chain = new Chain();
    const { readers } = await connect(chain);
    const listed = await readers.listImagingStudies();
    expect(listed.data.map(row => row.type)).toEqual(["imaging_study"]);
    await expect(readers.getImagingStudy("fixture-request")).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  });

  test("a series or image outside the study's own structure is refused before any per-image call", async () => {
    const chain = new Chain();
    const { readers } = await connect(chain);
    await expect(readers.getImagingImage(fixture.STUDY_UID, "1.2.826.0.1.3680043.8.498.7", fixture.SOP_UID)).rejects.toMatchObject({ code: "OWNER_MISMATCH", operation: "imaging-image" });
    await expect(readers.getImagingImage(fixture.STUDY_UID, fixture.SERIES_UID, "1.2.826.0.1.3680043.8.498.8")).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    expect(chain.paths()).not.toContain(image("metadata"));
  });
});

describe("what leaves the process", () => {
  test("the study tree loses the patient and keeps the clinical content", async () => {
    const { readers } = await connect(new Chain());
    const safe = safeClinical((await readers.getImagingStudy(fixture.STUDY_UID)).data) as Record<string, unknown>;
    for (const key of ["patientName", "patientID", "patientBirthDate"]) expect(safe).not.toHaveProperty(key);
    // patientSex survives the filter on purpose. The set drops identifiers; sex identifies nobody on
    // its own and imaging is read against it, so removing it would cost signal and buy nothing - the
    // profile reader returns the same fact under `sex` regardless.
    expect(safe.patientSex).toBe("M");
    expect(safe.studyDescription).toBe("US SOFT TISSUE NECK");
    expect(safe.studyDate).toBe("2024-05-14");
    expect(safe.mainModality).toBe("US");
    expect((safe.series as { seriesInstanceUID: string }[])[0]!.seriesInstanceUID).toBe(fixture.SERIES_UID);
  });

  test("per-image metadata loses the accession number, the rendered labels and the raw tag bag", async () => {
    const { readers } = await connect(new Chain());
    const metadata = (await readers.getImagingImage(fixture.STUDY_UID, fixture.SERIES_UID, fixture.SOP_UID)).data;
    // The library itself preserves everything; the omission is the shared filter's job, as everywhere else.
    expect(metadata.accessionNumber).toBe("ACC00000001");
    const safe = safeClinical(metadata) as Record<string, unknown>;
    for (const key of ["accessionNumber", "patientID", "viewPortLabels", "attributes"]) expect(safe).not.toHaveProperty(key);
    // The raw tags hid the patient name and the referring physician under hex keys no filter reads.
    expect(JSON.stringify(safe)).not.toContain("TEST PATIENT");
    expect(JSON.stringify(safe)).not.toContain("DR X");
    expect(JSON.stringify(safe)).not.toContain("TEST CLINIC SITE");
    expect(safe.rows).toBe(970);
    expect(safe.photometricInterpretation).toBe("MONOCHROME2");
  });

  test("the filter hands binary back untouched instead of rewriting it byte by byte", async () => {
    // safeClinical is exported for library callers, and a pixel or PDF read result is a Uint8Array.
    // Walking it as a record turned 2 MiB of document into a two-million-key object and spent close
    // to a second doing it, which is not a filter doing anything - binary carries no named fields.
    const { readers } = await connect(new Chain());
    const pixels = (await readers.getImagingImagePixels(fixture.STUDY_UID, fixture.SERIES_UID, fixture.SOP_UID)).data;
    const safe = safeClinical(pixels) as { pixels: Uint8Array };
    expect(safe.pixels).toBe(pixels.pixels);
    expect(safeClinical(pixels.pixels)).toBe(pixels.pixels);
    // Named fields beside the bytes are still filtered exactly as before.
    expect(safeClinical({ token: "secret", bytes: pixels.pixels, rows: 1 })).toEqual({ bytes: pixels.pixels, rows: 1 });
  });

  test("the handoff URL's member checksum is never returned to a caller", async () => {
    const chain = new Chain();
    const { readers } = await connect(chain);
    const study = await readers.getImagingStudy(fixture.STUDY_UID);
    expect(JSON.stringify(study)).not.toContain(fixture.CHECKSUM_ID);
    expect(JSON.stringify(safeClinical(study))).not.toContain(fixture.HIS_TOKEN);
    // It does go on the wire, once, on the one request that needs it.
    expect(chain.call(HANDOFF_PATH)[0]!.href).toContain(`checksum=${fixture.CHECKSUM_ID}`);
  });
});

describe("the pixel buffer", () => {
  test("arrives with the geometry it cannot be read without, and must satisfy the arithmetic", async () => {
    const { readers } = await connect(new Chain());
    const result = await readers.getImagingImagePixels(fixture.STUDY_UID, fixture.SERIES_UID, fixture.SOP_UID);
    expect(result.data.pixels.byteLength).toBe(970 * 1552);
    expect(result.data.expectedBytes).toBe(970 * 1552);
    expect(result.data.bytesPerFrame).toBe(970 * 1552);
    expect(result.data).toMatchObject({ rows: 970, columns: 1552, samplesPerPixel: 1, bitsAllocated: 8, numberOfFrames: 1, photometricInterpretation: "MONOCHROME2" });
    // The decoded syntax, not the stored JPEG-Lossless one /structure reports for the same instance.
    expect(result.data.transferSyntaxUID).toBe("1.2.840.10008.1.2.1");
    expect(result.data.windowCenter).toEqual([127]);
  });

  test("a buffer of the wrong length fails, because the arithmetic is the only integrity check there is", async () => {
    for (const bytes of [new Uint8Array(970 * 1552 - 1), new Uint8Array(970 * 1552 + 1)]) {
      const chain = new Chain({ [image("pixels")]: () => new Response(bytes, { headers: { "content-type": "application/octet-stream" } }) });
      const { readers } = await connect(chain);
      await expect(readers.getImagingImagePixels(fixture.STUDY_UID, fixture.SERIES_UID, fixture.SOP_UID)).rejects.toMatchObject({ code: "INVALID_RESPONSE", operation: "imaging-pixels" });
    }
  });

  test("16-bit multi-frame is computed from the metadata, not from the one modality we captured", async () => {
    // A shape that only works if bitsAllocated and numberOfFrames both multiply in: 4 x 5 x 1 x 2 x 3.
    const metadata = { ...fixture.imageMetadata(), rows: 4, columns: 5, bitsAllocated: 16, bitsStored: 12, numberOfFrames: 3, transferSyntaxUID: "1.2.840.10008.1.2.1" };
    const routes = (length: number) => ({
      [image("metadata")]: () => Response.json(metadata),
      [image("pixels")]: () => new Response(new Uint8Array(length), { headers: { "content-type": "application/octet-stream" } }),
    });
    const { readers } = await connect(new Chain(routes(120)));
    const result = await readers.getImagingImagePixels(fixture.STUDY_UID, fixture.SERIES_UID, fixture.SOP_UID);
    expect(result.data).toMatchObject({ bytesPerFrame: 40, expectedBytes: 120, numberOfFrames: 3, bitsAllocated: 16, bitsStored: 12 });
    expect(result.data.pixels.byteLength).toBe(120);
    // The 8-bit single-frame answer for the same image would have been 20 bytes. It is rejected.
    const { readers: narrow } = await connect(new Chain(routes(20)));
    await expect(narrow.getImagingImagePixels(fixture.STUDY_UID, fixture.SERIES_UID, fixture.SOP_UID)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test("a pixel container that is not whole bytes, or one that is enormous, is refused rather than guessed at", async () => {
    const cases: Record<string, unknown>[] = [
      { bitsAllocated: 12 },
      { rows: 40000, columns: 40000, bitsAllocated: 16 },
    ];
    for (const override of cases) {
      const chain = new Chain({ [image("metadata")]: () => Response.json({ ...fixture.imageMetadata(), ...override }) });
      const { readers } = await connect(chain);
      await expect(readers.getImagingImagePixels(fixture.STUDY_UID, fixture.SERIES_UID, fixture.SOP_UID)).rejects.toMatchObject({ code: "UNSUPPORTED_FLOW", operation: "imaging-pixels" });
      // Refused from the metadata alone: not one byte of the buffer was requested.
      expect(chain.paths()).not.toContain(image("pixels"));
    }
  });

  test("a numberOfFrames of 0, which is what /structure always reports, never zeroes the arithmetic", async () => {
    const chain = new Chain({ [image("metadata")]: () => Response.json({ ...fixture.imageMetadata(), numberOfFrames: 0 }) });
    const { readers } = await connect(chain);
    await expect(readers.getImagingImagePixels(fixture.STUDY_UID, fixture.SERIES_UID, fixture.SOP_UID)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    // The code alone does not say which check fired: a zeroed expectedBytes would reach the buffer and
    // be refused by the length comparison under the same code. Refused from the metadata means the
    // request was never made - and a zero-length body would otherwise have satisfied the arithmetic.
    expect(chain.paths()).not.toContain(image("pixels"));
  });

  /**
   * Measured live 2026-09-23: a viewer F5 session left over from an earlier run makes the SAML leg
   * answer differently and the token mint come back unsuccessful, so every imaging read after the
   * first failed TOKEN_UNAVAILABLE. The chain drops those cookies before it starts.
   */
  test("a viewer session left in the jar by an earlier run never rides along on the next handoff", async () => {
    const chain = new Chain();
    const transport = new MaccabiTransport({ fetch: chain.fetch });
    transport.importCookies({
      version: "tough-cookie@6.0.2", storeType: "MemoryCookieStore", rejectPublicSuffixes: true,
      cookies: [{
        key: "MEDDREAMSESSID", value: "stale-viewer-session", domain: "meddreamy.maccabi4u.co.il",
        path: "/", secure: true, httpOnly: true, hostOnly: true,
        creation: "2026-09-23T00:00:00.000Z", lastAccessed: "2026-09-23T00:00:00.000Z",
      }],
    });
    transport.markAuthenticated();
    const readers = await MaccabiReaders.create(transport);
    await readers.getImagingStudy(fixture.STUDY_UID);
    const viewerCalls = chain.seen.filter(entry => entry.href.startsWith(VIEWER_ORIGIN));
    expect(viewerCalls.length).toBeGreaterThan(0);
    for (const call of viewerCalls) expect(call.headers.get("cookie") ?? "").not.toContain("stale-viewer-session");
  });
});

describe("the thumbnail", () => {
  test("returns the JPEG bytes the server rendered", async () => {
    const { readers } = await connect(new Chain());
    const result = await readers.getImagingImageThumbnail(fixture.STUDY_UID, fixture.SERIES_UID, fixture.SOP_UID);
    expect([...result.data.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(result.source).toMatchObject({ service: "MedDream", operation: "imaging-thumbnail" });
  });

  test("anything that is not a JPEG fails instead of being written to a file", async () => {
    for (const response of [
      () => new Response("<html>error page</html>", { headers: { "content-type": "text/html" } }),
      () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/jpeg" } }),
    ] as Handler[]) {
      const { readers } = await connect(new Chain({ [image("thumbnail")]: response }));
      await expect(readers.getImagingImageThumbnail(fixture.STUDY_UID, fixture.SERIES_UID, fixture.SOP_UID)).rejects.toMatchObject({ code: "INVALID_RESPONSE", operation: "imaging-thumbnail" });
    }
  });
});

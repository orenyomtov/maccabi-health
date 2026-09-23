/**
 * The one list of keys that must not leave the process, and the filter that drops them.
 *
 * The readers deliberately preserve every source field, including the ones that identify the member,
 * authenticate the session, or point at a private document path. That is right for the library and
 * wrong for anything that prints, logs or ships a result: an MCP client keeps tool output in model
 * context, and the CLI writes it to a terminal, a shell scrape or whatever `--json` is piped into.
 * Both surfaces need the same filter, so it lives here rather than in one of them, where the two
 * copies would drift the moment either side learned about a new field. It is exported from the
 * published entry for the same reason: a library caller who logs or forwards a read result has
 * exactly the same problem, and a third copy would drift too.
 */
const omittedKeys = new Set([
  "memberid", "memberidcode", "patientid", "patientidcode", "membertechnicalid", "loggedcustomerinfo", "currentcustomerinfo", "familydata", "authorizationtoaccount",
  "idtech", "checksumid", "nationalid", "passportnumber", "unifierid", "unifieridcode", "paysid", "paysidcode", "accountnumber",
  "authorization", "apiauthorization", "authentication", "cookie", "cookies", "setcookie", "mrhsession", "lastmrhsession", "token", "accesstoken", "refreshtoken", "idtoken", "apikey", "jwt",
  "session", "sessionid", "samlresponse", "relaystate", "password", "otp", "hash", "coronahash", "coronat",
  "pdflink", "linkpdf", "filelink", "visitsummarypdflink", "referralpdflink", "resultfile", "resultfiles",
  // The imaging viewer's own payloads. Unlike the portal APIs, these name the patient at the top level
  // of an otherwise ordinary listing: /structure carries patientName, patientBirthDate and patientSex
  // beside the series tree, and per-image /metadata adds the accession number, the rendered corner
  // labels that repeat it, and `attributes` - a bag of raw DICOM tags keyed by hex number, holding
  // patient name, birth date, referring physician and institution under keys no name-based filter can
  // recognise. The whole bag goes, because reading it tag by tag would be the field allowlist this
  // file exists to avoid. Nothing else in this client returns a field called `attributes`.
  //
  // patientSex is deliberately KEPT. What this set drops is identifiers - fields whose use is
  // correlating a person across records, and which say nothing about the scan. Sex is the opposite:
  // not identifying on its own, and clinically load-bearing, since imaging interpretation and
  // reference ranges depend on it. It is also already returned by the profile reader under `sex`,
  // so dropping it here would remove signal without removing the information.
  "patientname", "patientbirthdate", "accessionnumber", "viewportlabels", "attributes",
]);

/**
 * Deep copy of a read result with the omitted keys removed at every depth. Clinical prose is left
 * exactly as the source wrote it; this drops fields, it does not de-identify text.
 */
export function safeClinical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeClinical);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!omittedKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) result[key] = safeClinical(item);
  }
  return result;
}

/** Read-only view of the omitted key set, for tests and for surfaces that want to document it. */
export const OMITTED_KEYS: ReadonlySet<string> = omittedKeys;

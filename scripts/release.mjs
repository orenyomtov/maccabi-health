import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const number = '(?:0|[1-9][0-9]*)';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const tagPattern = new RegExp(`^v(${number}\\.${number}\\.${number})(?:-(${identifier}(?:\\.${identifier})*))?$`);

/** Release tags deliberately exclude build metadata, which npm cannot version separately. */
export function releasePlan(event, manifest, registry) {
  if (event.action !== 'published' || event.release?.draft !== false || typeof event.release?.prerelease !== 'boolean') throw new Error('Expected a published GitHub release.');
  const tag = event.release.tag_name;
  const match = typeof tag === 'string' && tag.length <= 128 && tagPattern.exec(tag);
  if (!match || match[1].split('.').some(part => !Number.isSafeInteger(Number(part))) || !!match[2] !== event.release.prerelease) throw new Error('Use vX.Y.Z, or a SemVer prerelease tag with the GitHub prerelease checkbox selected.');
  if (manifest.name !== 'maccabi-health' || manifest.repository?.url !== `git+https://github.com/${event.repository?.full_name}.git`) throw new Error('Package name or repository does not match this release.');
  const version = tag.slice(1);
  if (registry === null) throw new Error('The npm package must exist and have this GitHub workflow configured as its trusted publisher before release publication.');
  if (registry !== undefined) {
    if (!registry || typeof registry.versions !== 'object' || registry.versions === null || Array.isArray(registry.versions)) throw new Error('Invalid public npm package metadata.');
    if (Object.hasOwn(registry.versions, version)) throw new Error('This npm version already exists; publish a new GitHub release with a new version.');
    const latest = registry['dist-tags']?.latest;
    if (!match[2] && latest !== undefined) {
      const old = tagPattern.exec(`v${latest}`);
      if (!old || old[2]) throw new Error('Invalid npm latest version metadata.');
      const currentParts = match[1].split('.').map(BigInt), oldParts = old[1].split('.').map(BigInt);
      const changed = currentParts.findIndex((value, index) => value !== oldParts[index]);
      if (changed === -1 || currentParts[changed] < oldParts[changed]) throw new Error('A stable release must advance the current npm latest version.');
    }
  }
  return { version, distTag: match[2] ? 'next' : 'latest' };
}

export async function prepareRelease(event, directory, fetchImpl = fetch) {
  const manifestPath = new URL('package.json', directory), lockPath = new URL('package-lock.json', directory);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Validate local release inputs before even the anonymous registry request.
  releasePlan(event, manifest, undefined);
  const response = await fetchImpl('https://registry.npmjs.org/maccabi-health', { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (response.status !== 200 && response.status !== 404) throw new Error('Public npm registry lookup failed; no release was prepared.');
  const plan = releasePlan(event, manifest, response.status === 404 ? null : await response.json());
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (lock.name !== manifest.name || lock.packages?.['']?.name !== manifest.name) throw new Error('Root npm lockfile does not match the package.');
  manifest.version = plan.version; lock.version = plan.version; lock.packages[''].version = plan.version;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
  // The MCP registry refuses a server.json whose version disagrees with the npm package it points at,
  // and it carries the version twice. Stamping it here keeps a release from failing at the last step
  // on a file nobody remembers to edit. Absent file is fine: the registry listing is optional.
  const serverPath = new URL('server.json', directory);
  const serverText = await readFile(serverPath, 'utf8').catch(() => null);
  if (serverText !== null) {
    const server = JSON.parse(serverText);
    if (server.packages?.[0]?.identifier !== manifest.name) throw new Error('server.json does not describe this package.');
    server.version = plan.version; server.packages[0].version = plan.version;
    await writeFile(serverPath, JSON.stringify(server, null, 2) + '\n');
  }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.GITHUB_EVENT_PATH || !process.env.GITHUB_OUTPUT) throw new Error('Run release preparation only in the published-release workflow.');
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const plan = await prepareRelease(event, new URL('../', import.meta.url));
  await appendFile(process.env.GITHUB_OUTPUT, `version=${plan.version}\ndist_tag=${plan.distTag}\n`);
}

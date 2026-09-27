import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { releaseVersion } from './changelog.mjs';

function versionsOf(tags) {
  const versions = [];
  for (const tag of tags) {
    try { versions.push(releaseVersion(tag)); } catch { /* a non-release tag is not a version */ }
  }
  return versions;
}

function compareVersions(a, b) {
  const [aCore, aPre = ''] = a.split('-');
  const [bCore, bPre = ''] = b.split('-');
  const aParts = aCore.split('.').map(Number);
  const bParts = bCore.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (aParts[i] !== bParts[i]) return aParts[i] > bParts[i] ? 1 : -1;
  }
  if (aPre === bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;
  const aIds = aPre.split('.'), bIds = bPre.split('.');
  const length = Math.max(aIds.length, bIds.length);
  for (let i = 0; i < length; i++) {
    if (aIds[i] === undefined) return -1;
    if (bIds[i] === undefined) return 1;
    const aNum = /^[0-9]+$/.test(aIds[i]), bNum = /^[0-9]+$/.test(bIds[i]);
    if (aNum && bNum && aIds[i] !== bIds[i]) return Number(aIds[i]) > Number(bIds[i]) ? 1 : -1;
    if (aNum !== bNum) return aNum ? -1 : 1;
    if (aIds[i] !== bIds[i]) return aIds[i] > bIds[i] ? 1 : -1;
  }
  return 0;
}

function maxVersion(tags) {
  const versions = versionsOf(tags);
  if (!versions.length) throw new Error('No published release to draft from.');
  return versions.reduce((best, version) => compareVersions(version, best) > 0 ? version : best);
}

/** Next stable version: the patch after the newest published release, or the stable form of a prerelease. */
export function nextDraftVersion(publishedTags) {
  const versions = versionsOf(publishedTags);
  const max = maxVersion(publishedTags);
  const [major, minor, patch] = max.split('-')[0].split('.').map(Number);
  if (max.includes('-')) {
    const stable = `${major}.${minor}.${patch}`;
    if (!versions.includes(stable)) return stable;
  }
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Keep a draft tag that is still ahead of the newest published release. Otherwise use the next patch.
 * A tag edited up to v0.2.0 survives the next push; a draft already published does not.
 */
export function chooseDraftVersion(publishedTags, existingDraftTag) {
  const next = nextDraftVersion(publishedTags);
  if (!existingDraftTag) return next;
  const existing = releaseVersion(existingDraftTag);
  if (compareVersions(existing, maxVersion(publishedTags)) > 0) return existing;
  return next;
}

export function planDraft(releases) {
  if (!Array.isArray(releases)) throw new Error('Expected a list of releases.');
  const published = [];
  const drafts = [];
  for (const release of releases) {
    if (!release || typeof release.tagName !== 'string' || typeof release.isDraft !== 'boolean') throw new Error('A release is missing tagName or isDraft.');
    (release.isDraft ? drafts : published).push(release.tagName);
  }
  if (drafts.length > 1) throw new Error('More than one draft release is open.');
  for (const tag of drafts) releaseVersion(tag);
  const version = chooseDraftVersion(published, drafts[0]);
  return { tag: `v${version}`, previous: `v${maxVersion(published)}`, edit: drafts[0] ?? '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.RELEASES_FILE || !process.env.GITHUB_OUTPUT) throw new Error('Draft planning runs in GitHub Actions.');
  const plan = planDraft(JSON.parse(await readFile(process.env.RELEASES_FILE, 'utf8')));
  await appendFile(process.env.GITHUB_OUTPUT, `tag=${plan.tag}\nprevious=${plan.previous}\nedit=${plan.edit}\n`);
}

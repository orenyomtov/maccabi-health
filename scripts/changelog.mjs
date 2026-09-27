import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const number = '(?:0|[1-9][0-9]*)';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
/** Same tag shape as scripts/release.mjs. Build metadata is rejected there too. */
const versionPattern = new RegExp(`^(${number}\\.${number}\\.${number})(?:-(${identifier}(?:\\.${identifier})*))?$`);

export function releaseVersion(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  const version = raw.startsWith('v') ? raw.slice(1) : raw;
  const match = version.length <= 127 && versionPattern.exec(version);
  if (!match || match[1].split('.').some(part => !Number.isSafeInteger(Number(part)))) {
    throw new Error('Use a version like 0.1.2, or a prerelease like 0.2.0-beta.1.');
  }
  return version;
}

function isSectionHeading(line) {
  if (line === '## Unreleased') return true;
  if (!line.startsWith('## ')) return false;
  try { releaseVersion(line.slice(3)); return true; } catch { return false; }
}

function parseChangelog(markdown) {
  const text = markdown.replace(/\r\n/g, '\n');
  if (!text.startsWith('# Changelog\n')) throw new Error('CHANGELOG.md must start with "# Changelog".');
  const lines = text.split('\n');
  const preamble = [];
  const parts = [];
  let current = null;
  for (const line of lines) {
    if (isSectionHeading(line)) {
      if (current) parts.push(current);
      current = { heading: line, body: [] };
    } else if (current) current.body.push(line);
    else preamble.push(line);
  }
  if (current) parts.push(current);
  return { preamble, parts };
}

function sectionText(parts, heading) {
  const part = parts.find(item => item.heading === heading);
  return part ? part.body.join('\n').trim() : '';
}

function render(preamble, parts) {
  const chunks = [preamble.join('\n').trimEnd()];
  for (const part of parts) {
    const body = part.body.join('\n').trim();
    chunks.push(body ? `${part.heading}\n\n${body}` : part.heading);
  }
  return `${chunks.join('\n\n')}\n`;
}

/** Body of `## Unreleased`, trimmed. */
export function unreleasedNotes(markdown) {
  return sectionText(parseChangelog(markdown).parts, '## Unreleased');
}

/**
 * Notes the maintainer wrote on the release win. An empty release uses the generated commit list.
 * Leftover Unreleased lines are included once so they are not dropped.
 */
export function resolveReleaseNotes({ unreleased = '', body = '', generated = '' } = {}) {
  const chosen = String(body).replace(/\r\n/g, '\n').trim() || String(generated).replace(/\r\n/g, '\n').trim();
  const present = new Set(chosen.split('\n').map(line => line.trim()).filter(Boolean));
  const extras = String(unreleased).replace(/\r\n/g, '\n').split('\n').filter(line => {
    const trimmed = line.trim();
    return trimmed && !present.has(trimmed);
  });
  const notes = [extras.join('\n').trim(), chosen].filter(Boolean).join('\n\n');
  if (!notes) throw new Error('Published release notes are empty.');
  return notes;
}

/**
 * Insert the published release notes as `## <version>` and clear Unreleased. A later run replaces
 * that version's notes and leaves anything added under Unreleased afterwards.
 */
export function changelogAfterRelease(markdown, version, body) {
  const released = releaseVersion(version);
  const notes = typeof body === 'string' ? body.replace(/\r\n/g, '\n').trim() : '';
  if (!notes) throw new Error('Published release notes are empty.');
  const { preamble, parts } = parseChangelog(markdown);
  const heading = `## ${released}`;
  const hadVersion = parts.some(part => part.heading === heading);
  const kept = parts.filter(part => part.heading !== heading);
  let unreleased = kept.find(part => part.heading === '## Unreleased');
  if (!unreleased) {
    unreleased = { heading: '## Unreleased', body: [] };
    kept.unshift(unreleased);
  }
  if (!hadVersion) unreleased.body = [];
  kept.splice(kept.findIndex(part => part.heading === '## Unreleased') + 1, 0, { heading, body: ['', notes, ''] });
  return render(preamble, kept);
}

function publishedEvent() {
  if (!process.env.GITHUB_EVENT_PATH) throw new Error('This mode runs in GitHub Actions.');
  return readFile(process.env.GITHUB_EVENT_PATH, 'utf8').then(text => {
    const event = JSON.parse(text);
    if (event.action !== 'published' || event.release?.draft !== false) throw new Error('Expected a published GitHub release.');
    releaseVersion(event.release.tag_name);
    return event;
  });
}

async function prepareMain() {
  if (!process.env.RUNNER_TEMP || !process.env.GITHUB_OUTPUT) throw new Error('Prepare mode runs in GitHub Actions.');
  const event = await publishedEvent();
  const body = String(event.release.body ?? '');
  const generated = process.env.GENERATED_NOTES_FILE
    ? await readFile(process.env.GENERATED_NOTES_FILE, 'utf8')
    : '';
  const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const notes = resolveReleaseNotes({ unreleased: unreleasedNotes(changelog), body, generated });
  const notesFile = `${process.env.RUNNER_TEMP}/release-notes.md`;
  await writeFile(notesFile, `${notes}\n`);
  const changed = notes !== body.replace(/\r\n/g, '\n').trim();
  await appendFile(process.env.GITHUB_OUTPUT, `notes_file=${notesFile}\nupdate_release=${changed ? 'true' : 'false'}\n`);
}

async function applyMain() {
  if (!process.env.NOTES_FILE) throw new Error('NOTES_FILE is required.');
  const event = await publishedEvent();
  const notes = await readFile(process.env.NOTES_FILE, 'utf8');
  const path = new URL('../CHANGELOG.md', import.meta.url);
  const next = changelogAfterRelease(await readFile(path, 'utf8'), event.release.tag_name, notes);
  await writeFile(path, next);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.env.CHANGELOG_MODE;
  if (mode === 'prepare') await prepareMain();
  else if (mode === 'apply') await applyMain();
  else throw new Error('Set CHANGELOG_MODE to prepare or apply.');
}

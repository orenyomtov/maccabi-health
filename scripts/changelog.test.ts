import { describe, expect, test } from 'vitest';
// @ts-expect-error Release notes automation is plain Node.js and independently validated here.
import { changelogAfterRelease, releaseVersion, resolveReleaseNotes } from './changelog.mjs';

const changelog = `# Changelog

## Unreleased

- ships
- stays

## 0.1.1

- older
`;

describe('release notes', () => {
  test('keeps notes written on the release, and otherwise uses the generated list', () => {
    expect(releaseVersion('v0.1.2')).toBe('0.1.2');
    expect(() => releaseVersion('1.2')).toThrow(/0\.1\.2/);
    expect(resolveReleaseNotes({ body: 'Wrote this.', generated: '* generated', unreleased: '- stays' })).toBe('- stays\n\nWrote this.');
    expect(resolveReleaseNotes({ body: '', generated: '* generated', unreleased: '' })).toBe('* generated');
    expect(resolveReleaseNotes({ body: '- stays', unreleased: '- stays' })).toBe('- stays');
    expect(() => resolveReleaseNotes({ body: '  ', generated: '', unreleased: '' })).toThrow(/empty/);
  });
});

describe('changelog after a published release', () => {
  test('inserts the notes and clears Unreleased', () => {
    const next = changelogAfterRelease(changelog, '0.1.2', '- ships\n');
    expect(next).toBe(`# Changelog

## Unreleased

## 0.1.2

- ships

## 0.1.1

- older
`);
    const again = changelogAfterRelease(next.replace('## Unreleased\n\n## 0.1.2', '## Unreleased\n\n- later\n\n## 0.1.2'), 'v0.1.2', '- ships\n');
    expect(again).toContain('- later');
    expect(again.match(/^## 0\.1\.2$/gm)).toHaveLength(1);
  });

  test('keeps headings inside the release notes inside that version', () => {
    const notes = '## What\'s Changed\n* login --http by @orenyomtov';
    const next = changelogAfterRelease(changelog, '0.1.2', notes);
    expect(next).toContain(`## 0.1.2\n\n${notes}\n\n## 0.1.1`);
    expect(next).not.toContain('- ships');
    expect(changelogAfterRelease(next, '0.1.2', notes)).toBe(next);
  });

  test('rejects an empty body', () => {
    expect(() => changelogAfterRelease(changelog, '0.1.2', '  \n')).toThrow(/empty/);
  });
});

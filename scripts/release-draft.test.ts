import { describe, expect, test } from 'vitest';
// @ts-expect-error Draft planning is plain Node.js and independently validated here.
import { chooseDraftVersion, nextDraftVersion, planDraft } from './release-draft.mjs';

describe('release draft version', () => {
  test('bumps the newest stable release by a patch', () => {
    expect(nextDraftVersion(['v0.1.0', 'v0.1.1'])).toBe('0.1.2');
    expect(nextDraftVersion(['v0.1.1', 'not-a-release'])).toBe('0.1.2');
    expect(nextDraftVersion(['v0.1.1', 'v0.2.0-beta.1'])).toBe('0.2.0');
    expect(() => nextDraftVersion(['nope'])).toThrow(/published release/);
  });

  test('keeps a draft tag that is still ahead of the published release', () => {
    expect(chooseDraftVersion(['v0.1.1'], 'v0.2.0')).toBe('0.2.0');
    expect(chooseDraftVersion(['v0.1.1'], 'v0.1.2')).toBe('0.1.2');
    expect(chooseDraftVersion(['v0.1.2'], 'v0.1.2')).toBe('0.1.3');
    expect(chooseDraftVersion(['v0.1.1'], undefined)).toBe('0.1.2');
  });

  test('plans one draft from the release list', () => {
    expect(planDraft([
      { tagName: 'v0.1.2', isDraft: true },
      { tagName: 'v0.1.1', isDraft: false },
    ])).toEqual({ tag: 'v0.1.2', previous: 'v0.1.1', edit: 'v0.1.2' });
    expect(planDraft([{ tagName: 'v0.1.1', isDraft: false }]).edit).toBe('');
    expect(() => planDraft([
      { tagName: 'v0.1.3', isDraft: true },
      { tagName: 'v0.1.2', isDraft: true },
      { tagName: 'v0.1.1', isDraft: false },
    ])).toThrow(/More than one draft/);
  });
});

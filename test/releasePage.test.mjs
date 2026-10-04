import { describe, it, expect } from 'vitest';
import { OWNERS, isReleasePage } from '../electron/release-page.cjs';

// v1.17 (Limekana/limecore#33, Limekana/StudyDesk#76). The desktop update
// check trusts a release page only under one of our owners. After the repo
// moves to the org, GitHub's API still answers at the old path but its
// `html_url` names the new owner, and an install that rejected that would
// never see another update.

const REPO = 'Limekana/StudyDesk';
const page = (owner, tag = 'v1.17.0') => `https://github.com/${owner}/StudyDesk/releases/tag/${tag}`;

describe('isReleasePage', () => {
  it('accepts the release page under the current owner', () => {
    expect(isReleasePage(page('Limekana'), REPO)).toBe(true);
  });

  it('accepts the release page under the org, as html_url names it after a transfer', () => {
    expect(isReleasePage(page('Limecore-Studio'), REPO)).toBe(true);
  });

  it('ignores case, as GitHub does', () => {
    expect(isReleasePage(page('limecore-studio').toLowerCase(), REPO)).toBe(true);
    expect(isReleasePage(page('LIMEKANA'), REPO)).toBe(true);
  });

  it('still accepts both once `repo` itself is switched to the org', () => {
    const moved = 'Limecore-Studio/StudyDesk';
    expect(isReleasePage(page('Limecore-Studio'), moved)).toBe(true);
    expect(isReleasePage(page('Limekana'), moved)).toBe(true);
  });

  it('rejects any other owner', () => {
    expect(isReleasePage(page('someone-else'), REPO)).toBe(false);
  });

  it('rejects another repo whose name only starts the same', () => {
    expect(isReleasePage('https://github.com/Limekana/StudyDesk-fork/releases/tag/v9.9.9', REPO)).toBe(false);
  });

  it('rejects a lookalike host', () => {
    expect(isReleasePage('https://github.com.evil.example/Limekana/StudyDesk/releases/tag/v1.17.0', REPO)).toBe(false);
  });

  it('rejects a page outside releases/', () => {
    expect(isReleasePage('https://github.com/Limekana/StudyDesk/issues/76', REPO)).toBe(false);
  });

  it('rejects a missing or non-string html_url', () => {
    expect(isReleasePage(undefined, REPO)).toBe(false);
    expect(isReleasePage(null, REPO)).toBe(false);
    expect(isReleasePage(42, REPO)).toBe(false);
  });

  it('knows both owners', () => {
    expect(OWNERS).toEqual(['Limekana', 'Limecore-Studio']);
  });
});

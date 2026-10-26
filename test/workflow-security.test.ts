/**
 * Static workflow checks — findings 16 and 19.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WF = join(__dirname, '..', '.github', 'workflows');
const files = readdirSync(WF).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

describe('workflow supply chain (finding 16)', () => {
  it.each(files)('%s pins every action to a full commit SHA', (file) => {
    const src = readFileSync(join(WF, file), 'utf8');
    const uses = [...src.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((m) => m[1]);
    for (const ref of uses) {
      if (ref.startsWith('./')) continue;
      expect(ref, `${file}: ${ref}`).toMatch(/^[\w.-]+\/[\w.\/-]+@[0-9a-f]{40}$/);
    }
  });
});

describe('review-gate evidence binding (finding 19)', () => {
  const src = readFileSync(join(WF, 'review-gate.yml'), 'utf8');

  it('binds the publish snapshot to the current base tip (not the possibly stale pr.base.sha)', () => {
    expect(src).toMatch(/\$\{await baseTipSha\(pr\)\}/);
    expect(src).toContain('repos.getBranch');
  });

  it('dates evidence against the base SHA move (activity log) and fails closed', () => {
    expect(src).toContain("GET /repos/{owner}/{repo}/activity");
    // Fail-closed parsing is behaviour-tested below (latestBaseMoveMs).
    expect(src).toMatch(/return times\.length \? Math\.max\(\.\.\.times\) : Number\.POSITIVE_INFINITY;/);
    expect(src).toContain("title: 'Base change time unavailable'");
    expect(src).toMatch(/timelineFacts\(prNumber, pr\)/);
  });

  it('re-evaluates on pushes to the protected default branch only', () => {
    expect(src).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(src).not.toMatch(/^\s+pull_request:\s*$/m);
  });
});

describe('review-gate accepts a clean Codex pass by full SHA and completion time (review follow-up, Codex round 10)', () => {
  const src = readFileSync(join(WF, 'review-gate.yml'), 'utf8');
  const fn = /\/\/ BEGIN codexCleanSummaryPasses\n([\s\S]*?)\/\/ END codexCleanSummaryPasses/.exec(src)?.[1];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const codexCleanSummaryPasses = new Function(`${fn}\nreturn codexCleanSummaryPasses;`)() as
    (body: string) => Array<{ sha: string; completedMs: number }>;
  const HEAD = 'a7449a0e75824251473dad7d17cb4048a7e8c07f';
  const DONE = '2026-10-26T05:52:57.138268Z';
  // Layout verbatim from the Codex summary comment on #98 (comment 6407103723).
  const summary = (state: object | string, status = `✅ **Completed** <relative-time datetime="${DONE}">${DONE}</relative-time>`, commit = '`a7449a0`') => [
    '<!-- codex-pull-request-review-summary -->',
    `<!-- codex-review-state:v1 ${typeof state === 'string' ? state : JSON.stringify(state)} -->`,
    '',
    '## Codex Review Summary',
    '',
    '| Review | Status | Commit | Review trigger |',
    '| --- | --- | --- | --- |',
    `| 📝 **Code Review** | ${status} | ${commit} | Manual request |`,
  ].join('\n');
  const clean = { code_review: { commit_sha: HEAD, has_any_findings: false, has_unresolved_findings: false, status: 'completed' } };
  const pass = [{ sha: HEAD, completedMs: Date.parse(DONE) }];

  it('is defined in the evaluate script and dates the clean pass by its completion time', () => {
    expect(fn).toBeTruthy();
    expect(src).toMatch(/codexCleanSummaryPasses\(c\.body \|\| ''\)\.some\(p =>\s*sameSha\(p\.sha, headSha\) && p\.completedMs > baseChangedMs\)/);
    expect(src).not.toMatch(/codexCleanSummaryShas/);
  });

  it('reads the full SHA from the state line and the completion time from the Code Review row', () => {
    expect(codexCleanSummaryPasses(summary(clean))).toEqual(pass);
  });

  it('decodes HTML-escaped braces in the state line', () => {
    const escaped = JSON.stringify(clean).replace(/{/g, '&#123;').replace(/}/g, '&#125;');
    expect(codexCleanSummaryPasses(summary(escaped))).toEqual(pass);
  });

  it.each([
    ['still running', { code_review: { ...clean.code_review, status: 'running', has_any_findings: null } }],
    ['with findings', { code_review: { ...clean.code_review, has_any_findings: true, has_unresolved_findings: true } }],
    ['with unresolved findings', { code_review: { ...clean.code_review, has_unresolved_findings: true } }],
    ['for a short SHA', { code_review: { ...clean.code_review, commit_sha: 'a7449a0' } }],
  ])('gives no evidence for a review %s', (_case, state) => {
    expect(codexCleanSummaryPasses(summary(state))).toEqual([]);
  });

  it('gives no evidence without a machine-readable completion time', () => {
    // The comment's updated_at moves on any later edit, so it never dates the review.
    expect(codexCleanSummaryPasses(summary(clean, '✅ **Completed**'))).toEqual([]);
    expect(codexCleanSummaryPasses(summary(clean, '✅ **Completed** <relative-time datetime="soon">x</relative-time>'))).toEqual([]);
    expect(codexCleanSummaryPasses(summary(clean, `🔄 **Running** since <relative-time datetime="${DONE}">x</relative-time>`))).toEqual([]);
  });

  it('requires the row to describe the same commit as the state line', () => {
    expect(codexCleanSummaryPasses(summary(clean, undefined, '`f41e8a2`'))).toEqual([]);
    expect(codexCleanSummaryPasses(summary(clean, undefined, '`a74`'))).toEqual([]);
  });

  it('ignores malformed state and comments without the summary marker', () => {
    expect(codexCleanSummaryPasses(summary('{not json'))).toEqual([]);
    expect(codexCleanSummaryPasses(summary(clean).replace('<!-- codex-pull-request-review-summary -->', ''))).toEqual([]);
  });

  it('no longer accepts a legacy table row, which carries no completion evidence of its own', () => {
    expect(codexCleanSummaryPasses(summary('{}', undefined, `\`${HEAD}\``))).toEqual([]);
  });
});

describe('review-gate reads base-move time from the real activity payload (Codex round 3)', () => {
  const src = readFileSync(join(WF, 'review-gate.yml'), 'utf8');
  const fn = /\/\/ BEGIN latestBaseMoveMs\n([\s\S]*?)\/\/ END latestBaseMoveMs/.exec(src)?.[1];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const latestBaseMoveMs = new Function(`${fn}\nreturn latestBaseMoveMs;`)() as (a: unknown, sha: string) => number;
  // Verbatim fields from GET /repos/up2itnow0822/agent-wallet-sdk/activity?ref=refs/heads/main (2026-10-26).
  const REAL = [
    { activity_type: 'pr_merge', after: '8a8b3a4a62b384d618b58a894fdec0640480ad50', before: 'ccc1418da46e92a0d5f33573f75fa61623b96390', id: 47583923740, ref: 'refs/heads/main', timestamp: '2026-10-24T00:51:11Z' },
    { activity_type: 'pr_merge', after: 'ccc1418da46e92a0d5f33573f75fa61623b96390', before: 'fb8f3a6c9e09c5e2beeb108dc790df9bb7593933', id: 47582748220, ref: 'refs/heads/main', timestamp: '2026-10-24T00:31:51Z' },
  ];

  it('is used by baseShaSinceMs', () => {
    expect(fn).toBeTruthy();
    expect(src).toMatch(/return latestBaseMoveMs\(data, baseSha\);/);
  });

  it('returns the documented `timestamp` of the move to the current base tip', () => {
    expect(latestBaseMoveMs(REAL, '8a8b3a4a62b384d618b58a894fdec0640480ad50')).toBe(Date.parse('2026-10-24T00:51:11Z'));
    expect(latestBaseMoveMs(REAL, 'CCC1418DA46E92A0D5F33573F75FA61623B96390')).toBe(Date.parse('2026-10-24T00:31:51Z'));
  });

  it('fails closed (Infinity) for an unknown tip, short SHA, missing time or bad payload', () => {
    expect(latestBaseMoveMs(REAL, 'f'.repeat(40))).toBe(Infinity);
    expect(latestBaseMoveMs(REAL, '8a8b3a4')).toBe(Infinity);
    expect(latestBaseMoveMs([{ ...REAL[0], timestamp: undefined }], REAL[0].after)).toBe(Infinity);
    expect(latestBaseMoveMs({ message: 'Not Found' }, REAL[0].after)).toBe(Infinity);
  });
});

describe('review-gate binds a retained waiver check to its PR/base snapshot (Codex round 9)', () => {
  const src = readFileSync(join(WF, 'review-gate.yml'), 'utf8');
  const fn = /\/\/ BEGIN waiverBinding\n([\s\S]*?)\/\/ END waiverBinding/.exec(src)?.[1];
  type Binding = { prNumber: number; headSha: string; baseRef: string; baseSha: string; labelEventId: number };
  type Want = Binding & { baseChangedMs: number; labelEventMs: number };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const { waiverMarker, waiverCheckQualifies } = new Function(`${fn}\nreturn { waiverMarker, waiverCheckQualifies };`)() as {
    waiverMarker: (b: Binding) => string;
    waiverCheckQualifies: (run: unknown, want: Want) => boolean;
  };

  // Field names from real payloads: GET .../commits/{sha}/check-runs (review-gate on edd1f50)
  // and the PR #92 timeline `labeled` event for codex-waived (id 33531149763).
  const binding: Binding = {
    prNumber: 92,
    headSha: '2ca206c77fd55d9b8ccf560377806acead0f9cc6',
    baseRef: 'main',
    baseSha: '8a8b3a4a62b384d618b58a894fdec0640480ad50',
    labelEventId: 33531149763,
  };
  const want: Want = {
    ...binding,
    baseChangedMs: Date.parse('2026-10-17T17:00:00Z'),
    labelEventMs: Date.parse('2026-10-17T17:08:57Z'),
  };
  const run = (over: Record<string, unknown> = {}, summary = `Label applied. ${waiverMarker(binding)}`) => ({
    app: { slug: 'github-actions' },
    status: 'completed',
    conclusion: 'success',
    completed_at: '2026-10-17T17:09:30Z',
    output: { title: 'Codex waived', summary },
    ...over,
  });

  it('is wired into headHasWaiverCheck and every waiver verdict', () => {
    expect(fn).toBeTruthy();
    expect(src).toMatch(/runs\.some\(r => waiverCheckQualifies\(r, want\)\)/);
    expect(src.match(/title: 'Codex waived',\n\s+summary: [^\n]*\n(?:[^\n]*\n){0,3}?[^\n]*waiverMarker\(/g)).toHaveLength(2);
  });

  it('accepts the check published for the current label event, PR, head and base', () => {
    expect(waiverCheckQualifies(run(), want)).toBe(true);
  });

  it('rejects a check that completed before the latest base move', () => {
    // The Codex scenario: the pre-base check survives on the unchanged head;
    // the label is re-applied after the base move but its check never lands.
    const moved = { ...want, baseChangedMs: Date.parse('2026-10-17T18:00:00Z'), labelEventMs: Date.parse('2026-10-17T18:05:00Z') };
    expect(waiverCheckQualifies(run(), moved)).toBe(false);
    expect(waiverCheckQualifies(run({ completed_at: '2026-10-17T17:00:00Z' }), want)).toBe(false);
  });

  it('rejects a check that predates the current label event', () => {
    expect(waiverCheckQualifies(run({ completed_at: '2026-10-17T17:08:00Z' }), want)).toBe(false);
  });

  it.each([
    ['an earlier label event', { labelEventId: 33531149000 }],
    ['another PR', { prNumber: 93 }],
    ['another head', { headSha: 'f'.repeat(40) }],
    ['another base ref', { baseRef: 'release' }],
    ['another base tip', { baseSha: 'c'.repeat(40) }],
  ])('rejects a marker for %s', (_label, change) => {
    expect(waiverCheckQualifies(run({}, `ok ${waiverMarker({ ...binding, ...change })}`), want)).toBe(false);
  });

  it('rejects legacy, foreign, failed or malformed checks', () => {
    expect(waiverCheckQualifies(run({}, 'Waiver previously recorded for head.'), want)).toBe(false);
    expect(waiverCheckQualifies(run({ app: { slug: 'some-app' } }), want)).toBe(false);
    expect(waiverCheckQualifies(run({ conclusion: 'failure' }), want)).toBe(false);
    expect(waiverCheckQualifies(run({ output: { title: 'Codex clean', summary: waiverMarker(binding) } }), want)).toBe(false);
    expect(waiverCheckQualifies(run({ completed_at: null }), want)).toBe(false);
    expect(waiverCheckQualifies(run({}, '<!-- review-gate-waiver:v1 {not json} -->'), want)).toBe(false);
    expect(waiverCheckQualifies(run(), { ...want, labelEventId: Number.NaN })).toBe(false);
    expect(waiverCheckQualifies(null, want)).toBe(false);
  });

  it('cannot be ended early by a base ref containing comment syntax', () => {
    const odd = { ...binding, baseRef: 'x-->"}<!--y' };
    const marker = waiverMarker(odd);
    expect(marker).not.toMatch(/-->[\s\S]*-->/);
    expect(waiverCheckQualifies(run({}, `ok ${marker}`), { ...want, baseRef: odd.baseRef })).toBe(true);
    expect(waiverCheckQualifies(run({}, `ok ${marker}`), want)).toBe(false);
  });
});

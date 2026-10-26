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
    expect(src).toMatch(/hit === undefined \? Number\.POSITIVE_INFINITY : hit/);
    expect(src).toContain("title: 'Base change time unavailable'");
    expect(src).toMatch(/timelineFacts\(prNumber, pr\)/);
  });

  it('re-evaluates on pushes to the protected default branch only', () => {
    expect(src).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(src).not.toMatch(/^\s+pull_request:\s*$/m);
  });
});

describe('review-gate accepts a clean Codex pass by full SHA (review follow-up)', () => {
  const src = readFileSync(join(WF, 'review-gate.yml'), 'utf8');
  const fn = /\/\/ BEGIN codexCleanSummaryShas\n([\s\S]*?)\/\/ END codexCleanSummaryShas/.exec(src)?.[1];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const codexCleanSummaryShas = new Function(`${fn}\nreturn codexCleanSummaryShas;`)() as (body: string) => string[];
  const HEAD = 'f41e8a2557774cb6acda18c3d3df762468c34973';
  const summary = (state: object | string, row = '`f41e8a2`') => [
    '<!-- codex-pull-request-review-summary -->',
    `<!-- codex-review-state:v1 ${typeof state === 'string' ? state : JSON.stringify(state)} -->`,
    '',
    '| Review | Status | Commit | Review trigger |',
    '| --- | --- | --- | --- |',
    `| 📝 **Code Review** | ✅ **Completed** <relative-time>t</relative-time> | ${row} | Manual request |`,
  ].join('\n');
  const clean = { code_review: { commit_sha: HEAD, has_any_findings: false, has_unresolved_findings: false, status: 'completed' } };

  it('is defined in the evaluate script and used for the clean-pass fallback', () => {
    expect(fn).toBeTruthy();
    expect(src).toMatch(/codexCleanSummaryShas\(c\.body \|\| ''\)\.some\(sha => sameSha\(sha, headSha\)\)/);
  });

  it('reads the full SHA from the Codex state line (the table only shows a short SHA)', () => {
    expect(codexCleanSummaryShas(summary(clean))).toEqual([HEAD]);
  });

  it('decodes HTML-escaped braces in the state line', () => {
    const escaped = JSON.stringify(clean).replace(/{/g, '&#123;').replace(/}/g, '&#125;');
    expect(codexCleanSummaryShas(summary(escaped))).toEqual([HEAD]);
  });

  it.each([
    ['still running', { code_review: { ...clean.code_review, status: 'running', has_any_findings: null } }],
    ['with findings', { code_review: { ...clean.code_review, has_any_findings: true, has_unresolved_findings: true } }],
    ['with unresolved findings', { code_review: { ...clean.code_review, has_unresolved_findings: true } }],
    ['for a short SHA', { code_review: { ...clean.code_review, commit_sha: 'f41e8a2' } }],
  ])('gives no evidence for a review %s', (_case, state) => {
    expect(codexCleanSummaryShas(summary(state))).toEqual([]);
  });

  it('ignores malformed state and comments without the summary marker', () => {
    expect(codexCleanSummaryShas(summary('{not json'))).toEqual([]);
    expect(codexCleanSummaryShas(summary(clean).replace('<!-- codex-pull-request-review-summary -->', ''))).toEqual([]);
  });

  it('still accepts a legacy table row with the full SHA', () => {
    expect(codexCleanSummaryShas(summary('{}', `\`${HEAD}\``))).toEqual([HEAD]);
  });
});

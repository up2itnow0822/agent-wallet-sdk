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

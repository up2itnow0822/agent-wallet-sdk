/**
 * Static workflow checks — finding 16 (pinned actions) and finding 19
 * (resolved by removing the review-gate workflow).
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

describe('no merge gate waits on a second Codex review (finding 19, resolved by removal)', () => {
  // Codex reviews every PR automatically. The review-gate workflow, whose
  // evidence binding was finding 19, was removed at the maintainer's direction.
  it('ships no review-gate workflow', () => {
    expect(files).not.toContain('review-gate.yml');
  });

  it.each(files)('%s does not gate on Codex review evidence', (file) => {
    const src = readFileSync(join(WF, file), 'utf8');
    expect(src).not.toMatch(/chatgpt-codex-connector|codex-review-state|codex-waived/);
  });
});

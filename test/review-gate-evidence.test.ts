/**
 * Executable spec for Codex-on-head evidence matching.
 * Fixtures are the real chatgpt-codex-connector comments from PR #87.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPLETED_ROW,
  MENTIONED_SHA,
  NO_MAJOR_ISSUES,
  SUMMARY_MARKER,
  commentAcceptsCleanHead,
  fullSha,
  isCleanNoMajorIssuesBody,
  isRetryableGithubStatus,
  mentionedShas,
  mentionsNonHeadSha,
  retryDelayMs,
  shaPrefixMatches,
  summaryMarksHeadCompleted,
  withRetry,
} from '../scripts/review-gate-evidence.js';

const HEAD = '982551f44942104308231bb10d5b56513c9c7050';
const OLDER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// Real Codex summary posted on PR #87 (short 7-char SHA in the table).
const PR87_SUMMARY = `<!-- codex-pull-request-review-summary -->
<!-- codex-review-state:v1 {"code_review":{"commit_sha":"982551f44942104308231bb10d5b56513c9c7050","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->

## Codex Review Summary

This comment shows the latest Codex review activity on this pull request.

| Review | Status | Commit | Review trigger |
| --- | --- | --- | --- |
| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-10-15T21:22:46.906149Z">2026-10-15T21:22:46.906149Z</relative-time> | \`982551f\` | Manual request |
`;

// Real Codex receipt posted on PR #87 (10-char SHA prefix, no formal review).
const PR87_RECEIPT = `<!-- codex-review-receipt:v1 -->

Codex Review: Didn't find any major issues. More of your lovely PRs please.

**Reviewed commit:** \`982551f449\`
`;

const BASE_CHANGED = 0;

function accept(body: string, extra: Record<string, unknown> = {}) {
  return commentAcceptsCleanHead(
    {
      body,
      created_at: '2026-10-15T21:22:45Z',
      updated_at: '2026-10-15T21:22:47Z',
      ...extra,
    },
    { headSha: HEAD, baseChangedMs: BASE_CHANGED },
  );
}

describe('shaPrefixMatches', () => {
  it('accepts a 7-char prefix of the 40-char head', () => {
    expect(shaPrefixMatches('982551f', HEAD)).toBe(true);
    expect(shaPrefixMatches('982551F', HEAD)).toBe(true);
  });

  it('accepts a 10-char prefix and the full SHA', () => {
    expect(shaPrefixMatches('982551f449', HEAD)).toBe(true);
    expect(shaPrefixMatches(HEAD, HEAD)).toBe(true);
  });

  it('rejects a 6-char stub, an older SHA, and a non-prefix', () => {
    expect(shaPrefixMatches('982551', HEAD)).toBe(false);
    expect(shaPrefixMatches('aaaaaaa', HEAD)).toBe(false);
    expect(shaPrefixMatches(OLDER, HEAD)).toBe(false);
    expect(shaPrefixMatches('982551f44942104308231bb10d5b56513c9c7051', HEAD)).toBe(false);
  });

  it('rejects empty or malformed input', () => {
    expect(shaPrefixMatches('', HEAD)).toBe(false);
    expect(fullSha('982551f')).toBe('');
    expect(shaPrefixMatches('982551f', '982551f')).toBe(false);
  });
});

describe('mentioned SHAs', () => {
  it('extracts backtick and commit_sha tokens from the PR #87 comments', () => {
    expect(mentionedShas(PR87_SUMMARY)).toEqual([
      HEAD,
      '982551f',
    ]);
    expect(mentionedShas(PR87_RECEIPT)).toEqual(['982551f449']);
  });

  it('flags a comment that names an older SHA', () => {
    expect(mentionsNonHeadSha(PR87_SUMMARY, HEAD)).toBe(false);
    expect(mentionsNonHeadSha(PR87_RECEIPT, HEAD)).toBe(false);
    expect(mentionsNonHeadSha(`Reviewed commit: \`${OLDER.slice(0, 7)}\``, HEAD)).toBe(true);
    expect(mentionsNonHeadSha(`clean \`${HEAD.slice(0, 7)}\` and old \`${OLDER.slice(0, 8)}\``, HEAD)).toBe(true);
  });
});

describe('PR #87 Codex summary (the rejected case)', () => {
  it('marks the head Completed on the 7-char table SHA', () => {
    expect(summaryMarksHeadCompleted(PR87_SUMMARY, HEAD)).toBe(true);
    expect(accept(PR87_SUMMARY)).toBe(true);
  });

  it('rejects that same summary when the head has moved', () => {
    expect(summaryMarksHeadCompleted(PR87_SUMMARY, OLDER)).toBe(false);
    expect(commentAcceptsCleanHead(
      { body: PR87_SUMMARY, created_at: '2026-10-15T21:22:45Z', updated_at: '2026-10-15T21:22:47Z' },
      { headSha: OLDER, baseChangedMs: BASE_CHANGED },
    )).toBe(false);
  });

  it('rejects a Completed row that still cites an older SHA', () => {
    const stale = PR87_SUMMARY
      .replace(/982551f44942104308231bb10d5b56513c9c7050/g, OLDER)
      .replace(/`982551f`/g, '`aaaaaaa`');
    expect(summaryMarksHeadCompleted(stale, HEAD)).toBe(false);
    expect(accept(stale)).toBe(false);
  });
});

describe('PR #87 clean no-major-issues receipt', () => {
  it('accepts the receipt because it names a head-SHA prefix', () => {
    expect(isCleanNoMajorIssuesBody(PR87_RECEIPT)).toBe(true);
    expect(accept(PR87_RECEIPT)).toBe(true);
  });

  it('rejects a SHA-less no-major-issues comment even after the head exists', () => {
    const body = "Codex Review: Didn't find any major issues.";
    expect(accept(body, { created_at: '2026-10-15T21:22:45Z' })).toBe(false);
    expect(accept(body, { created_at: '2026-10-15T19:00:00Z', updated_at: '2026-10-15T19:00:00Z' })).toBe(false);
  });

  it('accepts a no-major-issues comment that names the head prefix', () => {
    expect(accept(PR87_RECEIPT, {
      created_at: '2026-10-15T19:00:00Z',
      updated_at: '2026-10-15T19:00:00Z',
    })).toBe(true);
  });

  it('rejects a no-major-issues comment that names an older SHA', () => {
    const body = "Didn't find any major issues.\n**Reviewed commit:** `aaaaaaa`";
    expect(accept(body)).toBe(false);
  });

  it('rejects a receipt that names both the head prefix and a different SHA', () => {
    const body = `${PR87_RECEIPT}\nAlso saw \`${OLDER.slice(0, 7)}\`.`;
    expect(accept(body)).toBe(false);
  });
});

describe('strict leftovers', () => {
  it('does not treat a non-Codex-shaped comment as a clean pass', () => {
    expect(accept('Looks good to me')).toBe(false);
    expect(accept('Code Review still running')).toBe(false);
  });

  it('rejects evidence posted at or before the last base change', () => {
    expect(commentAcceptsCleanHead(
      { body: PR87_SUMMARY, created_at: '2026-10-15T21:22:45Z', updated_at: '2026-10-15T21:22:47Z' },
      { headSha: HEAD, baseChangedMs: Date.parse('2026-10-15T22:00:00Z') },
    )).toBe(false);
  });

  it('never treats a prefix as some other commit — only the current head counts', () => {
    const other = `982551f${'b'.repeat(33)}`;
    expect(shaPrefixMatches('982551f', HEAD)).toBe(true);
    expect(shaPrefixMatches('982551f', other)).toBe(true);
    expect(accept(PR87_RECEIPT)).toBe(true);
    expect(commentAcceptsCleanHead(
      { body: PR87_RECEIPT, created_at: '2026-10-15T21:22:45Z', updated_at: '2026-10-15T21:22:47Z' },
      { headSha: other, baseChangedMs: BASE_CHANGED },
    )).toBe(false);
  });
});

describe('GitHub API 5xx retry', () => {
  it('retries 5xx and not 4xx', () => {
    expect(isRetryableGithubStatus(500)).toBe(true);
    expect(isRetryableGithubStatus(502)).toBe(true);
    expect(isRetryableGithubStatus(503)).toBe(true);
    expect(isRetryableGithubStatus(404)).toBe(false);
    expect(isRetryableGithubStatus(422)).toBe(false);
    expect(retryDelayMs(0)).toBe(1000);
    expect(retryDelayMs(1)).toBe(2000);
    expect(retryDelayMs(2)).toBe(4000);
  });

  it('succeeds after two 500s, and does not retry a 422', async () => {
    let hits = 0;
    const result = await withRetry(async () => {
      hits += 1;
      if (hits < 3) {
        const err = new Error('GitHub 500');
        (err as Error & { status: number }).status = 500;
        throw err;
      }
      return 'ok';
    }, { sleep: async () => undefined });
    expect(result).toBe('ok');
    expect(hits).toBe(3);

    let fourHits = 0;
    await expect(withRetry(async () => {
      fourHits += 1;
      const err = new Error('GitHub 422');
      (err as Error & { status: number }).status = 422;
      throw err;
    }, { sleep: async () => undefined })).rejects.toThrow('GitHub 422');
    expect(fourHits).toBe(1);
  });
});

describe('workflow stays in sync with this spec', () => {
  const yaml = readFileSync(resolve(process.cwd(), '.github/workflows/review-gate.yml'), 'utf8');

  it('inlines the same Completed-row, mention, and no-major-issues matchers', () => {
    expect(yaml).toContain(SUMMARY_MARKER);
    expect(yaml).toContain('{7,40}');
    expect(yaml).toContain(COMPLETED_ROW.source);
    expect(yaml).toContain(MENTIONED_SHA.source);
    expect(yaml).toContain(NO_MAJOR_ISSUES.source);
    expect(yaml).toContain('shaPrefixMatches');
    expect(yaml).toContain('commentAcceptsCleanHead');
    expect(yaml).toContain('isCleanNoMajorIssuesBody');
    expect(yaml).not.toContain('headPushedMs');
    expect(yaml).not.toContain('postedAfterHead');
  });

  it('retries checks.create on GitHub 5xx', () => {
    expect(yaml).toContain('status >= 500');
    expect(yaml).toContain('status <= 599');
    expect(yaml).toContain('retrying in');
  });
});

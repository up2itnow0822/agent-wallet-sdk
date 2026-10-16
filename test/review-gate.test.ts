/**
 * Executable spec for review-gate evaluation and refresh.
 *
 * Fixtures include the real chatgpt-codex-connector comments from PR #87.
 * Verdicts are computed from those objects — no GitHub client mock.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHECK_JOB_NAME,
  CI_WORKFLOW_FILE,
  COMPLETED_ROW,
  MAX_RUN_ATTEMPTS,
  MENTIONED_SHA,
  NO_MAJOR_ISSUES,
  SCHEDULE_INTERVAL_MS,
  SUMMARY_MARKER,
  WAIVE_LABEL,
  WAIVER_MARKER,
  commentAcceptsCleanHead,
  combineHeadVerdicts,
  evaluatePr,
  formatWaiverComment,
  fullSha,
  headPushedMsFromEvidence,
  isCleanNoMajorIssuesBody,
  isCodexUser,
  isGithubActionsBot,
  isRetryableGithubStatus,
  isWaiverBoundToCurrentHead,
  mentionedShas,
  mentionsNonHeadSha,
  parseWaiverRecord,
  prefixUniquelyMatchesHead,
  retryDelayMs,
  rerunPlan,
  runAttemptCount,
  runMatchesPr,
  scheduleBackoffMs,
  selectCiRun,
  selectReviewGateJob,
  shaPrefixMatches,
  shouldPostWaiverRecord,
  shouldRerunOnSchedule,
  summaryMarksHeadCompleted,
  waiverRecordAcceptsHead,
  withRetry,
} from '../scripts/review-gate.mjs';

const HEAD = '982551f44942104308231bb10d5b56513c9c7050';
const OLDER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BILL = 'up2itnow0822';
const HEAD_PUSHED_MS = Date.parse('2026-10-15T21:20:00Z');
const uniqueToHead = (shown: string) => shaPrefixMatches(shown, HEAD);

const PR87_SUMMARY = `<!-- codex-pull-request-review-summary -->
<!-- codex-review-state:v1 {"code_review":{"commit_sha":"982551f44942104308231bb10d5b56513c9c7050","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->

## Codex Review Summary

This comment shows the latest Codex review activity on this pull request.

| Review | Status | Commit | Review trigger |
| --- | --- | --- | --- |
| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-10-15T21:22:46.906149Z">2026-10-15T21:22:46.906149Z</relative-time> | \`982551f\` | Manual request |
`;

const PR87_RECEIPT = `<!-- codex-review-receipt:v1 -->

Codex Review: Didn't find any major issues. More of your lovely PRs please.

**Reviewed commit:** \`982551f449\`
`;

const CODEX_BOT = { login: 'chatgpt-codex-connector[bot]', type: 'Bot' };
const GHA_BOT = { login: 'github-actions[bot]', type: 'Bot' };
const BASE_CHANGED = 0;

function accept(
  body: string,
  extra: Record<string, unknown> = {},
  ctxExtra: Record<string, unknown> = {},
) {
  return commentAcceptsCleanHead(
    {
      body,
      created_at: '2026-10-15T21:22:45Z',
      updated_at: '2026-10-15T21:22:47Z',
      ...extra,
    },
    {
      headSha: HEAD,
      baseChangedMs: BASE_CHANGED,
      headPushedMs: HEAD_PUSHED_MS,
      uniqueResolve: uniqueToHead,
      ...ctxExtra,
    },
  );
}

function pr(over: Record<string, unknown> = {}) {
  return {
    number: 87,
    draft: false,
    head: { sha: HEAD },
    base: { ref: 'main' },
    labels: [],
    ...over,
  };
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    pr: pr(),
    reviews: [],
    comments: [],
    timeline: [],
    headPushedMs: HEAD_PUSHED_MS,
    uniqueResolve: uniqueToHead,
    ...over,
  };
}

function waiverComment(sha = HEAD, actor = BILL, number = 87) {
  return {
    user: GHA_BOT,
    body: formatWaiverComment({ sha, actor, pr: number }),
    created_at: '2026-10-15T22:00:01Z',
  };
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

describe('prefix uniqueness (short-SHA spoofing)', () => {
  it('treats a 40-char exact match as unique without an API callback', () => {
    expect(prefixUniquelyMatchesHead(HEAD, HEAD, undefined)).toBe(true);
    expect(prefixUniquelyMatchesHead(OLDER, HEAD, undefined)).toBe(false);
  });

  it('rejects a short prefix unless GitHub uniquely resolves it to this head', () => {
    expect(prefixUniquelyMatchesHead('982551f', HEAD, undefined)).toBe(false);
    expect(prefixUniquelyMatchesHead('982551f', HEAD, () => false)).toBe(false);
    expect(prefixUniquelyMatchesHead('982551f', HEAD, uniqueToHead)).toBe(true);
  });

  it('still rejects a unique-looking prefix that is not this head', () => {
    expect(prefixUniquelyMatchesHead('aaaaaaa', HEAD, () => true)).toBe(false);
  });
});

describe('head push time is GitHub event time, not committer date', () => {
  it('takes the earliest pull_request workflow-run or check-suite created_at', () => {
    expect(headPushedMsFromEvidence({
      workflowRuns: [
        { created_at: '2026-10-15T21:20:00Z' },
        { created_at: '2026-10-15T21:25:00Z' },
      ],
      checkSuites: [{ created_at: '2026-10-15T21:19:30Z' }],
    })).toBe(Date.parse('2026-10-15T21:19:30Z'));
  });

  it('returns undefined when only an author-controlled commit date is offered', () => {
    expect(headPushedMsFromEvidence({
      workflowRuns: [],
      checkSuites: [],
    })).toBeUndefined();
    expect(headPushedMsFromEvidence({
      workflowRuns: [{ committer_date: '2020-01-01T00:00:00Z' }],
    })).toBeUndefined();
  });
});

describe('mentioned SHAs', () => {
  it('extracts backtick and commit_sha tokens from the PR #87 comments', () => {
    expect(mentionedShas(PR87_SUMMARY)).toEqual([HEAD, '982551f']);
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
      {
        headSha: OLDER,
        baseChangedMs: BASE_CHANGED,
        headPushedMs: HEAD_PUSHED_MS,
        uniqueResolve: (shown: string) => shaPrefixMatches(shown, OLDER),
      },
    )).toBe(false);
  });

  it('rejects a Completed row that still cites an older SHA', () => {
    const stale = PR87_SUMMARY
      .replace(/982551f44942104308231bb10d5b56513c9c7050/g, OLDER)
      .replace(/`982551f`/g, '`aaaaaaa`');
    expect(summaryMarksHeadCompleted(stale, HEAD)).toBe(false);
    expect(accept(stale)).toBe(false);
  });

  it('rejects a unique prefix comment posted before this head was pushed', () => {
    expect(accept(PR87_SUMMARY, {
      created_at: '2026-10-15T21:10:00Z',
      updated_at: '2026-10-15T21:10:00Z',
    })).toBe(false);
  });

  it('rejects a prefix that matches the head but is not unique on GitHub', () => {
    expect(accept(PR87_RECEIPT, {}, { uniqueResolve: () => false })).toBe(false);
    expect(accept(PR87_SUMMARY, {}, { uniqueResolve: () => false })).toBe(true);
  });

  it('fails closed when push/event time is missing (no committer-date fallback)', () => {
    expect(accept(PR87_SUMMARY, {}, { headPushedMs: undefined })).toBe(false);
  });
});

describe('PR #87 clean no-major-issues receipt', () => {
  it('accepts the receipt because it names a unique head-SHA prefix after push', () => {
    expect(isCleanNoMajorIssuesBody(PR87_RECEIPT)).toBe(true);
    expect(accept(PR87_RECEIPT)).toBe(true);
  });

  it('rejects a SHA-less no-major-issues comment even after the head exists', () => {
    const body = "Codex Review: Didn't find any major issues.";
    expect(accept(body, { created_at: '2026-10-15T21:22:45Z' })).toBe(false);
  });

  it('rejects a no-major-issues comment that names an older SHA', () => {
    expect(accept("Didn't find any major issues.\n**Reviewed commit:** `aaaaaaa`")).toBe(false);
  });

  it('rejects a receipt that names both the head prefix and a different SHA', () => {
    expect(accept(`${PR87_RECEIPT}\nAlso saw \`${OLDER.slice(0, 7)}\`.`)).toBe(false);
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
      {
        headSha: HEAD,
        baseChangedMs: Date.parse('2026-10-15T22:00:00Z'),
        headPushedMs: HEAD_PUSHED_MS,
        uniqueResolve: uniqueToHead,
      },
    )).toBe(false);
  });
});

describe('Codex actor rules', () => {
  it('counts only the chatgpt-codex-connector bot', () => {
    expect(isCodexUser(CODEX_BOT)).toBe(true);
    expect(isCodexUser({ login: 'chatgpt-codex-connector', type: 'Bot' })).toBe(true);
    expect(isCodexUser({ login: 'chatgpt-codex-connector[bot]', type: 'User' })).toBe(false);
    expect(isCodexUser({ login: 'cursor[bot]', type: 'Bot' })).toBe(false);
    expect(isCodexUser({ login: BILL, type: 'User' })).toBe(false);
  });
});

describe('evaluatePr — Codex on head', () => {
  it('passes on a non-dismissed Codex review of the current head', () => {
    const verdict = evaluatePr(snapshot({
      reviews: [{
        user: CODEX_BOT,
        commit_id: HEAD,
        state: 'COMMENTED',
        submitted_at: '2026-10-15T21:22:45Z',
      }],
    }));
    expect(verdict.conclusion).toBe('success');
    expect(verdict.title).toBe('Codex reviewed head');
    expect(verdict.headSha).toBe(HEAD);
  });

  it('accepts a review commit_id that uniquely prefixes the head after push', () => {
    const verdict = evaluatePr(snapshot({
      reviews: [{
        user: CODEX_BOT,
        commit_id: '982551f',
        state: 'APPROVED',
        submitted_at: '2026-10-15T21:22:45Z',
      }],
    }));
    expect(verdict.conclusion).toBe('success');
  });

  it('rejects a short review commit_id that is not unique to this head', () => {
    const verdict = evaluatePr(snapshot({
      uniqueResolve: () => false,
      reviews: [{
        user: CODEX_BOT,
        commit_id: '982551f',
        state: 'APPROVED',
        submitted_at: '2026-10-15T21:22:45Z',
      }],
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('rejects a short review submitted before this head was pushed', () => {
    const verdict = evaluatePr(snapshot({
      reviews: [{
        user: CODEX_BOT,
        commit_id: '982551f',
        state: 'APPROVED',
        submitted_at: '2026-10-15T21:10:00Z',
      }],
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('fails when the only Codex review is on another SHA', () => {
    const verdict = evaluatePr(snapshot({
      reviews: [{
        user: CODEX_BOT,
        commit_id: OLDER,
        state: 'COMMENTED',
        submitted_at: '2026-10-15T21:22:45Z',
      }],
    }));
    expect(verdict.conclusion).toBe('failure');
    expect(verdict.title).toBe('Waiting for Codex on head');
  });

  it('passes on the real PR #87 clean summary comment', () => {
    const verdict = evaluatePr(snapshot({
      comments: [{
        user: CODEX_BOT,
        body: PR87_SUMMARY,
        created_at: '2026-10-15T21:22:45Z',
        updated_at: '2026-10-15T21:22:47Z',
      }],
    }));
    expect(verdict.conclusion).toBe('success');
    expect(verdict.summary).toMatch(/no findings/);
  });

  it('passes on the real PR #87 no-major-issues receipt', () => {
    const verdict = evaluatePr(snapshot({
      comments: [{
        user: CODEX_BOT,
        body: PR87_RECEIPT,
        created_at: '2026-10-15T21:22:45Z',
        updated_at: '2026-10-15T21:22:47Z',
      }],
    }));
    expect(verdict.conclusion).toBe('success');
  });

  it('blocks the clean-summary fallback when a dismissed Codex review sits on this head', () => {
    const verdict = evaluatePr(snapshot({
      reviews: [{
        user: CODEX_BOT,
        commit_id: HEAD,
        state: 'DISMISSED',
        submitted_at: '2026-10-15T21:22:45Z',
      }],
      comments: [{
        user: CODEX_BOT,
        body: PR87_SUMMARY,
        created_at: '2026-10-15T21:22:45Z',
        updated_at: '2026-10-15T21:22:47Z',
      }],
    }));
    expect(verdict.conclusion).toBe('failure');
    expect(verdict.title).toBe('Waiting for Codex on head');
  });

  it('ignores a human comment that copies the Codex summary shape', () => {
    const verdict = evaluatePr(snapshot({
      comments: [{
        user: { login: BILL, type: 'User' },
        body: PR87_SUMMARY,
        created_at: '2026-10-15T21:22:45Z',
        updated_at: '2026-10-15T21:22:47Z',
      }],
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('fails closed on a Codex usage-limit comment without a head review', () => {
    const verdict = evaluatePr(snapshot({
      comments: [{
        user: CODEX_BOT,
        body: 'I hit usage limits and cannot finish this review.',
        created_at: '2026-10-15T21:22:45Z',
        updated_at: '2026-10-15T21:22:45Z',
      }],
    }));
    expect(verdict.conclusion).toBe('failure');
    expect(verdict.title).toBe('Codex unavailable (usage limit)');
  });

  it('keeps drafts red even without a usage-limit comment', () => {
    const verdict = evaluatePr(snapshot({ pr: pr({ draft: true }) }));
    expect(verdict.conclusion).toBe('failure');
    expect(verdict.title).toBe('Draft PR');
  });

  it('fails closed on a non-40-character head SHA', () => {
    const verdict = evaluatePr(snapshot({ pr: pr({ head: { sha: '982551f' } }) }));
    expect(verdict.conclusion).toBe('failure');
    expect(verdict.title).toBe('Invalid head SHA');
  });
});

describe('evaluatePr — Bill-only waiver bound to exact head SHA', () => {
  const labeled = {
    event: 'labeled',
    label: { name: WAIVE_LABEL },
    actor: { login: BILL },
    created_at: '2026-10-15T22:00:00Z',
  };

  it('passes when a github-actions waiver record binds the exact head SHA', () => {
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [waiverComment()],
      timeline: [labeled],
    }));
    expect(verdict.conclusion).toBe('success');
    expect(verdict.title).toBe('Codex waived');
    expect(isWaiverBoundToCurrentHead({
      labels: [WAIVE_LABEL],
      comments: [waiverComment()],
      headSha: HEAD,
      prNumber: 87,
    })).toBe(true);
  });

  it('rejects a timestamp-only waiver that never recorded the head SHA', () => {
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      timeline: [
        { event: 'committed', created_at: '2026-10-15T21:00:00Z' },
        labeled,
      ],
    }));
    expect(verdict.conclusion).toBe('failure');
    expect(verdict.title).not.toBe('Codex waived');
    expect(isWaiverBoundToCurrentHead({
      labels: [WAIVE_LABEL],
      comments: [],
      headSha: HEAD,
      prNumber: 87,
    })).toBe(false);
  });

  it('rejects a waiver record bound to an older SHA after a new push', () => {
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [waiverComment(OLDER)],
      timeline: [labeled],
    }));
    expect(verdict.conclusion).toBe('failure');
    expect(parseWaiverRecord(waiverComment(OLDER).body)?.sha).toBe(OLDER);
  });

  it('rejects a human-forged waiver marker', () => {
    expect(isGithubActionsBot({ login: BILL, type: 'User' })).toBe(false);
    expect(waiverRecordAcceptsHead({
      user: { login: BILL, type: 'User' },
      body: formatWaiverComment({ sha: HEAD, actor: BILL, pr: 87 }),
    }, { headSha: HEAD, prNumber: 87 })).toBe(false);
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [{
        user: { login: BILL, type: 'User' },
        body: formatWaiverComment({ sha: HEAD, actor: BILL, pr: 87 }),
      }],
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('rejects a waiver labeled by anyone other than Bill', () => {
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [waiverComment(HEAD, 'cursor[bot]')],
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('rejects an unlabeled leftover even if the SHA record remains', () => {
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [] }),
      comments: [waiverComment()],
      timeline: [labeled, {
        event: 'unlabeled',
        label: { name: WAIVE_LABEL },
        actor: { login: BILL },
        created_at: '2026-10-15T22:01:00Z',
      }],
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('accepts a fresh labeled event from Bill on this exact head', () => {
    const event = {
      name: 'pull_request',
      action: 'labeled',
      sender: { login: BILL },
      label: { name: WAIVE_LABEL },
      pull_request: { number: 87, head: { sha: HEAD }, base: { ref: 'main' } },
    };
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      event,
    }));
    expect(verdict.conclusion).toBe('success');
    expect(verdict.title).toBe('Codex waived');
    expect(shouldPostWaiverRecord(event, pr({ labels: [{ name: WAIVE_LABEL }] }), HEAD)).toBe(true);
  });

  it('round-trips the waiver marker to the exact SHA', () => {
    const body = formatWaiverComment({ sha: HEAD, actor: BILL, pr: 87 });
    expect(body).toContain(WAIVER_MARKER);
    expect(parseWaiverRecord(body)).toEqual({ sha: HEAD, actor: BILL, pr: 87 });
  });
});

describe('combineHeadVerdicts', () => {
  it('fails the shared SHA when any open PR on that head is red', () => {
    const ok = evaluatePr(snapshot({
      comments: [{
        user: CODEX_BOT,
        body: PR87_RECEIPT,
        created_at: '2026-10-15T21:22:45Z',
        updated_at: '2026-10-15T21:22:47Z',
      }],
    }));
    const blocked = evaluatePr(snapshot({
      pr: pr({ number: 99, draft: true }),
    }));
    const combined = combineHeadVerdicts([ok, blocked]);
    expect(combined.conclusion).toBe('failure');
    expect(combined.title).toBe('Draft PR');
    expect(combined.summary).toMatch(/#99/);
  });

  it('passes only when every open PR on the SHA passes', () => {
    const a = evaluatePr(snapshot({
      comments: [{
        user: CODEX_BOT,
        body: PR87_RECEIPT,
        created_at: '2026-10-15T21:22:45Z',
        updated_at: '2026-10-15T21:22:47Z',
      }],
    }));
    const b = evaluatePr(snapshot({
      pr: pr({ number: 99 }),
      comments: [{
        user: CODEX_BOT,
        body: PR87_SUMMARY,
        created_at: '2026-10-15T21:22:45Z',
        updated_at: '2026-10-15T21:22:47Z',
      }],
    }));
    expect(combineHeadVerdicts([a, b]).conclusion).toBe('success');
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
        const err = new Error('GitHub 500') as Error & { status: number };
        err.status = 500;
        throw err;
      }
      return 'ok';
    }, { sleep: async () => undefined });
    expect(result).toBe('ok');
    expect(hits).toBe(3);

    let fourHits = 0;
    await expect(withRetry(async () => {
      fourHits += 1;
      const err = new Error('GitHub 422') as Error & { status: number };
      err.status = 422;
      throw err;
    }, { sleep: async () => undefined })).rejects.toThrow('GitHub 422');
    expect(fourHits).toBe(1);
  });
});

describe('refresh selects the counted CI job for this PR', () => {
  const pr87run = {
    id: 3,
    event: 'pull_request',
    path: `.github/workflows/${CI_WORKFLOW_FILE}`,
    created_at: '2026-10-16T00:02:00Z',
    run_number: 12,
    pull_requests: [{ number: 87 }],
  };

  it('picks the latest pull_request CI run for this PR number, not just the SHA', () => {
    const run = selectCiRun([
      { id: 1, event: 'pull_request_target', path: '.github/workflows/review-gate.yml', created_at: '2026-10-16T00:00:00Z', run_number: 10, pull_requests: [{ number: 87 }] },
      { id: 2, event: 'pull_request', path: `.github/workflows/${CI_WORKFLOW_FILE}`, created_at: '2026-10-16T00:01:00Z', run_number: 11, pull_requests: [{ number: 90 }] },
      pr87run,
    ], { prNumber: 87 });
    expect(run && run.id).toBe(3);
    expect(runMatchesPr(pr87run, 87)).toBe(true);
    expect(runMatchesPr(pr87run, 90)).toBe(false);
  });

  it('rejects a SHA-matching CI run that belongs to a different PR', () => {
    const run = selectCiRun([
      { id: 2, event: 'pull_request', path: `.github/workflows/${CI_WORKFLOW_FILE}`, created_at: '2026-10-16T00:01:00Z', run_number: 11, pull_requests: [{ number: 90 }] },
    ], { prNumber: 87 });
    expect(run).toBeNull();
  });

  it('rejects a SHA-matching run with no pull_requests attribution', () => {
    const run = selectCiRun([
      { id: 2, event: 'pull_request', path: `.github/workflows/${CI_WORKFLOW_FILE}`, created_at: '2026-10-16T00:01:00Z', run_number: 11 },
    ], { prNumber: 87 });
    expect(run).toBeNull();
  });

  it('selects the job named exactly review-gate', () => {
    const job = selectReviewGateJob([
      { id: 10, name: 'verify' },
      { id: 11, name: CHECK_JOB_NAME },
      { id: 12, name: 'refresh' },
    ]);
    expect(job && job.id).toBe(11);
  });

  it('rechecks completed gates on schedule, including green ones', () => {
    expect(shouldRerunOnSchedule({ conclusion: 'success', status: 'completed' })).toBe(true);
    expect(shouldRerunOnSchedule({ conclusion: 'failure', status: 'completed' })).toBe(true);
    expect(shouldRerunOnSchedule({ conclusion: null, status: 'in_progress' })).toBe(false);
  });

  it('caps before GitHub\'s 50-rerun limit and backs off on schedule', () => {
    expect(MAX_RUN_ATTEMPTS).toBeLessThan(50);
    expect(MAX_RUN_ATTEMPTS).toBe(8);
    expect(scheduleBackoffMs(1)).toBe(SCHEDULE_INTERVAL_MS);
    expect(scheduleBackoffMs(2)).toBe(2 * SCHEDULE_INTERVAL_MS);
    expect(scheduleBackoffMs(4)).toBe(8 * SCHEDULE_INTERVAL_MS);
    expect(scheduleBackoffMs(9)).toBe(8 * SCHEDULE_INTERVAL_MS);
    expect(runAttemptCount({ run_attempt: 8 })).toBe(8);

    const completed = Date.parse('2026-10-16T00:00:00Z');
    const run = { id: 3, status: 'completed', run_attempt: 2, updated_at: '2026-10-16T00:00:00Z' };
    const green = { id: 11, name: CHECK_JOB_NAME, status: 'completed', conclusion: 'success', completed_at: '2026-10-16T00:00:00Z' };
    const red = { id: 11, name: CHECK_JOB_NAME, status: 'completed', conclusion: 'failure', completed_at: '2026-10-16T00:00:00Z' };

    expect(rerunPlan(run, green, {
      eventName: 'schedule',
      nowMs: completed + 1000,
      lastJobCompletedMs: completed,
    })).toBe('backoff');
    expect(rerunPlan(run, green, {
      eventName: 'schedule',
      nowMs: completed + scheduleBackoffMs(2) + 1,
      lastJobCompletedMs: completed,
    })).toBe('rerun');
    expect(rerunPlan(run, red, {
      eventName: 'schedule',
      nowMs: completed + scheduleBackoffMs(2) + 1,
      lastJobCompletedMs: completed,
    })).toBe('rerun');
    expect(rerunPlan({ ...run, run_attempt: 8 }, red, { eventName: 'issue_comment' })).toBe('capped');
    expect(rerunPlan({ ...run, run_attempt: 8 }, green, { eventName: 'schedule' })).toBe('capped');
  });

  it('waits for an in-progress CI run on comment events, and skips that wait on schedule', () => {
    const run = { id: 3, status: 'in_progress', run_attempt: 1 };
    const job = { id: 11, name: CHECK_JOB_NAME, status: 'in_progress' };
    expect(rerunPlan(run, job, { eventName: 'issue_comment' })).toBe('wait-run');
    expect(rerunPlan(run, job, { eventName: 'schedule' })).toBe('skip-in-progress');
    expect(rerunPlan({ id: 3, status: 'completed', run_attempt: 1 }, {
      id: 11, name: CHECK_JOB_NAME, status: 'completed', conclusion: 'failure',
    }, { eventName: 'issue_comment' })).toBe('rerun');
  });
});

function executableYaml(text: string) {
  return text
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n');
}

function reviewGateJob(ci: string) {
  const gateBlock = ci.split(/^ {2}review-gate:/m)[1] || '';
  const nextJob = gateBlock.search(/^ {2}[A-Za-z0-9_-]+:/m);
  return nextJob === -1 ? gateBlock : gateBlock.slice(0, nextJob);
}

describe('workflows pin the counted context and never orphan checks.create', () => {
  const ci = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  const refresh = readFileSync(resolve(process.cwd(), '.github/workflows/review-gate.yml'), 'utf8');
  const security = readFileSync(resolve(process.cwd(), '.github/workflows/security-review.yml'), 'utf8');
  const contributing = readFileSync(resolve(process.cwd(), 'CONTRIBUTING.md'), 'utf8');
  const ciExec = executableYaml(ci);
  const refreshExec = executableYaml(refresh);
  const job = reviewGateJob(ci);

  it('defines a pull_request CI job named exactly review-gate', () => {
    expect(ci).toMatch(/^ {2}review-gate:/m);
    expect(ci).toMatch(/name:\s*review-gate/);
    expect(ci).toContain('pull_request:');
    expect(ciExec).not.toContain('pull_request_target');
    expect(ciExec).not.toContain('checks.create');
    expect(ciExec).not.toContain('Evaluating Codex review');
  });

  it('fetches the evaluator from the PR base SHA and never checkouts the PR in review-gate', () => {
    expect(job).toContain('github.event.pull_request.base.sha');
    expect(job).toContain('contents/scripts/review-gate.mjs');
    expect(job).toContain('application/vnd.github.raw');
    expect(job).toContain('${RUNNER_TEMP}/review-gate.mjs');
    expect(job).not.toMatch(/actions\/checkout/);
    expect(job).not.toContain('node scripts/review-gate.mjs');
    expect(job).toContain('pull-requests: read');
    expect(job).toContain('issues: read');
    expect(job).not.toContain('npm ci');
    expect(job).not.toContain('npm install');
    expect(job).not.toContain('npm test');
    expect(job).not.toContain('checks: write');
  });

  it('refreshes by rerunning that CI job from main\'s copy only', () => {
    expect(refresh).toContain('actions/github-script@v7');
    expect(refresh).toContain('reRunJobForWorkflowRun');
    expect(refresh).toContain('actions: write');
    expect(refresh).toContain('issues: write');
    expect(refreshExec).not.toContain('checks: write');
    expect(refreshExec).not.toContain('checks.create');
    expect(refreshExec).not.toContain('Evaluating Codex review');
    expect(refreshExec).not.toContain('actions/checkout');
    expect(refresh).toContain('pull_request_target');
    expect(refresh).toContain('issue_comment');
    expect(refresh).toMatch(/types:\s*\[created, edited, deleted\]/);
    expect(refreshExec).not.toContain('pull_request_review:');
    expect(refresh).not.toMatch(/^ {2}review-gate:/m);
  });

  it('matches the CI run to the PR number, caps reruns, and records a SHA-bound waiver', () => {
    expect(refresh).toContain('runMatchesPr');
    expect(refresh).toContain('pull_requests');
    expect(refresh).toContain('MAX_RUN_ATTEMPTS');
    expect(refresh).toContain('scheduleBackoffMs');
    expect(refresh).toContain(WAIVER_MARKER);
    expect(refresh).toContain('createComment');
    expect(refreshExec).not.toMatch(/schedule skip \(success\)/);
  });

  it('keeps the #88 matcher constants and documents residual ci.yml risk', () => {
    expect(COMPLETED_ROW.source).toContain('{7,40}');
    expect(MENTIONED_SHA.source).toContain('{7,40}');
    expect(NO_MAJOR_ISSUES.source).toMatch(/major issues/i);
    expect(SUMMARY_MARKER).toContain('codex-pull-request-review-summary');
    expect(contributing).toContain('base SHA');
    expect(contributing).toContain('Residual risk');
    expect(contributing).toContain('Required workflow');
    expect(contributing).toContain('2 November 2026');
  });

  it('does not modify security-review.yml', () => {
    expect(security).toContain('name: AI Security Review');
    expect(security).toContain('Wallet Security Scan');
  });
});

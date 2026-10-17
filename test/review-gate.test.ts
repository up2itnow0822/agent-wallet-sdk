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
  MAX_PREFIX_RESOLVES,
  MAX_WAIVER_RUN_RESOLVES,
  collectResolvablePrefixes,
  collectResolvableWaiverRuns,
  waiverRunIsDefaultBranchRevision,
  waiverReceiptAcceptsComment,
  parseWaiverReceipts,
  GITHUB_RERUN_CEILING,
  latestCodexHeadOutcome,
  dismissalMsByReviewId,
  refreshAction,
  MENTIONED_SHA,
  NO_MAJOR_ISSUES,
  SCHEDULE_INTERVAL_MS,
  SUMMARY_MARKER,
  REFRESH_WORKFLOW_PATH,
  WAIVE_LABEL,
  WAIVER_MARKER,
  WAIVER_RECORD_JOB,
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
  latestWaiverLabelAcceptsRecord,
  scheduleCapsWaitingGate,
  mentionedShas,
  mentionsNonHeadSha,
  evidenceMentionsNonHeadSha,
  codeReviewMentionedShas,
  timelineFacts,
  parseWaiverRecord,
  prefixUniquelyMatchesHead,
  codeReviewCompletedAtMs,
  commentEvidenceMs,
  isRefreshWorkflowPath,
  retryDelayMs,
  rerunPlan,
  runAttemptCount,
  runMatchesPr,
  runMatchesUnattributedHead,
  scheduleBackoffMs,
  selectCiRun,
  selectReviewGateJob,
  shaPrefixMatches,
  shouldPostWaiverRecord,
  shouldRecordWaiverOnEvent,
  shouldScanRecordWaiver,
  existingWaiverRecordForHead,
  TRUSTED_WAIVER_RECORD_EVENTS,
  createGithubClient,
  githubClientFromOctokit,
  shouldRefreshOnEvent,
  shouldRerunOnSchedule,
  isTrustedRefreshComment,
  isTrustedPullRequestRefreshEvent,
  countOpenHeadsWithSha,
  summaryMarksCleanHeadCompleted,
  summaryMarksHeadCompleted,
  waiverRecordAcceptsHead,
  waiverRunProvenanceAccepts,
  withRetry,
} from '../scripts/review-gate.mjs';

const HEAD = '982551f44942104308231bb10d5b56513c9c7050';
const OLDER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER_BASE = 'cccccccccccccccccccccccccccccccccccccccc';
const BILL = 'up2itnow0822';
const HEAD_PUSHED_MS = Date.parse('2026-10-15T21:20:00Z');
const uniqueToHead = (shown: string) => shaPrefixMatches(shown, HEAD);
const WAIVER_RUN_ID = 555001;
const WAIVER_COMMENT_ID = 88001;
const trustedWaiverProvenance = {
  run: {
    id: WAIVER_RUN_ID,
    path: REFRESH_WORKFLOW_PATH,
    event: 'pull_request_target',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-10-15T22:00:00Z',
    updated_at: '2026-10-15T22:00:30Z',
    pull_requests: [{
      number: 87,
      head: { sha: HEAD },
      base: { ref: 'main', sha: BASE_SHA },
    }],
  },
  jobs: [{ name: WAIVER_RECORD_JOB, status: 'completed', conclusion: 'success' }],
  defaultBranch: 'main',
  receipts: [{
    commentId: WAIVER_COMMENT_ID, run: WAIVER_RUN_ID, sha: HEAD, baseSha: BASE_SHA, pr: 87,
  }],
};
function resolveTrustedWaiver(runId: number) {
  return Number(runId) === WAIVER_RUN_ID ? trustedWaiverProvenance : null;
}

const PR87_SUMMARY = `<!-- codex-pull-request-review-summary -->
<!-- codex-review-state:v1 {"code_review":{"commit_sha":"982551f44942104308231bb10d5b56513c9c7050","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->

## Codex Review Summary

This comment shows the latest Codex review activity on this pull request.

| Review | Status | Commit | Review trigger |
| --- | --- | --- | --- |
| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-10-15T21:22:46.906149Z">2026-10-15T21:22:46.906149Z</relative-time> | \`982551f\` | Manual request |
`;

const STALE_SECURITY_SUMMARY = PR87_SUMMARY
  .replace(
    '"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}',
    `"security_review":{"commit_sha":"${OLDER}","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"}`,
  )
  + '\n| 🔒 **Security Review** | ✅ **Completed** <relative-time datetime="2026-10-15T20:00:00Z">2026-10-15T20:00:00Z</relative-time> | `'
  + OLDER.slice(0, 7) + '` | Manual request |\n';

const PR87_RECEIPT = `<!-- codex-review-receipt:v1 -->

Codex Review: Didn't find any major issues. More of your lovely PRs please.

**Reviewed commit:** \`982551f449\`
`;

const FINDINGS_SUMMARY = PR87_SUMMARY
  .replace('"has_any_findings":false', '"has_any_findings":true')
  .replace('"has_unresolved_findings":false', '"has_unresolved_findings":true');

const CODEX_FINDINGS_REVIEW = `<!-- codex-review-receipt:v1 -->

### 💡 Codex Review

Here are some automated review suggestions for this pull request.

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
    base: { ref: 'main', sha: BASE_SHA },
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
    resolveWaiverRun: resolveTrustedWaiver,
    ...over,
  };
}

function waiverComment(
  sha = HEAD,
  actor = BILL,
  number = 87,
  extra: Record<string, unknown> = {},
) {
  return {
    id: WAIVER_COMMENT_ID,
    user: GHA_BOT,
    body: formatWaiverComment({
      sha,
      actor,
      pr: number,
      base: 'main',
      baseSha: BASE_SHA,
      run: WAIVER_RUN_ID,
      ...extra,
    }),
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

describe('prefix resolution stays Codex-only and bounded', () => {
  it('ignores author comments and prefixes that cannot be this head', () => {
    const flood = Array.from({ length: 80 }, (_, i) =>
      '`' + i.toString(16).padStart(7, '0') + '`',
    ).join(' ');
    expect(collectResolvablePrefixes([], [{
      user: { login: 'contributor', type: 'User' },
      body: flood + ' `' + HEAD.slice(0, 7) + '`',
    }], HEAD)).toEqual([]);
    expect(collectResolvablePrefixes([], [{
      user: CODEX_BOT,
      body: 'saw `' + OLDER.slice(0, 7) + '` and `' + HEAD.slice(0, 7) + '`',
    }], HEAD)).toEqual([HEAD.slice(0, 7)]);
  });

  it('caps the number of prefixes resolved from Codex evidence', () => {
    expect(MAX_PREFIX_RESOLVES).toBeLessThanOrEqual(20);
    const many = Array.from({ length: 30 }, (_, i) => '`' + HEAD.slice(0, 7 + i) + '`').join(' ');
    const prefixes = collectResolvablePrefixes([], [{ user: CODEX_BOT, body: many }], HEAD);
    expect(prefixes.length).toBeLessThanOrEqual(MAX_PREFIX_RESOLVES);
  });

  it('resolves waiver run ids only from github-actions comments and caps lookups', () => {
    expect(MAX_WAIVER_RUN_RESOLVES).toBeLessThanOrEqual(20);
    expect(collectResolvableWaiverRuns([{
      user: { login: 'contributor', type: 'User' },
      body: formatWaiverComment({
        sha: HEAD, base: 'main', baseSha: BASE_SHA, actor: BILL, pr: 87, run: 111,
      }),
    }])).toEqual([]);
    expect(collectResolvableWaiverRuns([{
      user: GHA_BOT,
      body: formatWaiverComment({
        sha: HEAD, base: 'main', baseSha: BASE_SHA, actor: BILL, pr: 87, run: WAIVER_RUN_ID,
      }),
    }])).toEqual([WAIVER_RUN_ID]);
    const flood = Array.from({ length: 30 }, (_, i) => ({
      user: GHA_BOT,
      body: formatWaiverComment({
        sha: HEAD, base: 'main', baseSha: BASE_SHA, actor: BILL, pr: 87, run: 700000 + i,
      }),
    }));
    expect(collectResolvableWaiverRuns(flood).length).toBeLessThanOrEqual(MAX_WAIVER_RUN_RESOLVES);
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
    const early = PR87_SUMMARY.replace(
      'datetime="2026-10-15T21:22:46.906149Z"',
      'datetime="2026-10-15T21:10:00Z"',
    );
    expect(codeReviewCompletedAtMs(early, HEAD)).toBe(Date.parse('2026-10-15T21:10:00Z'));
    expect(accept(early)).toBe(false);
  });

  it('uses the Code Review row time, not the summary comment updated_at', () => {
    const staleRow = PR87_SUMMARY.replace(
      'datetime="2026-10-15T21:22:46.906149Z"',
      'datetime="2026-10-15T20:00:00Z"',
    );
    expect(commentEvidenceMs(
      { body: staleRow, created_at: '2026-10-15T20:00:00Z', updated_at: '2026-10-16T03:00:00Z' },
      { headSha: HEAD },
    )).toBe(Date.parse('2026-10-15T20:00:00Z'));
    expect(commentAcceptsCleanHead(
      { body: staleRow, created_at: '2026-10-15T20:00:00Z', updated_at: '2026-10-16T03:00:00Z' },
      {
        headSha: HEAD,
        baseChangedMs: Date.parse('2026-10-15T22:00:00Z'),
        headPushedMs: HEAD_PUSHED_MS,
        uniqueResolve: uniqueToHead,
      },
    )).toBe(false);
  });

  it('rejects a prefix that matches the head but is not unique on GitHub', () => {
    expect(accept(PR87_RECEIPT, {}, { uniqueResolve: () => false })).toBe(false);
    expect(accept(PR87_SUMMARY, {}, { uniqueResolve: () => false })).toBe(true);
  });

  it('fails closed when push/event time is missing (no committer-date fallback)', () => {
    expect(accept(PR87_SUMMARY, {}, { headPushedMs: undefined })).toBe(false);
  });

  it('ignores a stale Security Review SHA when Code Review is clean on this head', () => {
    expect(mentionsNonHeadSha(STALE_SECURITY_SUMMARY, HEAD)).toBe(true);
    expect(codeReviewMentionedShas(STALE_SECURITY_SUMMARY).every(
      s => shaPrefixMatches(s, HEAD),
    )).toBe(true);
    expect(evidenceMentionsNonHeadSha(STALE_SECURITY_SUMMARY, HEAD)).toBe(false);
    expect(accept(STALE_SECURITY_SUMMARY)).toBe(true);
    const verdict = evaluatePr(snapshot({
      comments: [{
        user: CODEX_BOT,
        body: STALE_SECURITY_SUMMARY,
        created_at: '2026-10-15T21:22:45Z',
        updated_at: '2026-10-15T21:22:47Z',
      }],
    }));
    expect(verdict.conclusion).toBe('success');
    expect(verdict.summary).toMatch(/no findings/);
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
  it('rejects a Codex review that exists but has findings (3a31911-style)', () => {
    const verdict = evaluatePr(snapshot({
      reviews: [{
        user: CODEX_BOT,
        commit_id: HEAD,
        state: 'COMMENTED',
        body: CODEX_FINDINGS_REVIEW,
        submitted_at: '2026-10-15T21:22:45Z',
      }],
    }));
    expect(verdict.conclusion).toBe('failure');
    expect(verdict.title).toBe('Codex found issues on head');
    expect(verdict.headSha).toBe(HEAD);
  });

  it('does not treat a findings summary comment as a clean pass', () => {
    expect(summaryMarksHeadCompleted(FINDINGS_SUMMARY, HEAD)).toBe(true);
    expect(summaryMarksCleanHeadCompleted(FINDINGS_SUMMARY, HEAD)).toBe(false);
    expect(accept(FINDINGS_SUMMARY)).toBe(false);
    const verdict = evaluatePr(snapshot({
      comments: [{
        user: CODEX_BOT,
        body: FINDINGS_SUMMARY,
        created_at: '2026-10-15T21:22:45Z',
        updated_at: '2026-10-15T21:22:47Z',
      }],
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('accepts a Codex review whose body is a no-major-issues receipt', () => {
    const verdict = evaluatePr(snapshot({
      reviews: [{
        user: CODEX_BOT,
        commit_id: '982551f',
        state: 'COMMENTED',
        body: PR87_RECEIPT,
        submitted_at: '2026-10-15T21:22:45Z',
      }],
    }));
    expect(verdict.conclusion).toBe('success');
    expect(verdict.summary).toMatch(/no findings/);
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

  it('lets a later non-dismissed clean review supersede a dismissal on the same SHA', () => {
    const verdict = evaluatePr(snapshot({
      reviews: [{
        id: 1001,
        user: CODEX_BOT,
        commit_id: HEAD,
        state: 'DISMISSED',
        submitted_at: '2026-10-15T21:22:45Z',
      }, {
        user: CODEX_BOT,
        commit_id: HEAD,
        state: 'COMMENTED',
        body: PR87_RECEIPT,
        submitted_at: '2026-10-15T21:30:00Z',
      }],
      timeline: [{
        event: 'review_dismissed',
        created_at: '2026-10-15T21:23:00Z',
        dismissed_review: { review_id: 1001 },
      }],
    }));
    expect(verdict.conclusion).toBe('success');
    expect(verdict.summary).toMatch(/no findings/);
  });

  it('orders a dismissed Codex review by the dismissal time, not submitted_at', () => {
    const dismissed = {
      id: 5548493803,
      user: CODEX_BOT,
      commit_id: HEAD,
      state: 'DISMISSED',
      submitted_at: '2026-10-15T21:10:00Z',
    };
    const cleanComment = {
      user: CODEX_BOT,
      body: PR87_SUMMARY,
      created_at: '2026-10-15T21:22:45Z',
      updated_at: '2026-10-15T21:22:47Z',
    };
    const dismissal = {
      event: 'review_dismissed',
      created_at: '2026-10-15T21:50:00Z',
      dismissed_review: { review_id: 5548493803 },
    };
    expect(dismissalMsByReviewId([dismissal]).get(5548493803))
      .toBe(Date.parse('2026-10-15T21:50:00Z'));
    expect(latestCodexHeadOutcome({
      reviews: [dismissed],
      comments: [cleanComment],
      headSha: HEAD,
      uniqueResolve: uniqueToHead,
      headPushedMs: HEAD_PUSHED_MS,
      baseChangedMs: 0,
      timeline: [dismissal],
    })?.clean).toBe(false);

    const verdict = evaluatePr(snapshot({
      reviews: [dismissed],
      comments: [cleanComment],
      timeline: [dismissal],
    }));
    expect(verdict.conclusion).toBe('failure');
    expect(verdict.title).toBe('Waiting for Codex on head');
  });

  it('fails closed when a dismissed review has no timeline dismissal time', () => {
    const verdict = evaluatePr(snapshot({
      reviews: [{
        id: 77,
        user: CODEX_BOT,
        commit_id: HEAD,
        state: 'DISMISSED',
        submitted_at: '2026-10-15T21:10:00Z',
      }],
      comments: [{
        user: CODEX_BOT,
        body: PR87_SUMMARY,
        created_at: '2026-10-15T21:22:45Z',
        updated_at: '2026-10-15T21:22:47Z',
      }],
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('blocks the clean-summary fallback when a later dismissed Codex review sits on this head', () => {
    const verdict = evaluatePr(snapshot({
      reviews: [{
        user: CODEX_BOT,
        commit_id: HEAD,
        state: 'DISMISSED',
        submitted_at: '2026-10-15T21:23:00Z',
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

  it('lets later findings override an older clean review or comment on the same SHA', () => {
    expect(latestCodexHeadOutcome({
      reviews: [{
        user: CODEX_BOT,
        commit_id: HEAD,
        state: 'COMMENTED',
        body: PR87_RECEIPT,
        submitted_at: '2026-10-15T21:22:45Z',
      }, {
        user: CODEX_BOT,
        commit_id: HEAD,
        state: 'COMMENTED',
        body: CODEX_FINDINGS_REVIEW,
        submitted_at: '2026-10-15T21:40:00Z',
      }],
      comments: [],
      headSha: HEAD,
      uniqueResolve: uniqueToHead,
      headPushedMs: HEAD_PUSHED_MS,
      baseChangedMs: 0,
    })?.clean).toBe(false);

    const laterFindingsReview = evaluatePr(snapshot({
      reviews: [{
        user: CODEX_BOT,
        commit_id: HEAD,
        state: 'COMMENTED',
        body: PR87_RECEIPT,
        submitted_at: '2026-10-15T21:22:45Z',
      }, {
        user: CODEX_BOT,
        commit_id: HEAD,
        state: 'COMMENTED',
        body: CODEX_FINDINGS_REVIEW,
        submitted_at: '2026-10-15T21:40:00Z',
      }],
    }));
    expect(laterFindingsReview.conclusion).toBe('failure');
    expect(laterFindingsReview.title).toBe('Codex found issues on head');

    const laterFindingsComment = evaluatePr(snapshot({
      reviews: [{
        user: CODEX_BOT,
        commit_id: HEAD,
        state: 'COMMENTED',
        body: PR87_RECEIPT,
        submitted_at: '2026-10-15T21:22:45Z',
      }],
      comments: [{
        user: CODEX_BOT,
        body: FINDINGS_SUMMARY.replace(
          '2026-10-15T21:22:46.906149Z',
          '2026-10-15T21:40:00.000000Z',
        ),
        created_at: '2026-10-15T21:40:00Z',
        updated_at: '2026-10-15T21:40:00Z',
      }],
    }));
    expect(laterFindingsComment.conclusion).toBe('failure');
    expect(laterFindingsComment.title).toBe('Codex found issues on head');

    const laterClean = evaluatePr(snapshot({
      reviews: [{
        user: CODEX_BOT,
        commit_id: HEAD,
        state: 'COMMENTED',
        body: CODEX_FINDINGS_REVIEW,
        submitted_at: '2026-10-15T21:22:45Z',
      }, {
        user: CODEX_BOT,
        commit_id: HEAD,
        state: 'COMMENTED',
        body: PR87_RECEIPT,
        submitted_at: '2026-10-15T21:40:00Z',
      }],
    }));
    expect(laterClean.conclusion).toBe('success');
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

  it('passes when a github-actions waiver record binds head, base, and a trusted run', () => {
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
      baseRef: 'main',
      baseSha: BASE_SHA,
      resolveWaiverRun: resolveTrustedWaiver,
      lastWaiverEvent: labeled,
    })).toBe(true);
  });

  it('rejects resurrecting a revoked waiver when someone else re-applies the label', () => {
    const contributorLabeled = {
      event: 'labeled',
      label: { name: WAIVE_LABEL },
      actor: { login: 'contributor' },
      created_at: '2026-10-15T22:20:00Z',
    };
    const timeline = [
      labeled,
      {
        event: 'unlabeled',
        label: { name: WAIVE_LABEL },
        actor: { login: BILL },
        created_at: '2026-10-15T22:10:00Z',
      },
      contributorLabeled,
    ];
    expect(latestWaiverLabelAcceptsRecord(contributorLabeled, waiverComment())).toBe(false);
    expect(isWaiverBoundToCurrentHead({
      labels: [WAIVE_LABEL],
      comments: [waiverComment()],
      headSha: HEAD,
      prNumber: 87,
      baseRef: 'main',
      baseSha: BASE_SHA,
      resolveWaiverRun: resolveTrustedWaiver,
      lastWaiverEvent: contributorLabeled,
    })).toBe(false);
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [waiverComment()],
      timeline,
    }));
    expect(verdict.conclusion).toBe('failure');
    expect(verdict.title).not.toBe('Codex waived');
  });

  it('rejects an old record after Bill removes and later re-applies the label', () => {
    const relabeled = {
      event: 'labeled',
      label: { name: WAIVE_LABEL },
      actor: { login: BILL },
      created_at: '2026-10-15T23:00:00Z',
    };
    expect(latestWaiverLabelAcceptsRecord(relabeled, waiverComment())).toBe(false);
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [waiverComment()],
      timeline: [
        labeled,
        {
          event: 'unlabeled',
          label: { name: WAIVE_LABEL },
          actor: { login: BILL },
          created_at: '2026-10-15T22:10:00Z',
        },
        relabeled,
      ],
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('accepts a new Bill record posted after the latest labeled event', () => {
    const relabeled = {
      event: 'labeled',
      label: { name: WAIVE_LABEL },
      actor: { login: BILL },
      created_at: '2026-10-15T22:00:00Z',
    };
    const fresh = { ...waiverComment(), created_at: '2026-10-15T22:00:10Z' };
    expect(latestWaiverLabelAcceptsRecord(relabeled, fresh)).toBe(true);
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [fresh],
      timeline: [relabeled],
    }));
    expect(verdict.conclusion).toBe('success');
    expect(verdict.title).toBe('Codex waived');
  });

  it('rejects a bot comment that only impersonates github-actions without run provenance', () => {
    const forged = {
      user: GHA_BOT,
      body: '<!-- review-gate-waiver:v1 {"sha":"' + HEAD + '","actor":"' + BILL + '","pr":87} -->',
    };
    expect(parseWaiverRecord(forged.body)).toBeNull();
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [forged],
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('rejects a bot comment citing a PR-controlled security-review run', () => {
    const rec = formatWaiverComment({
      sha: HEAD, base: 'main', baseSha: BASE_SHA, actor: BILL, pr: 87, run: 42,
      workflow: '.github/workflows/security-review.yml',
    });
    expect(waiverRunProvenanceAccepts({
      id: 42,
      path: '.github/workflows/security-review.yml',
      event: 'pull_request',
      pull_requests: [{ number: 87 }],
    }, [{ name: 'security-review', status: 'completed', conclusion: 'success' }], { prNumber: 87 })).toBe(false);
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [{ user: GHA_BOT, body: rec }],
      resolveWaiverRun: () => ({
        run: {
          id: 42,
          path: '.github/workflows/security-review.yml',
          event: 'pull_request',
          pull_requests: [{ number: 87 }],
        },
        jobs: [{ name: 'security-review', status: 'completed', conclusion: 'success' }],
      }),
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('rejects replaying a trusted waiver run against a new head', () => {
    const replayed = waiverComment(HEAD, BILL, 87);
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [replayed],
      resolveWaiverRun: () => ({
        run: {
          id: WAIVER_RUN_ID,
          path: `${REFRESH_WORKFLOW_PATH}@main`,
          event: 'pull_request_target',
          created_at: '2026-10-15T22:00:00Z',
          updated_at: '2026-10-15T22:00:30Z',
          pull_requests: [{
            number: 87,
            head: { sha: OLDER },
            base: { ref: 'main', sha: BASE_SHA },
          }],
        },
        jobs: [{ name: WAIVER_RECORD_JOB, status: 'completed', conclusion: 'success' }],
      }),
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('rejects a waiver comment created after the cited run finished', () => {
    const late = {
      ...waiverComment(),
      created_at: '2026-10-16T04:00:00Z',
    };
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [late],
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('accepts GitHub\'s ref-qualified workflow path', () => {
    expect(isRefreshWorkflowPath('.github/workflows/review-gate.yml@main')).toBe(true);
    expect(isRefreshWorkflowPath('.github/workflows/review-gate.yml@22ceb65c27016c74997c52e07c7da7109f13a633')).toBe(true);
    expect(isRefreshWorkflowPath('.github/workflows/security-review.yml@main')).toBe(false);
    expect(isRefreshWorkflowPath('.github/workflows/review-gate.yml@main/../../evil.yml')).toBe(false);
  });

  it('rejects a comment citing a refresh run that never ran record-waiver', () => {
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [waiverComment()],
      resolveWaiverRun: () => ({
        run: {
          id: WAIVER_RUN_ID,
          path: REFRESH_WORKFLOW_PATH,
          event: 'pull_request_target',
          pull_requests: [{ number: 87 }],
        },
        jobs: [{ name: 'refresh', status: 'completed', conclusion: 'success' }],
      }),
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('rejects a waiver after the PR is retargeted to a new base', () => {
    const verdict = evaluatePr(snapshot({
      pr: pr({
        labels: [{ name: WAIVE_LABEL }],
        base: { ref: 'release', sha: OTHER_BASE },
      }),
      comments: [waiverComment()],
    }));
    expect(verdict.conclusion).toBe('failure');
    expect(verdict.title).not.toBe('Codex waived');
  });

  it('rejects a waiver when main moved and the recorded base SHA is stale', () => {
    const verdict = evaluatePr(snapshot({
      pr: pr({
        labels: [{ name: WAIVE_LABEL }],
        base: { ref: 'main', sha: OTHER_BASE },
      }),
      comments: [waiverComment()],
    }));
    expect(verdict.conclusion).toBe('failure');
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
      body: formatWaiverComment({
        sha: HEAD, actor: BILL, pr: 87, base: 'main', baseSha: BASE_SHA, run: WAIVER_RUN_ID,
      }),
    }, {
      headSha: HEAD,
      prNumber: 87,
      baseRef: 'main',
      baseSha: BASE_SHA,
      resolveWaiverRun: resolveTrustedWaiver,
    })).toBe(false);
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [{
        user: { login: BILL, type: 'User' },
        body: formatWaiverComment({
          sha: HEAD, actor: BILL, pr: 87, base: 'main', baseSha: BASE_SHA, run: WAIVER_RUN_ID,
        }),
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
      pull_request: { number: 87, head: { sha: HEAD }, base: { ref: 'main', sha: BASE_SHA } },
    };
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      event,
    }));
    expect(verdict.conclusion).toBe('success');
    expect(verdict.title).toBe('Codex waived');
    expect(shouldPostWaiverRecord(event, pr({ labels: [{ name: WAIVE_LABEL }] }), HEAD)).toBe(true);
  });

  it('round-trips the waiver marker to the exact SHA, base, and run', () => {
    const body = formatWaiverComment({
      sha: HEAD, actor: BILL, pr: 87, base: 'main', baseSha: BASE_SHA, run: WAIVER_RUN_ID,
    });
    expect(body).toContain(WAIVER_MARKER);
    expect(parseWaiverRecord(body)).toEqual({
      sha: HEAD,
      actor: BILL,
      pr: 87,
      base: 'main',
      baseSha: BASE_SHA,
      run: WAIVER_RUN_ID,
      workflow: REFRESH_WORKFLOW_PATH,
    });
  });

  it('accepts a schedule or dispatch record-waiver run with an empty pull_requests list', () => {
    expect(TRUSTED_WAIVER_RECORD_EVENTS.has('schedule')).toBe(true);
    expect(TRUSTED_WAIVER_RECORD_EVENTS.has('workflow_dispatch')).toBe(true);
    const scheduleRun = {
      id: WAIVER_RUN_ID,
      path: REFRESH_WORKFLOW_PATH,
      event: 'schedule',
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-10-15T22:00:00Z',
      updated_at: '2026-10-15T22:00:30Z',
      pull_requests: [],
    };
    const jobs = [{ name: WAIVER_RECORD_JOB, status: 'completed', conclusion: 'success' }];
    const receipts = [{
      commentId: WAIVER_COMMENT_ID, run: WAIVER_RUN_ID, sha: HEAD, baseSha: BASE_SHA, pr: 87,
    }];
    const bound = {
      prNumber: 87, headSha: HEAD, baseRef: 'main', baseSha: BASE_SHA,
      commentCreatedMs: Date.parse('2026-10-15T22:00:01Z'),
      defaultBranch: 'main',
      receipts,
      commentId: WAIVER_COMMENT_ID,
    };
    expect(waiverRunProvenanceAccepts(scheduleRun, jobs, bound)).toBe(true);
    expect(waiverRunProvenanceAccepts({
      ...scheduleRun, event: 'workflow_dispatch',
    }, jobs, bound)).toBe(true);
    expect(waiverRunProvenanceAccepts(scheduleRun, jobs, {
      ...bound, receipts: [],
    })).toBe(false);
    expect(waiverRunIsDefaultBranchRevision({
      event: 'workflow_dispatch', head_branch: 'evil',
    }, 'main')).toBe(false);
    expect(waiverRunIsDefaultBranchRevision({
      event: 'workflow_dispatch', head_branch: '',
    }, 'main')).toBe(false);
    expect(waiverRunProvenanceAccepts({
      ...scheduleRun, event: 'workflow_dispatch', head_branch: 'evil',
    }, jobs, bound)).toBe(false);
    expect(waiverRunProvenanceAccepts({
      ...scheduleRun,
      pull_requests: [{
        number: 87, head: { sha: HEAD }, base: { ref: 'main', sha: BASE_SHA },
      }],
    }, jobs, { ...bound, receipts: [] })).toBe(false);
    expect(waiverRunProvenanceAccepts({
      ...scheduleRun, event: 'pull_request_target',
    }, jobs, bound)).toBe(false);
    expect(waiverRunProvenanceAccepts({
      ...scheduleRun, event: 'issue_comment',
    }, jobs, { prNumber: 87 })).toBe(false);

    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [waiverComment()],
      timeline: [labeled],
      resolveWaiverRun: () => ({
        run: scheduleRun, jobs, receipts, defaultBranch: 'main',
      }),
    }));
    expect(verdict.conclusion).toBe('success');
    expect(verdict.title).toBe('Codex waived');
  });

  it('records a schedule waiver only for Bill\'s latest labeled event on this head', () => {
    expect(shouldRecordWaiverOnEvent('schedule')).toBe(true);
    expect(shouldRecordWaiverOnEvent('workflow_dispatch')).toBe(true);
    expect(shouldRecordWaiverOnEvent('issue_comment', {
      action: 'created',
      comment: { user: { login: 'chatgpt-codex-connector[bot]' } },
    })).toBe(false);
    expect(shouldRecordWaiverOnEvent('pull_request_target', {
      action: 'labeled',
      label: { name: WAIVE_LABEL },
      sender: { login: BILL },
    })).toBe(true);
    expect(shouldRecordWaiverOnEvent('pull_request_target', {
      action: 'labeled',
      label: { name: WAIVE_LABEL },
      sender: { login: 'contributor' },
    })).toBe(false);

    const scan = {
      labels: [WAIVE_LABEL],
      lastWaiverEvent: labeled,
      headMovedAfterWaiver: false,
      headPushedMs: Date.parse('2026-10-15T21:00:00Z'),
      baseChangedMs: 0,
      comments: [],
      headSha: HEAD,
      baseRef: 'main',
      baseSha: BASE_SHA,
      prNumber: 87,
    };
    expect(shouldScanRecordWaiver(scan)).toBe(true);
    expect(shouldScanRecordWaiver({
      ...scan,
      lastWaiverEvent: { ...labeled, actor: { login: 'contributor' } },
    })).toBe(false);
    expect(shouldScanRecordWaiver({
      ...scan,
      lastWaiverEvent: {
        event: 'unlabeled',
        label: { name: WAIVE_LABEL },
        actor: { login: BILL },
        created_at: '2026-10-15T22:10:00Z',
      },
    })).toBe(false);
    expect(shouldScanRecordWaiver({
      ...scan,
      headPushedMs: Date.parse('2026-10-15T22:10:00Z'),
    })).toBe(false);
    expect(shouldScanRecordWaiver({
      ...scan,
      headPushedMs: undefined,
    })).toBe(false);
    expect(shouldScanRecordWaiver({
      ...scan,
      comments: [waiverComment()],
    })).toBe(true);
    expect(existingWaiverRecordForHead([waiverComment()], {
      headSha: HEAD, baseRef: 'main', baseSha: BASE_SHA, prNumber: 87,
      actor: BILL, lastWaiverEvent: labeled,
    })).toBe(false);
    expect(existingWaiverRecordForHead([waiverComment()], {
      headSha: HEAD, baseRef: 'main', baseSha: BASE_SHA, prNumber: 87,
      actor: BILL, lastWaiverEvent: labeled, resolveWaiverRun: resolveTrustedWaiver,
    })).toBe(true);
    expect(shouldScanRecordWaiver({
      ...scan,
      comments: [waiverComment()],
      resolveWaiverRun: resolveTrustedWaiver,
    })).toBe(false);
  });

  it('does not let a forged github-actions waiver marker suppress recording', () => {
    const forged = {
      user: GHA_BOT,
      body: formatWaiverComment({
        sha: HEAD, base: 'main', baseSha: BASE_SHA, actor: BILL, pr: 87, run: 999001,
      }),
      created_at: '2026-10-15T22:00:10Z',
    };
    expect(existingWaiverRecordForHead([forged], {
      headSha: HEAD, baseRef: 'main', baseSha: BASE_SHA, prNumber: 87,
      actor: BILL, lastWaiverEvent: labeled,
      resolveWaiverRun: () => ({
        run: {
          id: 999001,
          path: '.github/workflows/security-review.yml',
          event: 'pull_request',
          status: 'completed',
          conclusion: 'success',
        },
        jobs: [{ name: 'security-review', status: 'completed', conclusion: 'success' }],
      }),
    })).toBe(false);
    expect(shouldScanRecordWaiver({
      labels: [WAIVE_LABEL],
      lastWaiverEvent: labeled,
      headMovedAfterWaiver: false,
      headPushedMs: Date.parse('2026-10-15T21:00:00Z'),
      baseChangedMs: 0,
      comments: [forged],
      headSha: HEAD,
      baseRef: 'main',
      baseSha: BASE_SHA,
      prNumber: 87,
      resolveWaiverRun: () => null,
    })).toBe(true);
  });

  it('does not bind a schedule waiver to a new head after an ordinary push', () => {
    const labeledOnA = {
      event: 'labeled',
      label: { name: WAIVE_LABEL },
      actor: { login: BILL },
      created_at: '2026-10-15T22:00:00Z',
    };
    const committedAfterLabel = { event: 'committed', sha: HEAD };
    const facts = timelineFacts([
      { event: 'committed', sha: OLDER },
      labeledOnA,
      committedAfterLabel,
    ]);
    expect(facts.headMovedAfterWaiver).toBe(true);
    expect(committedAfterLabel).not.toHaveProperty('created_at');
    expect(shouldScanRecordWaiver({
      labels: [WAIVE_LABEL],
      lastWaiverEvent: facts.lastWaiverEvent,
      headMovedAfterWaiver: facts.headMovedAfterWaiver,
      headPushedMs: Date.parse('2026-10-15T22:10:00Z'),
      baseChangedMs: 0,
      comments: [],
      headSha: HEAD,
      baseRef: 'main',
      baseSha: BASE_SHA,
      prNumber: 87,
    })).toBe(false);
    expect(shouldScanRecordWaiver({
      labels: [WAIVE_LABEL],
      lastWaiverEvent: labeledOnA,
      headMovedAfterWaiver: false,
      headPushedMs: Date.parse('2026-10-15T22:10:00Z'),
      baseChangedMs: 0,
      comments: [],
      headSha: HEAD,
      baseRef: 'main',
      baseSha: BASE_SHA,
      prNumber: 87,
    })).toBe(false);
  });

  it('rejects a persisted waiver after a later force-push even if the SHA returns', () => {
    const timeline = [
      labeled,
      { event: 'head_ref_force_pushed', created_at: '2026-10-15T22:30:00Z' },
    ];
    const facts = timelineFacts(timeline);
    expect(facts.headMovedAfterWaiver).toBe(true);
    expect(isWaiverBoundToCurrentHead({
      labels: [WAIVE_LABEL],
      comments: [waiverComment()],
      headSha: HEAD,
      prNumber: 87,
      baseRef: 'main',
      baseSha: BASE_SHA,
      resolveWaiverRun: resolveTrustedWaiver,
      lastWaiverEvent: labeled,
      headMovedAfterWaiver: true,
    })).toBe(false);
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      comments: [waiverComment()],
      timeline,
    }));
    expect(verdict.conclusion).toBe('failure');
    expect(verdict.title).not.toBe('Codex waived');
  });

  it('rejects record-waiver provenance that is still in progress or later failed', () => {
    const jobsInProgress = [{ name: WAIVER_RECORD_JOB, status: 'in_progress' }];
    const jobsFailed = [{ name: WAIVER_RECORD_JOB, status: 'completed', conclusion: 'failure' }];
    const run = {
      id: WAIVER_RUN_ID,
      path: REFRESH_WORKFLOW_PATH,
      event: 'schedule',
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-10-15T22:00:00Z',
      updated_at: '2026-10-15T22:00:30Z',
      pull_requests: [],
    };
    expect(waiverRunProvenanceAccepts(run, jobsInProgress, {
      prNumber: 87, headSha: HEAD, baseRef: 'main', baseSha: BASE_SHA,
      commentCreatedMs: Date.parse('2026-10-15T22:00:01Z'),
    })).toBe(false);
    expect(waiverRunProvenanceAccepts({ ...run, status: 'in_progress', conclusion: null }, [
      { name: WAIVER_RECORD_JOB, status: 'completed', conclusion: 'success' },
    ], { prNumber: 87, commentCreatedMs: Date.parse('2026-10-15T22:00:01Z') })).toBe(false);
    expect(waiverRunProvenanceAccepts({ ...run, conclusion: 'cancelled' }, [
      { name: WAIVER_RECORD_JOB, status: 'completed', conclusion: 'success' },
    ], { prNumber: 87, commentCreatedMs: Date.parse('2026-10-15T22:00:01Z') })).toBe(false);
    expect(waiverRunProvenanceAccepts(run, jobsFailed, {
      prNumber: 87, commentCreatedMs: Date.parse('2026-10-15T22:00:01Z'),
    })).toBe(false);
    expect(waiverRunProvenanceAccepts(run, [
      { name: WAIVER_RECORD_JOB, status: 'completed', conclusion: 'success' },
    ], {
      prNumber: 87, headSha: HEAD, baseRef: 'main', baseSha: BASE_SHA,
      commentCreatedMs: Date.parse('2026-10-15T22:00:01Z'),
    })).toBe(false);
    expect(waiverRunProvenanceAccepts(run, [
      { name: WAIVER_RECORD_JOB, status: 'completed', conclusion: 'success' },
    ], {
      prNumber: 87, headSha: HEAD, baseRef: 'main', baseSha: BASE_SHA,
      commentCreatedMs: Date.parse('2026-10-15T22:00:01Z'),
      defaultBranch: 'main',
      commentId: WAIVER_COMMENT_ID,
      receipts: [{
        commentId: WAIVER_COMMENT_ID, run: WAIVER_RUN_ID, sha: HEAD, baseSha: BASE_SHA, pr: 87,
      }],
    })).toBe(true);
    expect(waiverReceiptAcceptsComment([], waiverComment(), {
      prNumber: 87, headSha: HEAD, baseSha: BASE_SHA, runId: WAIVER_RUN_ID,
    })).toBe(false);
    expect(parseWaiverReceipts([{
      title: 'review-gate-waiver-receipt',
      message: JSON.stringify({
        marker: 'review-gate-waiver-receipt:v1',
        receipts: [{
          commentId: WAIVER_COMMENT_ID, run: WAIVER_RUN_ID, sha: HEAD, baseSha: BASE_SHA, pr: 87,
        }],
      }),
    }])[0]?.commentId).toBe(WAIVER_COMMENT_ID);
  });
});

describe('createGithubClient token and octokit', () => {
  it('prefers the injected octokit and throws without a token or octokit', () => {
    expect(() => createGithubClient({})).toThrow(/GITHUB_TOKEN/);
    const seen: string[] = [];
    const octokit = {
      request: async (route: string) => {
        seen.push(route);
        return { status: 200, data: { ok: true } };
      },
    };
    const client = createGithubClient({ octokit });
    return client.get('/repos/o/r').then(data => {
      expect(data).toEqual({ ok: true });
      expect(seen[0]).toBe('GET /repos/o/r');
      expect(githubClientFromOctokit(octokit)).toBeTruthy();
    });
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

  it('rejects a SHA-matching run with no pull_requests attribution when the head is not unique', () => {
    const run = selectCiRun([
      { id: 2, event: 'pull_request', path: `.github/workflows/${CI_WORKFLOW_FILE}`, created_at: '2026-10-16T00:01:00Z', run_number: 11 },
    ], { prNumber: 87, headIsUnique: false });
    expect(run).toBeNull();
  });

  const forkPr = {
    number: 87,
    head: {
      sha: HEAD,
      ref: 'cloud/review-gate-ci-job-6adb',
      repo: { full_name: 'contributor/agent-wallet-sdk' },
    },
  };
  const forkRun = {
    id: 4,
    event: 'pull_request',
    path: `.github/workflows/${CI_WORKFLOW_FILE}`,
    created_at: '2026-10-16T00:03:00Z',
    run_number: 13,
    head_sha: HEAD,
    head_branch: 'cloud/review-gate-ci-job-6adb',
    head_repository: { full_name: 'contributor/agent-wallet-sdk' },
    pull_requests: [],
  };

  it('matches an unattributed fork CI run by head SHA + repo + branch (actions/runner#3444)', () => {
    expect(runMatchesUnattributedHead(forkRun, forkPr)).toBe(true);
    const run = selectCiRun([forkRun], { prNumber: 87, pr: forkPr, headIsUnique: false });
    expect(run && run.id).toBe(4);
  });

  it('does not match an unattributed run from a different fork or branch', () => {
    expect(runMatchesUnattributedHead({
      ...forkRun,
      head_repository: { full_name: 'other/agent-wallet-sdk' },
    }, forkPr)).toBe(false);
    expect(runMatchesUnattributedHead({
      ...forkRun,
      head_branch: 'other-branch',
    }, forkPr)).toBe(false);
    expect(selectCiRun([{
      ...forkRun,
      head_repository: { full_name: 'other/agent-wallet-sdk' },
    }], { prNumber: 87, pr: forkPr, headIsUnique: false })).toBeNull();
  });

  it('never uses a run attributed to a different PR, even when fork metadata matches', () => {
    const stolen = {
      ...forkRun,
      id: 5,
      pull_requests: [{ number: 90 }],
    };
    expect(runMatchesUnattributedHead(stolen, forkPr)).toBe(false);
    expect(selectCiRun([stolen], { prNumber: 87, pr: forkPr, headIsUnique: true })).toBeNull();
  });

  it('prefers a numbered pull_requests match over an unattributed fork run', () => {
    const run = selectCiRun([
      forkRun,
      { ...pr87run, id: 3, run_number: 12, head_sha: HEAD },
    ], { prNumber: 87, pr: forkPr, headIsUnique: true });
    expect(run && run.id).toBe(3);
  });

  it('uses the single unattributed run only when the head SHA is unique among open PRs', () => {
    const bare = {
      id: 6,
      event: 'pull_request',
      path: `.github/workflows/${CI_WORKFLOW_FILE}`,
      created_at: '2026-10-16T00:04:00Z',
      run_number: 14,
      head_sha: HEAD,
      pull_requests: [],
    };
    expect(selectCiRun([bare], { prNumber: 87, pr: forkPr, headIsUnique: true })?.id).toBe(6);
    expect(selectCiRun([bare], { prNumber: 87, pr: forkPr, headIsUnique: false })).toBeNull();
    expect(selectCiRun([bare, { ...bare, id: 7, run_number: 15 }], {
      prNumber: 87, pr: forkPr, headIsUnique: true,
    })).toBeNull();
  });

  it('fails closed when several open PRs share a SHA and the unattributed run is ambiguous', () => {
    const otherFork = {
      ...forkPr,
      number: 91,
      head: { ...forkPr.head, repo: { full_name: 'other/agent-wallet-sdk' } },
    };
    expect(countOpenHeadsWithSha([forkPr, otherFork], HEAD)).toBe(2);
    expect(selectCiRun([
      forkRun,
      { ...forkRun, id: 8, head_repository: { full_name: 'other/agent-wallet-sdk' } },
    ], { prNumber: 87, pr: { number: 87, head: { sha: HEAD } }, headIsUnique: false })).toBeNull();
  });

  it('disambiguates shared-SHA fork PRs by head repo + branch', () => {
    const other = {
      ...forkRun,
      id: 8,
      head_repository: { full_name: 'other/agent-wallet-sdk' },
      head_branch: 'cloud/review-gate-ci-job-6adb',
    };
    expect(selectCiRun([forkRun, other], {
      prNumber: 87, pr: forkPr, headIsUnique: false,
    })?.id).toBe(4);
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

    expect(GITHUB_RERUN_CEILING).toBe(50);
    expect(rerunPlan(run, green, {
      eventName: 'schedule',
      nowMs: completed + 1000,
      lastJobCompletedMs: completed,
    })).toBe('rerun');
    expect(rerunPlan(run, green, {
      eventName: 'schedule',
      verdict: { conclusion: 'success' },
    })).toBe('skip-unchanged');
    expect(rerunPlan(run, red, {
      eventName: 'schedule',
      verdict: { conclusion: 'failure' },
    })).toBe('skip-unchanged');
    expect(rerunPlan(run, green, {
      eventName: 'schedule',
      verdict: { conclusion: 'failure' },
    })).toBe('rerun');
    expect(rerunPlan(run, red, {
      eventName: 'schedule',
      nowMs: completed + 1000,
      lastJobCompletedMs: completed,
    })).toBe('backoff');
    expect(rerunPlan(run, red, {
      eventName: 'schedule',
      nowMs: completed + scheduleBackoffMs(2) + 1,
      lastJobCompletedMs: completed,
    })).toBe('rerun');
    expect(rerunPlan({ ...run, run_attempt: 8 }, red, { eventName: 'issue_comment' })).toBe('rerun');
    expect(rerunPlan({ ...run, run_attempt: 8 }, red, { eventName: 'pull_request_target' })).toBe('rerun');
    expect(rerunPlan({ ...run, run_attempt: 8 }, red, { eventName: 'workflow_dispatch' })).toBe('rerun');
    expect(scheduleCapsWaitingGate({ ...run, run_attempt: 8 }, red)).toBe(true);
    expect(scheduleCapsWaitingGate({ ...run, run_attempt: 8 }, green)).toBe(false);
    expect(rerunPlan({ ...run, run_attempt: 8 }, red, { eventName: 'schedule' })).toBe('capped');
    expect(rerunPlan({ ...run, run_attempt: 8 }, green, { eventName: 'schedule' })).toBe('rerun');
    expect(rerunPlan({ ...run, run_attempt: 8 }, green, {
      eventName: 'schedule',
      verdict: { conclusion: 'failure' },
    })).toBe('rerun');
    expect(refreshAction({
      job: green,
      eventName: 'schedule',
      runAttempt: 2,
    })).toBe('rerun');
    expect(refreshAction({
      job: green,
      eventName: 'schedule',
      runAttempt: GITHUB_RERUN_CEILING - 5,
    })).toBe('ceiling-fail');
    expect(refreshAction({
      job: green,
      verdict: { conclusion: 'failure' },
      eventName: 'schedule',
      runAttempt: GITHUB_RERUN_CEILING - 5,
    })).toBe('ceiling-fail');
    expect(rerunPlan({ ...run, run_attempt: 8 }, red, {
      eventName: 'issue_comment',
      verdict: { conclusion: 'failure' },
    })).toBe('skip-unchanged');
  });

  it('refreshes only on trusted Codex comments, waiver labels, and base retargets', () => {
    const codexComment = {
      name: 'issue_comment',
      action: 'edited',
      issue: { pull_request: {} },
      comment: { user: CODEX_BOT },
    };
    expect(isTrustedRefreshComment(codexComment)).toBe(true);
    expect(shouldRefreshOnEvent(codexComment)).toBe(true);
    expect(shouldRefreshOnEvent({ ...codexComment, action: 'created' })).toBe(true);
    expect(shouldRefreshOnEvent({ ...codexComment, action: 'deleted' })).toBe(true);

    expect(shouldRefreshOnEvent({
      name: 'issue_comment',
      action: 'created',
      issue: { pull_request: {} },
      comment: { user: { login: 'contributor', type: 'User' } },
    })).toBe(false);
    expect(shouldRefreshOnEvent({
      name: 'issue_comment',
      action: 'edited',
      issue: { pull_request: {} },
      comment: { user: GHA_BOT },
    })).toBe(false);
    expect(isTrustedRefreshComment({
      name: 'issue_comment',
      action: 'created',
      issue: {},
      comment: { user: CODEX_BOT },
    })).toBe(false);

    expect(isTrustedPullRequestRefreshEvent({
      name: 'pull_request_target',
      action: 'labeled',
      label: { name: WAIVE_LABEL },
      sender: { login: BILL },
    })).toBe(true);
    expect(isTrustedPullRequestRefreshEvent({
      name: 'pull_request_target',
      action: 'labeled',
      label: { name: WAIVE_LABEL },
      sender: { login: 'contributor' },
    })).toBe(false);
    expect(isTrustedPullRequestRefreshEvent({
      name: 'pull_request_target',
      action: 'unlabeled',
      label: { name: WAIVE_LABEL },
    })).toBe(true);
    expect(isTrustedPullRequestRefreshEvent({
      name: 'pull_request_target',
      action: 'ready_for_review',
    })).toBe(true);
    expect(isTrustedPullRequestRefreshEvent({
      name: 'pull_request_target',
      action: 'reopened',
    })).toBe(true);
    expect(isTrustedPullRequestRefreshEvent({
      name: 'pull_request_target',
      action: 'edited',
      changes: { base: { ref: { from: 'develop' } } },
    })).toBe(true);
    expect(shouldRefreshOnEvent({
      name: 'pull_request_target',
      action: 'edited',
      changes: { title: { from: 'old' } },
    })).toBe(false);
    expect(shouldRefreshOnEvent({
      name: 'pull_request_target',
      action: 'labeled',
      label: { name: 'junk' },
    })).toBe(false);
    expect(shouldRefreshOnEvent({ name: 'schedule' })).toBe(true);
    expect(shouldRefreshOnEvent({ name: 'workflow_dispatch' })).toBe(true);
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
    expect(ci).toMatch(/types:\s*\[opened, synchronize, reopened, edited, ready_for_review\]/);
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
    expect(job).toContain('actions: read');
    expect(job).toContain('checks: read');
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
    expect(refresh).toContain('checks: read');
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

  it('matches the CI run to the PR number, caps reruns, and records an unforgeable waiver', () => {
    expect(refresh).toContain('runMatchesPr');
    expect(refresh).toContain('runMatchesUnattributedHead');
    expect(refresh).toContain('headIsUnique');
    expect(refresh).toContain('head_repository');
    expect(refresh).toContain('pull_requests');
    expect(refresh).toContain('MAX_RUN_ATTEMPTS');
    expect(refresh).toContain('refreshAction');
    expect(refresh).toContain('skip-unchanged');
    expect(refresh).toContain('ceiling-fail');
    expect(refresh).toContain('GITHUB_RERUN_CEILING');
    expect(refresh).toContain("job.conclusion === 'success'");
    expect(refresh).toContain('core.setFailed');
    expect(refresh).toContain('evaluatePrNumber');
    expect(refresh).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(refresh).toContain('octokit: github');
    expect(refresh).toContain('attempt >= MAX_RUN_ATTEMPTS');
    expect(refresh).toContain('scheduleBackoffMs');
    expect(refresh).toContain('recordTrustedWaivers');
    expect(refresh).toMatch(/^ {2}record-waiver:/m);
    expect(refresh).toContain(WAIVER_RECORD_JOB);
    expect(refresh).toContain('context.runId');
    expect(refresh).toContain("if (current === 'success') return 'rerun'");
    expect(refresh).toContain("job.conclusion !== 'success'");
    expect(refresh).toContain('not treating an existing green gate as unchanged');
    expect(refreshExec).not.toMatch(/schedule skip \(success\)/);
    expect(refresh).not.toMatch(/if \(!next\) \{[\s\S]*?if \(current === 'success'\) return 'skip-unchanged'/);
  });

  it('filters refresh to trusted Codex / waiver evidence and does not cancel on junk events', () => {
    expect(refresh).toContain('needs: [record-waiver]');
    expect(refresh).toContain('chatgpt-codex-connector[bot]');
    expect(refresh).toContain("github.event.label.name == 'codex-waived'");
    expect(refresh).toContain("github.event.sender.login == 'up2itnow0822'");
    expect(refresh).toContain('github.event.changes.base != null');
    expect(refresh).toContain('cancel-in-progress: false');
    expect(refresh).toMatch(/github\.event\.action == 'ready_for_review'/);
    expect(refresh).toMatch(/github\.event\.action == 'reopened'/);
    expect(refresh).not.toMatch(
      /issue_comment' && github\.event\.issue\.pull_request != null\)\s*$/m,
    );
    expect(refresh).not.toContain("github.event.comment.user.login == 'github-actions[bot]'");
  });

  it('records waivers on schedule and dispatch, not only pull_request_target', () => {
    const recordBlock = (() => {
      const rest = refresh.split(/^ {2}record-waiver:/m)[1] || '';
      const next = rest.search(/^ {2}[A-Za-z0-9_-]+:/m);
      return next === -1 ? rest : rest.slice(0, next);
    })();
    expect(recordBlock).toContain("github.event_name == 'schedule'");
    expect(recordBlock).toContain("github.event_name == 'workflow_dispatch'");
    expect(recordBlock).toContain("github.event_name == 'pull_request_target'");
    expect(recordBlock).toContain("github.event.sender.login == 'up2itnow0822'");
    expect(recordBlock).toContain('recordTrustedWaivers');
    expect(recordBlock).toContain('contents/scripts/review-gate.mjs');
    expect(recordBlock).toContain('context.sha');
    expect(recordBlock).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(recordBlock).toContain('github-token: ${{ secrets.GITHUB_TOKEN }}');
    expect(recordBlock).toContain('octokit: github');
    expect(recordBlock).toContain('review-gate-waiver-receipt');
    expect(recordBlock).toContain('core.notice');
    expect(recordBlock).toContain("file: '.github/workflows/review-gate.yml'");
    expect(recordBlock).not.toContain('issue_comment');
    expect(contributing).toContain('schedule');
    expect(contributing).toContain('workflow_dispatch');
    expect(contributing).toContain('committed.created_at');
    const agents = readFileSync(resolve(process.cwd(), 'AGENTS.md'), 'utf8');
    expect(agents).toMatch(/2 November 2026/);
    expect(agents).toContain('committed.created_at');
    const gate = readFileSync(resolve(process.cwd(), 'scripts/review-gate.mjs'), 'utf8');
    expect(gate).not.toMatch(/event === 'committed'[\s\S]{0,80}&& e\.created_at/);
    expect(gate).toContain('headMovedAfterWaiver');
    expect(gate).toContain('evidenceMentionsNonHeadSha');
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

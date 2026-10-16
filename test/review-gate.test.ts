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
  MENTIONED_SHA,
  NO_MAJOR_ISSUES,
  SUMMARY_MARKER,
  WAIVE_LABEL,
  commentAcceptsCleanHead,
  combineHeadVerdicts,
  evaluatePr,
  fullSha,
  isCleanNoMajorIssuesBody,
  isCodexUser,
  isRetryableGithubStatus,
  isWaiverBoundToCurrentHead,
  mentionedShas,
  mentionsNonHeadSha,
  retryDelayMs,
  rerunPlan,
  selectCiRun,
  selectReviewGateJob,
  shaPrefixMatches,
  shouldRerunOnSchedule,
  summaryMarksHeadCompleted,
  timelineFacts,
  withRetry,
} from '../scripts/review-gate.mjs';

const HEAD = '982551f44942104308231bb10d5b56513c9c7050';
const OLDER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BILL = 'up2itnow0822';

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
    ...over,
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
      { headSha: HEAD, baseChangedMs: Date.parse('2026-10-15T22:00:00Z') },
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

  it('accepts a review commit_id that is a 7+ prefix of the head', () => {
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

describe('evaluatePr — Bill-only waiver on current head', () => {
  const labeled = {
    event: 'labeled',
    label: { name: WAIVE_LABEL },
    actor: { login: BILL },
    created_at: '2026-10-15T22:00:00Z',
  };

  it('passes when Bill labeled after the last head move and base change', () => {
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      timeline: [
        { event: 'committed', created_at: '2026-10-15T21:00:00Z' },
        labeled,
      ],
    }));
    expect(verdict.conclusion).toBe('success');
    expect(verdict.title).toBe('Codex waived');
  });

  it('rejects a waiver after a later push to a new head', () => {
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      timeline: [
        labeled,
        { event: 'committed', created_at: '2026-10-15T22:05:00Z' },
      ],
    }));
    expect(verdict.conclusion).toBe('failure');
    expect(verdict.title).not.toBe('Codex waived');
  });

  it('rejects a waiver after a force-push', () => {
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      timeline: [
        labeled,
        { event: 'head_ref_force_pushed', created_at: '2026-10-15T22:05:00Z' },
      ],
    }));
    expect(isWaiverBoundToCurrentHead({
      labels: [WAIVE_LABEL],
      ...timelineFacts([labeled, { event: 'head_ref_force_pushed', created_at: '2026-10-15T22:05:00Z' }]),
    })).toBe(false);
    expect(verdict.conclusion).toBe('failure');
  });

  it('rejects a waiver applied before the last base retarget', () => {
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      timeline: [
        labeled,
        { event: 'base_ref_changed', created_at: '2026-10-15T22:10:00Z' },
      ],
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('rejects a waiver labeled by anyone other than Bill', () => {
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      timeline: [{
        event: 'labeled',
        label: { name: WAIVE_LABEL },
        actor: { login: 'cursor[bot]' },
        created_at: '2026-10-15T22:00:00Z',
      }],
    }));
    expect(verdict.conclusion).toBe('failure');
  });

  it('rejects an unlabeled leftover', () => {
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [] }),
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
    const verdict = evaluatePr(snapshot({
      pr: pr({ labels: [{ name: WAIVE_LABEL }] }),
      event: {
        name: 'pull_request',
        action: 'labeled',
        sender: { login: BILL },
        label: { name: WAIVE_LABEL },
        pull_request: { number: 87, head: { sha: HEAD }, base: { ref: 'main' } },
      },
    }));
    expect(verdict.conclusion).toBe('success');
    expect(verdict.title).toBe('Codex waived');
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

describe('refresh selects the counted CI job', () => {
  it('picks the latest pull_request CI run, not a pull_request_target suite', () => {
    const run = selectCiRun([
      { id: 1, event: 'pull_request_target', path: '.github/workflows/review-gate.yml', created_at: '2026-10-16T00:00:00Z', run_number: 10 },
      { id: 2, event: 'pull_request', path: `.github/workflows/${CI_WORKFLOW_FILE}`, created_at: '2026-10-16T00:01:00Z', run_number: 11 },
      { id: 3, event: 'pull_request', path: `.github/workflows/${CI_WORKFLOW_FILE}`, created_at: '2026-10-16T00:02:00Z', run_number: 12 },
    ]);
    expect(run && run.id).toBe(3);
  });

  it('selects the job named exactly review-gate', () => {
    const job = selectReviewGateJob([
      { id: 10, name: 'verify' },
      { id: 11, name: CHECK_JOB_NAME },
      { id: 12, name: 'refresh' },
    ]);
    expect(job && job.id).toBe(11);
  });

  it('reruns on schedule only when the counted job is not already green', () => {
    expect(shouldRerunOnSchedule({ conclusion: 'success', status: 'completed' })).toBe(false);
    expect(shouldRerunOnSchedule({ conclusion: 'failure', status: 'completed' })).toBe(true);
    expect(shouldRerunOnSchedule({ conclusion: 'cancelled', status: 'completed' })).toBe(true);
    expect(shouldRerunOnSchedule(null)).toBe(true);
    expect(shouldRerunOnSchedule({ conclusion: null, status: 'in_progress' })).toBe(false);
  });

  it('waits for an in-progress CI run on Codex events, and skips that wait on schedule', () => {
    const run = { id: 3, status: 'in_progress' };
    const job = { id: 11, name: CHECK_JOB_NAME, status: 'in_progress' };
    expect(rerunPlan(run, job, { eventName: 'issue_comment' })).toBe('wait-run');
    expect(rerunPlan(run, job, { eventName: 'pull_request_review' })).toBe('wait-run');
    expect(rerunPlan(run, job, { eventName: 'schedule' })).toBe('skip-in-progress');
    expect(rerunPlan({ id: 3, status: 'completed' }, {
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

describe('workflows pin the counted context and never orphan checks.create', () => {
  const ci = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  const refresh = readFileSync(resolve(process.cwd(), '.github/workflows/review-gate.yml'), 'utf8');
  const ciExec = executableYaml(ci);
  const refreshExec = executableYaml(refresh);

  it('defines a pull_request CI job named exactly review-gate', () => {
    expect(ci).toMatch(/^ {2}review-gate:/m);
    expect(ci).toMatch(/name:\s*review-gate/);
    expect(ci).toContain('scripts/review-gate.mjs evaluate');
    expect(ciExec).not.toContain('checks.create');
    expect(ciExec).not.toContain('Evaluating Codex review');
  });

  it('keeps evaluation read-only and does not install or run PR package code', () => {
    const gateBlock = ci.split(/^ {2}review-gate:/m)[1] || '';
    const nextJob = gateBlock.search(/^ {2}[A-Za-z0-9_-]+:/m);
    const job = nextJob === -1 ? gateBlock : gateBlock.slice(0, nextJob);
    expect(job).toContain('pull-requests: read');
    expect(job).toContain('issues: read');
    expect(job).not.toContain('npm ci');
    expect(job).not.toContain('npm install');
    expect(job).not.toContain('npm test');
    expect(job).not.toContain('checks: write');
  });

  it('refreshes by rerunning that CI job and never calls checks.create', () => {
    expect(refresh).toContain('scripts/review-gate.mjs rerun');
    expect(refresh).toContain('actions: write');
    expect(refreshExec).not.toContain('checks: write');
    expect(refreshExec).not.toContain('checks.create');
    expect(refreshExec).not.toContain('Evaluating Codex review');
    expect(refresh).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(refresh).toContain('pull_request_target');
    expect(refresh).toContain('issue_comment');
    expect(refresh).toContain('pull_request_review');
    expect(refresh).not.toMatch(/^ {2}review-gate:/m);
  });

  it('keeps the #88 matcher constants in the evaluated script, not inlined into checks.create', () => {
    expect(COMPLETED_ROW.source).toContain('{7,40}');
    expect(MENTIONED_SHA.source).toContain('{7,40}');
    expect(NO_MAJOR_ISSUES.source).toMatch(/major issues/i);
    expect(SUMMARY_MARKER).toContain('codex-pull-request-review-summary');
    expect(refresh).not.toContain('headPushedMs');
  });
});

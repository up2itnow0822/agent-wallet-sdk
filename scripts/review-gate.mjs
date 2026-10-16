/**
 * review-gate evaluation and refresh.
 *
 * The required GitHub Actions check named `review-gate` is the CI job in
 * `.github/workflows/ci.yml`. That job fetches THIS file from the PR's
 * base SHA (main), not from the PR checkout, so a PR cannot rewrite the
 * evaluator it is judged by. The job itself still lives in the PR's
 * ci.yml — see CONTRIBUTING.md for that residual risk and the ruleset
 * write-up for Bill.
 *
 * The pull_request_target / issue_comment / schedule workflow reruns the
 * CI job; it never calls checks.create. pull_request_review is omitted
 * because GitHub would run the PR's copy of that workflow with
 * actions: write. Refresh starts only on trusted evidence (Codex bot
 * comments, Bill's waiver label, base retarget, ready/reopen, schedule,
 * dispatch) so authors cannot burn GitHub's 50-rerun cap. Schedule never
 * reruns a check whose conclusion would not change, so green polling
 * cannot exhaust the 50-rerun ceiling. A 403 on a green gate fails the
 * refresh instead of being swallowed.
 *
 * Short-SHA Codex comments stay valid (PR #88) only when the prefix
 * uniquely resolves to the current 40-char head AND the comment's
 * created/updated time is after GitHub's push/event time for that head
 * (workflow-run / check-suite created_at — never the author-controlled
 * committer date).
 *
 * `codex-waived` binds to head SHA + base ref + base SHA + PR via a
 * github-actions[bot] comment that cites the review-gate-refresh
 * workflow run which wrote it. Evaluate fetches that run and requires
 * path `.github/workflows/review-gate.yml`, event `pull_request_target`
 * or `schedule` or `workflow_dispatch` (always main's copy), and a
 * successful `record-waiver` job — a job only that trusted workflow
 * defines. Recording does not depend on `pull_request_target` remaining
 * allowed after 2 November 2026: schedule (every 10 minutes) and
 * workflow_dispatch scan the label timeline from the default-branch
 * copy. Bill must be the latest `codex-waived` `labeled` actor after
 * this head's workflow-run / check-suite arrival and after the last
 * `committed` / force-push timeline event (order, not
 * `committed.created_at`, which does not exist). The comment is
 * written by that trusted run. `workflow_dispatch` is accepted only
 * when `run.head_branch` is the repository default branch (`gh
 * workflow run --ref` of a feature branch is rejected). Schedule and
 * dispatch comments must appear in that job's waiver-receipt
 * annotation (not merely in the run's wall-clock window).
 * `pull_request_target` stays a faster path until GitHub blocks it by
 * default. `issue_comment` never records a waiver.
 * The latest waiver-label timeline event must also be an allow-listed
 * `labeled` event for that same actor, and the persisted record must
 * belong to that labeling (comment at or after the event). Re-applying
 * the label after a revoke, without a new Bill record, does not
 * resurrect the old waiver. A PR-controlled workflow (including
 * security-review.yml) can post as the same bot but cannot mint that
 * run identity. A Codex review counts only when it is a clean
 * no-findings result, never merely because a review exists.
 * A dismissed Codex review is ordered by the timeline
 * `review_dismissed.created_at`, not the review's original
 * `submitted_at`. Missing dismissal time fails closed (sorts last).
 * Refresh never treats a green counted gate as unchanged when
 * reevaluation cannot produce a verdict — it reruns or ceiling-fails.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CHECK_JOB_NAME = 'review-gate';
export const CI_WORKFLOW_FILE = 'ci.yml';
export const WAIVE_LABEL = 'codex-waived';
export const WAIVER_ACTORS = new Set(['up2itnow0822']);
export const CODEX_LOGINS = new Set([
  'chatgpt-codex-connector',
  'chatgpt-codex-connector[bot]',
]);
export const GITHUB_ACTIONS_LOGINS = new Set([
  'github-actions[bot]',
  'github-actions',
]);

export const SUMMARY_MARKER = '<!-- codex-pull-request-review-summary -->';
export const COMPLETED_ROW =
  /^\|[^|\n]*\bCode Review\b[^|\n]*\|[^|\n]*\bCompleted\b[^|\n]*\|\s*`([0-9a-fA-F]{7,40})`\s*\|/gm;
export const MENTIONED_SHA =
  /`([0-9a-fA-F]{7,40})`|"commit_sha"\s*:\s*"([0-9a-fA-F]{7,40})"/g;
export const NO_MAJOR_ISSUES = /didn't find any major issues/i;
export const STATE_COMMENT = /<!--\s*codex-review-state:v1\s+(\{.*?\})\s*-->/;
export const WAIVER_MARKER = '<!-- review-gate-waiver:v1';
export const WAIVER_RECORD_RE = /<!--\s*review-gate-waiver:v1\s+(\{.*?\})\s*-->/;
export const REFRESH_WORKFLOW_PATH = '.github/workflows/review-gate.yml';
export const WAIVER_RECORD_JOB = 'record-waiver';
export const WAIVER_RECEIPT_TITLE = 'review-gate-waiver-receipt';
export const WAIVER_RECEIPT_MARKER = 'review-gate-waiver-receipt:v1';
export const MAX_PREFIX_RESOLVES = 20;
export const TRUSTED_WAIVER_RECORD_EVENTS = new Set([
  'pull_request_target',
  'schedule',
  'workflow_dispatch',
]);

// Well under GitHub's 50-rerun-per-run cap. A new push opens a new run.
export const MAX_RUN_ATTEMPTS = 8;
export const GITHUB_RERUN_CEILING = 50;
export const RERUN_CEILING_RESERVE = 5;
export const SCHEDULE_INTERVAL_MS = 10 * 60 * 1000;
export const RECEIPT_MARKER = '<!-- codex-review-receipt:v1 -->';

export function isCodexLogin(login) {
  return !!login && CODEX_LOGINS.has(login);
}

export function isCodexUser(user) {
  return !!user && user.type === 'Bot' && isCodexLogin(user.login);
}

export function isGithubActionsBot(user) {
  return !!user && user.type === 'Bot' && GITHUB_ACTIONS_LOGINS.has(user.login);
}

export function fullSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
    ? value.toLowerCase()
    : '';
}

export function sameSha(left, right) {
  const a = fullSha(left);
  const b = fullSha(right);
  return a !== '' && a === b;
}

// Prefixes are compared to the current 40-char head only.
// Never resolve an abbreviation to some other commit.
export function shaPrefixMatches(shown, headSha) {
  const prefix = typeof shown === 'string' && /^[0-9a-f]{7,40}$/i.test(shown)
    ? shown.toLowerCase()
    : '';
  const head = fullSha(headSha);
  return prefix !== '' && head !== '' && head.startsWith(prefix);
}

/**
 * Short SHA is accepted only when it prefixes the current head AND the
 * caller proved GitHub uniquely resolves that prefix to this head
 * (GET /commits/{prefix} returns this SHA; 422 ambiguous → reject).
 * A 40-char exact match is unique by identity and does not need the API.
 */
export function prefixUniquelyMatchesHead(shown, headSha, uniqueResolve) {
  if (!shaPrefixMatches(shown, headSha)) return false;
  const prefix = String(shown).toLowerCase();
  if (prefix.length === 40) return true;
  if (typeof uniqueResolve === 'function') return !!uniqueResolve(prefix, headSha);
  return false;
}

export function mentionedShas(body) {
  const found = [];
  const text = body || '';
  const re = new RegExp(MENTIONED_SHA.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push((m[1] || m[2]).toLowerCase());
  }
  return found;
}

export function mentionsNonHeadSha(body, headSha) {
  return mentionedShas(body).some(s => !shaPrefixMatches(s, headSha));
}

export function isCodexSummaryBody(body) {
  return typeof body === 'string' && body.includes(SUMMARY_MARKER);
}

/**
 * SHAs that belong to the Code Review being evaluated. Shared Codex
 * summaries also carry `security_review.commit_sha` and a Security
 * Review table row that update independently; those must not
 * disqualify a clean current-head Code Review.
 */
export function codeReviewMentionedShas(body) {
  const found = [];
  const cr = codeReviewState(body);
  if (cr && typeof cr.commit_sha === 'string' && /^[0-9a-f]{7,40}$/i.test(cr.commit_sha)) {
    found.push(cr.commit_sha.toLowerCase());
  }
  for (const line of String(body || '').split('\n')) {
    if (!/\bCode Review\b/.test(line) || /\bSecurity Review\b/.test(line)) continue;
    const re = /`([0-9a-fA-F]{7,40})`/g;
    let m;
    while ((m = re.exec(line)) !== null) found.push(m[1].toLowerCase());
  }
  return found;
}

export function evidenceMentionsNonHeadSha(body, headSha) {
  if (isCodexSummaryBody(body)) {
    return codeReviewMentionedShas(body).some(s => !shaPrefixMatches(s, headSha));
  }
  return mentionsNonHeadSha(body, headSha);
}

export function isCleanNoMajorIssuesBody(body) {
  return NO_MAJOR_ISSUES.test(body || '');
}

export function summaryTableMarksHeadCompleted(body, headSha) {
  const row = new RegExp(COMPLETED_ROW.source, 'gm');
  let m;
  while ((m = row.exec(body || '')) !== null) {
    if (shaPrefixMatches(m[1], headSha)) return true;
  }
  return false;
}

export function summaryStateMarksHeadCompleted(body, headSha) {
  const m = STATE_COMMENT.exec(body || '');
  if (!m) return false;
  try {
    const state = JSON.parse(m[1]);
    const cr = state && state.code_review;
    if (!cr || String(cr.status).toLowerCase() !== 'completed') return false;
    return shaPrefixMatches(cr.commit_sha, headSha);
  } catch {
    return false;
  }
}

export function summaryMarksHeadCompleted(body, headSha) {
  const text = body || '';
  if (!text.includes(SUMMARY_MARKER)) return false;
  return summaryTableMarksHeadCompleted(text, headSha) ||
    summaryStateMarksHeadCompleted(text, headSha);
}

function summaryCompletedPrefixIsUnique(body, headSha, uniqueResolve) {
  const row = new RegExp(COMPLETED_ROW.source, 'gm');
  let m;
  while ((m = row.exec(body || '')) !== null) {
    if (prefixUniquelyMatchesHead(m[1], headSha, uniqueResolve)) return true;
  }
  const state = STATE_COMMENT.exec(body || '');
  if (!state) return false;
  try {
    const cr = JSON.parse(state[1]).code_review;
    if (!cr || String(cr.status).toLowerCase() !== 'completed') return false;
    return prefixUniquelyMatchesHead(cr.commit_sha, headSha, uniqueResolve);
  } catch {
    return false;
  }
}

/**
 * Earliest GitHub-recorded time this SHA appeared as a pull_request head.
 * Uses workflow-run and check-suite created_at (platform event time after
 * the push). Never uses commit.committer.date — authors control that.
 */
export function headPushedMsFromEvidence({ workflowRuns, checkSuites } = {}) {
  const times = [];
  for (const r of workflowRuns || []) {
    if (r && r.created_at) times.push(Date.parse(r.created_at));
  }
  for (const s of checkSuites || []) {
    if (s && s.created_at) times.push(Date.parse(s.created_at));
  }
  const valid = times.filter(Number.isFinite);
  if (valid.length === 0) return undefined;
  return Math.min(...valid);
}

export function evidenceAfterHeadPush(eventMs, headPushedMs, { fullExact = false } = {}) {
  if (!Number.isFinite(eventMs)) return false;
  if (headPushedMs == null || !Number.isFinite(Number(headPushedMs))) {
    return !!fullExact;
  }
  return eventMs > Number(headPushedMs);
}

/**
 * A Codex issue comment or review-summary body counts as a clean head
 * review when the Code Review evidence (not a leftover Security Review
 * SHA in the same summary) names this head and either:
 *   - the summary marks Code Review Completed on a unique head-SHA prefix, or
 *   - the body is a "no major issues" receipt that names a unique head-SHA prefix.
 * The comment must be created/updated after GitHub's push/event time for
 * this head. SHA-less receipts never count.
 */
/**
 * Code Review row timestamp from the summary table, not the comment's
 * overall updated_at (Codex bumps that when a later security review
 * rewrites the same summary).
 */
export function codeReviewCompletedAtMs(body, headSha) {
  const re = /^\|[^|\n]*\bCode Review\b[^|\n]*\|[^|\n]*\bCompleted\b[^|\n]*datetime="([^"]+)"[^|\n]*\|\s*`([0-9a-fA-F]{7,40})`\s*\|/gm;
  let latest;
  let m;
  while ((m = re.exec(body || '')) !== null) {
    if (!shaPrefixMatches(m[2], headSha)) continue;
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t)) continue;
    latest = latest == null ? t : Math.max(latest, t);
  }
  return latest;
}

export function commentEvidenceMs(comment, ctx) {
  const body = (comment && comment.body) || '';
  const headSha = (ctx && ctx.headSha) || '';
  if (body.includes(SUMMARY_MARKER)) {
    const rowMs = codeReviewCompletedAtMs(body, headSha);
    return rowMs == null ? NaN : rowMs;
  }
  return Date.parse((comment && comment.created_at) || 0);
}

export function commentAcceptsCleanHead(comment, ctx) {
  const body = (comment && comment.body) || '';
  const eventMs = commentEvidenceMs(comment, ctx);
  const baseChangedMs = Number(ctx && ctx.baseChangedMs) || 0;
  const headSha = (ctx && ctx.headSha) || '';
  const headPushedMs = ctx && ctx.headPushedMs;
  const uniqueResolve = ctx && ctx.uniqueResolve;

  if (!(eventMs > baseChangedMs)) return false;
  if (!evidenceAfterHeadPush(eventMs, headPushedMs)) return false;
  if (evidenceMentionsNonHeadSha(body, headSha)) return false;
  if (summaryMarksCleanHeadCompleted(body, headSha)) {
    return summaryCompletedPrefixIsUnique(body, headSha, uniqueResolve);
  }
  if (isCleanNoMajorIssuesBody(body)) {
    return mentionedShas(body).some(s => prefixUniquelyMatchesHead(s, headSha, uniqueResolve));
  }
  return false;
}

export function codeReviewState(body) {
  const m = STATE_COMMENT.exec(body || '');
  if (!m) return null;
  try {
    return JSON.parse(m[1]).code_review || null;
  } catch {
    return null;
  }
}

/**
 * Completed-on-head is not enough: Codex marks the table Completed even
 * when it filed P1s. Require the state to say no findings.
 */
export function summaryMarksCleanHeadCompleted(body, headSha) {
  if (!summaryMarksHeadCompleted(body, headSha)) return false;
  const cr = codeReviewState(body);
  if (!cr) return false;
  if (cr.has_any_findings === true || cr.has_unresolved_findings === true) return false;
  if (cr.has_any_findings !== false) return false;
  return String(cr.status).toLowerCase() === 'completed';
}

/**
 * GitHub may return `path` as `.github/workflows/review-gate.yml@main`.
 * Only strip a trailing `@ref` after `.yml` / `.yaml`.
 */
export function workflowPathWithoutRef(path) {
  const raw = typeof path === 'string' ? path.trim() : '';
  if (!raw) return '';
  const m = raw.match(/^(.*\.ya?ml)@([A-Za-z0-9._/-]+)$/);
  if (!m) return raw;
  const ref = m[2];
  if (!ref || ref.includes('..') || ref.startsWith('/') || ref.endsWith('/')) return raw;
  return m[1];
}

export function isRefreshWorkflowPath(path) {
  const normalized = workflowPathWithoutRef(path);
  return normalized === REFRESH_WORKFLOW_PATH ||
    normalized === 'review-gate.yml' ||
    normalized.endsWith('/review-gate.yml');
}

export function waiverRunIsDefaultBranchRevision(run, defaultBranch) {
  const branch = typeof (run && run.head_branch) === 'string' ? run.head_branch : '';
  const trusted = typeof defaultBranch === 'string' ? defaultBranch : '';
  if ((run && run.event) === 'workflow_dispatch') {
    return !!trusted && branch === trusted;
  }
  if ((run && run.event) === 'schedule' && branch) {
    return !!trusted && branch === trusted;
  }
  return true;
}

export function checkRunIdFromJob(job) {
  const url = job && job.check_run_url;
  if (typeof url === 'string') {
    const m = url.match(/\/check-runs\/(\d+)\s*$/);
    if (m) return Number(m[1]);
  }
  const id = Number(job && job.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function parseWaiverReceipts(annotations) {
  const receipts = [];
  for (const a of annotations || []) {
    const title = (a && a.title) || '';
    const message = (a && a.message) || '';
    if (title !== WAIVER_RECEIPT_TITLE && !message.includes(WAIVER_RECEIPT_MARKER)) continue;
    try {
      const parsed = JSON.parse(message);
      const list = Array.isArray(parsed && parsed.receipts)
        ? parsed.receipts
        : (parsed && parsed.commentId ? [parsed] : []);
      for (const r of list) {
        const commentId = Number(r && r.commentId);
        const run = Number(r && r.run);
        const sha = fullSha(r && r.sha);
        const baseSha = fullSha(r && r.baseSha);
        const pr = Number(r && r.pr);
        if (!Number.isFinite(commentId) || commentId <= 0) continue;
        if (!Number.isFinite(run) || run <= 0 || !sha || !baseSha) continue;
        if (!Number.isFinite(pr) || pr <= 0) continue;
        receipts.push({ commentId, run, sha, baseSha, pr });
      }
    } catch {
      // ignore non-JSON notices
    }
  }
  return receipts;
}

export function waiverReceiptAcceptsComment(receipts, comment, {
  prNumber,
  headSha,
  baseSha,
  runId,
} = {}) {
  const commentId = Number(comment && comment.id);
  if (!Number.isFinite(commentId) || commentId <= 0) return false;
  return (receipts || []).some(r =>
    Number(r.commentId) === commentId &&
    Number(r.run) === Number(runId) &&
    (prNumber == null || Number(r.pr) === Number(prNumber)) &&
    (!headSha || sameSha(r.sha, headSha)) &&
    (!baseSha || sameSha(r.baseSha, baseSha)),
  );
}

export function waiverRunProvenanceAccepts(run, jobs, {
  prNumber,
  headSha,
  baseRef,
  baseSha,
  commentCreatedMs,
  defaultBranch,
  receipts,
  commentId,
} = {}) {
  if (!run || !isRefreshWorkflowPath(run.path)) return false;
  if (!TRUSTED_WAIVER_RECORD_EVENTS.has(run.event)) return false;
  if (run.status && run.status !== 'completed') return false;
  if (run.conclusion && run.conclusion !== 'success') return false;
  if (!waiverRunIsDefaultBranchRevision(run, defaultBranch)) return false;
  const job = (jobs || []).find(j => j.name === WAIVER_RECORD_JOB);
  if (!job || job.status !== 'completed' || job.conclusion !== 'success') return false;
  const prs = run.pull_requests || [];
  if (prs.length > 0) {
    const match = prs.find(p => prNumber == null || Number(p.number) === Number(prNumber));
    if (!match) return false;
    const runHead = fullSha(match.head && match.head.sha);
    const runBaseRef = match.base && match.base.ref;
    const runBaseSha = fullSha(match.base && match.base.sha);
    if (headSha && (!runHead || !sameSha(runHead, headSha))) return false;
    if (baseRef && runBaseRef && runBaseRef !== baseRef) return false;
    if (baseSha && runBaseSha && !sameSha(runBaseSha, baseSha)) return false;
  } else if (run.event === 'pull_request_target') {
    return false;
  } else if (run.event === 'schedule' || run.event === 'workflow_dispatch') {
    if (!waiverReceiptAcceptsComment(receipts, { id: commentId }, {
      prNumber,
      headSha,
      baseSha,
      runId: run.id,
    })) {
      return false;
    }
  }
  if (commentCreatedMs != null) {
    const start = Date.parse(run.created_at || 0);
    const end = Date.parse(run.updated_at || run.created_at || 0);
    if (!Number.isFinite(commentCreatedMs) || !Number.isFinite(start)) return false;
    const late = Number.isFinite(end) ? end + 60 * 1000 : start + 10 * 60 * 1000;
    if (commentCreatedMs < start || commentCreatedMs > late) return false;
  }
  return true;
}

export function formatWaiverComment({ sha, base, baseSha, actor, pr, run, workflow }) {
  const rec = {
    sha: fullSha(sha),
    base,
    baseSha: fullSha(baseSha),
    actor,
    pr: Number(pr),
    run: Number(run),
    workflow: workflow || REFRESH_WORKFLOW_PATH,
  };
  return `${WAIVER_MARKER} ${JSON.stringify(rec)} -->\n` +
    `review-gate: \`${WAIVE_LABEL}\` bound to head \`${rec.sha}\` base \`${rec.base}\` ` +
    `(\`${rec.baseSha}\`) by \`${actor}\` on PR #${rec.pr} via run ${rec.run}.`;
}

export function parseWaiverRecord(body) {
  const m = WAIVER_RECORD_RE.exec(body || '');
  if (!m) return null;
  try {
    const rec = JSON.parse(m[1]);
    const sha = fullSha(rec && rec.sha);
    const baseSha = fullSha(rec && rec.baseSha);
    const run = Number(rec && rec.run);
    const base = typeof (rec && rec.base) === 'string' ? rec.base : '';
    if (!sha || !baseSha || !base || !Number.isFinite(run) || run <= 0) return null;
    return {
      sha,
      base,
      baseSha,
      actor: rec.actor,
      pr: rec.pr,
      run,
      workflow: rec.workflow,
    };
  } catch {
    return null;
  }
}

export function waiverRecordAcceptsHead(comment, {
  headSha,
  prNumber,
  baseRef,
  baseSha,
  resolveWaiverRun,
} = {}) {
  if (!isGithubActionsBot(comment && comment.user)) return false;
  const rec = parseWaiverRecord(comment && comment.body);
  if (!rec) return false;
  if (!sameSha(rec.sha, headSha)) return false;
  if (!rec.base || rec.base !== baseRef) return false;
  if (baseSha && !sameSha(rec.baseSha, baseSha)) return false;
  if (prNumber != null && rec.pr != null && Number(rec.pr) !== Number(prNumber)) return false;
  if (rec.actor && !WAIVER_ACTORS.has(rec.actor)) return false;
  if (rec.workflow && !isRefreshWorkflowPath(rec.workflow)) return false;
  if (typeof resolveWaiverRun !== 'function') return false;
  const proven = resolveWaiverRun(rec.run);
  if (!proven || !proven.run) return false;
  if (Number(proven.run.id) !== Number(rec.run)) return false;
  return waiverRunProvenanceAccepts(proven.run, proven.jobs, {
    prNumber,
    headSha,
    baseRef,
    baseSha,
    commentCreatedMs: Date.parse((comment && comment.created_at) || 0),
    defaultBranch: proven.defaultBranch,
    receipts: proven.receipts,
    commentId: comment && comment.id,
  });
}

export function waiverActorLogin(event) {
  return (event && event.actor && event.actor.login) ||
    (event && event.sender && event.sender.login) ||
    '';
}

/**
 * Latest waiver-label timeline event must be an allow-listed `labeled`
 * event, and the persisted record must belong to that labeling (same
 * actor; comment created at or after the event). An old record left
 * after Bill removes the label cannot be resurrected by someone else
 * re-applying `codex-waived`.
 */
export function latestWaiverLabelAcceptsRecord(lastWaiverEvent, comment) {
  if (!lastWaiverEvent || lastWaiverEvent.event !== 'labeled') return false;
  const actor = waiverActorLogin(lastWaiverEvent);
  if (!WAIVER_ACTORS.has(actor)) return false;
  const rec = parseWaiverRecord(comment && comment.body);
  if (!rec || rec.actor !== actor) return false;
  const eventMs = Date.parse(lastWaiverEvent.created_at || 0);
  const commentMs = Date.parse((comment && comment.created_at) || 0);
  if (!Number.isFinite(eventMs) || !Number.isFinite(commentMs)) return false;
  return commentMs >= eventMs;
}

export function isWaiverBoundToCurrentHead({
  labels,
  comments,
  headSha,
  prNumber,
  baseRef,
  baseSha,
  resolveWaiverRun,
  lastWaiverEvent,
  headMovedAfterWaiver,
}) {
  if (!labels || !labels.includes(WAIVE_LABEL)) return false;
  if (headMovedAfterWaiver) return false;
  return (comments || []).some(c =>
    latestWaiverLabelAcceptsRecord(lastWaiverEvent, c) &&
    waiverRecordAcceptsHead(c, {
      headSha,
      prNumber,
      baseRef,
      baseSha,
      resolveWaiverRun,
    }),
  );
}

export function isRetryableGithubStatus(status) {
  return Number.isFinite(status) && status >= 500 && status <= 599;
}

export function retryDelayMs(attemptIndex) {
  return 1000 * (2 ** attemptIndex);
}

export async function withRetry(fn, opts = {}) {
  const retries = opts.retries == null ? 3 : opts.retries;
  const sleep = opts.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const retryable = opts.isRetryable || isRetryableGithubStatus;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err && (err.status != null ? err.status : err.statusCode);
      if (!retryable(status) || attempt === retries) throw err;
      await sleep(retryDelayMs(attempt));
    }
  }
  throw lastErr;
}

function isHeadMoveTimelineEvent(event) {
  return !!event && (event.event === 'committed' || event.event === 'head_ref_force_pushed');
}

/**
 * GitHub `committed` timeline events have no top-level `created_at`
 * (https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#committed).
 * Do not derive head-move time from that field. Ordinary pushes are
 * detected by timeline order (`headMovedAfterWaiver`) and by
 * workflow-run / check-suite `created_at` for the current head.
 */
export function timelineFacts(events) {
  let baseChangedMs = 0;
  let lastWaiverEvent = null;
  let lastWaiverIndex = -1;
  let lastHeadMoveIndex = -1;
  const list = events || [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.event === 'base_ref_changed' && e.created_at) {
      baseChangedMs = Math.max(baseChangedMs, Date.parse(e.created_at));
    }
    if ((e.event === 'labeled' || e.event === 'unlabeled') &&
        e.label && e.label.name === WAIVE_LABEL) {
      lastWaiverEvent = e;
      lastWaiverIndex = i;
    }
    if (isHeadMoveTimelineEvent(e)) {
      lastHeadMoveIndex = i;
    }
  }
  return {
    baseChangedMs,
    lastWaiverEvent,
    headMovedAfterWaiver: lastHeadMoveIndex > lastWaiverIndex,
  };
}

function reviewBodyIsClean(review, headSha, uniqueResolve) {
  const body = (review && review.body) || '';
  if (isCleanNoMajorIssuesBody(body)) {
    const named = mentionedShas(body);
    if (named.length === 0) {
      return prefixUniquelyMatchesHead(review.commit_id, headSha, uniqueResolve);
    }
    return named.some(s => prefixUniquelyMatchesHead(s, headSha, uniqueResolve));
  }
  if (summaryMarksCleanHeadCompleted(body, headSha)) {
    return summaryCompletedPrefixIsUnique(body, headSha, uniqueResolve);
  }
  return false;
}

export function dismissalMsByReviewId(timeline) {
  const map = new Map();
  for (const e of timeline || []) {
    if (!e || e.event !== 'review_dismissed') continue;
    const id = Number(
      (e.dismissed_review && e.dismissed_review.review_id) || e.review_id,
    );
    const ms = Date.parse(e.created_at || 0);
    if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(ms)) continue;
    const prev = map.get(id);
    if (prev == null || ms > prev) map.set(id, ms);
  }
  return map;
}

function dismissedReviewOutcomeMs(review, dismissalById) {
  const reviewId = Number(review && review.id);
  const fromTimeline = dismissalById && Number.isFinite(reviewId) && reviewId > 0
    ? dismissalById.get(reviewId)
    : undefined;
  return Number.isFinite(fromTimeline) ? fromTimeline : Number.POSITIVE_INFINITY;
}

function reviewCompletedHeadOutcome(
  review, headSha, uniqueResolve, headPushedMs, baseChangedMs, dismissalById,
) {
  if (!isCodexUser(review && review.user)) return null;
  if (!prefixUniquelyMatchesHead(review.commit_id, headSha, uniqueResolve)) return null;
  const submitted = Date.parse(review.submitted_at || 0);
  const exact = fullSha(review.commit_id) !== '' && sameSha(review.commit_id, headSha);
  const dismissed = String(review.state).toUpperCase() === 'DISMISSED';
  if (dismissed) {
    const ms = dismissedReviewOutcomeMs(review, dismissalById);
    return { ms, clean: false, dismissed: true, source: 'review' };
  }
  if (!evidenceAfterHeadPush(submitted, headPushedMs, { fullExact: exact })) return null;
  if (!(submitted > (baseChangedMs || 0))) return null;
  return {
    ms: submitted,
    clean: reviewBodyIsClean(review, headSha, uniqueResolve),
    dismissed: false,
    source: 'review',
  };
}

export function commentIsHeadFindingsReceipt(body, headSha, uniqueResolve) {
  const text = body || '';
  if (!text.includes('codex-review-receipt')) return false;
  if (isCleanNoMajorIssuesBody(text)) return false;
  if (mentionsNonHeadSha(text, headSha)) return false;
  return mentionedShas(text).some(s => prefixUniquelyMatchesHead(s, headSha, uniqueResolve));
}

export function commentCompletedHeadOutcome(comment, ctx) {
  if (!isCodexUser(comment && comment.user)) return null;
  const body = (comment && comment.body) || '';
  const headSha = (ctx && ctx.headSha) || '';
  const uniqueResolve = ctx && ctx.uniqueResolve;
  const eventMs = commentEvidenceMs(comment, ctx);
  if (!Number.isFinite(eventMs)) return null;
  if (!(eventMs > (Number(ctx && ctx.baseChangedMs) || 0))) return null;
  if (!evidenceAfterHeadPush(eventMs, ctx && ctx.headPushedMs)) return null;
  if (evidenceMentionsNonHeadSha(body, headSha)) return null;
  if (commentAcceptsCleanHead(comment, ctx)) {
    return { ms: eventMs, clean: true, dismissed: false, source: 'comment' };
  }
  if (summaryMarksHeadCompleted(body, headSha)) {
    if (!summaryCompletedPrefixIsUnique(body, headSha, uniqueResolve)) return null;
    return { ms: eventMs, clean: false, dismissed: false, source: 'comment' };
  }
  if (commentIsHeadFindingsReceipt(body, headSha, uniqueResolve)) {
    return { ms: eventMs, clean: false, dismissed: false, source: 'comment' };
  }
  return null;
}

/**
 * Newest completed Codex result on this head wins. An older clean
 * review/comment must not hide later findings, and a later clean
 * result supersedes earlier findings or a dismissal.
 * Equal timestamps fail closed (non-clean wins).
 */
export function latestCodexHeadOutcome({
  reviews,
  comments,
  headSha,
  uniqueResolve,
  headPushedMs,
  baseChangedMs,
  timeline,
} = {}) {
  const dismissalById = dismissalMsByReviewId(timeline);
  const outcomes = [];
  for (const r of reviews || []) {
    const o = reviewCompletedHeadOutcome(
      r, headSha, uniqueResolve, headPushedMs, baseChangedMs, dismissalById,
    );
    if (o) outcomes.push(o);
  }
  const ctx = { headSha, uniqueResolve, headPushedMs, baseChangedMs };
  for (const c of comments || []) {
    const o = commentCompletedHeadOutcome(c, ctx);
    if (o) outcomes.push(o);
  }
  if (outcomes.length === 0) return null;
  outcomes.sort((a, b) => {
    if (b.ms !== a.ms) return b.ms - a.ms;
    if (a.clean !== b.clean) return a.clean ? 1 : -1;
    return 0;
  });
  return outcomes[0];
}

function isFreshBillWaiver(pr, headSha, event, facts) {
  if (!event) return false;
  const sender = (event.sender && event.sender.login) || '';
  const payloadPr = event.pull_request;
  const payloadHead = payloadPr && payloadPr.head && payloadPr.head.sha;
  const payloadBase = payloadPr && payloadPr.base && payloadPr.base.ref;
  const payloadBaseSha = payloadPr && payloadPr.base && payloadPr.base.sha;
  const name = event.name || '';
  const afterBase = facts.baseChangedMs === 0 || (
    facts.lastWaiverEvent &&
    facts.lastWaiverEvent.event === 'labeled' &&
    Date.parse(facts.lastWaiverEvent.created_at || 0) > facts.baseChangedMs
  );
  return (
    (name === 'pull_request' || name === 'pull_request_target') &&
    event.action === 'labeled' &&
    event.label && event.label.name === WAIVE_LABEL &&
    payloadPr && payloadPr.number === pr.number &&
    sameSha(payloadHead, headSha) &&
    payloadBase === (pr.base && pr.base.ref) &&
    (!pr.base || !pr.base.sha || !payloadBaseSha || sameSha(payloadBaseSha, pr.base.sha)) &&
    WAIVER_ACTORS.has(sender) &&
    afterBase &&
    !facts.headMovedAfterWaiver
  );
}

export function shouldPostWaiverRecord(event, pr, headSha) {
  return isFreshBillWaiver(pr, headSha, event, {
    baseChangedMs: 0,
    lastWaiverEvent: null,
  });
}

export function shouldRecordWaiverOnEvent(eventName, payload = {}) {
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') return true;
  if (eventName === 'pull_request_target') {
    return payload.action === 'labeled' &&
      payload.label && payload.label.name === WAIVE_LABEL &&
      WAIVER_ACTORS.has((payload.sender && payload.sender.login) || '');
  }
  return false;
}

export function existingWaiverRecordForHead(comments, {
  headSha,
  baseRef,
  baseSha,
  prNumber,
  actor,
  labeledMs,
  lastWaiverEvent,
  resolveWaiverRun,
} = {}) {
  return (comments || []).some(c => {
    if (lastWaiverEvent && !latestWaiverLabelAcceptsRecord(lastWaiverEvent, c)) return false;
    if (labeledMs != null && !lastWaiverEvent) {
      const commentMs = Date.parse((c && c.created_at) || 0);
      if (!Number.isFinite(commentMs) || commentMs < labeledMs) return false;
    }
    if (actor) {
      const rec = parseWaiverRecord(c && c.body);
      if (!rec || rec.actor !== actor) return false;
    }
    return waiverRecordAcceptsHead(c, {
      headSha,
      prNumber,
      baseRef,
      baseSha,
      resolveWaiverRun,
    });
  });
}

/**
 * Schedule / dispatch may post a waiver only when Bill's latest
 * `codex-waived` event is `labeled` after this head's trusted arrival
 * (workflow-run / check-suite `created_at`) and after any later
 * `committed` / `head_ref_force_pushed` timeline event. Do not use
 * `committed.created_at` — that field does not exist. A leftover
 * label after a new push does not mint a new waiver.
 */
export function shouldScanRecordWaiver({
  labels,
  lastWaiverEvent,
  headMovedAfterWaiver,
  headPushedMs,
  baseChangedMs,
  comments,
  headSha,
  baseRef,
  baseSha,
  prNumber,
  resolveWaiverRun,
} = {}) {
  if (!labels || !labels.includes(WAIVE_LABEL)) return false;
  if (!lastWaiverEvent || lastWaiverEvent.event !== 'labeled') return false;
  const actor = waiverActorLogin(lastWaiverEvent);
  if (!WAIVER_ACTORS.has(actor)) return false;
  const eventMs = Date.parse(lastWaiverEvent.created_at || 0);
  if (!Number.isFinite(eventMs)) return false;
  if (headMovedAfterWaiver) return false;
  const pushed = Number(headPushedMs);
  if (!Number.isFinite(pushed)) return false;
  if (!(eventMs > pushed)) return false;
  if (baseChangedMs && eventMs <= baseChangedMs) return false;
  if (!fullSha(headSha) || !baseRef || !fullSha(baseSha)) return false;
  return !existingWaiverRecordForHead(comments, {
    headSha,
    baseRef,
    baseSha,
    prNumber,
    actor,
    lastWaiverEvent,
    resolveWaiverRun,
  });
}

export async function recordTrustedWaivers({
  client,
  owner,
  repo,
  eventName,
  payload = {},
  runId,
} = {}) {
  if (!shouldRecordWaiverOnEvent(eventName, payload)) return { posted: [], receipts: [] };
  const posted = [];
  const receipts = [];
  const numbers = [];
  if (eventName === 'pull_request_target' && payload.pull_request) {
    numbers.push(payload.pull_request.number);
  } else {
    const requested = payload.inputs && payload.inputs.pr_number;
    if (requested) {
      const n = parseInt(requested, 10);
      if (!Number.isFinite(n)) throw new Error(`bad pr_number: ${requested}`);
      numbers.push(n);
    } else {
      const prs = await client.paginate(`/repos/${owner}/${repo}/pulls?state=open`);
      for (const p of prs) numbers.push(p.number);
    }
  }

  for (const n of numbers) {
    const pr = await client.get(`/repos/${owner}/${repo}/pulls/${n}`);
    const headSha = fullSha(pr.head && pr.head.sha);
    const baseRef = pr.base && pr.base.ref;
    const baseSha = fullSha(pr.base && pr.base.sha);
    if (!headSha || !baseRef || !baseSha) continue;

    let actor = (payload.sender && payload.sender.login) || '';
    if (eventName === 'pull_request_target') {
      if (!shouldPostWaiverRecord({
        name: eventName,
        action: payload.action,
        sender: payload.sender,
        label: payload.label,
        pull_request: payload.pull_request,
      }, pr, headSha)) {
        continue;
      }
    } else {
      const [comments, timeline] = await Promise.all([
        client.paginate(`/repos/${owner}/${repo}/issues/${n}/comments`),
        client.paginate(`/repos/${owner}/${repo}/issues/${n}/timeline`),
      ]);
      const facts = timelineFacts(timeline);
      const labels = (pr.labels || []).map(l => l.name);
      const headPushedMs = await loadHeadPushMs(client, owner, repo, headSha);
      const resolveWaiverRun = await buildWaiverResolver(client, owner, repo, comments);
      if (!shouldScanRecordWaiver({
        labels,
        lastWaiverEvent: facts.lastWaiverEvent,
        headMovedAfterWaiver: facts.headMovedAfterWaiver,
        headPushedMs,
        baseChangedMs: facts.baseChangedMs,
        comments,
        headSha,
        baseRef,
        baseSha,
        prNumber: n,
        resolveWaiverRun,
      })) {
        continue;
      }
      actor = waiverActorLogin(facts.lastWaiverEvent);
    }

    if (!WAIVER_ACTORS.has(actor)) continue;
    const run = Number(runId);
    if (!Number.isFinite(run) || run <= 0) continue;

    const comments = await client.paginate(`/repos/${owner}/${repo}/issues/${n}/comments`);
    const already = comments.some(c =>
      isGithubActionsBot(c && c.user) &&
      (c.body || '').includes(WAIVER_MARKER) &&
      (c.body || '').includes(`"run":${run}`) &&
      (c.body || '').includes(`"sha":"${headSha}"`),
    );
    if (already) continue;

    const created = await client.post(`/repos/${owner}/${repo}/issues/${n}/comments`, {
      body: formatWaiverComment({
        sha: headSha,
        base: baseRef,
        baseSha,
        actor,
        pr: n,
        run,
      }),
    });
    const commentId = Number(created && created.id);
    posted.push(n);
    if (Number.isFinite(commentId) && commentId > 0) {
      receipts.push({
        pr: n,
        sha: headSha,
        baseSha,
        commentId,
        run,
      });
    }
  }
  return { posted, receipts };
}

export function evaluatePr(input) {
  const pr = input.pr || {};
  const prNumber = pr.number;
  const headSha = fullSha(pr.head && pr.head.sha);
  if (!headSha) {
    return {
      prNumber,
      headSha: pr.head && pr.head.sha,
      conclusion: 'failure',
      title: 'Invalid head SHA',
      summary: 'PR head is not a 40-character SHA; fail-closed.',
    };
  }

  const labels = (pr.labels || []).map(l => l.name);
  const facts = timelineFacts(input.timeline || []);
  const event = input.event || {};
  const comments = input.comments || [];
  const uniqueResolve = input.uniqueResolve;
  const headPushedMs = input.headPushedMs;
  const resolveWaiverRun = input.resolveWaiverRun;
  const baseRef = pr.base && pr.base.ref;
  const baseSha = pr.base && pr.base.sha;

  if (labels.includes(WAIVE_LABEL)) {
    if (isFreshBillWaiver(pr, headSha, event, facts) ||
        isWaiverBoundToCurrentHead({
          labels,
          comments,
          headSha,
          prNumber,
          baseRef,
          baseSha,
          resolveWaiverRun,
          lastWaiverEvent: facts.lastWaiverEvent,
          headMovedAfterWaiver: facts.headMovedAfterWaiver,
        })) {
      return {
        prNumber,
        headSha,
        conclusion: 'success',
        title: 'Codex waived',
        summary: `Label \`${WAIVE_LABEL}\` applied by an allow-listed actor on head \`${headSha}\` ` +
          `for base \`${baseRef}\`. The waiver covers this SHA and base only; ` +
          'any new push or retarget needs a new review or waiver.',
      };
    }
  }

  if (pr.draft) {
    return {
      prNumber,
      headSha,
      conclusion: 'failure',
      title: 'Draft PR',
      summary: 'Draft PRs stay blocked; mark ready for review and wait for Codex on the head.',
    };
  }

  const reviews = input.reviews || [];
  const latest = latestCodexHeadOutcome({
    reviews,
    comments,
    headSha,
    uniqueResolve,
    headPushedMs,
    baseChangedMs: facts.baseChangedMs,
    timeline: input.timeline || [],
  });

  const usageLimited = comments.some(c => {
    const body = c.body || '';
    return isCodexUser(c.user) && /usage limits?/i.test(body);
  });

  if (latest && latest.clean) {
    return {
      prNumber,
      headSha,
      conclusion: 'success',
      title: 'Codex reviewed head',
      summary: `chatgpt-codex-connector completed a clean review of \`${headSha}\` (no findings).`,
    };
  }

  if (latest && !latest.clean && !latest.dismissed) {
    return {
      prNumber,
      headSha,
      conclusion: 'failure',
      title: 'Codex found issues on head',
      summary: `chatgpt-codex-connector reviewed \`${headSha}\` but the result is not a clean ` +
        '"no major issues" / no-findings review. Gate stays red until Codex posts a clean ' +
        `result or \`${WAIVE_LABEL}\` is applied.`,
    };
  }

  if (usageLimited) {
    return {
      prNumber,
      headSha,
      conclusion: 'failure',
      title: 'Codex unavailable (usage limit)',
      summary: `Codex hit usage limits and has not reviewed \`${headSha}\`. ` +
        `Fail-closed: apply \`${WAIVE_LABEL}\` only with Bill's explicit GO, or wait for quota.`,
    };
  }

  return {
    prNumber,
    headSha,
    conclusion: 'failure',
    title: 'Waiting for Codex on head',
    summary: `No chatgpt-codex-connector review on \`${headSha}\` yet. ` +
      `CI alone is not enough. Gate stays red until Codex finishes or \`${WAIVE_LABEL}\` is applied.`,
  };
}

export function combineHeadVerdicts(results) {
  if (!results || results.length === 0) {
    return {
      conclusion: 'failure',
      title: 'No open PR to evaluate',
      summary: 'review-gate found no open PR for this head.',
    };
  }
  const failing = results.find(r => r.conclusion !== 'success');
  const verdict = failing || results[0];
  const others = results.length > 1
    ? ` Evaluated ${results.length} open PRs sharing this head (#${results.map(r => r.prNumber).join(', #')}).`
    : '';
  const blockedBy = failing && results.length > 1
    ? `Blocked by PR #${failing.prNumber} (same head): `
    : '';
  return {
    ...verdict,
    summary: blockedBy + verdict.summary + others,
  };
}

export function snapshotKey(pr, facts) {
  return `${fullSha(pr.head && pr.head.sha)}|${pr.base && pr.base.ref}|${facts.baseChangedMs}`;
}

export function sameNumberSet(left, right) {
  if (left.size !== right.size) return false;
  for (const n of left) if (!right.has(n)) return false;
  return true;
}

export function runMatchesPr(run, prNumber) {
  const n = Number(prNumber);
  if (!Number.isFinite(n) || n <= 0) return false;
  const prs = (run && run.pull_requests) || [];
  return prs.some(p => Number(p.number) === n);
}

export function isCiPullRequestRun(run) {
  if (!run || run.event !== 'pull_request') return false;
  const path = run.path || '';
  return path === `.github/workflows/${CI_WORKFLOW_FILE}` ||
    path.endsWith(`/${CI_WORKFLOW_FILE}`) ||
    path === CI_WORKFLOW_FILE ||
    run.name === 'CI';
}

export function runIsUnattributed(run) {
  return ((run && run.pull_requests) || []).length === 0;
}

export function headRepoFullName(pr) {
  const name = pr && pr.head && pr.head.repo && pr.head.repo.full_name;
  return typeof name === 'string' ? name : '';
}

export function runHeadRepoFullName(run) {
  const name = run && run.head_repository && run.head_repository.full_name;
  return typeof name === 'string' ? name : '';
}

export function prHeadBranch(pr) {
  const ref = pr && pr.head && pr.head.ref;
  return typeof ref === 'string' ? ref : '';
}

/**
 * Fork PRs often have an empty workflow_run.pull_requests[] (actions/runner#3444).
 * Match the already-SHA-filtered run by head repo + branch instead.
 * Never treat a run attributed to some other PR as a candidate.
 */
export function runMatchesUnattributedHead(run, pr) {
  if (!run || !pr || !runIsUnattributed(run)) return false;
  const sha = fullSha(pr.head && pr.head.sha);
  const branch = prHeadBranch(pr);
  const repoName = headRepoFullName(pr);
  if (!sha || !branch || !repoName) return false;
  if (!sameSha(run.head_sha, sha)) return false;
  if ((run.head_branch || '') !== branch) return false;
  return runHeadRepoFullName(run) === repoName;
}

export function countOpenHeadsWithSha(openPrs, headSha) {
  const sha = fullSha(headSha);
  if (!sha) return 0;
  return (openPrs || []).filter(p => sameSha(p.head && p.head.sha, sha)).length;
}

export function latestCiRun(runs) {
  const list = (runs || []).slice();
  list.sort((a, b) => {
    const byNumber = (b.run_number || 0) - (a.run_number || 0);
    if (byNumber !== 0) return byNumber;
    return Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0);
  });
  return list[0] || null;
}

/**
 * Pick the pull_request CI run that belongs to this PR.
 *   1. Numbered pull_requests[] match wins.
 *   2. Else an unattributed run whose head SHA + repo + branch match.
 *   3. Else, if this SHA belongs to only one open PR and there is
 *      exactly one unattributed CI run, use it.
 *   4. Else null (ambiguous / missing). Never use a run whose
 *      pull_requests[] lists a different PR.
 */
export function selectCiRun(runs, { prNumber, pr, headIsUnique } = {}) {
  const ci = (runs || []).filter(isCiPullRequestRun);
  const numbered = ci.filter(r => runMatchesPr(r, prNumber));
  if (numbered.length > 0) return latestCiRun(numbered);

  const unattributed = ci.filter(runIsUnattributed);
  const headMatched = unattributed.filter(r => runMatchesUnattributedHead(r, pr));
  if (headMatched.length > 0) return latestCiRun(headMatched);

  if (headIsUnique && unattributed.length === 1) return unattributed[0];
  return null;
}

export function isTrustedRefreshComment(event) {
  if (!event || event.name !== 'issue_comment') return false;
  if (!event.issue || !event.issue.pull_request) return false;
  const action = event.action;
  if (action !== 'created' && action !== 'edited' && action !== 'deleted') return false;
  return isCodexUser(event.comment && event.comment.user);
}

export function isTrustedPullRequestRefreshEvent(event) {
  if (!event || event.name !== 'pull_request_target') return false;
  const action = event.action;
  if (action === 'ready_for_review' || action === 'reopened') return true;
  if (event.label && event.label.name === WAIVE_LABEL) {
    if (action === 'unlabeled') return true;
    if (action === 'labeled') {
      const sender = (event.sender && event.sender.login) || '';
      return WAIVER_ACTORS.has(sender);
    }
  }
  if (action === 'edited') return !!(event.changes && event.changes.base);
  return false;
}

export function shouldRefreshOnEvent(event) {
  if (!event || !event.name) return false;
  if (event.name === 'schedule' || event.name === 'workflow_dispatch') return true;
  if (event.name === 'issue_comment') return isTrustedRefreshComment(event);
  if (event.name === 'pull_request_target') return isTrustedPullRequestRefreshEvent(event);
  return false;
}

export function selectReviewGateJob(jobs) {
  return (jobs || []).find(j => j.name === CHECK_JOB_NAME) || null;
}

export function runAttemptCount(run) {
  const n = Number(run && run.run_attempt);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function scheduleBackoffMs(attempt) {
  const n = Number(attempt);
  const safe = Number.isFinite(n) && n > 0 ? n : 1;
  const exp = Math.min(Math.max(safe - 1, 0), 3);
  return SCHEDULE_INTERVAL_MS * (2 ** exp);
}

export function shouldRerunOnSchedule(job) {
  if (!job) return true;
  if (job.status && job.status !== 'completed') return false;
  return true;
}

export function scheduleCapsWaitingGate(run, job) {
  return runAttemptCount(run) >= MAX_RUN_ATTEMPTS &&
    !(job && job.conclusion === 'success');
}

/**
 * Decide whether to spend a rerun. Never no-op-rerun a published
 * conclusion (green polling was exhausting GitHub's 50-rerun ceiling).
 * Flip only when evaluate disagrees with the published job. Near the
 * ceiling, refuse to touch a green gate (caller must fail closed).
 */
export function refreshAction({ job, verdict, eventName, runAttempt } = {}) {
  if (!job) return 'missing-job';
  const current = job.conclusion;
  const next = verdict && verdict.conclusion;
  const attempt = runAttemptCount({ run_attempt: runAttempt });
  const nearCeiling = attempt >= GITHUB_RERUN_CEILING - RERUN_CEILING_RESERVE;

  if (next && current === next) return 'skip-unchanged';

  if (!next) {
    if (nearCeiling && current === 'success') return 'ceiling-fail';
    if (current === 'success') return 'rerun';
    if (eventName === 'schedule' && attempt >= MAX_RUN_ATTEMPTS) return 'capped';
    return 'rerun';
  }

  if (nearCeiling) {
    return current === 'success' ? 'ceiling-fail' : 'capped';
  }
  return 'rerun';
}

export function rerunPlan(run, job, { eventName, nowMs, lastJobCompletedMs, verdict } = {}) {
  if (!run) return 'missing-run';
  if (run.status && run.status !== 'completed') {
    return eventName === 'schedule' ? 'skip-in-progress' : 'wait-run';
  }
  if (!job) return 'missing-job';
  const action = refreshAction({
    job,
    verdict,
    eventName,
    runAttempt: runAttemptCount(run),
  });
  if (action !== 'rerun') return action;
  // Back off only the no-verdict waiting poll. A conclusion flip
  // (dismissal, new clean review) reruns immediately. A green gate
  // whose reevaluation failed must not wait — invalidate now.
  if (
    eventName === 'schedule' &&
    !(verdict && verdict.conclusion) &&
    job.conclusion !== 'success'
  ) {
    const completedMs = lastJobCompletedMs != null
      ? Number(lastJobCompletedMs)
      : Date.parse((job && job.completed_at) || run.updated_at || 0);
    const wait = scheduleBackoffMs(runAttemptCount(run));
    const now = nowMs == null ? Date.now() : Number(nowMs);
    if (Number.isFinite(completedMs) && Number.isFinite(now) && now - completedMs < wait) {
      return 'backoff';
    }
  }
  return 'rerun';
}

export function githubClientFromOctokit(octokit) {
  if (!octokit || typeof octokit.request !== 'function') {
    throw new Error('octokit client is required');
  }
  async function request(method, path, body) {
    const res = await octokit.request(`${method} ${path}`, body !== undefined ? { data: body } : {});
    return { status: res.status, data: res.data };
  }
  async function paginate(path, listKey) {
    const items = [];
    let page = 1;
    const sep = path.includes('?') ? '&' : '?';
    for (;;) {
      const { data } = await request('GET', `${path}${sep}per_page=100&page=${page}`);
      const batch = listKey
        ? (data && data[listKey]) || []
        : (Array.isArray(data) ? data : []);
      items.push(...batch);
      if (batch.length < 100) break;
      page += 1;
    }
    return items;
  }
  return {
    request,
    paginate,
    get: async path => (await request('GET', path)).data,
    post: async (path, body) => (await request('POST', path, body)).data,
  };
}

export function createGithubClient({ token, fetchImpl, apiBase, octokit } = {}) {
  if (octokit) return githubClientFromOctokit(octokit);
  const fetchFn = fetchImpl || globalThis.fetch;
  const base = apiBase || 'https://api.github.com';
  if (!token) throw new Error('GITHUB_TOKEN is required for review-gate API reads');

  async function request(method, path, body) {
    return withRetry(async () => {
      const res = await fetchFn(`${base}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'agent-wallet-sdk-review-gate',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch { data = { message: text }; }
      }
      if (res.status >= 400) {
        const err = new Error(
          `GitHub ${res.status} ${method} ${path}: ${(data && data.message) || res.statusText}`,
        );
        err.status = res.status;
        throw err;
      }
      return { status: res.status, data };
    });
  }

  async function paginate(path, listKey) {
    const items = [];
    let page = 1;
    const sep = path.includes('?') ? '&' : '?';
    for (;;) {
      const { data } = await request('GET', `${path}${sep}per_page=100&page=${page}`);
      const batch = listKey
        ? (data && data[listKey]) || []
        : (Array.isArray(data) ? data : []);
      items.push(...batch);
      if (batch.length < 100) break;
      page += 1;
    }
    return items;
  }

  return {
    request,
    paginate,
    get: async path => (await request('GET', path)).data,
    post: async (path, body) => (await request('POST', path, body)).data,
  };
}

function readJsonFile(readFile, path) {
  if (!path) return {};
  return JSON.parse(readFile(path));
}

function repoParts(repository) {
  const [owner, repo] = String(repository || '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY must be owner/repo');
  return { owner, repo };
}

export async function resolvePrefixToHead(client, owner, repo, prefix, headSha) {
  if (!shaPrefixMatches(prefix, headSha)) return false;
  if (String(prefix).length === 40) return true;
  try {
    const commit = await client.get(`/repos/${owner}/${repo}/commits/${prefix}`);
    return sameSha(commit && commit.sha, headSha);
  } catch {
    return false;
  }
}

export function collectResolvablePrefixes(reviews, comments, headSha) {
  const prefixes = [];
  const seen = new Set();
  function add(value) {
    const s = typeof value === 'string' ? value.toLowerCase() : '';
    if (!s || seen.has(s) || !shaPrefixMatches(s, headSha)) return;
    seen.add(s);
    prefixes.push(s);
  }
  for (const r of reviews || []) {
    if (!isCodexUser(r && r.user)) continue;
    if (typeof r.commit_id === 'string') add(r.commit_id);
    for (const s of mentionedShas(r && r.body)) add(s);
    if (prefixes.length >= MAX_PREFIX_RESOLVES) break;
  }
  for (const c of comments || []) {
    if (prefixes.length >= MAX_PREFIX_RESOLVES) break;
    if (!isCodexUser(c && c.user)) continue;
    for (const s of mentionedShas(c && c.body)) {
      add(s);
      if (prefixes.length >= MAX_PREFIX_RESOLVES) break;
    }
  }
  return prefixes.slice(0, MAX_PREFIX_RESOLVES);
}

async function buildUniqueResolve(client, owner, repo, headSha, reviews, comments) {
  const prefixes = collectResolvablePrefixes(reviews, comments, headSha);
  const unique = new Set();
  for (const p of prefixes) {
    if (await resolvePrefixToHead(client, owner, repo, p, headSha)) unique.add(p);
  }
  return shown => {
    const s = typeof shown === 'string' ? shown.toLowerCase() : '';
    if (s.length === 40) return sameSha(s, headSha);
    return unique.has(s);
  };
}

async function loadHeadPushMs(client, owner, repo, headSha) {
  const [runs, suiteData] = await Promise.all([
    client.paginate(
      `/repos/${owner}/${repo}/actions/runs?head_sha=${headSha}&event=pull_request`,
      'workflow_runs',
    ),
    client.get(`/repos/${owner}/${repo}/commits/${headSha}/check-suites`).catch(() => ({
      check_suites: [],
    })),
  ]);
  return headPushedMsFromEvidence({
    workflowRuns: runs,
    checkSuites: (suiteData && suiteData.check_suites) || [],
  });
}

export async function evaluatePrNumber(client, owner, repo, prNumber, event) {
  const snap = await loadSnapshot(client, owner, repo, prNumber, event || {});
  return evaluatePr(snap);
}

async function loadSnapshot(client, owner, repo, prNumber, event) {
  const pr = await client.get(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  const [reviews, comments, timeline] = await Promise.all([
    client.paginate(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`),
    client.paginate(`/repos/${owner}/${repo}/issues/${prNumber}/comments`),
    client.paginate(`/repos/${owner}/${repo}/issues/${prNumber}/timeline`),
  ]);
  const headSha = fullSha(pr.head && pr.head.sha);
  let headPushedMs;
  let uniqueResolve = shown => {
    const s = typeof shown === 'string' ? shown.toLowerCase() : '';
    return s.length === 40 && sameSha(s, headSha);
  };
  let resolveWaiverRun = () => null;
  if (headSha) {
    headPushedMs = await loadHeadPushMs(client, owner, repo, headSha);
    uniqueResolve = await buildUniqueResolve(client, owner, repo, headSha, reviews, comments);
    resolveWaiverRun = await buildWaiverResolver(client, owner, repo, comments);
  }
  return { pr, reviews, comments, timeline, event, headPushedMs, uniqueResolve, resolveWaiverRun };
}

async function loadRepoDefaultBranch(client, owner, repo) {
  try {
    const data = await client.get(`/repos/${owner}/${repo}`);
    return typeof (data && data.default_branch) === 'string' ? data.default_branch : '';
  } catch {
    return '';
  }
}

async function loadJobReceipts(client, owner, repo, job) {
  const checkRunId = checkRunIdFromJob(job);
  if (!checkRunId) return [];
  try {
    const data = await client.get(`/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations`);
    const list = Array.isArray(data) ? data : (data && data.annotations) || [];
    return parseWaiverReceipts(list);
  } catch {
    return [];
  }
}

async function buildWaiverResolver(client, owner, repo, comments) {
  const map = new Map();
  const defaultBranch = await loadRepoDefaultBranch(client, owner, repo);
  for (const c of comments || []) {
    const rec = parseWaiverRecord(c && c.body);
    if (!rec || map.has(rec.run)) continue;
    try {
      const run = await client.get(`/repos/${owner}/${repo}/actions/runs/${rec.run}`);
      const jobs = await client.paginate(
        `/repos/${owner}/${repo}/actions/runs/${rec.run}/jobs`,
        'jobs',
      );
      const recordJob = (jobs || []).find(j => j.name === WAIVER_RECORD_JOB);
      const receipts = await loadJobReceipts(client, owner, repo, recordJob);
      map.set(rec.run, { run, jobs, receipts, defaultBranch });
    } catch {
      map.set(rec.run, null);
    }
  }
  return runId => map.get(Number(runId)) || null;
}

export async function runEvaluate({ env, readFile, github } = {}) {
  const environment = env || process.env;
  const read = readFile || (path => fs.readFileSync(path, 'utf8'));
  const payload = readJsonFile(read, environment.GITHUB_EVENT_PATH);
  const { owner, repo } = repoParts(environment.GITHUB_REPOSITORY);
  const client = github || createGithubClient({ token: environment.GITHUB_TOKEN });
  const event = {
    name: environment.GITHUB_EVENT_NAME,
    action: payload.action,
    sender: payload.sender,
    label: payload.label,
    pull_request: payload.pull_request,
  };

  const prNumber = (payload.pull_request && payload.pull_request.number) ||
    (payload.issue && payload.issue.pull_request && payload.issue.number);
  if (!prNumber) {
    throw new Error('review-gate evaluate requires a pull_request context');
  }

  const first = await loadSnapshot(client, owner, repo, prNumber, event);
  const headSha = fullSha(first.pr.head && first.pr.head.sha);
  if (!headSha) {
    const verdict = evaluatePr(first);
    console.log(`${verdict.conclusion}: ${verdict.title}`);
    console.log(verdict.summary);
    return verdict;
  }

  const open = await client.paginate(`/repos/${owner}/${repo}/pulls?state=open`);
  const sharers = [...new Set(
    open.filter(p => sameSha(p.head && p.head.sha, headSha)).map(p => p.number).concat(prNumber),
  )];

  const before = new Map();
  const snapshots = [];
  for (const n of sharers) {
    const snap = n === prNumber ? first : await loadSnapshot(client, owner, repo, n, event);
    before.set(n, snapshotKey(snap.pr, timelineFacts(snap.timeline)));
    snapshots.push(snap);
  }

  let verdict = combineHeadVerdicts(snapshots.map(s => evaluatePr(s)));

  if (verdict.conclusion === 'success') {
    const freshOpen = await client.paginate(`/repos/${owner}/${repo}/pulls?state=open`);
    const freshSharers = new Set(
      freshOpen.filter(p => sameSha(p.head && p.head.sha, headSha)).map(p => p.number),
    );
    if (!sameNumberSet(new Set(sharers), freshSharers)) {
      verdict = {
        conclusion: 'failure',
        title: 'Head SHA now shared with other PRs',
        summary: 'Another open PR moved onto this head during evaluation. Not publishing success.',
        headSha,
      };
    } else {
      const refreshed = [];
      let stale = false;
      for (const n of freshSharers) {
        const snap = await loadSnapshot(client, owner, repo, n, event);
        if (snapshotKey(snap.pr, timelineFacts(snap.timeline)) !== before.get(n)) {
          stale = true;
          break;
        }
        if (!sameSha(snap.pr.head && snap.pr.head.sha, headSha)) {
          stale = true;
          break;
        }
        refreshed.push(evaluatePr(snap));
      }
      verdict = stale
        ? {
            conclusion: 'failure',
            title: 'Stale during evaluation',
            summary: 'Head, base, or retarget time moved while evaluating; not publishing success.',
            headSha,
          }
        : combineHeadVerdicts(refreshed);
    }
  }

  console.log(`${verdict.conclusion}: ${verdict.title}`);
  console.log(verdict.summary);
  return verdict;
}

export async function resolvePrNumbers({ eventName, payload, client, owner, repo }) {
  if (payload.pull_request && payload.pull_request.number) {
    return [payload.pull_request.number];
  }
  if (payload.issue && payload.issue.pull_request) {
    return [payload.issue.number];
  }
  const requested = payload.inputs && payload.inputs.pr_number;
  if (requested) {
    const n = parseInt(requested, 10);
    if (!Number.isFinite(n)) throw new Error(`bad pr_number: ${requested}`);
    return [n];
  }
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    const prs = await client.paginate(`/repos/${owner}/${repo}/pulls?state=open`);
    return prs.map(pr => pr.number);
  }
  return [];
}

async function waitForRun(client, owner, repo, runId, opts = {}) {
  const timeoutMs = opts.timeoutMs == null ? 8 * 60 * 1000 : opts.timeoutMs;
  const pollMs = opts.pollMs == null ? 10 * 1000 : opts.pollMs;
  const sleep = opts.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = Date.now();
  for (;;) {
    const run = await client.get(`/repos/${owner}/${repo}/actions/runs/${runId}`);
    if (run.status === 'completed') return run;
    if (Date.now() - started >= timeoutMs) return run;
    await sleep(pollMs);
  }
}

export async function runRerun({ env, readFile, github } = {}) {
  const environment = env || process.env;
  const read = readFile || (path => fs.readFileSync(path, 'utf8'));
  const payload = readJsonFile(read, environment.GITHUB_EVENT_PATH);
  const { owner, repo } = repoParts(environment.GITHUB_REPOSITORY);
  const client = github || createGithubClient({ token: environment.GITHUB_TOKEN });
  const eventName = environment.GITHUB_EVENT_NAME;
  const event = {
    name: eventName,
    action: payload.action,
    sender: payload.sender,
    label: payload.label,
    pull_request: payload.pull_request,
    issue: payload.issue,
    comment: payload.comment,
    changes: payload.changes,
  };
  if (!shouldRefreshOnEvent(event)) {
    console.log('Ignoring untrusted refresh event');
    return { reran: [] };
  }
  try {
    await recordTrustedWaivers({
      client,
      owner,
      repo,
      eventName,
      payload,
      runId: environment.GITHUB_RUN_ID,
    });
  } catch (err) {
    const status = err && err.status;
    if (status === 403 || status === 422) {
      console.log(`waiver record skipped (${status} ${err.message})`);
    } else {
      throw err;
    }
  }
  const numbers = await resolvePrNumbers({ eventName, payload, client, owner, repo });
  if (numbers.length === 0) {
    console.log('No pull requests to refresh.');
    return { reran: [] };
  }

  const openPrs = await client.paginate(`/repos/${owner}/${repo}/pulls?state=open`);
  const reran = [];
  for (const n of numbers) {
    const pr = await client.get(`/repos/${owner}/${repo}/pulls/${n}`);
    const headSha = fullSha(pr.head && pr.head.sha);
    if (!headSha) {
      console.log(`#${n}: skip, head is not a 40-character SHA`);
      continue;
    }
    const runs = await client.paginate(
      `/repos/${owner}/${repo}/actions/workflows/${CI_WORKFLOW_FILE}/runs?head_sha=${headSha}&event=pull_request`,
      'workflow_runs',
    );
    const headIsUnique = countOpenHeadsWithSha(openPrs, headSha) <= 1;
    const run = selectCiRun(runs, { prNumber: n, pr, headIsUnique });
    if (!run) {
      console.log(`#${n} ${headSha.slice(0, 7)}: no pull_request CI run for this PR on this head yet`);
      continue;
    }
    const jobs = await client.paginate(
      `/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`,
      'jobs',
    );
    let job = selectReviewGateJob(jobs);
    let verdict;
    try {
      verdict = await evaluatePrNumber(client, owner, repo, n, event);
    } catch (err) {
      console.log(`#${n}: evaluate failed (${err && err.message}); using published conclusion only`);
    }
    const plan = rerunPlan(run, job, { eventName, nowMs: Date.now(), verdict });
    if (plan === 'skip-unchanged') {
      console.log(`#${n}: skip unchanged (${job && job.conclusion})`);
      continue;
    }
    if (plan === 'ceiling-fail') {
      throw new Error(
        `#${n}: green gate is at the rerun ceiling; not swallowing a stuck success. ` +
        'Push a new head or re-run CI to mint a fresh counted run.',
      );
    }
    if (plan === 'capped') {
      console.log(`#${n}: schedule capped (run ${run.id} attempt ${runAttemptCount(run)}/${MAX_RUN_ATTEMPTS})`);
      continue;
    }
    if (plan === 'backoff') {
      console.log(`#${n}: schedule backoff (attempt ${runAttemptCount(run)})`);
      continue;
    }
    if (plan === 'skip-in-progress') {
      console.log(`#${n}: schedule skip (${run.status})`);
      continue;
    }
    if (plan === 'missing-job') {
      console.log(`#${n}: CI run ${run.id} has no ${CHECK_JOB_NAME} job`);
      continue;
    }
    if (plan === 'wait-run') {
      console.log(`#${n}: waiting for CI run ${run.id} (${run.status}) before rerun`);
      const finished = await waitForRun(client, owner, repo, run.id);
      if (finished.status !== 'completed') {
        console.log(`#${n}: CI run ${run.id} still ${finished.status}; schedule will retry`);
        continue;
      }
      const freshJobs = await client.paginate(
        `/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`,
        'jobs',
      );
      job = selectReviewGateJob(freshJobs);
      if (!job) {
        console.log(`#${n}: CI run ${run.id} finished without ${CHECK_JOB_NAME}`);
        continue;
      }
      const waited = rerunPlan(finished, job, { eventName, nowMs: Date.now(), verdict });
      if (waited !== 'rerun') {
        console.log(`#${n}: ${waited} after wait (run ${run.id} attempt ${runAttemptCount(finished)})`);
        continue;
      }
    }
    try {
      await client.post(`/repos/${owner}/${repo}/actions/jobs/${job.id}/rerun`);
      console.log(`#${n}: reran ${CHECK_JOB_NAME} job ${job.id} on run ${run.id}`);
      reran.push({ pr: n, job: job.id, run: run.id });
    } catch (err) {
      const status = err && err.status;
      if (status === 403 && job && job.conclusion === 'success') {
        throw new Error(
          `#${n}: GitHub refused to rerun a green gate (${err.message}). ` +
          'Not swallowing 403; the counted check would stay green.',
        );
      }
      if (status === 403 || status === 409 || status === 422) {
        console.log(`#${n}: rerun skipped (${status} ${err.message})`);
        continue;
      }
      throw err;
    }
  }
  return { reran };
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const command = process.argv[2];
  try {
    if (command === 'evaluate') {
      const verdict = await runEvaluate({ env: process.env });
      if (!verdict || verdict.conclusion !== 'success') process.exit(1);
    } else if (command === 'rerun') {
      await runRerun({ env: process.env });
    } else {
      console.error('usage: node scripts/review-gate.mjs evaluate|rerun');
      process.exit(2);
    }
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

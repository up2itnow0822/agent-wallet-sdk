/**
 * review-gate evaluation and refresh.
 *
 * The required GitHub Actions check named `review-gate` is the CI job in
 * `.github/workflows/ci.yml`. This module is the only evaluator: it reads
 * pull-request evidence through the GitHub API and exits 0/1. The
 * pull_request_target / issue_comment / pull_request_review workflow reruns
 * that CI job; it never calls checks.create.
 *
 * Evidence matchers for clean Codex comments match PR #88 (7+ hex prefix of
 * the current head only; never resolve a short SHA against another commit).
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

export const SUMMARY_MARKER = '<!-- codex-pull-request-review-summary -->';
export const COMPLETED_ROW =
  /^\|[^|\n]*\bCode Review\b[^|\n]*\|[^|\n]*\bCompleted\b[^|\n]*\|\s*`([0-9a-fA-F]{7,40})`\s*\|/gm;
export const MENTIONED_SHA =
  /`([0-9a-fA-F]{7,40})`|"commit_sha"\s*:\s*"([0-9a-fA-F]{7,40})"/g;
export const NO_MAJOR_ISSUES = /didn't find any major issues/i;
export const STATE_COMMENT = /<!--\s*codex-review-state:v1\s+(\{.*?\})\s*-->/;

export function isCodexLogin(login) {
  return !!login && CODEX_LOGINS.has(login);
}

export function isCodexUser(user) {
  return !!user && user.type === 'Bot' && isCodexLogin(user.login);
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

/**
 * A Codex issue comment or review-summary body counts as a clean head
 * review when it does not name any other SHA and either:
 *   - the summary marks Code Review Completed on a head-SHA prefix, or
 *   - the body is a "no major issues" receipt that names a head-SHA prefix.
 * SHA-less receipts never count, even if posted after the head was pushed.
 */
export function commentAcceptsCleanHead(comment, ctx) {
  const body = (comment && comment.body) || '';
  const updatedMs = Date.parse((comment && (comment.updated_at || comment.created_at)) || 0);
  const createdMs = Date.parse((comment && comment.created_at) || 0);
  const baseChangedMs = Number(ctx && ctx.baseChangedMs) || 0;
  const headSha = (ctx && ctx.headSha) || '';

  if (!(updatedMs > baseChangedMs || createdMs > baseChangedMs)) return false;
  if (mentionsNonHeadSha(body, headSha)) return false;
  if (summaryMarksHeadCompleted(body, headSha)) return true;
  if (isCleanNoMajorIssuesBody(body)) {
    return mentionedShas(body).some(s => shaPrefixMatches(s, headSha));
  }
  return false;
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

export function timelineFacts(events) {
  let baseChangedMs = 0;
  let lastWaiverEvent = null;
  let lastHeadMoveMs = 0;
  for (const e of events || []) {
    if (e.event === 'base_ref_changed' && e.created_at) {
      baseChangedMs = Math.max(baseChangedMs, Date.parse(e.created_at));
    }
    if ((e.event === 'labeled' || e.event === 'unlabeled') &&
        e.label && e.label.name === WAIVE_LABEL) {
      lastWaiverEvent = e;
    }
    if ((e.event === 'committed' || e.event === 'head_ref_force_pushed') && e.created_at) {
      lastHeadMoveMs = Math.max(lastHeadMoveMs, Date.parse(e.created_at));
    }
  }
  return { baseChangedMs, lastWaiverEvent, lastHeadMoveMs };
}

export function isWaiverBoundToCurrentHead({
  labels,
  lastWaiverEvent,
  baseChangedMs,
  lastHeadMoveMs,
  headCommitterMs,
}) {
  if (!labels || !labels.includes(WAIVE_LABEL)) return false;
  if (!lastWaiverEvent || lastWaiverEvent.event !== 'labeled') return false;
  if (!lastWaiverEvent.actor || !WAIVER_ACTORS.has(lastWaiverEvent.actor.login)) return false;
  const labeledAt = Date.parse(lastWaiverEvent.created_at || 0);
  if (!Number.isFinite(labeledAt) || labeledAt <= (baseChangedMs || 0)) return false;
  if (labeledAt <= (lastHeadMoveMs || 0)) return false;
  if (headCommitterMs != null && Number(headCommitterMs) > labeledAt) return false;
  return true;
}

function reviewMatchesHead(review, headSha) {
  return isCodexUser(review.user) && shaPrefixMatches(review.commit_id, headSha);
}

function isFreshBillWaiver(pr, headSha, event, facts) {
  if (!event) return false;
  const sender = (event.sender && event.sender.login) || '';
  const payloadPr = event.pull_request;
  const payloadHead = payloadPr && payloadPr.head && payloadPr.head.sha;
  const payloadBase = payloadPr && payloadPr.base && payloadPr.base.ref;
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
    WAIVER_ACTORS.has(sender) &&
    afterBase
  );
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

  if (labels.includes(WAIVE_LABEL)) {
    if (isFreshBillWaiver(pr, headSha, event, facts) ||
        isWaiverBoundToCurrentHead({
          labels,
          lastWaiverEvent: facts.lastWaiverEvent,
          baseChangedMs: facts.baseChangedMs,
          lastHeadMoveMs: facts.lastHeadMoveMs,
          headCommitterMs: input.headCommitterMs,
        })) {
      return {
        prNumber,
        headSha,
        conclusion: 'success',
        title: 'Codex waived',
        summary: `Label \`${WAIVE_LABEL}\` applied by an allow-listed actor on head \`${headSha}\` ` +
          `for base \`${pr.base && pr.base.ref}\`. The waiver covers this SHA and base only; ` +
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
  const comments = input.comments || [];
  const codexReviewsOnHead = reviews.filter(r => reviewMatchesHead(r, headSha));
  const dismissedOnHead = codexReviewsOnHead.some(r =>
    String(r.state).toUpperCase() === 'DISMISSED'
  );
  const codexOnHead = codexReviewsOnHead.filter(r =>
    String(r.state).toUpperCase() !== 'DISMISSED' &&
    Date.parse(r.submitted_at || 0) > facts.baseChangedMs
  );

  const usageLimited = comments.some(c => {
    const body = c.body || '';
    return isCodexUser(c.user) && /usage limits?/i.test(body);
  });

  const cleanPassOnHead = comments.some(c => {
    if (!isCodexUser(c.user)) return false;
    return commentAcceptsCleanHead(c, { headSha, baseChangedMs: facts.baseChangedMs });
  });
  const acceptedCleanPass =
    cleanPassOnHead && codexReviewsOnHead.length === 0 && !dismissedOnHead;

  if (codexOnHead.length > 0 || acceptedCleanPass) {
    return {
      prNumber,
      headSha,
      conclusion: 'success',
      title: 'Codex reviewed head',
      summary: codexOnHead.length > 0
        ? `chatgpt-codex-connector reviewed \`${headSha}\` (${codexOnHead.length} review(s)).`
        : `chatgpt-codex-connector completed a clean review of \`${headSha}\` (no findings).`,
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

export function selectCiRun(runs) {
  const matches = (runs || []).filter(r => {
    const path = r.path || '';
    const isCi = path === `.github/workflows/${CI_WORKFLOW_FILE}` ||
      path.endsWith(`/${CI_WORKFLOW_FILE}`) ||
      path === CI_WORKFLOW_FILE ||
      r.name === 'CI';
    return isCi && r.event === 'pull_request';
  });
  matches.sort((a, b) => {
    const byNumber = (b.run_number || 0) - (a.run_number || 0);
    if (byNumber !== 0) return byNumber;
    return Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0);
  });
  return matches[0] || null;
}

export function selectReviewGateJob(jobs) {
  return (jobs || []).find(j => j.name === CHECK_JOB_NAME) || null;
}

export function shouldRerunOnSchedule(job) {
  if (!job) return true;
  if (job.status && job.status !== 'completed') return false;
  return job.conclusion !== 'success';
}

export function rerunPlan(run, job, { eventName } = {}) {
  if (!run) return 'missing-run';
  if (run.status && run.status !== 'completed') {
    return eventName === 'schedule' ? 'skip-in-progress' : 'wait-run';
  }
  if (!job) return 'missing-job';
  if (eventName === 'schedule' && job.conclusion === 'success') return 'skip-green';
  return 'rerun';
}

export function createGithubClient({ token, fetchImpl, apiBase } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const base = apiBase || 'https://api.github.com';
  if (!token) throw new Error('GITHUB_TOKEN is required for review-gate API reads');

  async function request(method, path) {
    return withRetry(async () => {
      const res = await fetchFn(`${base}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'agent-wallet-sdk-review-gate',
        },
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
    post: async path => (await request('POST', path)).data,
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

async function loadSnapshot(client, owner, repo, prNumber, event) {
  const pr = await client.get(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  const [reviews, comments, timeline] = await Promise.all([
    client.paginate(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`),
    client.paginate(`/repos/${owner}/${repo}/issues/${prNumber}/comments`),
    client.paginate(`/repos/${owner}/${repo}/issues/${prNumber}/timeline`),
  ]);
  const headSha = fullSha(pr.head && pr.head.sha);
  let headCommitterMs;
  if (headSha) {
    const commit = await client.get(`/repos/${owner}/${repo}/commits/${headSha}`);
    headCommitterMs = Date.parse(
      commit && commit.commit && commit.commit.committer && commit.commit.committer.date,
    );
    if (!Number.isFinite(headCommitterMs)) headCommitterMs = undefined;
  }
  return { pr, reviews, comments, timeline, event, headCommitterMs };
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
  const numbers = await resolvePrNumbers({ eventName, payload, client, owner, repo });
  if (numbers.length === 0) {
    console.log('No pull requests to refresh.');
    return { reran: [] };
  }

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
    const run = selectCiRun(runs);
    if (!run) {
      console.log(`#${n} ${headSha.slice(0, 7)}: no pull_request CI run on this head yet`);
      continue;
    }
    const jobs = await client.paginate(
      `/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`,
      'jobs',
    );
    let job = selectReviewGateJob(jobs);
    const plan = rerunPlan(run, job, { eventName });
    if (plan === 'skip-in-progress' || plan === 'skip-green') {
      console.log(`#${n}: schedule skip (${(job && job.conclusion) || run.status})`);
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
    }
    try {
      await client.post(`/repos/${owner}/${repo}/actions/jobs/${job.id}/rerun`);
      console.log(`#${n}: reran ${CHECK_JOB_NAME} job ${job.id} on run ${run.id}`);
      reran.push({ pr: n, job: job.id, run: run.id });
    } catch (err) {
      const status = err && err.status;
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

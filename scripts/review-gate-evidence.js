/**
 * Codex evidence matchers for .github/workflows/review-gate.yml.
 *
 * The workflow cannot check out PR content, so these helpers are inlined
 * there. Keep both copies in sync. Tests in test/review-gate-evidence.test.ts
 * are the executable spec.
 */

export const SUMMARY_MARKER = '<!-- codex-pull-request-review-summary -->';

export const COMPLETED_ROW =
  /^\|[^|\n]*\bCode Review\b[^|\n]*\|[^|\n]*\bCompleted\b[^|\n]*\|\s*`([0-9a-fA-F]{7,40})`\s*\|/gm;

export const MENTIONED_SHA =
  /`([0-9a-fA-F]{7,40})`|"commit_sha"\s*:\s*"([0-9a-fA-F]{7,40})"/g;

export const NO_MAJOR_ISSUES = /didn't find any major issues/i;

export const STATE_COMMENT = /<!--\s*codex-review-state:v1\s+(\{.*?\})\s*-->/;

export function fullSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
    ? value.toLowerCase()
    : '';
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

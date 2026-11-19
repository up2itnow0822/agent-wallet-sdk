import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXCEPTED_ADVISORY_ID = 'GHSA-fc5q-39xc-vjpf';
/** 2026-12-15 23:59 America/Chicago. Exception is valid strictly before this instant. */
export const EXCEPTION_EXPIRES_AT_MS = Date.parse('2026-12-16T05:59:00.000Z');
export const EXCEPTION_EXPIRY_LABEL = '2026-12-15 23:59 America/Chicago (2026-12-16T05:59:00Z)';
export const EXCEPTION_WARNING =
  `WARNING: ${EXCEPTED_ADVISORY_ID} (picomatch ReDoS) is temporarily excepted until ${EXCEPTION_EXPIRY_LABEL}.`;

const GHSA_RE = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;
const ADVISORY_URL = `https://api.github.com/advisories/${EXCEPTED_ADVISORY_ID}`;
const BLOCKING = new Set(['high', 'critical']);

function fail(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  return { ok: false, warning: null, messages: list };
}

function pass(messages, warning = null) {
  const list = Array.isArray(messages) ? messages : [messages];
  if (warning) list.push(warning);
  return { ok: true, warning, messages: list };
}

export function isBlockingSeverity(severity) {
  return BLOCKING.has(severity);
}

export function parseAuditReport(audit, label) {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    return { ok: false, reason: `${label} is not an object` };
  }
  if (audit.error && !audit.vulnerabilities) {
    return { ok: false, reason: `${label} is an npm error payload` };
  }
  if (audit.auditReportVersion !== 2) {
    return { ok: false, reason: `${label} has unsupported auditReportVersion` };
  }
  if (!audit.vulnerabilities || typeof audit.vulnerabilities !== 'object' || Array.isArray(audit.vulnerabilities)) {
    return { ok: false, reason: `${label} is missing a vulnerabilities map` };
  }
  return { ok: true, audit };
}

function blockingPackageNames(audit) {
  const names = [];
  for (const [name, node] of Object.entries(audit.vulnerabilities)) {
    if (node && typeof node === 'object' && isBlockingSeverity(node.severity)) names.push(name);
  }
  const meta = audit.metadata?.vulnerabilities;
  if (meta && typeof meta === 'object') {
    const high = Number(meta.high) || 0;
    const critical = Number(meta.critical) || 0;
    if (high + critical > 0 && names.length === 0) {
      return { ok: false, reason: `${high + critical} high/critical in metadata but none in the advisory graph` };
    }
  }
  return { ok: true, names };
}

export function extractGhsaId(viaObject) {
  if (!viaObject || typeof viaObject !== 'object' || Array.isArray(viaObject)) return null;
  for (const field of [viaObject.url, viaObject.ghsa_id, viaObject.ghsa, viaObject.id]) {
    if (typeof field !== 'string') continue;
    const match = field.match(GHSA_RE);
    if (match) return match[0].toUpperCase();
  }
  return null;
}

function walkViaChains(vulns, pkgName, stack) {
  if (stack.has(pkgName)) return { ok: false, kind: 'cyclic', pkgName };
  const node = vulns[pkgName];
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return { ok: false, kind: 'unresolved', pkgName };
  }
  const via = node.via;
  if (!Array.isArray(via) || via.length === 0) {
    return { ok: false, kind: 'unresolved', pkgName };
  }
  stack.add(pkgName);
  try {
    for (const entry of via) {
      if (typeof entry === 'string') {
        const nested = walkViaChains(vulns, entry, stack);
        if (!nested.ok) return nested;
        continue;
      }
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const id = extractGhsaId(entry);
        if (!id) return { ok: false, kind: 'unknown', pkgName };
        if (id !== EXCEPTED_ADVISORY_ID.toUpperCase()) return { ok: false, kind: 'other-advisory', pkgName, id };
        continue;
      }
      return { ok: false, kind: 'unknown', pkgName };
    }
    return { ok: true };
  } finally {
    stack.delete(pkgName);
  }
}

function describeViaFailure(result) {
  switch (result.kind) {
    case 'cyclic':
      return `cyclic via chain at ${result.pkgName}`;
    case 'unresolved':
      return `unresolved via chain at ${result.pkgName}`;
    case 'unknown':
      return `unknown via entry at ${result.pkgName}`;
    case 'other-advisory':
      return `non-excepted advisory ${result.id} in via chain at ${result.pkgName}`;
    default:
      return `via chain blocked at ${result.pkgName}`;
  }
}

export function everyBlockingViaChainEndsAtExcepted(audit) {
  const found = blockingPackageNames(audit);
  if (!found.ok) return found;
  for (const name of found.names) {
    const walked = walkViaChains(audit.vulnerabilities, name, new Set());
    if (!walked.ok) return { ok: false, reason: describeViaFailure(walked), names: found.names };
  }
  return { ok: true, names: found.names };
}

function patchedVersionValue(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && typeof value.identifier === 'string') {
    return value.identifier.trim();
  }
  return '';
}

export function picomatchPatchListed(advisory) {
  if (!advisory || typeof advisory !== 'object' || Array.isArray(advisory)) {
    return { ok: false, reason: 'advisory payload is not an object' };
  }
  if (!Array.isArray(advisory.vulnerabilities)) {
    return { ok: false, reason: 'advisory payload missing vulnerabilities' };
  }
  const rows = advisory.vulnerabilities.filter((row) => (
    row?.package?.ecosystem === 'npm' && row?.package?.name === 'picomatch'
  ));
  if (rows.length === 0) {
    return { ok: false, reason: 'advisory payload has no npm/picomatch vulnerability entry' };
  }
  for (const row of rows) {
    if (patchedVersionValue(row.first_patched_version)) return { ok: true, patched: true };
    if (typeof row.patched_versions === 'string') {
      const listed = row.patched_versions.trim();
      if (listed && listed !== '<none>' && listed.toLowerCase() !== 'none') return { ok: true, patched: true };
    }
  }
  return { ok: true, patched: false };
}

export function picomatchPresentInLsTree(lsJson) {
  if (!lsJson || typeof lsJson !== 'object' || Array.isArray(lsJson)) {
    return { ok: false, reason: 'npm ls JSON is not an object' };
  }
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    const deps = node.dependencies;
    if (!deps || typeof deps !== 'object') return false;
    for (const [key, child] of Object.entries(deps)) {
      if (key === 'picomatch') return true;
      if (child && child.name === 'picomatch') return true;
      if (walk(child)) return true;
    }
    return false;
  };
  return { ok: true, present: walk(lsJson) };
}

export async function fetchGithubAdvisory({
  fetchImpl = globalThis.fetch,
  advisoryId = EXCEPTED_ADVISORY_ID,
  token,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'advisory lookup fetch is unavailable' };
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agentwallet-sdk-security-check',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (typeof token === 'string' && token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }
  let response;
  try {
    response = await fetchImpl(advisoryId === EXCEPTED_ADVISORY_ID ? ADVISORY_URL : `https://api.github.com/advisories/${advisoryId}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, reason: 'advisory lookup request failed' };
  }
  if (!response || typeof response.ok !== 'boolean') {
    return { ok: false, reason: 'advisory lookup returned an unusable response' };
  }
  if (!response.ok) {
    return { ok: false, reason: `advisory lookup HTTP ${response.status}` };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'advisory lookup returned invalid JSON' };
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.vulnerabilities)) {
    return { ok: false, reason: 'advisory lookup returned an unexpected payload' };
  }
  if (typeof body.ghsa_id !== 'string' || body.ghsa_id.toUpperCase() !== advisoryId.toUpperCase()) {
    return { ok: false, reason: 'advisory lookup returned an unexpected payload' };
  }
  return { ok: true, advisory: body };
}

export async function runSecurityCheck({
  fullAudit,
  prodAudit,
  picomatchInProd,
  lookupAdvisory,
  nowMs = Date.now(),
} = {}) {
  const prodParsed = parseAuditReport(prodAudit, 'prod-only audit JSON');
  if (!prodParsed.ok) return fail(`security-check: ${prodParsed.reason}`);
  const prodBlocking = blockingPackageNames(prodParsed.audit);
  if (!prodBlocking.ok) return fail(`security-check: prod-only audit ${prodBlocking.reason}`);
  if (prodBlocking.names.length > 0) {
    return fail(`security-check: prod-only audit reported high/critical (${prodBlocking.names.join(', ')})`);
  }

  const fullParsed = parseAuditReport(fullAudit, 'full audit JSON');
  if (!fullParsed.ok) return fail(`security-check: ${fullParsed.reason}`);
  const chains = everyBlockingViaChainEndsAtExcepted(fullParsed.audit);
  if (!chains.ok) {
    return fail(`security-check: ${chains.reason}`);
  }
  if (chains.names.length === 0) {
    return pass('security-check: prod-only audit reports 0 high/critical; no high/critical findings to except');
  }

  if (picomatchInProd === true) {
    return fail('security-check: picomatch is present in the production tree; exception does not apply');
  }
  if (picomatchInProd !== false) {
    return fail('security-check: production picomatch presence could not be determined; exception not applied');
  }
  if (!Number.isFinite(nowMs) || nowMs >= EXCEPTION_EXPIRES_AT_MS) {
    return fail(`security-check: ${EXCEPTED_ADVISORY_ID} exception expired at ${EXCEPTION_EXPIRY_LABEL}`);
  }
  if (typeof lookupAdvisory !== 'function') {
    return fail('security-check: GitHub advisory lookup failed; exception not applied');
  }
  let lookup;
  try {
    lookup = await lookupAdvisory();
  } catch {
    return fail('security-check: GitHub advisory lookup failed; exception not applied');
  }
  if (!lookup || lookup.ok !== true || !lookup.advisory) {
    return fail('security-check: GitHub advisory lookup failed; exception not applied');
  }
  const patch = picomatchPatchListed(lookup.advisory);
  if (!patch.ok) {
    return fail(`security-check: ${patch.reason}; exception not applied`);
  }
  if (patch.patched) {
    return fail(`security-check: GitHub lists a patched picomatch for ${EXCEPTED_ADVISORY_ID}; exception not applied`);
  }
  return pass(
    `security-check: prod-only audit reports 0 high/critical; excepting ${chains.names.length} high/critical via ${EXCEPTED_ADVISORY_ID}`,
    EXCEPTION_WARNING,
  );
}

function npmJson(args) {
  const result = spawnSync('npm', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`npm ${args.join(' ')} failed to start`);
  }
  const stdout = (result.stdout ?? '').trim();
  if (!stdout) {
    throw new Error(`npm ${args.join(' ')} produced no JSON`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`npm ${args.join(' ')} produced invalid JSON`);
  }
}

export function readNpmAuditJson({ omitDev = false } = {}) {
  const args = omitDev ? ['audit', '--omit=dev', '--json'] : ['audit', '--json'];
  return npmJson(args);
}

export function detectPicomatchInProdTree(lsJson = npmJson(['ls', 'picomatch', '--omit=dev', '--all', '--json'])) {
  const present = picomatchPresentInLsTree(lsJson);
  if (!present.ok) return present;
  return { ok: true, present: present.present };
}

export async function main({
  readFullAudit = () => readNpmAuditJson({ omitDev: false }),
  readProdAudit = () => readNpmAuditJson({ omitDev: true }),
  readPicomatchInProd = detectPicomatchInProdTree,
  lookupAdvisory = () => fetchGithubAdvisory({ token: process.env.GITHUB_TOKEN }),
  nowMs = Date.now(),
  log = (line) => {
    process.stdout.write(`${line}\n`);
  },
} = {}) {
  try {
    const prodAudit = readProdAudit();
    const fullAudit = readFullAudit();
    const inProd = readPicomatchInProd();
    const picomatchInProd = inProd && inProd.ok === true ? inProd.present : null;
    const result = await runSecurityCheck({
      fullAudit,
      prodAudit,
      picomatchInProd,
      lookupAdvisory,
      nowMs,
    });
    for (const line of result.messages) log(line);
    return result.ok ? 0 : 1;
  } catch (err) {
    log(`security-check: ${err instanceof Error ? err.message : 'failed'}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] != null
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().then((code) => {
    process.exit(code);
  }).catch((err) => {
    process.stderr.write(`security-check: ${err instanceof Error ? err.message : 'failed'}\n`);
    process.exit(1);
  });
}

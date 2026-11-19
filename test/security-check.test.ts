import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXCEPTION_EXPIRES_AT_MS,
  EXCEPTION_WARNING,
  EXCEPTED_ADVISORY_ID,
  fetchGithubAdvisory,
  picomatchPresentInLsTree,
  runSecurityCheck,
} from '../scripts/security-check.mjs';

const root = join(import.meta.dirname, '..');
const fixtureDir = join(root, 'test/fixtures/security-check');
const load = (name: string) => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));

const prodClean = load('prod-clean.json');
const picomatchOnly = load('picomatch-only.json');
const mixedChain = load('mixed-chain.json');
const unrelatedHigh = load('unrelated-high.json');
const cyclicVia = load('cyclic-via.json');
const unresolvedVia = load('unresolved-via.json');
const moderateOnly = load('moderate-only.json');
const unpatched = load('advisory-unpatched.json');
const patched = load('advisory-patched.json');

const BEFORE_EXPIRY = Date.parse('2026-11-18T22:36:00.000Z');
const AFTER_EXPIRY = EXCEPTION_EXPIRES_AT_MS + 1;

function unpatchedLookup() {
  return async () => ({ ok: true as const, advisory: unpatched });
}

async function check(overrides: Record<string, unknown> = {}) {
  return runSecurityCheck({
    fullAudit: picomatchOnly,
    prodAudit: prodClean,
    picomatchInProd: false,
    nowMs: BEFORE_EXPIRY,
    lookupAdvisory: unpatchedLookup(),
    ...overrides,
  });
}

describe('SEC-20261117-02 R2 picomatch exception', () => {
  it('(a) picomatch-only chains pass with the warning', async () => {
    const result = await check();
    expect(result.ok).toBe(true);
    expect(result.warning).toBe(EXCEPTION_WARNING);
    expect(result.messages.join('\n')).toContain(EXCEPTED_ADVISORY_ID);
    expect(result.messages.join('\n')).toContain('2026-12-15 23:59 America/Chicago');
  });

  it('(b) a mixed chain (picomatch plus another high) fails', async () => {
    const result = await check({ fullAudit: mixedChain });
    expect(result.ok).toBe(false);
    expect(result.warning).toBeNull();
    expect(result.messages.join('\n')).toMatch(/non-excepted advisory GHSA-AAAA-BBBB-CCCC/i);
  });

  it('(c) an unrelated high fails', async () => {
    const result = await check({ fullAudit: unrelatedHigh });
    expect(result.ok).toBe(false);
    expect(result.warning).toBeNull();
    expect(result.messages.join('\n')).toMatch(/GHSA-ZZZZ-YYYY-XXXX/i);
  });

  it('(d) after expiry fails', async () => {
    const result = await check({ nowMs: AFTER_EXPIRY });
    expect(result.ok).toBe(false);
    expect(result.warning).toBeNull();
    expect(result.messages.join('\n')).toMatch(/expired/);
  });

  it('(e) patched-version-listed fails', async () => {
    const result = await check({
      lookupAdvisory: async () => ({ ok: true, advisory: patched }),
    });
    expect(result.ok).toBe(false);
    expect(result.warning).toBeNull();
    expect(result.messages.join('\n')).toMatch(/patched picomatch/);
  });

  it('(f) advisory lookup failure fails', async () => {
    const lookupFail = await check({
      lookupAdvisory: async () => ({ ok: false, reason: 'HTTP 500' }),
    });
    expect(lookupFail.ok).toBe(false);
    expect(lookupFail.messages.join('\n')).toMatch(/advisory lookup failed/);

    const thrown = await check({
      lookupAdvisory: async () => {
        throw new Error('network down');
      },
    });
    expect(thrown.ok).toBe(false);
    expect(thrown.messages.join('\n')).toMatch(/advisory lookup failed/);

    const fetchFail = await fetchGithubAdvisory({
      fetchImpl: async () => {
        throw new Error('refused');
      },
      token: '',
    });
    expect(fetchFail.ok).toBe(false);
  });

  it('(g) picomatch in the prod tree fails', async () => {
    const result = await check({ picomatchInProd: true });
    expect(result.ok).toBe(false);
    expect(result.warning).toBeNull();
    expect(result.messages.join('\n')).toMatch(/production tree/);
    expect(picomatchPresentInLsTree({
      name: 'agentwallet-sdk',
      dependencies: { vite: { name: 'vite', dependencies: { picomatch: { version: '4.0.7' } } } },
    })).toEqual({ ok: true, present: true });
    expect(picomatchPresentInLsTree({ name: 'agentwallet-sdk', version: '8.0.0' }))
      .toEqual({ ok: true, present: false });
  });

  it('(h) a cyclic or unresolved via chain fails', async () => {
    const cyclic = await check({ fullAudit: cyclicVia });
    expect(cyclic.ok).toBe(false);
    expect(cyclic.messages.join('\n')).toMatch(/cyclic via chain/);

    const unresolved = await check({ fullAudit: unresolvedVia });
    expect(unresolved.ok).toBe(false);
    expect(unresolved.messages.join('\n')).toMatch(/unresolved via chain/);
  });

  it('does not waive moderate findings and does not warn when nothing is excepted', async () => {
    const result = await check({ fullAudit: moderateOnly });
    expect(result.ok).toBe(true);
    expect(result.warning).toBeNull();
    expect(result.messages.join('\n')).not.toContain(EXCEPTION_WARNING);
  });

  it('fails closed when prod-only audit reports high/critical', async () => {
    const result = await check({ prodAudit: picomatchOnly, fullAudit: picomatchOnly });
    expect(result.ok).toBe(false);
    expect(result.messages.join('\n')).toMatch(/prod-only audit reported high\/critical/);
  });
});

describe('required jobs still call security-check', () => {
  it('replaces only the npm audit steps in build and verify', () => {
    const build = readFileSync(join(root, '.github/workflows/build.yml'), 'utf8');
    const verify = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(build).toContain('node scripts/security-check.mjs');
    expect(verify).toContain('node scripts/security-check.mjs');
    expect(build).not.toMatch(/npm audit --audit-level=high/);
    expect(verify).not.toMatch(/npm audit --audit-level=high/);
    expect(build).toMatch(/^\s+build:\s*$/m);
    expect(verify).toMatch(/^\s+verify:\s*$/m);
    expect(verify).toContain('name: Audit dependencies');
  });
});

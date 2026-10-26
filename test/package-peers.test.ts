/**
 * Every module the SDK loads lazily (dynamic `import('<package>')`) must be a
 * declared dependency, so package managers can install and validate it.
 * Optional integrations are optional peers. (Codex round 9)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** Bare package names passed to dynamic import() in shipped source. */
function lazyPackages(): string[] {
  const names = new Set<string>();
  for (const file of sources(join(ROOT, 'src'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      names.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    }
  }
  return [...names].sort();
}

describe('lazily loaded packages are declared (Codex round 9)', () => {
  const lazy = lazyPackages();

  it('finds the Stellar and Solana integrations', () => {
    expect(lazy).toEqual(expect.arrayContaining(['@stellar/stellar-sdk', '@solana/web3.js', '@solana/spl-token']));
  });

  it.each(lazy)('%s is a dependency or an optional peer', (name) => {
    if (pkg.dependencies?.[name]) return;
    expect(pkg.peerDependencies?.[name], `${name} peer range`).toMatch(/^>=\d+\.\d+\.\d+$/);
    expect(pkg.peerDependenciesMeta?.[name]?.optional, `${name} optional`).toBe(true);
  });

  it('keeps the lockfile root entry in sync with package.json', () => {
    expect(lock.packages[''].peerDependencies).toEqual(pkg.peerDependencies);
    expect(lock.packages[''].peerDependenciesMeta).toEqual(pkg.peerDependenciesMeta);
  });
});

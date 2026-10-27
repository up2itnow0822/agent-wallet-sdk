/**
 * The published tarball carries the built library only: no compiled tests
 * or test helpers. Runs after `npm run build` (as CI does).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

describe('npm package contents', () => {
  it('requires a build before checking the tarball', () => {
    expect(existsSync(join(ROOT, 'dist', 'index.js')), 'run `npm run build` first').toBe(true);
  });

  it('ships the library and no compiled tests', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' });
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    expect(files).toEqual(expect.arrayContaining(['dist/index.js', 'dist/index.d.ts', 'dist/x402/chains/stellar/index.js', 'package.json', 'README.md', 'LICENSE']));
    expect(files.filter((f) => /__tests__|\.test\./.test(f))).toEqual([]);
  }, 60_000);
});

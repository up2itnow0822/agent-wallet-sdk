/**
 * The package has one entry point (dist/index.js). Every value and type that a
 * submodule index re-exported by the root declares public must also be
 * exported from the root, so consumers never need an internal deep path.
 * (Codex review of #98, post-merge.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const entry = join(ROOT, 'src', 'index.ts');
const submodules = [...new Set(
  [...readFileSync(entry, 'utf8').matchAll(/from '\.\/([\w/-]+)\/index\.js'/g)].map((m) => m[1]),
)].sort();

const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, ROOT,
);
const files = [entry, ...submodules.map((m) => join(ROOT, 'src', m, 'index.ts'))];
const program = ts.createProgram(files, { ...config.options, noEmit: true });
const checker = program.getTypeChecker();
const exportsOf = (file: string) => {
  const sf = program.getSourceFile(file);
  const sym = sf && checker.getSymbolAtLocation(sf);
  return new Set(sym ? checker.getExportsOfModule(sym).map((s) => s.getName()) : []);
};
const rootExports = exportsOf(entry);

describe('package root re-exports every public submodule API', () => {
  it('finds the submodules the root re-exports', () => {
    expect(submodules).toEqual(expect.arrayContaining(['bridge', 'swap', 'x402']));
    expect(rootExports.size).toBeGreaterThan(100);
  });

  it.each(submodules)('src/%s/index.ts', (m) => {
    const missing = [...exportsOf(join(ROOT, 'src', m, 'index.ts'))].filter((n) => !rootExports.has(n));
    expect(missing).toEqual([]);
  });
}, 120_000);

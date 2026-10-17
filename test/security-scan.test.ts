import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const fixtures: string[] = [];
afterEach(() => fixtures.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function scan(contents: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'wallet-scan-'));
  fixtures.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'security-test@example.invalid');
  git('config', 'user.name', 'Security fixture');
  writeFileSync(join(dir, 'README.md'), 'fixture');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  for (const [name, body] of Object.entries(contents)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  git('add', '.'); git('commit', '-qm', 'changes');
  const head = git('rev-parse', 'HEAD');
  const scanner = join(root, 'scripts/security-scan.mjs');
  if (existsSync(scanner)) {
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(scanner, join(dir, 'scripts/security-scan.mjs'));
  }
  const workflow = readFileSync(join(root, '.github/workflows/security-review.yml'), 'utf8');
  const output = join(dir, 'output');
  const summary = join(dir, 'summary');
  const env = { ...process.env, BASE_SHA: base, HEAD_SHA: head, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary };
  // Exercise the actual workflow command, including its legacy changed-file step.
  const runs = [...workflow.matchAll(/        run: (?:\|\n((?:          .*\n|\n)+)|([^\n]+))/g)];
  let status: number | null = 0;
  let stdout = '';
  for (const run of runs) {
    const changed = existsSync(output) ? readFileSync(output, 'utf8').replace(/^files=/, '').trim() : '';
    const command = (run[1]?.replace(/^          /gm, '') ?? run[2])
      .replaceAll('${{ github.event.pull_request.base.sha }}', base)
      .replaceAll('${{ github.sha }}', head)
      .replaceAll('${{ steps.changed.outputs.files }}', changed);
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', command], { cwd: dir, env, encoding: 'utf8' });
    status = result.status;
    stdout += result.stdout;
    if (status !== 0) break;
  }
  return { dir, status, stdout };
}

describe('security workflow filename handling', () => {
  it('treats PR-controlled shell syntax and whitespace in filenames as data', () => {
    const result = scan({
      'src/$(touch SCAN_EXECUTED).ts': 'export const value = 1;',
      'src/name with spaces.ts': 'export const another = 2;',
      'src/line\nbreak.ts': 'export const third = 3;',
    });
    expect(existsSync(join(result.dir, 'SCAN_EXECUTED'))).toBe(false);
    expect(result.status).toBe(0);
  });

  it('fails the scan on a dangerous pattern in a filename containing spaces', () => {
    const result = scan({ 'src/payment handler.ts': "export const sign = () => console.log('private key');" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('CRITICAL:');
    expect(result.stdout).toContain('payment handler.ts');
  });
});

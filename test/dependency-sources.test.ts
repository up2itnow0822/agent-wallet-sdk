import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts/check-dependency-sources.mjs');
const FIXTURES = join(ROOT, 'test/fixtures/dep-sources');
const WORKFLOWS = join(ROOT, '.github/workflows');

function run(cwd: string, args: string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
}

function fixture(name: string) {
  return run(ROOT, [join(FIXTURES, name)]);
}

function workflowSources(): Array<{ file: string; src: string }> {
  return readdirSync(WORKFLOWS)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => ({ file, src: readFileSync(join(WORKFLOWS, file), 'utf8') }));
}

function installCommands(src: string): string[] {
  return [...src.matchAll(/^\s+run:\s*(.+)$/gm)].map((match) => match[1].trim());
}

describe('dependency source check (T0–T10, replay 79592d6)', () => {
  it('T0: current package.json and lockfile pass', () => {
    const result = run(ROOT);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('allowlist entries: (none)');
    expect(result.stdout).toContain('dependency sources: ok');
  });

  it('T1: npm: override fails', () => {
    const result = fixture('t1-npm-override');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('F1:');
    expect(result.stderr).toContain('overrides.picomatch');
  });

  it('T2: nested npm: override fails', () => {
    const result = fixture('t2-nested-override');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('F1:');
    expect(result.stderr).toContain('overrides.vitest.picomatch');
  });

  it('T3: npm: devDependency fails', () => {
    const result = fixture('t3-devdep-npm-alias');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('F1:');
    expect(result.stderr).toContain('devDependencies.foo');
  });

  it.each([
    ['t4-git', 'dependencies.foo'],
    ['t4-github', 'dependencies.foo'],
    ['t4-https-tarball', 'dependencies.foo'],
    ['t4-file', 'dependencies.foo'],
  ] as const)('T4: %s fails', (name, key) => {
    const result = fixture(name);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('F2:');
    expect(result.stderr).toContain(key);
  });

  it('T5: non-npmjs lock resolved fails', () => {
    const result = fixture('t5-non-npmjs-resolved');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('F3:');
    expect(result.stderr).toContain('node_modules/leftpad');
  });

  it('T6: lock name disagrees with node_modules path fails', () => {
    const result = fixture('t6-lock-name-mismatch');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('F4:');
    expect(result.stderr).toContain('node_modules/picomatch');
  });

  it('T7: lock entry missing integrity fails', () => {
    const result = fixture('t7-missing-integrity');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('F5:');
    expect(result.stderr).toContain('node_modules/leftpad');
  });

  it('T8: .npmrc registry other than registry.npmjs.org fails', () => {
    const result = fixture('t8-evil-npmrc');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('F6:');
    expect(result.stderr).toContain('.npmrc registry');
    expect(result.stderr).not.toMatch(/evil\.example|PATH=|HOME=/);
  });

  it('T9: malformed lockfile fails closed', () => {
    const result = fixture('t9-malformed-lock');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('F7:');
    expect(result.stderr).toContain('package-lock.json');
  });

  it('T9: missing lockfile fails closed', () => {
    const result = fixture('t9-missing-lock');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('F7:');
    expect(result.stderr).toContain('package-lock.json is missing');
  });

  it('T10: fixture-local allowlist passes and is printed', () => {
    const result = fixture('t10-allowlisted');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('package.json:devDependencies.foo');
    expect(result.stdout).toContain('dependency sources: ok');
    expect(result.stderr).toBe('');
  });

  it('replay 79592d6: picomatch npm: override and lock name mismatch fail', () => {
    const result = fixture('replay-79592d6');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('F1:');
    expect(result.stderr).toContain('overrides.picomatch');
    expect(result.stderr).toContain('F4:');
    expect(result.stderr).toContain('node_modules/picomatch');
  });

  it('p1: lockfile-only resolved alias fails F4', () => {
    const result = fixture('p1-lockfile-only-alias');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('F4:');
    expect(result.stderr).toContain('node_modules/picomatch');
  });

  it('p5: root lock npm: alias fails', () => {
    const result = fixture('p5-root-lock-npm-alias');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('F1:');
    expect(result.stderr).toContain('dependencies.picomatch');
  });
});

describe('dependency source check wiring', () => {
  it('ships an empty allowlist', () => {
    const allowlist = JSON.parse(
      readFileSync(join(ROOT, 'scripts/dependency-sources-allowlist.json'), 'utf8'),
    ) as { entries: unknown[] };
    expect(allowlist.entries).toEqual([]);
  });

  it('npm run security is the checker and does not replace audit', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.security).toBe('node scripts/check-dependency-sources.mjs');
    expect(pkg.scripts.security.startsWith('node scripts/check-dependency-sources.mjs')).toBe(true);
  });

  it('refuses --skip and does not honor a skip environment variable', () => {
    const skipped = spawnSync(process.execPath, [SCRIPT, '--skip'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', SKIP_DEPENDENCY_SOURCES: '1' },
    });
    expect(skipped.status).toBe(1);
    expect(skipped.stderr).toContain('F7:');
    expect(skipped.stderr).toContain('--skip');

    const envBypass = spawnSync(process.execPath, [SCRIPT], {
      cwd: join(FIXTURES, 't1-npm-override'),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', DEPENDENCY_SOURCES_SKIP: '1', SKIP: '1' },
    });
    expect(envBypass.status).toBe(1);
    expect(envBypass.stderr).toContain('F1:');
  });

  it('runs the pre-install check before every npm ci/install, then npm run security, and keeps audit', () => {
    const workflows = workflowSources();
    const build = workflows.find((item) => item.file === 'build.yml');
    expect(build, 'build.yml reports the required build check').toBeTruthy();
    expect(build?.src).toMatch(/^jobs:\n  #.*\n  build:/m);

    for (const { file, src } of workflows) {
      expect(src).not.toMatch(/continue-on-error:\s*true/);
      const commands = installCommands(src);
      const ciIndexes = commands
        .map((command, index) => ({ command, index }))
        .filter(({ command }) => /npm (ci|install)\b/.test(command));
      for (const { index } of ciIndexes) {
        expect(commands[index - 1], `${file} check must precede npm ci`).toBe(
          'node scripts/check-dependency-sources.mjs',
        );
        expect(commands.slice(index + 1)).toContain('npm run security');
        expect(commands.slice(index + 1).some((command) => command.startsWith('npm audit'))).toBe(true);
      }
    }
  });
});

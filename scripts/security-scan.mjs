import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, readFileSync } from 'node:fs';

const { BASE_SHA: base, HEAD_SHA: head } = process.env;
if (![base, head].every(sha => /^[0-9a-f]{40}$/i.test(sha ?? ''))) {
  throw new Error('Security scan requires full Git commit SHAs');
}

// NUL-delimited names are data passed to filesystem APIs, never shell source.
const names = execFileSync('git', ['diff', '--name-only', '-z', '--diff-filter=ACMR', `${base}...${head}`, '--'], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
}).split('\0').filter(Boolean);
const patterns = [
  ['CRITICAL', 'Potential key exposure', /console.*(?:private|secret|mnemonic|seed)/i],
  ['CRITICAL', 'Private key via CLI argument', /privateKey.*process\.argv|--private-key|--secret/],
  ['HIGH', 'Dynamic code execution', /eval\s*\(|new\s+Function\s*\(/],
];
const report = ['## Security pattern scan'];
let found = false;
for (const name of names) {
  if (!/^(src|contracts)\//.test(name) || !/\.(ts|sol)$/.test(name) || /\.d\.ts$/.test(name)) continue;
  if (/(?:^|\/)(?:__tests__|tests?)(?:\/)|\.(?:test|spec)\.ts$/.test(name)) continue;
  const label = JSON.stringify(name).replaceAll('`', '\\`');
  if (!lstatSync(name).isFile()) {
    report.push(`- CRITICAL: Refusing non-regular source file ${label}`);
    found = true;
    continue;
  }
  const lines = readFileSync(name, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const [severity, description, pattern] of patterns) {
      if (!pattern.test(lines[i])) continue;
      report.push(`- ${severity}: ${description} in ${label}, line ${i + 1}`);
      found = true;
    }
  }
}
if (!found) report.push('No configured security patterns detected. This is a heuristic check, not a security audit.');
const text = report.join('\n') + '\n';
process.stdout.write(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
process.exitCode = found ? 1 : 0;

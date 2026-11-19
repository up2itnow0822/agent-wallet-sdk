#!/usr/bin/env node
/**
 * Fail-closed dependency source guard. Node built-ins only; no network.
 * Reads package.json, package-lock.json, npm-shrinkwrap.json, .npmrc, and the
 * allowlist from disk. Unvalidated pnpm-lock.yaml / yarn.lock fail closed.
 * No --skip flag and no environment bypass.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MANIFEST_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
];
const LOCK_SPEC_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const NPMJS_HOST = 'registry.npmjs.org';
const ALLOWLIST_REL = 'scripts/dependency-sources-allowlist.json';

function failClosed(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  for (const arg of argv) {
    if (arg === '--skip' || arg.startsWith('--skip=')) {
      failClosed('F7: --skip is not supported');
    }
    if (arg.startsWith('-')) {
      failClosed(`F7: unknown argument ${arg}`);
    }
    positional.push(arg);
  }
  if (positional.length > 1) {
    failClosed('F7: expected at most one root directory argument');
  }
  return positional[0] ? resolve(positional[0]) : process.cwd();
}

function readText(filePath) {
  return readFileSync(filePath, 'utf8');
}

function parseJsonFile(filePath, label) {
  let text;
  try {
    text = readText(filePath);
  } catch {
    failClosed(`F7: ${label} is missing`);
  }
  try {
    return JSON.parse(text);
  } catch {
    failClosed(`F7: ${label} parse error`);
  }
}

function loadAllowlist(root) {
  const allowlistPath = join(root, ALLOWLIST_REL);
  if (!existsSync(allowlistPath)) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(readText(allowlistPath));
  } catch {
    failClosed(`F7: ${ALLOWLIST_REL} parse error`);
  }
  if (Array.isArray(parsed)) {
    if (!parsed.every((entry) => typeof entry === 'string')) {
      failClosed(`F7: ${ALLOWLIST_REL} entries must be strings`);
    }
    return parsed;
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
    if (!parsed.entries.every((entry) => typeof entry === 'string')) {
      failClosed(`F7: ${ALLOWLIST_REL} entries must be strings`);
    }
    return parsed.entries;
  }
  failClosed(`F7: ${ALLOWLIST_REL} must be [] or { "entries": [] }`);
}

function printAllowlist(entries) {
  if (entries.length === 0) {
    process.stdout.write('allowlist entries: (none)\n');
    return;
  }
  process.stdout.write('allowlist entries:\n');
  for (const entry of entries) {
    process.stdout.write(`  ${entry}\n`);
  }
}

function isNpmjsHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === NPMJS_HOST &&
      url.username === '' &&
      url.password === '' &&
      (url.port === '' || url.port === '443')
    );
  } catch {
    return false;
  }
}

function workspaceGlobs(manifest) {
  const workspaces = manifest?.workspaces;
  if (Array.isArray(workspaces)) return workspaces.filter((item) => typeof item === 'string');
  if (workspaces && Array.isArray(workspaces.packages)) {
    return workspaces.packages.filter((item) => typeof item === 'string');
  }
  return [];
}

function globToRegExp(glob) {
  const normalized = glob.replaceAll('\\', '/').replace(/\/+$/u, '');
  let pattern = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '*' && normalized[i + 1] === '*') {
      pattern += '.*';
      i += 1;
      if (normalized[i + 1] === '/') i += 1;
      continue;
    }
    if (char === '*') {
      pattern += '[^/]*';
      continue;
    }
    if ('\\^$+?.()|[]{}'.includes(char)) pattern += `\\${char}`;
    else pattern += char;
  }
  pattern += '$';
  return new RegExp(pattern);
}

function isDeclaredWorkspacePath(relPath, globs) {
  const normalized = relPath.replaceAll('\\', '/').replace(/\/+$/u, '');
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

function walkStringSpecs(value, keyPath, out) {
  if (typeof value === 'string') {
    out.push({ key: keyPath, spec: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStringSpecs(item, `${keyPath}[${index}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [child, nested] of Object.entries(value)) {
      walkStringSpecs(nested, `${keyPath}.${child}`, out);
    }
  }
}

function classifyManifestSpec(spec) {
  const trimmed = spec.trim();
  if (trimmed.toLowerCase().startsWith('npm:')) return 'F1';
  // Registry versions, ranges, and tags have no protocol and no path slash.
  if (/^(?:[a-z0-9.*x^~<>=|, \t_+-]+)$/iu.test(trimmed)) return null;
  return 'F2';
}

function nameFromNodeModulesPath(lockKey) {
  const marker = 'node_modules/';
  const index = lockKey.lastIndexOf(marker);
  if (index === -1) return null;
  const rest = lockKey.slice(index + marker.length);
  if (!rest) return null;
  if (rest.startsWith('@')) {
    const [scope, name] = rest.split('/');
    return name ? `${scope}/${name}` : rest;
  }
  return rest.split('/')[0] ?? rest;
}

function resolvedPathnameMatchesImplied(resolved, implied) {
  try {
    const pathname = decodeURIComponent(new URL(resolved).pathname);
    return pathname.startsWith(`/${implied}/-/`);
  } catch {
    return false;
  }
}

function isAbsoluteUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return Boolean(url.protocol);
  } catch {
    return false;
  }
}

function parseNpmrc(text) {
  const settings = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const withoutComment = line.replace(/[ \t][#;].*$/u, '');
    const eq = withoutComment.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutComment.slice(0, eq).trim();
    const value = withoutComment.slice(eq + 1).trim();
    settings.push({ key, value });
  }
  return settings;
}

function isRegistryNpmrcKey(key) {
  return key === 'registry' || key.endsWith(':registry');
}

const root = parseArgs(process.argv.slice(2));
const allowlist = loadAllowlist(root);
printAllowlist(allowlist);
const allowed = new Set(allowlist);

const findings = [];

function note(code, id, detail) {
  findings.push({ code, id, detail });
}

function noteSpecs(container, fields, idPrefix) {
  for (const field of fields) {
    if (!(field in container)) continue;
    const specs = [];
    walkStringSpecs(container[field], field, specs);
    for (const { key, spec } of specs) {
      const code = classifyManifestSpec(spec);
      if (code === 'F1') note('F1', `${idPrefix}${key}`, `${key} uses npm: alias`);
      else if (code === 'F2') note('F2', `${idPrefix}${key}`, `${key} uses a non-registry spec`);
    }
  }
}

const packageJsonPath = join(root, 'package.json');
if (!existsSync(packageJsonPath)) failClosed('F7: package.json is missing');
const manifest = parseJsonFile(packageJsonPath, 'package.json');
const globs = workspaceGlobs(manifest);

noteSpecs(manifest, MANIFEST_FIELDS, 'package.json:');

if (manifest.publishConfig && typeof manifest.publishConfig === 'object' && !Array.isArray(manifest.publishConfig)) {
  for (const [key, value] of Object.entries(manifest.publishConfig)) {
    if (!isRegistryNpmrcKey(key)) continue;
    if (!isNpmjsHttpsUrl(value)) {
      note('F6', `package.json:publishConfig.${key}`, `publishConfig.${key}`);
    }
  }
}

for (const name of ['pnpm-lock.yaml', 'yarn.lock']) {
  if (existsSync(join(root, name))) {
    note('F7', name, `${name} is present and not validated`);
  }
}

function checkLockDocument(lockfile, fileLabel) {
  const version = lockfile?.lockfileVersion;
  if (typeof version !== 'number' || version < 2) {
    note('F7', `${fileLabel}:lockfileVersion`, `${fileLabel} lockfileVersion`);
  }
  const packages = lockfile?.packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    note('F7', `${fileLabel}:packages`, `${fileLabel} packages`);
    return;
  }
  for (const [lockKey, meta] of Object.entries(packages)) {
    if (!meta || typeof meta !== 'object') {
      note('F7', `${fileLabel}:${lockKey}`, `${lockKey} is not an object`);
      continue;
    }
    if (lockKey === '') {
      noteSpecs(meta, LOCK_SPEC_FIELDS, `${fileLabel}:`);
      continue;
    }

    const workspaceRecord = isDeclaredWorkspacePath(lockKey, globs);
    const workspaceLink =
      meta.link === true &&
      typeof meta.resolved === 'string' &&
      !meta.resolved.includes('://') &&
      isDeclaredWorkspacePath(meta.resolved, globs);
    const workspaceExempt = workspaceRecord || workspaceLink;

    if (!workspaceExempt) {
      if (!isNpmjsHttpsUrl(meta.resolved)) {
        note('F3', `${fileLabel}:${lockKey}:resolved`, `${lockKey} resolved`);
      }
      if (typeof meta.integrity !== 'string' || meta.integrity.length === 0) {
        note('F5', `${fileLabel}:${lockKey}:integrity`, `${lockKey} integrity`);
      }
    }

    const implied = nameFromNodeModulesPath(lockKey);
    if (!implied) continue;
    const nameFieldMismatch =
      typeof meta.name === 'string' && meta.name.length > 0 && meta.name !== implied;
    const resolvedNameMismatch =
      !workspaceExempt && isAbsoluteUrl(meta.resolved) && !resolvedPathnameMatchesImplied(meta.resolved, implied);
    if (nameFieldMismatch || resolvedNameMismatch) {
      note('F4', `${fileLabel}:${lockKey}:name`, `${lockKey} name`);
    }
  }
}

const lockPath = join(root, 'package-lock.json');
const shrinkPath = join(root, 'npm-shrinkwrap.json');
const hasLock = existsSync(lockPath);
const hasShrink = existsSync(shrinkPath);
if (!hasLock && !hasShrink) {
  note('F7', 'package-lock.json', 'package-lock.json is missing');
} else {
  const lockfile = hasLock ? parseJsonFile(lockPath, 'package-lock.json') : null;
  const shrinkwrap = hasShrink ? parseJsonFile(shrinkPath, 'npm-shrinkwrap.json') : null;
  if (hasLock && hasShrink && JSON.stringify(lockfile) !== JSON.stringify(shrinkwrap)) {
    note('F7', 'npm-shrinkwrap.json', 'package-lock.json and npm-shrinkwrap.json differ');
  }
  if (hasLock) checkLockDocument(lockfile, 'package-lock.json');
  if (hasShrink) checkLockDocument(shrinkwrap, 'npm-shrinkwrap.json');
}

const npmrcPath = join(root, '.npmrc');
if (existsSync(npmrcPath)) {
  let npmrcText;
  try {
    npmrcText = readText(npmrcPath);
  } catch {
    failClosed('F7: .npmrc parse error');
  }
  for (const { key, value } of parseNpmrc(npmrcText)) {
    if (!isRegistryNpmrcKey(key)) continue;
    if (!isNpmjsHttpsUrl(value)) {
      note('F6', `.npmrc:${key}`, `.npmrc ${key}`);
    }
  }
}

const blocked = [];
for (const finding of findings) {
  if (allowed.has(finding.id)) continue;
  blocked.push(finding);
}

if (blocked.length > 0) {
  for (const finding of blocked) {
    process.stderr.write(`${finding.code}: ${finding.detail}\n`);
  }
  process.exit(1);
}

process.stdout.write('dependency sources: ok\n');
process.exit(0);

import { spawnSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(scriptPath, '../..');

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Quality checks require Node.js 24 or newer.');
  process.exit(1);
}

// V8 supplies real ESM import metadata, without evaluating application modules.
// Keep this experimental development-only API out of the application runtime.
if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath, [
    '--experimental-vm-modules', '--disable-warning=ExperimentalWarning', scriptPath,
  ], { stdio: 'inherit' });
  if (child.error) console.error(child.error.message);
  process.exit(child.status ?? 1);
}

const failures = [];
const excludedFiles = new Set(['public/policy-options-worker.js']);
const boundaries = [
  { layer: 'src/core/', allowed: ['src/core/', 'data/'] },
  { layer: 'src/http/', allowed: ['src/http/', 'src/core/'] },
  { layer: 'src/ai/', allowed: ['src/ai/', 'src/core/'] },
  { layer: 'src/browser/', allowed: ['src/browser/', 'src/core/', 'data/'] },
  { layer: 'public/', allowed: ['public/'] },
];

function localName(path) {
  return relative(root, path).split(sep).join('/');
}

function isWithinRoot(path) {
  const name = relative(root, path);
  return name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const name = localName(path);
    if (name === 'public/vendor' || excludedFiles.has(name)) continue;
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

async function checkImports(file, source) {
  const name = localName(file);
  const boundary = boundaries.find(({ layer }) => name.startsWith(layer));
  const module = new vm.SourceTextModule(source, { identifier: name });
  let count = 0;
  for (const specifier of module.dependencySpecifiers) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      if (boundary) failures.push(`${name}: ${specifier} violates the ${boundary.layer} dependency boundary`);
      continue;
    }
    count += 1;
    const target = fileURLToPath(new URL(specifier, pathToFileURL(file)));
    const targetName = localName(target);
    if (!isWithinRoot(target)) {
      failures.push(`${name}: import escapes the repository: ${specifier}`);
      continue;
    }
    try {
      if (!(await stat(target)).isFile()) throw new Error('target is not a file');
    } catch {
      failures.push(`${name}: import target is missing or not a file: ${specifier}`);
    }
    if (boundary && !boundary.allowed.some((prefix) => targetName.startsWith(prefix))) {
      failures.push(`${name}: ${targetName} violates the ${boundary.layer} dependency boundary`);
    }
  }
  return count;
}

async function checkSecurityHeaders() {
  const { SECURITY_HEADERS } = await import('../src/http/policy.js');
  const expected = new Map(Object.entries(SECURITY_HEADERS).map(([name, value]) => [name.toLowerCase(), value]));
  const actual = new Map();
  const lines = (await readFile(resolve(root, 'public/_headers'), 'utf8'))
    .split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (lines.shift()?.trim() !== '/*') {
    throw new Error('public/_headers must begin with the global /* rule');
  }
  for (const line of lines) {
    const header = /^\s+([^:\s]+):\s*(.*?)\s*$/.exec(line);
    if (!header) throw new Error('public/_headers: unsupported rule; update this check when adding scoped rules');
    const [, name, value] = header;
    const key = name.toLowerCase();
    if (actual.has(key)) throw new Error(`public/_headers: duplicate ${name}`);
    actual.set(key, value);
  }
  for (const name of new Set([...expected.keys(), ...actual.keys()])) {
    if (expected.get(name) !== actual.get(name)) {
      failures.push(`public/_headers: ${name} differs from src/http/policy.js SECURITY_HEADERS`);
    }
  }
  return expected.size;
}

async function main() {
  const files = (await Promise.all(['src', 'public', 'tests', 'scripts']
    .map((directory) => sourceFiles(resolve(root, directory))))).flat();
  let imports = 0;
  for (const file of files) {
    const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (syntax.status !== 0) {
      failures.push(`${localName(file)}: syntax check failed\n${syntax.stderr || syntax.error?.message || ''}`);
      continue;
    }
    imports += await checkImports(file, await readFile(file, 'utf8'));
  }
  const headers = await checkSecurityHeaders();
  if (failures.length) {
    console.error(failures.map((failure) => `FAIL ${failure}`).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`Quality checks passed: ${files.length} authored JavaScript files, ${imports} relative static imports, dependency boundaries, ${headers} shared security headers.`);
  console.log('Excluded: public/vendor/** and generated public/policy-options-worker.js. Dynamic imports and runtime behavior require tests/review.');
}

await main().catch((error) => {
  console.error(`Quality check failed: ${error.message}`);
  process.exitCode = 1;
});

// Guard tests for the TypeScript rule (TS-STEP-1, closing commit of 5 November 2026). They need
// no exiftool, ImageMagick or browser, so the release workflow runs them next to
// tools/build-ts.sh in check mode; npm test runs them with the engine tests.
//
// The rule: the code is TypeScript. The only JavaScript in the repository is what
// tools/build-ts.sh compiles from it (app.js, src/, the Android bridge script), plus gate.js,
// which build-gates.py at the root of the GitHub folder writes for every Labs app. Each compiled
// file has its source, says so in its first comment, and is marked linguist-generated; nothing
// else is. The sources, the build and its settings are never published (_config.yml) or bundled
// into the APK (APK_EXCLUDES in android/app/build.gradle.kts). No .env is ever tracked.
//
// tools/build-ts.sh check mode proves that each compiled file is what its source compiles to;
// these tests prove that the tree holds nothing outside that rule.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const IN_GIT = existsSync(join(ROOT, '.git'));
const BRIDGE = 'android/web-overlay/android-bridge.js';

const git = (...args: string[]): string => {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/** Every file under a folder of the repository, as paths relative to the root. */
const SKIP = new Set(['node_modules', '.git', 'android/.gradle', 'android/build', 'android/app/build', 'android/.kotlin', 'tests/fixtures/out']);
const walk = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((name) => {
  const rel = dir ? `${dir}/${name}` : name;
  if (SKIP.has(rel)) return [];
  return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
});

/** The repository's files: tracked and not ignored in a git checkout, else everything on disk. */
const repoFiles = (): string[] => IN_GIT
  ? [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))]
  : walk('');

/** The compiled files and their sources: ts/x.ts gives x.js; the bridge's source sits beside it. */
const compiled = (): Map<string, string> => {
  const out = new Map<string, string>();
  for (const src of walk('ts')) {
    if (src.endsWith('.ts') && !src.endsWith('.d.ts')) out.set(src.slice('ts/'.length).replace(/\.ts$/, '.js'), src);
  }
  out.set(BRIDGE, BRIDGE.replace(/\.js$/, '.ts'));
  return out;
};

/** The paths .gitattributes marks linguist-generated (each line is one exact path). */
const markedGenerated = (): string[] => read('.gitattributes').split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split(/\s+/))
  .filter(([, ...attrs]) => attrs.includes('linguist-generated=true'))
  .map(([pattern]) => (pattern ?? '').replace(/^\//, ''));

test('the only JavaScript in the repository is compiled output and gate.js', () => {
  const js = repoFiles().filter((f) => /\.(js|mjs|cjs)$/.test(f)).sort();
  const allowed = [...compiled().keys(), 'gate.js'].sort();
  assert.deepEqual(js, allowed, 'JavaScript other than the compiled files and gate.js');
  // The page's sources are all there: the interface, the engine and the bridge.
  for (const f of ['app.js', 'src/scrub-core.js', BRIDGE]) assert.ok(allowed.includes(f), `${f} is compiled from TypeScript`);
});

test('each compiled file has its TypeScript source and names it in its first comment', () => {
  for (const [js, src] of compiled()) {
    assert.ok(existsSync(join(ROOT, src)), `${src} exists`);
    assert.ok(existsSync(join(ROOT, js)), `${js} exists (run tools/build-ts.sh)`);
    const text = read(js);
    const head = js === BRIDGE
      ? '"use strict";\n/*! android-bridge.js is compiled from android-bridge.ts beside it by tools/build-ts.sh'
      : `/*! ${js} is compiled from ${src} by tools/build-ts.sh`;
    assert.ok(text.startsWith(head), `${js} starts with its header`);
  }
});

test('.gitattributes marks exactly the generated files', () => {
  const generated = [...compiled().keys(), 'gate.js'].sort();
  assert.deepEqual(markedGenerated().sort(), generated);
  if (IN_GIT) {
    const out = git('check-attr', '-z', 'linguist-generated', '--', ...generated).split('\0');
    for (let i = 0; i + 2 < out.length; i += 3) assert.equal(out[i + 2], 'true', `${out[i]} is linguist-generated (git)`);
    // A source is never marked: it is what people write.
    const sources = [...compiled().values()];
    const srcOut = git('check-attr', '-z', 'linguist-generated', '--', ...sources).split('\0');
    for (let i = 0; i + 2 < srcOut.length; i += 3) assert.notEqual(srcOut[i + 2], 'true', `${srcOut[i]} is not marked generated`);
  }
});

test('the JavaScript checker of the move is gone', () => {
  for (const f of ['jsconfig.json', 'types', 'tools/js-to-convert.txt', 'tests/index.js']) {
    assert.ok(!existsSync(join(ROOT, f)), `${f} was retired in the closing commit`);
  }
  const build = read('tools/build-ts.sh');
  for (const word of ['jsconfig', 'js-to-convert', 'stamped-imports']) assert.ok(!build.includes(word), `tools/build-ts.sh still names ${word}`);
  const testsConfig = read('tests/tsconfig.json');
  for (const option of ['allowJs', 'checkJs', '"paths"']) assert.ok(!testsConfig.includes(option), `tests/tsconfig.json still sets ${option}`);
  // The tests import the engine as #src/x.js: Node runs the served src/x.js, the checker reads ts/src/x.ts.
  const pkg = JSON.parse(read('package.json')) as { imports?: Record<string, unknown> };
  assert.deepEqual(pkg.imports, { '#src/*.js': { types: './ts/src/*.ts', default: './src/*.js' } });
});

test('the TypeScript and its build are never published or bundled into the APK', () => {
  const config = read('_config.yml');
  const excluded = new Set([...config.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((m) => m[1]));
  for (const f of ['ts/', 'tools/', 'tsconfig.json', 'tsconfig.core.json', 'package.json', 'package-lock.json', 'node_modules/', 'tests/']) {
    assert.ok(excluded.has(f), `_config.yml excludes ${f}`);
  }
  const gradle = read('android/app/build.gradle.kts');
  const start = gradle.indexOf('val APK_EXCLUDES = listOf(');
  assert.ok(start > 0, 'build.gradle.kts has APK_EXCLUDES');
  // The list ends at the line that holds only its closing parenthesis.
  const apk = gradle.slice(start, gradle.indexOf('\n    )\n', start));
  for (const f of ['ts/**', 'tools/**', 'tsconfig.json', 'tsconfig.core.json', 'package.json', 'package-lock.json', 'node_modules/**', 'tests/**']) {
    assert.ok(apk.includes(`"${f}"`), `APK_EXCLUDES has ${f}`);
  }
  // .npmrc and .gitattributes are dot files: Jekyll never publishes them, and the APK build
  // repeats that rule.
  assert.match(gradle, /JEKYLL_DEFAULT_EXCLUDES = listOf\("\*\*\/\.\*"/);
  // The APK serves no .ts file.
  assert.match(gradle, /ALLOWED_EXTENSIONS = setOf\((?![^)]*"ts")[^)]*\)/);
});

test('no .env file is tracked, and .gitignore keeps them out', () => {
  const tracked = IN_GIT ? git('ls-files', '-z').split('\0').filter(Boolean) : walk('');
  const env = tracked.filter((f) => /(^|\/)\.env(\..*)?$/.test(f) && !f.endsWith('.env.example'));
  assert.deepEqual(env, [], 'a .env file is in the repository');
  const ignore = read('.gitignore').split('\n').map((l) => l.trim());
  for (const line of ['.env', '.env.*', '!.env.example']) assert.ok(ignore.includes(line), `.gitignore has ${line}`);
});

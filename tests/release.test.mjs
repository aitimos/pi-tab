import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {classifyCommit, nextVersion, parseVersion, planRelease, prepareRelease, publishRelease, verifyRelease} from '../scripts/release.mjs';

const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tab-release-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const cwd = join(directory, 'repo'), remote = join(directory, 'remote.git');
  mkdirSync(cwd);
  git(directory, 'init', '--bare', '--initial-branch=main', remote);
  git(cwd, 'init', '--initial-branch=main');
  git(cwd, 'config', 'user.name', 'Release test');
  git(cwd, 'config', 'user.email', 'release@example.test');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  git(cwd, 'config', 'tag.gpgsign', 'false');
  for (const path of ['extension', 'dist', 'oauth']) mkdirSync(join(cwd, path));
  const version = '1.0.34';
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({version, scripts: {build: 'node build.mjs', test: 'node fixture.test.mjs'}}));
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({version, lockfileVersion: 3, packages: {'': {version}}}));
  writeFileSync(join(cwd, 'extension/manifest.json'), JSON.stringify({manifest_version: 3, version}));
  writeFileSync(join(cwd, 'CHANGELOG.md'), '# 更新记录\n\n## v1.0.34 — 2026-10-30\n\n- Existing history.\n');
  writeFileSync(join(cwd, 'pi-bookmarklet-chat-install.html'), '<html>installer</html>');
  writeFileSync(join(cwd, 'oauth/test.js'), '// OAuth fixture\n');
  writeFileSync(join(cwd, 'fixture.test.mjs'), "import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; assert.equal(JSON.parse(readFileSync('package.json')).version, JSON.parse(readFileSync('extension/manifest.json')).version);\n");
  // Small real ZIP: exercises the same archive verification as production.
  writeFileSync(join(cwd, 'build.mjs'), `
import {mkdirSync, copyFileSync, mkdtempSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
mkdirSync('dist/extension', {recursive:true});
copyFileSync('extension/manifest.json', 'dist/extension/manifest.json');
const temp = mkdtempSync(join(tmpdir(), 'pi-release-zip-'));
mkdirSync(join(temp, 'pi-tab-extension'));
copyFileSync('extension/manifest.json', join(temp, 'pi-tab-extension/manifest.json'));
execFileSync('zip', ['-q', resolve('dist/pi-tab-extension.zip'), 'pi-tab-extension/manifest.json'], {cwd:temp});
rmSync(temp, {recursive:true, force:true});
`);
  execFileSync(process.execPath, ['build.mjs'], {cwd});
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'chore: initial release');
  git(cwd, 'tag', 'v1.0.34');
  git(cwd, 'remote', 'add', 'origin', remote);
  git(cwd, 'push', '-u', 'origin', 'main', '--tags');
  const commit = message => {
    appendFileSync(join(cwd, 'changes.txt'), message + '\n');
    git(cwd, 'add', 'changes.txt');
    git(cwd, 'commit', '-m', message);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  return {directory, cwd, remote, commit, push: () => git(cwd, 'push', 'origin', 'main')};
}

test('release levels follow conventional commits, including scopes and breaking footers', () => {
  for (const [message, level] of [
    ['fix: repair', 1], ['perf(engine): faster', 1], ['feat(linux): add tools', 2],
    ['feat!: new format', 3], ['fix(api)!: remove format', 3],
    ['chore: replace protocol\n\nBREAKING CHANGE: previous requests are invalid', 3],
    ['refactor: clean up\n\nBREAKING-CHANGE: remove old option', 3],
    ['refactor: clean up\n\nBREAKING CHANGE:\nremove old option', 3],
    ['docs: usage', 0], ['test: coverage', 0], ['ci: release', 0], ['chore: dependencies', 0],
    ['unstructured message', 0], ['docs: explain BREAKING CHANGE: syntax', 0],
  ]) assert.equal(classifyCommit(message).level, level, message);
});

test('version increments use integer components and reset only lower components', () => {
  assert.equal(nextVersion('1.0.34', 1), '1.0.35');
  assert.equal(nextVersion('1.0.9', 1), '1.0.10');
  assert.equal(nextVersion('1.0.99', 1), '1.0.100');
  assert.equal(nextVersion('1.99.34', 2), '1.100.0');
  assert.equal(nextVersion('1.9.99', 3), '2.0.0');
  assert.equal(nextVersion('0.9.9', 3), '1.0.0');
  for (const version of ['1.0.65535', '65535.0.0']) assert.throws(() => nextVersion(version, version.startsWith('65535') ? 3 : 1), /65535/);
  for (const version of ['01.0.0', '1.0', '1.0.0-rc.1', '0.0.0']) assert.throws(() => parseVersion(version));
});

test('planning includes merged feature commits, ignores prerelease tags and leaves files untouched', t => {
  const f = fixture(t);
  git(f.cwd, 'checkout', '-b', 'feature');
  f.commit('feat(linux): add tools');
  git(f.cwd, 'tag', 'v9.0.0-rc.1');
  git(f.cwd, 'checkout', 'main');
  writeFileSync(join(f.cwd, 'fix.txt'), 'fix');
  git(f.cwd, 'add', 'fix.txt');
  git(f.cwd, 'commit', '-m', 'fix: repair browser tests');
  git(f.cwd, 'merge', '--no-ff', 'feature', '-m', 'Merge feature');
  f.push();
  const before = readFileSync(join(f.cwd, 'package.json'), 'utf8');
  const plan = planRelease(f.cwd);
  assert.equal(plan.version, '1.1.0');
  assert.equal(plan.changes.length, 2);
  assert.equal(readFileSync(join(f.cwd, 'package.json'), 'utf8'), before);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
  f.commit('fix(api)!: drop old format'); f.push();
  assert.equal(planRelease(f.cwd).version, '2.0.0');
});

test('docs-only history and outdated tested commits do not release', t => {
  const f = fixture(t);
  f.commit('docs: explain usage'); f.push();
  assert.equal(planRelease(f.cwd).action, 'skip');
  const tested = f.commit('fix: repair'); f.push();
  f.commit('feat: newer untested feature'); f.push();
  assert.match(planRelease(f.cwd, tested).reason, /main has moved/);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
});

test('prepare keeps version files and release notes aligned, and verifies actual ZIP contents', t => {
  const f = fixture(t);
  f.commit('fix: repair quotes'); f.commit('docs: explain files'); f.push();
  const history = readFileSync(join(f.cwd, 'CHANGELOG.md'), 'utf8');
  const plan = planRelease(f.cwd);
  prepareRelease(f.cwd, plan, '2026-11-01');
  assert.equal(JSON.parse(readFileSync(join(f.cwd, 'package-lock.json'))).packages[''].version, '1.0.35');
  const changelog = readFileSync(join(f.cwd, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## v1\.0\.35 — 2026-11-01/);
  assert.match(changelog, /### 修复与性能改进\n\n- fix: repair quotes/);
  assert.match(changelog, /### 其他更新\n\n- docs: explain files/);
  assert.ok(changelog.endsWith(history.slice(history.indexOf('\n'))));
  assert.throws(() => verifyRelease(f.cwd, plan.version), /Version files disagree/);
  execFileSync(process.execPath, ['build.mjs'], {cwd: f.cwd});
  verifyRelease(f.cwd, plan.version);
  writeFileSync(join(f.cwd, 'extension/manifest.json'), JSON.stringify({version: '1.0.36'}));
  execFileSync(process.execPath, ['build.mjs'], {cwd: f.cwd});
  for (const path of ['extension/manifest.json', 'dist/extension/manifest.json']) writeFileSync(join(f.cwd, path), JSON.stringify({version: plan.version}));
  assert.throws(() => verifyRelease(f.cwd, plan.version), /ZIP manifest version disagrees/);
});

test('an existing conflicting version tag is never replaced', t => {
  const f = fixture(t);
  git(f.cwd, 'checkout', '-b', 'other');
  f.commit('feat!: unrelated release'); git(f.cwd, 'tag', 'v1.0.35');
  git(f.cwd, 'checkout', 'main');
  f.commit('fix: repair'); f.push();
  assert.throws(() => planRelease(f.cwd), /already exists/);
});

test('failed validation cannot push a release commit or tag', t => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, 'fixture.test.mjs'), "throw new Error('regression detected');\n");
  git(f.cwd, 'add', 'fixture.test.mjs');
  const source = f.commit('fix: repair'); f.push();
  assert.throws(() => publishRelease(f.cwd, source), /npm test/);
  assert.equal(git(f.remote, 'rev-parse', 'main'), source);
  assert.equal(git(f.remote, 'tag', '--list'), 'v1.0.34');
});

test('publishing atomically pushes a version commit and tag, then resumes failed uploads without another bump', t => {
  const f = fixture(t);
  const source = f.commit('feat: Linux tools'); f.push();
  const bin = join(f.directory, 'bin'); mkdirSync(bin);
  const log = join(f.directory, 'gh.log'), state = join(f.directory, 'release-created'), fail = join(f.directory, 'fail-upload');
  const publishedNotes = join(f.directory, 'published-notes.md');
  writeFileSync(fail, 'fail once');
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if(args.includes('--notes-file'))fs.copyFileSync(args[args.indexOf('--notes-file')+1], ${JSON.stringify(publishedNotes)});
if(args[1] === 'view' && !fs.existsSync(${JSON.stringify(state)})){console.error('release not found');process.exit(1);}
if(args[1] === 'create')fs.writeFileSync(${JSON.stringify(state)}, 'draft');
if(args[1] === 'upload' && fs.existsSync(${JSON.stringify(fail)})){fs.unlinkSync(${JSON.stringify(fail)});console.error('upload interrupted');process.exit(1);}
`);
  chmodSync(gh, 0o755);
  const oldPath = process.env.PATH, oldOutput = process.env.GITHUB_OUTPUT;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.GITHUB_OUTPUT = join(f.directory, 'outputs');
  t.after(() => {
    process.env.PATH = oldPath;
    if (oldOutput === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = oldOutput;
  });
  assert.throws(() => publishRelease(f.cwd, source), /upload/);
  const releaseSha = git(f.remote, 'rev-parse', 'refs/heads/main');
  assert.equal(git(f.remote, 'rev-parse', 'refs/tags/v1.1.0'), releaseSha);
  assert.equal(git(f.cwd, 'rev-parse', `${releaseSha}^`), source);
  assert.match(git(f.cwd, 'show', '-s', '--format=%B', releaseSha), new RegExp(`Release-Source: ${source}`));
  assert.equal(existsSync(process.env.GITHUB_OUTPUT), false, 'Pages must not run after failed upload');
  assert.equal(planRelease(f.cwd, source).action, 'resume');
  assert.equal(planRelease(f.cwd, releaseSha).action, 'resume', 'manual dispatch on the release commit');
  const resumed = publishRelease(f.cwd, source);
  assert.equal(resumed.releaseSha, releaseSha);
  assert.equal(git(f.cwd, 'tag', '--list', 'v1.1.*'), 'v1.1.0');
  assert.match(readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), new RegExp(`sha=${releaseSha}\\ntag=v1.1.0`));
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args[1] === 'create').length, 1);
  assert.ok(calls.find(args => args[1] === 'create').includes('--draft'));
  assert.deepEqual(calls.filter(args => args[1] === 'upload').at(-1).slice(3), ['dist/pi-tab-extension.zip', 'pi-bookmarklet-chat-install.html', '--clobber']);
  assert.ok(calls.at(-1).includes('--latest'));
  const releaseSection = readFileSync(join(f.cwd, 'CHANGELOG.md'), 'utf8').split('\n## ')[1];
  assert.equal(readFileSync(publishedNotes, 'utf8'), releaseSection.slice(releaseSection.indexOf('\n') + 1).trim() + '\n');
  git(f.cwd, 'checkout', '-B', 'main', 'origin/main');
  f.commit('feat: newer release'); f.push();
  assert.equal(publishRelease(f.cwd, source).action, 'skip');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, calls.length, 'Old reruns must not change Latest');
});

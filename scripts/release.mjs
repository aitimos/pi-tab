import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const versionFiles = ['package.json', 'package-lock.json', 'extension/manifest.json'];
const releasePaths = [...versionFiles, 'CHANGELOG.md', 'dist', 'oauth', 'pi-bookmarklet-chat-install.html'];
const run = (cwd, command, args, options = {}) => execFileSync(command, args, {cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options});
const git = (cwd, ...args) => run(cwd, 'git', args).trim();

export function parseVersion(version) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Expected X.Y.Z without leading zeroes');
  const parts = version.split('.').map(Number);
  assert.ok(parts.every(n => n <= 65535) && parts.some(n => n > 0), 'Chrome version components must be 0–65535 and not all zero');
  return parts;
}

export function classifyCommit(message) {
  const [subject, ...body] = message.trim().split('\n');
  const header = /^(\w+)(?:\([^\r\n()]+\))?(!)?:\s+(.+)$/.exec(subject);
  const breaking = !!header?.[2] || body.some(line => /^BREAKING(?: CHANGE|-CHANGE):(?:\s|$)/.test(line));
  const type = header?.[1];
  return {subject, type, level: breaking ? 3 : type === 'feat' ? 2 : ['fix', 'perf'].includes(type) ? 1 : 0};
}

export function nextVersion(version, level) {
  const parts = parseVersion(version);
  assert.ok([1, 2, 3].includes(level), 'Expected a release level');
  const index = 3 - level;
  parts[index]++;
  parts.fill(0, index + 1);
  const next = parts.join('.');
  parseVersion(next);
  return next;
}

export function planRelease(cwd, source = 'HEAD', main = 'origin/main') {
  const sourceSha = git(cwd, 'rev-parse', '--verify', '--end-of-options', `${source}^{commit}`);
  const mainSha = git(cwd, 'rev-parse', '--verify', '--end-of-options', `${main}^{commit}`);
  const tags = git(cwd, 'tag', '--merged', mainSha, '--sort=-version:refname', '--list', 'v*')
    .split('\n').filter(tag => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag));
  assert.ok(tags.length, 'No reachable stable version tag found');
  const baseTag = tags[0];
  const baseVersion = baseTag.slice(1);
  parseVersion(baseVersion);
  const tagSha = git(cwd, 'rev-parse', `${baseTag}^{commit}`);
  const message = git(cwd, 'show', '-s', '--format=%B', tagSha);
  const original = /^Release-Source: ([0-9a-f]{40,64})$/m.exec(message)?.[1];
  // A rerun may target either the tested commit or the bot's release commit.
  if (tagSha === mainSha && original && (sourceSha === original || sourceSha === tagSha)) {
    assert.equal(message.split('\n')[0], `chore(release): ${baseTag}`);
    assert.equal(git(cwd, 'rev-parse', `${tagSha}^`), original);
    return {action: 'resume', tag: baseTag, version: baseVersion, sourceSha: original, releaseSha: tagSha};
  }
  if (mainSha !== sourceSha) return {action: 'skip', reason: 'main has moved beyond the tested commit'};
  const commits = git(cwd, 'log', '--no-merges', '--reverse', '--format=%H%x00%B%x00', `${baseTag}..${sourceSha}`)
    .split('\0');
  const changes = [];
  for (let i = 0; i + 1 < commits.length; i += 2) {
    changes.push({sha: commits[i].trim(), ...classifyCommit(commits[i + 1])});
  }
  const level = Math.max(0, ...changes.map(change => change.level));
  if (!level) return {action: 'skip', reason: 'No fix, perf, feat or breaking change since the last release'};
  const version = nextVersion(baseVersion, level);
  const tag = `v${version}`;
  assert.equal(git(cwd, 'tag', '--list', tag), '', `Tag ${tag} already exists outside this release history`);
  return {action: 'create', baseTag, baseVersion, version, tag, sourceSha, changes};
}

export function prepareRelease(cwd, plan, date = new Date().toISOString().slice(0, 10)) {
  assert.equal(plan.action, 'create');
  const files = versionFiles.map(path => JSON.parse(readFileSync(join(cwd, path), 'utf8')));
  const versions = [...files.map(file => file.version), files[1].packages[''].version];
  assert.ok(versions.every(version => version === plan.baseVersion), 'Source versions must match the last release tag');
  for (let i = 0; i < files.length; i++) {
    files[i].version = plan.version;
    if (i === 1) files[i].packages[''].version = plan.version;
    writeFileSync(join(cwd, versionFiles[i]), JSON.stringify(files[i], null, 2) + '\n');
  }
  const groups = [
    ['不兼容变更', change => change.level === 3],
    ['新增功能', change => change.level === 2],
    ['修复与性能改进', change => change.level === 1],
    ['其他更新', change => change.level === 0],
  ];
  const notes = groups.flatMap(([title, matches]) => {
    const entries = plan.changes.filter(matches);
    return entries.length ? [`### ${title}\n\n${entries.map(change => `- ${change.subject} (${change.sha.slice(0, 7)})`).join('\n')}`] : [];
  }).join('\n\n');
  const changelogPath = join(cwd, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  const firstLine = changelog.indexOf('\n');
  assert.ok(firstLine >= 0, 'Changelog must start with a title');
  writeFileSync(changelogPath, `${changelog.slice(0, firstLine)}\n\n## ${plan.tag} — ${date}\n\n${notes}\n${changelog.slice(firstLine)}`);
}

export function verifyRelease(cwd, expected) {
  const files = [...versionFiles, 'dist/extension/manifest.json'].map(path => JSON.parse(readFileSync(join(cwd, path), 'utf8')));
  const version = expected ?? files[0].version;
  parseVersion(version);
  assert.ok([...files.map(file => file.version), files[1].packages[''].version].every(value => value === version), 'Version files disagree');
  run(cwd, 'unzip', ['-tq', 'dist/pi-tab-extension.zip']);
  const manifest = JSON.parse(run(cwd, 'unzip', ['-p', 'dist/pi-tab-extension.zip', 'pi-tab-extension/manifest.json']));
  assert.equal(manifest.version, version, 'ZIP manifest version disagrees');
  assert.ok(readFileSync(join(cwd, 'pi-bookmarklet-chat-install.html')).length, 'Installer is empty');
}

export function publishRelease(cwd, source = 'HEAD') {
  assert.equal(git(cwd, 'status', '--porcelain'), '', 'Release requires a clean checkout');
  git(cwd, 'fetch', 'origin', 'main', '--tags');
  const plan = planRelease(cwd, source);
  console.log(JSON.stringify(plan, null, 2));
  if (plan.action === 'skip') return plan;
  if (plan.action === 'create') {
    git(cwd, 'checkout', '--detach', plan.sourceSha);
    prepareRelease(cwd, plan);
    run(cwd, 'npm', ['run', 'build'], {stdio: 'inherit'});
    run(cwd, 'npm', ['test'], {stdio: 'inherit'});
    verifyRelease(cwd, plan.version);
    // Ordinary fast-forward + atomic push prevents publishing over a newer main.
    git(cwd, 'fetch', 'origin', 'main');
    if (git(cwd, 'rev-parse', 'origin/main') !== plan.sourceSha) {
      return {action: 'skip', reason: 'main changed while preparing the release'};
    }
    git(cwd, 'add', '--', ...releasePaths);
    git(cwd, '-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '-m', `chore(release): ${plan.tag}`, '-m', `Release-Source: ${plan.sourceSha}`);
    git(cwd, 'tag', plan.tag);
    git(cwd, 'push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${plan.tag}`);
    plan.releaseSha = git(cwd, 'rev-parse', 'HEAD');
  } else {
    git(cwd, 'checkout', '--detach', plan.releaseSha);
    verifyRelease(cwd, plan.version);
  }
  const changelog = readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8');
  const section = changelog.split('\n## ').slice(1).find(section => section.split(' — ')[0] === plan.tag);
  assert.ok(section, `Missing changelog for ${plan.tag}`);
  const temporary = mkdtempSync(join(tmpdir(), 'pi-tab-release-'));
  const notesPath = join(temporary, 'notes.md');
  writeFileSync(notesPath, section.slice(section.indexOf('\n') + 1).trim() + '\n');
  try {
    const existing = spawnSync('gh', ['release', 'view', plan.tag, '--json', 'tagName'], {cwd, encoding: 'utf8'});
    if (existing.status !== 0) {
      assert.match(existing.stderr ?? '', /release not found/i, existing.error?.message ?? existing.stderr);
      run(cwd, 'gh', ['release', 'create', plan.tag, '--verify-tag', '--draft', '--title', `Pi Tab ${plan.tag}`, '--notes-file', notesPath]);
    }
    run(cwd, 'gh', ['release', 'upload', plan.tag, 'dist/pi-tab-extension.zip', 'pi-bookmarklet-chat-install.html', '--clobber']);
    run(cwd, 'gh', ['release', 'edit', plan.tag, '--draft=false', '--prerelease=false', '--latest', '--title', `Pi Tab ${plan.tag}`, '--notes-file', notesPath]);
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${plan.releaseSha}\ntag=${plan.tag}\n`);
  return plan;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2] ?? 'preview';
  assert.ok(['preview', 'publish', 'verify'].includes(mode), 'Usage: node scripts/release.mjs [preview|publish|verify]');
  const cwd = process.cwd();
  const source = process.env.GITHUB_SHA || 'HEAD';
  if (mode === 'preview') console.log(JSON.stringify(planRelease(cwd, source, source), null, 2));
  if (mode === 'verify') verifyRelease(cwd);
  if (mode === 'publish') console.log(JSON.stringify(publishRelease(cwd, source), null, 2));
}

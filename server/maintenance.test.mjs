import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from './store.mjs';
import {MEDIA_DIR} from './media.mjs';

const freshStore = () => new Store({dataDir: mkdtempSync(join(tmpdir(), 'spr-maint-')), seedDir: null, log: () => {}}).open();
const doc = (text = 'x') => ({sections: [{groups: [{promptItems: [{itemcode: '1', mediaitems: [{mimetype: 'text/plain', text}]}]}]}]});

test('migrateLegacyTrees imports flat scripts as version 1 and is idempotent', () => {
  const store = freshStore();
  writeFileSync(store.scriptPath('legacy'), JSON.stringify({name: 'Legacy', sections: [{groups: []}]}));

  assert.deepEqual(store.migrateLegacyTrees(), {scripts: 1, imported: 1, lists: 0});
  assert.equal(store.scriptMeta('legacy').publishedVersion, 1);
  assert.equal(store.scriptMeta('legacy').layoutVersion, 1, 'server/README.md promises a layout version in each meta.json');
  assert.equal(store.version('legacy', 1).name, 'Legacy');
  // The history the editor's panel and `GET …/version` read must agree with `meta.publishedVersion`;
  // the imported document alone is invisible.
  const index = store.versionsIndex('legacy');
  assert.equal(index.length, 1);
  assert.equal(index[0].version, 1);
  assert.ok(typeof index[0].publishedDate === 'string' && index[0].publishedDate !== '');
  assert.deepEqual(store.migrateLegacyTrees(), {scripts: 1, imported: 0, lists: 0});
  assert.equal(store.versionsIndex('legacy').length, 1, 'migrating twice must not duplicate the entry');
});

test('every meta.json carries the layout version the runbook promises', () => {
  // server/README.md: "the layout version in each meta.json says which layout a script is". Two write
  // paths produce a meta — createScript and ensureScriptMeta, the latter covering the migration above —
  // and neither was asserted, so a script could have been written without it and the runbook's claim
  // would have stopped being true in silence. `--migrate` alone does not cover this: a fresh script
  // never goes through it.
  const store = freshStore();
  const created = store.createScript({name: 'S', project: 'demo', value: doc(), text: JSON.stringify(doc())});
  assert.equal(store.scriptMeta(created.scriptId).layoutVersion, 1, 'createScript must stamp the layout version');
});

test('pruneDraftRevisions keeps the newest N and drops aged-out revisions', () => {
  const store = freshStore();
  const created = store.createScript({name: 'S', project: 'demo', value: doc(), text: JSON.stringify(doc())});
  const id = String(created.scriptId);
  for (let i = 0; i < 9; i++) {
    store.writeDraft(id, JSON.stringify({...doc(), n: i}), {...doc(), n: i});
  }
  const revisionsDir = join(store.scriptDir(id), 'revisions');
  assert.equal(readdirSync(revisionsDir).length, 10);

  assert.equal(store.pruneDraftRevisions({keep: 4, maxAgeDays: 3650}).removed, 6);
  assert.equal(readdirSync(revisionsDir).length, 4);
  assert.equal(store.pruneDraftRevisions({keep: 50, maxAgeDays: 0}).removed, 4);
  assert.equal(readdirSync(revisionsDir).length, 0);
});

test('gc removes expired previews with their materialised script and keeps live ones', () => {
  const store = freshStore();
  const created = store.createScript({name: 'P', project: 'demo', value: doc(), text: JSON.stringify(doc())});
  const expired = store.createPreviewSession({project: 'demo', scriptId: String(created.scriptId), version: 'draft', ttlMs: -1000});
  const live = store.createPreviewSession({project: 'demo', scriptId: String(created.scriptId), version: 'draft'});

  assert.deepEqual(store.expiredPreviews().map((entry) => entry.sessionId), [expired.sessionId]);
  const summary = store.gc();
  assert.equal(summary.previewsRemoved, 1);
  assert.equal(store.session(expired.sessionId), null);
  assert.ok(!existsSync(store.scriptPath(String(expired.script))));
  assert.notEqual(store.session(live.sessionId), null);
  assert.ok(existsSync(store.scriptPath(String(live.script))));
});

test('orphanMedia reports only files no draft, published version or bank item references', () => {
  const store = freshStore();
  writeFileSync(join(store.dataDir, 'project', 'demo.json'), JSON.stringify({name: 'Demo'}));
  store.ensureMediaDir('demo');
  writeFileSync(store.mediaPath('demo', 'orphan.wav'), Buffer.from('x'));
  writeFileSync(store.mediaPath('demo', 'used.wav'), Buffer.from('x'));
  const referencing = {sections: [{groups: [{promptItems: [{itemcode: '1', mediaitems: [{mimetype: 'audio/wav', src: 'media/used.wav'}]}]}]}]};
  store.createScript({name: 'S', project: 'demo', value: referencing, text: JSON.stringify(referencing)});
  // A drawn group plays the recording its bank item names, so a clip only a bank refers to is used
  // too. `used.wav` above is held by a draft; this one by a bank — the case that was taken for an
  // orphan and deleted by `--gc-media` (§11.51).
  writeFileSync(store.mediaPath('demo', 'bank.wav'), Buffer.from('x'));
  store.writeBank('std', {
    title: 'Bank',
    source: 'BUILTIN',
    items: [{bankItemId: 'std-001', text: 'x', audioSrc: 'media/bank.wav'}],
  });

  assert.deepEqual(store.orphanMedia().map((entry) => entry.name), ['orphan.wav']);
  assert.deepEqual(store.resourceReferences().get('media/bank.wav'), [{bankId: 'std', bank: true}]);
  const summary = store.gc({media: true});
  assert.equal(summary.orphansFound, 1);
  assert.equal(summary.mediaRemoved, 1);
  assert.ok(!existsSync(store.mediaPath('demo', 'orphan.wav')));
  assert.ok(existsSync(store.mediaPath('demo', 'used.wav')));
  assert.ok(existsSync(store.mediaPath('demo', 'bank.wav')), 'a bank-referenced clip is not an orphan');
});

test('gc defaults to the 50 deep, 30 day retention the runbook documents', () => {
  const store = freshStore();
  const created = store.createScript({name: 'R', project: 'demo', value: doc(), text: JSON.stringify(doc())});
  const id = String(created.scriptId);
  for (let i = 0; i < 60; i++) {
    store.writeDraft(id, JSON.stringify({...doc(), n: i}), {...doc(), n: i});
  }
  const dir = join(store.scriptDir(id), 'revisions');
  const revisions = readdirSync(dir).sort((a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]));
  assert.equal(revisions.length, 61, 'the create writes one, then sixty drafts');

  // One of the newest carries a date outside the documented window, its neighbour one inside it.
  const day = 24 * 60 * 60 * 1000;
  const aged = revisions[revisions.length - 1];
  const inside = revisions[revisions.length - 2];
  utimesSync(join(dir, aged), new Date(Date.now() - 31 * day), new Date(Date.now() - 31 * day));
  utimesSync(join(dir, inside), new Date(Date.now() - 29 * day), new Date(Date.now() - 29 * day));

  const versionsBefore = store.versionsIndex(id).map((entry) => entry.version);
  const summary = store.gc();

  assert.equal(summary.revisionsRemoved, 12, 'eleven over the documented depth, plus the one out of its window');
  assert.ok(!existsSync(join(dir, aged)), 'a revision older than 30 days goes');
  assert.ok(existsSync(join(dir, inside)), 'a revision inside the window stays');
  assert.ok(readdirSync(dir).length <= 50, 'the runbook documents 50 deep');
  assert.deepEqual(store.versionsIndex(id).map((entry) => entry.version), versionsBefore, 'published versions are never pruned');
});

test('the documented gc commands thread --gc-media through to the store', () => {
  // The store-level tests above call `gc({media})` directly, so the flag the runbook tells an
  // operator to pass was the one part of that promise nothing checked.
  const store = freshStore();
  const created = store.createScript({name: 'M', project: 'demo', value: doc(), text: JSON.stringify(doc())});
  mkdirSync(join(store.dataDir, 'project', 'demo', 'media'), {recursive: true});
  writeFileSync(join(store.dataDir, 'project', 'demo.json'), JSON.stringify({name: 'Demo'}));
  writeFileSync(store.mediaPath('demo', 'orphan.wav'), 'RIFF');
  const run = (...flags) => execFileSync(process.execPath,
    ['server/server.mjs', '--data', store.dataDir, ...flags], {encoding: 'utf8', cwd: process.cwd()});

  const without = run('--gc');
  assert.match(without, /1 orphan media found \(pass --gc-media to remove\)/);
  assert.ok(existsSync(store.mediaPath('demo', 'orphan.wav')), 'without the flag the orphan stays');

  const with_ = run('--gc', '--gc-media');
  assert.match(with_, /1 orphan media found, 1 removed/);
  assert.ok(!existsSync(store.mediaPath('demo', 'orphan.wav')), 'with the flag it goes');
  assert.ok(store.scriptMeta(String(created.scriptId)) !== null, 'and the script itself survives');
});

test('open sweeps the temp files an interrupted write leaves behind (§11.191)', () => {
  const store = freshStore();
  const created = store.createScript({name: 'S', project: 'demo', value: doc(), text: JSON.stringify(doc())});
  const meta = store.scriptMetaPath(created.scriptId);
  // A version file that was never written: the temp of a first write that failed has no target.
  const version = store.scriptVersionPath(created.scriptId, 1);
  assert.equal(existsSync(version), false, 'the version file is absent, so this temp has no target');
  mkdirSync(dirname(version), {recursive: true});

  // What writeJson/writeText leave behind when they die between writeFileSync and renameSync.
  writeFileSync(`${meta}.tmp-4711`, '{"half":');
  writeFileSync(`${version}.tmp-4712`, 'half a version');

  // Files the pattern must not touch: a real artifact, and a media name the uploader chose. Inside a
  // media directory the store writes exactly one JSON file, `index.json`, so its own temp is still
  // collectable while anything else a person named is not.
  const mediaDir = join(store.dataDir, 'project', 'demo', MEDIA_DIR);
  mkdirSync(mediaDir, {recursive: true});
  const chosen = join(mediaDir, 'notes.json.tmp-4');
  writeFileSync(chosen, 'RIFF');
  const indexTemp = join(mediaDir, 'index.json.tmp-4713');
  writeFileSync(indexTemp, '{"files":');
  const kept = join(store.dataDir, 'project', 'demo.json');
  writeFileSync(kept, JSON.stringify({name: 'Demo'}));

  assert.equal(existsSync(`${meta}.tmp-4711`), true, 'the temps are there before the store opens');
  assert.equal(existsSync(`${version}.tmp-4712`), true);
  assert.equal(existsSync(indexTemp), true);

  new Store({dataDir: store.dataDir, seedDir: null, log: () => {}}).open();

  assert.equal(existsSync(`${meta}.tmp-4711`), false, 'the temp beside the metadata is gone');
  assert.equal(existsSync(`${version}.tmp-4712`), false, 'so is the one whose target was never written');
  assert.equal(existsSync(indexTemp), false, 'and the media index\'s own temp, inside a media directory');
  assert.equal(existsSync(meta), true, 'the real metadata survives');
  assert.equal(existsSync(kept), true, 'so does a real project file');
  assert.equal(existsSync(chosen), true, 'and a media file a person named like the pattern is left alone');
  assert.equal(store.scriptMeta(created.scriptId).name, 'S', 'the store still reads what it kept');
});

test('a directory the sweep cannot read does not stop the store opening (§11.191)', () => {
  const store = freshStore();
  const kept = join(store.dataDir, 'script', '1001');
  mkdirSync(kept, {recursive: true});
  writeFileSync(join(kept, 'meta.json.tmp-4714'), '{"half":');
  const locked = join(store.dataDir, 'locked');
  mkdirSync(locked, {recursive: true});
  writeFileSync(join(locked, 'meta.json.tmp-4715'), '{"half":');
  // chmod is the realistic case (EACCES) but it does not bite for root, and Windows has no mode bits
  // to set, so those assertions are made only where the permission actually means something.
  const permissionsBite = process.platform !== 'win32'
    && !(typeof process.getuid === 'function' && process.getuid() === 0);

  const logs = [];
  const reopened = new Store({dataDir: store.dataDir, seedDir: null, log: (line) => logs.push(line)});
  if (permissionsBite) {
    chmodSync(locked, 0o000);
  }
  try {
    reopened.open();
  } finally {
    if (permissionsBite) {
      chmodSync(locked, 0o700);
    }
  }

  // The sweep is housekeeping: whatever it cannot read, it must not take the receiver down with it.
  assert.equal(existsSync(join(kept, 'meta.json.tmp-4714')), false, 'the readable part was still swept');
  if (permissionsBite) {
    assert.equal(existsSync(join(locked, 'meta.json.tmp-4715')), true, 'the unreadable directory is left alone');
    assert.ok(logs.some((line) => line.includes('could not sweep') && line.includes('locked')),
      'and named, so the litter is findable');
  }

  // The same path without needing permissions: a file is not a directory (ENOTDIR), and the sweep says
  // so rather than throwing.
  writeFileSync(join(kept, 'not-a-directory.json'), '{}');
  assert.equal(reopened.sweepTempFiles(join(kept, 'not-a-directory.json')), 0);
  assert.ok(logs.some((line) => line.includes('not-a-directory.json')), 'the file is named too');
});

test('gc reports unfinished chunk sessions and leaves them alone (§11.195)', () => {
  const store = freshStore();
  const chunk = join(store.tmpDir, 'chunk-fixture.wav');
  writeFileSync(chunk, 'RIFF');

  // An upload that was started and never published: two chunks, no finalizedRecording.
  store.addChunk('open-upload', 0, chunk);
  writeFileSync(chunk, 'RIFF');
  store.addChunk('open-upload', 1, chunk);

  // And one that published: its chunks are gone and it carries the publication, so it is not pending.
  writeFileSync(chunk, 'RIFF');
  store.addChunk('done-upload', 0, chunk);
  store.markChunkSessionFinalized('done-upload', {recordingFileId: 1, session: 1, version: 1, chunks: 1, frames: 1});

  const summary = store.gc();
  assert.equal(summary.chunkSessionsLeft, 1, 'the unfinished session is counted');
  assert.equal(summary.chunkFilesLeft, 2, 'with the chunks it holds');
  assert.equal(existsSync(store.chunkPath('open-upload', 0)), true, 'and nothing was removed');
  assert.equal(existsSync(store.chunkPath('open-upload', 1)), true);
  assert.equal(store.chunkIndices('open-upload').length, 2, 'the session is intact for a resuming client');

  // The finalised session is not pending, and re-running reports the same thing: this counts, it does not act.
  assert.equal(store.pendingChunkSessions().length, 1);
  assert.equal(store.gc().chunkSessionsLeft, 1);
  assert.equal(store.gc().chunkSessionsRemoved, 0, 'and the session is inside the default window, so the bound collects nothing');
});

test('gc bounds the journal and the chunk sessions by age by default, and by a count when one is given (§11.255)', () => {
  const store = freshStore();
  // Dates inside the store's default window, so what these cases exercise is the *count* (§11.255); the age bound has
  // cases of its own in the chunk half below.
  const day = (n) => new Date(Date.now() - (4 - n) * 24 * 60 * 60 * 1000).toISOString();

  // The journal: newest N by the date each entry was remembered, since an Idempotency-Key may look
  // like an integer and JSON object order is then numeric rather than insertion order.
  store.idempotencyRemember('oldest', {status: 200, body: 'e30=', note: 'a', date: day(1)});
  store.idempotencyRemember('middle', {status: 200, body: 'e30=', note: 'b', date: day(2)});
  store.idempotencyRemember('newest', {status: 200, body: 'e30=', note: 'c', date: day(3)});

  const counted = store.gc();
  assert.equal(counted.journalEntries, 3, 'a plain gc counts the journal');
  assert.equal(counted.journalRemoved, 0);
  assert.equal(store.idempotencyLookup('oldest').note, 'a', 'and removes nothing');

  const trimmed = store.gc({journalKeep: 2});
  assert.equal(trimmed.journalRemoved, 1);
  assert.equal(trimmed.journalEntries, 2);
  assert.equal(store.idempotencyLookup('oldest'), null, 'the oldest entry went');
  assert.equal(store.idempotencyLookup('newest').note, 'c', 'the newest stayed');
  // On disk, not only in the cache: a second store reads the same two entries.
  const reopened = new Store({dataDir: store.dataDir, seedDir: null, log: () => {}}).open();
  assert.deepEqual(Object.keys(reopened.journal()).sort(), ['middle', 'newest']);

  // Chunk sessions: an age, an old session and a recent one, and no collection when no age is given.
  const chunk = join(store.tmpDir, 'chunk-age.wav');
  const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  for (const [uuid, createdAt] of [['stale-upload', stale], ['fresh-upload', new Date().toISOString()]]) {
    store.upsertChunkSession(uuid, {createdAt});
    writeFileSync(chunk, 'RIFF');
    store.addChunk(uuid, 0, chunk);
  }

  assert.equal(store.gc({uploadsMaxAgeDays: null}).chunkSessionsLeft, 2, 'with the age bound off, a plain gc only counts both');
  assert.equal(existsSync(store.chunkPath('stale-upload', 0)), true, 'and collects neither');

  const collected = store.gc({uploadsMaxAgeDays: 30});
  assert.equal(collected.chunkSessionsRemoved, 1, 'the session past the age is collected');
  assert.equal(collected.chunkFilesRemoved, 1);
  assert.equal(collected.chunkSessionsLeft, 1, 'the recent one is left');
  assert.equal(existsSync(store.chunkDir('stale-upload')), false, 'directory and all');
  assert.equal(existsSync(store.chunkPath('fresh-upload', 0)), true, 'the recent one keeps its chunk');
  assert.equal(store.chunkIndices('fresh-upload').length, 1, 'and is still resumable');
});

test('both prunes keep what they cannot order (§11.194/§11.195)', () => {
  const store = freshStore();

  // A journal entry with no date — an older receiver's, or a hand-edited file. Neither prune may treat
  // "cannot be compared" as "old": keeping is the only safe reading of a value it cannot order.
  store.idempotencyRemember('dated-old', {status: 200, body: 'e30=', note: 'a', date: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString()});
  store.idempotencyRemember('dated-new', {status: 200, body: 'e30=', note: 'b', date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()});
  store.idempotencyRemember('undated', {status: 200, body: 'e30=', note: 'c'});

  // One slot is taken by the undated entry, so the trim keeps the newest dated entry as well.
  const trimmed = store.gc({journalKeep: 2});
  assert.equal(trimmed.journalRemoved, 1, 'only the older *dated* entry goes');
  assert.equal(trimmed.journalEntries, 2);
  assert.equal(store.idempotencyLookup('undated').note, 'c', 'the undated entry survives');
  assert.equal(store.idempotencyLookup('dated-new').note, 'b', 'so does the newest dated one');
  assert.equal(store.idempotencyLookup('dated-old'), null);

  // With the budget eaten by undated entries, the dated one still goes and the *kept* count exceeds
  // `keep`: the count is a floor once the store cannot order everything it holds, which is the
  // consequence of never dropping an entry it cannot compare.
  store.idempotencyRemember('undated-2', {status: 200, body: 'e30=', note: 'd'});
  const overBudget = store.gc({journalKeep: 1});
  assert.equal(overBudget.journalRemoved, 1, 'the dated entry is what it can order, so it is what goes');
  assert.equal(overBudget.journalEntries, 2, 'and two undated entries outlive a keep of one');
  assert.equal(store.idempotencyLookup('dated-new'), null);

  // With nothing but undated entries left, a trim removes nothing at all.
  store.idempotencyRemember('undated-3', {status: 200, body: 'e30=', note: 'e'});
  assert.equal(store.gc({journalKeep: 1}).journalRemoved, 0, 'nothing it can order is left to trim');
  assert.equal(store.pendingChunkSessions().length, 0, 'and no chunk session is involved');

  // A chunk session whose createdAt is unusable, against an age that would otherwise collect it.
  const chunk = join(store.tmpDir, 'chunk-nodate.wav');
  store.upsertChunkSession('no-date-upload', {createdAt: 'not a date'});
  writeFileSync(chunk, 'RIFF');
  store.addChunk('no-date-upload', 0, chunk);
  const noCreatedAt = join(store.chunkDir('no-date-upload'), 'meta.json');
  writeFileSync(noCreatedAt, JSON.stringify({uuid: 'no-date-upload', chunks: {0: 4}}));

  const collected = store.gc({uploadsMaxAgeDays: 0});
  assert.equal(collected.chunkSessionsRemoved, 0, 'an age of 0 collects nothing it cannot date');
  assert.equal(collected.chunkSessionsLeft, 1);
  assert.equal(existsSync(store.chunkPath('no-date-upload', 0)), true, 'the chunk is still there');
});

test('gc prunes what it can when a record it reads is corrupt (§11.194/§11.195)', () => {
  const store = freshStore();
  const chunk = join(store.tmpDir, 'chunk-corrupt.wav');
  store.upsertChunkSession('readable', {createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()});
  writeFileSync(chunk, 'RIFF');
  store.addChunk('readable', 0, chunk);

  // Two files the store refuses to guess at: `readJson` throws so a request fails loudly rather than
  // acting on nonsense. `gc` must not be stopped by either — it read neither before this session's
  // changes, and it is the command an operator reaches for when state is broken.
  mkdirSync(store.chunkDir('corrupt'), {recursive: true});
  writeFileSync(join(store.chunkDir('corrupt'), 'meta.json'), '{ not json');
  writeFileSync(join(store.uploadsDir, 'journal.json'), '{ not json');

  const logs = [];
  const reopened = new Store({dataDir: store.dataDir, seedDir: null, log: (line) => logs.push(line)}).open();
  const summary = reopened.gc({uploadsMaxAgeDays: 1, journalKeep: 1});

  assert.equal(summary.chunkSessionsRemoved, 1, 'the readable session is still collectable');
  assert.equal(summary.chunkSessionsLeft, 0);
  assert.equal(existsSync(store.chunkDir('corrupt')), true, 'and the unreadable one was not touched');
  assert.equal(summary.journalEntries, null, 'an unreadable journal has an unknown count, not a zero one');
  assert.equal(summary.journalRemoved, 0);
  assert.ok(logs.some((line) => line.includes('could not read the chunk session chunk-corrupt')), 'named: the chunk record');
  assert.ok(logs.some((line) => line.includes('could not read the idempotency journal')), 'named: the journal');
});

test('an undeletable chunk session does not stop the others being collected (§11.195)', () => {
  const store = freshStore();
  const chunk = join(store.tmpDir, 'chunk-locked.wav');
  // Three days old: inside the store's 7-day default, so `open()` leaves it alone and the *age the test passes* is
  // what collects it (§11.255).
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  for (const uuid of ['locked', 'free']) {
    store.upsertChunkSession(uuid, {createdAt: old});
    writeFileSync(chunk, 'RIFF');
    store.addChunk(uuid, 0, chunk);
  }
  // Removing entries inside a directory needs write permission on it, which `force: true` does not grant.
  const permissionsBite = process.platform !== 'win32'
    && !(typeof process.getuid === 'function' && process.getuid() === 0);
  if (!permissionsBite) {
    return;
  }
  chmodSync(store.chunkDir('locked'), 0o500);

  const logs = [];
  const reopened = new Store({dataDir: store.dataDir, seedDir: null, log: (line) => logs.push(line)}).open();
  let summary;
  try {
    summary = reopened.gc({uploadsMaxAgeDays: 1});
  } finally {
    chmodSync(store.chunkDir('locked'), 0o700);
  }

  assert.equal(summary.chunkSessionsRemoved, 1, 'the session it could delete was collected');
  assert.equal(summary.chunkSessionsLeft, 1, 'the one it could not is still reported');
  assert.equal(existsSync(store.chunkPath('locked', 0)), true, 'and still there');
  assert.equal(existsSync(store.chunkDir('free')), false, 'while the other is gone');
  assert.ok(logs.some((line) => line.includes('could not collect the chunk session locked')), 'and named');
});

test('--gc-media removes what it can and reports what it did (§11.194)', () => {
  const store = freshStore();
  const free = join(store.dataDir, 'project', 'demo', MEDIA_DIR);
  const stuck = join(store.dataDir, 'project', 'locked', MEDIA_DIR);
  for (const [project, dir, name] of [['demo', free, 'a.wav'], ['locked', stuck, 'b.wav']]) {
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(store.dataDir, 'project', `${project}.json`), JSON.stringify({name: project}));
    writeFileSync(join(dir, name), 'RIFF');
  }

  const permissionsBite = process.platform !== 'win32'
    && !(typeof process.getuid === 'function' && process.getuid() === 0);
  if (!permissionsBite) {
    return;
  }
  // Unlinking needs write permission on the directory; 500 gives read and traverse only, so the orphan
  // in `locked/` cannot be removed while the one in `demo/` can.
  chmodSync(stuck, 0o500);

  const logs = [];
  const reopened = new Store({dataDir: store.dataDir, seedDir: null, log: (line) => logs.push(line)}).open();
  let summary;
  try {
    summary = reopened.gc({media: true});
  } finally {
    chmodSync(stuck, 0o700);
  }

  assert.equal(summary.orphansFound, 2, 'both are orphans');
  assert.equal(summary.mediaRemoved, 1, 'the count reports the one it removed, not the two it found');
  assert.equal(existsSync(join(free, 'a.wav')), false, 'the removable one went');
  assert.equal(existsSync(join(stuck, 'b.wav')), true, 'the stuck one is still there for the next run');
  assert.equal(logs.filter((line) => line.includes('could not remove the orphan media b.wav')).length, 1, 'and named');
});

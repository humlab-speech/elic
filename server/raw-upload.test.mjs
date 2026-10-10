/** A raw single POST names its take in the query: when it started, and which take it is. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {withServer} from './api-harness.mjs';

const wav = readFileSync(new URL('../src/test/test_mono1.wav', import.meta.url));
const post = (base, query = '') => fetch(`${base}/session/r/recfile/A1${query}`, {method: 'POST', headers: {'content-type': 'audio/wav'}, body: wav});

test('startedDate and uuid in the query are stored; a repeated uuid is answered, not stored again', async () => {
  await withServer(async ({base, store}) => {
    store.createSession('r', {project: 'demo', script: null, type: 'NORM'});
    const started = '2026-01-02T03:04:05.000Z';
    const first = await post(base, `?startedDate=${encodeURIComponent(started)}&uuid=take-1`);
    assert.equal(first.status, 201);
    const [meta] = store.recordingFilesOfSession('r');
    assert.equal(meta.startedDate, started);
    assert.equal(meta.uuid, 'take-1');

    const again = await post(base, `?startedDate=${encodeURIComponent(started)}&uuid=take-1`);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).replayed, true);
    assert.equal(store.recordingFilesOfSession('r').length, 1);
  });
});

test('without the query nothing changes, and an implausible start date is dropped', async () => {
  await withServer(async ({base, store}) => {
    store.createSession('r', {project: 'demo', script: null, type: 'NORM'});
    assert.equal((await post(base)).status, 201);
    assert.equal((await post(base, '?startedDate=not-a-date')).status, 201);
    assert.equal((await post(base, '?startedDate=2999-01-01T00:00:00Z')).status, 201);
    const stamped = store.recordingFilesOfSession('r').map((meta) => meta.startedDate);
    assert.ok(stamped.every((date) => Math.abs(Date.parse(date) - Date.now()) < 60_000), `server time expected, got ${stamped}`);
    assert.equal(store.recordingFilesOfSession('r')[0].uuid, undefined);
  });
});

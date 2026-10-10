/** Receiver hardening for the chunked upload: no double publish, no resurrected chunks, no guessed count. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildWavHeader} from './wav.mjs';
import {withServer, jsonRequest} from './api-harness.mjs';

const BYTES = 16000;
const wave = () => Buffer.concat([buildWavHeader({audioFormat: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16}, BYTES), Buffer.alloc(BYTES)]);
const chunk = (base, session, uuid, idx) => fetch(`${base}/session/${session}/recfile/${uuid}/${idx}`, {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: wave()});
const concat = (base, session, uuid, body = {chunkCount: 2}, headers = {}) =>
  fetch(`${base}/session/${session}/recfile/${uuid}/concatChunksRequest`, {...jsonRequest('POST', body), headers: {'content-type': 'application/json', ...headers}});

test('concurrent concats of one take publish it once, and a replayed chunk leaves nothing behind', async () => {
  await withServer(async ({base, store}) => {
    store.createSession('c', {project: 'demo', script: null, type: 'NORM'});
    await chunk(base, 'c', 'u1', 0);
    await chunk(base, 'c', 'u1', 1);
    const answers = await Promise.all([concat(base, 'c', 'u1'), concat(base, 'c', 'u1'), concat(base, 'c', 'u1')]);
    assert.ok(answers.every((answer) => answer.status === 200 || answer.status === 201));
    assert.equal(store.recordingFilesOfSession('c').length, 1);

    const late = await chunk(base, 'c', 'u1', 0);
    assert.equal(late.status, 200);
    assert.equal((await late.json()).replayed, true);
    assert.deepEqual(store.chunkIndices('u1'), [], 'a published take must not get its chunk files back');
  });
});

test('a concat without a chunk count is refused instead of publishing what has arrived', async () => {
  await withServer(async ({base, store}) => {
    store.createSession('d', {project: 'demo', script: null, type: 'NORM'});
    await chunk(base, 'd', 'u2', 0);
    const refused = await concat(base, 'd', 'u2', {});
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).code, 'CHUNK_COUNT_REQUIRED');
    assert.equal(store.recordingFilesOfSession('d').length, 0);
  });
});

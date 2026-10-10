/** Publish: the recorder-version gate reads the published floor, a reverted draft publishes again, E05 escapes. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withServer, jsonRequest} from './api-harness.mjs';
import {validateScript} from './validate.mjs';

const item = (itemcode, text, extra = {}) => ({itemcode, mediaitems: [{mimetype: 'text/plain', text}], ...extra});
const script = (items) => ({name: 'S', sections: [{mode: 'MANUAL', promptphase: 'IDLE', order: 'SEQUENTIAL', training: false,
  groups: [{order: 'SEQUENTIAL', promptItems: items}]}]});

async function create(base) {
  const response = await fetch(`${base}/project/demo/script`, jsonRequest('POST', {name: 'S'}));
  return {etag: response.headers.get('etag'), ...(await response.json())};
}
async function put(base, id, value, etag) {
  const response = await fetch(`${base}/project/demo/script/${id}/draft`, {method: 'PUT', headers: {'content-type': 'application/json', 'if-match': etag}, body: JSON.stringify(value)});
  assert.equal(response.status, 200);
  return response.headers.get('etag');
}
const publish = (base, id, body, key) => fetch(`${base}/project/demo/script/${id}/publish`, {...jsonRequest('POST', body), headers: {'content-type': 'application/json', 'idempotency-key': key}});

test('a script that needs a newer recorder cannot start a session on an older receiver', async () => {
  await withServer(async ({base, store}) => {
    const {scriptId, etag} = await create(base);
    const withPlayback = script([{itemcode: 'a', mediaitems: [{mimetype: 'text/plain', text: 'x'}, {mimetype: 'audio/wav', src: 'media/a.wav'}], playback: {mode: 'PRE'}}]);
    const next = await put(base, scriptId, withPlayback, etag);
    // The published document carries no floor of its own; the version index does.
    const published = await publish(base, scriptId, {fromDraftEtag: next}, 'k0');
    const answer = await published.json();
    assert.equal(published.status, 201, JSON.stringify(answer));
    const floor = answer.minRecorderVersion;
    assert.ok(floor);
    const meta = store.scriptMeta(scriptId);
    assert.equal(meta.minRecorderVersion, floor);
    store.recorderVersion = '0.0.1';
    assert.throws(() => store.createSession('old', {project: 'demo', script: scriptId, type: 'NORM'}), (err) => err.code === 'RECORDER_VERSION_TOO_OLD');
  });
});

test('a draft reverted to bytes published before publishes again under the same key', async () => {
  await withServer(async ({base}) => {
    const {scriptId, etag} = await create(base);
    const a = script([item('a', 'one')]);
    const b = script([item('a', 'two')]);
    const e1 = await put(base, scriptId, a, etag);
    assert.equal((await (await publish(base, scriptId, {fromDraftEtag: e1}, 'K')).json()).version, 1);
    const e2 = await put(base, scriptId, b, e1);
    assert.equal((await (await publish(base, scriptId, {fromDraftEtag: e2}, 'K2')).json()).version, 2);
    const e3 = await put(base, scriptId, a, e2);
    const again = await publish(base, scriptId, {fromDraftEtag: e3}, 'K');
    assert.equal(again.headers.get('idempotency-replayed'), null);
    assert.equal((await again.json()).version, 3);
    // A true retry (nothing published since) is still answered from the journal.
    const retry = await publish(base, scriptId, {fromDraftEtag: e3}, 'K');
    assert.equal(retry.headers.get('idempotency-replayed'), 'true');
    assert.equal((await retry.json()).version, 3);
  });
});

test('E05 treats a prefix as text, not as a pattern', () => {
  const withPrefix = (prefix, fixed) => script([
    item('RB', 'p', {prefill: {bank: {bank: 'b', count: 2, itemcodePrefix: prefix}}}),
    item(fixed, 'x'),
  ]);
  const e05 = (doc) => validateScript(doc, {lookupBank: () => ({bankId: 'b', items: [{}, {}, {}]})}).filter((finding) => finding.id === 'E05');
  assert.doesNotThrow(() => e05(withPrefix('P(', 'P(001')));
  assert.equal(e05(withPrefix('P(', 'P(001')).length, 1);
  assert.equal(e05(withPrefix('A.', 'AB002')).length, 0);
});

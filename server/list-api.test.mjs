/** List sources as a resource: library, conditional writes, in-use guard, legacy files, migration, pinning. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {withServer, jsonRequest} from './api-harness.mjs';

const lists = (...ids) => ids.map((id) => ({id, entries: [`a${id}`, `b${id}`]}));
const using = (source) => ({name: 'Uses', sections: [{mode: 'MANUAL', promptphase: 'IDLE', order: 'SEQUENTIAL', training: false, groups: [{order: 'SEQUENTIAL', promptItems: [
  {itemcode: '6', mediaitems: [{mimetype: 'text/plain', text: 'Read'}], prefill: {source, itemcodeFormat: '6.{n}', mediaitems: [{mimetype: 'text/plain', text: '{entry}'}]}}]}]}]});

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'spr-list-api-'));
  mkdirSync(join(dir, 'script'), {recursive: true});
  writeFileSync(join(dir, 'script', 'flat-words.json'), JSON.stringify({lists: lists('1', '2')}));
  writeFileSync(join(dir, 'script', 'uses.json'), JSON.stringify(using('flat-words')));
  return dir;
}
const put = (base, id, body, headers) => fetch(`${base}/project/demo/list/${id}`, {method: 'PUT', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});

test('a list source is created, read, changed under If-Match and refused when invalid', async () => {
  await withServer(async ({base}) => {
    const created = await fetch(`${base}/project/demo/list`, jsonRequest('POST', {name: 'My Words', lists: lists('1', '2', '3')}));
    assert.equal(created.status, 201);
    const {listId, etag} = await created.json();
    assert.equal(listId, 'my-words');
    const read = await fetch(`${base}/project/demo/list/${listId}`);
    assert.equal(read.headers.get('etag'), etag);
    assert.equal((await read.json()).lists.length, 3);

    assert.equal((await put(base, listId, {lists: lists('9')}, {})).status, 428);
    assert.equal((await put(base, listId, {lists: lists('9')}, {'if-match': '"stale"'})).status, 412);
    const changed = await put(base, listId, {name: 'My Words', lists: lists('9')}, {'if-match': etag});
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);

    const bad = await put(base, listId, {lists: [{id: '1', entries: ['x']}, {id: '1', entries: ['']}]}, {'if-match': changed.headers.get('etag')});
    assert.equal(bad.status, 400);
    const {code, details} = await bad.json();
    assert.equal(code, 'LIST_INVALID');
    assert.deepEqual(details.checks.map((check) => check.id).sort(), ['L04', 'L05']);

    assert.equal((await put(base, 'fresh', {lists: lists('1')}, {'if-none-match': '*'})).status, 201);
    assert.equal((await put(base, 'fresh', {lists: lists('1')}, {'if-none-match': '*'})).status, 412);
    const library = await (await fetch(`${base}/project/demo/list`)).json();
    assert.deepEqual(library.map((row) => row.listId).sort(), ['fresh', 'my-words']);
  });
});

test('a legacy flat list works, is not a script, is guarded while used, and moves on migrate', async () => {
  await withServer(async ({base, store, dataDir}) => {
    const scripts = await (await fetch(`${base}/project/demo/script`)).json();
    assert.deepEqual(scripts.map((row) => row.scriptId), ['uses'], 'a list source is not a script');
    const [row] = await (await fetch(`${base}/project/demo/list`)).json();
    assert.equal(row.legacy, true);
    assert.deepEqual(row.shape, [{id: '1', entries: 2}, {id: '2', entries: 2}]);
    assert.equal(row.usedBy[0].scriptId, 'uses');

    const refused = await fetch(`${base}/project/demo/list/flat-words`, {method: 'DELETE'});
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, 'LIST_IN_USE');

    const session = store.createSession('s', {project: 'demo', script: 'uses', type: 'NORM'});
    assert.ok(session.listDraws[0].sourceHash, 'the draw records which content it read');

    const before = readFileSync(join(dataDir, 'script', 'flat-words.json'), 'utf8');
    assert.equal(store.migrateLegacyTrees().lists, 1);
    assert.equal(existsSync(join(dataDir, 'script', 'flat-words.json')), false);
    assert.equal(readFileSync(join(dataDir, 'list', 'flat-words.json'), 'utf8'), before);
    assert.equal(store.migrateLegacyTrees().lists, 0, 'idempotent');
    assert.equal(store.createSession('s2', {project: 'demo', script: 'uses', type: 'NORM'}).listDraws.length, 1);
  }, {seed: seed()});
});

test('an unused list is deleted', async () => {
  await withServer(async ({base}) => {
    const {listId} = await (await fetch(`${base}/project/demo/list`, jsonRequest('POST', {name: 'Gone', lists: lists('1')}))).json();
    assert.equal((await fetch(`${base}/project/demo/list/${listId}`, {method: 'DELETE'})).status, 200);
    assert.equal((await fetch(`${base}/project/demo/list/${listId}`)).status, 404);
    assert.equal((await fetch(`${base}/project/demo/list/${listId}`, {method: 'DELETE'})).status, 404);
  });
});

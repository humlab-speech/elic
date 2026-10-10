import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {withServer, jsonRequest} from './api-harness.mjs';

const lists = (prefix) => ({lists: ['1', '2', '3', '4', '5', '6'].map((id) => ({id, entries: [`${prefix}${id}a`, `${prefix}${id}b`]}))});
const placeholder = (code, source, extra = {}) => ({
  itemcode: code, recduration: 9000, mediaitems: [{mimetype: 'text/plain', text: 'Read'}],
  prefill: {source, itemcodeFormat: `${code}.{n}`, recinstructions: 'Say it', mediaitems: [{mimetype: 'text/plain', text: '{entry}'}], ...extra},
});
const script = {name: 'STI', sections: [{mode: 'MANUAL', promptphase: 'IDLE', order: 'SEQUENTIAL', training: false,
  groups: [{order: 'SEQUENTIAL', promptItems: [
    {itemcode: '1', mediaitems: [{mimetype: 'text/plain', text: 'plain'}]},
    placeholder('6', 'words', {link: 'sti'}),
    placeholder('7', 'sentences', {link: 'sti'}),
  ]}]}]};

function seedDir() {
  const dir = mkdtempSync(join(tmpdir(), 'spr-list-seed-'));
  mkdirSync(join(dir, 'script'), {recursive: true});
  writeFileSync(join(dir, 'script', 'sti.json'), JSON.stringify(script));
  writeFileSync(join(dir, 'script', 'words.json'), JSON.stringify(lists('w')));
  writeFileSync(join(dir, 'script', 'sentences.json'), JSON.stringify(lists('s')));
  return dir;
}
const codes = (doc) => doc.sections.flatMap((s) => s.groups.flatMap((g) => g.promptItems.map((i) => i.itemcode)));

test('list sources are drawn on the receiver, linked, and redrawn per launch until something is recorded', async () => {
  await withServer(async ({base, store}) => {
    store.createSession('a', {project: 'demo', script: 'sti', type: 'NORM'});
    const first = await (await fetch(`${base}/session/a`)).json();
    const doc = await (await fetch(`${base}/script/${first.script}`)).json();
    assert.deepEqual(codes(doc), ['1', '6.1', '6.2', '7.1', '7.2']);
    assert.ok(doc.sections[0].groups[0].promptItems.every((item) => item.prefill === undefined));
    assert.equal(first.prefills['6'].list, first.prefills['7'].list, 'linked specs share one list id');
    const [word] = doc.sections[0].groups[0].promptItems.slice(1);
    assert.equal(word.mediaitems[0].text, `w${first.prefills['6'].list}a`);
    assert.equal(word.recduration, 9000);

    // Every GET is a launch: nothing recorded, so the draw is made again (some launch differs).
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      seen.add((await (await fetch(`${base}/session/a`)).json()).prefills['6'].list);
    }
    assert.ok(seen.size > 1, `expected the list to vary across launches, saw ${[...seen]}`);

    // A stored recording freezes the draw, and the file says what was shown.
    const frozen = await (await fetch(`${base}/session/a`)).json();
    const wav = readFileSync(new URL('../src/test/test_mono1.wav', import.meta.url));
    const res = await fetch(`${base}/session/a/recfile/6.2`, {method: 'POST', headers: {'content-type': 'audio/wav'}, body: wav});
    assert.equal(res.status, 201);
    const again = await (await fetch(`${base}/session/a`)).json();
    assert.deepEqual(again.prefills, frozen.prefills);
    assert.equal(again.redraw, frozen.redraw);
    const [meta] = await (await fetch(`${base}/project/demo/session/a/recfile`)).json();
    assert.equal(meta.recording.mediaitems[0].text, `w${frozen.prefills['6'].list}b`);
    assert.equal(meta.draw.kind, 'list');
    assert.equal(meta.draw.list, frozen.prefills['6'].list);
    assert.equal(meta.draw.entry, `w${frozen.prefills['6'].list}b`);
    assert.equal(meta.promptMissing, undefined);
    const refused = await fetch(`${base}/project/demo/session/a/draws/_redraw`, {method: 'POST'});
    assert.equal(refused.status, 409);
  }, {seed: seedDir()});
});

test('the recorder may move a session forward, not rewrite it', async () => {
  await withServer(async ({base, store}) => {
    store.createSession('b', {project: 'demo', script: 'sti', type: 'NORM'});
    const patch = (body) => fetch(`${base}/project/demo/session/b`, jsonRequest('PATCH', body));
    assert.equal((await patch({status: 'LOADED', loadedDate: '2026-01-01T00:00:00Z'})).status, 200);
    assert.equal((await patch({status: 'CREATED'})).status, 409);
    assert.equal((await patch({script: '1245'})).status, 400);
    assert.equal((await patch({bankDraws: []})).status, 400);
    const kept = await (await fetch(`${base}/project/demo/session/b`, jsonRequest('PATCH', {prefills: {x: 1}, replayLog: {}}))).json();
    assert.equal(kept.prefills['6'].source, 'words', 'prefills from a client are ignored');
  }, {seed: seedDir()});
});

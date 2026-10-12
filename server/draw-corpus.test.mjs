/**
 * The shared draw fixtures (`doc/script-editor/draws/*.draw.json`): a script, the banks and lists it
 * names and a session context, with the script the receiver resolves it to. The editor's preview runs
 * the same files through its own copy of the draw (`core/draw-engine.ts`), so a rule that changes on
 * one side alone fails on the other.
 *
 * `UPDATE_DRAW_FIXTURES=1 node --test server/draw-corpus.test.mjs` rewrites `expect` from the
 * receiver — review the diff, the file is the contract.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveBankSources, resolveListSources} from './draw.mjs';

const DIR = fileURLToPath(new URL('../doc/script-editor/draws', import.meta.url));

/** What a fixture's `expect` holds: the resolved script and the trace fields the editor also produces. */
export function resolveLikeTheReceiver(fixture) {
  const {context} = fixture;
  const base = {
    sessionId: context.sessionId,
    speaker: context.speaker ?? null,
    scriptId: context.scriptId ?? null,
    scriptVersion: context.scriptVersion ?? null,
  };
  const banks = resolveBankSources(fixture.script, {
    ...base,
    lookupBank: (bankId) => fixture.banks?.[bankId] ?? null,
    recordedBankItemIds: new Set(context.recordedBankItemIds ?? []),
  });
  const lists = resolveListSources(banks.script, {...base, lookupSource: (listId) => fixture.lists?.[listId] ?? null});
  return {
    script: lists.script,
    bankDraws: (banks.trace ?? []).map(({placeholderItemcode, bank, key, items, refilled, skippedRecorded, speakerFallback}) =>
      ({kind: 'bank', placeholderItemcode, bank, key, items, refilled, skippedRecorded, speakerFallback})),
    listDraws: (lists.trace ?? []).map(({placeholderItemcode, source, list, link, linked, key, items}) =>
      ({kind: 'list', placeholderItemcode, source, list, link, linked, key, items})),
  };
}

test('the receiver resolves every shared draw fixture to its recorded expectation', () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith('.draw.json')).sort();
  // The file set is part of the contract: keep in step with DRAW_FILES in the editor's core/draw-engine.spec.ts.
  assert.deepEqual(files.map((name) => name.replace(/\.draw\.json$/, '')).sort(),
    ['bank-and-list', 'bank-filter', 'bank-fixed-script', 'bank-fixed-speaker', 'bank-fixed-speaker-unknown', 'bank-media-kinds', 'bank-random-a', 'bank-random-b', 'bank-refill', 'bank-sequential', 'bank-unicode-session', 'list-linked', 'list-single', 'list-unlinked-fixed-by-script'],
    'the draw fixtures drifted from the editor\'s DRAW_FILES');
  for (const file of files) {
    const path = join(DIR, file);
    const fixture = JSON.parse(readFileSync(path, 'utf8'));
    const actual = resolveLikeTheReceiver(fixture);
    if (process.env.UPDATE_DRAW_FIXTURES === '1') {
      writeFileSync(path, `${JSON.stringify({...fixture, expect: actual}, null, 2)}\n`);
      continue;
    }
    assert.deepEqual(actual, fixture.expect, `${file}: ${fixture.note}`);
  }
});

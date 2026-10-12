/**
 * The editor's draw against the receiver's: every shared fixture (`doc/script-editor/draws/*.draw.json`)
 * is resolved here and must equal what the receiver recorded for it. A fixture that is not served is a
 * failure, not a skipped spec.
 */
import {randomFrom, resolveDraws, seedFrom, type DrawContext, type ListDoc} from './draw-engine';
import type {BankView} from './validation/types';

const DRAW_FILES = [
  'bank-and-list',
  'bank-filter',
  'bank-fixed-script',
  'bank-fixed-speaker-unknown',
  'bank-fixed-speaker',
  'bank-media-kinds',
  'bank-random-a',
  'bank-random-b',
  'bank-refill',
  'bank-sequential',
  'bank-unicode-session',
  'list-linked',
  'list-single',
  'list-unlinked-fixed-by-script',
] as const;

interface DrawFixture {
  note: string;
  banks?: Record<string, BankView>;
  lists?: Record<string, ListDoc>;
  script: unknown;
  context: {sessionId: string; speaker?: string; scriptId?: string; scriptVersion?: number; recordedBankItemIds?: string[]};
  expect: {script: unknown; bankDraws: unknown[]; listDraws: unknown[]};
}

async function load(name: string): Promise<DrawFixture | null> {
  try {
    const response = await fetch(`/draws/${name}.draw.json`);
    return response.ok ? ((await response.json()) as DrawFixture) : null;
  } catch {
    return null;
  }
}

function contextOf(fixture: DrawFixture): DrawContext {
  const {context} = fixture;
  return {
    sessionId: context.sessionId,
    speaker: context.speaker ?? null,
    scriptId: context.scriptId ?? null,
    scriptVersion: context.scriptVersion ?? null,
    recordedBankItemIds: new Set(context.recordedBankItemIds ?? []),
    bank: (bankId) => fixture.banks?.[bankId] ?? null,
    list: (listId) => fixture.lists?.[listId] ?? null,
  };
}

describe('the editor draw equals the receiver draw', () => {
  for (const name of DRAW_FILES) {
    it(`${name}.draw.json`, async () => {
      const fixture = await load(name);
      expect(fixture).withContext(`the fixture ${name}.draw.json is not served — check the karma assets`).not.toBeNull();
      if (fixture === null) {
        return;
      }
      const result = resolveDraws(fixture.script, contextOf(fixture));
      expect(result.unresolved).toEqual([]);
      expect(result.script).withContext(fixture.note).toEqual(fixture.expect.script);
      expect(result.bankDraws).toEqual(fixture.expect.bankDraws as never);
      expect(result.listDraws).toEqual(fixture.expect.listDraws as never);
    });
  }
});

describe('draw engine details', () => {
  it('seeds from code points, not UTF-16 units', () => {
    expect(seedFrom('\u{1F600}')).not.toBe(seedFrom('\uD83D', '\uDE00'));
    expect(seedFrom('a', 'b')).not.toBe(seedFrom('ab'));
  });

  it('is deterministic per seed', () => {
    const first = randomFrom(seedFrom('session:s1', 'RB', 'mixed'));
    const again = randomFrom(seedFrom('session:s1', 'RB', 'mixed'));
    expect([first(), first(), first()]).toEqual([again(), again(), again()]);
  });

  it('leaves a placeholder alone, and says why, when its bank or list is not available', () => {
    const script = {sections: [{groups: [{promptItems: [
      {itemcode: 'RB', prefill: {bank: {bank: 'gone', count: 1, itemcodePrefix: 'RB'}}},
      {itemcode: '6', prefill: {source: 'later'}},
    ]}]}]};
    const result = resolveDraws(script, {sessionId: 's', bank: () => null, list: () => undefined});
    expect(result.unresolved).toEqual([
      {itemcode: 'RB', kind: 'bank', id: 'gone', reason: 'missing'},
      {itemcode: '6', kind: 'list', id: 'later', reason: 'unavailable'},
    ]);
    expect(result.script).toEqual(script);
  });

  it('does not modify its input', () => {
    const script = {sections: [{groups: [{promptItems: [{itemcode: '6', prefill: {source: 'w', mediaitems: [{text: '{entry}'}]}}]}]}]};
    const before = JSON.stringify(script);
    resolveDraws(script, {sessionId: 's', bank: () => null, list: () => ({lists: [{id: '1', entries: ['a']}]})});
    expect(JSON.stringify(script)).toBe(before);
  });
});

import type {PrefillBankSource, PromptItem} from 'speechrecorderng';
import type {EditorScript} from '../core/script.model';
import {buildOrderRows, selectableRows} from './preview-order';

const DRAW_BANK: PrefillBankSource = {
  bank: 'std-passages',
  bankSource: 'BUILTIN',
  filter: {category: 'vowel', hasAudio: true},
  count: 2,
  itemcodePrefix: 'D',
  playBankAudio: true,
  playback: {when: 'DURING', replayable: true, maxReplays: 1},
  itemDefaults: {prerecdelay: 1000, recduration: 5000, postrecdelay: 500},
};

function textItem(itemcode: string, text: string): PromptItem {
  return {itemcode, mediaitems: [{mimetype: 'text/plain', text}]};
}

const PLACEHOLDER: PromptItem = {
  itemcode: 'D',
  mediaitems: [{mimetype: 'text/plain', text: 'Repeat the vowel {entry} after the model.'}],
  prefill: {bank: DRAW_BANK},
};

const SCRIPT: EditorScript = {
  scriptId: 'demo',
  name: 'Demo script',
  sections: [
    {
      name: 'Warm-up',
      mode: 'MANUAL',
      promptphase: 'IDLE',
      training: true,
      groups: [{order: 'SEQUENTIAL', promptItems: [textItem('W1', 'Say hello.')]}],
    },
    {
      name: 'Vowels',
      mode: 'MANUAL',
      promptphase: 'RECORDING',
      training: false,
      groups: [{order: 'RANDOMIZED', promptItems: [textItem('V1', 'Say a.'), PLACEHOLDER]}],
    },
  ],
};

describe('preview session order', () => {
  it('lists sections, groups and items in model order', () => {
    const rows = buildOrderRows(SCRIPT, 0);

    expect(rows.map((row) => row.kind)).toEqual([
      'section', 'group', 'item',
      'section', 'group', 'item', 'drawn-group', 'drawn', 'drawn',
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 0, 1, 2, 2, 3, 3]);
    expect(rows[0].label).toBe('Warm-up');
    expect(rows[2].label).toBe('W1');
    expect(rows[2].detail).toBe('Say hello.');
  });

  it('folds the drawn example in at the placeholder, marked as drawn', () => {
    const rows = buildOrderRows(SCRIPT, 0);
    const drawnRows = rows.filter((row) => row.kind === 'drawn');

    expect(drawnRows).toHaveSize(2);
    expect(drawnRows.map((row) => row.label)).toEqual(['D001', 'D002']);
    expect(drawnRows.every((row) => row.drawn)).toBe(true);
    expect(drawnRows.every((row) => row.bank === DRAW_BANK)).toBe(true);
    expect(drawnRows[0].entry).not.toBe(drawnRows[1].entry);

    const rule = rows.find((row) => row.kind === 'drawn-group');
    expect(rule?.drawn).toBe(true);
    expect(rule?.label).toBe('Drawn group: 2 × std-passages');
    expect(rule?.item).toBeNull();

    // The drawn rows sit directly under their rule, after the group's own item.
    expect(rows.indexOf(drawnRows[0])).toBe(rows.indexOf(rule!) + 1);
  });

  it('walks the drawn items at the placeholder position when the frame steps through', () => {
    const rows = selectableRows(buildOrderRows(SCRIPT, 0));

    expect(rows.map((row) => row.item?.itemcode)).toEqual(['W1', 'V1', 'D001', 'D002']);
    expect(rows.map((row) => row.key)).toEqual([
      's0g0i0', 's1g0i0', 's1g0i1-d0', 's1g0i1-d1',
    ]);
    expect(rows.filter((row) => row.drawn)).toHaveSize(2);
  });

  it('re-draws a different example with the same itemcodes', () => {
    const first = buildOrderRows(SCRIPT, 0).filter((row) => row.kind === 'drawn');
    const second = buildOrderRows(SCRIPT, 1).filter((row) => row.kind === 'drawn');

    expect(second.map((row) => row.label)).toEqual(['D001', 'D002']);
    expect(second.map((row) => row.entry)).not.toEqual(first.map((row) => row.entry));
    expect(second[0].detail).toBe(second[0].entry);
  });

  it('keeps a legacy promptUnits section flat instead of inventing groups', () => {
    const legacy: EditorScript = {
      scriptId: '1',
      sections: [
        {
          mode: 'MANUAL',
          promptphase: 'IDLE',
          training: false,
          promptUnits: [textItem('A1', 'One.'), textItem('A2', 'Two.')],
        },
      ],
    };
    const rows = buildOrderRows(legacy, 0);

    expect(rows.map((row) => row.kind)).toEqual(['section', 'item', 'item']);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1]);
    expect(rows[0].label).toBe('Section 1');
    expect(selectableRows(rows).map((row) => row.item?.itemcode)).toEqual(['A1', 'A2']);
  });

  it('numbers unnamed sections, groups and items', () => {
    const rows = buildOrderRows(
      {scriptId: '2', sections: [{groups: [{promptItems: [{mediaitems: [{text: 'x'}]}]}]}]},
      0,
    );

    expect(rows.map((row) => row.label)).toEqual(['Section 1', 'Group 1', 'Item 1']);
  });

  it('copes with a script that has no sections', () => {
    expect(buildOrderRows(null, 0)).toEqual([]);
    expect(buildOrderRows({scriptId: 'empty', sections: []}, 0)).toEqual([]);
  });
});

describe('buildOrderRows with the banks and lists read from the receiver', () => {
  const BANK = {
    bankId: 'std-passages',
    items: [
      {bankItemId: 'v1', text: 'a', category: 'vowel', audioSrc: 'media/a.wav'},
      {bankItemId: 'v2', text: 'e', category: 'vowel', audioSrc: 'media/e.wav'},
      {bankItemId: 's1', text: 'A sentence.', category: 'sentence'},
    ],
  };
  const LISTED: PromptItem = {
    itemcode: '6',
    mediaitems: [{mimetype: 'text/plain', text: 'Read'}],
    prefill: {source: 'words', itemcodeFormat: '6.{n}', mediaitems: [{mimetype: 'text/plain', text: '{entry}'}]},
  };
  const scriptWith = (...items: PromptItem[]): EditorScript => ({
    scriptId: 'demo',
    name: 'Demo',
    sections: [{mode: 'MANUAL', promptphase: 'IDLE', training: false, groups: [{order: 'SEQUENTIAL', promptItems: items}]}],
  } as EditorScript);
  const inputs = {
    bank: (id: string) => (id === 'std-passages' ? BANK : null),
    list: (id: string) => (id === 'words' ? {lists: [{id: '1', entries: ['apa', 'bil']}]} : null),
  };

  it('draws the bank\'s own items (filtered, with their bank audio), not the mock entries', () => {
    const rows = buildOrderRows(scriptWith(PLACEHOLDER), 0, inputs);
    const drawn = rows.filter((row) => row.kind === 'drawn');
    expect(drawn.map((row) => row.label)).toEqual(['D001', 'D002']);
    expect(drawn.map((row) => row.entry).sort()).toEqual(['a', 'e']);
    expect(drawn[0].item?.mediaitems.some((mediaitem) => mediaitem.src?.startsWith('media/'))).toBeTrue();
    expect(drawn[0].item?.playback).toEqual(DRAW_BANK.playback as never);
    expect((drawn[0].item as unknown as {bankItemId: string}).bankItemId).toMatch(/^v[12]$/);
  });

  it('is the same example for the same generation and another one after Re-draw', () => {
    const entries = (generation: number) => buildOrderRows(scriptWith(PLACEHOLDER), generation, inputs)
      .filter((row) => row.kind === 'drawn').map((row) => row.entry);
    expect(entries(0)).toEqual(entries(0));
    expect(Array.from({length: 8}, (_, generation) => entries(generation).join()).some((joined) => joined !== entries(0).join())).toBeTrue();
  });

  it('expands a list source into its entries under a drawn-list row', () => {
    const rows = buildOrderRows(scriptWith(LISTED), 0, inputs);
    expect(rows.filter((row) => row.kind === 'drawn-group').map((row) => row.label)).toEqual(['Drawn list: words']);
    expect(rows.filter((row) => row.kind === 'drawn').map((row) => [row.label, row.entry])).toEqual([['6.1', 'apa'], ['6.2', 'bil']]);
    expect(rows.filter((row) => row.kind === 'item')).toEqual([]);
  });

  it('falls back to mock entries for a bank that could not be read, and shows none for one that does not exist', () => {
    const unreadable = buildOrderRows(scriptWith(PLACEHOLDER), 0, {bank: () => undefined, list: () => undefined});
    expect(unreadable.filter((row) => row.kind === 'drawn').length).toBe(2);
    const gone = buildOrderRows(scriptWith(PLACEHOLDER), 0, {bank: () => null, list: () => null});
    expect(gone.filter((row) => row.kind === 'drawn')).toEqual([]);
    expect(gone.filter((row) => row.kind === 'drawn-group').length).toBe(1);
  });

  it('shows a list placeholder as a plain item when its list is not available', () => {
    const rows = buildOrderRows(scriptWith(LISTED), 0, {bank: () => undefined, list: () => undefined});
    expect(rows.filter((row) => row.kind === 'item').map((row) => row.label)).toEqual(['6']);
  });
});


/** E12–E15 and W14–W16: the checks for list sources (the STI word and sentence lists). */
import {checkE12, checkE13, checkE14, checkE15, checkW14, checkW15, checkW16, runChecks} from './index';
import {group, ids, item, listItem, listLookupOver, paths, script, section} from './test-helpers';

const P = (index: number) => `sections[0].groups[0].promptItems[${index}]`;
const withItems = (...items: unknown[]) => script({sections: [section({groups: [group({promptItems: items})]})]});

describe('E12 list source exists', () => {
  const listLookup = listLookupOver({words: [3, 2], empty: []});
  it('is clean when the list source exists', () => {
    expect(checkE12(withItems(listItem('6', 'words')), {listLookup})).toEqual([]);
  });
  it('flags a missing name, an unknown source and one with no lists', () => {
    const draft = withItems(listItem('6', ''), listItem('7', 'nope'), listItem('8', 'empty'));
    const findings = checkE12(draft, {listLookup});
    expect(ids(findings)).toEqual(['E12', 'E12', 'E12']);
    expect(paths(findings)).toEqual([0, 1, 2].map((index) => `${P(index)}.prefill.source`));
  });
  it('is suspended, not passed, when the library could not be read', () => {
    const findings = checkE12(withItems(listItem('6', 'words')), {listLookup: () => undefined});
    expect(findings.length).toBe(1);
    expect(findings[0].suspended).toBe(true);
    expect(findings[0].severity).toBe('warning');
  });
  it('does nothing without a lookup', () => {
    expect(checkE12(withItems(listItem('6', 'words')))).toEqual([]);
  });
});

describe('E13 one kind of source', () => {
  it('flags a prefill with both a list source and a bank source', () => {
    const both = item({itemcode: '6', prefill: {source: 'words', bank: {bank: 'b', count: 1, itemcodePrefix: 'P'}}});
    expect(paths(checkE13(withItems(both)))).toEqual([`${P(0)}.prefill`]);
    expect(checkE13(withItems(listItem('6', 'words')))).toEqual([]);
  });
});

describe('E14 itemcodeFormat numbers the items', () => {
  it('flags a format without {n}; the default {n} is fine', () => {
    expect(paths(checkE14(withItems(listItem('6', 'words', {itemcodeFormat: 'fixed'}))))).toEqual([`${P(0)}.prefill.itemcodeFormat`]);
    expect(checkE14(withItems(listItem('6', 'words', {itemcodeFormat: undefined})))).toEqual([]);
  });
});

describe('E15 generated itemcodes are free', () => {
  const listLookup = listLookupOver({words: [3, 2]});
  it('is clean when the generated range is free', () => {
    expect(checkE15(withItems(item({itemcode: '1'}), listItem('6', 'words')), {listLookup})).toEqual([]);
  });
  it('flags a fixed itemcode inside the range of the longest list', () => {
    const findings = checkE15(withItems(item({itemcode: '6.3'}), listItem('6', 'words')), {listLookup});
    expect(paths(findings)).toEqual([`${P(1)}.prefill.itemcodeFormat`]);
  });
  it('does not count the placeholder\'s own code, and flags two sources generating the same codes', () => {
    expect(checkE15(withItems(listItem('6', 'words', {itemcodeFormat: '{n}'})), {listLookup})).toEqual([]);
    const twice = withItems(listItem('6', 'words', {itemcodeFormat: '{n}'}), listItem('7', 'words', {itemcodeFormat: '{n}'}));
    expect(paths(checkE15(twice, {listLookup}))).toEqual([`${P(1)}.prefill.itemcodeFormat`]);
  });
  it('flags a code inside a bank source\'s reserved range', () => {
    const bank = item({itemcode: 'B', prefill: {bank: {bank: 'b', count: 5, itemcodePrefix: 'RB'}}});
    const findings = checkE15(withItems(bank, listItem('6', 'words', {itemcodeFormat: 'RB00{n}'})), {listLookup});
    expect(ids(findings)).toEqual(['E15']);
  });
  it('is silent when the source cannot be read', () => {
    expect(checkE15(withItems(item({itemcode: '6.1'}), listItem('6', 'words')), {listLookup: () => undefined})).toEqual([]);
  });
});

describe('W14 link', () => {
  it('warns about a link with one member', () => {
    const findings = checkW14(withItems(listItem('6', 'words', {link: 'sti'})), {listLookup: listLookupOver({words: [2]})});
    expect(paths(findings)).toEqual([`${P(0)}.prefill.link`]);
  });
  it('is clean for sources that share a list id, warns for sources that share none', () => {
    const draft = withItems(listItem('6', 'words', {link: 'sti'}), listItem('7', 'sentences', {link: 'sti'}));
    expect(checkW14(draft, {listLookup: listLookupOver({words: [2, 2], sentences: [3, 3]})})).toEqual([]);
    const disjoint = (id: string) => ({listId: id, lists: [{id: id === 'words' ? 'a' : 'b', entries: 1}]});
    expect(paths(checkW14(draft, {listLookup: disjoint}))).toEqual([`${P(1)}.prefill.link`]);
  });
});

describe('W15 select', () => {
  it('warns about a select other than random', () => {
    expect(paths(checkW15(withItems(listItem('6', 'words', {select: 'sequential'}))))).toEqual([`${P(0)}.prefill.select`]);
    expect(checkW15(withItems(listItem('6', 'words', {select: 'random'})))).toEqual([]);
  });
});

describe('W16 template shows the entry', () => {
  it('warns about a template that shows no {entry}', () => {
    const bare = listItem('6', 'words', {mediaitems: [{mimetype: 'text/plain', text: 'same'}]});
    expect(paths(checkW16(withItems(bare)))).toEqual([`${P(0)}.prefill.mediaitems`]);
    expect(checkW16(withItems(listItem('6', 'words')))).toEqual([]);
  });
});

describe('the catalogue runs them', () => {
  it('reports an unknown list source through runChecks', () => {
    const findings = runChecks(withItems(listItem('6', 'nope')), {listLookup: listLookupOver({})});
    expect(ids(findings)).toContain('E12');
  });
});

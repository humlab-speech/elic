/**
 * The shared cross-implementation fixture (doc/script-editor/checks/*.checks.json). The server runs
 * the same files from `server/checks-corpus.test.mjs`; this runner applies them to the editor's
 * implementation and reports what is missing or extra.
 */
import type {BankView, Finding, ValidationContext} from './types';
import {runChecks} from './index';

export interface CorpusExpect {
  id: string;
  path: string;
}

export interface CorpusDoc {
  note?: string;
  banks?: Record<string, BankView>;
  /** List sources by id, as stored: `{lists: [{id, entries}]}`. */
  lists?: Record<string, {lists: Array<{id: string | number; entries: string[]}>}>;
  draft: unknown;
  expect: CorpusExpect[];
}

export interface CorpusDiff {
  /** Expected findings the implementation did not produce. */
  missing: CorpusExpect[];
  /** Error findings the corpus did not declare (the corpus lists only the check under test). */
  unexpectedErrors: Finding[];
}

export interface CorpusResult {
  findings: Finding[];
  diff: CorpusDiff;
}

export function contextFor(doc: CorpusDoc): ValidationContext {
  const banks = doc.banks;
  const lists = doc.lists;
  return {
    bankLookup: banks === undefined ? undefined : (bankId: string) => banks[bankId] ?? null,
    listLookup: lists === undefined ? undefined : (listId: string) => {
      const stored = Object.prototype.hasOwnProperty.call(lists, listId) ? lists[listId] : undefined;
      return stored === undefined
        ? null
        : {listId, lists: stored.lists.map((list) => ({id: String(list.id), entries: list.entries.length}))};
    },
  };
}

export function runCorpus(doc: CorpusDoc): CorpusResult {
  const findings = runChecks(doc.draft, contextFor(doc));
  const expectedKeys = new Set(doc.expect.map((entry) => `${entry.id}|${entry.path}`));
  return {
    findings,
    diff: {
      missing: doc.expect.filter((entry) => !findings.some((finding) => finding.id === entry.id && finding.path === entry.path)),
      unexpectedErrors: findings.filter((finding) => finding.severity === 'error' && !expectedKeys.has(`${finding.id}|${finding.path}`)),
    },
  };
}

/** The corpus files, mirrored from `doc/script-editor/checks/`. */
export const CORPUS_FILES = [
  'bank-count',
  'bank-missing',
  'bank-prefix-clash',
  'clean',
  'duplicate-itemcode',
  'empty-item',
  'empty-script',
  'missing-itemcode',
  'negative-timing',
  'playback-bounds',
  'playback-without-audio',
  'bank-count-cap',
  'bank-prefix-across-sections',
  'list-clean',
  'list-source-missing',
  'list-source-empty-name',
  'list-source-and-bank',
  'list-format-without-n',
  'list-codes-clash',
  'list-codes-clash-between',
] as const;

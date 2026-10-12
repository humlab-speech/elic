/**
 * The editor's copy of the receiver's draw (`server/draw.mjs`): the rules that turn a script's bank and
 * list-source placeholders into prompt items. The tier-1 preview runs this so that what it shows is built
 * the way the receiver builds a session's script, not by a mock: same filter, same default order, same
 * seed, same generated fields.
 *
 * Fed the same inputs and the same session id, the receiver and this module produce the same items. The
 * shared fixtures in `doc/script-editor/draws/*.draw.json` hold both to that; the receiver's session id is
 * what a preview replaces with `preview:<script>:<generation>`.
 *
 * Pure: nothing here touches the network. An input that is not loaded (a bank or list the caller could not
 * read) leaves its placeholder as it was and is named in `unresolved`, never guessed.
 */
import type {BankItem, PrefillBankSource} from 'speechrecorderng';
import {matchesFilter} from './validation/filter';
import type {BankView} from './validation/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const POSITION_WIDTH = 3;

/** A list source as the receiver stores it. */
export interface ListDoc {
  lists: ReadonlyArray<{id: string | number; entries: ReadonlyArray<string>}>;
}

export interface DrawContext {
  sessionId: string;
  speaker?: string | null;
  scriptId?: string | number | null;
  scriptVersion?: number | null;
  /** Bank item ids the speaker has recorded (for `skipRecordedBySpeaker`). */
  recordedBankItemIds?: ReadonlySet<string>;
  /** `null`: no such bank; `undefined`: not loaded. */
  bank: (bankId: string) => BankView | null | undefined;
  list: (listId: string) => ListDoc | null | undefined;
}

export interface BankDrawTrace {
  kind: 'bank';
  placeholderItemcode: string | null;
  bank: string;
  key: string;
  items: Array<{itemcode: string; bankItemId: string}>;
  refilled: boolean;
  skippedRecorded: boolean;
  speakerFallback: boolean;
}

export interface ListDrawTrace {
  kind: 'list';
  placeholderItemcode: string;
  source: string;
  list: string;
  link: string | null;
  linked: boolean;
  key: string;
  items: Array<{itemcode: string; entry: string}>;
}

export interface DrawResult {
  script: Json;
  bankDraws: BankDrawTrace[];
  listDraws: ListDrawTrace[];
  /** Placeholders left as they were because a bank or list was not available, with the reason. */
  unresolved: Array<{itemcode: string | null; kind: 'bank' | 'list'; id: string; reason: 'missing' | 'unavailable'}>;
}

/** A stable 32-bit seed from any number of strings (FNV-1a over code points). */
export function seedFrom(...parts: unknown[]): number {
  let hash = 2166136261;
  for (const part of parts) {
    for (const char of String(part ?? '')) {
      hash ^= char.codePointAt(0) as number;
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 31;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32, written exactly as the receiver writes it. */
export function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function drawKey(
  fixedBy: string | undefined | null,
  ctx: Pick<DrawContext, 'sessionId' | 'speaker' | 'scriptId' | 'scriptVersion'>,
): string {
  switch (fixedBy ?? 'SESSION') {
    case 'SPEAKER':
      return `speaker:${ctx.speaker ?? ctx.sessionId}`;
    case 'SCRIPT':
      return `script:${ctx.scriptId}@${ctx.scriptVersion ?? ''}`;
    default:
      return `session:${ctx.sessionId}`;
  }
}

export function shuffle<T>(items: ReadonlyArray<T>, random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function itemcodeForPrefix(prefix: string | undefined | null, position: number): string {
  return `${prefix ?? ''}${String(position).padStart(POSITION_WIDTH, '0')}`;
}

/** Filter, drop what the speaker recorded, order, take `count`, then refill from the skipped items. */
export function chooseItems(
  bank: BankView | null | undefined,
  source: PrefillBankSource,
  excluded: ReadonlySet<string>,
  random: () => number,
): {chosen: BankItem[]; refilled: boolean} {
  const matching = (bank?.items ?? []).filter((item) => matchesFilter(item, source.filter ?? {}));
  const available = matching.filter((item) => !excluded.has(String(item.bankItemId)));
  const count = Number(source.count ?? 1);
  const ordered = source.order === 'SEQUENTIAL' ? available : shuffle(available, random);
  const chosen = ordered.slice(0, count);
  let refilled = false;
  if (chosen.length < count) {
    const skipped = matching.filter((item) => excluded.has(String(item.bankItemId)));
    for (const item of source.order === 'SEQUENTIAL' ? skipped : shuffle(skipped, random)) {
      if (chosen.length >= count) {
        break;
      }
      chosen.push(item);
      refilled = true;
    }
  }
  return {chosen, refilled};
}

/** The prompt items one bank source generates from its chosen bank items. */
export function generateBankItems(source: PrefillBankSource, chosen: ReadonlyArray<BankItem>): Json[] {
  const defaults = (source.itemDefaults ?? {}) as Record<string, unknown>;
  return chosen.map((bankItem: Json, index) => {
    const shown = bankItem.promptDoc !== undefined
      ? {promptDoc: bankItem.promptDoc}
      : (bankItem.src !== undefined ? {src: bankItem.src} : {text: bankItem.text ?? ''});
    const first: Json = {...shown};
    if (bankItem.mimetype !== undefined) {
      first.mimetype = bankItem.mimetype;
    } else if (first.text !== undefined) {
      first.mimetype = 'text/plain';
    }
    if (bankItem.alt !== undefined) {
      first.alt = bankItem.alt;
    }
    const mediaitems: Json[] = [first];
    if (source.playBankAudio === true && bankItem.audioSrc !== undefined) {
      mediaitems.push({
        mimetype: bankItem.audioMimetype ?? 'audio/wav',
        src: bankItem.audioSrc,
        ...(bankItem.alt === undefined ? {} : {alt: bankItem.alt}),
      });
    }
    const item: Json = {
      itemcode: itemcodeForPrefix(source.itemcodePrefix, index + 1),
      mediaitems,
      bankItemId: bankItem.bankItemId,
    };
    for (const field of ['prerecdelay', 'recduration', 'postrecdelay', 'recinstructions']) {
      if (defaults[field] !== undefined) {
        item[field] = defaults[field];
      }
    }
    if (source.playBankAudio === true && source.playback !== undefined) {
      item.playback = {...source.playback};
    }
    return item;
  });
}

const fill = (text: unknown, entry: string): unknown => (typeof text === 'string' ? text.split('{entry}').join(entry) : text);

/** The prompt items one list source generates from the entries of its drawn list. */
export function generateListItems(item: Json, spec: Json, entries: ReadonlyArray<string>): Json[] {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {prefill: _prefill, mediaitems: _mediaitems, itemcode: _itemcode, ...template} = item;
  const format: string = spec.itemcodeFormat ?? '{n}';
  return entries.map((entry, index) => {
    const generated: Json = {
      ...template,
      itemcode: format.split('{n}').join(String(index + 1)),
      mediaitems: (spec.mediaitems ?? []).map((mediaitem: Json) => {
        const filled = {...mediaitem};
        for (const field of ['text', 'src', 'alt']) {
          if (typeof mediaitem[field] === 'string') {
            filled[field] = fill(mediaitem[field], entry);
          }
        }
        return filled;
      }),
    };
    if (spec.recinstructions !== undefined && spec.recinstructions !== null) {
      generated.recinstructions = {recinstructions: spec.recinstructions};
    }
    return generated;
  });
}

interface Position {
  sectionIdx: number;
  groupIdx: number;
  itemIdx: number;
  itemcode: string | null;
}

function placeholders(script: Json, wanted: (item: Json) => boolean): Position[] {
  const found: Position[] = [];
  (script?.sections ?? []).forEach((section: Json, sectionIdx: number) => {
    (section?.groups ?? []).forEach((group: Json, groupIdx: number) => {
      (group?.promptItems ?? []).forEach((item: Json, itemIdx: number) => {
        if (wanted(item)) {
          found.push({sectionIdx, groupIdx, itemIdx, itemcode: item?.itemcode ?? null});
        }
      });
    });
  });
  return found;
}

function splice(resolved: Json, replacements: Array<{pos: Position; generated: Json[]}>): void {
  const byGroup = new Map<string, Array<{itemIdx: number; generated: Json[]}>>();
  for (const {pos, generated} of replacements) {
    const key = `${pos.sectionIdx}:${pos.groupIdx}`;
    byGroup.set(key, [...(byGroup.get(key) ?? []), {itemIdx: pos.itemIdx, generated}]);
  }
  for (const [key, list] of byGroup) {
    const [sectionIdx, groupIdx] = key.split(':').map(Number);
    const items = resolved.sections[sectionIdx].groups[groupIdx].promptItems;
    for (const {itemIdx, generated} of [...list].sort((a, b) => b.itemIdx - a.itemIdx)) {
      items.splice(itemIdx, 1, ...generated);
    }
  }
}

const hasBank = (item: Json): boolean => item?.prefill?.bank !== undefined && item?.prefill?.bank !== null;
const isListPlaceholder = (item: Json): boolean => item?.prefill?.source !== undefined && item?.prefill?.source !== null
  && !hasBank(item) && item?.itemcode != null;

/**
 * Resolves every bank source, then every list source, of a script the way the receiver resolves a
 * session's script. The input is not modified.
 */
export function resolveDraws(script: Json, ctx: DrawContext): DrawResult {
  const result: DrawResult = {script: structuredClone(script), bankDraws: [], listDraws: [], unresolved: []};
  resolveBanks(result, ctx);
  resolveLists(result, ctx);
  return result;
}

function resolveBanks(result: DrawResult, ctx: DrawContext): void {
  const base = result.script;
  const replacements: Array<{pos: Position; generated: Json[]}> = [];
  for (const pos of placeholders(base, hasBank)) {
    const source: PrefillBankSource = base.sections[pos.sectionIdx].groups[pos.groupIdx].promptItems[pos.itemIdx].prefill.bank;
    const bank = ctx.bank(source.bank);
    if (bank === null || bank === undefined) {
      result.unresolved.push({itemcode: pos.itemcode, kind: 'bank', id: String(source.bank), reason: bank === null ? 'missing' : 'unavailable'});
      continue;
    }
    const key = drawKey(source.fixedBy, ctx);
    const random = randomFrom(seedFrom(key, pos.itemcode ?? '', source.bank));
    const speakerKnown = ctx.speaker !== null && ctx.speaker !== undefined;
    const skip = source.skipRecordedBySpeaker === true && speakerKnown;
    const {chosen, refilled} = chooseItems(bank, source, skip ? (ctx.recordedBankItemIds ?? new Set()) : new Set(), random);
    const generated = generateBankItems(source, chosen);
    result.bankDraws.push({
      kind: 'bank',
      placeholderItemcode: pos.itemcode,
      bank: source.bank,
      key,
      items: generated.map((item) => ({itemcode: item.itemcode, bankItemId: item['bankItemId']})),
      refilled,
      skippedRecorded: skip,
      speakerFallback: source.fixedBy === 'SPEAKER' && !speakerKnown,
    });
    replacements.push({pos, generated});
  }
  splice(base, replacements);
}

function resolveLists(result: DrawResult, ctx: DrawContext): void {
  const base = result.script;
  const linkedIds = new Map<string, string>();
  const replacements: Array<{pos: Position; generated: Json[]}> = [];
  // The positions are read before any splice, from the script as it stands after the bank pass.
  for (const pos of placeholders(base, isListPlaceholder)) {
    const item: Json = base.sections[pos.sectionIdx].groups[pos.groupIdx].promptItems[pos.itemIdx];
    const spec: Json = item.prefill;
    const doc = ctx.list(String(spec.source));
    if (doc === null || doc === undefined || doc.lists.length === 0) {
      result.unresolved.push({itemcode: pos.itemcode, kind: 'list', id: String(spec.source), reason: doc === undefined ? 'unavailable' : 'missing'});
      continue;
    }
    const key = drawKey(spec.fixedBy, ctx);
    const link: string | null = spec.link === undefined || spec.link === null || spec.link === '' ? null : String(spec.link);
    let list = link === null ? undefined : doc.lists.find((candidate) => String(candidate.id) === linkedIds.get(link));
    const linked = list !== undefined;
    if (list === undefined) {
      const random = randomFrom(seedFrom(key, link ?? pos.itemcode, spec.source));
      list = doc.lists[Math.floor(random() * doc.lists.length)];
      if (link !== null) {
        linkedIds.set(link, String(list.id));
      }
    }
    const generated = generateListItems(item, spec, list.entries);
    result.listDraws.push({
      kind: 'list',
      placeholderItemcode: pos.itemcode as string,
      source: String(spec.source),
      list: String(list.id),
      link,
      linked,
      key,
      items: generated.map((made, index) => ({itemcode: made['itemcode'], entry: list.entries[index]})),
    });
    replacements.push({pos, generated});
  }
  splice(base, replacements);
}

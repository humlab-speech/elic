/**
 * Traversal helpers that keep every check's JSON paths identical to the server's
 * (`server/validate.mjs`) and the corpus fixtures.
 */
import type {Draft} from './types';

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function trimmedCode(item: unknown): string {
  const code = isObject(item) ? item['itemcode'] : undefined;
  return typeof code === 'string' ? code.trim() : '';
}

export function sectionPath(index: number): string {
  return `sections[${index}]`;
}

export function groupPath(sectionIndex: number, groupIndex: number): string {
  return `${sectionPath(sectionIndex)}.groups[${groupIndex}]`;
}

export function itemPath(sectionIndex: number, groupIndex: number, itemIndex: number): string {
  return `${groupPath(sectionIndex, groupIndex)}.promptItems[${itemIndex}]`;
}

export function bankPath(item: string): string {
  return `${item}.prefill.bank`;
}

export interface SectionRef {
  section: Record<string, unknown>;
  index: number;
  path: string;
}

export function eachSection(draft: Draft): SectionRef[] {
  const sections = arrayOf(draft?.sections);
  return sections.map((section, index) => ({
    section: isObject(section) ? section : {},
    index,
    path: sectionPath(index),
  }));
}

export interface GroupRef extends SectionRef {
  group: Record<string, unknown>;
  groupIndex: number;
  groupPath: string;
}

export function eachGroup(draft: Draft): GroupRef[] {
  const out: GroupRef[] = [];
  for (const s of eachSection(draft)) {
    arrayOf(s.section['groups']).forEach((group, groupIndex) => {
      out.push({
        ...s,
        group: isObject(group) ? group : {},
        groupIndex,
        groupPath: groupPath(s.index, groupIndex),
      });
    });
  }
  return out;
}

export interface ItemRef extends GroupRef {
  item: Record<string, unknown>;
  itemIndex: number;
  itemPath: string;
}

export function eachItem(draft: Draft): ItemRef[] {
  const out: ItemRef[] = [];
  for (const g of eachGroup(draft)) {
    arrayOf(g.group['promptItems']).forEach((item, itemIndex) => {
      out.push({
        ...g,
        item: isObject(item) ? item : {},
        itemIndex,
        itemPath: itemPath(g.index, g.groupIndex, itemIndex),
      });
    });
  }
  return out;
}

export interface BankRef extends ItemRef {
  bank: Record<string, unknown>;
  /** `${itemPath}.prefill.bank` */
  bankPath: string;
  /** The placeholder item's itemcode, excluded from its own reserved range (E05). */
  placeholder: string;
  bankId: string;
}

/** Every placeholder item that references a bank source (D-W). */
export function eachBankSource(draft: Draft): BankRef[] {
  const out: BankRef[] = [];
  for (const ref of eachItem(draft)) {
    const prefill = ref.item['prefill'];
    const bank = isObject(prefill) ? prefill['bank'] : undefined;
    if (!isObject(bank)) {
      continue;
    }
    const bankId = bank['bank'];
    out.push({
      ...ref,
      bank,
      bankPath: bankPath(ref.itemPath),
      placeholder: trimmedCode(ref.item),
      bankId: bankId === undefined || bankId === null ? '' : String(bankId),
    });
  }
  return out;
}

export interface ListRef extends ItemRef {
  prefill: Record<string, unknown>;
  /** `${itemPath}.prefill` */
  prefillPath: string;
  /** The placeholder item's itemcode. */
  placeholder: string;
  /** The raw `prefill.source`, which may be missing or malformed. */
  source: unknown;
  /** The `prefill.itemcodeFormat`, `{n}` when unset. */
  format: unknown;
  link: string | null;
}

/**
 * Every placeholder that names a list source (`prefill.source`, no bank source). A prefill with both is E13's
 * and is not a list source: the receiver draws the bank one.
 */
export function eachListSource(draft: Draft): ListRef[] {
  const out: ListRef[] = [];
  for (const ref of eachItem(draft)) {
    const prefill = ref.item['prefill'];
    if (!isObject(prefill) || prefill['source'] === undefined || prefill['source'] === null || hasBankSource(prefill)) {
      continue;
    }
    const link = prefill['link'];
    out.push({
      ...ref,
      prefill,
      prefillPath: `${ref.itemPath}.prefill`,
      placeholder: trimmedCode(ref.item),
      source: prefill['source'],
      format: prefill['itemcodeFormat'] ?? '{n}',
      link: typeof link === 'string' && link !== '' ? link : null,
    });
  }
  return out;
}

/** True when a prefill carries a bank source, whatever its shape (the receiver's test). */
export function hasBankSource(prefill: Record<string, unknown>): boolean {
  return prefill['bank'] !== undefined && prefill['bank'] !== null;
}

export function isNonRecordingItem(item: Record<string, unknown>): boolean {
  return item['type'] === 'nonrecording';
}

const AUDIO = /^audio/i;
const IMAGE = /^image/i;

export function isAudio(mediaitem: unknown): boolean {
  return isObject(mediaitem) && typeof mediaitem['mimetype'] === 'string' && AUDIO.test(mediaitem['mimetype']);
}

export function isImage(mediaitem: unknown): boolean {
  return isObject(mediaitem) && typeof mediaitem['mimetype'] === 'string' && IMAGE.test(mediaitem['mimetype']);
}

export function mediaitemsOf(item: Record<string, unknown>): unknown[] {
  return arrayOf(item['mediaitems']);
}

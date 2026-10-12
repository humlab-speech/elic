/**
 * The example draw shown on a drawn group (ui-spec §3.2). It is **an example**, never the
 * session's draw: the real draw is resolved once, server-side, at session creation
 * (data-model.md §2.2). What this module guarantees is that the example is deterministic — the
 * same bank, rule and offset always produce the same items — so a reload shows the same thing
 * and the "Draw another example" button walks a fixed sequence instead of a random one.
 *
 * Itemcodes use the reserved range the draw claims: `${prefix}001`, `${prefix}002`, …
 */
import type {BankItem, PrefillBankSource} from 'speechrecorderng';
import {chooseItems, drawKey, randomFrom, seedFrom} from '../core/draw-engine';
import {itemText} from '../core/validation/filter';
import type {BankView} from '../core/validation';

/** The reserved itemcode of the `position`-th drawn item (1-based). */
export function reservedCode(prefix: string, position: number): string {
  return `${prefix ?? ''}${String(position).padStart(3, '0')}`;
}

/** The codes a draw of `count` items reserves, e.g. `["RB001", "RB002"]`. */
export function previewCodes(prefix: string, count: number): string[] {
  const size = Number.isInteger(count) && count > 0 ? Math.min(count, 999) : 0;
  return Array.from({length: size}, (_, index) => reservedCode(prefix, index + 1));
}

export interface ExampleDrawItem {
  itemcode: string;
  text: string;
  bankItemId: string;
}

/**
 * Up to four example items for the rule, in draw order, drawn the way the receiver draws. Deterministic per
 * `(rule, offset)`: changing `offset` selects the next example, it never resolves the actual session draw.
 */
export function exampleDraw(
  bank: BankView | null | undefined,
  source: PrefillBankSource,
  offset = 0,
  placeholder = '',
): ExampleDrawItem[] {
  // The receiver's own rules (filter, default order, seed), keyed on a made-up session so that `offset`
  // walks through different examples. The placeholder's itemcode is part of the receiver's seed.
  const random = randomFrom(seedFrom(drawKey(source.fixedBy, {sessionId: `example#${offset}`}), placeholder, source.bank));
  const {chosen} = chooseItems(bank, source, new Set(), random);
  return chosen.slice(0, 4).map((item: BankItem, index: number) => ({
    itemcode: reservedCode(source.itemcodePrefix, index + 1),
    text: itemText(item) ?? item.bankItemId,
    bankItemId: item.bankItemId,
  }));
}

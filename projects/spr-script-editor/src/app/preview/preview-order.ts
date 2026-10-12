/**
 * The preview's session order list (ui-spec §4): "the sections/groups/items in order with drawn
 * items folded in at their place and marked drawn".
 *
 * The list is the session's walk order, so it is built from the model's real arrays — the same
 * fields `load.ts` fills and the recorder reads — and a drawn group is *expanded in place*: the
 * placeholder's rule becomes a "drawn group" row and the locally generated example items follow it
 * as rows marked `drawn`. `generation` is the Re-draw counter: it changes nothing but which
 * deterministic example is folded in (see `preview-draw.ts`).
 *
 * Structural rows (section/group/drawn group) are not selectable; item and drawn rows are, and
 * their `key` is what the URL carries.
 */
import type {PrefillBankSource, PromptItem} from 'speechrecorderng';
import {PREVIEW_STRINGS} from './preview-strings';
import type {EditorScript, EditorSection} from '../core/script.model';
import {exampleDraw, isDrawnPlaceholder} from './preview-draw';
import {resolveDraws, type DrawContext} from '../core/draw-engine';
import {promptTextOf} from './preview-stage';

export type OrderRowKind = 'section' | 'group' | 'drawn-group' | 'item' | 'drawn';

export interface OrderRow {
  /** Stable within a script; the URL's `?item=` value for the selectable rows. */
  key: string;
  kind: OrderRowKind;
  depth: 0 | 1 | 2 | 3;
  label: string;
  /** The row's second line: a group's order, an item's prompt text, a drawn example's entry. */
  detail: string | null;
  /** The item a selectable row stands for; null for the structural rows. */
  item: PromptItem | null;
  /** The bank placeholder the drawn rows come from. */
  bank: PrefillBankSource | null;
  /** The example entry of a drawn row. */
  entry: string | null;
  drawn: boolean;
  section: EditorSection;
  sectionIndex: number;
  groupIndex: number | null;
  itemIndex: number | null;
}

function itemLabel(item: PromptItem, index: number): string {
  return item.itemcode?.trim() || `${PREVIEW_STRINGS.itemOne} ${index + 1}`;
}

function itemRow(
  item: PromptItem,
  key: string,
  depth: 1 | 2,
  section: EditorSection,
  sectionIndex: number,
  groupIndex: number | null,
  itemIndex: number,
): OrderRow {
  return {
    key,
    kind: 'item',
    depth,
    label: itemLabel(item, itemIndex),
    detail: promptTextOf(item) || null,
    item,
    bank: null,
    entry: null,
    drawn: false,
    section,
    sectionIndex,
    groupIndex,
    itemIndex,
  };
}

/** What the preview knows of the banks and list sources the script draws from. */
export type PreviewDrawInputs = Pick<DrawContext, 'bank' | 'list'>;

/**
 * The order rows of a script, with the example draw of `generation` folded into each drawn group.
 *
 * With `inputs` the draw is the receiver's own (`core/draw-engine.ts`, held to it by shared fixtures): the
 * bank's real items and the list's real entries, drawn for the session id `preview:<script>:<generation>`.
 * A bank that could not be read falls back to the mock entries; without `inputs` everything is mock.
 */
export function buildOrderRows(
  script: EditorScript | null | undefined,
  generation: number,
  inputs?: PreviewDrawInputs,
): OrderRow[] {
  const strings = PREVIEW_STRINGS;
  const rows: OrderRow[] = [];
  const drawn = inputs === undefined || !script
    ? null
    : resolveDraws(script, {sessionId: `preview:${script.scriptId ?? ''}:${generation}`, scriptId: script.scriptId, ...inputs});
  const generated = new Map<string, PromptItem>();
  for (const section of drawn?.script.sections ?? []) {
    for (const group of section?.groups ?? []) {
      for (const made of group?.promptItems ?? []) {
        generated.set(String(made.itemcode), made as PromptItem);
      }
    }
  }
  (script?.sections ?? []).forEach((section, sectionIndex) => {
    rows.push({
      key: `s${sectionIndex}`,
      kind: 'section',
      depth: 0,
      label: section.name?.trim() || `${strings.sectionOne} ${sectionIndex + 1}`,
      detail: null,
      item: null,
      bank: null,
      entry: null,
      drawn: false,
      section,
      sectionIndex,
      groupIndex: null,
      itemIndex: null,
    });

    const groups = Array.isArray(section.groups) ? section.groups : null;
    if (groups === null) {
      // A legacy `promptUnits` section: its items hang directly off the section (data-model §4).
      (section.promptUnits ?? []).forEach((item, itemIndex) => {
        rows.push(itemRow(item, `s${sectionIndex}-i${itemIndex}`, 1, section, sectionIndex, null, itemIndex));
      });
      return;
    }

    groups.forEach((group, groupIndex) => {
      const items = group.promptItems ?? [];
      rows.push({
        key: `s${sectionIndex}g${groupIndex}`,
        kind: 'group',
        depth: 1,
        label: `${strings.groupOne} ${groupIndex + 1}`,
        detail: `${group.order ?? 'SEQUENTIAL'} · ${items.length} ${strings.itemsWord}`,
        item: null,
        bank: null,
        entry: null,
        drawn: false,
        section,
        sectionIndex,
        groupIndex,
        itemIndex: null,
      });

      items.forEach((item, itemIndex) => {
        const key = `s${sectionIndex}g${groupIndex}i${itemIndex}`;
        const listDraw = drawn?.listDraws.find((draw) => draw.placeholderItemcode === item.itemcode);
        if (listDraw !== undefined) {
          rows.push({
            key: `${key}-rule`,
            kind: 'drawn-group',
            depth: 2,
            label: `${strings.drawnListLabel}: ${listDraw.source}`,
            detail: `${strings.listWord} ${listDraw.list} · ${listDraw.items.length} ${strings.itemsWord}`,
            item: null,
            bank: null,
            entry: null,
            drawn: true,
            section,
            sectionIndex,
            groupIndex,
            itemIndex,
          });
          listDraw.items.forEach((made, exampleIndex) => {
            rows.push({
              key: `${key}-d${exampleIndex}`,
              kind: 'drawn',
              depth: 3,
              label: made.itemcode,
              detail: made.entry,
              item: generated.get(made.itemcode) ?? null,
              bank: null,
              entry: made.entry,
              drawn: true,
              section,
              sectionIndex,
              groupIndex,
              itemIndex,
            });
          });
          return;
        }
        if (!isDrawnPlaceholder(item) || !item.prefill?.bank) {
          rows.push(itemRow(item, key, 2, section, sectionIndex, groupIndex, itemIndex));
          return;
        }
        const bank = item.prefill.bank;
        // The rule row sits where the placeholder sits: one level under its group.
        rows.push({
          key: `${key}-rule`,
          kind: 'drawn-group',
          depth: 2,
          label: `${strings.drawnGroupLabel}: ${bank.count} × ${bank.bank}`,
          detail: `${strings.fromWord} ${bank.bankSource}`,
          item: null,
          bank,
          entry: null,
          drawn: true,
          section,
          sectionIndex,
          groupIndex,
          itemIndex,
        });
        const bankDraw = drawn?.bankDraws.find((draw) => draw.placeholderItemcode === item.itemcode);
        const missing = drawn?.unresolved.some((entry) => entry.itemcode === item.itemcode && entry.reason === 'missing') === true;
        const examples = bankDraw !== undefined
          ? bankDraw.items.map((made) => {
            const madeItem = generated.get(made.itemcode) as PromptItem;
            return {itemcode: made.itemcode, entry: promptTextOf(madeItem) || made.bankItemId, item: madeItem};
          })
          : (missing ? [] : exampleDraw(bank, script?.scriptId, sectionIndex, groupIndex, itemIndex, generation, item.mediaitems ?? []));
        examples.forEach((example, exampleIndex) => {
          rows.push({
            key: `${key}-d${exampleIndex}`,
            kind: 'drawn',
            depth: 3,
            label: example.itemcode,
            detail: example.entry,
            item: example.item,
            bank,
            entry: example.entry,
            drawn: true,
            section,
            sectionIndex,
            groupIndex,
            itemIndex,
          });
        });
      });
    });
  });
  return rows;
}

/** The rows the frame can show: items and drawn examples, in session order. */
export function selectableRows(rows: readonly OrderRow[]): OrderRow[] {
  return rows.filter((row) => row.item !== null);
}

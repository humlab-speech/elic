/**
 * Error checks E01–E11 (doc/script-editor/validation.md). Every function is pure:
 * `(draft, context) => Finding[]`, with ids and paths held byte-for-byte against
 * `server/validate.mjs` and `doc/script-editor/checks/*.checks.json`.
 */
import {EDITOR_STRINGS} from '../editor-strings';
import type {Draft, Finding, ValidationContext} from './types';
import {filterOf, queryBank} from './filter';
import {fillTemplate} from './interpolate';
import {eachBankSource, eachItem, eachListSource, eachSection, hasBankSource, isAudio, isObject, mediaitemsOf, trimmedCode} from './walk';

const S = EDITOR_STRINGS.validation;

/** The item timing keys the recorder reads; a negative or non-numeric value is E09. */
export const TIMING_FIELDS = ['prerecdelay', 'prerecording', 'recduration', 'duration', 'postrecording', 'postrecdelay'];
const NON_NEGATIVE_PLAYBACK_FIELDS = ['gap', 'maxReplays'];

function error(id: string, path: string, message: string, fix?: Finding['fix'], data?: Finding['data']): Finding {
  const finding: Finding = {id, severity: 'error', path, message};
  if (fix !== undefined) {
    finding.fix = fix;
  }
  if (data !== undefined) {
    finding.data = data;
  }
  return finding;
}

/** E01 — a `itemcode` that is empty or only whitespace. */
export function checkE01(draft: Draft): Finding[] {
  const findings: Finding[] = [];
  for (const {item, itemPath: path} of eachItem(draft)) {
    if (trimmedCode(item) === '') {
      findings.push(error('E01', `${path}.itemcode`, S.e01, 'focus'));
    }
  }
  return findings;
}

/** E02 — two items sharing an `itemcode`; the second occurrence is flagged. */
export function checkE02(draft: Draft): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, string>();
  for (const {item, itemPath: path} of eachItem(draft)) {
    const code = trimmedCode(item);
    if (code === '') {
      continue;
    }
    const first = seen.get(code);
    if (first !== undefined) {
      findings.push(error('E02', `${path}.itemcode`, S.e02, 'next-code', {first}));
    } else {
      seen.set(code, path);
    }
  }
  return findings;
}

/** E03 — a bank source that names no bank, or one that does not exist. */
export function checkE03(draft: Draft, context: ValidationContext = {}): Finding[] {
  const findings: Finding[] = [];
  for (const ref of eachBankSource(draft)) {
    if (ref.bankId.trim() === '') {
      findings.push(error('E03', `${ref.bankPath}.bank`, S.e03NoBank, 'bank-picker'));
      continue;
    }
    if (context.bankLookup === undefined) {
      continue;
    }
    if (context.bankLookup(ref.bankId) === null) {
      findings.push(error('E03', `${ref.bankPath}.bank`, fillTemplate(S.e03Missing, {bankId: ref.bankId}), 'bank-picker'));
    }
  }
  return findings;
}

/** E04 — the draw `count` exceeds the filter's `matchCount`; suspended when the bank cannot be read. */
export function checkE04(draft: Draft, context: ValidationContext = {}): Finding[] {
  const findings: Finding[] = [];
  for (const ref of eachBankSource(draft)) {
    if (ref.bankId.trim() === '') {
      continue;
    }
    const count = Number(ref.bank['count']);
    if (!Number.isInteger(count) || count < 1) {
      // The count itself is malformed; E09 owns that.
      continue;
    }
    const view = context.bankLookup?.(ref.bankId);
    if (view === undefined) {
      findings.push({
        id: 'E04',
        severity: 'warning',
        path: `${ref.bankPath}.count`,
        message: S.e04Suspended,
        suspended: true,
      });
      continue;
    }
    if (view === null) {
      continue;
    }
    const {matchCount} = queryBank(view, filterOf(ref.bank));
    if (count > matchCount) {
      findings.push(error(
        'E04',
        `${ref.bankPath}.count`,
        fillTemplate(S.e04, {matchCount}),
        'clamp-count',
        {matchCount},
      ));
    }
  }
  return findings;
}

interface ReservedRange {
  prefix: string;
  count: number;
  path: string;
  placeholder: string;
}

function reservedRanges(draft: Draft, findings: Finding[]): ReservedRange[] {
  const ranges: ReservedRange[] = [];
  for (const ref of eachBankSource(draft)) {
    const prefix = ref.bank['itemcodePrefix'];
    const count = Number(ref.bank['count']);
    if (prefix === undefined || prefix === null || String(prefix) === '') {
      findings.push(error('E05', `${ref.bankPath}.itemcodePrefix`, S.e05PrefixMissing, 'free-prefix'));
      continue;
    }
    if (Number.isInteger(count) && count >= 1) {
      ranges.push({prefix: String(prefix), count, path: ref.bankPath, placeholder: ref.placeholder});
    }
  }
  return ranges;
}

/** E05 — a fixed itemcode inside a reserved range, or two bank sources sharing a prefix. */
export function checkE05(draft: Draft): Finding[] {
  const findings: Finding[] = [];
  const codes: Array<{code: string; path: string}> = [];
  for (const {item, itemPath: path} of eachItem(draft)) {
    const code = trimmedCode(item);
    if (code !== '') {
      codes.push({code, path: `${path}.itemcode`});
    }
  }
  const ranges = reservedRanges(draft, findings);

  const byPrefix = new Map<string, ReservedRange>();
  for (const range of ranges) {
    const previous = byPrefix.get(range.prefix);
    if (previous !== undefined) {
      findings.push(error(
        'E05',
        `${range.path}.itemcodePrefix`,
        fillTemplate(S.e05PrefixClash, {prefix: range.prefix, path: previous.path}),
        'free-prefix',
        {prefix: range.prefix},
      ));
    } else {
      byPrefix.set(range.prefix, range);
    }
  }

  for (const range of ranges) {
    const escaped = range.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reserved = new RegExp(`^${escaped}(\\d{3,})$`);
    for (const {code, path} of codes) {
      if (code === range.placeholder) {
        continue;
      }
      const match = reserved.exec(code);
      if (match !== null && Number(match[1]) <= range.count) {
        const last = String(range.count).padStart(3, '0');
        findings.push(error(
          'E05',
          path,
          fillTemplate(S.e05Reserved, {prefix: range.prefix, last, path: range.path}),
          'free-prefix',
          {prefix: range.prefix, count: range.count},
        ));
      }
    }
  }
  return findings;
}

/** E06 — `playback` without an audio mediaitem to play. */
export function checkE06(draft: Draft): Finding[] {
  const findings: Finding[] = [];
  for (const {item, itemPath: path} of eachItem(draft)) {
    if (item['playback'] === undefined || item['playback'] === null) {
      continue;
    }
    if (!mediaitemsOf(item).some(isAudio)) {
      findings.push(error('E06', `${path}.playback`, S.e06, 'file-picker'));
    }
  }
  return findings;
}

/**
 * E07 — the item shows nothing and plays nothing: no entry of `mediaitems` carries `text`, `promptDoc` or `src`, and
 * none of them is audio. The **whole list** is considered, which is what `server/validate.mjs` does and what
 * validation.md's trigger says.
 *
 * It used to read `mediaitems[0]` and to treat a `playback` as something to play, so the editor could refuse a script
 * the server would publish — the opposite of this pass's own principle that a client-side check is not the gate
 * (§11.249).
 */
export function checkE07(draft: Draft): Finding[] {
  const findings: Finding[] = [];
  for (const {item, itemPath: path} of eachItem(draft)) {
    const mediaitems = mediaitemsOf(item);
    const shows = mediaitems.some((entry) => isObject(entry)
      && ((entry['text'] !== undefined && entry['text'] !== null)
        || (entry['promptDoc'] !== undefined && entry['promptDoc'] !== null)
        || (entry['src'] !== undefined && entry['src'] !== null)));
    if (!shows && !mediaitems.some((entry) => isAudio(entry))) {
      findings.push(error('E07', `${path}.mediaitems`, S.e07));
    }
  }
  return findings;
}

/** E08 — retired by D-W: a group can no longer hold both a rule and a fixed list. */
export function checkE08(): Finding[] {
  return [];
}

/** E09 — a bad draw count, or a timing field that is negative or not a number. */
export function checkE09(draft: Draft): Finding[] {
  const findings: Finding[] = [];
  for (const ref of eachBankSource(draft)) {
    const count = Number(ref.bank['count']);
    if (!Number.isInteger(count) || count < 1) {
      findings.push(error('E09', `${ref.bankPath}.count`, S.e09Count));
    }
  }
  for (const {item, itemPath: path} of eachItem(draft)) {
    for (const field of TIMING_FIELDS) {
      const value = item[field];
      if (value === undefined || value === null) {
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        findings.push(error('E09', `${path}.${field}`, fillTemplate(S.e09Timing, {field})));
      }
    }
  }
  return findings;
}

/** E10 — a script with no section, or a section with no group. */
export function checkE10(draft: Draft): Finding[] {
  const findings: Finding[] = [];
  const sections = Array.isArray(draft?.sections) ? draft.sections : [];
  if (sections.length === 0) {
    findings.push(error('E10', 'sections', S.e10, 'add-group'));
    return findings;
  }
  for (const {section, path} of eachSection(draft)) {
    const groups = section['groups'];
    if (!Array.isArray(groups) || groups.length === 0) {
      findings.push(error('E10', `${path}.groups`, S.e10, 'add-group'));
    }
  }
  return findings;
}

/** E11 — counters and view boxes out of range. */
export function checkE11(draft: Draft): Finding[] {
  const findings: Finding[] = [];
  for (const ref of eachBankSource(draft)) {
    const count = Number(ref.bank['count']);
    if (Number.isInteger(count) && count > 999) {
      findings.push(error('E11', `${ref.bankPath}.count`, S.e11Count));
    }
  }
  for (const {item, itemPath: path} of eachItem(draft)) {
    const playback: unknown = item['playback'];
    if (isObject(playback)) {
      const repeats = playback['repeats'];
      if (repeats !== undefined && (!Number.isInteger(repeats) || (repeats as number) < 1)) {
        findings.push(error('E11', `${path}.playback.repeats`, S.e11Repeats));
      }
      for (const field of NON_NEGATIVE_PLAYBACK_FIELDS) {
        const value = playback[field];
        if (value !== undefined && (!Number.isFinite(value) || (value as number) < 0)) {
          findings.push(error('E11', `${path}.playback.${field}`, fillTemplate(S.e11NonNegative, {field})));
        }
      }
    }
    mediaitemsOf(item).forEach((mediaitem, mediaIndex) => {
      const box = isObject(mediaitem) ? mediaitem['defaultVirtualViewBox'] : undefined;
      const value = isObject(box) ? box['height'] : undefined;
      if (value !== undefined && !(typeof value === 'number' && value > 0)) {
        findings.push(error(
          'E11',
          `${path}.mediaitems[${mediaIndex}].defaultVirtualViewBox.height`,
          S.e11Height,
        ));
      }
    });
  }
  return findings;
}

/** E12 — a list source that is not named, does not exist or holds no lists; suspended when it cannot be read. */
export function checkE12(draft: Draft, context: ValidationContext = {}): Finding[] {
  const findings: Finding[] = [];
  for (const ref of eachListSource(draft)) {
    const path = `${ref.prefillPath}.source`;
    if (typeof ref.source !== 'string' || ref.source.trim() === '') {
      findings.push(error('E12', path, S.e12NoSource, 'focus'));
      continue;
    }
    const view = context.listLookup?.(ref.source);
    if (context.listLookup === undefined) {
      continue;
    }
    if (view === undefined) {
      findings.push({id: 'E12', severity: 'warning', path, message: S.e12Suspended, suspended: true});
    } else if (view === null) {
      findings.push(error('E12', path, fillTemplate(S.e12Missing, {listId: ref.source}), 'focus'));
    } else if (view.lists.length === 0) {
      findings.push(error('E12', path, fillTemplate(S.e12Empty, {listId: ref.source}), 'focus'));
    }
  }
  return findings;
}

/** E13 — one prefill with both a list source and a bank source. */
export function checkE13(draft: Draft): Finding[] {
  const findings: Finding[] = [];
  for (const {item, itemPath: path} of eachItem(draft)) {
    const prefill = item['prefill'];
    if (isObject(prefill) && prefill['source'] !== undefined && prefill['source'] !== null && hasBankSource(prefill)) {
      findings.push(error('E13', `${path}.prefill`, S.e13, 'focus'));
    }
  }
  return findings;
}

/** The format as a usable template, or null when it lacks `{n}`. */
function usableFormat(format: unknown): string | null {
  return typeof format === 'string' && format.includes('{n}') ? format : null;
}

/** E14 — an `itemcodeFormat` without `{n}`: every generated item would get the same code. */
export function checkE14(draft: Draft): Finding[] {
  const findings: Finding[] = [];
  for (const ref of eachListSource(draft)) {
    if (usableFormat(ref.format) === null) {
      findings.push(error('E14', `${ref.prefillPath}.itemcodeFormat`, S.e14, 'focus'));
    }
  }
  return findings;
}

/**
 * E15 — the codes a list source generates (1…its longest list) meet a fixed itemcode, a bank range or
 * another list source's codes. The longest list is the worst case: any draw can pick it.
 */
export function checkE15(draft: Draft, context: ValidationContext = {}): Finding[] {
  const findings: Finding[] = [];
  const lookup = context.listLookup;
  if (lookup === undefined) {
    return findings;
  }
  const claimed = new Map<string, string>();
  for (const {item, itemPath: path} of eachItem(draft)) {
    const code = trimmedCode(item);
    const prefill = item['prefill'];
    const isListSource = isObject(prefill) && prefill['source'] !== undefined && prefill['source'] !== null && !hasBankSource(prefill);
    if (code !== '' && !isListSource && !(isObject(prefill) && hasBankSource(prefill))) {
      claimed.set(code, path);
    }
  }
  const ranges = reservedRanges(draft, []);
  for (const ref of eachListSource(draft)) {
    const format = usableFormat(ref.format);
    const view = typeof ref.source === 'string' ? lookup(ref.source) : undefined;
    if (format === null || view === null || view === undefined || view.lists.length === 0) {
      continue;
    }
    const longest = Math.max(...view.lists.map((list) => list.entries));
    const mine: string[] = [];
    for (let n = 1; n <= longest; n++) {
      mine.push(format.split('{n}').join(String(n)));
    }
    for (const code of mine) {
      const other = claimed.get(code) ?? bankRangePath(ranges, code);
      if (other !== undefined) {
        findings.push(error('E15', `${ref.prefillPath}.itemcodeFormat`, fillTemplate(S.e15, {code, path: other})));
        break;
      }
    }
    for (const code of mine) {
      if (!claimed.has(code)) {
        claimed.set(code, ref.prefillPath);
      }
    }
  }
  return findings;
}

function bankRangePath(ranges: ReservedRange[], code: string): string | undefined {
  for (const range of ranges) {
    const escaped = range.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^${escaped}(\\d{3,})$`).exec(code);
    if (match !== null && Number(match[1]) <= range.count) {
      return range.path;
    }
  }
  return undefined;
}

/** Every error check, in catalogue order. */
export function runErrorChecks(draft: Draft, context: ValidationContext = {}): Finding[] {
  return [
    ...checkE01(draft),
    ...checkE02(draft),
    ...checkE03(draft, context),
    ...checkE04(draft, context),
    ...checkE05(draft),
    ...checkE06(draft),
    ...checkE07(draft),
    ...checkE08(),
    ...checkE09(draft),
    ...checkE10(draft),
    ...checkE11(draft),
    ...checkE12(draft, context),
    ...checkE13(draft),
    ...checkE14(draft),
    ...checkE15(draft, context),
  ];
}

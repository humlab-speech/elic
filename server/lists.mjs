/**
 * List sources: the word and sentence lists a `prefill.source` placeholder expands from (the STI lists).
 *
 * A list source is a document of its own, `{name?, lists: [{id, entries: [string…]}]}`, kept beside the
 * scripts in `list/<id>.json` (a flat `script/<id>.json` with `lists` and no `sections` is the legacy
 * place and still read). One list is drawn per placeholder and expanded into one prompt item per entry
 * (`draw.mjs`).
 */
import {createHash} from 'node:crypto';

/** True for a document that is a list source, not a script. */
export function isListDoc(doc) {
  return doc !== null && typeof doc === 'object' && !Array.isArray(doc) && Array.isArray(doc.lists) && !Array.isArray(doc.sections);
}

/** A short digest of the content a draw reads, written into the draw trace so a later edit is visible. */
export function contentHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * The findings for a list source document: `{id, path, message}`, ids `L01`–`L05`.
 * Empty means the document can be saved.
 */
export function validateListSource(doc) {
  const findings = [];
  const add = (id, path, message) => findings.push({id, severity: 'error', path, message});
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    add('L01', '', 'A list source must be a JSON object with a "lists" array.');
    return findings;
  }
  if (!Array.isArray(doc.lists)) {
    add('L01', 'lists', 'A list source needs a "lists" array.');
    return findings;
  }
  if (doc.lists.length === 0) {
    add('L02', 'lists', 'A list source needs at least one list.');
  }
  const seen = new Map();
  for (const [index, list] of doc.lists.entries()) {
    const path = `lists[${index}]`;
    const id = list?.id;
    if (typeof id !== 'string' && typeof id !== 'number') {
      add('L03', `${path}.id`, 'Every list needs an id.');
    } else if (String(id).trim() === '') {
      add('L03', `${path}.id`, 'A list id cannot be empty.');
    } else if (seen.has(String(id))) {
      add('L04', `${path}.id`, `List id ${id} is already used at ${seen.get(String(id))}.`);
    } else {
      seen.set(String(id), path);
    }
    if (!Array.isArray(list?.entries) || list.entries.length === 0) {
      add('L05', `${path}.entries`, 'A list needs at least one entry.');
      continue;
    }
    for (const [entryIndex, entry] of list.entries.entries()) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        add('L05', `${path}.entries[${entryIndex}]`, 'An entry must be a non-empty string.');
      }
    }
  }
  return findings;
}

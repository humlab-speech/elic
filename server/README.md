# The receiver

The REST API the recorder and the script editor talk to. It is the **draft of the production
server**: the API shape and the on-disk layout in `store.mjs` are contracts, so a layout change
ships with a migration.

Node builtins only — no dependencies, no install step.

## Run

```bash
npm run serve:api                                   # http://127.0.0.1:8080, data in server/data
npm run serve:api -- --port 4301 --data /tmp/spr --seed src/test
node server/server.mjs --help
```

`--api-base` must match the application's `apiEndPoint` (`/api/v1` by default). The data directory
is seeded from `--seed` (`src/test` by default) on first run; `server/data` is gitignored.

## Tests

```bash
node --test server/*.test.mjs   # drafts, publish, validation corpus, banks, media, draw
                                # resolution, previews, maintenance
```

The explicit file list, not `server/`: Node 22's runner treats a directory argument as an entry
module (`MODULE_NOT_FOUND`) and only learned to scan one in a later major (plan §11.48).

CI runs this and the other five jobs (`.github/workflows/tests.yml`).

## Data layout

```
<data>/project/<id>.json              project configuration
<data>/project/<id>/<resource>        project resources (images, media/)
<data>/project/<id>/media/<name>      uploaded clips and images (+ index.json for duration)
<data>/script/<id>/meta.json          name, archived, publishedVersion, draftVersion, layoutVersion
<data>/script/<id>/published.json     what GET script/{id} serves
<data>/script/<id>/draft.json         current draft (ETag = sha256 of these bytes)
<data>/script/<id>/versions/<n>.json  immutable published versions (never pruned)
<data>/script/<id>/versions.json      the published version index, newest first
<data>/script/<id>/revisions/<n>.json draft snapshots (pruned by gc)
<data>/script/<id>.json               legacy flat script: read as published v1, never written
<data>/session/<id>.json              session; bank draws (bankDraws), list draws (listDraws, prefills) are recorded here
<data>/recordingfile/<id>.{json,wav}  recording metadata and audio
<data>/bank/<id>.json                 item banks (BUILTIN banks are read-only)
<data>/uploads/                       runtime state: idempotency journal, chunk sessions, ids
```

## Draws and the session lifecycle

Bank sources (`prefill.bank`) and list sources (`prefill.source`, the STI word and sentence lists) are both
drawn **on the receiver**; the recorder gets a materialised script with nothing left to expand.
`GET session/{id}` is a *launch*: while nothing is recorded the draw is made again (new `redraw` seed), the
first stored recording freezes it. `fixedBy` SPEAKER/SCRIPT keeps the same items across launches. Each
recording's metadata carries `draw` (source, list or bank item, key, redraw) and `promptMissing` when its
itemcode is not in the script. `PATCH session` accepts progress fields only; status never moves back.

## Maintenance

```bash
node server/server.mjs --data <dir> --migrate          # per-script layout for legacy flat scripts
node server/server.mjs --data <dir> --gc               # prune draft revisions + expired previews
node server/server.mjs --data <dir> --gc --gc-media    # also delete unreferenced media
node server/server.mjs --data <dir> --gc --gc-journal 500 --gc-uploads 30   # also bound the two below
```

* **Draft revisions** are kept 50 deep and 30 days (see `Store.pruneDraftRevisions`).
* **Unreferenced** means no draft, no published version and no **bank item** names the file: a drawn
  group plays the recording its bank item points at, so a clip only a bank refers to is in use and
  `--gc-media` leaves it alone (plan §11.51).
* **Preview sessions** (`type: "TEST"`) expire; `gc` removes the session and its materialised script,
  never the source script.
* **Published versions and recordings are never touched** by `gc`.
* **Two kinds of runtime state are bounded by age, by default** (§11.255): `uploads/journal.json` (the idempotency
  answers) drops entries older than **30 days**, and `uploads/chunk-<uuid>/` — an upload that was started and never
  published — is collected after **7** (`server/store.mjs`). Both also happen in `open()`, so a deployment that never
  runs maintenance still bounds them. `--gc-journal <keep>` and `--gc-uploads <days>` tighten either further: a count,
  or a shorter age. Age is what makes the chunk collection safe although a session is **resumable** — a client still
  finishing its upload is inside the window by construction.
  Independently of retention, a file or record `--gc` cannot read **or remove** — a corrupt `meta.json`, a corrupt
  journal, media in
  a directory it may not write — is named in the log and skipped, and the counts say what actually
  happened rather than what was found: the command prunes everything else and never stops on the state
  it exists to clean up.
* `--migrate` is idempotent and is safe to run on every deployment.
* **Run these against a stopped receiver.** The store assumes one process owns the data directory (Production notes),
  and that matters most here: a *serving* receiver holds the idempotency journal in memory, so a trim it never saw is
  rewritten wholesale by its next remembered write — the entries `--gc-journal` removed come back.

## Backup, restore, transfer

The whole state is the data directory: stop nothing, copy the tree (rsync, tar), restore it into a
fresh `--data`. Do not copy `uploads/tmp`. To move a deployment to a newer receiver build, copy the
tree and run `--migrate` once; the layout version in each `meta.json` says which layout a script is
in. Verify with `--gc` (read-only for versions) and by fetching a published script.

## Production notes

**One receiver owns a data directory.** Nothing here locks: every write is a read-modify-write of a
JSON file (`journal.json`, the version indexes, `meta.json`, the draft revision counter), so a second
process on the same `--data` would corrupt more than it saves. That is also what lets `open()` clear
the `*.json.tmp-<pid>` files an interrupted write leaves behind — no other writer's temp file can be
in flight (`Store.sweepTempFiles`; inside `project/<p>/media/`, whose other names come from the
uploader, only the index's own temp file is collectable). It is best effort: a directory it cannot
read, or a file it cannot remove, is logged by name and skipped — housekeeping never stops the
receiver from starting, whatever it finds under `--data`.

The receiver itself has no authentication; the deployment puts it behind the same protection as the
recorder (the sample `apache_www_htaccess_sample.txt` shows the SPA fallback pattern). Auth, CSRF,
retention policy and backups belong to that deployment, not to this process. Changes here are
transferred to production, so keep the recorder-facing paths (`GET script/{id}`,
`project/{p}/<resource>`, the upload routes) compatible and add a migration when the layout changes.

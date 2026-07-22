import type { ArchNode } from '../types.js';
import { GH, GH_PROVGATE } from './links.js';

/** Nodes in the `provgate` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  cron: {
    title: 'The external scheduler',
    body: 'provgate ships no scheduler of its own. `sync --all` is one shot: it services every enabled class once and exits, and the host’s cron or systemd timer owns the cadence. The `--loop` flag is a thin sleep-between-passes convenience (a bad pass is logged and the loop continues) not an orchestration framework.\n\nThe alternative, a resident daemon with its own job queue, would make provgate a stateful service that has to be supervised, restarted, and reasoned about when it wedges. A one-shot process the OS invokes has no in-flight state to lose between runs: everything it needs to resume lives in the SQLite watermark, so a missed or killed run costs nothing but an hour.',
    links: [
      { label: 'cli/main.py', href: `${GH_PROVGATE}/src/provgate/cli/main.py` },
      { label: 'loop.py', href: `${GH_PROVGATE}/src/provgate/sync/loop.py` },
    ],
  },
  loop: {
    title: 'One class at a time, each an island',
    body: 'A pass walks the enabled classes in label order and runs each inside its own try/except. The isolation is two-layered, which this single node flattens: a class-level failure (a bad Gradescope login, an unparseable assignment list, a decrypt that fails) is caught once and recorded as a single error run for the class; below it, each in-scope assignment is caught separately, so one assignment’s download failure does not abort its siblings.\n\nThe unit of failure is deliberately small because the failures are independent: one course’s expired staff password or one assignment’s malformed export says nothing about the others, and a pass that aborted wholesale on the first error would let one broken class stall every class behind it.',
    invariant:
      'One class’s Gradescope outage or bad credential never aborts the pass for the others. Every outcome, including an isolated failure, is recorded.',
    links: [{ label: 'engine.py', href: `${GH_PROVGATE}/src/provgate/sync/engine.py` }],
  },
  sqlite: {
    title: 'The store · one file, four tables',
    body: 'One SQLite file holds classes, their encrypted secrets, the forwarded-submission watermark, and the runs audit log, and `store/` is the only module that writes SQL. The watermark is the load-bearing one, and it is not a scalar: `forwarded_submissions` holds one row per (class, assignment, submission_key), so “have we sent this?” is a set-membership test, not an “everything before timestamp T” comparison.\n\nIt has to be a set because Gradescope submission keys carry no order (they are opaque folder names, not monotonic ids or times) so there is no high-water mark to advance past. Modelling it as a set of seen keys means a resubmission with a fresh key is automatically “not yet forwarded,” and losing the file degrades to re-sending everything, which the server’s dedup absorbs.',
    links: [
      { label: 'db.py', href: `${GH_PROVGATE}/src/provgate/store/db.py` },
      { label: 'repository.py', href: `${GH_PROVGATE}/src/provgate/store/repository.py` },
    ],
  },
  fern: {
    title: 'The one encryption seam',
    body: 'Gradescope passwords and Provenance tokens are stored Fernet-encrypted, and exactly one place can turn ciphertext back into plaintext: the SecretBox in `store/`. The master key never lives in the database (it comes from PROVGATE_SECRET_KEY in the environment) so the SQLite file on its own is inert: an attacker with the store but not the key holds only ciphertext.\n\nConfining encrypt and decrypt to a single class is what makes “no plaintext at rest, ever” auditable rather than aspirational. Every credential read in the app goes through `get_secret`, and plaintext exists only on the stack for the duration of a pass, never in a column, a log line, or a runs row.',
    links: [
      { label: 'crypto.py', href: `${GH_PROVGATE}/src/provgate/store/crypto.py` },
      { label: 'repository.py', href: `${GH_PROVGATE}/src/provgate/store/repository.py` },
    ],
  },
  prune: {
    title: 'Prune to the delta',
    body: 'prune_export is a pure function over in-memory ZIP bytes with no I/O: it lists the archive, derives each submission’s key from its top-level folder name, subtracts the keys already in the watermark, and writes a new ZIP containing only the folders that remain, plus the metadata file, minus macOS noise. The delta is a set difference on folder keys, computed without the function ever touching Gradescope or the store.\n\nIncrementality is achieved by removing folders, never by editing Gradescope’s record of who submitted. A pruned export is still a valid Gradescope export as far as Provenance is concerned, so the server needs no notion of “this came from a gateway”: the submitters whose folders were pruned out appear as rostered-with-no-bundle, exactly as they would in a hand-uploaded export.',
    invariant:
      'The delta is folders removed, never metadata rewritten. Keys come from folder names, not from parsing the YAML.',
    links: [{ label: 'prune.py', href: `${GH_PROVGATE}/src/provgate/sync/prune.py` }],
  },
  gslogin: {
    title: 'Log in once per class',
    body: 'A class’s sync opens a single authenticated Gradescope session (GET the login page, scrape the CSRF token, POST the credentials) and reuses it for every assignment in that class before closing it in a finally. Login success is detected by the post-redirect landing URL: still on /login means bad credentials. (The session is per class, not literally per whole pass; each class authenticates with its own credentials.)\n\nReuse is a rate-limit defence. Per-class credentials already mean one login per class per pass; logging in again for each assignment would multiply authentications against an undocumented endpoint that can lock or throttle an account. One session per class is the fewest logins that still keeps each class’s credentials isolated from the next.',
    links: [
      { label: 'client.py', href: `${GH_PROVGATE}/src/provgate/gradescope/client.py` },
      { label: 'parse.py', href: `${GH_PROVGATE}/src/provgate/gradescope/parse.py` },
    ],
  },
  gsback: {
    title: 'Stand down, don’t hammer',
    body: 'When a Gradescope request fails (an auth rejection, a non-200, a throttled response) the client raises rather than retrying in place, and the failure is caught at the class boundary, recorded as an error run, and the pass moves on to the next class. There is no in-pass retry loop against Gradescope: “back off” here means stand down for this pass, not sleep-and-retry.\n\nRetrying an undocumented, credentialed endpoint that just refused you is how an account gets locked. Because the watermark is untouched on any failure, the safe move is to abandon this class for the hour and let the next scheduled pass try again with a clean session: the cost of waiting is one cycle; the cost of hammering is a disabled staff login.',
    links: [
      { label: 'client.py', href: `${GH_PROVGATE}/src/provgate/gradescope/client.py` },
      { label: 'engine.py', href: `${GH_PROVGATE}/src/provgate/sync/engine.py` },
    ],
  },
  gslist: {
    title: 'List, then narrow to scope',
    body: 'The assignment list is read from the instructor course page by pulling the React AssignmentsTable component’s props out of the HTML; the parser raises rather than returning an empty list when it finds no table, so a Gradescope markup change surfaces loudly instead of quietly syncing zero assignments. The resulting ids are then filtered by the class’s policy (all, an include set, or an exclude set) down to the assignments actually in scope.\n\nFailing loud is the point: an empty result is ambiguous between “this course has no assignments” and “the page we scraped no longer looks the way we expect,” and the two demand opposite responses. Treating a parse miss as an error routes it to the class-isolation boundary and a visible failed run, where a silent empty list would look like a healthy pass that did nothing.',
    links: [
      { label: 'parse.py', href: `${GH_PROVGATE}/src/provgate/gradescope/parse.py` },
      { label: 'policy.py', href: `${GH_PROVGATE}/src/provgate/sync/policy.py` },
    ],
  },
  gsdl: {
    title: 'Stream the export to disk',
    body: 'Once the export is ready, provgate streams the ZIP straight to a temp file and yields its path inside a context manager that deletes the file on exit. The full export never enters memory and is never retained past the run: the pruning step reads it, the delta is POSTed, and the temp file is unlinked.\n\nStreaming to disk rather than buffering makes the ceiling storage, not RAM: a course-wide export of sealed bundles can be large, and holding it in memory would cap how big an assignment provgate can service. The on-exit delete is what keeps the promise that provgate stores no student source: it is a pipe, not a cache.',
    links: [{ label: 'client.py', href: `${GH_PROVGATE}/src/provgate/gradescope/client.py` }],
  },
  gsprep: {
    title: 'The export is asynchronous',
    body: 'Gradescope does not hand back the ZIP synchronously. provgate POSTs to create an export, receives a generated_file_id, and polls that file’s status endpoint until it reports completed with a presigned download URL, bounded by a timeout, so a stuck export fails the assignment rather than hanging the pass. Only then does the download begin.\n\nA large assignment’s export is generated in the background, and a client that assumed a synchronous body would read a “still preparing” placeholder as if it were the archive. Modelling the wait explicitly (create, poll to completed, then fetch the URL) is the only way to tell “not ready yet” apart from “ready,” and the timeout bounds how long provgate waits before giving the slot back to the next pass.',
    links: [{ label: 'client.py', href: `${GH_PROVGATE}/src/provgate/gradescope/client.py` }],
  },
  valid: {
    title: 'Is this really an export?',
    body: 'Before anything is pruned, `prune_export` confirms the downloaded bytes are a ZIP that actually contains a submission_metadata.yml; if not, it raises NotAnExportError and the assignment fails cleanly. The metadata is located by matching the filename anywhere in the archive and taking the shallowest match: the export’s top-level folder name is never assumed, because Gradescope does not contract it.\n\nThe download came from an undocumented endpoint that can just as easily return an error page or a shape that shifted since last term. Validating that the archive is really an export, and deriving the folder-key prefix from where the metadata sits rather than from a hard-coded directory name, is what stops a bad download from being pruned into a plausible-looking but wrong delta.',
    links: [{ label: 'prune.py', href: `${GH_PROVGATE}/src/provgate/sync/prune.py` }],
  },
  enum: {
    title: 'Keys come from folders, not the YAML',
    body: 'The submission keys are enumerated from the archive’s top-level folder names, not by parsing submission_metadata.yml. By Gradescope’s construction the folder names and the metadata keys coincide, so provgate reads the folders (which it must open anyway to rebuild the pruned ZIP) and treats the metadata purely as opaque bytes to copy through.\n\nParsing the YAML to get keys would make provgate depend on the metadata’s internal shape, which is precisely the thing it refuses to interpret. Keeping key enumeration on the file tree and the metadata untouched means the one artifact Provenance reads for roster and assignment identity is never even deserialized on the gateway, let alone reshaped.',
    links: [{ label: 'prune.py', href: `${GH_PROVGATE}/src/provgate/sync/prune.py` }],
  },
  never: {
    title: 'Copy the metadata byte-for-byte',
    body: 'submission_metadata.yml is written into the pruned ZIP as the exact bytes read out of the original, never parsed, re-serialized, filtered to the delta, or hand-edited. It is copied whole even though most of the submitters it names have had their folders pruned away.\n\nThis file is Provenance’s source of truth for the roster and for assignment identity: no assignment id is sent over the wire, so the server derives it from the metadata and each bundle’s signed manifest. A YAML round-trip can silently drop or reorder a field the server reads, and a regenerated metadata would be a second, diverging authority for who submitted. Copying the bytes means there is exactly one such authority and provgate is not it; the pruned-out submitters resolve on the server to rostered-with-no-new-bundle.',
    invariant:
      'submission_metadata.yml is copied byte-for-byte. provgate never regenerates, re-serializes, or filters it; the server is the only authority over its contents.',
    links: [
      { label: 'prune.py', href: `${GH_PROVGATE}/src/provgate/sync/prune.py` },
      { label: 'ingest.ts (server)', href: `${GH}/packages/server/src/api/v1/routes/ingest.ts` },
    ],
  },
  post: {
    title: 'POST the delta, no assignment id',
    body: 'The pruned ZIP goes to POST /semesters/{id}/ingest:gradescope as multipart under the field archive, with a write-scoped Provenance token as a Bearer credential, and the server answers 202 with a job id. No assignment id is sent: Provenance derives assignment identity, and the roster itself, from the export’s metadata and each bundle’s signed manifest.\n\nWithholding the assignment id keeps provgate a dumb pipe: it never has to map its own Gradescope assignment ids onto Provenance’s, so the two systems’ identifiers never have to agree. For exports past a size threshold the client transparently switches from the single multipart POST to a resumable, S3-backed multipart upload, putting parts and completing to the same job id, so a multi-gigabyte assignment is not bounded by one request.',
    links: [
      { label: 'provenance/client.py', href: `${GH_PROVGATE}/src/provgate/provenance/client.py` },
      { label: 'ingest.ts (server)', href: `${GH}/packages/server/src/api/v1/routes/ingest.ts` },
    ],
  },
  term: {
    title: 'Terminal status decides the watermark',
    body: 'The job is polled to a terminal state, and provgate sorts three outcomes into two actions: succeeded and partial both count as success and advance the watermark; failed, or any error or timeout while polling, leaves it untouched. Partial deliberately lands on the success side.\n\nA partial job means some bundles ingested and some were skipped or rejected, and the whole delta is marked forwarded regardless. Holding the watermark on partial would re-send the entire assignment every pass, and the bundles that were rejected (typically for reasons re-sending cannot fix, like a missing manifest) would be rejected again each time. Advancing on partial accepts the successful ingests and stops retrying the unfixable ones; a genuinely new submission still gets a fresh Gradescope key and is picked up next pass.',
    links: [
      { label: 'provenance/client.py', href: `${GH_PROVGATE}/src/provgate/provenance/client.py` },
      { label: 'engine.py', href: `${GH_PROVGATE}/src/provgate/sync/engine.py` },
    ],
  },
  hold: {
    title: 'On failure, leave the watermark',
    body: 'A failed job, an HTTP error, a poll timeout, or any exception raised while forwarding lands here, and the response is to write nothing to the watermark. The delta is not marked forwarded, so the next scheduled pass recomputes the same delta and sends it again.\n\nNothing durable records an in-flight job (forwarded_submissions is written only on success and the runs row only after the fact) so a crash between the POST and a terminal success leaves the watermark where it was, and the whole delta is re-derived next time. The submissions that did land are absorbed by the server’s content-hash dedup, so re-sending is cheap; the ones that did not are retried. Advancing the watermark before a confirmed terminal success is the one thing that could silently lose a submission, so it is never done.',
    invariant:
      'The watermark advances only after a terminal succeeded or partial. A crash or failure mid-forward re-sends the delta; it never loses it.',
    links: [
      { label: 'engine.py', href: `${GH_PROVGATE}/src/provgate/sync/engine.py` },
      { label: 'provenance/client.py', href: `${GH_PROVGATE}/src/provgate/provenance/client.py` },
    ],
  },
  adv: {
    title: 'Advance the watermark',
    body: 'The per-assignment watermark moves only after the Provenance ingest job reaches a terminal succeeded or partial state. On failure, or on any error mid-poll, it is left untouched so the next run retries.',
    invariant:
      'The watermark is an optimisation; content-hash dedup is correctness. When in doubt, forward.',
    links: [{ label: 'engine.py', href: `${GH_PROVGATE}/src/provgate/sync/engine.py` }],
  },
  dedupnote: {
    title: 'The watermark optimises; dedup is correct',
    body: 'Provenance rejects a bundle whose (semester, blob_sha256) it has already ingested, before any heavy work, so a re-sent submission costs one indexed lookup. That is why provgate can treat its watermark as an optimisation and forward whenever in doubt: the correctness of “each submission ingested once” lives on the server, not in the gateway’s memory of what it sent.\n\nInvert that and two things break. If the watermark were made authoritative (gate on it, skip server dedup) a lost or corrupt watermark would permanently drop every submission it had recorded, because nothing would re-send them; and a resubmission that reused a Gradescope key would never be forwarded at all. Keeping dedup authoritative means the worst case of a wrong watermark is a cheap re-send. The server even narrows the key to (semester, student, blob) on this path, so two co-submitters of one group bundle (identical bytes, different students) each get their own submission instead of one being discarded as a duplicate.',
    links: [
      { label: 'dedup.ts (server)', href: `${GH}/packages/server/src/services/ingest/dedup.ts` },
      { label: 'engine.py', href: `${GH_PROVGATE}/src/provgate/sync/engine.py` },
    ],
  },
  runs: {
    title: 'The audit row',
    body: 'Every assignment outcome (succeeded, partial, failed, skipped, dry-run, or an isolated error) writes one runs row with the class, the assignment id, the outcome, the delta count, the Provenance job id, and an error summary. It records no password, token, cookie, or header value; the error summary is a constructed message, not a raw dump that could carry a credential.\n\nThe runs log is provgate’s only durable account of a pass (bundles and exports are never retained) so it is where an operator sees that a class failed, when, and roughly why, via the runs command. Writing a row on every branch, including the isolated failures that never reached Provenance, is what turns silent per-class isolation into something observable after the fact.',
    links: [
      { label: 'repository.py', href: `${GH_PROVGATE}/src/provgate/store/repository.py` },
      { label: 'engine.py', href: `${GH_PROVGATE}/src/provgate/sync/engine.py` },
    ],
  },
  notify: {
    title: 'Best-effort, after the fact',
    body: 'When a webhook is configured, provgate renders a summary of the pass and POSTs it, but only after every class has been synced, its outcomes printed, and its runs rows written. render_summary is a pure function of the results, and the POST swallows every exception; a dead, slow, or misconfigured webhook logs a warning and changes nothing about the sync.\n\nNotification is the least trustworthy dependency in the system (an external URL that can hang or 500) so it sits entirely downstream of the work it describes. Firing it before the pass was reported would let a webhook outage delay or mask a sync that actually succeeded; firing it after, inside its own swallow-everything guard, means the pass’s outcome is already recorded and the notification can only add information, never subtract correctness.',
    links: [
      { label: 'render.py', href: `${GH_PROVGATE}/src/provgate/notify/render.py` },
      { label: 'webhook.py', href: `${GH_PROVGATE}/src/provgate/notify/webhook.py` },
      { label: 'cli/main.py', href: `${GH_PROVGATE}/src/provgate/cli/main.py` },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [
  // A yes/no branch test; the substance lives in `gsback`, which explains what
  // happens when the answer is "yes".
  'gsauth',
  // The error branch of `valid`. Once `valid` explains the check, "raise a clear
  // error" is fully carried by the label.
  'bad',
  // "Poll until terminal" is exactly what it does; the terminal-status decision
  // that actually matters is `term`.
  'poll',
];

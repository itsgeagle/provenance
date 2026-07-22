import type { ArchNode } from '../types.js';
import { GH } from './links.js';

/** Nodes in the `chain` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── Key material ──────────────────────────────────────────────────────────
  ckpriv: {
    title: 'The course private key',
    body: 'It signs one thing: the assignment manifest. Nothing in the running system ever verifies with it — the recorder carries only the public half, and no server holds either — so there is no deployment that needs it and no service whose compromise could leak it. The generator refuses to overwrite an existing file, refuses to write anywhere inside the repository, and sets mode 0600; even the hash-allowlist tooling that takes a keypair file reads only public_key_hex out of it.\n\nThat asymmetry is why the design puts an offline key at the root instead of an online signing service. Holding this key lets you mint a manifest for any folder, and a manifest is both the permission to record and the input to the derivation that wraps every session key — so anyone with it can produce logs the analyzer will accept. Rotating per semester is what bounds that exposure, and rotation is a real operation: a new keypair means a new recorder build, because the public half is compiled in.',
    invariant:
      'Never in the repo, in CI, or on a server. The only machine that needs it is a staff machine signing an assignment manifest.',
    links: [
      {
        label: 'generate-course-keypair.ts',
        href: `${GH}/tools/generate-course-keypair.ts`,
      },
      { label: 'sign-manifest.ts', href: `${GH}/tools/sign-manifest.ts` },
    ],
  },
  ckpub: {
    title: 'The course public key',
    body: 'One 64-hex constant in a file whose shape is a contract. The production build locates it with a regex that assumes a single-line definition, rewrites it, builds and packages the VSIX, then restores the file so local work continues on the dev key. It refuses to run if the supplied key is missing, is not 64 lowercase hex, or equals the dev key committed to the repo — a misconfigured release cannot silently ship a recorder that trusts the development keypair.\n\nCompiled in rather than fetched, because the recorder makes no network calls at all. The cost is that there is no revocation channel and no way to push a replacement: rotating the course keypair means publishing a new VSIX and re-signing every manifest, and until a student installs it their recorder simply will not activate. That is the accepted price of a tool that must work offline and must not phone anywhere.',
    invariant:
      'A production build refuses to embed the dev key, so a release can never ship trusting the development keypair.',
    links: [
      {
        label: 'course-public-key.ts',
        href: `${GH}/packages/recorder/src/activation/course-public-key.ts`,
      },
      { label: 'embed-course-key.ts', href: `${GH}/tools/embed-course-key.ts` },
    ],
  },
  skey: {
    title: 'The session keypair',
    body: 'A fresh ed25519 keypair per session, generated before the log file exists. The private key is never written in the clear: it is encrypted with XChaCha20-Poly1305 under a 32-byte key derived by HKDF-SHA256 from the hex-decoded manifest signature, with a random 16-byte salt and the fixed info string provenance-session-key-v1, and only that ciphertext reaches the .slog.meta sidecar. Decrypting with the wrong manifest signature does not yield garbage — the Poly1305 tag fails and the call throws.\n\nPer session rather than per student, because per student would need a key distribution the course does not have, and would make one leaked key retroactively fatal for everything that student ever submitted. Ephemeral keys cost nothing to create, need no directory, and confine a compromise to a single session. What they cannot do is prove who held them: the wrapping input is a signature every student in the course possesses, which is precisely the limit the tamper-resistance section states out loud.',
    links: [
      { label: 'session-keys.ts', href: `${GH}/packages/log-core/src/session-keys.ts` },
      {
        label: 'session-registry.ts',
        href: `${GH}/packages/recorder/src/session/session-registry.ts`,
      },
    ],
  },

  // ── Activation ────────────────────────────────────────────────────────────
  amf: {
    title: 'The assignment manifest',
    body: 'The signature covers exactly four fields — assignment_id, semester, issued_at, files_under_review — canonicalized as a fresh object with sig excluded. The parser ignores every other key in the file, which also means every other key sits outside the signature; nothing reads them, and nothing that matters should ever be added there. files_under_review is not decoration either: it is the list that gets the in-memory expected-content model behind external-change detection, and the list whose final on-disk hashes the seal records.\n\nThe field carrying the security property is assignment_id, because it is what makes each assignment’s signature different from the last. That signature is copied into every session’s entry 0 and is the input the session private key is wrapped under, so one file is simultaneously the authorization to record and the secret that unwraps this assignment’s keys. Rotating the id per assignment is what stops a session recorded for last week’s homework being re-presented for this one.',
    links: [
      { label: 'manifest.ts', href: `${GH}/packages/log-core/src/manifest.ts` },
      { label: 'Recorder PRD §4.1', href: `${GH}/docs/prd.md` },
    ],
  },
  averify: {
    title: 'Verify the manifest signature',
    body: 'The payload is rebuilt rather than read. Verification canonicalizes a fresh object of the four signed fields and checks the signature over those bytes, so nothing about the file itself — key order, indentation, a trailing newline — can affect the outcome. A student may reformat their manifest and the recorder still activates; a student who changes one character of files_under_review breaks it.\n\nOne implementation choice here is deliberate rather than incidental: @noble/ed25519 v3 verifies with ZIP215 semantics, which are more permissive than RFC 8032 about non-canonical point encodings. That is acceptable only because the public key is a hardcoded constant rather than something a caller supplies, and the verifier says so in a comment. If the key ever becomes user-supplied, this is the decision that has to be revisited first.',
    links: [
      { label: 'manifest.ts', href: `${GH}/packages/log-core/src/manifest.ts` },
      {
        label: 'manifest-loader.ts',
        href: `${GH}/packages/recorder/src/activation/manifest-loader.ts`,
      },
    ],
  },
  bind: {
    title: 'The binding',
    body: 'There is no separate binding step to point at in the code, which is what makes this box worth reading. Two things happen at session start and together they are the binding. The manifest signature is copied verbatim into session.start’s payload, so the claim that this session was recorded against that assignment lives inside entry 0, covered by that entry’s hash and by every hash after it. And the session private key is wrapped under a key derived from the same signature, so the key that will sign this session’s checkpoints and its bundle manifest cannot be unwrapped from the sidecar without the assignment manifest it was issued for.\n\nWhat that buys is replay resistance, not authenticity. Last term’s log cannot be re-sealed under this term’s assignment: the old sidecar’s key only opens with the old signature, and the old entry 0 names the old assignment. What it cannot buy is proof of authorship — the wrapping input is a signature every student in the course holds, so possessing it is evidence of nothing.',
    invariant:
      'The session_pubkey that verification trusts is the copy inside chained entry 0, never the copy in the unchained .slog.meta sidecar.',
    links: [
      {
        label: 'recorder-context.ts',
        href: `${GH}/packages/recorder/src/session/recorder-context.ts`,
      },
      { label: 'session-keys.ts', href: `${GH}/packages/log-core/src/session-keys.ts` },
    ],
  },

  // ── The chain ─────────────────────────────────────────────────────────────
  gen: {
    title: 'GENESIS_PREV_HASH',
    body: 'Sixty-four ASCII zeros, pinned by a test that asserts the literal value. It is a formatting convention rather than a secret or a nonce: entry 0 gets a prev_hash of the right shape so the chaining function needs no special case for the first entry, and so the line validator can require a 64-hex prev_hash on every line without exception. Omitting the field at seq 0, or writing null, would have bought a branch in three language implementations and in every parser that reads the format.\n\nIt is worth being clear about what it does not do. Zeros at the front stop nobody rewriting a log from scratch — a forger recomputes from genesis like everyone else. All the constant guarantees is that a log’s first entry cannot quietly claim to continue some earlier chain: a chain that starts anywhere else is not a chain this format recognises.',
    links: [
      { label: 'hash-chain.ts', href: `${GH}/packages/log-core/src/hash-chain.ts` },
      { label: 'hash-chain.test.ts', href: `${GH}/packages/log-core/src/hash-chain.test.ts` },
    ],
  },
  e0: {
    title: 'Entry 0 — session.start',
    body: 'Position zero is structural, not conventional. The loader rejects a .slog whose first entry is anything other than session.start, and sealing records session_id: null for a log where it cannot find one rather than guessing. The session id, the assignment, the format version, the session public key and the manifest signature all live in that single payload, so a log with no readable entry 0 is a log with no identity.\n\nConcentrating all of it there is the point: everything verification needs later about what a session was sits at the head of the chain, where altering any of it invalidates every hash that follows. The obvious alternative — a separate header file, or the sidecar that already carries the same public key — would have put the verification anchor somewhere the chain does not reach.',
    links: [
      {
        label: 'parse-session.ts',
        href: `${GH}/packages/analysis-core/src/loader/parse-session.ts`,
      },
      { label: 'Recorder PRD §5.1', href: `${GH}/docs/prd.md` },
    ],
  },
  e1: {
    title: 'Entry 1 — doc.open',
    body: 'The chain does not read payloads. Chaining canonicalizes the whole envelope — seq, t, wall, kind and data together — and hashes it after the previous entry’s hash, so what is protected is not only the content of an event but its kind, its position and both of its timestamps. Deleting an entry, swapping two, or lifting one out of another session breaks the chain exactly as surely as editing a pasted string does.\n\nThat indifference is also what makes forward compatibility possible. The parser accepts unknown kind values on purpose, and because the hash covers the canonical JSON of whatever data happens to be present, an analyzer that has never heard of an event kind can still verify the chain it sits in. Integrity and extensibility usually pull against each other; they do not here, because the integrity layer was given no opinion about meaning.',
    links: [
      { label: 'hash-chain.ts', href: `${GH}/packages/log-core/src/hash-chain.ts` },
      { label: 'ndjson.ts', href: `${GH}/packages/log-core/src/ndjson.ts` },
    ],
  },
  e2: {
    title: 'Entry 2 — doc.change',
    body: 'This is the firehose — the editor fires one per keystroke — and it is why the chain is built out of hashes rather than signatures. Hashing an entry is a synchronous step cheap enough to sit inside a handler with a p99 budget of one millisecond. An ed25519 signature is far more expensive and asynchronous besides; signing every entry would have put a keypair operation between a student’s keystroke and their editor.\n\nSo the split is: hash everything, sign occasionally. Cheap linkage on every entry makes tampering locatable to an exact sequence number; a periodic signature over the chain state makes a range of it attributable to a key holder. Collapsing the two into one operation would either make the recorder unusable during ordinary typing or make signatures so rare that a session which crashed carried none at all.',
    invariant: 'Entries are hashed on the emit path, never signed there.',
    links: [
      { label: 'hash-chain.ts', href: `${GH}/packages/log-core/src/hash-chain.ts` },
      { label: 'Recorder PRD §4.7', href: `${GH}/docs/prd.md` },
    ],
  },
  e99: {
    title: 'Entry 99 — doc.save',
    body: 'A save is where the log makes a checkable claim about the world: it records the sha256 of the file’s bytes as they were on disk at that moment. Check 8 takes the last such hash for each reviewed file — from doc.save, doc.open or fs.external_change, whichever came last — and compares it against the sha256 in the signed bundle manifest. That comparison is what turns a log of edits into evidence about the artefact that was actually handed in.\n\nWhich makes it the entry an attacker would most want to change, and a good place to count the cost. Altering a recorded save hash means recomputing that entry’s hash, therefore the prev_hash and hash of every entry after it in the session, therefore every checkpoint signature covering that range, and then re-signing the bundle manifest — which means first unwrapping the session key, which means holding the assignment manifest. Opening the file and editing one line fails at the first step.',
    links: [
      {
        label: 'verify-submitted-code.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-submitted-code.ts`,
      },
      { label: 'Recorder PRD §5.4', href: `${GH}/docs/prd.md` },
    ],
  },
  e100: {
    title: 'The signed checkpoint',
    body: 'Two things about this box are not what the drawing suggests. A checkpoint is not a log entry — it is a record appended to the .slog.meta sidecar, a seq, the hash at that seq, and an ed25519 signature over the canonical form of the pair — describing an entry that is itself an ordinary event of whatever kind. And the cadence counts entries actually written, so the first checkpoint lands on the hundredth write, and entries dropped in degraded mode never advance the counter.\n\nCheckpoints exist because the chain proves consistency, not authorship. A log rewritten from genesis is perfectly self-consistent — every link recomputes — so what a checkpoint adds is a signature over the chain state at a point, which cannot be produced without the session key. They are written every hundred entries rather than once at seal because sessions end badly more often than they end cleanly, and a signature that exists only at seal time is a signature a crashed session never has. Signing stays off the entry path: the operation is chained onto a pending promise that teardown drains.\n\nWorth knowing that nothing yet checks them. log-core exports and tests a checkpoint verifier and the loader shape-validates the sidecar, but no validation check verifies a checkpoint signature — so today they are evidence available to a reviewer rather than evidence the pipeline acts on.',
    links: [
      {
        label: 'checkpoint-signer.ts',
        href: `${GH}/packages/log-core/src/checkpoint-signer.ts`,
      },
      {
        label: 'session-registry.ts',
        href: `${GH}/packages/recorder/src/session/session-registry.ts`,
      },
    ],
  },

  // ── Seal ──────────────────────────────────────────────────────────────────
  bman: {
    title: 'manifest.json',
    body: 'Beyond what the box lists, the manifest carries the part check 8 depends on: submission_files, the final on-disk sha256 of every path in files_under_review, with files that were absent at seal recorded explicitly as missing with a null hash rather than omitted. A file that vanished and a file that was never listed are different facts, and the manifest keeps them different.\n\nPer-log hashes rather than one hash over the archive, for a mundane reason: the manifest sits inside the zip it describes and cannot hash itself. Naming each .slog and .slog.meta individually also means a session whose chain failed to validate still appears, with its hash, instead of being quietly dropped — sealing warns and continues. And because these bytes are signed they are frozen: the server strips student source out of stored bundles but never touches manifest.json, which is what keeps an archived bundle verifiable years later.',
    links: [
      { label: 'seal.ts', href: `${GH}/packages/recorder/src/commands/seal.ts` },
      { label: 'bundle.ts', href: `${GH}/packages/log-core/src/bundle.ts` },
    ],
  },
  bsig: {
    title: 'manifest.sig',
    body: 'Signed with the session private key, not the course key — the course key has been offline since the assignment was issued and never sees a bundle. So this signature does not mean that the course endorses this submission; it means the bundle was produced by the holder of a key wrapped under this assignment’s manifest signature. The file holds the hex signature over exactly the canonical JSON written to manifest.json, and both are written atomically, so an interrupted seal cannot leave a signature over bytes that are not there.\n\nSealing signs with the currently active session’s key while the manifest describes every log in the directory — several sessions, several keys. That is why verification tries the newest session’s public key first and then falls back through the rest rather than assuming a particular one: a bundle sealed during the third session is signed by the third session’s key and must still verify.',
    links: [
      { label: 'bundle-sign.ts', href: `${GH}/packages/log-core/src/bundle-sign.ts` },
      {
        label: 'verify-manifest-sig.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-manifest-sig.ts`,
      },
    ],
  },
  zip: {
    title: 'The bundle .zip',
    body: 'Flat, with no directories: everything in .provenance/ goes in at the top level, and the reviewed files go in beside them at their workspace-relative paths. Two classes of file are deliberately left out — quarantined .corrupt- logs from a failed chain recovery, and .tmp leftovers from an interrupted atomic write — so the archive contains nothing unparseable, while the recovery event inside the log still records that a quarantine happened.\n\nThe loader treats the contents as a closed set. manifest.json, manifest.sig and the per-session .slog / .slog.meta pairs are recognised by name; anything else is accepted only if the manifest names it in submission_files, and any remaining entry fails the load outright. A log with no sidecar, or a sidecar with no log, is its own distinct error. Strictness is cheap here, and it means no later stage ever has to reason about what an unexplained file in a bundle might be.',
    links: [
      { label: 'seal.ts', href: `${GH}/packages/recorder/src/commands/seal.ts` },
      { label: 'unzip.ts', href: `${GH}/packages/analysis-core/src/loader/unzip.ts` },
    ],
  },

  // ── Verification ──────────────────────────────────────────────────────────
  vchain: {
    title: 'Walk the chain',
    body: 'Each entry is recomputed against its own recorded prev_hash rather than against a running value carried forward — a deliberate difference from the recorder-side validator, which walks linkage and stops at the first break. Cascading would be worse than useless during review: one deleted line in the middle of a session would report every entry after it as tampered, burying the one entry that actually is. Linkage gaps are a separate check; this one answers only whether an entry hashes to what it claims.\n\nThe output is therefore a list of exact sequence numbers rather than a boolean, and those numbers travel all the way through to the flag as deep links into the timeline. The check also has to work years later on a machine that has never seen the recorder, which is why it needs nothing but the bundle: the rule is a sha256 over a canonical string, with no key and no service in the loop.',
    invariant:
      'An entry is broken only if it fails against its own prev_hash. One tampered entry is reported as one failure, never as every entry after it.',
    links: [
      {
        label: 'verify-chain.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-chain.ts`,
      },
      { label: 'chain-validator.ts', href: `${GH}/packages/log-core/src/chain-validator.ts` },
    ],
  },
  vsig: {
    title: 'Verify manifest.sig',
    body: 'The verifier does not keep the bytes that were signed. It parses manifest.json, re-canonicalizes the parsed object, and verifies the signature over that string — so the determinism of JCS is load-bearing at verification time and not only at signing time. A verifier that re-serialized with an ordinary JSON writer would produce different bytes and reject a perfectly good signature. This is the concrete reason canonicalization is a library rather than something each implementation writes for itself.\n\nThe public key it verifies against is read from session.start’s payload, inside the hash chain, rather than from the .slog.meta sidecar that carries the same key with no chain protecting it. Trusting the sidecar copy would let a forger substitute their own public key and re-sign the manifest without touching the log at all.',
    links: [
      {
        label: 'verify-manifest-sig.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-manifest-sig.ts`,
      },
      { label: 'canonical.ts', href: `${GH}/packages/log-core/src/canonical.ts` },
    ],
  },
  vbind: {
    title: 'Verify the session binding',
    body: 'Worth stating exactly what this check does, because the label promises more than the code delivers. It compares the manifest signature recorded in each session’s entry 0 across the sessions in one bundle and fails when they differ, which catches a bundle assembled from sessions recorded against different assignments. A single-session bundle passes it trivially. It cannot check that signature against the course public key, because the bundle manifest carries no copy of it and the analyzer holds no assignment manifest to compare against.\n\nThe anti-replay property really lives elsewhere: in the per-assignment rotation that makes each manifest signature unique, and in the key wrapping that makes an old session key unrecoverable without the old manifest. This check is the cheap consistency test sitting on top of those. Closing the gap would mean giving the analyzer the signed manifests for a semester — a product decision, not an oversight in this function.',
    links: [
      {
        label: 'verify-session-binding.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-session-binding.ts`,
      },
      { label: 'Recorder PRD §5.4', href: `${GH}/docs/prd.md` },
    ],
  },
  verdict: {
    title: 'Any link, signature or binding broken?',
    body: 'This diamond covers three of the eight validation checks, and it is not a gate. A failing verdict stops nothing: ingest completes, the bundle is stored, statistics and heuristics still run, and the outcome is a flag on a submission a reviewer may never open. The recorder behaves the same way at the other end, where sealing never aborts on a broken chain. There is no point anywhere in the system at which an integrity failure blocks a path; it only changes a ranking.\n\nThe roll-up across all eight checks has one asymmetry worth knowing: a check that could not run does not count as a pass. Any failure makes the bundle fail, and no failure but a skipped check makes it warn. An absence of evidence is reported as an absence rather than rounded up to clean.',
    links: [
      {
        label: 'run-validation.ts',
        href: `${GH}/packages/analysis-core/src/validation/run-validation.ts`,
      },
      { label: 'Recorder PRD §5.4', href: `${GH}/docs/prd.md` },
    ],
  },
  ok: {
    title: 'Valid — chain intact',
    body: 'This verdict is narrower than it looks. It says the entries are internally consistent, that the bundle manifest was signed by a key wrapped under an assignment manifest, and that nothing in the bundle contradicts anything else in it. It says nothing about who wrote the code.\n\nThe project is explicit about why. The key that signs a bundle is derivable from a manifest every student in the course already has, so anyone willing to build a tool that synthesises a plausible editing session can produce a bundle that passes every check here. The claim is not that the log is tamper-proof; it is that casual tampering is detected, that reasonable-effort tampering is detected, and that a full forgery costs more work than doing the assignment. A clean verdict is the floor for taking the rest of the evidence seriously, not a conclusion on its own.',
    links: [
      { label: 'Recorder PRD §6', href: `${GH}/docs/prd.md` },
      {
        label: 'run-validation.ts',
        href: `${GH}/packages/analysis-core/src/validation/run-validation.ts`,
      },
    ],
  },
  bad: {
    title: 'A high-severity flag',
    body: 'Integrity findings enter the same ranked flag list as the behavioural heuristics, at severity high and confidence 1.0 — 1.0 because a hash either recomputes or it does not, which is a different sort of claim from “this paste looks large for this assignment”. High is the largest of the four severity weights, so a broken chain rises to the top of a cohort list without anyone tuning anything.\n\nThe supporting sequence numbers become deep links into the timeline, which is what the exact failing seq means in practice. It does not always exist: a manifest-signature failure has no particular entry to blame, so that flag carries no sequence numbers at all. And it stays a flag — the spec is explicit that tampering, a crashed recorder and a corrupted disk look alike from outside, and that a human decides what any of them means.',
    links: [
      {
        label: 'integrity-flags.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/integrity-flags.ts`,
      },
      { label: 'Recorder PRD §5.4', href: `${GH}/docs/prd.md` },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = ['edots'];

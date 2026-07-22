# Course Engine coding-agent contract

This file is the automatic entrypoint for every coding agent working in this
repository. Course Engine is a course compiler, not a generic document viewer,
content management system, authoring tool, or admin dashboard.

The product is an open-install application for one person who downloaded a
course and wants to study it in a cleaner, Khan Academy-like experience. The
compiler and the coding agent exist only to turn the original course into that
experience. They are infrastructure, not the product surface.

The intended learner journey is:

```text
clone/download Course Engine beside a downloaded course
  -> run one setup/start command
  -> automatically discover and inspect the course
  -> deterministically extract and compile it
  -> optionally use AI to resolve evidence-backed ambiguities
  -> validate it
  -> atomically activate it locally
  -> open the learner experience
  -> resume studying on later launches
```

The stop condition is not "a compiler dashboard exists." The stop condition is:
a nontechnical learner can install this repository beside a course, run one
obvious command, and land in a polished course with units, lessons, one-step
navigation, source-faithful resources, stable progress, and no exposed compiler
administration.

## Default first-run directive

When an agent is told only `Read AGENTS.md and set up this course`, treat that
as authorization to complete the safe local setup workflow end to end.

The agent must:

1. Inspect this repository and the immediately surrounding directory before
   asking questions.
2. Automatically locate the downloaded course ZIP, extracted course directory,
   PDFs, or website configuration and infer all metadata available in the
   source.
3. Ask exactly one question at a time only for a genuine unresolved blocker,
   such as multiple equally plausible sources, required permission to transmit
   content, or missing credential references for a provider the user explicitly
   enabled.
4. Never ask the user to identify an obvious course file, state an inferable
   learner level, choose whether compilation is source-faithful, copy internal
   IDs, inspect hashes, operate a compiler dashboard, or paste API keys in chat.
5. Keep compilation permanently source-faithful. AI may make cited,
   evidence-bound representation suggestions but must never construct a
   different curriculum.
6. Install dependencies, validate the source, configure the course, compile,
   repair resolvable validation failures, activate the exact validated artifact,
   start the local services, and open the learner interface.
7. Use `--visual-qa disabled` by default. Do not install or run Playwright,
   Puppeteer, Chrome automation, or another browser-control system unless the
   user explicitly requests visual browser QA. Always run the nonvisual lint,
   build, API, rendered-HTML, compiler, and validation checks that are available.
8. Stop only when the learner course is usable or one precise user decision is
   truly required.

The normal command is:

```bash
npm install
npm run course:start -- --visual-qa disabled
```

## Product invariants — do not negotiate these

1. **The course source is authoritative.** Compilation is always source-faithful.
   AI must not create a different curriculum, reorder topics without source
   evidence, invent missing lessons, or replace the source's instructional intent.
2. **Inference precedes questions.** Do not ask "Which file is the course?",
   "What level is it?", "What is the title?", or equivalent questions when those
   facts can be discovered. Inventory nearby ZIPs, folders, PDFs, HTML, metadata,
   syllabi, headings, manifests, and archive structure; select the single
   high-confidence course candidate and infer metadata with recorded evidence.
3. **Ask only on a real blocking ambiguity.** If two or more candidates have
   materially similar confidence, ask the user to choose between the concrete
   detected candidates. If metadata inference is uncertain, preserve the source
   label or use an honest neutral value; do not turn uncertainty into a
   questionnaire.
4. **AI is optional and subordinate.** Deterministic extraction and compilation
   must work without credentials. Compiler AI may propose declarative, cited
   decisions only when enabled. It may not invent curriculum, silently attach
   resources, bypass validation, write executable renderers, activate a failing
   build, or become required for ordinary compilation.
5. **The compiler is invisible to the learner.** SourceGraph counts, hashes,
   drafts, provider readiness, relationship inspectors, validation gates,
   publish/rollback controls, and compiler stages must not appear in the normal
   product. Keep robust internal machinery where useful, but hide it behind a
   developer-only capability.
6. **Local activation is the user concept.** Internally, preserve exact-artifact
   review, atomic promotion, and rollback safety. Externally, the experience is
   "Preparing your course" followed by "Continue studying," not draft
   publication management.
7. **No detached study-material bucket.** Every PDF, page, table, diagram,
   video, transcript, problem, solution, interactive, and source link belongs
   inside the lesson step justified by its source relationship, or is explicitly
   excluded with a recorded reason.
8. **Visual browser QA is optional and configurable.** Use
   `verification.visual_qa` with exactly `auto | enabled | disabled`:
   - `auto` (default): run browser QA when the active agent/runtime exposes
     browser automation; otherwise run build, rendered-HTML, API, and smoke
     checks and record that visual QA was unavailable. Absence does not block
     activation.
   - `enabled`: browser capability is required; absence is a clear blocking issue.
   - `disabled`: skip browser automation intentionally; nonvisual verification
     still runs.
   Coding agents must choose `disabled` unless the user explicitly requests
   browser automation.
9. **Do not ask the learner to manage IDs or services.** The launcher captures
   course IDs, starts required local processes, waits for readiness, selects the
   active course, and opens `/` itself.
10. **Do not weaken existing safety.** Preserve stable source identities/hashes,
    decision replay, ZIP safety, URL safety, credential separation/redaction,
    validation gates, deterministic artifact hashes, exact-artifact activation,
    and rollback.

## Automatic task routing

When the user asks to set up, import, compile, open, test, regenerate, or finish
a course, execute the workflow below. Do not merely explain commands that the
agent can safely run itself.

Before asking anything:

1. Inspect the repository, `course-engine.sqlite3`, running local services, and
   every `courses/*/course.setup.json`, `course.config.ts`, and
   `compilation.json`.
2. Search the repository parent and its nearby directory for likely source
   directories, ZIPs, PDFs, and existing course packages. Prefer the newest
   plausible course source, but never select an ambiguous source silently.
3. Reuse complete saved setup. Ask only for missing, stale, changed, or truly
   ambiguous information.
4. Never overwrite human or AI decisions in `compilation.json` during
   regeneration.

## New-course / activation execution workflow

Use the one-command bootstrap unless you are explicitly debugging:

```bash
npm run course:start [-- --source <path> --reconfigure --non-interactive --no-open --visual-qa auto|enabled|disabled]
```

The bootstrap orchestration is idempotent and resumable:

1. Check supported Node/Python/runtime dependencies and give actionable failures.
2. Load existing active course/setup state.
3. Discover the source automatically unless an explicit path is supplied.
4. Infer and persist nonsecret course metadata.
5. Create/reuse the course-local package.
6. Validate archives safely before extraction.
7. Register/reuse the backend course without duplicating it.
8. Compile deterministically and replay persistent decisions.
9. Optionally invoke compiler AI only under saved policy and budget.
10. Validate all structural and source relationships.
11. If validation passes, atomically activate exactly the validated artifact
    locally.
12. Start or reuse the API and learner frontend, wait on health endpoints, and
    open `http://localhost:3003/`.
13. On restart, skip completed work whose inputs/fingerprints are unchanged and
    open the learner immediately.

Do not make the user run separate `init`, capture a UUID, run `ingest`, open a
compiler URL, inspect a hash, publish a draft, and then open the learner. Those
remain internal agent/debug operations.

For agent automation, use:

```bash
PYTHONPATH=services/engine python3 -m course_engine.cli bootstrap \
  --non-interactive --course-dir courses/<slug> --source <source> \
  --set compiler_ai.enabled=no --set privacy.allow_cloud=false
```

## Credentials and privacy

- Never request, repeat, recover, display, or paste API keys in normal chat.
- Any key previously posted in chat is compromised; instruct the user to revoke
  it and create a replacement.
- Ask only whether a fresh credential exists. Enter it through a masked local
  terminal prompt, environment variable, or operating-system keychain.
- Never write credential values into source files, setup files, compilation
  decisions, artifacts, commands visible in logs, tests, or audit records.
- Keep these namespaces isolated:
  - `COMPILER_AI_BASE_URL`, `COMPILER_AI_API_KEY`, `COMPILER_AI_MODEL`
  - `STUDY_AI_BASE_URL`, `STUDY_AI_API_KEY`, `STUDY_AI_MODEL`
  - `MINERU_BASE_URL`, `MINERU_API_KEY`
  - `COURSE_ENGINE_ADMIN_TOKEN`
- Never substitute learner-assistant credentials for compiler credentials.
- When cloud processing is disabled, do not transmit source content remotely.
- Run a minimal redacted health check before any paid or expensive provider
  operation. Enforce saved call and cost limits.

No credentials are required for deterministic compilation.

## Compilation rules

- Replay `courses/<slug>/compilation.json` on every regeneration.
- Stable selectors resolve through immutable SourceGraph node IDs plus content
  hashes, not filenames or offsets alone.
- Preserve learner IDs, deep links, progress keys, source attribution, and
  accepted decisions unless an explicit migration is reviewed.
- Preserve source order unless a recorded decision explains the change.
- Never invent curriculum topics or unexplained source relationships.
- Never fabricate clip timing. When reliable timing is unavailable, use the
  labeled full-lecture fallback `chapter timing unavailable`.
- Claimed timing must be within duration, non-reversed, properly non-overlapping,
  and supported by transcript evidence when inferred.
- Every PDF, PDF page, table, diagram, figure, video, transcript, interactive,
  problem, and solution must be attached to the learner step where it belongs
  or explicitly excluded with a reason.
- Problems precede their paired solutions.
- AI-created instructional content must be visibly identified, source-cited,
  and carry AI provenance.
- AI may write declarative draft decisions but may not write executable renderer
  code, bypass validation, or publish.
- Never create a detached `Study material` section.

## Validation and activation gates

Treat these as blocking:

- Empty required units, lessons, sections, or steps.
- Orphaned or unexplained resources.
- Unsafe or required broken source links.
- Stale or ambiguous decision selectors.
- Invalid or unsupported clip ranges.
- Missing or incorrectly ordered problem/solution pairs.
- Generated content without citations and AI provenance.
- Unexpected ID, deep-link, progress-key, or fingerprint changes.
- Required parser/provider failure.
- An activated artifact that differs from the reviewed bundle.

Activation must atomically promote exactly the reviewed artifact and accepted
decision revision. Failure preserves the previous live version. Rollback moves
the live pointer without deleting history.

## Required verification

Before handoff, run:

```bash
npm run lint
npm run course:qa
npm run course:test-second
npm run engine:test
npm test
```

Perform capability-appropriate QA:

- `visual_qa=auto`: detect whether the agent/runtime exposes browser automation.
  If it does, run a real learner-flow browser check of `/` at desktop and narrow
  viewport, deep-link navigation, progress persistence, and absence of console
  errors. If it does not, run build, rendered-HTML, API, and smoke checks and
  record that visual QA was unavailable.
- `visual_qa=enabled`: browser capability is required. Report a blocker if it is
  missing.
- `visual_qa=disabled`: skip browser automation. Nonvisual verification still
  runs.

Report honestly whether visual QA actually ran.

## AI boundary that must be enforced in code, not only prose

Compiler AI output must use the typed declarative proposal schema. Every
proposal includes targeted immutable source-node IDs and content hashes,
evidence/citations, reason, confidence, provider/model provenance, and operation
type. Allow only bounded operations such as grouping source-adjacent material,
suggesting transcript-supported clip boundaries, pairing source
problems/solutions, matching figures to text using evidence, clarifying
source-derived labels, and adding visibly labeled cited scaffolding when
explicitly enabled.

Reject proposals that:

- introduce a topic or learning objective absent from the source graph;
- reorder units/lessons without an explicit source-order justification rule;
- attach a resource without an explainable relationship;
- fabricate clip timing;
- generate uncited instructional material;
- mutate executable renderer code;
- alter active/live data directly;
- bypass blockers or activation checks.

AI should optimize the representation of the source course, never "make a better
different course."

## Coding agent role

The coding agent is a temporary editor/integration/QA operator. It returns only
when a source changes, a new course is imported, or the learner requests a
source-faithful correction. It is not required for day-to-day study.

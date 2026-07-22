# Course Engine

Course Engine turns a downloaded course archive into a clean, Khan Academy-like
local study experience.

```text
archive / website / PDFs → deterministic extraction → course-local compilation
  → validation → local activation → learner course at http://localhost:3003/
```

The learner interface is the product: one-step navigation through units,
lessons, videos, worked examples, problems, and solutions. Every resource stays
attached to the lesson step that explains it; there is no detached study-material
area.

## Run it

From the directory containing your downloaded course, this one line downloads
the engine and displays the complete coding-agent contract:

```bash
git clone https://github.com/WindowsRefundDay/course-engine.git && cd course-engine && cat AGENTS.md
```

Then tell any coding agent:

```text
Read AGENTS.md and set up this course completely. Continue until the learner
interface is running; ask me only when AGENTS.md defines a genuine blocker.
```

Place a downloaded course beside this repository, then run:

```bash
npm install
npm run course:start -- --visual-qa disabled
```

This single command discovers the source, compiles it deterministically,
validates the structure and source relationships, activates the exact artifact,
starts the local API and learner frontend, and opens `http://localhost:3003/`.

Options:

```bash
npm run course:start -- --source <path-or-url>
npm run course:start -- --reconfigure
npm run course:start -- --non-interactive --no-open
npm run course:start -- --visual-qa auto|enabled|disabled
```

## How it works

- `npm run course:start` runs `scripts/bootstrap.ts`, which orchestrates the
  entire local setup.
- `services/engine/` discovers nearby sources, runs the deterministic compiler,
  validates relationships, and activates the artifact atomically.
- `courses/<slug>/course.setup.json` stores non-secret setup and policy.
- `courses/<slug>/compilation.json` stores persistent course-local decisions.
- `scripts/compiler/` defines SourceGraph, stable node IDs and hashes, decision
  replay, provenance, relationships, generated-content citations, and blocking
  validation.
- `scripts/compile-ocw.ts` runs extraction through the compiler boundary and
  embeds its graph, relationships, decisions, fingerprint, and audit in the
  reviewable course artifact.

Unsupported sources cannot activate an empty placeholder course. Missing clip
timing is allowed only as an honest full-lecture fallback with
`chapter timing unavailable`; claimed timing must be valid and supported.

## Provider separation

Deterministic compilation needs no provider credentials and cloud processing is
off by default. The setup process only asks about credentials when an optional
provider is enabled, and it never asks for key values. Configure secrets only
through environment variables or a local keychain:

- `COMPILER_AI_*` — optional evidence-bound course optimization provider.
- `STUDY_AI_*` — read-only active-course learner assistant.
- `MINERU_*` — optional document parser.

These namespaces are isolated and only credential references are persisted.
See `services/engine/README.md` and `.env.example` for details.

## Developer diagnostics

The compiler dashboard at `/compiler` is gated behind `COURSE_ENGINE_DEVTOOLS=1`
or development mode. It is not part of the normal learner journey.

## Verification

```bash
npm run lint
npm test
npm run engine:test
```

Maintainers can additionally run `npm run course:qa` with the MIT 18.01SC
source available in the expected local fixture layout. `npm run
course:test-second` requires an uncommitted
`test-fixtures/18.02sc-fall-2010.zip`; raw course archives are intentionally not
distributed with the engine.

The MIT materials retain their attribution and CC BY-NC-SA 4.0 license. Review
individual assets before public redistribution.

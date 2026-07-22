# Course Engine service

The engine owns deterministic local ingestion state. It uses SQLite and does
not require a running MinerU service until a document parsing job is executed.

```bash
cd services/engine
python -m venv .venv && .venv/bin/pip install -e .
course-engine doctor
course-engine setup ../../courses/mit-18-01sc
course-engine init ../.. --title "Single Variable Calculus"
course-engine ingest <course-id>
# Queue and run the import in one local process.
course-engine ingest <course-id> --wait
# Or consume the oldest queued job (use --watch to keep polling).
course-engine worker
uvicorn course_engine.api:app --reload --port 8000
```

Environment variables:

- `COURSE_ENGINE_DB` — SQLite path (defaults to `./course-engine.sqlite3`).
- `COURSE_ENGINE_ADMIN_TOKEN` — optional bearer token enforced on publish and
  rollback. Set it whenever the engine is reachable outside a trusted local
  development session.
- `COMPILER_AI_BASE_URL`, `COMPILER_AI_API_KEY`, `COMPILER_AI_MODEL` — optional
  course-optimization provider. Deterministic compilation never requires them.
- `STUDY_AI_BASE_URL`, `STUDY_AI_API_KEY`, `STUDY_AI_MODEL` — optional learner
  assistant, intentionally isolated from compiler credentials.
- `MINERU_BASE_URL`, `MINERU_API_KEY` — optional document parser settings,
  checked by `doctor`. `MINERU_API_URL` remains a compatibility alias.

## Guided course setup

`course-engine setup <course-dir>` asks one conditional question at a time and
writes `course.setup.json`. Deterministic mode skips all compiler-AI questions;
MinerU questions appear only when MinerU is selected. The file contains only
non-secret policy and environment-variable references, never key values.

Use `--reconfigure` to restart the interview. Automation can supply answers as
repeated `--set dotted.key=value` arguments and add `--non-interactive`; an
incomplete configuration then fails with the precise missing keys instead of
prompting. Provider diagnostics report only whether a key exists and redact
secret-shaped data.

Endpoints include import jobs, course drafts, published artifacts, revision
history, exact-hash publication, and rollback. See `course_engine/api.py` for
the complete local API surface.

## Local import pipeline

`ingest` creates a durable SQLite job. `course-engine worker` claims one
queued job atomically, and `ingest --wait` runs that same job pipeline in the
foreground. Every job records evidence for these stages:

1. `inventory` — detect the source adapter and collect a manifest.
2. `extract` — inspect a directory in place or safely index a ZIP. ZIP contents
   are extracted only into an isolated temporary directory during compilation.
3. `normalize` — create the stable metadata-only import representation.
4. `enrich` — record the optional parser boundary; no AI or MinerU call occurs.
5. `validate` — run the course compiler and reject empty or invalid artifacts.
6. `preview` — retain a hashed, unpublished draft for explicit review.

Failures retain completed-stage output and an error against the failed stage.
The public HTTP import endpoints remain queue-only and compatible with the
original contract; a local worker is responsible for consuming their jobs.

`publish <draft-id> --reviewed-hash <sha256>` atomically promotes exactly the
reviewed artifact. A failed promotion leaves the previous live version intact;
`rollback <course-id> <version>` moves the live pointer without deleting
history. Website and PDF sources remain blocked until a registered deterministic
adapter or configured parser produces non-empty learner units.

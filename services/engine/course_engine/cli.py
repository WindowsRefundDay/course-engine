from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

from .adapters import adapter_for
from .config import database_path, mineru_api_url
from .db import Database
from .mineru import MinerUClient
from .pipeline import ImportPipeline
from .providers import compiler_ai_environment, mineru_environment, study_ai_environment
from .setup import configure, parse_supplied


def _db() -> Database:
    db = Database(database_path())
    db.migrate()
    return db


def doctor(_: argparse.Namespace) -> int:
    mineru = MinerUClient(mineru_api_url()).health()
    report = {
        "python": sys.version.split()[0],
        "sqlite": __import__("sqlite3").sqlite_version,
        "database": str(database_path()),
        "mineru": mineru.__dict__,
        "providers": {
            "compiler_ai": compiler_ai_environment().diagnostic(),
            "study_ai": study_ai_environment().diagnostic(),
            "document_parser": mineru_environment().diagnostic(),
        },
        "uvicorn": shutil.which("uvicorn") is not None,
    }
    print(json.dumps(report, indent=2))
    return 0


def setup_course(args: argparse.Namespace) -> int:
    try:
        supplied = parse_supplied(args.set)
        state = configure(
            Path(args.course_dir).expanduser().resolve(),
            project_root=Path(args.project_root).expanduser().resolve() if args.project_root else None,
            explicit_source=args.source,
            reconfigure=args.reconfigure,
            non_interactive=args.non_interactive,
            supplied=supplied,
        )
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(state, indent=2, sort_keys=True))
    return 0


def init(args: argparse.Namespace) -> int:
    parsed = urlparse(args.source)
    source = args.source if parsed.scheme in {"http", "https"} else str(Path(args.source).expanduser().resolve())
    adapter = adapter_for(source)
    manifest = adapter.inventory(source)
    title = args.title or manifest.title
    course = _db().create_course(title=title, source=source, adapter_name=adapter.name, manifest=manifest.to_dict())
    print(json.dumps({"course": course, "manifest": manifest.to_dict()}, indent=2))
    return 0


def ingest(args: argparse.Namespace) -> int:
    db = _db()
    course = db.get_course(args.course_id)
    if not course:
        print(f"Unknown course: {args.course_id}", file=sys.stderr)
        return 2
    job = db.create_import(course_id=args.course_id, source=course["source"], adapter_name=course["adapter_name"])
    if args.wait:
        job = ImportPipeline(db).run_job(job["id"])
    print(json.dumps(job, indent=2))
    return 0 if job["status"] == "completed" or not args.wait else 1


def activate(args: argparse.Namespace) -> int:
    """Activate a validated draft as the local learner course."""
    db = _db()
    draft = db.get_compilation_draft(args.draft_id)
    if not draft:
        print(f"Unknown draft: {args.draft_id}", file=sys.stderr)
        return 2
    try:
        active = db.activate_compilation_draft(args.draft_id, reviewed_hash=args.reviewed_hash)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(active, indent=2))
    return 0


def bootstrap(args: argparse.Namespace) -> int:
    """One-command local course setup: discover, compile, validate, activate."""
    project_root = Path(args.project_root).expanduser().resolve() if args.project_root else Path.cwd()
    supplied = parse_supplied(args.set)

    # 1. Configure (discover source, infer metadata).
    course_dir = Path(args.course_dir).expanduser().resolve() if args.course_dir else project_root / "courses" / "auto-discovered"
    try:
        state = configure(
            course_dir,
            project_root=project_root,
            explicit_source=args.source,
            reconfigure=args.reconfigure,
            non_interactive=args.non_interactive,
            supplied=supplied,
        )
    except ValueError as error:
        print(json.dumps({"status": "blocked", "stage": "configure", "error": str(error)}), file=sys.stderr)
        return 2

    source = state["source"]["location"]
    # Resolve relative source paths against the course-local directory, matching
    # the compiler's own setup-path resolution.
    source_path = Path(source).expanduser()
    if not source_path.is_absolute():
        source_path = (course_dir / source_path).resolve()
    source = str(source_path)
    title = state["course"]["title"]

    # 2. Register or reuse backend course.
    db = _db()
    adapter = adapter_for(source)
    manifest = adapter.inventory(source)
    existing = None
    for setup_path in sorted((project_root / "courses").glob("*/course.setup.json")):
        try:
            setup = json.loads(setup_path.read_text(encoding="utf-8"))
            configured = str(setup["source"]["location"])
            configured_path = Path(configured).expanduser()
            if not configured_path.is_absolute():
                configured_path = (setup_path.parent / configured_path).resolve()
            if configured_path == Path(source).expanduser().resolve():
                # Find the matching backend course by source.
                for course in db.list_active_courses():
                    if course["source"] == source:
                        existing = course
                        break
                if existing:
                    break
        except (KeyError, OSError, ValueError, TypeError, json.JSONDecodeError):
            continue

    if existing:
        course = existing
    else:
        course = db.create_course(title=title, source=source, adapter_name=adapter.name, manifest=manifest.to_dict())

    # 3. Compile.
    job = db.create_import(course_id=course["id"], source=source, adapter_name=adapter.name)
    job = ImportPipeline(db).run_job(job["id"])
    if job["status"] != "completed":
        print(json.dumps({"status": "blocked", "stage": job.get("stage", "compile"), "error": job.get("error", "Compilation failed")}), file=sys.stderr)
        return 1

    # 4. Activate the validated draft automatically.
    draft_id = job.get("detail", {}).get("stages", {}).get("preview", {}).get("output", {}).get("draft_id")
    artifact_hash = job.get("detail", {}).get("stages", {}).get("preview", {}).get("output", {}).get("artifact_hash")
    if not draft_id or not artifact_hash:
        print(json.dumps({"status": "blocked", "stage": "activate", "error": "No reviewable draft was produced"}), file=sys.stderr)
        return 1
    try:
        active = db.activate_compilation_draft(draft_id, reviewed_hash=artifact_hash)
    except ValueError as error:
        print(json.dumps({"status": "blocked", "stage": "activate", "error": str(error)}), file=sys.stderr)
        return 2

    print(json.dumps({"status": "ready", "course_id": course["id"], "version": active.get("version"), "title": title}, indent=2))
    return 0


def worker(args: argparse.Namespace) -> int:
    """Run one queued job, or keep polling when explicitly asked to watch."""
    db = _db()
    pipeline = ImportPipeline(db)
    processed = 0
    try:
        while True:
            job = pipeline.run_job(args.job_id) if args.job_id and processed == 0 else pipeline.run_next()
            if job:
                processed += 1
                print(json.dumps(job, indent=2))
            if not args.watch:
                break
            if not job:
                time.sleep(args.poll_interval)
            args.job_id = None
    except KeyboardInterrupt:
        return 130
    return 0


def drafts(args: argparse.Namespace) -> int:
    print(json.dumps(_db().list_compilation_drafts(args.course_id), indent=2))
    return 0


def publish(args: argparse.Namespace) -> int:
    db = _db()
    draft = db.get_compilation_draft(args.draft_id)
    if not draft:
        print(f"Unknown draft: {args.draft_id}", file=sys.stderr)
        return 2
    try:
        published = db.publish_compilation_draft(
            args.draft_id,
            reviewed_hash=args.reviewed_hash,
        )
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(published, indent=2))
    return 0


def rollback(args: argparse.Namespace) -> int:
    try:
        published = _db().rollback_course(args.course_id, version=args.version)
    except KeyError as error:
        print(str(error), file=sys.stderr)
        return 2
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(published, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="course-engine")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("doctor", help="check local prerequisites").set_defaults(func=doctor)

    setup_parser = subparsers.add_parser("setup", help="infer or update course setup")
    setup_parser.add_argument("course_dir", help="course-local configuration directory")
    setup_parser.add_argument("--source", help="explicit source path or URL")
    setup_parser.add_argument("--project-root", help="repository root for source discovery")
    setup_parser.add_argument("--reconfigure", action="store_true", help="restart setup from scratch")
    setup_parser.add_argument("--non-interactive", action="store_true", help="fail with blockers instead of prompting")
    setup_parser.add_argument("--set", action="append", default=[], metavar="KEY=VALUE", help="provide one non-secret setup answer; may be repeated")
    setup_parser.set_defaults(func=setup_course)

    init_parser = subparsers.add_parser("init", help="inventory a local course directory")
    init_parser.add_argument("source")
    init_parser.add_argument("--title")
    init_parser.set_defaults(func=init)

    ingest_parser = subparsers.add_parser("ingest", help="queue an import for a course")
    ingest_parser.add_argument("course_id")
    ingest_parser.add_argument("--wait", action="store_true", help="run this import synchronously before returning")
    ingest_parser.set_defaults(func=ingest)

    activate_parser = subparsers.add_parser("activate", help="activate a validated draft for local study")
    activate_parser.add_argument("draft_id")
    activate_parser.add_argument("--reviewed-hash", required=True, help="exact hash of the validated artifact")
    activate_parser.set_defaults(func=activate)

    bootstrap_parser = subparsers.add_parser("bootstrap", help="one-command discover, compile, validate, and activate")
    bootstrap_parser.add_argument("--source", help="explicit source path or URL")
    bootstrap_parser.add_argument("--course-dir", help="course-local configuration directory")
    bootstrap_parser.add_argument("--project-root", help="repository root for source discovery")
    bootstrap_parser.add_argument("--reconfigure", action="store_true", help="ignore saved setup and rediscover")
    bootstrap_parser.add_argument("--non-interactive", action="store_true", help="fail with machine-readable blockers")
    bootstrap_parser.add_argument("--set", action="append", default=[], metavar="KEY=VALUE", help="provide setup answers")
    bootstrap_parser.set_defaults(func=bootstrap)

    worker_parser = subparsers.add_parser("worker", help="run queued local import jobs")
    worker_parser.add_argument("--job-id", help="run one specific queued job")
    worker_parser.add_argument("--watch", action="store_true", help="poll for queued jobs until interrupted")
    worker_parser.add_argument("--poll-interval", type=float, default=1.0, help="seconds between empty polls")
    worker_parser.set_defaults(func=worker)

    drafts_parser = subparsers.add_parser("drafts", help="list reviewable compilation drafts")
    drafts_parser.add_argument("course_id")
    drafts_parser.set_defaults(func=drafts)

    publish_parser = subparsers.add_parser("publish", help="publish exactly one reviewed compilation draft")
    publish_parser.add_argument("draft_id")
    publish_parser.add_argument("--reviewed-hash", required=True, help="exact hash of the artifact that was reviewed")
    publish_parser.set_defaults(func=publish)

    rollback_parser = subparsers.add_parser("rollback", help="move the live publication pointer to an existing version")
    rollback_parser.add_argument("course_id")
    rollback_parser.add_argument("version", type=int)
    rollback_parser.set_defaults(func=rollback)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext's next/link shim creates a duplicate React hook context on this client route. */

import { useEffect, useMemo, useState } from "react";
import {
  ArrowSquareOut,
  BookOpen,
  CaretDown,
  CaretRight,
  Check,
  CheckCircle,
  Clock,
  Code,
  FilePdf,
  GitDiff,
  LinkSimple,
  Play,
  Robot,
  ShieldCheck,
  Sparkle,
  TreeStructure,
  Warning,
} from "@phosphor-icons/react";
import type { Course, CourseLesson, LessonSlide, SourceReference } from "../course-types";
import type { CompilerStatus, ValidationIssue } from "../compiler-types";
import { getCompilerStatus, publishDraft, rollbackRevision } from "./compiler-api";

const demoStatus: CompilerStatus = {
  mode: "local-demo",
  courseSlug: "18-01sc-fall-2010",
  sourceLabel: "MIT OpenCourseWare archive",
  stages: [
    { id: "inventory", label: "Inventory", detail: "Source files fingerprinted", status: "complete" },
    { id: "extract", label: "Extract", detail: "Pages and resources normalized", status: "complete" },
    { id: "compile", label: "Compile", detail: "Course-local decisions replayed", status: "complete" },
    { id: "validate", label: "Validate", detail: "Relationship audit available", status: "complete" },
    { id: "publish", label: "Publish", detail: "Requires connected engine", status: "pending" },
  ],
  providers: [
    { id: "deterministic", label: "Deterministic compiler", detail: "Required · local", state: "ready" },
    { id: "document-parser", label: "Document parser", detail: "Built-in extraction", state: "ready" },
    { id: "compiler-ai", label: "Compiler AI", detail: "Optional · not configured", state: "optional" },
    { id: "study-ai", label: "Study assistant", detail: "Separate learner service", state: "isolated" },
  ],
  issues: [],
  draft: { id: "local-draft", label: "Local generated draft", courseHash: "preview-only" },
  live: { id: "current-public", label: "Current public course", courseHash: "published" },
  capabilities: { publish: false, rollback: false, aiOptimize: false },
};

function flattenLessons(course: Course) {
  return course.units.flatMap((unit) => unit.lessons);
}

function resourceHref(source: SourceReference) {
  const value = source.url ?? source.archiveUrl ?? (source.youtubeId ? `https://www.youtube.com/watch?v=${encodeURIComponent(source.youtubeId)}` : undefined);
  if (!value) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch { return undefined; }
}

function slideRelationshipIssue(slide: LessonSlide): ValidationIssue[] {
  return slide.sourceRefs
    .filter((source) => !resourceHref(source))
    .map((source) => ({
      id: `${slide.id}-${source.id}`,
      severity: "warning" as const,
      title: "Source has no resolvable link",
      detail: `${source.title} is attached to ${slide.title}, but no local or remote URL is available.`,
      sourceId: source.id,
    }));
}

function sourceIcon(kind: SourceReference["kind"]) {
  if (kind === "video") return <Play size={15} weight="fill" />;
  if (kind === "document") return <FilePdf size={16} />;
  return <LinkSimple size={16} />;
}

export function CompilerWorkspace() {
  const [course, setCourse] = useState<Course | null>(null);
  const [status, setStatus] = useState<CompilerStatus>(demoStatus);
  const [engineNote, setEngineNote] = useState("Checking for a compiler engine…");
  const [activeLessonId, setActiveLessonId] = useState("");
  const [activeSlideId, setActiveSlideId] = useState("");
  const [expandedUnits, setExpandedUnits] = useState<Record<string, boolean>>({});
  const [activeIssueFilter, setActiveIssueFilter] = useState<ValidationIssue["severity"] | "all">("all");
  const [actionState, setActionState] = useState<"idle" | "publishing" | "rolling-back">("idle");
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch("/course-data/calculus.json").then((response) => {
        if (!response.ok) throw new Error("Course artifact unavailable");
        return response.json() as Promise<Course>;
      }),
      getCompilerStatus(new URLSearchParams(window.location.search).get("course") ?? undefined).catch(() => null),
    ]).then(([loadedCourse, engineStatus]) => {
      if (!live) return;
      const reviewCourse = engineStatus?.previewCourse ?? engineStatus?.liveCourse ?? loadedCourse;
      setCourse(reviewCourse);
      const firstLesson = reviewCourse.units[0]?.lessons[0];
      const firstSlide = firstLesson?.sections[0]?.slides[0];
      setActiveLessonId(firstLesson?.id ?? "");
      setActiveSlideId(firstSlide?.id ?? "");
      setExpandedUnits({ [reviewCourse.units[0]?.id ?? ""]: true });
      if (engineStatus) {
        setStatus(engineStatus);
        setEngineNote("Compiler engine connected. Actions reflect live capabilities.");
      } else {
        setEngineNote("Local preview mode. Connect the compiler engine to publish or roll back.");
      }
    }).catch(() => {
      if (live) setEngineNote("The published course artifact could not be loaded.");
    });
    return () => { live = false; };
  }, []);

  const lessons = useMemo(() => course ? flattenLessons(course) : [], [course]);
  const activeLesson = lessons.find((lesson) => lesson.id === activeLessonId) ?? lessons[0];
  const activeSlide = activeLesson?.sections.flatMap((section) => section.slides).find((slide) => slide.id === activeSlideId)
    ?? activeLesson?.sections[0]?.slides[0];
  const activeSection = activeLesson?.sections.find((section) => section.slides.some((slide) => slide.id === activeSlide?.id));
  const derivedIssues = useMemo(() => course ? flattenLessons(course).flatMap((lesson) => lesson.sections.flatMap((section) => section.slides.flatMap(slideRelationshipIssue))) : [], [course]);
  const issues = [...status.issues, ...derivedIssues];
  const visibleIssues = activeIssueFilter === "all" ? issues : issues.filter((issue) => issue.severity === activeIssueFilter);
  const sourceCount = activeSlide?.sourceRefs.length ?? 0;
  const allSlides = course?.units.flatMap((unit) => unit.lessons.flatMap((lesson) => lesson.sections.flatMap((section) => section.slides))) ?? [];

  function chooseLesson(lesson: CourseLesson) {
    setActiveLessonId(lesson.id);
    setActiveSlideId(lesson.sections[0]?.slides[0]?.id ?? "");
  }

  async function runPublish() {
    if (!status.capabilities.publish || !status.draft?.courseHash) return;
    setActionState("publishing");
    setActionError("");
    try {
      await publishDraft(status.draft.id, status.draft.courseHash);
      setStatus(await getCompilerStatus());
    }
    catch (error) { setActionError(error instanceof Error ? error.message : "Publishing failed"); }
    finally { setActionState("idle"); }
  }

  async function runRollback() {
    if (!status.capabilities.rollback || !status.rollbackVersion) return;
    setActionState("rolling-back");
    setActionError("");
    try {
      await rollbackRevision(status.courseSlug, status.rollbackVersion);
      setStatus(await getCompilerStatus());
    }
    catch (error) { setActionError(error instanceof Error ? error.message : "Rollback failed"); }
    finally { setActionState("idle"); }
  }

  return (
    <main className="compiler-shell">
      <header className="compiler-topbar">
        <a className="compiler-brand" href="/" aria-label="Open learner course">
          <span className="compiler-brand-mark"><Code size={18} weight="bold" /></span>
          <span>course engine</span>
        </a>
        <span className="compiler-surface-label">Compiler workspace</span>
        <div className="compiler-top-actions">
          <span className={`compiler-mode compiler-mode--${status.mode}`}><span />{status.mode === "connected" ? "Engine connected" : "Local preview"}</span>
          <a className="compiler-button compiler-button--quiet" href="/" target="_blank" rel="noreferrer">
            Learner preview <ArrowSquareOut size={16} />
          </a>
        </div>
      </header>

      <div className="compiler-page">
        <section className="compiler-intro" aria-labelledby="compiler-heading">
          <div>
            <p className="compiler-eyebrow">COURSE COMPILATION / {status.courseSlug}</p>
            <h1 id="compiler-heading">Turn source material into a course.</h1>
            <p>Inspect deterministic extraction, curriculum decisions, source relationships, and publication readiness in one place.</p>
          </div>
          <div className="compiler-intro-actions">
            <button className="compiler-button compiler-button--quiet" disabled={!status.capabilities.rollback || actionState !== "idle"} onClick={runRollback} title={!status.capabilities.rollback ? "Connect the compiler engine to roll back revisions" : undefined}>
              {actionState === "rolling-back" ? "Rolling back…" : "Rollback"}
            </button>
            <button className="compiler-button compiler-button--primary" disabled={!status.capabilities.publish || actionState !== "idle"} onClick={runPublish} title={!status.capabilities.publish ? "Publishing is disabled in local preview mode" : undefined}>
              <ShieldCheck size={17} weight="bold" /> {actionState === "publishing" ? "Publishing…" : "Publish draft"}
            </button>
          </div>
        </section>

        <p className={`compiler-engine-note${actionError ? " compiler-engine-note--error" : ""}`} role={actionError ? "alert" : "status"}><span aria-hidden="true" />{actionError || engineNote}</p>

        <section className="compiler-summary" aria-label="Course compilation summary">
          <article><span>Source</span><strong>{status.sourceLabel}</strong><small>{course?.code ?? "Loading"} · {course?.term ?? ""}</small></article>
          <article><span>Curriculum</span><strong>{course?.units.length ?? 0} units · {lessons.length} lessons</strong><small>{allSlides.length} focused learner steps</small></article>
          <article><span>Validation</span><strong>{issues.filter((issue) => issue.severity === "blocker").length} blockers</strong><small>{issues.filter((issue) => issue.severity === "warning").length} warnings to review</small></article>
          <article><span>Publication</span><strong>{status.mode === "connected" ? "Draft ready" : "Preview only"}</strong><small>Review-before-publish enforced</small></article>
        </section>

        <section className="compiler-panel compiler-pipeline" aria-labelledby="pipeline-heading">
          <div className="compiler-panel-heading"><div><span>PIPELINE</span><h2 id="pipeline-heading">Compilation stages</h2></div><small>Deterministic tools run before optional AI optimization.</small></div>
          <ol>
            {status.stages.map((stage, index) => (
              <li key={stage.id} className={`compiler-stage compiler-stage--${stage.status}`}>
                <span className="compiler-stage-index">{stage.status === "complete" ? <Check size={14} weight="bold" /> : String(index + 1).padStart(2, "0")}</span>
                <div><strong>{stage.label}</strong><small>{stage.detail}</small></div>
              </li>
            ))}
          </ol>
        </section>

        <section className="compiler-provider-grid" aria-labelledby="providers-heading">
          <div className="compiler-panel-heading compiler-provider-heading"><div><span>PROVIDER READINESS</span><h2 id="providers-heading">Clear system boundaries</h2></div><small>No credential values are displayed or stored here.</small></div>
          {status.providers.map((provider) => (
            <article key={provider.id} className="compiler-provider">
              <div className="compiler-provider-icon">{provider.id === "compiler-ai" ? <Robot size={20} /> : provider.id === "study-ai" ? <BookOpen size={20} /> : provider.id === "document-parser" ? <FilePdf size={20} /> : <TreeStructure size={20} />}</div>
              <div><strong>{provider.label}</strong><small>{provider.detail}</small></div>
              <span className={`compiler-provider-state compiler-provider-state--${provider.state}`}>{provider.state}</span>
            </article>
          ))}
          <p className="compiler-boundary-note"><Sparkle size={16} /> Compiler AI may optimize a draft. The study assistant only helps learners inside a published course.</p>
        </section>

        <section className="compiler-workbench" aria-label="Curriculum and source relationship workbench">
          <aside className="compiler-tree compiler-panel">
            <div className="compiler-panel-heading"><div><span>CURRICULUM</span><h2>Course tree</h2></div></div>
            <nav aria-label="Compiled course curriculum">
              {course?.units.map((unit, unitIndex) => {
                const expanded = Boolean(expandedUnits[unit.id]);
                return <div className="compiler-tree-unit" key={unit.id}>
                  <button className="compiler-unit-button" aria-expanded={expanded} onClick={() => setExpandedUnits((current) => ({ ...current, [unit.id]: !expanded }))}>
                    {expanded ? <CaretDown size={15} /> : <CaretRight size={15} />}
                    <span>{String(unitIndex + 1).padStart(2, "0")}</span><strong>{unit.title.replace(/^\d+\.\s*/, "")}</strong><small>{unit.lessons.length}</small>
                  </button>
                  {expanded && <div className="compiler-lesson-list">{unit.lessons.map((lesson) => <button key={lesson.id} className={lesson.id === activeLesson?.id ? "is-active" : ""} onClick={() => chooseLesson(lesson)}><span>{lesson.title}</span><small>{lesson.sections.length} sections</small></button>)}</div>}
                </div>;
              })}
            </nav>
          </aside>

          <section className="compiler-inspector compiler-panel" aria-labelledby="inspector-heading">
            <div className="compiler-inspector-header">
              <div><span>SELECTED LESSON</span><h2 id="inspector-heading">{activeLesson?.title ?? "Loading course…"}</h2><p>{activeLesson?.partTitle}</p></div>
              <span className="compiler-schema-tag">schema v{course?.schemaVersion ?? 2}</span>
            </div>
            <div className="compiler-section-tabs" role="list" aria-label="Lesson steps">
              {activeLesson?.sections.map((section, sectionIndex) => section.slides.map((slide, slideIndex) => (
                <button key={slide.id} className={slide.id === activeSlide?.id ? "is-active" : ""} onClick={() => setActiveSlideId(slide.id)} aria-label={`Open ${slide.title}`}>
                  <span>{String(sectionIndex + 1).padStart(2, "0")}.{slideIndex + 1}</span>{slide.title}
                </button>
              )))}
            </div>
            {activeSlide && <div className="compiler-slide-inspector">
              <div className="compiler-slide-copy">
                <span>{activeSection?.kind.replace("-", " ")} / {activeSlide.type}</span>
                <h3>{activeSlide.title}</h3>
                <p>{activeSlide.blocks.find((block) => block.type === "paragraph")?.text ?? "This step is compiled directly from its attached source material."}</p>
                <dl><div><dt>Stable step ID</dt><dd>{activeSlide.id}</dd></div><div><dt>Requirement</dt><dd>{activeSlide.required ? "Required" : "Optional"}</dd></div><div><dt>Relationship count</dt><dd>{sourceCount}</dd></div></dl>
              </div>
              <div className="compiler-sources">
                <div className="compiler-subheading"><div><LinkSimple size={17} /><strong>Source relationships</strong></div><span>{sourceCount}</span></div>
                {activeSlide.sourceRefs.length ? activeSlide.sourceRefs.map((source) => {
                  const href = resourceHref(source);
                  return <article key={source.id}>
                    <div className="compiler-source-icon">{sourceIcon(source.kind)}</div>
                    <div><strong>{source.title}</strong><small>{source.kind} · attached to this step</small></div>
                    {href ? <a href={href} target="_blank" rel="noreferrer" aria-label={`Open source ${source.title}`}><ArrowSquareOut size={16} /></a> : <span className="compiler-source-missing" title="No resolvable source link"><Warning size={16} /></span>}
                  </article>;
                }) : <div className="compiler-empty"><CheckCircle size={23} /><strong>No external source required</strong><span>This authored step is self-contained.</span></div>}
              </div>
            </div>}
          </section>
        </section>

        <section className="compiler-lower-grid">
          <article className="compiler-panel compiler-validation">
            <div className="compiler-panel-heading"><div><span>VALIDATION</span><h2>Publication gate</h2></div><span className={issues.some((issue) => issue.severity === "blocker") ? "compiler-gate is-blocked" : "compiler-gate"}>{issues.some((issue) => issue.severity === "blocker") ? "Blocked" : "Passing"}</span></div>
            <div className="compiler-filters" aria-label="Filter validation issues">
              {(["all", "blocker", "warning", "suggestion"] as const).map((filter) => <button key={filter} className={activeIssueFilter === filter ? "is-active" : ""} onClick={() => setActiveIssueFilter(filter)}>{filter}</button>)}
            </div>
            <div className="compiler-issue-list">
              {visibleIssues.length ? visibleIssues.slice(0, 8).map((issue) => <article key={issue.id} className={`compiler-issue compiler-issue--${issue.severity}`}><Warning size={17} /><div><strong>{issue.title}</strong><p>{issue.detail}</p></div><span>{issue.severity}</span></article>) : <div className="compiler-empty compiler-empty--validation"><ShieldCheck size={28} /><strong>No issues in this view</strong><span>The compiled artifact meets the selected validation filter.</span></div>}
            </div>
          </article>

          <article className="compiler-panel compiler-diff">
            <div className="compiler-panel-heading"><div><span>REVISIONS</span><h2>Draft vs live</h2></div><GitDiff size={20} /></div>
            <div className="compiler-revision"><span>DRAFT</span><strong>{status.draft?.label ?? "No draft"}</strong><small>{status.draft?.courseHash ?? "—"}</small></div>
            <div className="compiler-diff-rule"><span /><strong>{allSlides.length} steps available for review</strong><span /></div>
            <div className="compiler-revision"><span>LIVE</span><strong>{status.live?.label ?? "Not published"}</strong><small>{status.live?.courseHash ?? "—"}</small></div>
            <p><Clock size={16} /> Publication is atomic and always requires a reviewed draft.</p>
            <a className="compiler-button compiler-button--quiet compiler-preview-link" href="/" target="_blank" rel="noreferrer">Open learner preview <ArrowSquareOut size={16} /></a>
          </article>
        </section>
      </div>
    </main>
  );
}

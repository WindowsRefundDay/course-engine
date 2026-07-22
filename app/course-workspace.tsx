"use client";

/* Source figures are remote, course-attributed archive assets. */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from "react";
import {
  BookOpen, CaretDown, CaretLeft, CaretRight, Check, Compass,
  FilePdf, List, MagnifyingGlass, Note, PlayCircle, Plus, Sparkle, Warning, X,
} from "@phosphor-icons/react";
import { db, courseStateId, progressId, slideProgressId, type LocalProfile } from "./course-db";
import { loadLearnerCourse } from "./active-course-api";
import type { Course, CourseLesson, LessonSection, LessonSlide, SourceReference } from "./course-types";

const AUTO_DISCOVER_URL = "https://ocw.mit.edu/";

type WorkspaceState =
  | { kind: "loading"; stage: string }
  | { kind: "no-course"; reason: string }
  | { kind: "blocked"; reason: string; recovery?: string }
  | { kind: "ready"; course: Course; activeCourseId: string; activeVersion: number };

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function flatSlides(lesson: CourseLesson) {
  return lesson.sections.flatMap((section, sectionIndex) => section.slides.map((slide, slideIndex) => ({ section, slide, sectionIndex, slideIndex })));
}

function stepLabel(sectionIndex: number, slideIndex?: number) {
  return slideIndex === undefined ? String(sectionIndex + 1).padStart(2, "0") : `${String(sectionIndex + 1).padStart(2, "0")}.${slideIndex + 1}`;
}

function hashLocation() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return { lessonId: params.get("lesson"), sectionId: params.get("section"), slideId: params.get("slide") };
}

function setHash(lessonId: string, sectionId: string, slideId: string, replace = false) {
  const value = `#lesson=${encodeURIComponent(lessonId)}&section=${encodeURIComponent(sectionId)}&slide=${encodeURIComponent(slideId)}`;
  window.history[replace ? "replaceState" : "pushState"](null, "", value);
}

function sourceHref(source: SourceReference) {
  const value = source.url ?? source.archiveUrl ?? (source.youtubeId ? `https://www.youtube.com/watch?v=${encodeURIComponent(source.youtubeId)}` : undefined);
  if (!value) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch { return undefined; }
}

function sourceIcon(source: SourceReference) {
  return source.kind === "video" ? <PlayCircle size={19} weight="fill" /> : source.kind === "document" ? <FilePdf size={18} /> : <Note size={18} />;
}

function closestValidStep(course: Course, lessonId?: string | null, sectionId?: string | null, slideId?: string | null) {
  const lessons = course.units.flatMap((unit) => unit.lessons);
  const lesson = lessons.find((item) => item.id === lessonId) ?? lessons[0];
  const steps = lesson ? flatSlides(lesson) : [];
  const step = steps.find((item) => item.slide.id === slideId) ?? steps.find((item) => item.section.id === sectionId) ?? steps[0];
  return lesson && step ? { lesson, section: step.section, slide: step.slide } : undefined;
}

export function CourseWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceState>({ kind: "loading", stage: "loading" });
  const [activeLessonId, setActiveLessonId] = useState("");
  const [activeSectionId, setActiveSectionId] = useState("");
  const [activeSlideId, setActiveSlideId] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [profiles, setProfiles] = useState<LocalProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<LocalProfile | null>(null);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [viewedSlides, setViewedSlides] = useState<Set<string>>(new Set());
  const [attemptedPairs, setAttemptedPairs] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [navOpen, setNavOpen] = useState(false);

  const course = workspace.kind === "ready" ? workspace.course : null;
  const activeCourseId = workspace.kind === "ready" ? workspace.activeCourseId : "";
  const lessons = useMemo(() => course?.units.flatMap((unit) => unit.lessons) ?? [], [course]);
  const activeLesson = lessons.find((lesson) => lesson.id === activeLessonId) ?? lessons[0];
  const activeUnit = course?.units.find((unit) => unit.lessons.some((lesson) => lesson.id === activeLesson?.id));
  const steps = activeLesson ? flatSlides(activeLesson) : [];
  const currentIndex = steps.findIndex((step) => step.slide.id === activeSlideId);
  const current = steps[Math.max(currentIndex, 0)] ?? steps[0];
  const filteredLessons = query.trim() ? lessons.filter((lesson) => `${lesson.title} ${lesson.summary}`.toLowerCase().includes(query.toLowerCase())) : [];
  const totalCount = lessons.length;
  const completedCount = completed.size;

  function setLocation(lesson: CourseLesson, section: LessonSection, slide: LessonSlide, replace = false) {
    setActiveLessonId(lesson.id); setActiveSectionId(section.id); setActiveSlideId(slide.id); setHash(lesson.id, section.id, slide.id, replace);
  }

  useEffect(() => {
    let cancelled = false;
    loadLearnerCourse()
      .then(async (imported) => {
        if (cancelled) return;
        if (!imported) {
          setWorkspace({ kind: "no-course", reason: "No active course found. Place a downloaded course beside this app, then run npm run course:start." });
          return;
        }
        setWorkspace({ kind: "ready", course: imported, activeCourseId: imported.code ?? "local", activeVersion: 1 });
        const saved = hashLocation();
        const restored = closestValidStep(imported, saved.lessonId, saved.sectionId, saved.slideId);
        if (restored) {
          setLocation(restored.lesson, restored.section, restored.slide, true);
        } else {
          const firstLesson = imported.units[0]?.lessons[0];
          const firstSection = firstLesson?.sections[0];
          const firstSlide = firstSection?.slides[0];
          if (firstLesson && firstSection && firstSlide) {
            setLocation(firstLesson, firstSection, firstSlide, true);
          }
        }
        const expandedInit: Record<string, boolean> = {};
        for (const unit of imported.units) {
          if (unit.lessons.some((lesson) => lesson.id === saved.lessonId)) {
            expandedInit[unit.id] = true;
          }
        }
        setExpanded(expandedInit);
      })
      .catch((error) => {
        if (!cancelled) setWorkspace({ kind: "blocked", reason: error instanceof Error ? error.message : "Could not load the course", recovery: "Run npm run course:start to prepare the course." });
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    void (async () => {
      let stored = await db.profiles.toArray();
      if (!stored.length) {
        const profile = { id: crypto.randomUUID(), name: "My study profile", color: "#a41f35", createdAt: new Date().toISOString() };
        await db.profiles.add(profile); stored = [profile];
      }
      setProfiles(stored); setActiveProfile(stored[0]);
    })();
  }, []);

  useEffect(() => {
    if (!activeProfile || !activeCourseId) return;
    void Promise.all([
      db.progress.where({ profileId: activeProfile.id, courseId: activeCourseId }).toArray(),
      db.slideProgress.where({ profileId: activeProfile.id, courseId: activeCourseId }).toArray(),
    ]).then(([lessonRows, slideRows]) => {
      setCompleted(new Set(lessonRows.filter((row) => row.completed).map((row) => row.lessonId)));
      setViewedSlides(new Set(slideRows.filter((row) => row.viewed).map((row) => row.slideId)));
    });
  }, [activeProfile, activeCourseId]);

  useEffect(() => {
    const onPopState = () => {
      const location = hashLocation();
      const lesson = lessons.find((item) => item.id === location.lessonId);
      const section = lesson?.sections.find((item) => item.id === location.sectionId);
      const slide = section?.slides.find((item) => item.id === location.slideId);
      if (lesson && section && slide) {
        setActiveLessonId(lesson.id); setActiveSectionId(section.id); setActiveSlideId(slide.id);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [lessons]);

  async function persistLastLocation(lessonId: string, sectionId: string, slideId: string) {
    if (!activeCourseId) return;
    await db.courseState.put({
      id: courseStateId(activeCourseId),
      courseId: activeCourseId,
      version: workspace.kind === "ready" ? workspace.activeVersion : 1,
      title: course?.title ?? "",
      lastLessonId: lessonId,
      lastSectionId: sectionId,
      lastSlideId: slideId,
      updatedAt: new Date().toISOString(),
    });
  }

  async function recordViewed(step = current, completeOnFinish = false) {
    if (!activeProfile || !step || !activeLesson || !activeCourseId) return;
    const now = new Date().toISOString();
    setViewedSlides((existing) => new Set(existing).add(step.slide.id));
    await db.slideProgress.put({
      id: slideProgressId(activeProfile.id, activeCourseId, activeLesson.id, step.slide.id),
      profileId: activeProfile.id,
      courseId: activeCourseId,
      lessonId: activeLesson.id,
      slideId: step.slide.id,
      viewed: true,
      updatedAt: now,
    });
    if (completeOnFinish) {
      setCompleted((existing) => new Set(existing).add(activeLesson.id));
      await db.progress.put({
        id: progressId(activeProfile.id, activeCourseId, activeLesson.id),
        profileId: activeProfile.id,
        courseId: activeCourseId,
        lessonId: activeLesson.id,
        completed: true,
        updatedAt: now,
      });
    }
  }

  function selectLesson(lesson: CourseLesson) {
    const section = lesson.sections[0], slide = section?.slides[0];
    if (section && slide) {
      setLocation(lesson, section, slide);
      void persistLastLocation(lesson.id, section.id, slide.id);
    }
    setNavOpen(false); setQuery("");
  }

  async function next() {
    if (!current || !activeLesson) return;
    if (current.slide.type === "problem" && current.slide.pairId && !attemptedPairs.has(current.slide.pairId)) {
      setAttemptedPairs((pairs) => new Set(pairs).add(current.slide.pairId!));
    }
    const isLast = currentIndex === steps.length - 1;
    await recordViewed(current, isLast);
    if (isLast) return;
    const following = steps[currentIndex + 1];
    setLocation(activeLesson, following.section, following.slide);
    await persistLastLocation(activeLesson.id, following.section.id, following.slide.id);
  }

  function previous() {
    if (!activeLesson || currentIndex <= 0) return;
    const preceding = steps[currentIndex - 1];
    setLocation(activeLesson, preceding.section, preceding.slide);
    void persistLastLocation(activeLesson.id, preceding.section.id, preceding.slide.id);
  }

  async function addProfile() {
    const profile = { id: crypto.randomUUID(), name: `Study profile ${profiles.length + 1}`, color: "#c76b25", createdAt: new Date().toISOString() };
    await db.profiles.add(profile); setProfiles((currentProfiles) => [...currentProfiles, profile]); setActiveProfile(profile);
  }

  const stepProgress = steps.length ? Math.round((steps.filter((step) => viewedSlides.has(step.slide.id)).length / steps.length) * 100) : 0;

  if (workspace.kind === "loading") {
    return <main className="engine-shell empty-state"><Compass size={48} weight="bold" /><h1>Preparing your course</h1><p>Checking for an active course…</p></main>;
  }

  if (workspace.kind === "no-course") {
    return (
      <main className="engine-shell empty-state">
        <Compass size={48} weight="bold" />
        <h1>Welcome to Course Engine</h1>
        <p>{workspace.reason}</p>
        <div className="empty-actions">
          <a className="primary-button" href={AUTO_DISCOVER_URL} target="_blank" rel="noreferrer">Find a course</a>
          <span>Then run <code>npm run course:start</code></span>
        </div>
      </main>
    );
  }

  if (workspace.kind === "blocked") {
    return (
      <main className="engine-shell empty-state">
        <Warning size={48} weight="bold" />
        <h1>Could not open the course</h1>
        <p>{workspace.reason}</p>
        {workspace.recovery && <div className="empty-actions"><span>{workspace.recovery}</span></div>}
      </main>
    );
  }

  if (!course || !activeLesson || !current) {
    return <main className="engine-shell empty-state"><Warning size={48} weight="bold" /><h1>Course is empty</h1><p>This active course has no lessons.</p></main>;
  }

  return <main className="engine-shell">
    <header className="topbar">
      <button className="nav-toggle" onClick={() => setNavOpen(true)} aria-label="Open course syllabus" aria-expanded={navOpen}><List size={20} /></button>
      <a className="brand" href="#top" aria-label="Course Engine home"><span className="brand-mark"><Compass size={19} weight="bold" /></span><span>course engine</span></a>
      <div className="course-crumb"><span>{course.code}</span><i /> <span>{course.term}</span></div>
      <div className="topbar-actions">
        <label className="search"><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search course" aria-label="Search course" /></label>
        <button className="profile-button" style={activeProfile ? { backgroundColor: activeProfile.color } : undefined} title={activeProfile?.name} aria-label="Switch profile" onClick={() => setActiveProfile(profiles[(profiles.findIndex((profile) => profile.id === activeProfile?.id) + 1) % Math.max(profiles.length, 1)] ?? activeProfile)}>{activeProfile ? initials(activeProfile.name) : "…"}</button>
      </div>
    </header>
    {filteredLessons.length > 0 && <div className="search-results">{filteredLessons.map((lesson) => <button key={lesson.id} onClick={() => selectLesson(lesson)}>{lesson.title}<small>{lesson.summary}</small></button>)}</div>}

    <div className={`workspace ${assistantOpen ? "assistant-visible" : ""} ${navOpen ? "nav-open" : ""}`} id="top">
      <button className="scrim" onClick={() => setNavOpen(false)} aria-label="Close course syllabus" tabIndex={-1} />
      <aside className="syllabus" aria-label="Course syllabus">
        <div className="course-summary"><p className="eyebrow">Guided course path</p><h1>{course.title}</h1><p>{course.description}</p><div className="progress-summary"><div><strong>{completedCount}</strong><span>completed</span></div><div><strong>{Math.max(totalCount - completedCount, 0)}</strong><span>lessons left</span></div><div className="progress-track" aria-hidden="true"><span style={{ width: `${totalCount ? Math.round((completedCount / totalCount) * 100) : 0}%` }} /></div></div></div>
        <nav className="unit-list">{course.units.map((unit) => <div className="unit" key={unit.id}><button className="unit-toggle" onClick={() => setExpanded((currentExpanded) => ({ ...currentExpanded, [unit.id]: !currentExpanded[unit.id] }))} aria-expanded={Boolean(expanded[unit.id])}>{expanded[unit.id] ? <CaretDown size={15} /> : <CaretRight size={15} />}<span>{unit.title}</span><small>{unit.lessons.length}</small></button>{expanded[unit.id] && <div className="lesson-list">{unit.lessons.map((lesson) => <button key={lesson.id} className={lesson.id === activeLesson?.id ? "lesson active" : "lesson"} onClick={() => selectLesson(lesson)}><span className={completed.has(lesson.id) ? "lesson-check done" : "lesson-check"}>{completed.has(lesson.id) && <Check size={11} weight="bold" />}</span><span><b>{lesson.title}</b><small>{lesson.sections.reduce((count, section) => count + section.slides.length, 0)} steps</small></span></button>)}</div>}</div>)}</nav>
        <div className="profile-switcher"><div className="profile-list">{profiles.map((profile) => <button key={profile.id} className={profile.id === activeProfile?.id ? "current" : ""} onClick={() => setActiveProfile(profile)}><span style={{ backgroundColor: profile.color }}>{initials(profile.name)}</span>{profile.name}</button>)}</div><button className="new-profile" onClick={() => void addProfile()}><Plus size={15} /> New local profile</button></div>
      </aside>

      <section className="reader lesson-flow" aria-labelledby="lesson-title">
        <div className="reader-topline"><span>{activeLesson?.unitTitle ?? activeUnit?.title}{activeLesson?.partTitle ? ` / ${activeLesson.partTitle}` : ""}</span><span>{stepProgress}% through lesson</span></div>
        <article className="lesson-content" key={activeLesson?.id}>
          <div className="lesson-heading"><p className="lesson-kicker">Lesson sequence</p><h2 id="lesson-title">{activeLesson?.title}</h2><p className="deck">{activeLesson?.overview}</p></div>
          <nav className="section-rail" aria-label="Lesson steps">{activeLesson?.sections.map((section, sectionIndex) => <div className={section.id === activeSectionId ? "section-nav active" : "section-nav"} key={section.id}><button onClick={() => { const slide = section.slides[0]; if (activeLesson && slide) setLocation(activeLesson, section, slide); }}><span>{stepLabel(sectionIndex)}</span><b>{section.title}</b><small>{section.slides.length} {section.slides.length === 1 ? "step" : "steps"}</small></button><div>{section.slides.map((slide, slideIndex) => <button key={slide.id} className={slide.id === current?.slide.id ? "slide-link active" : "slide-link"} onClick={() => activeLesson && setLocation(activeLesson, section, slide)}><span>{stepLabel(sectionIndex, slideIndex)}</span>{viewedSlides.has(slide.id) && <Check size={12} weight="bold" />}<b>{slide.title}</b></button>)}</div></div>)}</nav>
          {current && <section className="slide-stage" aria-labelledby="slide-title">
            <div className="slide-topline"><span>{stepLabel(current.sectionIndex, current.slideIndex)}</span><span>{current.section.title}</span></div>
            <h3 id="slide-title">{current.slide.title}</h3>
            {current.slide.type === "video" && <VideoSlide slide={current.slide} />}
            {current.slide.blocks.map((block, index) => block.type === "paragraph" ? <p className="slide-copy" key={index}>{block.text}</p> : block.type === "list" ? <ul className="slide-list" key={index}>{block.items.map((item) => <li key={item}>{item}</li>)}</ul> : <figure className="slide-figure" key={index}><img src={block.src} alt={block.alt} /><figcaption>{block.caption ?? "Source course figure"}</figcaption></figure>)}
            {current.slide.type === "problem" && <div className="example-prompt"><BookOpen size={21} /><div><b>Try the problem before revealing the solution.</b><p>Your source problem is linked below. Next will reveal the paired solution.</p></div></div>}
            {current.slide.type === "solution" && <div className="example-solution"><Check size={20} weight="bold" /><span>Solution material from the original course.</span></div>}
            <SourceLinks sources={current.slide.sourceRefs} />
            <div className="slide-actions"><button className="back-step" onClick={previous} disabled={currentIndex <= 0}><CaretLeft size={18} /> Back</button><span>{currentIndex + 1} of {steps.length}</span><button className="next-step" onClick={() => void next()}>{currentIndex === steps.length - 1 ? "Finish lesson" : current.slide.type === "problem" && current.slide.pairId ? "Reveal solution" : "Next"}<CaretRight size={18} /></button></div>
          </section>}
        </article>
      </section>

      {assistantOpen && <aside className="study-panel" aria-label="Study assistant"><div className="assistant-header"><div><span className="assistant-mark"><Sparkle size={16} weight="fill" /></span><div><b>Study companion</b><small>Grounded in this step</small></div></div><button onClick={() => setAssistantOpen(false)} aria-label="Close study companion"><X size={17} weight="bold" /></button></div><div className="assistant-context"><span>Current step</span><b>{current?.slide.title}</b><p>{current?.section.title} · {current ? stepLabel(current.sectionIndex, current.slideIndex) : ""}</p></div><div className="prompt-list"><button><Sparkle size={16} /> Explain this step</button><button><Note size={16} /> Summarize this source</button><button><Warning size={16} /> Give me a practice question</button></div><div className="chat-placeholder"><span>AI setup required</span><p>Connect an OpenAI-compatible API in the engine settings to enable cited responses.</p></div></aside>}
      {!assistantOpen && <button className="open-assistant" onClick={() => setAssistantOpen(true)}><Sparkle size={17} weight="fill" /> Study companion</button>}
    </div>
  </main>;
}

function VideoSlide({ slide }: { slide: LessonSlide }) {
  const video = slide.video;
  const source = slide.sourceRefs.find((item) => item.kind === "video");
  if (video?.youtubeId) {
    const timing = video.startSeconds !== undefined ? `&start=${Math.floor(video.startSeconds)}${video.endSeconds !== undefined ? `&end=${Math.floor(video.endSeconds)}` : ""}` : "";
    return <div className="video-frame"><iframe title={slide.title} src={`https://www.youtube-nocookie.com/embed/${video.youtubeId}?rel=0&modestbranding=1${timing}`} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen /><small>{video.chapterStatus === "unavailable" ? "This source labels a clip but does not provide a chapter timestamp." : "Chapter timing from the source transcript."}</small></div>;
  }
  const href = source ? sourceHref(source) : video?.archiveUrl;
  return href ? <a className="video-fallback" href={href} target="_blank" rel="noreferrer"><PlayCircle size={28} weight="fill" /><span>Open source video</span><CaretRight size={18} /></a> : <div className="empty-lesson"><PlayCircle size={30} /><h3>Source video</h3><p>This archive lists a video without a playable public source.</p></div>;
}

function SourceLinks({ sources }: { sources: SourceReference[] }) {
  if (!sources.length) return null;
  return <div className="source-links"><span>Original course material</span>{sources.map((source) => {
    const href = sourceHref(source);
    return href ? <a href={href} target="_blank" rel="noreferrer" key={source.id}>{sourceIcon(source)}<span><b>{source.title}</b><small>{source.description || source.learningResourceTypes?.join(", ") || (source.kind === "video" ? "Video source" : "Source material")}</small></span><CaretRight size={17} /></a> : <div className="source-link unavailable" key={source.id}>{sourceIcon(source)}<span><b>{source.title}</b><small>Source link unavailable</small></span></div>;
  })}</div>;
}

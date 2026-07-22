import assert from "node:assert/strict";
import test from "node:test";
import { ingestOcwArchive } from "./ingest-ocw.ts";
import { validateCourse } from "./validate-course.ts";

test("compiles OCW lessons into an ordered source-backed lesson flow", async () => {
  const data = await ingestOcwArchive();
  const audit = validateCourse(data);
  assert.equal(audit.valid, true, audit.errors.join("\n"));
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.title, "Single Variable Calculus");
  assert.equal(data.units.length, 5);
  assert.equal(data.units[0].title, "1. Differentiation");

  const sessionOne = data.units[0].lessons.find((lesson) => lesson.id === "session-1");
  assert.ok(sessionOne);
  assert.deepEqual(sessionOne.sections.slice(0, 5).map((section) => section.title), ["Overview", "Lecture Videos and Notes", "Worked Example", "Mathlet", "Recitation Video"]);
  const lecture = sessionOne.sections.find((section) => section.title === "Lecture Videos and Notes");
  assert.equal(lecture?.slides.length, 5);
  assert.ok(lecture?.slides.every((slide) => slide.type === "video" && slide.sourceRefs.length === 1));
  assert.deepEqual(lecture?.slides.map((slide) => slide.title), [
    "Clip 1: Introduction to 18.01", "Clip 2: Geometric Interpretation of Differentiation", "Clip 3: Limit of Secants", "Clip 4: Slope as Ratio", "Clip 5: Main Formula",
  ]);
  assert.ok(lecture?.slides.every((slide) => slide.video?.chapterStatus === "unavailable"));

  const worked = sessionOne.sections.find((section) => section.kind === "worked-example");
  const problem = worked?.slides.find((slide) => slide.type === "problem");
  const solution = worked?.slides.find((slide) => slide.type === "solution");
  assert.ok(problem?.sourceRefs[0]?.url?.endsWith("MIT18_01SCF10_ex01prb.pdf"));
  assert.ok(solution?.sourceRefs[0]?.url?.endsWith("MIT18_01SCF10_ex01sol.pdf"));
  assert.equal(problem?.pairId, solution?.pairId);

  const lessons = data.units.flatMap((unit) => unit.lessons);
  assert.equal(lessons.length, 112);
  assert.ok(lessons.every((lesson) => lesson.sections.length > 0 && lesson.sections.every((section) => section.slides.length > 0)));
  assert.ok(audit.counts.videos >= 277);
  assert.ok(audit.counts.documents >= 191);
});

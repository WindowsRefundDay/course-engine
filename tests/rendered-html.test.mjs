import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the learner shell without compiler dashboard links", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /Course Engine/);
  assert.match(html, /Preparing your course|Welcome to Course Engine|Could not open the course/);
  assert.doesNotMatch(html, /compiler workspace|Compiler Workspace|Draft ready|Publish draft/i);
  assert.doesNotMatch(html, /Study material/i);
  assert.doesNotMatch(html, /Codex is working|react-loading-skeleton|codex-preview/i);
});

test("compiler route is gated from production learner builds", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/compiler", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
  assert.ok(response.status === 404 || response.status === 500, `Expected compiler route to be unreachable in production, got ${response.status}`);
});

test("keeps the reader backed by schema-v2 course data and course-scoped progress", async () => {
  const [workspace, database, activeCourseApi, courseData, config, packageJson] = await Promise.all([
    readFile(new URL("../app/course-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/course-db.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/active-course-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/course-data/calculus.json", import.meta.url), "utf8"),
    readFile(new URL("../courses/mit-18-01sc/course.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const course = JSON.parse(courseData);
  assert.equal(course.schemaVersion, 2);
  assert.equal(course.units.length, 5);
  assert.ok(course.units[0].lessons.length >= 20);
  assert.match(workspace, /loadLearnerCourse/);
  assert.match(workspace, /activeCourseId/);
  assert.match(workspace, /section-rail/);
  assert.match(workspace, /Finish lesson/);
  assert.match(workspace, /setHash/);
  assert.doesNotMatch(workspace, /Study material/);
  assert.doesNotMatch(workspace, /fallbackCourse/);
  assert.match(workspace, /loadLearnerCourse/);
  assert.match(activeCourseApi, /NEXT_PUBLIC_COURSE_ENGINE_STATIC_FALLBACK/);
  assert.match(activeCourseApi, /STATIC_FALLBACK_ENABLED/);
  assert.match(activeCourseApi, /loadStaticFallback/);
  assert.doesNotMatch(activeCourseApi, /\/course-data\/calculus\.json[^\n]*\n(?![\s\S]*FALLBACK)/);
  assert.match(database, /slideProgress/);
  assert.match(database, /db\.version\(3\)/);
  assert.match(database, /courseId/);
  assert.match(config, /mit-ocw-static-archive/);
  assert.match(packageJson, /"course:start"/);
  assert.match(packageJson, /"course:validate"/);
  assert.match(packageJson, /"engine:doctor"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

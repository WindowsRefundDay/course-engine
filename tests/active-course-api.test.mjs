import assert from "node:assert/strict";
import test from "node:test";

const { loadLearnerCourse, staticFallbackEnabled } = await import("../app/active-course-api.ts");

test("static fallback is disabled by default", () => {
  assert.equal(staticFallbackEnabled(), false);
});

test("loadLearnerCourse returns null when no active backend exists and static fallback is disabled", async () => {
  // The local engine is not running in this test, so /active will fail.
  const course = await loadLearnerCourse();
  assert.equal(course, null);
});

test("loadLearnerCourse does not silently load calculus.json by default", async () => {
  const course = await loadLearnerCourse();
  if (course !== null) {
    assert.notEqual(course.title, "Single Variable Calculus", "Default load must not silently import the static calculus artifact");
  }
});

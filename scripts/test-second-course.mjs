import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const fixture = resolve("test-fixtures/18.02sc-fall-2010.zip");
const temporary = await mkdtemp(join(tmpdir(), "course-engine-18.02-"));
const output = join(temporary, "compiled.json");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
}

try {
  run("unzip", ["-tq", fixture]);
  run("unzip", ["-q", fixture, "-d", temporary]);
  run("node", ["--experimental-strip-types", "scripts/compile-ocw.ts", temporary, output]);
  const course = JSON.parse(await readFile(output, "utf8"));
  const lessons = course.units.flatMap((unit) => unit.lessons);
  const slides = lessons.flatMap((lesson) => lesson.sections.flatMap((section) => section.slides));
  assert.equal(course.schemaVersion, 2);
  assert.equal(course.code, "18.02SC");
  assert.ok(course.units.length > 1);
  assert.ok(lessons.length > 100);
  assert.ok(slides.length > 1000);
  assert.equal(course.compiler.validation.valid, true);
  console.log(JSON.stringify({ title: course.title, units: course.units.length, lessons: lessons.length, slides: slides.length }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

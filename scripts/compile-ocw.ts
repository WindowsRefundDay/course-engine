/** Compile an OCW archive through SourceGraph, decision replay, and validation. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompilationFile } from "./compiler/types.ts";
import { compileCourse } from "./compiler/compile.ts";
import { createSourceGraphFromCourse } from "./compiler/source-graph.ts";
import { ingestOcwArchive } from "./ingest-ocw.ts";

const EMPTY_COMPILATION = (slug: string): CompilationFile => ({
  schemaVersion: 1,
  courseSlug: slug,
  decisions: [],
  relationships: [],
});

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "course";
}

export async function compileOcwArchive(sourceRoot: string, compilationPath?: string) {
  const course = await ingestOcwArchive(sourceRoot);
  const { sourceGraph, relationships } = createSourceGraphFromCourse(course);
  const local: CompilationFile = compilationPath
    ? JSON.parse(await readFile(compilationPath, "utf8")) as CompilationFile
    : EMPTY_COMPILATION(slug(course.code));
  const compilation: CompilationFile = {
    ...local,
    sourceFingerprint: local.sourceFingerprint ?? sourceGraph.sourceFingerprint,
    relationships: [...relationships, ...local.relationships],
  };
  const result = compileCourse({ course, sourceGraph, compilation });
  if (!result.audit.valid) throw new Error(result.audit.errors.join("\n"));
  return {
    ...result.artifact.course,
    compiler: {
      sourceFingerprint: sourceGraph.sourceFingerprint,
      sourceGraph,
      decisions: result.artifact.decisions,
      relationships: result.artifact.relationships,
      validation: result.audit,
    },
  };
}

export async function writeCompiledOcwArchive(sourceRoot: string, outputPath: string, compilationPath?: string) {
  const course = await compileOcwArchive(sourceRoot, compilationPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(course, null, 2)}\n`, "utf8");
  return course;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = resolve(process.argv[2] ?? "..");
  const output = resolve(process.argv[3] ?? "public/course-data/calculus.json");
  const compilation = process.argv[4] ? resolve(process.argv[4]) : undefined;
  writeCompiledOcwArchive(source, output, compilation)
    .then((course) => console.log(`Compiled ${course.title} with ${course.units.length} units to ${output}`))
    .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}

import type { Course } from "../../app/course-types.ts";
import { validateCourse, type CourseAudit } from "../validate-course.ts";
import { replayCompilationDecisions } from "./decisions.ts";
import type { CompilationFile, CompiledCourseArtifact, GeneratedContentRecord, SourceGraph, ValidationIssue } from "./types.ts";

export type CompileCourseInput = {
  course: Course;
  sourceGraph: SourceGraph;
  compilation: CompilationFile;
  generatedContent?: GeneratedContentRecord[];
};

export type CompileCourseResult = {
  artifact: CompiledCourseArtifact;
  audit: CourseAudit;
};

/** Deterministic compiler boundary. Publishing must require audit.valid. */
export function compileCourse(input: CompileCourseInput): CompileCourseResult {
  const fingerprintIssues: ValidationIssue[] = [];
  if (input.compilation.sourceFingerprint && input.compilation.sourceFingerprint !== input.sourceGraph.sourceFingerprint) {
    fingerprintIssues.push({ code: "stale-decision", severity: "blocker", message: "Compilation decisions were recorded for a different source fingerprint." });
  }
  const replay = replayCompilationDecisions(input.course, input.sourceGraph, input.compilation.decisions, input.compilation.relationships);
  const generatedContent = structuredClone(input.generatedContent ?? []);
  const artifact: CompiledCourseArtifact = {
    schemaVersion: 1,
    sourceFingerprint: input.sourceGraph.sourceFingerprint,
    course: replay.course,
    decisions: structuredClone(input.compilation.decisions),
    relationships: replay.relationships,
    generatedContent,
  };
  const audit = validateCourse(artifact.course, {
    sourceGraph: input.sourceGraph,
    relationships: artifact.relationships,
    generatedContent,
    priorIssues: [...fingerprintIssues, ...replay.issues],
  });
  return { artifact, audit };
}

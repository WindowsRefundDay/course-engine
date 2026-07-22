import assert from "node:assert/strict";
import test from "node:test";
import type { Course } from "../../app/course-types.ts";
import { validateCourse } from "../validate-course.ts";
import { compileCourse } from "./compile.ts";
import { replayCompilationDecisions } from "./decisions.ts";
import { createSourceGraph, createSourceNode } from "./source-graph.ts";
import type { CompilationDecision, GeneratedContentRecord, SourceRelationship } from "./types.ts";

function course(): Course {
  return {
    schemaVersion: 2,
    title: "Fixture course",
    code: "FIX-1",
    term: "Test",
    description: "Compiler fixture",
    units: [{
      id: "unit-1",
      title: "Unit 1",
      lessons: [{
        id: "lesson-1",
        title: "Lesson 1",
        unitTitle: "Unit 1",
        partTitle: "Part A",
        summary: "Summary",
        overview: "Overview",
        sections: [{
          id: "section-1",
          title: "Clips",
          kind: "media",
          slides: [
            { id: "slide-1", title: "First", type: "video", blocks: [], sourceRefs: [{ id: "video-source", title: "Lecture", kind: "video", youtubeId: "abc" }], required: true, video: { youtubeId: "abc", chapterStatus: "unavailable" } },
            { id: "slide-2", title: "Second", type: "article", blocks: [{ type: "paragraph", text: "Text" }], sourceRefs: [], required: true },
          ],
        }],
      }],
    }],
  };
}

const provenance = { author: "compiler-test", origin: "human" as const, reason: "Explicit fixture relationship", confidence: 1 };

test("source identities and fingerprints survive archive relocation", () => {
  const first = createSourceGraph([{ kind: "pdf", title: "Worked example", text: "x = 2", semanticKey: "worked-example-1", location: { sourcePath: "old/example.pdf", page: 4 } }]);
  const relocated = createSourceGraph([{ kind: "pdf", title: "Worked example", text: "x = 2", semanticKey: "worked-example-1", location: { sourcePath: "new/archive/example.pdf", page: 9 } }]);
  assert.equal(first.nodes[0].id, relocated.nodes[0].id);
  assert.equal(first.nodes[0].contentHash, relocated.nodes[0].contentHash);
  assert.equal(first.sourceFingerprint, relocated.sourceFingerprint);
  const edited = createSourceGraph([{ kind: "pdf", title: "Worked example", text: "x = 3", semanticKey: "worked-example-1", location: { sourcePath: "new/archive/example.pdf", page: 9 } }]);
  assert.equal(first.nodes[0].id, edited.nodes[0].id);
  assert.notEqual(first.nodes[0].contentHash, edited.nodes[0].contentHash);
});

test("course-local decisions replay deterministically without changing stable learner ids", () => {
  const graph = createSourceGraph([{ kind: "paragraph", title: "Clip label", text: "A clearer label", semanticKey: "clip-label" }]);
  const selector = { nodeId: graph.nodes[0].id, contentHash: graph.nodes[0].contentHash };
  const decisions: CompilationDecision[] = [
    { id: "02-reorder", operation: "reorder-slides", selector, targetSectionId: "section-1", orderedSlideIds: ["slide-2", "slide-1"], provenance },
    { id: "01-rename", operation: "rename-slide", selector, targetSlideId: "slide-1", title: "Introduction clip", provenance },
  ];
  const first = replayCompilationDecisions(course(), graph, decisions);
  const second = replayCompilationDecisions(course(), graph, [...decisions].reverse());
  assert.deepEqual(first, second);
  assert.deepEqual(first.course.units[0].lessons[0].sections[0].slides.map((slide) => slide.id), ["slide-2", "slide-1"]);
  assert.equal(first.course.units[0].lessons[0].sections[0].slides[1].title, "Introduction clip");
  assert.deepEqual(first.appliedDecisionIds, ["01-rename", "02-reorder"]);
});

test("decision replay blocks stale and ambiguous stable selectors", () => {
  const node = createSourceNode({ kind: "paragraph", text: "source", semanticKey: "source" });
  const decision: CompilationDecision = { id: "rename", operation: "rename-slide", selector: { nodeId: node.id, contentHash: "changed" }, targetSlideId: "slide-1", title: "No", provenance };
  const stale = replayCompilationDecisions(course(), { schemaVersion: 1, sourceFingerprint: "fixture", nodes: [node], edges: [] }, [decision]);
  assert.equal(stale.issues[0]?.code, "stale-decision");
  const ambiguousDecision = { ...decision, selector: { nodeId: node.id, contentHash: node.contentHash } };
  const ambiguous = replayCompilationDecisions(course(), { schemaVersion: 1, sourceFingerprint: "fixture", nodes: [node, structuredClone(node)], edges: [] }, [ambiguousDecision]);
  assert.equal(ambiguous.issues[0]?.code, "ambiguous-decision");
});

test("missing chapter timing is valid but fabricated or unsupported ranges block publication", () => {
  assert.equal(validateCourse(course()).valid, true);
  const invalid = course();
  invalid.units[0].lessons[0].sections[0].slides[0].video = { youtubeId: "abc", chapterStatus: "unavailable", startSeconds: 1, endSeconds: 5 };
  assert.ok(validateCourse(invalid).issues.some((issue) => issue.code === "invalid-clip-range"));
  const inferred = course();
  inferred.units[0].lessons[0].sections[0].slides[0].video = { youtubeId: "abc", chapterStatus: "inferred", startSeconds: 1, endSeconds: 5 };
  assert.ok(validateCourse(inferred).issues.some((issue) => issue.code === "unsupported-clip-range"));
});

test("relationship and generated-content gates reject orphans, unexplained diagrams, and uncited AI text", () => {
  const graph = createSourceGraph([
    { kind: "diagram", title: "Derivative diagram", text: "tangent and secant", semanticKey: "diagram-1" },
    { kind: "paragraph", text: "The derivative is a limit.", semanticKey: "paragraph-1" },
  ]);
  const diagram = graph.nodes.find((node) => node.kind === "diagram")!;
  const paragraph = graph.nodes.find((node) => node.kind === "paragraph")!;
  const orphanAudit = validateCourse(course(), { sourceGraph: graph });
  assert.ok(orphanAudit.issues.some((issue) => issue.code === "orphaned-resource" && issue.nodeId === diagram.id));

  const relationships: SourceRelationship[] = [{ id: "diagram-placement", source: { nodeId: diagram.id, contentHash: diagram.contentHash }, targetSlideId: "slide-2", kind: "illustrates", reason: "", provenance }];
  const generatedContent: GeneratedContentRecord[] = [{ id: "summary", targetSlideId: "slide-2", blocks: [{ type: "paragraph", text: "Generated summary" }], provenance: { ...provenance, origin: "ai" }, citations: [] }];
  const invalid = validateCourse(course(), { sourceGraph: graph, relationships, generatedContent });
  assert.ok(invalid.issues.some((issue) => issue.code === "unexplained-relationship"));
  assert.ok(invalid.issues.some((issue) => issue.code === "missing-generated-citation"));

  relationships[0].reason = "This source diagram illustrates the tangent construction shown in this step.";
  const cited: GeneratedContentRecord[] = [{ ...generatedContent[0], citations: [{ nodeId: paragraph.id, contentHash: paragraph.contentHash }] }];
  const valid = validateCourse(course(), { sourceGraph: graph, relationships, generatedContent: cited });
  assert.equal(valid.valid, true, valid.errors.join("\n"));
});

test("unsafe source URL schemes block publication", () => {
  const graph = createSourceGraph([{ kind: "pdf", title: "Unsafe", semanticKey: "unsafe", location: { url: "javascript:alert(1)" } }]);
  const node = graph.nodes[0];
  const relationships: SourceRelationship[] = [{ id: "unsafe-placement", source: { nodeId: node.id, contentHash: node.contentHash }, targetSlideId: "slide-2", kind: "primary-source", reason: "Fixture", provenance }];
  const audit = validateCourse(course(), { sourceGraph: graph, relationships });
  assert.ok(audit.issues.some((issue) => issue.code === "unsafe-source-link"));
});

test("inferred clip decisions retain transcript evidence as an explicit relationship", () => {
  const graph = createSourceGraph([
    { kind: "video", title: "Lecture", semanticKey: "lecture", metadata: { youtubeId: "abc", durationSeconds: 120 } },
    { kind: "transcript", text: "At this point we introduce derivatives.", semanticKey: "lecture-transcript" },
  ]);
  const video = graph.nodes.find((node) => node.kind === "video")!, transcript = graph.nodes.find((node) => node.kind === "transcript")!;
  const decision: CompilationDecision = {
    id: "clip-1",
    operation: "set-clip-range",
    selector: { nodeId: video.id, contentHash: video.contentHash },
    targetSlideId: "slide-1",
    chapterStatus: "inferred",
    startSeconds: 10,
    endSeconds: 30,
    transcriptEvidence: { nodeId: transcript.id, contentHash: transcript.contentHash },
    confidence: 0.9,
    provenance: { ...provenance, origin: "ai" },
  };
  const replay = replayCompilationDecisions(course(), graph, [decision]);
  const audit = validateCourse(replay.course, { sourceGraph: graph, relationships: replay.relationships, priorIssues: replay.issues });
  assert.ok(replay.relationships.some((relationship) => relationship.kind === "transcript-evidence"));
  assert.ok(!audit.issues.some((issue) => issue.code === "unsupported-clip-range"));
});

test("compile boundary replays decisions and blocks a stale course-local fingerprint", () => {
  const graph = createSourceGraph([{ kind: "paragraph", title: "Overview", text: "Source overview", semanticKey: "overview" }]);
  const selector = { nodeId: graph.nodes[0].id, contentHash: graph.nodes[0].contentHash };
  const result = compileCourse({
    course: course(),
    sourceGraph: graph,
    compilation: {
      schemaVersion: 1,
      courseSlug: "fixture",
      sourceFingerprint: "previous-source",
      decisions: [{ id: "rename", operation: "rename-slide", selector, targetSlideId: "slide-2", title: "Compiled overview", provenance }],
      relationships: [],
    },
  });
  assert.equal(result.artifact.course.units[0].lessons[0].sections[0].slides[1].title, "Compiled overview");
  assert.equal(result.audit.valid, false);
  assert.ok(result.audit.issues.some((issue) => issue.code === "stale-decision" && issue.message.includes("fingerprint")));
});

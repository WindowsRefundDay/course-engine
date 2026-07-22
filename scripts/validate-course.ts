/** Deterministic structural and source-relationship checks for compiled courses. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Course, LessonSlide } from "../app/course-types.ts";
import type {
  GeneratedContentRecord,
  SourceGraph,
  SourceRelationship,
  StableSourceSelector,
  ValidationIssue,
} from "./compiler/types.ts";

export type CourseValidationContext = {
  sourceGraph?: SourceGraph;
  relationships?: SourceRelationship[];
  generatedContent?: GeneratedContentRecord[];
  priorIssues?: ValidationIssue[];
};

export type CourseAudit = {
  valid: boolean;
  errors: string[];
  issues: ValidationIssue[];
  counts: { units: number; lessons: number; sections: number; slides: number; videos: number; documents: number };
};

function selectorMatches(graph: SourceGraph, selector: StableSourceSelector): boolean {
  return graph.nodes.some((node) => node.id === selector.nodeId && node.contentHash === selector.contentHash);
}

function safeSourceUrl(value: string): boolean {
  try {
    const parsed = new URL(value, "https://course-engine.invalid");
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
}

function validateRelationships(context: CourseValidationContext, slideIds: Set<string>): ValidationIssue[] {
  const graph = context.sourceGraph;
  if (!graph) return [];
  const issues: ValidationIssue[] = [];
  const relationships = context.relationships ?? [];
  const nodeIdCounts = new Map<string, number>();
  for (const node of graph.nodes) nodeIdCounts.set(node.id, (nodeIdCounts.get(node.id) ?? 0) + 1);
  for (const [nodeId, count] of nodeIdCounts) if (count > 1) issues.push({ code: "duplicate-source-node", severity: "blocker", nodeId, message: `Source node ${nodeId} occurs ${count} times.` });
  for (const node of graph.nodes) if (node.location?.url && !safeSourceUrl(node.location.url)) {
    issues.push({ code: "unsafe-source-link", severity: "blocker", nodeId: node.id, message: `Source node ${node.id} has an unsafe URL.` });
  }

  for (const relationship of relationships) {
    if (!selectorMatches(graph, relationship.source)) issues.push({ code: "stale-decision", severity: "blocker", nodeId: relationship.source.nodeId, message: `Relationship ${relationship.id} targets a missing or changed source node.` });
    if (relationship.targetSlideId && !slideIds.has(relationship.targetSlideId)) issues.push({ code: "missing-target", severity: "blocker", slideId: relationship.targetSlideId, message: `Relationship ${relationship.id} targets missing slide ${relationship.targetSlideId}.` });
    if (!relationship.reason.trim()) issues.push({ code: "unexplained-relationship", severity: "blocker", nodeId: relationship.source.nodeId, message: `Relationship ${relationship.id} has no explanation.` });
    for (const evidence of relationship.evidence ?? []) if (!selectorMatches(graph, evidence)) issues.push({ code: "stale-decision", severity: "blocker", nodeId: evidence.nodeId, message: `Evidence for relationship ${relationship.id} is missing or changed.` });
  }

  const relationshipKinds = new Set(["video", "pdf", "pdf-page", "table", "diagram", "figure", "interactive"]);
  for (const node of graph.nodes.filter((item) => item.relationshipRequired || relationshipKinds.has(item.kind))) {
    if (!relationships.some((relationship) => relationship.source.nodeId === node.id && relationship.source.contentHash === node.contentHash)) {
      issues.push({ code: "orphaned-resource", severity: "blocker", nodeId: node.id, message: `${node.kind} source ${node.id} is not placed or explicitly excluded.` });
    }
  }
  return issues;
}

function validateGeneratedContent(context: CourseValidationContext, slideIds: Set<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const record of context.generatedContent ?? []) {
    if (!slideIds.has(record.targetSlideId)) issues.push({ code: "missing-target", severity: "blocker", slideId: record.targetSlideId, message: `Generated content ${record.id} targets a missing slide.` });
    if (record.provenance.origin !== "ai" || !record.provenance.author.trim() || !record.provenance.reason.trim()) issues.push({ code: "invalid-generated-provenance", severity: "blocker", slideId: record.targetSlideId, message: `Generated content ${record.id} lacks AI provenance.` });
    if (!record.citations.length) issues.push({ code: "missing-generated-citation", severity: "blocker", slideId: record.targetSlideId, message: `Generated content ${record.id} has no source citations.` });
    if (context.sourceGraph) for (const citation of record.citations) if (!selectorMatches(context.sourceGraph, citation)) issues.push({ code: "missing-generated-citation", severity: "blocker", slideId: record.targetSlideId, nodeId: citation.nodeId, message: `Generated content ${record.id} cites a missing or changed source.` });
  }
  return issues;
}

function validateExamplePairs(slides: LessonSlide[], slideSections: Map<string, string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const positions = new Map(slides.map((slide, index) => [slide.id, index]));
  const pairs = new Map<string, LessonSlide[]>();
  for (const slide of slides) {
    if ((slide.type === "problem" || slide.type === "solution") && !slide.pairId) issues.push({ code: "invalid-example-pair", severity: "blocker", slideId: slide.id, message: `${slide.type} slide ${slide.id} is not paired.` });
    if (slide.pairId) pairs.set(slide.pairId, [...(pairs.get(slide.pairId) ?? []), slide]);
  }
  for (const [pairId, pairSlides] of pairs) {
    const problems = pairSlides.filter((slide) => slide.type === "problem"), solutions = pairSlides.filter((slide) => slide.type === "solution");
    if (problems.length !== 1 || solutions.length !== 1) issues.push({ code: "invalid-example-pair", severity: "blocker", message: `Example pair ${pairId} must contain exactly one problem and one solution.` });
    else if (slideSections.get(problems[0].id) !== slideSections.get(solutions[0].id)) issues.push({ code: "invalid-example-pair", severity: "blocker", slideId: solutions[0].id, message: `Example pair ${pairId} crosses section boundaries.` });
    else if ((positions.get(problems[0].id) ?? 0) >= (positions.get(solutions[0].id) ?? 0)) issues.push({ code: "invalid-example-pair", severity: "blocker", slideId: solutions[0].id, message: `Solution ${solutions[0].id} appears before its problem.` });
  }
  return issues;
}

function videoSourceKey(slide: LessonSlide): string | undefined {
  return slide.video?.youtubeId ?? slide.video?.archiveUrl ?? slide.sourceRefs.find((source) => source.kind === "video")?.id;
}

function validateClipRanges(slides: LessonSlide[], context: CourseValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const claimed: Array<{ slide: LessonSlide; sourceKey: string; start: number; end: number }> = [];
  for (const slide of slides.filter((item) => item.type === "video")) {
    const video = slide.video;
    if (!video) continue;
    const hasStart = video.startSeconds !== undefined, hasEnd = video.endSeconds !== undefined;
    if (video.chapterStatus === "unavailable") {
      if (hasStart || hasEnd) issues.push({ code: "invalid-clip-range", severity: "blocker", slideId: slide.id, message: `Video ${slide.id} is marked chapter timing unavailable but claims a range.` });
      continue;
    }
    if (!hasStart || !hasEnd || video.startSeconds! < 0 || video.endSeconds! <= video.startSeconds!) {
      issues.push({ code: "invalid-clip-range", severity: "blocker", slideId: slide.id, message: `Video ${slide.id} has an invalid claimed chapter range.` });
      continue;
    }
    const sourceKey = videoSourceKey(slide);
    if (sourceKey) claimed.push({ slide, sourceKey, start: video.startSeconds!, end: video.endSeconds! });
    if (video.chapterStatus === "inferred") {
      const supported = (context.relationships ?? []).some((relationship) => relationship.targetSlideId === slide.id && relationship.kind === "transcript-evidence" && relationship.evidence?.some((selector) => context.sourceGraph ? selectorMatches(context.sourceGraph, selector) : true));
      if (!supported) issues.push({ code: "unsupported-clip-range", severity: "blocker", slideId: slide.id, message: `Inferred clip range for ${slide.id} has no transcript evidence.` });
    }
    if (context.sourceGraph && sourceKey) {
      const duration = context.sourceGraph.nodes.find((node) => node.id === sourceKey || node.metadata?.youtubeId === sourceKey || node.location?.url === sourceKey)?.metadata?.durationSeconds;
      if (typeof duration === "number" && video.endSeconds! > duration) issues.push({ code: "invalid-clip-range", severity: "blocker", slideId: slide.id, message: `Video ${slide.id} ends after its source duration.` });
    }
  }
  const grouped = new Map<string, typeof claimed>();
  for (const item of claimed) grouped.set(item.sourceKey, [...(grouped.get(item.sourceKey) ?? []), item]);
  for (const [sourceKey, ranges] of grouped) {
    const ordered = [...ranges].sort((left, right) => left.start - right.start);
    for (let index = 1; index < ordered.length; index += 1) if (ordered[index].start < ordered[index - 1].end) issues.push({ code: "invalid-clip-range", severity: "blocker", slideId: ordered[index].slide.id, message: `Claimed clip ranges overlap for source ${sourceKey}.` });
  }
  return issues;
}

export function validateCourse(value: unknown, context: CourseValidationContext = {}): CourseAudit {
  const issues: ValidationIssue[] = [...(context.priorIssues ?? [])];
  const counts = { units: 0, lessons: 0, sections: 0, slides: 0, videos: 0, documents: 0 };
  if (!value || typeof value !== "object") return { valid: false, errors: ["Course data must be an object."], issues: [{ code: "invalid-course-structure", severity: "blocker", message: "Course data must be an object." }], counts };
  const course = value as Partial<Course>;
  const structural = (message: string, slideId?: string) => issues.push({ code: "invalid-course-structure", severity: "blocker", message, ...(slideId ? { slideId } : {}) });
  if (course.schemaVersion !== 2) structural("Course data must use schemaVersion 2.");
  if (!course.title || !Array.isArray(course.units)) structural("Course title and units are required.");
  const ids = new Set<string>(), slideIds = new Set<string>(), slides: LessonSlide[] = [], slideSections = new Map<string, string>();
  const remember = (id: string, label: string) => {
    if (!id) structural(`${label} is missing an id.`);
    else if (ids.has(id)) structural(`Duplicate id: ${id}.`);
    else ids.add(id);
  };
  for (const unit of course.units ?? []) {
    counts.units += 1; remember(unit.id, "Unit");
    for (const lesson of unit.lessons ?? []) {
      counts.lessons += 1; remember(lesson.id, "Lesson");
      if (!lesson.sections?.length) structural(`Lesson ${lesson.id} has no sections.`);
      for (const section of lesson.sections ?? []) {
        counts.sections += 1; remember(section.id, "Section");
        if (!section.slides?.length) structural(`Section ${section.id} has no slides.`);
        for (const slide of section.slides ?? []) {
          counts.slides += 1; remember(slide.id, "Slide"); slideIds.add(slide.id); slides.push(slide); slideSections.set(slide.id, section.id);
          if (!slide.title) structural(`Slide ${slide.id} is missing a title.`, slide.id);
          if (!Array.isArray(slide.blocks) || !Array.isArray(slide.sourceRefs)) structural(`Slide ${slide.id} has an invalid content shape.`, slide.id);
          if (slide.type === "video") {
            counts.videos += 1;
            if (!slide.video?.youtubeId && !slide.video?.archiveUrl && !slide.sourceRefs.some((source) => source.kind === "video")) structural(`Video slide ${slide.id} has no playable source.`, slide.id);
          }
          if (["problem", "solution", "document"].includes(slide.type)) counts.documents += 1;
        }
      }
    }
  }
  issues.push(...validateExamplePairs(slides, slideSections), ...validateClipRanges(slides, context), ...validateRelationships(context, slideIds), ...validateGeneratedContent(context, slideIds));
  const errors = issues.filter((issue) => issue.severity === "blocker").map((issue) => issue.message);
  return { valid: errors.length === 0, errors, issues, counts };
}

if (process.argv[1]?.endsWith("validate-course.ts")) {
  const input = resolve(process.argv[2] ?? "public/course-data/calculus.json");
  readFile(input, "utf8").then((contents) => {
    const audit = validateCourse(JSON.parse(contents));
    console.log(JSON.stringify(audit, null, 2));
    if (!audit.valid) process.exitCode = 1;
  }).catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}

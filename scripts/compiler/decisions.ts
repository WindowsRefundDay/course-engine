import type { Course, LessonSlide } from "../../app/course-types.ts";
import type {
  CompilationDecision,
  SourceGraph,
  SourceRelationship,
  StableSourceSelector,
  ValidationIssue,
} from "./types.ts";

export type DecisionReplayResult = {
  course: Course;
  relationships: SourceRelationship[];
  appliedDecisionIds: string[];
  issues: ValidationIssue[];
};

function cloneCourse(course: Course): Course {
  return structuredClone(course);
}

function resolveSelector(graph: SourceGraph, selector: StableSourceSelector): { valid: boolean; issue?: Pick<ValidationIssue, "code" | "message"> } {
  const matches = graph.nodes.filter((node) => node.id === selector.nodeId && node.contentHash === selector.contentHash);
  if (matches.length === 1) return { valid: true };
  if (matches.length > 1) return { valid: false, issue: { code: "ambiguous-decision", message: `Source selector ${selector.nodeId} resolves to ${matches.length} nodes.` } };
  const idMatches = graph.nodes.filter((node) => node.id === selector.nodeId);
  return {
    valid: false,
    issue: {
      code: idMatches.length ? "stale-decision" : "stale-decision",
      message: idMatches.length
        ? `Source selector ${selector.nodeId} has a stale content hash.`
        : `Source selector ${selector.nodeId} no longer exists.`,
    },
  };
}

function allSlides(course: Course): LessonSlide[] {
  return course.units.flatMap((unit) => unit.lessons.flatMap((lesson) => lesson.sections.flatMap((section) => section.slides)));
}

function issue(decision: CompilationDecision, code: ValidationIssue["code"], message: string): ValidationIssue {
  return { code, severity: "blocker", message, decisionId: decision.id, nodeId: decision.selector.nodeId };
}

export function replayCompilationDecisions(
  sourceCourse: Course,
  graph: SourceGraph,
  decisions: CompilationDecision[],
  initialRelationships: SourceRelationship[] = [],
): DecisionReplayResult {
  const course = cloneCourse(sourceCourse);
  const relationships = structuredClone(initialRelationships);
  const issues: ValidationIssue[] = [];
  const appliedDecisionIds: string[] = [];

  for (const decision of [...decisions].sort((left, right) => left.id.localeCompare(right.id))) {
    const resolution = resolveSelector(graph, decision.selector);
    if (!resolution.valid) {
      issues.push(issue(decision, resolution.issue?.code ?? "stale-decision", resolution.issue?.message ?? "Source selector is invalid."));
      continue;
    }
    const slides = allSlides(course);
    const slideById = (id: string) => slides.find((slide) => slide.id === id);

    if (decision.operation === "rename-slide") {
      const slide = slideById(decision.targetSlideId);
      if (!slide) issues.push(issue(decision, "missing-target", `Slide ${decision.targetSlideId} does not exist.`));
      else slide.title = decision.title;
    } else if (decision.operation === "exclude-slide") {
      let removed = false;
      for (const unit of course.units) for (const lesson of unit.lessons) for (const section of lesson.sections) {
        const index = section.slides.findIndex((slide) => slide.id === decision.targetSlideId);
        if (index >= 0) { section.slides.splice(index, 1); removed = true; }
      }
      if (!removed) issues.push(issue(decision, "missing-target", `Slide ${decision.targetSlideId} does not exist.`));
    } else if (decision.operation === "reorder-slides") {
      const section = course.units.flatMap((unit) => unit.lessons.flatMap((lesson) => lesson.sections)).find((item) => item.id === decision.targetSectionId);
      if (!section) issues.push(issue(decision, "missing-target", `Section ${decision.targetSectionId} does not exist.`));
      else if (decision.orderedSlideIds.length !== section.slides.length || new Set(decision.orderedSlideIds).size !== section.slides.length || decision.orderedSlideIds.some((id) => !section.slides.some((slide) => slide.id === id))) {
        issues.push(issue(decision, "invalid-order", `Decision ${decision.id} must list every slide in ${section.id} exactly once.`));
      } else {
        const order = new Map(decision.orderedSlideIds.map((id, index) => [id, index]));
        section.slides.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
      }
    } else if (decision.operation === "attach-source") {
      const slide = slideById(decision.targetSlideId);
      const node = graph.nodes.find((item) => item.id === decision.selector.nodeId && item.contentHash === decision.selector.contentHash);
      if (!slide || !node) issues.push(issue(decision, "missing-target", `Cannot attach source to missing slide ${decision.targetSlideId}.`));
      else {
        if (!slide.sourceRefs.some((reference) => reference.id === node.id)) slide.sourceRefs.push({ id: node.id, title: node.title ?? node.text ?? node.id, kind: node.kind === "video" ? "video" : node.kind === "interactive" ? "interactive" : ["pdf", "pdf-page"].includes(node.kind) ? "document" : "other", ...(node.location?.url ? { url: node.location.url } : {}) });
        relationships.push({ id: decision.relationshipId, source: decision.selector, targetSlideId: slide.id, kind: decision.relationshipKind, reason: decision.provenance.reason, provenance: decision.provenance });
      }
    } else if (decision.operation === "pair-example") {
      const problem = slideById(decision.problemSlideId), solution = slideById(decision.solutionSlideId);
      if (!problem || !solution) issues.push(issue(decision, "missing-target", "Problem or solution slide does not exist."));
      else { problem.type = "problem"; solution.type = "solution"; problem.pairId = decision.pairId; solution.pairId = decision.pairId; }
    } else if (decision.operation === "set-clip-range") {
      const slide = slideById(decision.targetSlideId);
      if (!slide) issues.push(issue(decision, "missing-target", `Video slide ${decision.targetSlideId} does not exist.`));
      else {
        if (decision.transcriptEvidence) {
          const transcriptResolution = resolveSelector(graph, decision.transcriptEvidence);
          if (!transcriptResolution.valid) {
            issues.push(issue(decision, transcriptResolution.issue?.code ?? "stale-decision", `Transcript evidence for ${decision.id} is missing or stale.`));
            continue;
          }
          relationships.push({
            id: `${decision.id}-transcript-evidence`,
            source: decision.selector,
            targetSlideId: slide.id,
            kind: "transcript-evidence",
            reason: decision.provenance.reason,
            provenance: decision.provenance,
            evidence: [decision.transcriptEvidence],
          });
        }
        slide.type = "video";
        slide.video = {
          youtubeId: slide.video?.youtubeId,
          archiveUrl: slide.video?.archiveUrl,
          captionsUrl: slide.video?.captionsUrl,
          transcriptUrl: slide.video?.transcriptUrl,
          chapterStatus: decision.chapterStatus,
          ...(decision.startSeconds === undefined ? {} : { startSeconds: decision.startSeconds }),
          ...(decision.endSeconds === undefined ? {} : { endSeconds: decision.endSeconds }),
          ...(decision.confidence === undefined ? {} : { confidence: decision.confidence }),
        };
      }
    }

    if (!issues.some((item) => item.decisionId === decision.id)) appliedDecisionIds.push(decision.id);
  }

  return { course, relationships, appliedDecisionIds, issues };
}

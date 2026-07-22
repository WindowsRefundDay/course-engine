import type { Course, CourseBlock } from "../../app/course-types.ts";

export type SourceNodeKind =
  | "page"
  | "heading"
  | "paragraph"
  | "list"
  | "equation"
  | "video"
  | "transcript"
  | "caption"
  | "pdf"
  | "pdf-page"
  | "table"
  | "diagram"
  | "figure"
  | "link"
  | "interactive"
  | "metadata";

export type SourceLocation = {
  sourcePath?: string;
  url?: string;
  page?: number;
  boundingBox?: { x: number; y: number; width: number; height: number };
};

export type SourceNode = {
  /** Immutable semantic identifier. It does not depend on a filename or offset. */
  id: string;
  contentHash: string;
  kind: SourceNodeKind;
  title?: string;
  text?: string;
  location?: SourceLocation;
  metadata?: Record<string, string | number | boolean | null>;
  /** Resource nodes marked true must be placed or explicitly excluded. */
  relationshipRequired?: boolean;
};

export type SourceEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: "contains" | "follows" | "references" | "derived-from" | "transcript-of" | "caption-of";
};

export type SourceGraph = {
  schemaVersion: 1;
  sourceFingerprint: string;
  nodes: SourceNode[];
  edges: SourceEdge[];
};

export type StableSourceSelector = {
  nodeId: string;
  contentHash: string;
};

export type DecisionProvenance = {
  author: string;
  origin: "automatic" | "ai" | "human";
  reason: string;
  confidence: number;
  createdAt?: string;
};

type DecisionBase = {
  id: string;
  selector: StableSourceSelector;
  provenance: DecisionProvenance;
};

export type CompilationDecision =
  | (DecisionBase & { operation: "rename-slide"; targetSlideId: string; title: string })
  | (DecisionBase & { operation: "exclude-slide"; targetSlideId: string })
  | (DecisionBase & { operation: "reorder-slides"; targetSectionId: string; orderedSlideIds: string[] })
  | (DecisionBase & { operation: "attach-source"; targetSlideId: string; relationshipId: string; relationshipKind: SourceRelationshipKind })
  | (DecisionBase & { operation: "pair-example"; problemSlideId: string; solutionSlideId: string; pairId: string })
  | (DecisionBase & {
      operation: "set-clip-range";
      targetSlideId: string;
      startSeconds?: number;
      endSeconds?: number;
      chapterStatus: "source" | "inferred" | "unavailable";
      transcriptEvidence?: StableSourceSelector;
      confidence?: number;
    });

export type SourceRelationshipKind =
  | "primary-source"
  | "illustrates"
  | "explains"
  | "worked-example-problem"
  | "worked-example-solution"
  | "transcript-evidence"
  | "supplemental"
  | "excluded";

export type SourceRelationship = {
  id: string;
  source: StableSourceSelector;
  targetSlideId?: string;
  kind: SourceRelationshipKind;
  reason: string;
  provenance: DecisionProvenance;
  evidence?: StableSourceSelector[];
};

export type GeneratedContentRecord = {
  id: string;
  targetSlideId: string;
  blocks: CourseBlock[];
  provenance: DecisionProvenance & { origin: "ai" };
  citations: StableSourceSelector[];
};

export type ValidationIssueCode =
  | "duplicate-source-node"
  | "stale-decision"
  | "ambiguous-decision"
  | "missing-target"
  | "invalid-order"
  | "orphaned-resource"
  | "unexplained-relationship"
  | "invalid-clip-range"
  | "unsupported-clip-range"
  | "invalid-example-pair"
  | "missing-generated-citation"
  | "invalid-generated-provenance"
  | "unsafe-source-link"
  | "invalid-course-structure";

export type ValidationIssue = {
  code: ValidationIssueCode;
  severity: "blocker" | "warning";
  message: string;
  decisionId?: string;
  nodeId?: string;
  slideId?: string;
};

export type CompilationFile = {
  schemaVersion: 1;
  courseSlug: string;
  sourceFingerprint?: string;
  decisions: CompilationDecision[];
  relationships: SourceRelationship[];
};

export type CompiledCourseArtifact = {
  schemaVersion: 1;
  sourceFingerprint: string;
  course: Course;
  decisions: CompilationDecision[];
  relationships: SourceRelationship[];
  generatedContent: GeneratedContentRecord[];
};

import { createHash } from "node:crypto";
import type { Course, CourseBlock, SourceReference } from "../../app/course-types.ts";
import type { DecisionProvenance, SourceRelationship } from "./types.ts";
import type { SourceEdge, SourceGraph, SourceNode, SourceNodeKind } from "./types.ts";

export type SourceNodeInput = Omit<SourceNode, "id" | "contentHash"> & {
  /** Adapter-provided semantic identity. Must not contain a path or page offset. */
  semanticKey?: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function contentPayload(input: SourceNodeInput): Record<string, unknown> {
  return {
    kind: input.kind,
    title: input.title,
    text: input.text,
    metadata: input.metadata,
  };
}

export function createSourceNode(input: SourceNodeInput): SourceNode {
  const hash = contentHash(contentPayload(input));
  const kind = input.kind.replace(/[^a-z0-9]+/gi, "-");
  const identityHash = input.semanticKey ? contentHash({ kind: input.kind, semanticKey: input.semanticKey }) : hash;
  const { semanticKey: _semanticKey, ...node } = input;
  void _semanticKey;
  return { ...node, id: `src-${kind}-${identityHash.slice(0, 24)}`, contentHash: hash };
}

export function createSourceGraph(inputs: SourceNodeInput[], edges: SourceEdge[] = []): SourceGraph {
  const nodes = inputs.map(createSourceNode).sort((left, right) => left.id.localeCompare(right.id));
  const normalizedEdges = [...edges].sort((left, right) => left.id.localeCompare(right.id));
  const sourceFingerprint = contentHash({
    nodes: nodes.map(({ id, contentHash: hash }) => ({ id, contentHash: hash })),
    edges: normalizedEdges,
  });
  return { schemaVersion: 1, sourceFingerprint, nodes, edges: normalizedEdges };
}

export function sourceKindsRequiringRelationships(): ReadonlySet<SourceNodeKind> {
  return new Set(["video", "pdf", "pdf-page", "table", "diagram", "figure", "interactive"]);
}

function referenceKind(reference: SourceReference): SourceNodeKind {
  if (reference.kind === "video") return "video";
  if (reference.kind === "document") return "pdf";
  if (reference.kind === "interactive") return "interactive";
  return "link";
}

function blockKind(block: CourseBlock): SourceNodeKind {
  if (block.type === "figure") return "figure";
  if (block.type === "list") return "list";
  return "paragraph";
}

const AUTOMATIC_PROVENANCE: DecisionProvenance = {
  author: "deterministic-course-adapter",
  origin: "automatic",
  reason: "The resource was explicitly embedded in this learner step by the source adapter.",
  confidence: 1,
};

/**
 * Materialize a canonical graph from an adapter-produced course. This keeps the
 * compiler boundary usable while older adapters are progressively moved to
 * emit SourceGraph nodes directly during extraction.
 */
export function createSourceGraphFromCourse(course: Course): {
  sourceGraph: SourceGraph;
  relationships: SourceRelationship[];
} {
  const inputByKey = new Map<string, SourceNodeInput>();
  const placements: Array<{ key: string; slideId: string }> = [];

  for (const unit of course.units) for (const lesson of unit.lessons) for (const section of lesson.sections) for (const slide of section.slides) {
    for (const reference of slide.sourceRefs) {
      const key = `resource:${reference.id}`;
      if (!inputByKey.has(key)) inputByKey.set(key, {
        semanticKey: key,
        kind: referenceKind(reference),
        title: reference.title,
        location: { url: reference.url ?? reference.archiveUrl },
        metadata: {
          referenceId: reference.id,
          youtubeId: reference.youtubeId ?? null,
          transcriptUrl: reference.transcriptUrl ?? null,
          captionsUrl: reference.captionsUrl ?? null,
        },
        relationshipRequired: ["video", "document", "interactive"].includes(reference.kind),
      });
      placements.push({ key, slideId: slide.id });
    }
    if (slide.video && !slide.sourceRefs.some((reference) => reference.kind === "video")) {
      const key = `video:${slide.id}`;
      inputByKey.set(key, {
        semanticKey: key,
        kind: "video",
        title: slide.title,
        location: { url: slide.video.archiveUrl },
        metadata: {
          youtubeId: slide.video.youtubeId ?? null,
          transcriptUrl: slide.video.transcriptUrl ?? null,
          captionsUrl: slide.video.captionsUrl ?? null,
          chapterStatus: slide.video.chapterStatus,
        },
        relationshipRequired: true,
      });
      placements.push({ key, slideId: slide.id });
    }
    slide.blocks.forEach((block, index) => {
      const key = `content:${slide.id}:${index}`;
      const text = block.type === "paragraph" ? block.text : block.type === "list" ? block.items.join("\n") : block.alt;
      inputByKey.set(key, {
        semanticKey: key,
        kind: blockKind(block),
        title: slide.title,
        text,
        ...(block.type === "figure" ? { location: { url: block.src }, relationshipRequired: true } : {}),
      });
      if (block.type === "figure") placements.push({ key, slideId: slide.id });
    });
  }

  const keyedNodes = [...inputByKey.entries()].map(([key, input]) => ({ key, node: createSourceNode(input) }));
  const sourceGraph = createSourceGraph([...inputByKey.values()]);
  const nodeByKey = new Map(keyedNodes.map(({ key, node }) => [key, node]));
  const relationships = placements.map((placement, index) => {
    const node = nodeByKey.get(placement.key)!;
    return {
      id: `automatic-placement-${index + 1}`,
      source: { nodeId: node.id, contentHash: node.contentHash },
      targetSlideId: placement.slideId,
      kind: "primary-source" as const,
      reason: AUTOMATIC_PROVENANCE.reason,
      provenance: AUTOMATIC_PROVENANCE,
    };
  });
  return { sourceGraph, relationships };
}

import type { CompilerStatus } from "../compiler-types";
import type { Course } from "../course-types";

const ENGINE_BASE = process.env.NEXT_PUBLIC_COURSE_ENGINE_URL ?? "http://127.0.0.1:8000";

type EngineDraft = {
  id: string;
  artifact_hash: string;
  status: string;
  created_at: string;
  validation?: { blocking_issues?: string[]; warnings?: string[] };
  artifact: Course;
};

type EngineVersion = { id: string; version: number; created_at: string };
type EnginePublished = { id: string; course_id: string; version: number; created_at: string; artifact: Course };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ENGINE_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(`Compiler engine returned ${response.status}`);
  return response.json() as Promise<T>;
}

export async function getCompilerStatus(selectedCourseId?: string): Promise<CompilerStatus> {
  const latest = selectedCourseId
    ? await request<EnginePublished>(`/courses/${encodeURIComponent(selectedCourseId)}/published`).catch(() => undefined)
    : await request<EnginePublished>("/published/latest");
  const courseId = selectedCourseId ?? latest?.course_id;
  if (!courseId) throw new Error("No course is available in the compiler engine");
  const [drafts, versions] = await Promise.all([
    request<EngineDraft[]>(`/courses/${encodeURIComponent(courseId)}/drafts`),
    request<EngineVersion[]>(`/courses/${encodeURIComponent(courseId)}/versions`),
  ]);
  const draft = drafts.find((item) => item.status === "draft");
  const prior = latest ? versions.filter((item) => item.version < latest.version && item.version > 1).at(-1) : undefined;
  const blockers = draft?.validation?.blocking_issues ?? [];
  const warnings = draft?.validation?.warnings ?? [];
  return {
    mode: "connected",
    courseSlug: courseId,
    sourceLabel: "Connected course engine",
    stages: [
      { id: "inventory", label: "Inventory", detail: "Source files fingerprinted", status: "complete" },
      { id: "extract", label: "Extract", detail: "Source graph normalized", status: "complete" },
      { id: "compile", label: "Compile", detail: draft ? "Reviewable draft available" : "No unpublished draft", status: draft ? "complete" : "pending" },
      { id: "validate", label: "Validate", detail: blockers.length ? `${blockers.length} blockers` : "Validation passing", status: blockers.length ? "blocked" : "complete" },
      { id: "publish", label: "Publish", detail: draft ? "Awaiting explicit review" : latest ? `Live version ${latest.version}` : "No reviewable draft", status: draft ? "pending" : latest ? "complete" : "blocked" },
    ],
    providers: [
      { id: "deterministic", label: "Deterministic compiler", detail: "Required · engine connected", state: "ready" },
      { id: "document-parser", label: "Document parser", detail: "Provider managed by engine", state: "ready" },
      { id: "compiler-ai", label: "Compiler AI", detail: "Optional optimization layer", state: "optional" },
      { id: "study-ai", label: "Study assistant", detail: "Separate learner service", state: "isolated" },
    ],
    issues: [
      ...blockers.map((detail, index) => ({ id: `engine-blocker-${index}`, severity: "blocker" as const, title: "Compiler validation blocker", detail })),
      ...warnings.map((detail, index) => ({ id: `engine-warning-${index}`, severity: "warning" as const, title: "Compiler validation warning", detail })),
    ],
    draft: draft ? { id: draft.id, label: "Reviewable compiler draft", createdAt: draft.created_at, courseHash: draft.artifact_hash } : undefined,
    live: latest ? { id: latest.id, label: `Published version ${latest.version}`, version: latest.version, createdAt: latest.created_at } : undefined,
    previewCourse: draft?.artifact,
    liveCourse: latest?.artifact,
    rollbackVersion: prior?.version,
    capabilities: { publish: Boolean(draft && !blockers.length), rollback: Boolean(prior), aiOptimize: false },
  };
}

export async function publishDraft(draftId: string, reviewedHash: string): Promise<void> {
  await request<EnginePublished>(`/drafts/${encodeURIComponent(draftId)}/publish`, {
    method: "POST",
    body: JSON.stringify({ reviewed_hash: reviewedHash }),
  });
}

export async function rollbackRevision(courseId: string, version: number): Promise<void> {
  await request<EnginePublished>(`/courses/${encodeURIComponent(courseId)}/rollback`, {
    method: "POST",
    body: JSON.stringify({ version }),
  });
}

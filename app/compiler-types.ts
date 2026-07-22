export type CompilerMode = "connected" | "local-demo" | "unavailable";

export type PipelineStageStatus = "complete" | "running" | "pending" | "blocked";

export type PipelineStage = {
  id: string;
  label: string;
  detail: string;
  status: PipelineStageStatus;
};

export type ValidationIssue = {
  id: string;
  severity: "blocker" | "warning" | "suggestion";
  title: string;
  detail: string;
  sourceId?: string;
};

export type CompilerProvider = {
  id: "deterministic" | "compiler-ai" | "study-ai" | "document-parser";
  label: string;
  detail: string;
  state: "ready" | "optional" | "missing" | "isolated";
};

export type CompilerRevision = {
  id: string;
  label: string;
  version?: number;
  createdAt?: string;
  courseHash?: string;
};

export type CompilerStatus = {
  mode: CompilerMode;
  courseSlug: string;
  sourceLabel: string;
  stages: PipelineStage[];
  providers: CompilerProvider[];
  issues: ValidationIssue[];
  draft?: CompilerRevision;
  live?: CompilerRevision;
  /** Exact immutable artifacts represented by the revision metadata above. */
  previewCourse?: Course;
  liveCourse?: Course;
  rollbackVersion?: number;
  capabilities: {
    publish: boolean;
    rollback: boolean;
    aiOptimize: boolean;
  };
};
import type { Course } from "./course-types";

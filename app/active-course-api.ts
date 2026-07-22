import type { Course } from "./course-types";

const ENGINE_BASE = process.env.NEXT_PUBLIC_COURSE_ENGINE_URL ?? "http://127.0.0.1:8000";
const STATIC_FALLBACK_ENABLED = process.env.NEXT_PUBLIC_COURSE_ENGINE_STATIC_FALLBACK === "1";
const STATIC_FALLBACK_PATH = process.env.NEXT_PUBLIC_COURSE_ENGINE_STATIC_FALLBACK_PATH ?? "/course-data/calculus.json";

export type ActiveCourse = {
  id: string;
  course_id: string;
  version: number;
  title: string;
  created_at: string;
  artifact: Course;
};

export type BootstrapStatus = {
  ready: boolean;
  course_id: string | null;
  version: number | null;
  title: string | null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ENGINE_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(`Engine returned ${response.status}`);
  return response.json() as Promise<T>;
}

export async function getLatestActiveCourse(): Promise<ActiveCourse | null> {
  return request<ActiveCourse>("/active").catch(() => null);
}

export async function getActiveCourse(courseId: string): Promise<ActiveCourse | null> {
  return request<ActiveCourse>(`/courses/${encodeURIComponent(courseId)}/active`).catch(() => null);
}

export async function getBootstrapStatus(): Promise<BootstrapStatus> {
  return request<BootstrapStatus>("/bootstrap/status").catch(() => ({ ready: false, course_id: null, version: null, title: null }));
}

export async function listActiveCourses(): Promise<Array<{ id: string; title: string; version: number }>> {
  return request<Array<{ id: string; title: string; version: number }>>("/courses/active").catch(() => []);
}

async function loadStaticFallback(): Promise<Course | null> {
  if (!STATIC_FALLBACK_ENABLED) return null;
  try {
    const response = await fetch(STATIC_FALLBACK_PATH);
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (payload && typeof payload === "object" && (payload as Partial<Course>).schemaVersion === 2 && Array.isArray((payload as Course).units)) {
      return payload as Course;
    }
  } catch {
    return null;
  }
  return null;
}

export async function loadLearnerCourse(): Promise<Course | null> {
  const active = await getLatestActiveCourse();
  if (active) {
    return active.artifact;
  }
  // Default behavior: do not silently load a static placeholder. Static-only
  // development must opt in via NEXT_PUBLIC_COURSE_ENGINE_STATIC_FALLBACK=1.
  return loadStaticFallback();
}

export function staticFallbackEnabled(): boolean {
  return STATIC_FALLBACK_ENABLED;
}

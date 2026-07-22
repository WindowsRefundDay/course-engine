"use client";

import Dexie, { type EntityTable } from "dexie";

export type LocalProfile = {
  id: string;
  name: string;
  color: string;
  createdAt: string;
};

export type LessonProgress = {
  id: string;
  profileId: string;
  courseId: string;
  lessonId: string;
  completed: boolean;
  updatedAt: string;
};

export type SlideProgress = {
  id: string;
  profileId: string;
  courseId: string;
  lessonId: string;
  slideId: string;
  viewed: boolean;
  updatedAt: string;
};

export type CourseState = {
  id: string;
  courseId: string;
  version: number;
  title: string;
  lastLessonId?: string;
  lastSectionId?: string;
  lastSlideId?: string;
  updatedAt: string;
};

const db = new Dexie("course-engine") as Dexie & {
  profiles: EntityTable<LocalProfile, "id">;
  progress: EntityTable<LessonProgress, "id">;
  slideProgress: EntityTable<SlideProgress, "id">;
  courseState: EntityTable<CourseState, "id">;
};

db.version(1).stores({ profiles: "id", progress: "id, profileId, lessonId" });
db.version(2).stores({
  profiles: "id",
  progress: "id, profileId, lessonId",
  slideProgress: "id, profileId, lessonId, slideId",
});
// v3 scopes all progress to a course identity and persists last location per course.
db.version(3).stores({
  profiles: "id",
  progress: "id, [profileId+courseId], lessonId",
  slideProgress: "id, [profileId+courseId], lessonId, slideId",
  courseState: "id, courseId",
}).upgrade(async (tx) => {
  const progress = await tx.table("progress").toArray();
  for (const row of progress) {
    if (!row.courseId) {
      await tx.table("progress").update(row.id, { courseId: "legacy" });
    }
  }
  const slideProgress = await tx.table("slideProgress").toArray();
  for (const row of slideProgress) {
    if (!row.courseId) {
      await tx.table("slideProgress").update(row.id, { courseId: "legacy" });
    }
  }
});

export { db };

export function progressId(profileId: string, courseId: string, lessonId: string) {
  return `${profileId}:${courseId}:${lessonId}`;
}

export function slideProgressId(profileId: string, courseId: string, lessonId: string, slideId: string) {
  return `${profileId}:${courseId}:${lessonId}:${slideId}`;
}

export function courseStateId(courseId: string) {
  return `active:${courseId}`;
}

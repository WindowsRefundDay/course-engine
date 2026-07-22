export type ResourceKind = "video" | "document" | "interactive" | "other";

export type SourceReference = {
  id: string;
  title: string;
  kind: ResourceKind;
  url?: string;
  archiveUrl?: string;
  youtubeId?: string;
  captionsUrl?: string;
  transcriptUrl?: string;
  description?: string;
  learningResourceTypes?: string[];
};

export type CourseBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "figure"; src: string; alt: string; caption?: string };

export type LessonSlide = {
  id: string;
  title: string;
  type: "article" | "video" | "problem" | "solution" | "document" | "interactive" | "assessment" | "other";
  blocks: CourseBlock[];
  sourceRefs: SourceReference[];
  required: boolean;
  pairId?: string;
  video?: {
    youtubeId?: string;
    archiveUrl?: string;
    captionsUrl?: string;
    transcriptUrl?: string;
    chapterStatus: "source" | "inferred" | "unavailable";
    startSeconds?: number;
    endSeconds?: number;
    confidence?: number;
  };
};

export type LessonSection = {
  id: string;
  title: string;
  kind: "overview" | "media" | "worked-example" | "practice" | "reading" | "interactive" | "assessment" | "other";
  slides: LessonSlide[];
};

export type CourseLesson = {
  id: string;
  title: string;
  unitTitle: string;
  partTitle: string;
  summary: string;
  overview: string;
  sections: LessonSection[];
};

export type CourseUnit = { id: string; title: string; lessons: CourseLesson[] };

export type Course = {
  schemaVersion: 2;
  title: string;
  code: string;
  term: string;
  description: string;
  units: CourseUnit[];
  source?: { adapter: string; root?: string; courseUrl?: string };
};

/**
 * Compile an MIT OCW static archive into the ordered lesson-flow contract used
 * by Course Engine. The archive is read-only; every rendered item keeps a
 * source reference so material cannot be detached from its original context.
 *
 * Run: node --experimental-strip-types scripts/ingest-ocw.ts [source] [output]
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Course, CourseBlock, LessonSection, LessonSlide, SourceReference } from "../app/course-types";

type JsonRecord = Record<string, unknown>;
type CourseLink = { label: string; href: string; sourcePath?: string };
type Resource = SourceReference & { sourcePath: string; learningResourceTypes: string[] };
type ParsedBlock =
  | { type: "heading"; level: 3 | 4; text: string }
  | { type: "paragraph"; text: string; links: CourseLink[] }
  | { type: "list"; items: Array<{ text: string; links: CourseLink[] }> }
  | { type: "video"; title: string; youtubeId?: string; archiveUrl?: string; captionsUrl?: string }
  | { type: "figure"; src: string; alt: string };

type OutlineLesson = { id: string; title: string; sourcePath: string };
type OutlineUnit = { id: string; title: string; parts: Array<{ id: string; title: string; lessons: OutlineLesson[] }> };

export type StarterCourseData = Course & {
  source: { adapter: "mit-ocw-static-archive"; root: string; courseUrl?: string };
};

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = resolve(ADAPTER_DIR, "..");
const DEFAULT_SOURCE_ROOT = resolve(ENGINE_DIR, "..");
const DEFAULT_OUTPUT = join(ENGINE_DIR, "public", "course-data", "calculus.json");

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`Expected a JSON object in ${path}`);
  return parsed;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => typeof item === "string" ? [item] : []) : [];
}

function stableId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "item";
}

function decodeHtml(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;|&#34;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'").replace(/&ndash;|&mdash;/gi, "-")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"');
}

function textFromHtml(input: string): string {
  return decodeHtml(input.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function attr(input: string, name: string): string | undefined {
  const match = input.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? decodeHtml(match[1]) : undefined;
}

function sourceRelative(sourceRoot: string, absolutePath: string): string {
  return relative(sourceRoot, absolutePath).split(sep).join("/");
}

function isWithin(root: string, candidate: string): boolean {
  return normalize(candidate).startsWith(normalize(`${root}${sep}`));
}

function publicUrl(file: string | undefined, courseUrl?: string): string | undefined {
  if (!file) return undefined;
  if (/^https?:\/\//i.test(file)) return file;
  if (file.startsWith("/")) return `https://ocw.mit.edu${file}`;
  return courseUrl ? new URL(file.replace(/^\.\//, ""), courseUrl).href : undefined;
}

async function discoverCourseUrl(sourceRoot: string): Promise<string | undefined> {
  try {
    const html = await readFile(join(sourceRoot, "index.html"), "utf8");
    const canonical = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1]
      ?? html.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i)?.[1];
    return canonical?.replace(/\/?$/, "/");
  } catch {
    return undefined;
  }
}

function extractLinks(html: string, pageDir: string, sourceRoot: string): CourseLink[] {
  const links: CourseLink[] = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (let match = anchor.exec(html); match; match = anchor.exec(html)) {
    const href = attr(match[1], "href");
    const label = textFromHtml(match[2]);
    if (!href || !label || href.startsWith("#") || /^javascript:/i.test(href)) continue;
    const absolute = href.startsWith("http") ? undefined : resolve(pageDir, href);
    links.push({ label, href, ...(absolute && isWithin(sourceRoot, absolute) ? { sourcePath: sourceRelative(sourceRoot, absolute) } : {}) });
  }
  return links;
}

function courseContent(html: string): string {
  const start = html.search(/<main\b[^>]*\bid=["']course-content-section["'][^>]*>/i);
  if (start < 0) throw new Error("Could not locate #course-content-section in session HTML");
  const contentStart = html.indexOf(">", start) + 1;
  const end = html.indexOf("</main>", contentStart);
  if (end < 0) throw new Error("Could not locate the end of #course-content-section");
  return html.slice(contentStart, end);
}

function normalizeResource(record: JsonRecord, sourcePath: string, courseUrl?: string): Resource {
  const resourceType = asString(record.resource_type)?.toLowerCase();
  const youtubeId = asString(record.youtube_key);
  const kind: Resource["kind"] = youtubeId || resourceType === "video" ? "video" : resourceType === "document" ? "document" : "other";
  return {
    id: stableId(sourcePath.replace(/\/data\.json$/, "")),
    title: asString(record.title) ?? sourcePath,
    kind,
    sourcePath,
    ...(publicUrl(asString(record.file), courseUrl) ? { url: publicUrl(asString(record.file), courseUrl) } : {}),
    ...(youtubeId ? { youtubeId } : {}),
    ...(asString(record.archive_url) ? { archiveUrl: asString(record.archive_url) } : {}),
    ...(publicUrl(asString(record.captions_file), courseUrl) ? { captionsUrl: publicUrl(asString(record.captions_file), courseUrl) } : {}),
    ...(publicUrl(asString(record.transcript_file), courseUrl) ? { transcriptUrl: publicUrl(asString(record.transcript_file), courseUrl) } : {}),
    ...(asString(record.description) ? { description: asString(record.description) } : {}),
    learningResourceTypes: asStringList(record.learning_resource_types),
  };
}

async function resourceFromLink(link: CourseLink, sourceRoot: string, courseUrl?: string): Promise<Resource | undefined> {
  if (!link.sourcePath?.startsWith("resources/") || !link.sourcePath.endsWith("/index.html")) return undefined;
  const resourcePath = join(sourceRoot, link.sourcePath.replace(/\/index\.html$/, "/data.json"));
  try {
    return normalizeResource(await readJson(resourcePath), sourceRelative(sourceRoot, resourcePath), courseUrl);
  } catch {
    return undefined;
  }
}

function parseBlocks(html: string, pageDir: string, sourceRoot: string, courseUrl?: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const content = courseContent(html);
  let currentVideoTitle = "Course video";
  const token = /<h([34])\b[^>]*>([\s\S]*?)<\/h\1>|<p\b[^>]*>([\s\S]*?)<\/p>|<ul\b[^>]*>([\s\S]*?)<\/ul>|<video\b([^>]*)>[\s\S]*?<\/video>|<img\b([^>]*)>/gi;
  for (let match = token.exec(content); match; match = token.exec(content)) {
    if (match[1]) {
      const text = textFromHtml(match[2]);
      if (text) {
        const level = Number(match[1]) as 3 | 4;
        if (level === 4) currentVideoTitle = text;
        blocks.push({ type: "heading", level, text });
      }
    } else if (match[3] !== undefined) {
      const text = textFromHtml(match[3]);
      if (text && !/^«\s*(previous|next)/i.test(text)) blocks.push({ type: "paragraph", text, links: extractLinks(match[3], pageDir, sourceRoot) });
    } else if (match[4] !== undefined) {
      const items = [...match[4].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
        .map((item) => ({ text: textFromHtml(item[1]), links: extractLinks(item[1], pageDir, sourceRoot) }))
        .filter((item) => item.text);
      if (items.length) blocks.push({ type: "list", items });
    } else if (match[5] !== undefined) {
      const youtubeId = match[0].match(/youtube\.com\/embed\/([\w-]+)/i)?.[1];
      const captions = match[0].match(/<track\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
      blocks.push({ type: "video", title: currentVideoTitle, ...(youtubeId ? { youtubeId } : {}), ...(attr(match[5], "data-downloadlink") ? { archiveUrl: attr(match[5], "data-downloadlink") } : {}), ...(captions ? { captionsUrl: publicUrl(decodeHtml(captions).replace(/^\.\.\/\.\.\/\.\.\/\.\.\//, ""), courseUrl) } : {}) });
    } else if (match[6] !== undefined) {
      const src = attr(match[6], "src");
      if (src) blocks.push({ type: "figure", src: publicUrl(src, courseUrl) ?? src, alt: attr(match[6], "alt") ?? "Source course figure" });
    }
  }
  return blocks;
}

function curriculumOrder(title: string): [number, number, string] {
  const part = title.match(/^Part\s+([A-Z])/i);
  if (part) return [-1, part[1].toUpperCase().charCodeAt(0), title];
  const session = title.match(/^Session\s+(\d+)/i);
  if (session) return [0, Number(session[1]), title];
  const problemSet = title.match(/^Problem Set\s+(\d+)/i);
  if (problemSet) return [1, Number(problemSet[1]), title];
  const exam = title.match(/^Exam\s+(\d+)/i);
  if (exam) return [2, Number(exam[1]), title];
  return [3, 0, title];
}

function compareCurriculumTitles(left: string, right: string): number {
  const a = curriculumOrder(left), b = curriculumOrder(right);
  return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2], undefined, { numeric: true });
}

async function readOutline(sourceRoot: string): Promise<OutlineUnit[]> {
  const units: OutlineUnit[] = [];
  const entries = await readdir(join(sourceRoot, "pages"), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    if (!entry.isDirectory() || !/^(\d+\.|unit-)/.test(entry.name)) continue;
    const unitDir = join(sourceRoot, "pages", entry.name);
    let unit: JsonRecord;
    try { unit = await readJson(join(unitDir, "data.json")); } catch { continue; }
    const parts: OutlineUnit["parts"] = [];
    for (const partEntry of await readdir(unitDir, { withFileTypes: true })) {
      if (!partEntry.isDirectory()) continue;
      const partDir = join(unitDir, partEntry.name);
      let part: JsonRecord;
      try { part = await readJson(join(partDir, "data.json")); } catch { continue; }
      const lessons = (await Promise.all((await readdir(partDir, { withFileTypes: true })).filter((candidate) => candidate.isDirectory()).map(async (candidate) => {
        const dataPath = join(partDir, candidate.name, "data.json");
        try {
          const lesson = await readJson(dataPath), title = asString(lesson.title);
          return title ? { id: stableId(sourceRelative(sourceRoot, dirname(dataPath))), title, sourcePath: sourceRelative(sourceRoot, dataPath) } : undefined;
        } catch { return undefined; }
      }))).filter((lesson): lesson is OutlineLesson => Boolean(lesson)).sort((a, b) => compareCurriculumTitles(a.title, b.title));
      if (lessons.length) parts.push({ id: stableId(sourceRelative(sourceRoot, partDir)), title: asString(part.title) ?? partEntry.name, lessons });
    }
    parts.sort((a, b) => compareCurriculumTitles(a.title, b.title));
    units.push({ id: stableId(sourceRelative(sourceRoot, unitDir)), title: asString(unit.title) ?? entry.name, parts });
  }
  return units;
}

function sectionKind(title: string): LessonSection["kind"] {
  const value = title.toLowerCase();
  if (value.includes("overview")) return "overview";
  if (value.includes("worked example")) return "worked-example";
  if (value.includes("mathlet") || value.includes("interactive")) return "interactive";
  if (value.includes("problem set")) return "practice";
  if (value.includes("exam")) return "assessment";
  if (value.includes("reading")) return "reading";
  if (value.includes("video")) return "media";
  return "other";
}

function lessonId(title: string, sourcePath: string): string {
  return title.match(/^Session\s+(\d+)/i)?.[1] ? `session-${title.match(/^Session\s+(\d+)/i)?.[1]}` : stableId(sourcePath);
}

function resourceSlide(resource: Resource, label: string, section: LessonSection, slideIndex: number): LessonSlide {
  const isVideo = resource.kind === "video";
  return {
    id: `${section.id}-${stableId(resource.sourcePath || label)}-${slideIndex}`,
    title: label || resource.title,
    type: isVideo ? "video" : "document",
    blocks: resource.description ? [{ type: "paragraph", text: resource.description }] : [],
    sourceRefs: [resource],
    required: true,
    ...(isVideo ? { video: { youtubeId: resource.youtubeId, archiveUrl: resource.archiveUrl, captionsUrl: resource.captionsUrl, transcriptUrl: resource.transcriptUrl, chapterStatus: "unavailable" } } : {}),
  };
}

function isProblem(slide: LessonSlide): boolean {
  const text = `${slide.title} ${slide.sourceRefs.map((source) => `${source.title} ${source.learningResourceTypes?.join(" ") ?? ""}`).join(" ")}`.toLowerCase();
  return /\b(problem|exercise|prb)\b/.test(text) && !/\b(solution|sol)\b/.test(text);
}

function isSolution(slide: LessonSlide): boolean {
  const text = `${slide.title} ${slide.sourceRefs.map((source) => `${source.title} ${source.learningResourceTypes?.join(" ") ?? ""}`).join(" ")}`.toLowerCase();
  return /\b(solution|solutions|sol)\b/.test(text);
}

function finaliseWorkedExamples(section: LessonSection) {
  if (section.kind !== "worked-example") return;
  for (let index = 0; index < section.slides.length; index += 1) {
    const slide = section.slides[index];
    if (isProblem(slide)) {
      slide.type = "problem";
      const solution = section.slides.slice(index + 1).find(isSolution);
      if (solution) {
        const pairId = `${section.id}-example-${index + 1}`;
        slide.pairId = pairId;
        solution.pairId = pairId;
        solution.type = "solution";
      }
    } else if (isSolution(slide)) slide.type = "solution";
  }
}

function buildSections(lesson: OutlineLesson, blocks: ParsedBlock[], resourcesByPath: Map<string, Resource>, courseUrl?: string): LessonSection[] {
  const sections: LessonSection[] = [];
  let current: LessonSection | undefined;
  let pendingSubheading: string | undefined;
  let anonymousIndex = 0;
  const ensure = () => {
    if (!current) {
      current = { id: `${lesson.id}-section-${sections.length + 1}`, title: "Lesson", kind: "other", slides: [] };
      sections.push(current);
    }
    return current;
  };
  const article = (title: string, block: CourseBlock) => {
    const section = ensure();
    const prior = section.slides.at(-1);
    if (prior?.type === "article" && prior.title === title) prior.blocks.push(block);
    else section.slides.push({ id: `${section.id}-slide-${++anonymousIndex}`, title, type: "article", blocks: [block], sourceRefs: [], required: true });
  };
  const externalSlide = (link: CourseLink) => {
    const section = ensure();
    const kind = section.kind === "interactive" ? "interactive" : "document";
    section.slides.push({ id: `${section.id}-${stableId(link.href)}`, title: link.label, type: kind, blocks: [], sourceRefs: [{ id: stableId(link.href), title: link.label, kind: kind === "interactive" ? "interactive" : "other", url: publicUrl(link.href, courseUrl) ?? link.href }], required: true });
  };
  for (const block of blocks) {
    if (block.type === "heading" && block.level === 3) {
      current = { id: `${lesson.id}-section-${sections.length + 1}-${stableId(block.text)}`, title: block.text, kind: sectionKind(block.text), slides: [] };
      sections.push(current); pendingSubheading = undefined; continue;
    }
    if (block.type === "heading") { pendingSubheading = block.text; continue; }
    const section = ensure();
    if (block.type === "video") {
      section.slides.push({ id: `${section.id}-video-${++anonymousIndex}`, title: pendingSubheading ?? block.title, type: "video", blocks: [], sourceRefs: [], required: true, video: { youtubeId: block.youtubeId, archiveUrl: block.archiveUrl, captionsUrl: block.captionsUrl, chapterStatus: "unavailable" } });
      pendingSubheading = undefined; continue;
    }
    if (block.type === "figure") { article(pendingSubheading ?? section.title, { type: "figure", src: block.src, alt: block.alt }); continue; }
    const links = block.type === "paragraph" ? block.links : block.items.flatMap((item) => item.links);
    const resources = links.map((link) => ({ link, resource: link.sourcePath ? resourcesByPath.get(link.sourcePath.replace(/\/index\.html$/, "/data.json")) : undefined }));
    const resourceLinks = resources.filter((entry): entry is { link: CourseLink; resource: Resource } => Boolean(entry.resource));
    if (resourceLinks.length) {
      for (const { link, resource } of resourceLinks) section.slides.push(resourceSlide(resource, link.label, section, section.slides.length + 1));
      const prose = block.type === "paragraph" ? block.text : block.items.filter((item) => !item.links.some((link) => resourceLinks.some((entry) => entry.link.href === link.href))).map((item) => item.text).join(" ");
      if (prose) article(pendingSubheading ?? section.title, block.type === "paragraph" ? { type: "paragraph", text: prose } : { type: "list", items: prose.split(" ") });
    } else {
      for (const link of links.filter((link) => /^https?:\/\//i.test(link.href) || link.href.includes("mathlet"))) externalSlide(link);
      if (block.type === "paragraph") article(pendingSubheading ?? section.title, { type: "paragraph", text: block.text });
      else article(pendingSubheading ?? section.title, { type: "list", items: block.items.map((item) => item.text) });
    }
    pendingSubheading = undefined;
  }
  for (const section of sections) finaliseWorkedExamples(section);
  return sections.filter((section) => section.slides.length);
}

async function parseLesson(lesson: OutlineLesson, sourceRoot: string, courseUrl?: string) {
  const indexPath = join(sourceRoot, lesson.sourcePath.replace(/data\.json$/, "index.html"));
  try {
    const html = await readFile(indexPath, "utf8");
    const blocks = parseBlocks(html, dirname(indexPath), sourceRoot, courseUrl);
    const links = blocks.flatMap((block) => block.type === "paragraph" ? block.links : block.type === "list" ? block.items.flatMap((item) => item.links) : []);
    const resources = (await Promise.all(links.map((link) => resourceFromLink(link, sourceRoot, courseUrl)))).filter((resource): resource is Resource => Boolean(resource));
    const byPath = new Map(resources.map((resource) => [resource.sourcePath, resource]));
    return buildSections(lesson, blocks, byPath, courseUrl);
  } catch {
    return [] as LessonSection[];
  }
}

function overviewFrom(sections: LessonSection[], title: string): string {
  const overview = sections.find((section) => section.kind === "overview")?.slides.flatMap((slide) => slide.blocks).find((block) => block.type === "paragraph");
  return overview?.type === "paragraph" ? overview.text : `${title} is included in the imported course structure.`;
}

function summary(text: string): string {
  const sentence = text.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? text;
  return sentence.length > 180 ? `${sentence.slice(0, 177).trimEnd()}...` : sentence;
}

export async function ingestOcwArchive(sourceRoot = DEFAULT_SOURCE_ROOT): Promise<StarterCourseData> {
  const source = resolve(sourceRoot);
  const [course, outline, courseUrl] = await Promise.all([readJson(join(source, "data.json")), readOutline(source), discoverCourseUrl(source)]);
  const units = await Promise.all(outline.map(async (unit) => ({
    id: unit.id,
    title: unit.title,
    lessons: await Promise.all(unit.parts.flatMap((part) => part.lessons).map(async (lesson) => {
      const sections = await parseLesson(lesson, source, courseUrl);
      const overview = overviewFrom(sections, lesson.title);
      return { id: lessonId(lesson.title, lesson.sourcePath), title: lesson.title.replace(/^Session\s+\d+:\s*/i, ""), unitTitle: unit.title, partTitle: unit.parts.find((part) => part.lessons.includes(lesson))?.title ?? "Course material", summary: summary(overview), overview, sections: sections.length ? sections : [{ id: `${lessonId(lesson.title, lesson.sourcePath)}-section-1`, title: "Lesson", kind: "other" as const, slides: [{ id: `${lessonId(lesson.title, lesson.sourcePath)}-slide-1`, title: lesson.title, type: "article" as const, blocks: [{ type: "paragraph" as const, text: overview }], sourceRefs: [], required: true }] }] };
    })),
  })));
  return {
    schemaVersion: 2,
    source: { adapter: "mit-ocw-static-archive", root: source, ...(courseUrl ? { courseUrl } : {}) },
    title: asString(course.course_title) ?? "Untitled course",
    code: asString(course.primary_course_number) ?? "Course",
    term: [asString(course.term), asString(course.year)].filter(Boolean).join(" "),
    description: asString(course.course_description)?.split("\n")[0] ?? "",
    units,
  };
}

export async function writeStarterCourseData(sourceRoot = DEFAULT_SOURCE_ROOT, outputPath = DEFAULT_OUTPUT) {
  const data = await ingestOcwArchive(sourceRoot);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return data;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeStarterCourseData(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_SOURCE_ROOT, process.argv[3] ? resolve(process.argv[3]) : DEFAULT_OUTPUT)
    .then((data) => console.log(`Wrote ${data.title} with ${data.units.length} units to ${process.argv[3] ? resolve(process.argv[3]) : DEFAULT_OUTPUT}`))
    .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}

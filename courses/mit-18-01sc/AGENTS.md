# Course customization guide

This folder is the safe extension point for the MIT 18.01SC course.

- The coding agent orchestrates compilation: run deterministic compiler tools
  first, then use the optional compiler-AI provider only when
  `course.setup.json` enables it. The provider proposes declarative decisions;
  it never replaces the compiler or publishes a course.
- Before compiling, run `course-engine setup courses/mit-18-01sc` from the
  repository root (or inspect the existing setup file). Ask only questions that
  remain missing or stale. Never request an API key in chat or persist a secret;
  use the provider-specific environment reference recorded by setup.
- Read `course.config.ts`, `public/course-data/calculus.json`, and representative source files before changing presentation.
- Treat schema-v2 lesson sections and slides as the rendering contract. Never restore a separate resource bucket: source links must stay with their instructional step.
- Preserve source order and provenance. Do not invent chapter timestamps, pair unrelated documents, or attach diagrams without an explicit source relationship.
- Keep the source archive at `../..` read-only.
- Theme the reader through the `COURSE THEME` token block at the top of `app/globals.css` (paper, surface, ink, line, accent, shadow, easing; light + dark values). Edit that block to re-theme; do not hardcode new colors in component styles.
- Put course-specific renderer overrides in this folder. Do not alter `services/engine` for a one-course visual change.
- Run `npm run course:ingest`, `npm run course:validate`, `npm run build`, `npm run lint`, and `npm run engine:doctor` before handing off work.
- Preserve the source attribution and CC BY-NC-SA license metadata. Do not represent AI-generated text or diagrams as source material.

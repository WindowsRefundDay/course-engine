# Design

## Source of truth

- Status: Active
- Primary surface: the ordered lesson reader
- Evidence reviewed: OCW lesson hierarchy, schema-v2 compiler, current reader

## Product goals

- Let a learner complete one clear instructional step at a time.
- Keep source descriptions, clips, examples, documents, figures, and interactives in their original instructional context.
- Make section and slide locations shareable and keyboard reachable.

## Information architecture

- Course navigation selects a lesson.
- The lesson rail exposes source sections as `01`, `02`, `03` and nested slides as `02.1`, `02.2`.
- The reader shows one slide, with Back and Next controlling visible progress.

## Design principles

- The source determines order; AI may enrich but never reauthor it.
- Do not use a separate material bucket.
- Prefer focus, readable measure, and clear movement over dashboard density.

## Components

- Existing: course syllabus, profile switcher, study companion.
- Changed: lesson section rail, slide stage, source-link list, problem/solution flow, per-slide progress.

## Accessibility

- Use semantic navigation and headings, visible focus styles, labeled controls, and keyboard-operable step movement.
- Preserve source attribution and meaningful figure alt text.

## Responsive behavior

- Desktop keeps course navigation, focused reader, and optional companion.
- Mobile uses drawers for navigation and companion while preserving the one-step flow.

## Implementation constraints

- React, CSS, Dexie, and Phosphor only; no new dependency.
- Schema validation must pass before published course JSON is replaced.

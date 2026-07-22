# Course Engine agent entrypoint

Before taking any action in this repository, read and follow the complete root
[`AGENTS.md`](./AGENTS.md). It is the single source of truth for automatic
course-source discovery, the one-command learner-first bootstrap, credential
safety, deterministic compilation, optional provider use, validation,
capability-appropriate QA, and local activation.

Do not replace that workflow with a generic coding plan. When the user asks to
set up or compile a course, execute the automatic `npm run course:start` workflow
in `AGENTS.md` and open the learner at `http://localhost:3003/`.

The compiler dashboard at `/compiler` is a developer-only diagnostic; it is not
part of the normal learner journey.

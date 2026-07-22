# OCW starter-data adapter

`ingest-ocw.ts` reads an OCW static archive and creates schema-v2 lesson flows.
It never writes to the archive itself: source headings become numbered sections,
and source links, clips, examples, and documents become ordered lesson steps.

From `course-engine`, run:

```sh
node --experimental-strip-types scripts/ingest-ocw.ts
```

The default output is `public/course-data/calculus.json`. Optional positional
arguments override the source archive root and output path, respectively. Run
`npm run course:validate` after ingest; it rejects empty sections, orphaned
slides, invalid video ranges, and unpaired solution steps.

The adapter preserves source order for every lesson. Shared lecture videos are
never given invented timestamps: transcript chapter timing remains unavailable
until a separate, validated enrichment step supplies it.

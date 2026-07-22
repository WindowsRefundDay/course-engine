export const courseConfig = {
  slug: "mit-18-02sc",
  source: "../../../../../18.02sc-fall-2010.zip",
  adapter: "mit-ocw-static-archive",
  title: "Multivariable Calculus",
  theme: {
    accent: "#2457d6",
    displayFont: "Georgia, serif",
    density: "academic",
  },
  capabilities: {
    studyAssistant: true,
    pdfComparison: true,
    localProfiles: true,
    generatedArtifactsRequireReview: true,
  },
} as const;

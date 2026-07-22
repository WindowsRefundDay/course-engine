export const courseConfig = {
  slug: "mit-18-01sc",
  source: "../../..",
  adapter: "mit-ocw-static-archive",
  title: "Single Variable Calculus",
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

import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Compiler Workspace | Course Engine",
  description: "Internal compiler diagnostics for development.",
};

export default async function CompilerPage() {
  const devtoolsEnabled = process.env.COURSE_ENGINE_DEVTOOLS === "1" || process.env.NODE_ENV === "development";
  if (!devtoolsEnabled) {
    notFound();
  }
  // Dynamic import keeps the compiler bundle out of the production learner build.
  const { CompilerWorkspace } = await import("./compiler-workspace");
  return <CompilerWorkspace />;
}

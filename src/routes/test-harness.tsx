import { createFileRoute } from "@tanstack/react-router";
import WordPackerTestHarness from "@/components/WordPackerTestHarness";

export const Route = createFileRoute("/test-harness")({
  component: WordPackerTestHarness,
});

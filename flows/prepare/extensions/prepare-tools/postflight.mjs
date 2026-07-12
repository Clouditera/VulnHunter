#!/usr/bin/env node
import { createJiti } from "jiti";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error("missing trusted input");
  return value;
};

try {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const { PrepareToolState } = await jiti.import("./index.ts");
  const result = PrepareToolState.postflightExisting({
    sourceRoot: required("PREPARE_SOURCE_ROOT"),
    controlDir: required("PREPARE_CONTROL_DIR"),
    outputDir: required("PREPARE_OUTPUT_DIR"),
    plannerInputPath: required("PREPARE_PLANNER_INPUT"),
    manifestSchemaPath: required("PREPARE_MANIFEST_SCHEMA"),
    planSchemaPath: required("PREPARE_PLAN_SCHEMA"),
  });
  process.stdout.write(JSON.stringify({ ok: true, plan_sha256: result.plan_sha256, counters: result.counters }) + "\n");
} catch {
  process.stdout.write('{"ok":false}\n');
  process.exitCode = 3;
}

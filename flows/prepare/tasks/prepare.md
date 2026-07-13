Inspect the current source repository quickly and write the final three-field JSON result to the exact output path in the stage prompt.

Rules:
- Do not compile, install dependencies, execute project code, scripts, or tests.
- A complete repository contains the core source and understandable project structure needed to implement its stated purpose.
- Tests, fixtures, documentation, patches, generated fragments, or overlays without the base project are incomplete.
- When dynamic validation is disabled, set `sandbox_type` to null.
- Do not write any other output file or add any other JSON field.

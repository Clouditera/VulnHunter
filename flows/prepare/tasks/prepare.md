Inspect the current source repository quickly and write the final three-field JSON result to the exact output path in the stage prompt.

Rules:
- Do not compile, install dependencies, execute project code, scripts, or tests.
- A complete repository contains the core source and understandable project structure needed to implement its stated purpose.
- Tests, fixtures, documentation, patches, generated fragments, or overlays without the base project are incomplete.
- When dynamic validation is disabled, set `sandbox_type` to null; do not call `list_sandbox_types` or `get_sandbox_type`.
- When dynamic validation is enabled and the project is complete, call `list_sandbox_types` before choosing `sandbox_type`; select KVM/QEMU > Docker > plain Linux by the project's primary run method (see agent instructions); if nothing available matches, set `sandbox_type` to null and `reason` to `no_compatible_sandbox`.
- Do not write any other output file or add any other JSON field.

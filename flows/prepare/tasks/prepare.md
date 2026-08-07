Inspect the current source repository quickly and write the final three-field JSON result to the exact output path in the stage prompt.

Rules:
- Do not compile, install dependencies, execute project code, scripts, or tests.
- A complete repository contains the core source and understandable project structure needed to implement its stated purpose — a unified, buildable/runnable whole (a single top-level build system or entry point; modules that compose one application or library).
- A complete project may be a web app, CLI tool, library, service, or a full intentional vulnerable-target application (e.g. VAmPI, DVWA) — as long as it is a self-contained functional whole.
- Incomplete sources: partial/missing core code (tests, fixtures, docs, patches, generated fragments, or overlays without the base project).
- Fragment collections are incomplete: a repository that is a loose set of independent example files, tutorial snippets, or practice exercises with no top-level unifying build and no single application or library identity. Set reason to `fragment_collection`.
- When dynamic validation is disabled, set `sandbox_type` to null; do not call `list_sandbox_types` or `get_sandbox_type`.
- When dynamic validation is enabled and the project is complete, call `list_sandbox_types` before choosing `sandbox_type`; select KVM/QEMU > Docker > plain Linux by the project's primary run method (see agent instructions); if nothing available matches, set `sandbox_type` to null and `reason` to `no_compatible_sandbox`.
- Do not write any other output file or add any other JSON field.

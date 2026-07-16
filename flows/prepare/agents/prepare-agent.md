# Prepare Agent

Quickly inspect the current directory's files, folders, build entry points, and core source files. Decide whether it is a normal, complete, self-contained source repository rather than partial source, tests, fixtures, documentation, patches, or overlay material without its base project.

Use only lightweight inspection such as `find`, `ls`, `git`, and `cat`. Do not compile, install dependencies, run project scripts, run tests, or execute source code.

Write exactly one JSON object to the requested `prepare-result.json`. It must contain only:

- `project_complete`: boolean
- `sandbox_type`: string or null
- `reason`: `complete`, `partial_source`, or `no_compatible_sandbox`

When dynamic validation is disabled, do not inspect or select sandbox types; `sandbox_type` must be null. An incomplete project must use `false / null / partial_source`.

## Sandbox type selection (dynamic validation enabled only)

When dynamic validation is enabled and the project is complete, call `list_sandbox_types` to see the currently available sandbox types and their `docker`/`kvm`/`qemu` capability flags, then choose according to the project's primary dynamic run method:

1. If the project must boot a full system, kernel, firmware image, or explicitly requires KVM/QEMU: choose an available type with both `kvm` and `qemu` true.
2. Otherwise, if the project's standard run method is the Docker daemon or Compose: choose an available type with `docker` true.
3. Otherwise: choose an available type with no special capability requirement (plain Linux).

A Dockerfile present alone does not require Docker; an optional VM test alone does not require KVM. Judge by the project's actual primary run method. If both Docker and KVM/QEMU are required, the chosen type must have both flags true; if no available type satisfies the requirement, set `sandbox_type` to null and `reason` to `no_compatible_sandbox`. Only choose a `profile_id` that `list_sandbox_types` (or `get_sandbox_type`) actually returned as `available: true` this run.

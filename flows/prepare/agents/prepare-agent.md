# Prepare Agent

Quickly inspect the current directory's files, folders, build entry points, and core source files. Decide whether it is a normal, complete, self-contained source repository rather than partial source, tests, fixtures, documentation, patches, or overlay material without its base project.

Use only lightweight inspection such as `find`, `ls`, `git`, and `cat`. Do not compile, install dependencies, run project scripts, run tests, or execute source code.

Write exactly one JSON object to the requested `prepare-result.json`. It must contain only:

- `project_complete`: boolean
- `sandbox_type`: string or null
- `reason`: `complete`, `partial_source`, or `no_compatible_sandbox`

When dynamic validation is disabled, do not inspect or select sandbox types; `sandbox_type` must be null. An incomplete project must use `false / null / partial_source`.

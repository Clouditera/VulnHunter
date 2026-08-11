Inspect the current source repository quickly and write the final three-field JSON result to the exact output path in the stage prompt.

Rules:
- Do not compile, install dependencies, execute project code, scripts, or tests.

## Step 1 — Determine the project's real purpose (read README / top-level docs first)

Ask: **Is this project a real production application or library, or is it demonstration / marketing / teaching material?**

- Read the top-level README and documentation to find a **stated purpose** — what application it is or what library it provides, what real-world problem it solves.
- If the README declares a real production purpose (a web app, a CLI tool, a reusable library, a service, or a complete runnable vulnerable-target application like VAmPI / DVWA) → proceed to Step 2 (structural completeness).
- If the purpose is **missing, vague/generic, or self-declared as demo / demonstration / showcase / tutorial / marketing** → go to Step 1b.

## Step 1b — Confirm fragment collection (check sub-directory content)

When the top-level purpose is not a real production app/library:
- Inspect the sub-directories' content nature: are they **functional demonstrations, usage examples, calling samples, tutorials, or practice exercises**?
- If yes → this is a **fragment collection**. Set `project_complete: false` and `reason: "fragment_collection"`. Do not proceed further.

Examples of fragment collections: a repo whose top-level is a thin lint config / packaging wrapper, but all real content lives in `demo/`, `examples/`, `tutorial/`, `finetune/`, `inference/` directories that are independent showcase snippets with no single unified application or library identity.

## Step 2 — Self-contained auditable whole (only when the purpose is a real app/library)

A target is **complete** if its content constitutes a **self-contained, coherent
auditable whole** — regardless of packaging form (source repo, deployment
directory, compiled artifacts, firmware, appliance console, etc.).

Check for the presence of **three elements** that together form a connected structure:

1. **Recognizable entry points / routing** — URL paths, CLI commands, web.xml
   routes, main() functions, message handlers, or equivalent dispatch structure.
2. **Business logic** — source code OR compiled artifacts (JSP, .class, .pyc,
   binaries) that implement the application's behavior.
3. **Configuration / dependencies** — web.xml, package.json, requirements.txt,
   pom.xml, Dockerfile, config files, or equivalent wiring that defines how
   the application is assembled and configured.

When all three are present and form a coherent structure → **complete**, even
if there is no README, no build system, or no `.java`/source files (e.g. a
Tomcat `webapps/` directory with JSP + web.xml + compiled classes is complete).

**Incomplete** sources: only tests, only documentation, only patches, only
generated fragments, or overlays without the base application they extend —
the three elements above do not form a coherent whole. Set `project_complete:
false` and `reason: "partial_source"`.

## Exemption — intentional vulnerable targets

A project whose **purpose is explicitly a vulnerable demonstration target** AND which is itself a **complete runnable application** (e.g. VAmPI, DVWA) is **complete** — it has real audit value. Only loose example/tutorial snippets are fragment collections.

## Sandbox selection

- When dynamic validation is disabled, set `sandbox_type` to null; do not call `list_sandbox_types` or `get_sandbox_type`.
- When dynamic validation is enabled and the project is complete, call `list_sandbox_types` before choosing `sandbox_type`; select KVM/QEMU > Docker > plain Linux by the project's primary run method (see agent instructions); if nothing available matches, set `sandbox_type` to null and `reason` to `no_compatible_sandbox`.

## Output

Write the final result JSON to ${flow_inputs.result_path} — nothing else, no other files.

Example (complete project):
```
{
  "project_complete": true,
  "sandbox_type": "linux-docker",
  "reason": "complete"
}
```

Incomplete → `project_complete: false`, `sandbox_type: null`, `reason: "partial_source"` | `"fragment_collection"` | `"no_compatible_sandbox"`.

Do NOT self-validate the schema with node/python — just write the file.

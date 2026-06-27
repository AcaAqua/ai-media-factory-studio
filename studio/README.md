# AI Media Factory Studio v0.1.7

Local-first control surface for ComfyUI, Ollama, workflow registration, generation history, and media management.

Designed & developed by LuckyFields LLC. Licensed under Apache License 2.0.

## Start

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start_studio.ps1
```

Then open:

```text
http://127.0.0.1:8765
```

## Scope

- Creates a local SQLite DB at `studio/data/media_factory.sqlite3`.
- Reads workflow JSON files under `workflows/`.
- Registers selected workflow files into the Studio DB.
- Stores prompt, negative prompt, parameters, and generation job history.
- Stores per-workflow input mappings for prompt, seed, size, sampler, scheduler, checkpoint, and output prefix.
- Sends a copied, prepared workflow payload to ComfyUI `/prompt` with a job-unique output prefix without rewriting the original workflow file.
- Polls ComfyUI history for Studio-submitted jobs and reference-registers image outputs.
- Shows imported images in the library with a detail drawer for status, rating, tags, notes, prompt, and regenerate actions.
- Saves reusable recipes from generated images and can apply them back to the generation form.
- Searches and filters the media library by keyword, status, rating, tags, workflow, recipe, period, and content scope.
- Compares 2 to 8 images, updates comparison notes, and stores comparison sets.
- Edits saved recipes, supports overwrite confirmation, and can duplicate a recipe as a new version record.
- Manages storage locations by content scope and usage type, including Adult Local storage status and write checks.
- Shows a dedicated approved asset board for reuse and export-candidate marking.
- Reopens saved comparison sets and applies recipes through an in-app selection dialog.
- Validates Adult Local storage against the configured ComfyUI output root before real submission.
- Writes scope-safe output prefixes such as `sensitive/...` and `adult_local/...` only into copied execution payloads.
- Shows short local-first, third-party responsibility, license, and Adult Local scope notices without blocking routine generation.
- Checks local ComfyUI, Ollama, and Git status.

## Safety

- Existing ComfyUI files, models, generated outputs, and workflow JSON files are not moved or deleted.
- Prompt injection into arbitrary workflow nodes is controlled by explicit saved mappings.
- Adult Local mode is visible as an explicit mode but does not change guard sets automatically yet.
- ComfyUI output files are reference-registered in place; only Studio thumbnails are written under `studio/thumbnails/`.
- User-entered output prefixes are retained in job parameters for traceability, but ComfyUI receives the Studio-generated unique prefix.
- Adult Local submissions are blocked when no dedicated Adult Local storage location is configured, disabled, not writable, or outside the ComfyUI output root.
- Git initialization, remote setup, commit, and push are intentionally not performed by Studio setup.
- ComfyUI, Ollama, custom nodes, models, LoRA files, workflows, and generated assets are not bundled and remain the user's responsibility to license and manage.

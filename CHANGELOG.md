# Changelog

## v0.2.0-dev - Unreleased

- Added local setup status API and Settings panel for launcher, database, storage, and asset registry readiness.
- Added first-run setup checklist with required/optional readiness steps and persistent complete/dismiss controls.
- Added manual SQLite database backup action from the Settings screen.
- Added guarded database backup listing and restore UI with pre-restore backup creation and explicit confirmation.
- Added Civitai safe download flow with target location selection, explicit `DOWNLOAD` confirmation, no-overwrite saving, SHA256 verification when available, and automatic asset registry registration as `needs_review`.
- Added post-download asset registry refresh, recent asset highlighting, detail review shortcut, and Workflow required asset resync.
- Added background Civitai download jobs with progress polling and cancellation.
- Improved `scripts/start_studio.ps1` to reuse an already running Studio server or start it in the background and open the browser.

## v0.1.9 - 2026-06-27

- Added initial Studio asset registry tables for model, LoRA, VAE, ControlNet, upscaler, and workflow locations.
- Added non-destructive asset scanning that records file metadata without moving or deleting source files.
- Added Studio asset registry panel and rescan action to the Models view.
- Added asset registry metadata editing for source URL, license, creator, base model, status, and notes.
- Added Civitai metadata apply action for asset registry items.
- Added Workflow required asset scan and missing/matched diagnostics.
- Improved Civitai asset candidate matching by type, hash, filename, and existing source URL.
- Expanded Workflow asset detection for common VAE, ControlNet, LoRA, Upscaler, UNet, and diffusion model loader variants.

## v0.1.8 - 2026-06-27

- Added local dictionary-based Japanese Prompt to English tag Prompt conversion.
- Added Prompt translation terms, presets, and history tables.
- Added Prompt translation API endpoints for conversion, dictionary editing, presets, and history.
- Added Prompt translation panel, dictionary editor, history viewer, and manual apply action for generation prompts.
- Updated About screen version to `v0.1.8`.

## v0.1.7 - 2026-06-27

- Added diagnostics API and diagnostics panel.
- Added job resync endpoint and UI action.
- Surfaced connection, database, job, storage, mapping, and Adult Local risks.
- Added local UI shutdown action for the Studio server.
- Added a public roadmap for external ComfyUI/Ollama integration and Studio-managed asset registry direction.
- Added Civitai URL metadata lookup and preview.
- Added local-only Civitai API key save/delete/test controls.
- Updated About screen version to `v0.1.7`.

## v0.1.6 - 2026-06-27

- Adopted Apache License 2.0.
- Added `NOTICE` and moved the earlier license discussion to `docs/license-decision.md`.
- Strengthened README notices for third-party software, models, generated content rights, local data handling, and Adult Local scopes.
- Added third-party, asset responsibility, and Adult Local scope documentation.
- Updated product wording to `AI Media Factory Studio - Designed & developed by LuckyFields LLC`.

## v0.1.5 - 2026-06-27

- Documented Git recovery status and public repository preparation.
- Added public repository safety files and documentation.
- Added DB fields for scope-aware output validation.
- Added Adult Local output-prefix safety checks for ComfyUI submissions.
- Added storage UI labels for ComfyUI output-root compatibility.

## v0.1.4 - 2026-06-27

- Added Adult Local storage UI.
- Added content-scope library tabs.
- Added production board for approved assets.
- Added recipe apply dialog.
- Added comparison set list, reload, duplicate, and archive controls.

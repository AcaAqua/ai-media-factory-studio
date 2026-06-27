# Roadmap

AI Media Factory Studio is moving toward a distributable local-first Studio application.

## Product Boundary

AI Media Factory Studio should become the application layer that manages local creative AI operations.

The Studio should manage:

- Studio launcher and local server lifecycle
- Studio database and backups
- Workflow registration and mapping metadata
- Generation history and output references
- Image, video, reference, recipe, and production-board records
- Model and LoRA metadata
- Storage locations and content scopes
- Diagnostics, resync, import, export, and recovery tools

ComfyUI and Ollama remain external integrations. Users install, update, and operate them separately. Studio connects to them through local endpoints and should provide diagnostics and setup guidance.

Model, LoRA, VAE, ControlNet, embedding, and upscaler files should not be bundled in the public source repository by default. Studio should provide a logical asset registry and optional standard folders, while also allowing existing external folders to remain in place.

The preferred model is a Studio-managed registry, not forced file relocation. Studio should be able to manage:

- Studio database records
- Studio standard storage locations for newly added files
- Existing ComfyUI model folders
- Existing local model folders
- NAS or shared model folders
- Future external SSD folders

Studio should scan registered locations, record metadata, and help users understand status without moving files unless the user explicitly chooses an import/copy action.

## Planned Managed Location Model

Future portable builds should separate public source from local runtime data, while supporting both Studio-standard locations and externally registered locations:

```text
AI-Media-Factory/
  studio/
  studio_data/
    media_factory.sqlite3
    thumbnails/
    exports/
    backups/
  library/
    images/
    videos/
    references/
  workflows/
    user/
    samples/
    archived/
  models/
    checkpoints/
    loras/
    vae/
    controlnet/
    embeddings/
    upscale_models/
  recipes/
  logs/
```

These folders are local runtime assets, not public repository content. They are defaults, not mandatory destinations. Existing ComfyUI, NAS, or external SSD folders should be registrable as external managed locations.

## Version Direction

### v0.1.7 - Operations Stabilization

Focus on reliability, visibility, and maintainability of existing features.

- Diagnostics API and diagnostics panel
- Job resync endpoint and manual UI action
- Connection, database, job, storage, mapping, and Adult Local risk visibility
- UI shutdown action for local server lifecycle
- Startup shortcut and launcher improvements
- Error visibility improvements
- No major DB redesign
- No model or LoRA file movement
- No ComfyUI or Ollama bundling

### v0.1.8 - Studio Asset Registry Foundation

Introduce Studio-managed asset registry foundations without bundling or forcibly moving third-party model files.

- Define Studio-managed logical locations and optional standard folders
- Register and scan storage locations
- Add model, LoRA, and workflow registry tables after migration review
- Add Civitai URL lookup and metadata preview
- Prepare confirmed download flow for Civitai assets
- Track Checkpoint, LoRA, VAE, ControlNet, Upscaler, embedding, and workflow records by purpose
- Scan Studio-standard folders and registered external folders
- Track source URL, license memo, checksum, file size, and user notes
- Track author, usage purpose, compatible base model, and review status
- Mark unknown or unreviewed files clearly
- Detect unregistered or unreviewed files
- Keep file movement manual or opt-in

### v0.1.9 - Practical ComfyUI Integration

Make ComfyUI integration practical by connecting workflows to the asset registry.

- ComfyUI endpoint setup and health diagnostics
- Ollama endpoint setup and model diagnostics
- Workflow dependency checks
- Missing model or LoRA warnings before generation
- Model and LoRA selection UI
- Workflow-to-asset linking
- External ComfyUI folder sync and rescan
- Duplicate, missing, disconnected, and broken reference diagnostics
- Safer mapping test workflow
- Clear setup and recovery guidance

### v0.2.0 - Distributable Local App

Prepare a portable Windows application shape.

- Studio launcher executable
- Browser auto-open
- UI shutdown and optional stop shortcut
- First setup wizard
- ComfyUI and Ollama connection setup
- Backup, export, and import tools
- Settings export and import
- Portable package layout
- Clear boundary for external ComfyUI, Ollama, and user-managed model files

## Non-Goals for Public Source Distribution

- Bundling ComfyUI
- Bundling Ollama
- Bundling model, LoRA, checkpoint, or generated media files
- Publishing user DB files
- Publishing private workflows
- Publishing local absolute-path configuration

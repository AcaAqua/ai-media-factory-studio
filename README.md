# AI Media Factory Studio

Designed & developed by LuckyFields LLC

AI Media Factory Studio is a local-first creative control center for ComfyUI and Ollama environments. It helps manage workflows, prompts, recipes, generated assets, storage locations, generation history, comparison sets, and local production operations.

## License

AI Media Factory Studio is licensed under the Apache License, Version 2.0. See `LICENSE` and `NOTICE`.

Copyright 2026 LuckyFields LLC.

## What This Project Does

- Provides a local web UI for Studio-managed generation operations.
- Sends copied, mapped workflow payloads to an existing ComfyUI `/prompt` endpoint.
- Checks local Ollama connectivity for prompt-assist workflows.
- Stores local workflow mappings, prompts, recipes, generated asset records, comparison sets, and production board metadata.
- Tracks content scopes such as `general`, `sensitive`, and `adult_local` for local organization and storage separation.
- Uses scope-safe output prefixes for ComfyUI submissions when mappings are configured.

## What This Project Does Not Include

This repository does not include ComfyUI, Ollama, model files, LoRA files, VAE files, ControlNet files, generated images, generated videos, personal databases, API keys, or private settings.

Users install and manage third-party tools, models, custom nodes, and workflows separately.

## Local-First Data Handling

Generated assets, prompts, recipes, thumbnails, and database records are designed to remain local unless the user explicitly connects external services or exports data.

Local/private data excluded from the public repository includes:

- SQLite databases
- backups
- thumbnails
- generated images and videos
- reference assets
- model and LoRA folders
- API keys, tokens, secrets, and local config

## Third-Party Software and Model Notice

ComfyUI, Ollama, custom nodes, model files, LoRA files, workflows, and external services may have independent licenses, terms of service, and content restrictions.

Users are responsible for reviewing and complying with the terms that apply to each component they install, import, connect, or use.

## Generated Content and Rights Notice

Generated outputs may be subject to third-party rights, model license conditions, platform terms, or local laws.

AI Media Factory Studio does not determine ownership, copyright status, commercial usability, legal compliance, or platform compliance of imported or generated assets.

This project is not legal advice and does not replace copyright, licensing, or terms-of-service review.

## Adult Local / Content Scope Notice

The application supports local content scopes such as `general`, `sensitive`, and `adult_local` for organizational and storage separation.

These scopes are user-managed labels and storage controls. They do not constitute legal classification, legal advice, age verification, or automated content compliance determination.

Adult Local output submission is blocked unless the configured storage can be safely represented as a relative ComfyUI output prefix under the configured ComfyUI output root.

## Security and Privacy

The application is designed for local-first use. Review firewall rules and network exposure before binding Studio or ComfyUI to non-localhost addresses.

Do not commit or publish local DB files, generated media, reference assets, model files, LoRA files, personal prompts, API keys, tokens, `.env` files, or private configuration.

See `SECURITY.md` and `docs/privacy-and-local-data.md`.

## Requirements

- Windows with PowerShell
- Python 3.10+
- A separately installed ComfyUI instance
- Optional: Ollama for local prompt assistance

## Start

Recommended local launcher:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start_studio.ps1
```

The launcher reuses an already running local Studio server when possible. If Studio is not running, it starts the server on `127.0.0.1:8765` and opens the browser.

Manual server start:

```powershell
python studio\server.py
```

Open:

```text
http://127.0.0.1:8765/
```

## First Setup

1. Start ComfyUI separately.
2. Open Studio.
3. Confirm ComfyUI and Ollama connection status in Settings.
4. Review the Local Setup checklist in Settings.
5. Complete or dismiss the setup checklist when the required local checks are ready.
6. Create a manual DB backup from Settings before larger operational changes.
7. Use the guarded DB restore dialog only when you intentionally want to replace the current local database with a selected backup.
8. Register or scan workflows.
9. Open Workflow input mapping and save mappings before real generation.
10. Configure Adult Local storage only if the directory is inside the ComfyUI output root.

## Civitai Metadata and Safe Download

Studio can look up Civitai metadata and prepare a local download safety plan. The plan checks the selected file metadata, target asset registry locations, overwrite risk, Civitai scan results, and required user confirmations.

After reviewing the plan, users can choose a registered asset location and type `DOWNLOAD` to download the selected file. Studio refuses to overwrite existing files, verifies SHA256 when Civitai metadata provides it, and registers the saved file in the asset registry as `needs_review`.

Users are still responsible for reviewing license terms, model safety, and local placement before using third-party assets.

## Roadmap

See `docs/roadmap.md` for the local app roadmap. The current direction keeps ComfyUI and Ollama as external integrations while moving models, LoRA files, workflows, and other assets toward a Studio-managed registry that can scan both Studio-standard folders and existing external folders without forced file relocation.

## Public Repository Boundary

Intended public source:

- `studio/server.py`
- `studio/static/`
- `studio/data/migrations/`
- `scripts/start_studio.ps1`
- `docs/`
- `config/studio.example.json`
- `sample-workflows/`
- project metadata such as README, changelog, license, notice, security notes, and contribution notes

Excluded local/private data:

- SQLite DB files
- backups
- thumbnails
- generated images and references
- models, LoRA, checkpoints, VAE, ControlNet, upscale models
- API keys, tokens, secrets, and local config

## Support and Issue Reporting

Public issue reporting should be enabled only after the first public repository setup is complete and private local data has been excluded. When reporting issues, do not attach databases, generated images, private prompts, API keys, model files, or client materials.

## Known Constraints

- ComfyUI and Ollama are external local services and must be installed and started separately.
- The launcher is a PowerShell helper, not a signed packaged installer.
- DB restore is local-only and intentionally requires explicit confirmation text.
- Civitai downloads are user-confirmed only and do not decide license or usage compatibility automatically.
- Video import is reserved for a future version.
- This project controls Studio only; it does not redistribute ComfyUI, models, custom nodes, or third-party checkpoints.

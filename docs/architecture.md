# Architecture

AI Media Factory Studio is a small local web app.

Designed & developed by LuckyFields LLC.

## Components

- `studio/server.py`: HTTP API, SQLite access, ComfyUI/Ollama checks, workflow payload preparation, job polling, and media import.
- `studio/static/`: browser UI.
- `studio/data/migrations/`: schema migrations. These are public source.
- `studio/data/media_factory.sqlite3`: local runtime DB. This is private and ignored.
- `studio/thumbnails/`: local generated thumbnails. This is private and ignored.
- `workflows/`: local workflow source files. Public release should include only safe samples.

## Generation Flow

1. User enters prompt and generation settings.
2. Studio loads the selected workflow JSON.
3. Studio copies the workflow JSON in memory.
4. Saved workflow mappings write values into the copy.
5. Studio resolves a scope-safe `filename_prefix`.
6. Studio sends the copied payload to ComfyUI `/prompt`.
7. Studio tracks `prompt_id` and imports only outputs from submitted jobs.

Original workflow files are not modified by this flow.

## Third-Party Boundary

ComfyUI, Ollama, custom nodes, models, LoRA files, VAE files, ControlNet files, upscalers, external workflows, and generated assets are outside the Studio source distribution unless explicitly stated. Users are responsible for reviewing the terms that apply to those materials.

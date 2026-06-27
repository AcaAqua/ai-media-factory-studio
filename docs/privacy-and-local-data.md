# Privacy and Local Data

Studio is intended to keep creative work local.

AI Media Factory Studio is designed & developed by LuckyFields LLC.

## Private Data

The following should not be committed or published:

- `studio/data/media_factory.sqlite3`
- `studio/data/backups/`
- `studio/thumbnails/`
- `output/`
- `storage/`
- `references/`
- model and LoRA folders
- local config and secrets

## Adult Local

Adult Local assets are intentionally separated from normal output handling. Real ComfyUI submission is blocked unless the configured Adult Local storage is under the ComfyUI output root and can be represented as a safe relative `filename_prefix`.

Content scopes are user-managed labels and storage controls. They are not legal classification, legal advice, age verification, or automated compliance decisions.

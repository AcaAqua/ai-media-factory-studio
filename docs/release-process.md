# Release Process

AI Media Factory Studio  
Designed & developed by LuckyFields LLC

## Before First Public Release

1. Confirm Git recovery conclusion.
2. Confirm Apache-2.0 `LICENSE` and `NOTICE`.
3. Review `.gitignore`.
4. Run a secret scan.
5. Confirm no DB, generated images, models, LoRA, or local config are staged.
6. Confirm sample workflows contain no private paths or client data.
7. Run syntax and startup checks.

## License

The project uses Apache License 2.0. See `LICENSE`, `NOTICE`, and `docs/license-decision.md`.

## Publication Boundary

Do not publish local DB files, generated media, thumbnails, backups, models, LoRA files, API keys, `.env` files, personal prompts, Adult Local assets, or private settings.

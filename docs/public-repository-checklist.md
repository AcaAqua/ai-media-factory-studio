# Public Repository Checklist

## Required Checks

- [ ] `LICENSE` is Apache-2.0.
- [ ] `NOTICE` exists.
- [ ] `README.md` includes LuckyFields LLC.
- [ ] `README.md` states that ComfyUI, Ollama, models, LoRA, VAE, ControlNet, generated media, DB files, API keys, and private settings are not bundled.
- [ ] `README.md` explains local-first data handling.
- [ ] `README.md` explains the responsibility boundary for third-party assets and generated content.
- [ ] `.gitignore` excludes DB files, generated media, models, LoRA, secrets, and local config.
- [ ] SQLite DB files are not staged.
- [ ] `output/`, `storage/`, and `references/` are not staged.
- [ ] API keys, tokens, passwords, private keys, and private URLs are not included.
- [ ] Real images, real videos, and personal prompts are not included.
- [ ] Adult Local assets and storage records are not included.
- [ ] Sample config does not include secrets or user-specific real paths.
- [ ] Local absolute paths in `docs/` have been reviewed before public release.
- [ ] `CHANGELOG.md` is updated.
- [ ] `SECURITY.md` exists.

## Do Not Publish

- [ ] `studio/data/media_factory.sqlite3`
- [ ] `studio/data/backups/`
- [ ] `studio/thumbnails/`
- [ ] `output/`
- [ ] `storage/`
- [ ] `references/`
- [ ] `models/`
- [ ] `loras/`
- [ ] `checkpoints/`
- [ ] `.env` and secret files
- [ ] local ComfyUI checkout

## Publish Candidates

- [ ] `studio/server.py`
- [ ] `studio/static/`
- [ ] `studio/data/migrations/`
- [ ] `scripts/start_studio.ps1`
- [ ] `docs/`
- [ ] `config/studio.example.json`
- [ ] `.gitignore`
- [ ] `README.md`
- [ ] `CHANGELOG.md`
- [ ] `SECURITY.md`
- [ ] `CONTRIBUTING.md`
- [ ] `LICENSE`
- [ ] `NOTICE`

## Git Decision

Current classification: C. The root `.git` directory exists but does not contain the files needed to recover a valid repository. New public repository initialization is likely the practical next step, after owner approval.

## Future Git Verification Commands

Run these only after the user approves new repository initialization:

```powershell
git status
git add --dry-run .
git check-ignore -v studio/data/media_factory.sqlite3
git check-ignore -v output/
git check-ignore -v storage/
git diff --cached
```

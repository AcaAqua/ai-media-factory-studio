# Contributing

This repository is not ready for public contributions until Git recovery and first public repository setup are finalized.

AI Media Factory Studio is licensed under Apache License 2.0 and is designed & developed by LuckyFields LLC.

Before proposing changes:

1. Keep ComfyUI, models, generated media, DB files, and local secrets out of commits.
2. Update migrations instead of editing existing SQLite DB structure directly.
3. Do not overwrite original workflow JSON files during execution.
4. Add or update `docs/作業履歴.md` for meaningful changes.
5. Run:

```powershell
python -m py_compile studio\server.py
node --check studio\static\app.js
python studio\server.py --init-only
```

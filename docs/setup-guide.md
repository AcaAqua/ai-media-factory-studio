# Setup Guide

## Prerequisites

- Python 3.10+
- ComfyUI installed separately
- Optional Ollama installation

## Studio

```powershell
python studio\server.py
```

Open:

```text
http://127.0.0.1:8765/
```

## ComfyUI

Start ComfyUI separately. Example output argument:

```text
--output-directory D:\Example\AI-Media-Factory\output\draft
```

Adult Local storage must be inside that output directory to be eligible for real ComfyUI submission.

## Database Backup

Before migrations or risky local changes:

```powershell
Copy-Item studio\data\media_factory.sqlite3 studio\data\backups\media_factory.sqlite3.before-change
```

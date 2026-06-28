from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import random
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse
from urllib.error import URLError
from urllib.request import Request, urlopen


APP_VERSION = "0.2.0-dev"
ROOT = Path(__file__).resolve().parents[1]
STUDIO = ROOT / "studio"
STATIC = STUDIO / "static"
DATA = STUDIO / "data"
DB_PATH = DATA / "media_factory.sqlite3"
MIGRATIONS = DATA / "migrations"
CONFIG = STUDIO / "config"
PUBLIC_CONFIG = ROOT / "config"
LOCAL_CONFIG_PATH = PUBLIC_CONFIG / "studio.local.json"
THUMBNAILS = STUDIO / "thumbnails"
DEFAULT_COMFY = "http://127.0.0.1:8188"
DEFAULT_OLLAMA = "http://127.0.0.1:11434"
CIVITAI_API = "https://civitai.com/api/v1"
CLIENT_ID = "ai-media-factory-studio"
REQUIRED_MAPPINGS = ("positive_prompt", "seed", "width", "height", "output")
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
CONTENT_SCOPES = {"sfw", "sensitive", "adult_local"}
STORAGE_SCOPES = {"general", "sensitive", "adult_local"}
STORAGE_USAGE_TYPES = {"generated", "references", "exports", "thumbnails", "backups"}
LOCAL_SHUTDOWN_HOSTS = {"127.0.0.1", "::1", "localhost"}
PROMPT_SPLIT_RE = re.compile(r"[、，,。．.\n\r\t\s]+")
PROMPT_PARTICLE_RE = re.compile(r"^[のにをがはでとへやも]|[のにをがはでとへやも]$")
ASSET_REGISTRY_EXTENSIONS = {
    "checkpoint": {".safetensors", ".ckpt", ".pt", ".pth", ".bin"},
    "lora": {".safetensors", ".pt", ".ckpt"},
    "vae": {".safetensors", ".ckpt", ".pt"},
    "controlnet": {".safetensors", ".ckpt", ".pt", ".pth"},
    "upscaler": {".pth", ".pt", ".safetensors", ".onnx"},
    "workflow": {".json"},
}
CIVITAI_DOWNLOAD_JOBS: dict[str, dict[str, Any]] = {}
CIVITAI_DOWNLOAD_JOBS_LOCK = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def safe_slug(value: str, limit: int = 80) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", value).strip("_")
    return (cleaned or "item")[:limit]


def build_output_prefix(job_id: str, scope: str = "sfw", relative_dir: str = "") -> str:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = f"amfs_{safe_slug(job_id, 32)}_{stamp}"
    if relative_dir:
        return f"{relative_dir.rstrip('/')}/{base}"
    if scope == "sensitive":
        return f"sensitive/{base}"
    return base


def path_under(child: Path, parent: Path) -> bool:
    child_resolved = child.resolve()
    parent_resolved = parent.resolve()
    return child_resolved == parent_resolved or parent_resolved in child_resolved.parents


def safe_relative_prefix(path: Path, root: Path) -> str | None:
    try:
        relative = path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None
    parts = [part for part in relative.split("/") if part]
    if any(part in {".", ".."} for part in parts):
        return None
    return "/".join(parts)


def configured_comfy_output_root(con: sqlite3.Connection | None = None) -> Path:
    if con is not None:
        value = get_setting(con, "comfy_output_root", None)
        if value:
            return Path(str(value))
    return ROOT / "output" / "draft"


def db() -> sqlite3.Connection:
    DATA.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def create_database_backup(reason: str = "manual") -> dict[str, Any]:
    if not DB_PATH.exists():
        raise ValueError("database file does not exist")
    DATA.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = DATA / "backups" / f"{safe_slug(reason, 40)}-{stamp}"
    backup_dir.mkdir(parents=True, exist_ok=False)
    backup_path = backup_dir / DB_PATH.name
    with sqlite3.connect(DB_PATH) as source:
        with sqlite3.connect(backup_path) as target:
            source.backup(target)
    return {
        "ok": True,
        "reason": reason,
        "path": str(backup_path),
        "relative_path": backup_path.relative_to(ROOT).as_posix(),
        "size_bytes": backup_path.stat().st_size,
        "created_at": now_iso(),
    }


def list_database_backups() -> dict[str, Any]:
    backup_root = DATA / "backups"
    backups = []
    if backup_root.exists():
        for path in sorted(backup_root.rglob(DB_PATH.name), key=lambda item: item.stat().st_mtime, reverse=True):
            try:
                relative = path.relative_to(ROOT).as_posix()
            except ValueError:
                continue
            backups.append(
                {
                    "name": path.parent.name,
                    "relative_path": relative,
                    "size_bytes": path.stat().st_size,
                    "created_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).replace(microsecond=0).isoformat(),
                }
            )
    return {"ok": True, "backups": backups[:100]}


def resolve_database_backup(relative_path: str) -> Path:
    if not relative_path:
        raise ValueError("backup path is required")
    backup_root = (DATA / "backups").resolve()
    candidate = (ROOT / relative_path).resolve()
    try:
        candidate.relative_to(backup_root)
    except ValueError as exc:
        raise ValueError("backup path must be under studio/data/backups") from exc
    if candidate.name != DB_PATH.name:
        raise ValueError("backup file name is invalid")
    if not candidate.exists() or not candidate.is_file():
        raise ValueError("backup file does not exist")
    return candidate


def restore_database_backup(payload: dict[str, Any]) -> dict[str, Any]:
    confirm_text = str(payload.get("confirm_text") or "").strip()
    if confirm_text != "RESTORE":
        raise ValueError("confirm_text must be RESTORE")
    backup_path = resolve_database_backup(str(payload.get("relative_path") or ""))
    pre_restore = create_database_backup("pre-restore")
    with sqlite3.connect(backup_path) as source:
        with sqlite3.connect(DB_PATH) as target:
            source.backup(target)
    run_migrations()
    return {
        "ok": True,
        "restored_from": backup_path.relative_to(ROOT).as_posix(),
        "pre_restore_backup": pre_restore,
        "restored_at": now_iso(),
        "reload_required": True,
    }


def run_migrations() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    THUMBNAILS.mkdir(parents=True, exist_ok=True)
    with db() as con:
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version TEXT PRIMARY KEY,
              applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        for path in sorted(MIGRATIONS.glob("*.sql")):
            version = path.stem
            applied = con.execute("SELECT 1 FROM schema_migrations WHERE version = ?", (version,)).fetchone()
            if applied:
                continue
            con.executescript(path.read_text(encoding="utf-8"))
            con.execute("INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)", (version,))
        seed_defaults(con)


def seed_defaults(con: sqlite3.Connection) -> None:
    default_storage = ROOT / "output"
    free = shutil.disk_usage(default_storage if default_storage.exists() else ROOT).free
    con.execute(
        """
        INSERT OR IGNORE INTO storage_locations
          (storage_id, name, base_path, type, is_default, is_available, writable, free_space_bytes)
        VALUES (?, ?, ?, 'local', 1, 1, 1, ?)
        """,
        ("storage_default_output", "Default Output", str(default_storage), free),
    )
    con.execute(
        """
        INSERT OR IGNORE INTO storage_locations
          (storage_id, name, base_path, type, is_default, is_available, writable, free_space_bytes)
        VALUES (?, ?, ?, 'local', 0, 1, 1, ?)
        """,
        ("storage_studio_thumbnails", "Studio Thumbnails", str(THUMBNAILS), shutil.disk_usage(ROOT).free),
    )
    con.execute(
        """
        INSERT OR IGNORE INTO ollama_profiles
          (profile_id, name, model_name, endpoint, role, is_default)
        VALUES (?, ?, ?, ?, 'prompt_assistant', 1)
        """,
        ("ollama_qwen_ja_7b", "Japanese Prompt Assistant", "qwen-ja:7b", DEFAULT_OLLAMA),
    )
    set_setting(con, "comfy_endpoint", DEFAULT_COMFY)
    set_setting(con, "ollama_endpoint", DEFAULT_OLLAMA)
    set_setting(con, "comfy_output_root", str(ROOT / "output" / "draft"))
    set_setting(con, "panel_state", {})


def set_setting(con: sqlite3.Connection, key: str, value: Any) -> None:
    con.execute(
        """
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')
        """,
        (key, json.dumps(value, ensure_ascii=False)),
    )


def get_setting(con: sqlite3.Connection, key: str, fallback: Any = None) -> Any:
    row = con.execute("SELECT value_json FROM app_settings WHERE key = ?", (key,)).fetchone()
    if not row:
        return fallback
    try:
        return json.loads(row["value_json"])
    except json.JSONDecodeError:
        return fallback


def load_local_config() -> dict[str, Any]:
    if not LOCAL_CONFIG_PATH.exists():
        return {}
    try:
        payload = json.loads(LOCAL_CONFIG_PATH.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_local_config(payload: dict[str, Any]) -> None:
    PUBLIC_CONFIG.mkdir(parents=True, exist_ok=True)
    LOCAL_CONFIG_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def get_civitai_token() -> str:
    env_token = os.environ.get("CIVITAI_API_TOKEN", "").strip()
    if env_token:
        return env_token
    civitai = load_local_config().get("civitai", {})
    return str(civitai.get("api_token") or "").strip() if isinstance(civitai, dict) else ""


def civitai_config_status() -> dict[str, Any]:
    local_config = load_local_config()
    local_token = isinstance(local_config.get("civitai"), dict) and bool(local_config["civitai"].get("api_token"))
    env_token = bool(os.environ.get("CIVITAI_API_TOKEN", "").strip())
    return {
        "ok": True,
        "civitai": {
            "has_token": env_token or local_token,
            "source": "environment" if env_token else ("local_config" if local_token else "none"),
        },
    }


def save_civitai_config(payload: dict[str, Any]) -> dict[str, Any]:
    token = str(payload.get("api_token") or "").strip()
    if not token:
        raise ValueError("Civitai API key is required")
    local_config = load_local_config()
    civitai = local_config.get("civitai", {}) if isinstance(local_config.get("civitai"), dict) else {}
    civitai["api_token"] = token
    local_config["civitai"] = civitai
    save_local_config(local_config)
    return civitai_config_status()


def delete_civitai_config() -> dict[str, Any]:
    local_config = load_local_config()
    if isinstance(local_config.get("civitai"), dict):
        local_config["civitai"].pop("api_token", None)
        if not local_config["civitai"]:
            local_config.pop("civitai", None)
        if local_config:
            save_local_config(local_config)
        elif LOCAL_CONFIG_PATH.exists():
            LOCAL_CONFIG_PATH.unlink()
    return civitai_config_status()


def rows(con: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    return [dict(row) for row in con.execute(sql, params).fetchall()]


def row(con: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    result = con.execute(sql, params).fetchone()
    return dict(result) if result else None


def asset_tags(con: sqlite3.Connection, asset_id: str) -> list[str]:
    return [
        item["name"]
        for item in rows(
            con,
            """
            SELECT t.name
            FROM tags t
            JOIN asset_tags at ON at.tag_id = t.tag_id
            WHERE at.asset_id = ?
            ORDER BY t.name
            """,
            (asset_id,),
        )
    ]


def recipe_tags(con: sqlite3.Connection, recipe_id: str) -> list[str]:
    return [
        item["name"]
        for item in rows(
            con,
            """
            SELECT t.name
            FROM tags t
            JOIN recipe_tags rt ON rt.tag_id = t.tag_id
            WHERE rt.recipe_id = ?
            ORDER BY t.name
            """,
            (recipe_id,),
        )
    ]


def normalize_tags(tags: Any) -> list[str]:
    if isinstance(tags, str):
        raw = re.split(r"[,、\s]+", tags)
    elif isinstance(tags, list):
        raw = [str(item) for item in tags]
    else:
        raw = []
    normalized = []
    seen = set()
    for item in raw:
        tag = item.strip().lower()
        tag = re.sub(r"[^a-z0-9_-]+", "-", tag).strip("-")
        if tag and tag not in seen:
            normalized.append(tag[:48])
            seen.add(tag)
    return normalized


def parse_query_params(path: str) -> dict[str, str]:
    parsed = urlparse(path)
    params = parse_qs(parsed.query)
    return {key: values[-1] for key, values in params.items() if values}


def asset_select_sql(where_sql: str = "") -> str:
    return f"""
        SELECT
          ma.*,
          go.source_path,
          go.file_name,
          go.width AS output_width,
          go.height AS output_height,
          gj.prompt,
          gj.negative_prompt,
          gj.parameters_json,
          gj.output_prefix,
          gj.workflow_id,
          wf.name AS workflow_name,
          r.recipe_id AS recipe_id,
          r.name AS recipe_name
        FROM media_assets ma
        LEFT JOIN generation_jobs gj ON gj.job_id = ma.source_job_id
        LEFT JOIN generation_job_outputs go ON go.asset_id = ma.asset_id
        LEFT JOIN workflows wf ON wf.workflow_id = gj.workflow_id
        LEFT JOIN recipes r ON r.source_asset_id = ma.asset_id
        {where_sql}
        GROUP BY ma.asset_id
        ORDER BY ma.created_at DESC
    """


def hydrate_assets(con: sqlite3.Connection, assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for asset in assets:
        asset["tags"] = asset_tags(con, asset["asset_id"])
    return assets


def list_assets(filters: dict[str, str]) -> dict[str, Any]:
    clauses = []
    params: list[Any] = []

    query = filters.get("query", "").strip()
    if query:
        like = f"%{query}%"
        clauses.append(
            """(
              ma.relative_path LIKE ? OR go.file_name LIKE ? OR gj.prompt LIKE ? OR gj.negative_prompt LIKE ?
              OR ma.note LIKE ? OR ma.comparison_note LIKE ? OR wf.name LIKE ? OR r.name LIKE ?
              OR gj.output_prefix LIKE ? OR gj.parameters_json LIKE ?
            )"""
        )
        params.extend([like] * 10)

    status = filters.get("status", "")
    if status:
        clauses.append("ma.status = ?")
        params.append(status)

    quick = filters.get("quick", "")
    if quick == "approved":
        clauses.append("ma.status = 'approved'")
    elif quick == "candidate":
        clauses.append("ma.status = 'candidate'")
    elif quick == "not_rejected":
        clauses.append("ma.status != 'rejected'")
    elif quick == "recent":
        clauses.append("ma.created_at >= datetime('now', '-7 days')")

    rating = filters.get("rating", "")
    if rating:
        try:
            clauses.append("ma.rating >= ?")
            params.append(int(rating))
        except ValueError:
            pass

    scope = filters.get("content_scope", "")
    if scope:
        clauses.append("ma.content_scope = ?")
        params.append(scope)

    workflow_id = filters.get("workflow_id", "")
    if workflow_id:
        clauses.append("gj.workflow_id = ?")
        params.append(workflow_id)

    recipe_id = filters.get("recipe_id", "")
    if recipe_id:
        clauses.append("r.recipe_id = ?")
        params.append(recipe_id)

    period = filters.get("period", "")
    if period == "today":
        clauses.append("ma.created_at >= date('now')")
    elif period == "week":
        clauses.append("ma.created_at >= datetime('now', '-7 days')")
    elif period == "month":
        clauses.append("ma.created_at >= datetime('now', '-30 days')")

    tags = normalize_tags(filters.get("tags", ""))
    if tags == ["untagged"]:
        clauses.append("NOT EXISTS (SELECT 1 FROM asset_tags at WHERE at.asset_id = ma.asset_id)")
    else:
        for tag in tags:
            clauses.append(
                """
                EXISTS (
                  SELECT 1
                  FROM asset_tags at
                  JOIN tags t ON t.tag_id = at.tag_id
                  WHERE at.asset_id = ma.asset_id AND t.name = ?
                )
                """
            )
            params.append(tag)

    where_sql = "WHERE " + " AND ".join(clauses) if clauses else ""
    limit = min(max(int(filters.get("limit", "80") or 80), 1), 200)
    sql = asset_select_sql(where_sql) + " LIMIT ?"
    params.append(limit)
    with db() as con:
        assets = rows(con, sql, tuple(params))
        hydrate_assets(con, assets)
    return {"ok": True, "assets": assets, "count": len(assets)}


def storage_status(storage: dict[str, Any], comfy_output_root: Path | None = None) -> dict[str, Any]:
    path = Path(storage["base_path"])
    exists = path.exists() and path.is_dir()
    output_root = comfy_output_root or (ROOT / "output" / "draft")
    relative_path = safe_relative_prefix(path, output_root) if exists else None
    output_compatible = bool(exists and relative_path is not None)
    free_space = None
    if exists:
        try:
            free_space = shutil.disk_usage(path).free
        except OSError:
            free_space = None
    result = dict(storage)
    result["path_exists"] = exists
    result["free_space_bytes"] = free_space if free_space is not None else storage.get("free_space_bytes")
    result["comfy_output_root"] = str(output_root)
    result["comfy_output_relative_path"] = relative_path or storage.get("comfy_output_relative_path")
    result["is_comfy_output_compatible"] = 1 if output_compatible else 0
    if not exists:
        result["last_validation_result"] = "path_missing"
    elif not output_compatible:
        result["last_validation_result"] = "outside_comfy_output_root"
    elif not storage.get("is_enabled", 1):
        result["last_validation_result"] = "disabled"
    elif not storage.get("writable", 1):
        result["last_validation_result"] = "not_writable"
    else:
        result["last_validation_result"] = "ok"
    return result


def list_storage_locations() -> dict[str, Any]:
    with db() as con:
        output_root = configured_comfy_output_root(con)
        storage = rows(con, "SELECT * FROM storage_locations ORDER BY content_scope, is_default DESC, name")
    return {"ok": True, "storage": [storage_status(item, output_root) for item in storage]}


def validate_storage_payload(payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    base_path = str(payload.get("base_path") or "").strip()
    content_scope = str(payload.get("content_scope") or "general")
    usage_type = str(payload.get("usage_type") or "generated")
    if not name:
        raise ValueError("storage name is required")
    if not base_path:
        raise ValueError("base path is required")
    path = Path(base_path)
    if not path.is_absolute():
        raise ValueError("base path must be absolute")
    if content_scope not in STORAGE_SCOPES:
        raise ValueError("invalid storage content scope")
    if usage_type not in STORAGE_USAGE_TYPES:
        raise ValueError("invalid storage usage type")
    return {
        "name": name,
        "base_path": str(path),
        "content_scope": content_scope,
        "usage_type": usage_type,
        "is_default": 1 if payload.get("is_default") else 0,
        "is_enabled": 1 if payload.get("is_enabled", True) else 0,
    }


def create_storage_location(payload: dict[str, Any]) -> dict[str, Any]:
    data = validate_storage_payload(payload)
    storage_id = payload.get("storage_id") or new_id("storage")
    path = Path(data["base_path"])
    exists = path.exists() and path.is_dir()
    free = shutil.disk_usage(path).free if exists else None
    with db() as con:
        output_root = configured_comfy_output_root(con)
        relative_path = safe_relative_prefix(path, output_root) if exists else None
        compatible = 1 if relative_path is not None else 0
        validation_result = "ok" if compatible else ("path_missing" if not exists else "outside_comfy_output_root")
        if data["is_default"]:
            con.execute(
                "UPDATE storage_locations SET is_default = 0 WHERE content_scope = ? AND usage_type = ?",
                (data["content_scope"], data["usage_type"]),
            )
        con.execute(
            """
            INSERT INTO storage_locations
              (storage_id, name, base_path, type, is_default, is_available, writable, free_space_bytes,
               content_scope, usage_type, is_enabled, last_checked_at, updated_at,
               comfy_output_relative_path, is_comfy_output_compatible, last_validation_result)
            VALUES (?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?)
            """,
            (
                storage_id,
                data["name"],
                data["base_path"],
                data["is_default"],
                1 if exists else 0,
                1 if exists else 0,
                free,
                data["content_scope"],
                data["usage_type"],
                data["is_enabled"],
                relative_path,
                compatible,
                validation_result,
            ),
        )
        con.execute(
            "INSERT INTO audit_logs (audit_id, action, entity_type, entity_id, detail_json) VALUES (?, 'create', 'storage_location', ?, ?)",
            (new_id("aud"), storage_id, json.dumps(data, ensure_ascii=False)),
        )
    return get_storage_location(storage_id)


def get_storage_location(storage_id: str) -> dict[str, Any]:
    with db() as con:
        output_root = configured_comfy_output_root(con)
        storage = row(con, "SELECT * FROM storage_locations WHERE storage_id = ?", (storage_id,))
        if not storage:
            raise ValueError("storage location not found")
    return {"ok": True, "storage": storage_status(storage, output_root)}


def update_storage_location(storage_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    with db() as con:
        existing = row(con, "SELECT * FROM storage_locations WHERE storage_id = ?", (storage_id,))
        if not existing:
            raise ValueError("storage location not found")
    merged = {**existing, **payload}
    data = validate_storage_payload(merged)
    path = Path(data["base_path"])
    exists = path.exists() and path.is_dir()
    free = shutil.disk_usage(path).free if exists else None
    with db() as con:
        output_root = configured_comfy_output_root(con)
        relative_path = safe_relative_prefix(path, output_root) if exists else None
        compatible = 1 if relative_path is not None else 0
        validation_result = "ok" if compatible else ("path_missing" if not exists else "outside_comfy_output_root")
        if data["is_default"]:
            con.execute(
                "UPDATE storage_locations SET is_default = 0 WHERE content_scope = ? AND usage_type = ? AND storage_id != ?",
                (data["content_scope"], data["usage_type"], storage_id),
            )
        con.execute(
            """
            UPDATE storage_locations
            SET name = ?, base_path = ?, is_default = ?, is_available = ?, writable = ?, free_space_bytes = ?,
                content_scope = ?, usage_type = ?, is_enabled = ?, last_checked_at = datetime('now'), updated_at = datetime('now'),
                comfy_output_relative_path = ?, is_comfy_output_compatible = ?, last_validation_result = ?
            WHERE storage_id = ?
            """,
            (
                data["name"],
                data["base_path"],
                data["is_default"],
                1 if exists else 0,
                1 if exists else 0,
                free,
                data["content_scope"],
                data["usage_type"],
                data["is_enabled"],
                relative_path,
                compatible,
                validation_result,
                storage_id,
            ),
        )
        con.execute(
            "INSERT INTO audit_logs (audit_id, action, entity_type, entity_id, detail_json) VALUES (?, 'update', 'storage_location', ?, ?)",
            (new_id("aud"), storage_id, json.dumps(data, ensure_ascii=False)),
        )
    return get_storage_location(storage_id)


def test_storage_location(payload: dict[str, Any]) -> dict[str, Any]:
    base_path = str(payload.get("base_path") or "")
    storage_id = payload.get("storage_id")
    if storage_id and not base_path:
        with db() as con:
            storage = row(con, "SELECT * FROM storage_locations WHERE storage_id = ?", (storage_id,))
        if not storage:
            raise ValueError("storage location not found")
        base_path = storage["base_path"]
    path = Path(base_path)
    exists = path.exists() and path.is_dir()
    writable = False
    error = None
    free = None
    if exists:
        try:
            free = shutil.disk_usage(path).free
            test_file = path / f".amfs_write_test_{uuid.uuid4().hex}.tmp"
            test_file.write_text("ok", encoding="utf-8")
            test_file.unlink()
            writable = True
        except Exception as exc:
            error = str(exc)
    else:
        error = "path does not exist or is not a directory"
    if storage_id:
        with db() as con:
            output_root = configured_comfy_output_root(con)
            relative_path = safe_relative_prefix(path, output_root) if exists else None
            compatible = 1 if relative_path is not None else 0
            validation_result = "ok" if exists and writable and compatible else (
                error or ("outside_comfy_output_root" if exists and not compatible else "not_writable")
            )
            con.execute(
                """
                UPDATE storage_locations
                SET is_available = ?, writable = ?, free_space_bytes = ?, last_checked_at = datetime('now'), updated_at = datetime('now'),
                    comfy_output_relative_path = ?, is_comfy_output_compatible = ?, last_validation_result = ?
                WHERE storage_id = ?
                """,
                (1 if exists else 0, 1 if writable else 0, free, relative_path, compatible, validation_result, storage_id),
            )
    return {"ok": exists and writable, "path_exists": exists, "writable": writable, "free_space_bytes": free, "error": error}


def resolve_asset_location_path(base_path: str) -> Path:
    path = Path(str(base_path))
    if not path.is_absolute():
        path = ROOT / path
    return path.resolve()


def asset_registry_location_status(location: dict[str, Any]) -> dict[str, Any]:
    path = resolve_asset_location_path(location["base_path"])
    result = dict(location)
    result["resolved_path"] = str(path)
    result["path_exists"] = path.exists() and path.is_dir()
    result["writable"] = result["path_exists"] and os.access(path, os.W_OK)
    return result


def list_asset_registry() -> dict[str, Any]:
    with db() as con:
        locations = rows(con, "SELECT * FROM asset_registry_locations ORDER BY asset_kind, name")
        items = rows(
            con,
            """
            SELECT i.*, l.name AS location_name, l.base_path AS location_base_path
            FROM asset_registry_items i
            LEFT JOIN asset_registry_locations l ON l.location_id = i.location_id
            ORDER BY i.asset_kind, i.missing, i.name
            LIMIT 500
            """,
        )
        scan_runs = rows(con, "SELECT * FROM asset_scan_runs ORDER BY started_at DESC LIMIT 20")
        counts = rows(
            con,
            """
            SELECT asset_kind, missing, COUNT(*) AS count
            FROM asset_registry_items
            GROUP BY asset_kind, missing
            ORDER BY asset_kind, missing
            """,
        )
        requirements = rows(
            con,
            """
            SELECT r.*, i.name AS matched_name, i.relative_path AS matched_relative_path
            FROM workflow_asset_requirements r
            LEFT JOIN asset_registry_items i ON i.item_id = r.matched_item_id
            ORDER BY
              CASE r.status WHEN 'missing' THEN 0 WHEN 'matched' THEN 1 ELSE 2 END,
              r.workflow_name,
              r.asset_kind,
              r.asset_name
            LIMIT 500
            """,
        )
        requirement_counts = rows(
            con,
            """
            SELECT status, asset_kind, COUNT(*) AS count
            FROM workflow_asset_requirements
            GROUP BY status, asset_kind
            ORDER BY status, asset_kind
            """,
        )
    return {
        "ok": True,
        "locations": [asset_registry_location_status(item) for item in locations],
        "items": items,
        "scan_runs": scan_runs,
        "counts": counts,
        "requirements": requirements,
        "requirement_counts": requirement_counts,
    }


def validate_asset_location_payload(payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    asset_kind = str(payload.get("asset_kind") or "").strip()
    base_path = str(payload.get("base_path") or "").strip()
    if not name:
        raise ValueError("location name is required")
    if asset_kind not in ASSET_REGISTRY_EXTENSIONS:
        raise ValueError("invalid asset kind")
    if not base_path:
        raise ValueError("base path is required")
    return {
        "name": name,
        "asset_kind": asset_kind,
        "base_path": base_path.replace("\\", "/") if not Path(base_path).is_absolute() else base_path,
        "is_external": 1 if payload.get("is_external") else 0,
        "is_enabled": 1 if payload.get("is_enabled", True) else 0,
        "notes": str(payload.get("notes") or "").strip(),
    }


def create_asset_registry_location(payload: dict[str, Any]) -> dict[str, Any]:
    data = validate_asset_location_payload(payload)
    location_id = payload.get("location_id") or new_id("arl")
    with db() as con:
        con.execute(
            """
            INSERT INTO asset_registry_locations
              (location_id, name, asset_kind, base_path, is_external, is_enabled, notes, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(asset_kind, base_path) DO UPDATE SET
              name = excluded.name,
              asset_kind = excluded.asset_kind,
              is_external = excluded.is_external,
              is_enabled = excluded.is_enabled,
              notes = excluded.notes,
              updated_at = datetime('now')
            """,
            (location_id, data["name"], data["asset_kind"], data["base_path"], data["is_external"], data["is_enabled"], data["notes"]),
        )
    return list_asset_registry()


def update_asset_registry_item(item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    allowed = {"source_url", "license", "creator", "base_model", "status", "notes"}
    updates = []
    params: list[Any] = []
    if "status" in payload and str(payload.get("status") or "") not in {"unverified", "verified", "needs_review", "rejected"}:
        raise ValueError("invalid asset status")
    for key in allowed:
        if key not in payload:
            continue
        value = str(payload.get(key) or "").strip()
        updates.append(f"{key} = ?")
        params.append(value)
    if not updates:
        raise ValueError("no fields to update")
    params.append(item_id)
    with db() as con:
        existing = row(con, "SELECT item_id FROM asset_registry_items WHERE item_id = ?", (item_id,))
        if not existing:
            raise ValueError("asset registry item not found")
        con.execute(
            f"UPDATE asset_registry_items SET {', '.join(updates)}, updated_at = datetime('now') WHERE item_id = ?",
            tuple(params),
        )
        item = row(
            con,
            """
            SELECT i.*, l.name AS location_name, l.base_path AS location_base_path
            FROM asset_registry_items i
            LEFT JOIN asset_registry_locations l ON l.location_id = i.location_id
            WHERE i.item_id = ?
            """,
            (item_id,),
        )
    return {"ok": True, "item": item}


def asset_kind_from_civitai_type(model_type: str) -> str:
    value = (model_type or "").lower()
    if "lora" in value:
        return "lora"
    if "vae" in value:
        return "vae"
    if "controlnet" in value:
        return "controlnet"
    if "upscaler" in value:
        return "upscaler"
    return "checkpoint"


def select_civitai_file(civitai: dict[str, Any], selected_name: str = "") -> dict[str, Any]:
    version = civitai.get("version") if isinstance(civitai.get("version"), dict) else {}
    files = version.get("files") if isinstance(version.get("files"), list) else []
    selected = None
    if selected_name:
        selected = next((item for item in files if str(item.get("name") or "") == selected_name), None)
    selected = selected or next((item for item in files if item.get("download_url")), None) or (files[0] if files else {})
    if not selected:
        raise ValueError("Civitai file metadata is required")
    return selected


def civitai_expected_sha256(selected_file: dict[str, Any]) -> str:
    hashes = selected_file.get("hashes") if isinstance(selected_file.get("hashes"), dict) else {}
    for key, value in hashes.items():
        if str(key).lower() == "sha256" and str(value or "").strip():
            return str(value).strip().lower()
    return ""


def civitai_download_url_allowed(download_url: str) -> bool:
    parsed = urlparse(download_url)
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (host == "civitai.com" or host.endswith(".civitai.com"))


def civitai_download_headers() -> dict[str, str]:
    headers = {"User-Agent": "AI-Media-Factory-Studio/0.2"}
    token = civitai_api_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def apply_civitai_to_asset_registry(payload: dict[str, Any]) -> dict[str, Any]:
    item_id = str(payload.get("item_id") or "").strip()
    civitai = payload.get("civitai") if isinstance(payload.get("civitai"), dict) else {}
    model = civitai.get("model") if isinstance(civitai.get("model"), dict) else {}
    version = civitai.get("version") if isinstance(civitai.get("version"), dict) else {}
    if not item_id:
        raise ValueError("item_id is required")
    notes = []
    if version.get("name"):
        notes.append(f"Civitai version: {version.get('name')}")
    trained_words = version.get("trained_words") if isinstance(version.get("trained_words"), list) else []
    if trained_words:
        notes.append(f"Trigger words: {', '.join(str(item) for item in trained_words[:12])}")
    tags = model.get("tags") if isinstance(model.get("tags"), list) else []
    if tags:
        notes.append(f"Tags: {', '.join(str(item) for item in tags[:16])}")
    update = {
        "source_url": str(civitai.get("source_url") or ""),
        "creator": str(model.get("creator") or ""),
        "base_model": str(version.get("base_model") or ""),
        "license": str(payload.get("license") or ""),
        "status": "needs_review",
        "notes": "\n".join(notes),
    }
    result = update_asset_registry_item(item_id, update)
    result["asset_kind_hint"] = asset_kind_from_civitai_type(str(model.get("type") or ""))
    return result


def civitai_download_plan(payload: dict[str, Any]) -> dict[str, Any]:
    civitai = payload.get("civitai") if isinstance(payload.get("civitai"), dict) else {}
    model = civitai.get("model") if isinstance(civitai.get("model"), dict) else {}
    version = civitai.get("version") if isinstance(civitai.get("version"), dict) else {}
    selected_name = str(payload.get("file_name") or "").strip()
    selected_file = select_civitai_file(civitai, selected_name)

    asset_kind = asset_kind_from_civitai_type(str(model.get("type") or ""))
    file_name = Path(str(selected_file.get("name") or f"{safe_slug(model.get('name') or 'civitai_asset')}.safetensors")).name
    if not file_name or file_name in {".", ".."}:
        raise ValueError("invalid Civitai file name")
    extension = Path(file_name).suffix.lower()
    allowed = ASSET_REGISTRY_EXTENSIONS.get(asset_kind, set())
    warnings = []
    blockers = []
    if allowed and extension not in allowed:
        warnings.append(f"Unexpected extension for {asset_kind}: {extension or '(none)'}")
    if model.get("nsfw"):
        warnings.append("Civitai metadata marks this model as NSFW. Confirm intended local scope before downloading.")
    pickle_scan = str(selected_file.get("pickle_scan_result") or "").lower()
    virus_scan = str(selected_file.get("virus_scan_result") or "").lower()
    if pickle_scan and pickle_scan not in {"success", "clean", "passed"}:
        warnings.append(f"Pickle scan result needs review: {selected_file.get('pickle_scan_result')}")
    if virus_scan and virus_scan not in {"success", "clean", "passed"}:
        blockers.append(f"Virus scan result is not clean: {selected_file.get('virus_scan_result')}")
    download_url = str(selected_file.get("download_url") or version.get("download_url") or "")
    if not download_url:
        blockers.append("Download URL is missing from Civitai metadata.")
    elif not civitai_download_url_allowed(download_url):
        blockers.append("Download URL is not an allowed Civitai HTTPS URL.")

    with db() as con:
        locations = [
            asset_registry_location_status(item)
            for item in rows(
                con,
                "SELECT * FROM asset_registry_locations WHERE asset_kind = ? AND is_enabled = 1 ORDER BY is_external, name",
                (asset_kind,),
            )
        ]
    location_options = []
    for location in locations:
        base = Path(location["base_path"])
        candidate = (base / file_name).resolve() if base.is_absolute() else (ROOT / base / file_name).resolve()
        path_exists = candidate.exists()
        if path_exists:
            warnings.append(f"Target file already exists in {location['name']}. Download must not overwrite it.")
        location_options.append(
            {
                "location_id": location["location_id"],
                "name": location["name"],
                "asset_kind": location["asset_kind"],
                "base_path": location["base_path"],
                "path_exists": location.get("path_exists"),
                "writable": location.get("writable"),
                "target_relative_path": file_name,
                "target_path_exists": path_exists,
                "is_external": location.get("is_external"),
            }
        )
    if not location_options:
        blockers.append(f"No enabled asset registry location for {asset_kind}.")
    elif not any(item.get("path_exists") and item.get("writable") and not item.get("target_path_exists") for item in location_options):
        warnings.append("No ready non-overwriting target was found. Register or fix an asset location before downloading.")
    ready_location = next((item for item in location_options if item.get("path_exists") and item.get("writable") and not item.get("target_path_exists")), None)

    return {
        "ok": True,
        "download_enabled": bool(ready_location and not blockers),
        "asset_kind": asset_kind,
        "recommended_location_id": ready_location.get("location_id") if ready_location else "",
        "file": {
            "name": file_name,
            "size_bytes": int(float(selected_file.get("size_kb") or 0) * 1024),
            "download_url": download_url,
            "pickle_scan_result": selected_file.get("pickle_scan_result"),
            "virus_scan_result": selected_file.get("virus_scan_result"),
            "hashes": selected_file.get("hashes") or {},
        },
        "locations": location_options,
        "warnings": warnings,
        "blockers": blockers,
        "required_confirmations": [
            "Review the model license and Civitai page terms.",
            "Confirm the selected file is intended for this local project.",
            "Confirm no existing file will be overwritten.",
            "Scan the downloaded file with your local security tools before use.",
        ],
    }


def download_civitai_asset(
    payload: dict[str, Any],
    cancel_event: threading.Event | None = None,
    progress: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if str(payload.get("confirm_text") or "").strip() != "DOWNLOAD":
        raise ValueError("confirm_text must be DOWNLOAD")

    civitai = payload.get("civitai") if isinstance(payload.get("civitai"), dict) else {}
    model = civitai.get("model") if isinstance(civitai.get("model"), dict) else {}
    version = civitai.get("version") if isinstance(civitai.get("version"), dict) else {}
    selected_file = select_civitai_file(civitai, str(payload.get("file_name") or "").strip())
    asset_kind = asset_kind_from_civitai_type(str(model.get("type") or ""))
    file_name = Path(str(selected_file.get("name") or f"{safe_slug(model.get('name') or 'civitai_asset')}.safetensors")).name
    if not file_name or file_name in {".", ".."}:
        raise ValueError("invalid Civitai file name")
    extension = Path(file_name).suffix.lower()
    allowed = ASSET_REGISTRY_EXTENSIONS.get(asset_kind, set())
    if allowed and extension not in allowed:
        raise ValueError(f"unexpected extension for {asset_kind}: {extension or '(none)'}")

    download_url = str(selected_file.get("download_url") or version.get("download_url") or "")
    if not download_url:
        raise ValueError("download URL is missing")
    if not civitai_download_url_allowed(download_url):
        raise ValueError("download URL is not an allowed Civitai HTTPS URL")

    virus_scan = str(selected_file.get("virus_scan_result") or "").lower()
    if virus_scan and virus_scan not in {"success", "clean", "passed"}:
        raise ValueError(f"virus scan result is not clean: {selected_file.get('virus_scan_result')}")

    location_id = str(payload.get("location_id") or "").strip()
    if not location_id:
        raise ValueError("location_id is required")

    with db() as con:
        location = row(con, "SELECT * FROM asset_registry_locations WHERE location_id = ? AND is_enabled = 1", (location_id,))
        if not location:
            raise ValueError("asset registry location not found or disabled")
        if location["asset_kind"] != asset_kind:
            raise ValueError(f"location asset kind does not match: {location['asset_kind']} != {asset_kind}")

        base = resolve_asset_location_path(location["base_path"])
        if not int(location.get("is_external") or 0):
            base.mkdir(parents=True, exist_ok=True)
        if not base.exists() or not base.is_dir():
            raise ValueError("target location path does not exist")
        if not os.access(base, os.W_OK):
            raise ValueError("target location is not writable")

        target = (base / file_name).resolve()
        if not path_under(target, base):
            raise ValueError("target path escaped the asset location")
        if target.exists():
            raise ValueError("target file already exists; refusing to overwrite")
        existing = row(con, "SELECT item_id FROM asset_registry_items WHERE location_id = ? AND relative_path = ?", (location_id, file_name))
        if existing:
            raise ValueError("asset registry item already exists for this target path")

        tmp = target.with_name(f".{target.name}.{uuid.uuid4().hex[:8]}.part")
        digest = hashlib.sha256()
        size_bytes = 0
        try:
            req = Request(download_url, headers=civitai_download_headers())
            with urlopen(req, timeout=120) as response, tmp.open("wb") as handle:
                total_header = response.headers.get("Content-Length") or ""
                total_bytes = int(total_header) if total_header.isdigit() else 0
                if progress is not None:
                    progress.update(
                        {
                            "status": "running",
                            "file_name": file_name,
                            "location_id": location_id,
                            "total_bytes": total_bytes,
                            "downloaded_bytes": 0,
                            "percent": 0,
                        }
                    )
                for chunk in iter(lambda: response.read(1024 * 1024), b""):
                    if cancel_event is not None and cancel_event.is_set():
                        raise ValueError("download cancelled")
                    handle.write(chunk)
                    digest.update(chunk)
                    size_bytes += len(chunk)
                    if progress is not None:
                        progress.update(
                            {
                                "downloaded_bytes": size_bytes,
                                "percent": round((size_bytes / total_bytes) * 100, 1) if total_bytes else 0,
                            }
                        )
            sha256 = digest.hexdigest()
            expected_sha256 = civitai_expected_sha256(selected_file)
            if expected_sha256 and sha256.lower() != expected_sha256:
                tmp.unlink(missing_ok=True)
                raise ValueError("downloaded file SHA256 does not match Civitai metadata")
            if target.exists():
                tmp.unlink(missing_ok=True)
                raise ValueError("target file appeared during download; refusing to overwrite")
            tmp.replace(target)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise

        trained_words = version.get("trained_words") if isinstance(version.get("trained_words"), list) else []
        tags = model.get("tags") if isinstance(model.get("tags"), list) else []
        notes = [
            f"Civitai model: {model.get('name') or '-'}",
            f"Civitai version: {version.get('name') or '-'}",
        ]
        if trained_words:
            notes.append(f"Trigger words: {', '.join(str(item) for item in trained_words[:12])}")
        if tags:
            notes.append(f"Tags: {', '.join(str(item) for item in tags[:16])}")
        item_id = new_id("ari")
        con.execute(
            """
            INSERT INTO asset_registry_items
              (item_id, location_id, asset_kind, name, relative_path, file_name, extension, size_bytes,
               sha256, source_url, creator, base_model, status, notes, missing, last_seen_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_review', ?, 0, datetime('now'), datetime('now'))
            """,
            (
                item_id,
                location_id,
                asset_kind,
                Path(file_name).stem,
                file_name,
                file_name,
                extension,
                size_bytes,
                sha256,
                str(civitai.get("source_url") or ""),
                str(model.get("creator") or ""),
                str(version.get("base_model") or ""),
                "\n".join(notes),
            ),
        )
        con.execute("UPDATE asset_registry_locations SET last_scanned_at = datetime('now'), updated_at = datetime('now') WHERE location_id = ?", (location_id,))
        item = row(
            con,
            """
            SELECT i.*, l.name AS location_name, l.base_path AS location_base_path
            FROM asset_registry_items i
            LEFT JOIN asset_registry_locations l ON l.location_id = i.location_id
            WHERE i.item_id = ?
            """,
            (item_id,),
        )

    return {
        "ok": True,
        "item": item,
        "file": {"name": file_name, "size_bytes": size_bytes, "sha256": item.get("sha256") if item else ""},
        "warnings": ["Downloaded file is registered as needs_review. Review license and compatibility before use."],
    }


def public_civitai_download_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in job.items()
        if key not in {"cancel_event", "payload"}
    }


def get_civitai_download_job(job_id: str) -> dict[str, Any]:
    with CIVITAI_DOWNLOAD_JOBS_LOCK:
        job = CIVITAI_DOWNLOAD_JOBS.get(job_id)
        if not job:
            raise ValueError("download job not found")
        return {"ok": True, "job": public_civitai_download_job(dict(job))}


def create_civitai_download_job(payload: dict[str, Any]) -> dict[str, Any]:
    if str(payload.get("confirm_text") or "").strip() != "DOWNLOAD":
        raise ValueError("confirm_text must be DOWNLOAD")
    job_id = new_id("cdj")
    cancel_event = threading.Event()
    job = {
        "job_id": job_id,
        "status": "queued",
        "file_name": "",
        "location_id": str(payload.get("location_id") or ""),
        "downloaded_bytes": 0,
        "total_bytes": 0,
        "percent": 0,
        "error": "",
        "result": None,
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "cancel_event": cancel_event,
        "payload": payload,
    }
    with CIVITAI_DOWNLOAD_JOBS_LOCK:
        CIVITAI_DOWNLOAD_JOBS[job_id] = job

    def worker() -> None:
        try:
            with CIVITAI_DOWNLOAD_JOBS_LOCK:
                CIVITAI_DOWNLOAD_JOBS[job_id]["status"] = "running"
                CIVITAI_DOWNLOAD_JOBS[job_id]["updated_at"] = now_iso()
            result = download_civitai_asset(payload, cancel_event=cancel_event, progress=job)
            with CIVITAI_DOWNLOAD_JOBS_LOCK:
                CIVITAI_DOWNLOAD_JOBS[job_id].update(
                    {
                        "status": "completed",
                        "percent": 100,
                        "result": result,
                        "updated_at": now_iso(),
                    }
                )
        except Exception as exc:
            with CIVITAI_DOWNLOAD_JOBS_LOCK:
                status = "cancelled" if cancel_event.is_set() or str(exc) == "download cancelled" else "failed"
                CIVITAI_DOWNLOAD_JOBS[job_id].update(
                    {
                        "status": status,
                        "error": str(exc),
                        "updated_at": now_iso(),
                    }
                )

    threading.Thread(target=worker, daemon=True).start()
    return get_civitai_download_job(job_id)


def cancel_civitai_download_job(job_id: str) -> dict[str, Any]:
    with CIVITAI_DOWNLOAD_JOBS_LOCK:
        job = CIVITAI_DOWNLOAD_JOBS.get(job_id)
        if not job:
            raise ValueError("download job not found")
        if job.get("status") in {"completed", "failed", "cancelled"}:
            return {"ok": True, "job": public_civitai_download_job(dict(job))}
        job["cancel_event"].set()
        job["status"] = "cancelling"
        job["updated_at"] = now_iso()
        return {"ok": True, "job": public_civitai_download_job(dict(job))}


def workflow_requirement_kind(class_type: str, input_key: str) -> str | None:
    class_lower = class_type.lower()
    key = input_key.lower()
    if "upscale" in class_lower and key in {"model_name", "upscale_model", "upscaler_name"}:
        return "upscaler"
    if "controlnet" in class_lower and key in {"control_net_name", "controlnet_name", "model_name"}:
        return "controlnet"
    if "vae" in class_lower and key in {"vae_name", "ckpt_name", "model_name"}:
        return "vae"
    if "lora" in class_lower and (key == "lora_name" or "lora" in key):
        return "lora"
    if "checkpoint" in class_lower and key in {"ckpt_name", "checkpoint", "model_name"}:
        return "checkpoint"
    if class_lower in {"unetloader", "diffusionmodelloader"} and key in {"unet_name", "model_name"}:
        return "checkpoint"
    return None


def normalize_asset_name(value: str) -> str:
    name = Path(str(value or "")).name.lower()
    for suffix in [".safetensors", ".ckpt", ".pth", ".pt", ".bin", ".onnx", ".json"]:
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def find_matching_asset_item(con: sqlite3.Connection, asset_kind: str, asset_name: str) -> dict[str, Any] | None:
    wanted = normalize_asset_name(asset_name)
    candidates = rows(
        con,
        """
        SELECT * FROM asset_registry_items
        WHERE asset_kind = ? AND missing = 0
        """,
        (asset_kind,),
    )
    for item in candidates:
        if normalize_asset_name(item.get("file_name") or item.get("name") or "") == wanted:
            return item
    for item in candidates:
        candidate = normalize_asset_name(item.get("file_name") or item.get("name") or "")
        if wanted and (wanted in candidate or candidate in wanted):
            return item
    return None


def extract_workflow_requirements_from_file(path: Path) -> list[dict[str, Any]]:
    workflow_json = json.loads(path.read_text(encoding="utf-8"))
    requirements = []
    for node in workflow_nodes(workflow_json):
        for input_key, value in node["inputs"].items():
            if not isinstance(value, str) or not value.strip():
                continue
            asset_kind = workflow_requirement_kind(node["class_type"], input_key)
            if not asset_kind:
                continue
            requirements.append(
                {
                    "node_id": node["node_id"],
                    "class_type": node["class_type"],
                    "asset_kind": asset_kind,
                    "asset_name": value,
                    "input_key": input_key,
                }
            )
    return requirements


def scan_workflow_asset_requirements(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    target_path = str(payload.get("workflow_path") or "").strip().replace("\\", "/")
    workflow_root = (ROOT / "workflows").resolve()
    workflow_files = []
    if target_path:
        path = (ROOT / target_path).resolve()
        if not path.exists() or workflow_root not in path.parents:
            raise ValueError("workflow path is outside workflows or missing")
        workflow_files = [path]
    elif workflow_root.exists():
        workflow_files = sorted(workflow_root.rglob("*.json"))
    scanned = detected = matched = missing = 0
    with db() as con:
        for path in workflow_files:
            try:
                relative = path.relative_to(ROOT).as_posix()
                requirements = extract_workflow_requirements_from_file(path)
            except Exception:
                continue
            scanned += 1
            active_keys = set()
            for req in requirements:
                detected += 1
                match = find_matching_asset_item(con, req["asset_kind"], req["asset_name"])
                status = "matched" if match else "missing"
                if match:
                    matched += 1
                else:
                    missing += 1
                active_keys.add((relative, req["node_id"], req["input_key"], req["asset_name"]))
                requirement_id = new_id("war")
                con.execute(
                    """
                    INSERT INTO workflow_asset_requirements
                      (requirement_id, workflow_path, workflow_name, node_id, class_type, asset_kind, asset_name,
                       input_key, matched_item_id, status, last_checked_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                    ON CONFLICT(workflow_path, node_id, input_key, asset_name) DO UPDATE SET
                      workflow_name = excluded.workflow_name,
                      class_type = excluded.class_type,
                      asset_kind = excluded.asset_kind,
                      matched_item_id = excluded.matched_item_id,
                      status = excluded.status,
                      last_checked_at = datetime('now'),
                      updated_at = datetime('now')
                    """,
                    (
                        requirement_id,
                        relative,
                        path.stem,
                        req["node_id"],
                        req["class_type"],
                        req["asset_kind"],
                        req["asset_name"],
                        req["input_key"],
                        match["item_id"] if match else None,
                        status,
                    ),
                )
            existing = rows(con, "SELECT workflow_path, node_id, input_key, asset_name FROM workflow_asset_requirements WHERE workflow_path = ?", (relative,))
            for item in existing:
                key = (item["workflow_path"], item["node_id"], item["input_key"], item["asset_name"])
                if key not in active_keys:
                    con.execute(
                        """
                        UPDATE workflow_asset_requirements
                        SET status = 'stale', matched_item_id = NULL, updated_at = datetime('now')
                        WHERE workflow_path = ? AND node_id = ? AND input_key = ? AND asset_name = ?
                        """,
                        key,
                    )
    result = list_workflow_asset_requirements()
    result["scan_summary"] = {"workflows": scanned, "detected": detected, "matched": matched, "missing": missing}
    return result


def list_workflow_asset_requirements() -> dict[str, Any]:
    with db() as con:
        requirements = rows(
            con,
            """
            SELECT r.*, i.name AS matched_name, i.relative_path AS matched_relative_path
            FROM workflow_asset_requirements r
            LEFT JOIN asset_registry_items i ON i.item_id = r.matched_item_id
            ORDER BY
              CASE r.status WHEN 'missing' THEN 0 WHEN 'matched' THEN 1 ELSE 2 END,
              r.workflow_name,
              r.asset_kind,
              r.asset_name
            LIMIT 500
            """,
        )
        counts = rows(
            con,
            """
            SELECT status, asset_kind, COUNT(*) AS count
            FROM workflow_asset_requirements
            GROUP BY status, asset_kind
            ORDER BY status, asset_kind
            """,
        )
    return {"ok": True, "requirements": requirements, "counts": counts}


def scan_asset_registry_location(con: sqlite3.Connection, location: dict[str, Any]) -> dict[str, Any]:
    location_id = location["location_id"]
    asset_kind = location["asset_kind"]
    base = resolve_asset_location_path(location["base_path"])
    scan_id = new_id("scan")
    con.execute("INSERT INTO asset_scan_runs (scan_id, location_id) VALUES (?, ?)", (scan_id, location_id))
    if not base.exists() or not base.is_dir():
        con.execute(
            """
            UPDATE asset_scan_runs
            SET status = 'failed', finished_at = datetime('now'), error_message = ?
            WHERE scan_id = ?
            """,
            ("path_missing", scan_id),
        )
        return {"scan_id": scan_id, "status": "failed", "error_message": "path_missing"}

    allowed_ext = ASSET_REGISTRY_EXTENSIONS.get(asset_kind, set())
    seen_paths = set()
    scanned = added = updated = 0
    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        extension = path.suffix.lower()
        if allowed_ext and extension not in allowed_ext:
            continue
        try:
            relative_path = path.relative_to(base).as_posix()
        except ValueError:
            continue
        seen_paths.add(relative_path)
        scanned += 1
        stat = path.stat()
        existing = row(con, "SELECT item_id, size_bytes, missing FROM asset_registry_items WHERE location_id = ? AND relative_path = ?", (location_id, relative_path))
        item_id = existing["item_id"] if existing else new_id("ari")
        con.execute(
            """
            INSERT INTO asset_registry_items
              (item_id, location_id, asset_kind, name, relative_path, file_name, extension, size_bytes, missing, last_seen_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
            ON CONFLICT(location_id, relative_path) DO UPDATE SET
              asset_kind = excluded.asset_kind,
              name = excluded.name,
              file_name = excluded.file_name,
              extension = excluded.extension,
              size_bytes = excluded.size_bytes,
              missing = 0,
              last_seen_at = datetime('now'),
              updated_at = datetime('now')
            """,
            (item_id, location_id, asset_kind, path.stem, relative_path, path.name, extension, stat.st_size),
        )
        if existing:
            if existing.get("size_bytes") != stat.st_size or existing.get("missing"):
                updated += 1
        else:
            added += 1

    existing_paths = {
        item["relative_path"]
        for item in rows(con, "SELECT relative_path FROM asset_registry_items WHERE location_id = ? AND missing = 0", (location_id,))
    }
    missing_paths = sorted(existing_paths - seen_paths)
    for relative_path in missing_paths:
        con.execute(
            "UPDATE asset_registry_items SET missing = 1, updated_at = datetime('now') WHERE location_id = ? AND relative_path = ?",
            (location_id, relative_path),
        )
    con.execute(
        """
        UPDATE asset_scan_runs
        SET status = 'completed', finished_at = datetime('now'), scanned_count = ?, added_count = ?, updated_count = ?, missing_count = ?
        WHERE scan_id = ?
        """,
        (scanned, added, updated, len(missing_paths), scan_id),
    )
    con.execute("UPDATE asset_registry_locations SET last_scanned_at = datetime('now'), updated_at = datetime('now') WHERE location_id = ?", (location_id,))
    return {
        "scan_id": scan_id,
        "status": "completed",
        "scanned_count": scanned,
        "added_count": added,
        "updated_count": updated,
        "missing_count": len(missing_paths),
    }


def scan_asset_registry(payload: dict[str, Any]) -> dict[str, Any]:
    target_location = str(payload.get("location_id") or "").strip()
    with db() as con:
        if target_location:
            locations = rows(con, "SELECT * FROM asset_registry_locations WHERE location_id = ? AND is_enabled = 1", (target_location,))
        else:
            locations = rows(con, "SELECT * FROM asset_registry_locations WHERE is_enabled = 1 ORDER BY asset_kind, name")
        results = [scan_asset_registry_location(con, location) for location in locations]
    state = list_asset_registry()
    state["scan_results"] = results
    return state


def board_assets(filters: dict[str, str]) -> dict[str, Any]:
    filters = dict(filters)
    filters["status"] = "approved"
    result = list_assets(filters)
    return {"ok": True, "assets": result["assets"], "count": result["count"]}


def list_comparisons(filters: dict[str, str] | None = None) -> dict[str, Any]:
    status = (filters or {}).get("status", "active")
    params: tuple[Any, ...] = ()
    where = ""
    if status:
        where = "WHERE cs.status = ?"
        params = (status,)
    with db() as con:
        comparisons = rows(
            con,
            f"""
            SELECT
              cs.*,
              COUNT(csi.asset_id) AS asset_count,
              SUM(CASE WHEN ma.status = 'approved' THEN 1 ELSE 0 END) AS approved_count
            FROM comparison_sets cs
            LEFT JOIN comparison_set_items csi ON csi.comparison_id = cs.comparison_id
            LEFT JOIN media_assets ma ON ma.asset_id = csi.asset_id
            {where}
            GROUP BY cs.comparison_id
            ORDER BY cs.updated_at DESC
            LIMIT 100
            """,
            params,
        )
    return {"ok": True, "comparisons": comparisons}


def ensure_tag(con: sqlite3.Connection, name: str, category: str = "asset") -> str:
    tag = row(con, "SELECT tag_id FROM tags WHERE name = ?", (name,))
    if tag:
        return tag["tag_id"]
    tag_id = new_id("tag")
    con.execute("INSERT INTO tags (tag_id, name, category) VALUES (?, ?, ?)", (tag_id, name, category))
    return tag_id


def request_json(url: str, timeout: float = 1.5) -> tuple[bool, Any]:
    try:
        with urlopen(url, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return True, json.loads(raw) if raw else {}
    except Exception as exc:
        return False, str(exc)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_workflow_json(relative_path: str) -> dict[str, Any]:
    workflow_path = (ROOT / relative_path).resolve()
    if not workflow_path.exists() or ROOT not in workflow_path.parents:
        raise ValueError("workflow file is outside the workspace or missing")
    return json.loads(workflow_path.read_text(encoding="utf-8"))


def workflow_nodes(workflow_json: dict[str, Any]) -> list[dict[str, Any]]:
    nodes = []
    for node_id, node in workflow_json.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            inputs = {}
        meta = node.get("_meta", {}) if isinstance(node.get("_meta"), dict) else {}
        nodes.append(
            {
                "node_id": str(node_id),
                "title": meta.get("title") or node.get("class_type") or str(node_id),
                "class_type": node.get("class_type", ""),
                "inputs": inputs,
            }
        )
    return nodes


def infer_input_type(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, list):
        return "link"
    return "text"


def candidate_score(
    field_key: str,
    class_type: str,
    input_key: str,
    title: str,
    node_id: str,
    positive_nodes: set[str],
    negative_nodes: set[str],
) -> int:
    haystack = f"{class_type} {input_key} {title}".lower()
    class_lower = class_type.lower()
    if field_key == "positive_prompt":
        if "cliptextencode" not in class_lower or input_key != "text":
            return 0
        return 8 if node_id in positive_nodes else 2
    if field_key == "negative_prompt":
        if "cliptextencode" not in class_lower or input_key != "text":
            return 0
        return 8 if node_id in negative_nodes else 2
    exact_rules = {
        "seed": ("ksampler", {"seed", "noise_seed"}),
        "steps": ("ksampler", {"steps"}),
        "cfg": ("ksampler", {"cfg"}),
        "sampler": ("ksampler", {"sampler_name"}),
        "scheduler": ("ksampler", {"scheduler"}),
        "width": ("emptylatentimage", {"width"}),
        "height": ("emptylatentimage", {"height"}),
        "checkpoint": ("checkpointloadersimple", {"ckpt_name"}),
        "lora": ("loraloader", {"lora_name"}),
        "output": ("saveimage", {"filename_prefix"}),
    }
    class_token, input_keys = exact_rules.get(field_key, ("", set()))
    if class_token and class_token in class_lower and input_key in input_keys:
        return 6
    if field_key in {"checkpoint", "lora"} and input_key in input_keys:
        return 2
    return 0


def detect_mapping_candidates(workflow_json: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    fields = [
        "positive_prompt",
        "negative_prompt",
        "seed",
        "width",
        "height",
        "steps",
        "cfg",
        "sampler",
        "scheduler",
        "checkpoint",
        "lora",
        "output",
    ]
    candidates: dict[str, list[dict[str, Any]]] = {field: [] for field in fields}
    positive_nodes: set[str] = set()
    negative_nodes: set[str] = set()
    for node in workflow_nodes(workflow_json):
        if "ksampler" not in node["class_type"].lower():
            continue
        positive = node["inputs"].get("positive")
        negative = node["inputs"].get("negative")
        if isinstance(positive, list) and positive:
            positive_nodes.add(str(positive[0]))
        if isinstance(negative, list) and negative:
            negative_nodes.add(str(negative[0]))
    for node in workflow_nodes(workflow_json):
        for input_key, value in node["inputs"].items():
            for field in fields:
                score = candidate_score(
                    field,
                    node["class_type"],
                    input_key,
                    node["title"],
                    node["node_id"],
                    positive_nodes,
                    negative_nodes,
                )
                if score <= 0:
                    continue
                candidates[field].append(
                    {
                        "node_id": node["node_id"],
                        "input_key": input_key,
                        "input_type": infer_input_type(value),
                        "class_type": node["class_type"],
                        "title": node["title"],
                        "current_value": value if not isinstance(value, list) else "[link]",
                        "score": score,
                    }
                )
    for field in candidates:
        candidates[field].sort(key=lambda item: item["score"], reverse=True)
    return candidates


def field_value(field_key: str, prompt: str, negative: str, parameters: dict[str, Any]) -> Any:
    if field_key == "positive_prompt":
        return prompt
    if field_key == "negative_prompt":
        return negative
    if field_key == "seed":
        seed = parameters.get("seed", "random")
        if seed in ("", None, "random"):
            return random.randint(0, 2**32 - 1)
        return int(seed)
    if field_key == "width":
        return int(parameters.get("width") or 1024)
    if field_key == "height":
        return int(parameters.get("height") or 1024)
    if field_key == "steps":
        return int(parameters.get("steps") or 20)
    if field_key == "cfg":
        return float(parameters.get("cfg") or 7)
    if field_key == "sampler":
        return parameters.get("sampler") or None
    if field_key == "scheduler":
        return parameters.get("scheduler") or None
    if field_key == "checkpoint":
        return parameters.get("model") or None
    if field_key == "lora":
        return parameters.get("lora") or None
    if field_key == "output":
        return parameters.get("filename_prefix") or "studio"
    return None


def apply_mappings(
    workflow_json: dict[str, Any],
    mappings: list[dict[str, Any]],
    prompt: str,
    negative: str,
    parameters: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    prepared = json.loads(json.dumps(workflow_json))
    applied: list[str] = []
    for mapping in mappings:
        field_key = mapping["field_key"]
        value = field_value(field_key, prompt, negative, parameters)
        if value in (None, "") and field_key not in REQUIRED_MAPPINGS:
            continue
        node_id = str(mapping["node_id"])
        input_key = mapping["input_key"]
        if node_id not in prepared or "inputs" not in prepared[node_id]:
            raise ValueError(f"Mapping target not found: {field_key}")
        prepared[node_id]["inputs"][input_key] = value
        applied.append(field_key)
    return prepared, applied


def missing_required_mappings(mappings: list[dict[str, Any]], negative: str = "") -> list[str]:
    enabled = {mapping["field_key"] for mapping in mappings if mapping.get("is_enabled", 1)}
    required = set(REQUIRED_MAPPINGS)
    if negative:
        required.add("negative_prompt")
    return [field for field in sorted(required) if field not in enabled]


def media_type_for(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in IMAGE_EXTENSIONS:
        return "image"
    return "other"


def image_dimensions(path: Path) -> tuple[int | None, int | None]:
    try:
        from PIL import Image

        with Image.open(path) as image:
            return image.size
    except Exception:
        return None, None


def make_thumbnail(source: Path, asset_id: str) -> tuple[str | None, str | None]:
    try:
        from PIL import Image

        THUMBNAILS.mkdir(parents=True, exist_ok=True)
        thumb_name = f"{asset_id}.webp"
        thumb_path = THUMBNAILS / thumb_name
        with Image.open(source) as image:
            image.thumbnail((360, 360))
            image.save(thumb_path, "WEBP", quality=82)
        return "storage_studio_thumbnails", thumb_name
    except Exception:
        return None, None


def resolve_comfy_image(image_info: dict[str, Any]) -> Path:
    filename = image_info.get("filename")
    if not filename:
        raise ValueError("ComfyUI image output is missing filename")
    subfolder = image_info.get("subfolder") or ""
    image_type = image_info.get("type") or "output"
    if image_type == "input":
        base = ROOT / "input"
    elif image_type == "temp":
        base = ROOT / "ComfyUI" / "temp"
    else:
        base = ROOT / "output"
    direct = (base / subfolder / filename).resolve()
    if direct.exists():
        return direct
    if image_type == "output":
        matches = sorted((ROOT / "output").rglob(filename))
        if matches:
            return matches[0].resolve()
    return direct


def relative_to_storage(path: Path, storage_base: Path) -> str:
    try:
        return path.relative_to(storage_base).as_posix()
    except ValueError:
        return path.name


def strip_sensitive_query(url: str) -> str:
    parsed = urlparse(url)
    if not parsed.query:
        return url
    sensitive = {"token", "api_key", "apikey", "key", "Authorization", "authorization"}
    query = parse_qs(parsed.query, keep_blank_values=True)
    safe_pairs = []
    for key, values in query.items():
        if key in sensitive:
            continue
        for value in values:
            safe_pairs.append((key, value))
    from urllib.parse import urlencode

    return parsed._replace(query=urlencode(safe_pairs, doseq=True)).geturl()


def civitai_request(path: str) -> tuple[bool, Any]:
    headers = {"User-Agent": "AI-Media-Factory-Studio/0.1.7"}
    token = get_civitai_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = Request(f"{CIVITAI_API}{path}", headers=headers)
    try:
        with urlopen(req, timeout=8) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return True, json.loads(raw) if raw else {}
    except Exception as exc:
        return False, str(exc)


def parse_civitai_url(value: str) -> dict[str, str]:
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Civitai URL must start with http:// or https://")
    host = parsed.netloc.lower()
    if host not in {"civitai.com", "www.civitai.com"}:
        raise ValueError("Only civitai.com URLs are supported")
    path_parts = [part for part in parsed.path.split("/") if part]
    query = parse_qs(parsed.query)
    result: dict[str, str] = {}
    if len(path_parts) >= 2 and path_parts[0] == "models" and path_parts[1].isdigit():
        result["model_id"] = path_parts[1]
        if query.get("modelVersionId") and query["modelVersionId"][0].isdigit():
            result["version_id"] = query["modelVersionId"][0]
        return result
    if len(path_parts) >= 3 and path_parts[:2] == ["api", "download"] and path_parts[2] == "models":
        if len(path_parts) >= 4 and path_parts[3].isdigit():
            result["version_id"] = path_parts[3]
            return result
    if len(path_parts) >= 3 and path_parts[:2] == ["api", "v1"]:
        if path_parts[2] == "model-versions" and len(path_parts) >= 4 and path_parts[3].isdigit():
            result["version_id"] = path_parts[3]
            return result
        if path_parts[2] == "models" and len(path_parts) >= 4 and path_parts[3].isdigit():
            result["model_id"] = path_parts[3]
            return result
    raise ValueError("Unsupported Civitai URL format")


def summarize_civitai_model(model: dict[str, Any] | None, version: dict[str, Any] | None, source_url: str) -> dict[str, Any]:
    model = model or {}
    version = version or {}
    files = version.get("files") if isinstance(version.get("files"), list) else []
    primary_file = next((item for item in files if item.get("primary")), None) or (files[0] if files else {})
    safe_files = []
    for item in files:
        safe_files.append(
            {
                "name": item.get("name"),
                "type": item.get("type"),
                "size_kb": item.get("sizeKB"),
                "pickle_scan_result": item.get("pickleScanResult"),
                "virus_scan_result": item.get("virusScanResult"),
                "download_url": strip_sensitive_query(item.get("downloadUrl") or ""),
                "hashes": item.get("hashes") or {},
            }
        )
    return {
        "source_url": strip_sensitive_query(source_url),
        "model": {
            "id": model.get("id") or version.get("modelId"),
            "name": model.get("name") or version.get("model", {}).get("name"),
            "type": model.get("type") or version.get("model", {}).get("type"),
            "nsfw": model.get("nsfw"),
            "creator": (model.get("creator") or {}).get("username") if isinstance(model.get("creator"), dict) else None,
            "tags": model.get("tags") or [],
        },
        "version": {
            "id": version.get("id"),
            "name": version.get("name"),
            "base_model": version.get("baseModel"),
            "published_at": version.get("publishedAt"),
            "trained_words": version.get("trainedWords") or [],
            "download_url": strip_sensitive_query(
                version.get("downloadUrl") or primary_file.get("downloadUrl") or f"https://civitai.com/api/download/models/{version.get('id')}"
            ),
            "files": safe_files,
        },
    }


def lookup_civitai_model(payload: dict[str, Any]) -> dict[str, Any]:
    source_url = str(payload.get("url") or "").strip()
    if not source_url:
        raise ValueError("Civitai URL is required")
    parsed = parse_civitai_url(source_url)
    model = None
    version = None
    if parsed.get("version_id"):
        ok, version_payload = civitai_request(f"/model-versions/{parsed['version_id']}")
        if not ok:
            raise ValueError(f"Civitai version lookup failed: {version_payload}")
        version = version_payload
        model_id = parsed.get("model_id") or str(version.get("modelId") or "")
        if model_id:
            ok, model_payload = civitai_request(f"/models/{model_id}")
            if ok:
                model = model_payload
    if not version and parsed.get("model_id"):
        ok, model_payload = civitai_request(f"/models/{parsed['model_id']}")
        if not ok:
            raise ValueError(f"Civitai model lookup failed: {model_payload}")
        model = model_payload
        versions = model.get("modelVersions") if isinstance(model.get("modelVersions"), list) else []
        if versions:
            version = versions[0]
    if not model and not version:
        raise ValueError("Civitai metadata was not found")
    return {"ok": True, "civitai": summarize_civitai_model(model, version, source_url)}


def post_json(url: str, payload: dict[str, Any], timeout: float = 5.0) -> tuple[bool, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return True, json.loads(raw) if raw else {}
    except Exception as exc:
        return False, str(exc)


def connection_state(con: sqlite3.Connection) -> dict[str, Any]:
    comfy_endpoint = get_setting(con, "comfy_endpoint", DEFAULT_COMFY)
    ollama_endpoint = get_setting(con, "ollama_endpoint", DEFAULT_OLLAMA)
    comfy_ok, comfy_payload = request_json(f"{comfy_endpoint}/system_stats")
    ollama_ok, ollama_payload = request_json(f"{ollama_endpoint}/api/tags")
    return {
        "comfyui": {
            "endpoint": comfy_endpoint,
            "ok": comfy_ok,
            "detail": "connected" if comfy_ok else str(comfy_payload),
        },
        "ollama": {
            "endpoint": ollama_endpoint,
            "ok": ollama_ok,
            "models": [m.get("name") for m in ollama_payload.get("models", [])] if ollama_ok else [],
            "detail": "connected" if ollama_ok else str(ollama_payload),
        },
    }


def git_state() -> dict[str, Any]:
    try:
        proc = subprocess.run(
            ["git", "-C", str(ROOT), "status", "--short", "--branch"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        return {
            "ok": proc.returncode == 0,
            "output": proc.stdout.strip() if proc.returncode == 0 else proc.stderr.strip(),
        }
    except Exception as exc:
        return {"ok": False, "output": str(exc)}


def diagnostics_summary(
    con: sqlite3.Connection,
    connections: dict[str, Any] | None = None,
    git: dict[str, Any] | None = None,
    storage: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    connections = connections or connection_state(con)
    git = git or git_state()
    output_root = configured_comfy_output_root(con)
    storage = storage or [
        storage_status(item, output_root)
        for item in rows(con, "SELECT * FROM storage_locations ORDER BY content_scope, is_default DESC, name")
    ]
    job_statuses = rows(con, "SELECT status, COUNT(*) AS count FROM generation_jobs GROUP BY status ORDER BY status")
    counts = {
        "jobs": row(con, "SELECT COUNT(*) AS count FROM generation_jobs")["count"],
        "assets": row(con, "SELECT COUNT(*) AS count FROM media_assets")["count"],
        "outputs": row(con, "SELECT COUNT(*) AS count FROM generation_job_outputs")["count"],
        "workflows": row(con, "SELECT COUNT(*) AS count FROM workflows")["count"],
        "recipes": row(con, "SELECT COUNT(*) AS count FROM recipes")["count"],
    }
    active_jobs = rows(
        con,
        """
        SELECT job_id, status, comfy_prompt_id, created_at, updated_at, error_message
        FROM generation_jobs
        WHERE status IN ('submitted', 'running')
        ORDER BY created_at DESC
        LIMIT 20
        """,
    )
    resync_candidates = rows(
        con,
        """
        SELECT job_id, status, comfy_prompt_id, updated_at
        FROM generation_jobs
        WHERE comfy_prompt_id IS NOT NULL AND status IN ('submitted', 'running', 'failed')
        ORDER BY updated_at DESC
        LIMIT 50
        """,
    )
    prompt_id_missing = rows(
        con,
        """
        SELECT job_id, status, created_at
        FROM generation_jobs
        WHERE status IN ('submitted', 'running') AND comfy_prompt_id IS NULL
        ORDER BY created_at DESC
        LIMIT 20
        """,
    )

    enabled_mappings = rows(
        con,
        "SELECT workflow_id, field_key FROM workflow_input_mappings WHERE is_enabled = 1 ORDER BY workflow_id, field_key",
    )
    mapping_fields: dict[str, set[str]] = {}
    for item in enabled_mappings:
        mapping_fields.setdefault(item["workflow_id"], set()).add(item["field_key"])
    missing_mappings = []
    for workflow in rows(con, "SELECT workflow_id, name, status FROM workflows ORDER BY updated_at DESC"):
        missing = [field for field in REQUIRED_MAPPINGS if field not in mapping_fields.get(workflow["workflow_id"], set())]
        if missing:
            missing_mappings.append({"workflow_id": workflow["workflow_id"], "name": workflow["name"], "missing": missing})

    storage_issues = []
    for item in storage:
        if not item.get("is_enabled", 1):
            continue
        adult_generated = item.get("content_scope") == "adult_local" and item.get("usage_type") == "generated"
        unavailable = not item.get("path_exists") or not item.get("writable")
        scope_risk = adult_generated and item.get("last_validation_result") not in (None, "ok")
        if unavailable or scope_risk:
            storage_issues.append(
                {
                    "storage_id": item["storage_id"],
                    "name": item["name"],
                    "content_scope": item.get("content_scope"),
                    "validation": item.get("last_validation_result"),
                    "path_exists": item.get("path_exists"),
                    "writable": item.get("writable"),
                }
            )
    adult_storage_ok = any(
        item.get("content_scope") == "adult_local"
        and item.get("is_enabled", 1)
        and item.get("path_exists")
        and item.get("writable")
        and item.get("is_comfy_output_compatible")
        for item in storage
    )

    warnings = []
    if not connections.get("comfyui", {}).get("ok"):
        warnings.append("ComfyUI is not connected.")
    if not connections.get("ollama", {}).get("ok"):
        warnings.append("Ollama is not connected.")
    if not git.get("ok"):
        warnings.append("Git status could not be read.")
    if active_jobs:
        warnings.append(f"{len(active_jobs)} generation job(s) are submitted or running.")
    if prompt_id_missing:
        warnings.append("Some active jobs do not have a ComfyUI prompt_id.")
    if missing_mappings:
        warnings.append("Some workflows are missing required input mappings.")
    if storage_issues:
        warnings.append("Some enabled storage locations need attention.")
    if not adult_storage_ok:
        warnings.append("Adult Local storage is not fully ready.")

    migrations = rows(con, "SELECT version, applied_at FROM schema_migrations ORDER BY version")
    return {
        "generated_at": now_iso(),
        "app": {"version": APP_VERSION},
        "connections": connections,
        "git": git,
        "database": {
            "path": str(DB_PATH),
            "exists": DB_PATH.exists(),
            "size_bytes": DB_PATH.stat().st_size if DB_PATH.exists() else 0,
            "migrations": migrations,
        },
        "counts": counts,
        "job_statuses": job_statuses,
        "active_jobs": active_jobs,
        "resync_candidates": resync_candidates,
        "prompt_id_missing": prompt_id_missing,
        "missing_mappings": missing_mappings,
        "storage_issues": storage_issues,
        "adult_storage_ok": adult_storage_ok,
        "warnings": warnings,
    }


def diagnostics() -> dict[str, Any]:
    with db() as con:
        return {"ok": True, "diagnostics": diagnostics_summary(con)}


def setup_status() -> dict[str, Any]:
    launcher = ROOT / "scripts" / "start_studio.ps1"
    with db() as con:
        connections = connection_state(con)
        output_root = configured_comfy_output_root(con)
        storage = [
            storage_status(item, output_root)
            for item in rows(con, "SELECT * FROM storage_locations ORDER BY content_scope, is_default DESC, name")
        ]
        asset_locations = rows(con, "SELECT asset_kind, COUNT(*) AS count FROM asset_registry_locations WHERE is_enabled = 1 GROUP BY asset_kind")
        asset_items = rows(con, "SELECT asset_kind, COUNT(*) AS count FROM asset_registry_items WHERE missing = 0 GROUP BY asset_kind")
        workflow_requirements = rows(con, "SELECT status, asset_kind, COUNT(*) AS count FROM workflow_asset_requirements GROUP BY status, asset_kind")
        backups = list_database_backups()["backups"]
        setup_preferences = get_setting(con, "setup_wizard", {"completed": False, "dismissed": False})
        storage_ready = sum(1 for item in storage if item.get("path_exists") and item.get("writable"))
        storage_issues = [
            {
                "name": item["name"],
                "content_scope": item.get("content_scope"),
                "validation": item.get("last_validation_result"),
            }
            for item in storage
            if item.get("is_enabled") and (not item.get("path_exists") or not item.get("writable"))
        ]
        missing_requirements = sum(int(item["count"]) for item in workflow_requirements if item["status"] == "missing")
        detected_requirements = sum(int(item["count"]) for item in workflow_requirements)
        civitai = civitai_config_status()["civitai"]
        steps = [
            {
                "key": "launcher",
                "label": "Studio起動",
                "status": "ok" if launcher.exists() else "warn",
                "detail": "起動スクリプトを確認済み" if launcher.exists() else "起動スクリプトが見つかりません",
                "required": True,
                "action": "launcher",
            },
            {
                "key": "comfyui",
                "label": "ComfyUI接続",
                "status": "ok" if connections.get("comfyui", {}).get("ok") else "warn",
                "detail": connections.get("comfyui", {}).get("detail") or connections.get("comfyui", {}).get("endpoint"),
                "required": True,
                "action": "settings",
            },
            {
                "key": "ollama",
                "label": "Ollama接続",
                "status": "ok" if connections.get("ollama", {}).get("ok") else "warn",
                "detail": connections.get("ollama", {}).get("detail") or connections.get("ollama", {}).get("endpoint"),
                "required": False,
                "action": "settings",
            },
            {
                "key": "database_backup",
                "label": "DBバックアップ",
                "status": "ok" if backups else "warn",
                "detail": f"{len(backups)} backup(s)",
                "required": True,
                "action": "backup",
            },
            {
                "key": "storage",
                "label": "保存先",
                "status": "ok" if storage_ready and not storage_issues else "warn",
                "detail": f"ready {storage_ready} / {len(storage)}",
                "required": True,
                "action": "storage",
            },
            {
                "key": "asset_registry",
                "label": "資産台帳",
                "status": "ok" if asset_items else "warn",
                "detail": f"{sum(int(item['count']) for item in asset_items)} item(s)",
                "required": True,
                "action": "models",
            },
            {
                "key": "workflow_requirements",
                "label": "Workflow必要資産",
                "status": "ok" if detected_requirements and not missing_requirements else "warn",
                "detail": f"detected {detected_requirements}, missing {missing_requirements}",
                "required": False,
                "action": "workflow_scan",
            },
            {
                "key": "civitai",
                "label": "Civitai API Key",
                "status": "ok" if civitai.get("has_token") else "info",
                "detail": civitai.get("source") or "none",
                "required": False,
                "action": "models",
            },
        ]
        return {
            "ok": True,
            "setup": {
                "version": APP_VERSION,
                "local_first": True,
                "preferences": setup_preferences,
                "steps": steps,
                "database": {
                    "exists": DB_PATH.exists(),
                    "path": str(DB_PATH),
                    "size_bytes": DB_PATH.stat().st_size if DB_PATH.exists() else 0,
                    "backup_dir": str(DATA / "backups"),
                    "backup_count": len(backups),
                },
                "launcher": {
                    "script": str(launcher),
                    "exists": launcher.exists(),
                    "url": "http://127.0.0.1:8765/",
                },
                "connections": connections,
                "storage": {
                    "total": len(storage),
                    "ready": storage_ready,
                    "issues": storage_issues,
                },
                "asset_registry": {
                    "locations": asset_locations,
                    "items": asset_items,
                    "workflow_requirements": workflow_requirements,
                },
            },
        }


def save_setup_wizard_state(payload: dict[str, Any]) -> dict[str, Any]:
    allowed = {"completed", "dismissed"}
    state = {key: bool(payload.get(key)) for key in allowed if key in payload}
    with db() as con:
        current = get_setting(con, "setup_wizard", {"completed": False, "dismissed": False})
        if not isinstance(current, dict):
            current = {"completed": False, "dismissed": False}
        current.update(state)
        current["updated_at"] = now_iso()
        set_setting(con, "setup_wizard", current)
    return setup_status()


def normalize_prompt_tag(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())


def split_prompt_tags(value: str) -> list[str]:
    tags = []
    for item in re.split(r"[,、\n\r]+", value or ""):
        tag = normalize_prompt_tag(item)
        if tag:
            tags.append(tag)
    return tags


def dedupe_prompt_tags(tags: list[str]) -> list[str]:
    normalized = []
    seen = set()
    for item in tags:
        tag = normalize_prompt_tag(item)
        key = tag.lower()
        if tag and key not in seen:
            normalized.append(tag)
            seen.add(key)
    return normalized


def cleanup_unconverted_token(value: str) -> str:
    token = PROMPT_PARTICLE_RE.sub("", value.strip())
    token = PROMPT_PARTICLE_RE.sub("", token)
    return token.strip()


def convert_prompt_text(text: str, terms: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
    working = str(text or "")
    tags: list[str] = []
    ordered_terms = sorted(
        [term for term in terms if term.get("is_enabled") and term.get("source_text") and term.get("target_text")],
        key=lambda term: (len(str(term["source_text"])), int(term.get("weight") or 0)),
        reverse=True,
    )
    for term in ordered_terms:
        source = str(term["source_text"]).strip()
        if source and source in working:
            tags.extend(split_prompt_tags(str(term["target_text"])))
            working = working.replace(source, " ")
    unconverted = []
    seen_unconverted = set()
    for raw in PROMPT_SPLIT_RE.split(working):
        token = cleanup_unconverted_token(raw)
        if token and token not in seen_unconverted:
            unconverted.append(token)
            seen_unconverted.add(token)
    return dedupe_prompt_tags(tags), unconverted


def list_prompt_translation_terms(query: str = "") -> list[dict[str, Any]]:
    params: tuple[Any, ...] = ()
    where = ""
    if query:
        where = "WHERE source_text LIKE ? OR target_text LIKE ? OR category LIKE ?"
        like = f"%{query}%"
        params = (like, like, like)
    with db() as con:
        return rows(
            con,
            f"""
            SELECT * FROM prompt_translation_terms
            {where}
            ORDER BY is_enabled DESC, category, length(source_text) DESC, source_text
            """,
            params,
        )


def list_prompt_translation_presets(enabled_only: bool = False) -> list[dict[str, Any]]:
    where = "WHERE is_enabled = 1" if enabled_only else ""
    with db() as con:
        return rows(
            con,
            f"""
            SELECT * FROM prompt_translation_presets
            {where}
            ORDER BY is_default DESC, name
            """,
        )


def list_prompt_translation_history(limit: int = 50) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit or 50), 200))
    with db() as con:
        history = rows(
            con,
            """
            SELECT h.*, p.name AS preset_name
            FROM prompt_translation_history h
            LEFT JOIN prompt_translation_presets p ON p.preset_id = h.preset_id
            ORDER BY h.created_at DESC
            LIMIT ?
            """,
            (safe_limit,),
        )
    for item in history:
        try:
            item["unconverted_terms"] = json.loads(item.get("unconverted_terms_json") or "[]")
        except json.JSONDecodeError:
            item["unconverted_terms"] = []
    return history


def prompt_translation_state() -> dict[str, Any]:
    return {
        "ok": True,
        "terms": list_prompt_translation_terms(),
        "presets": list_prompt_translation_presets(),
        "history": list_prompt_translation_history(30),
    }


def get_prompt_translation_preset(con: sqlite3.Connection, preset_id: str | None) -> dict[str, Any] | None:
    if preset_id:
        preset = row(con, "SELECT * FROM prompt_translation_presets WHERE preset_id = ? AND is_enabled = 1", (preset_id,))
        if preset:
            return preset
    return row(con, "SELECT * FROM prompt_translation_presets WHERE is_default = 1 AND is_enabled = 1 ORDER BY name LIMIT 1")


def convert_prompt_translation(payload: dict[str, Any]) -> dict[str, Any]:
    source_prompt = str(payload.get("source_prompt") or "")
    source_negative = str(payload.get("source_negative") or "")
    preset_id = str(payload.get("preset_id") or "").strip() or None
    with db() as con:
        terms = rows(con, "SELECT * FROM prompt_translation_terms WHERE is_enabled = 1")
        preset = get_prompt_translation_preset(con, preset_id)
        prompt_tags, prompt_unconverted = convert_prompt_text(source_prompt, terms)
        negative_tags, negative_unconverted = convert_prompt_text(source_negative, terms)
        if preset:
            prompt_tags.extend(split_prompt_tags(preset.get("append_prompt") or ""))
            negative_tags.extend(split_prompt_tags(preset.get("append_negative") or ""))
            preset_id = preset["preset_id"]
        translated_prompt = ", ".join(dedupe_prompt_tags(prompt_tags))
        translated_negative = ", ".join(dedupe_prompt_tags(negative_tags))
        unconverted = []
        for item in prompt_unconverted + negative_unconverted:
            if item not in unconverted:
                unconverted.append(item)
        history_id = new_id("pth")
        con.execute(
            """
            INSERT INTO prompt_translation_history
              (history_id, source_prompt, translated_prompt, source_negative, translated_negative, unconverted_terms_json, preset_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                history_id,
                source_prompt,
                translated_prompt,
                source_negative,
                translated_negative,
                json.dumps(unconverted, ensure_ascii=False),
                preset_id,
            ),
        )
    return {
        "ok": True,
        "result": {
            "history_id": history_id,
            "source_prompt": source_prompt,
            "translated_prompt": translated_prompt,
            "source_negative": source_negative,
            "translated_negative": translated_negative,
            "unconverted_terms": unconverted,
            "preset_id": preset_id,
        },
    }


def create_prompt_translation_term(payload: dict[str, Any]) -> dict[str, Any]:
    source_text = str(payload.get("source_text") or "").strip()
    target_text = str(payload.get("target_text") or "").strip()
    if not source_text or not target_text:
        raise ValueError("source_text and target_text are required")
    category = str(payload.get("category") or "general").strip() or "general"
    weight = int(payload.get("weight") or 0)
    is_enabled = 1 if payload.get("is_enabled", True) else 0
    term_id = payload.get("term_id") or new_id("ptm")
    with db() as con:
        con.execute(
            """
            INSERT INTO prompt_translation_terms
              (term_id, source_text, target_text, category, weight, is_enabled, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(source_text) DO UPDATE SET
              target_text = excluded.target_text,
              category = excluded.category,
              weight = excluded.weight,
              is_enabled = excluded.is_enabled,
              updated_at = datetime('now')
            """,
            (term_id, source_text, target_text, category, weight, is_enabled),
        )
        saved = row(con, "SELECT * FROM prompt_translation_terms WHERE source_text = ?", (source_text,))
    return {"ok": True, "term": saved}


def update_prompt_translation_term(term_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    allowed = {"source_text", "target_text", "category", "weight", "is_enabled"}
    updates = []
    params: list[Any] = []
    for key in allowed:
        if key not in payload:
            continue
        value = payload[key]
        if key in {"source_text", "target_text", "category"}:
            value = str(value or "").strip()
            if key in {"source_text", "target_text"} and not value:
                raise ValueError(f"{key} is required")
        if key == "weight":
            value = int(value or 0)
        if key == "is_enabled":
            value = 1 if value else 0
        updates.append(f"{key} = ?")
        params.append(value)
    if not updates:
        raise ValueError("no fields to update")
    params.append(term_id)
    with db() as con:
        con.execute(
            f"UPDATE prompt_translation_terms SET {', '.join(updates)}, updated_at = datetime('now') WHERE term_id = ?",
            tuple(params),
        )
        saved = row(con, "SELECT * FROM prompt_translation_terms WHERE term_id = ?", (term_id,))
    if not saved:
        raise ValueError("term not found")
    return {"ok": True, "term": saved}


def create_prompt_translation_preset(payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("name is required")
    preset_id = payload.get("preset_id") or new_id("pts")
    with db() as con:
        con.execute(
            """
            INSERT INTO prompt_translation_presets
              (preset_id, name, append_prompt, append_negative, is_default, is_enabled, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(name) DO UPDATE SET
              append_prompt = excluded.append_prompt,
              append_negative = excluded.append_negative,
              is_default = excluded.is_default,
              is_enabled = excluded.is_enabled,
              updated_at = datetime('now')
            """,
            (
                preset_id,
                name,
                str(payload.get("append_prompt") or ""),
                str(payload.get("append_negative") or ""),
                1 if payload.get("is_default") else 0,
                1 if payload.get("is_enabled", True) else 0,
            ),
        )
        saved = row(con, "SELECT * FROM prompt_translation_presets WHERE name = ?", (name,))
    return {"ok": True, "preset": saved}


def update_prompt_translation_preset(preset_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    allowed = {"name", "append_prompt", "append_negative", "is_default", "is_enabled"}
    updates = []
    params: list[Any] = []
    for key in allowed:
        if key not in payload:
            continue
        value = payload[key]
        if key in {"name", "append_prompt", "append_negative"}:
            value = str(value or "").strip()
            if key == "name" and not value:
                raise ValueError("name is required")
        if key in {"is_default", "is_enabled"}:
            value = 1 if value else 0
        updates.append(f"{key} = ?")
        params.append(value)
    if not updates:
        raise ValueError("no fields to update")
    params.append(preset_id)
    with db() as con:
        con.execute(
            f"UPDATE prompt_translation_presets SET {', '.join(updates)}, updated_at = datetime('now') WHERE preset_id = ?",
            tuple(params),
        )
        saved = row(con, "SELECT * FROM prompt_translation_presets WHERE preset_id = ?", (preset_id,))
    if not saved:
        raise ValueError("preset not found")
    return {"ok": True, "preset": saved}


def discover_workflows() -> list[dict[str, Any]]:
    base = ROOT / "workflows"
    if not base.exists():
        return []
    found = []
    for path in sorted(base.rglob("*.json")):
        try:
            rel = path.relative_to(ROOT).as_posix()
        except ValueError:
            rel = str(path)
        found.append({"name": path.stem, "relative_path": rel, "size": path.stat().st_size})
    return found


def bootstrap() -> dict[str, Any]:
    with db() as con:
        output_root = configured_comfy_output_root(con)
        storage = [
            storage_status(item, output_root)
            for item in rows(con, "SELECT * FROM storage_locations ORDER BY content_scope, is_default DESC, name")
        ]
        connections = connection_state(con)
        git = git_state()
        workflows = rows(con, "SELECT * FROM workflows ORDER BY updated_at DESC")
        jobs = rows(con, "SELECT * FROM generation_jobs ORDER BY created_at DESC LIMIT 30")
        mappings = rows(con, "SELECT * FROM workflow_input_mappings WHERE is_enabled = 1 ORDER BY workflow_id, field_key")
        outputs = rows(con, "SELECT * FROM generation_job_outputs ORDER BY created_at DESC LIMIT 100")
        assets = rows(
            con,
            """
            SELECT
              ma.*,
              go.source_path,
              go.file_name,
              go.width AS output_width,
              go.height AS output_height,
              gj.prompt,
              gj.negative_prompt,
              gj.parameters_json,
              gj.output_prefix,
              gj.workflow_id,
              wf.name AS workflow_name
            FROM media_assets ma
            LEFT JOIN generation_jobs gj ON gj.job_id = ma.source_job_id
            LEFT JOIN generation_job_outputs go ON go.asset_id = ma.asset_id
            LEFT JOIN workflows wf ON wf.workflow_id = gj.workflow_id
            ORDER BY ma.created_at DESC
            LIMIT 60
            """,
        )
        hydrate_assets(con, assets)
        recipes = rows(
            con,
            """
            SELECT
              r.*,
              wf.name AS workflow_name,
              ma.thumbnail_relative_path AS source_thumbnail
            FROM recipes r
            LEFT JOIN workflows wf ON wf.workflow_id = r.workflow_id
            LEFT JOIN media_assets ma ON ma.asset_id = r.source_asset_id
            ORDER BY r.updated_at DESC
            LIMIT 100
            """,
        )
        for recipe in recipes:
            recipe["tags"] = recipe_tags(con, recipe["recipe_id"])
        discovered = discover_workflows()
        return {
            "app": {"name": "AI Media Factory Studio", "version": APP_VERSION},
            "connections": connections,
            "git": git,
            "storage": storage,
            "workflows": workflows,
            "mappings": mappings,
            "discovered_workflows": discovered,
            "jobs": jobs,
            "outputs": outputs,
            "assets": assets,
            "recipes": recipes,
            "comparisons": list_comparisons({})["comparisons"],
            "tags": rows(con, "SELECT * FROM tags ORDER BY name"),
            "panel_state": get_setting(con, "panel_state", {}),
            "asset_registry": {
                "locations": [
                    asset_registry_location_status(item)
                    for item in rows(con, "SELECT * FROM asset_registry_locations ORDER BY asset_kind, name")
                ],
                "items": rows(
                    con,
                    """
                    SELECT i.*, l.name AS location_name, l.base_path AS location_base_path
                    FROM asset_registry_items i
                    LEFT JOIN asset_registry_locations l ON l.location_id = i.location_id
                    ORDER BY i.asset_kind, i.missing, i.name
                    LIMIT 500
                    """,
                ),
                "scan_runs": rows(con, "SELECT * FROM asset_scan_runs ORDER BY started_at DESC LIMIT 20"),
                "requirements": rows(
                    con,
                    """
                    SELECT r.*, i.name AS matched_name, i.relative_path AS matched_relative_path
                    FROM workflow_asset_requirements r
                    LEFT JOIN asset_registry_items i ON i.item_id = r.matched_item_id
                    ORDER BY r.status DESC, r.workflow_name, r.asset_kind, r.asset_name
                    LIMIT 500
                    """,
                ),
            },
            "prompt_translation": {
                "terms": rows(
                    con,
                    """
                    SELECT * FROM prompt_translation_terms
                    ORDER BY is_enabled DESC, category, length(source_text) DESC, source_text
                    """,
                ),
                "presets": rows(
                    con,
                    """
                    SELECT * FROM prompt_translation_presets
                    ORDER BY is_default DESC, name
                    """,
                ),
                "history": rows(
                    con,
                    """
                    SELECT h.*, p.name AS preset_name
                    FROM prompt_translation_history h
                    LEFT JOIN prompt_translation_presets p ON p.preset_id = h.preset_id
                    ORDER BY h.created_at DESC
                    LIMIT 30
                    """,
                ),
            },
            "diagnostics": diagnostics_summary(con, connections, git, storage),
        }


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        if path == "/" or not path.startswith("/api/"):
            cleaned = path.split("?", 1)[0].split("#", 1)[0]
            if cleaned == "/":
                cleaned = "/index.html"
            return str((STATIC / cleaned.lstrip("/")).resolve())
        return super().translate_path(path)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, payload: Any, status: int = 200) -> None:
        raw = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw else {}

    def do_GET(self) -> None:
        if self.path.startswith("/api/bootstrap"):
            self.send_json(bootstrap())
            return
        if self.path == "/api/assets" or self.path.startswith("/api/assets?"):
            self.send_json(list_assets(parse_query_params(self.path)))
            return
        if self.path == "/api/board" or self.path.startswith("/api/board?"):
            self.send_json(board_assets(parse_query_params(self.path)))
            return
        if self.path == "/api/storage":
            self.send_json(list_storage_locations())
            return
        if self.path == "/api/asset-registry":
            self.send_json(list_asset_registry())
            return
        if self.path == "/api/asset-registry/workflow-requirements":
            self.send_json(list_workflow_asset_requirements())
            return
        if self.path.startswith("/api/civitai/download-jobs/"):
            job_id = self.path.split("/")[4]
            try:
                self.send_json(get_civitai_download_job(job_id))
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 404)
            return
        if self.path == "/api/comparisons" or self.path.startswith("/api/comparisons?"):
            self.send_json(list_comparisons(parse_query_params(self.path)))
            return
        if self.path.startswith("/api/health"):
            with db() as con:
                self.send_json({"connections": connection_state(con), "git": git_state()})
            return
        if self.path == "/api/diagnostics":
            self.send_json(diagnostics())
            return
        if self.path == "/api/setup/status":
            self.send_json(setup_status())
            return
        if self.path == "/api/database/backups":
            self.send_json(list_database_backups())
            return
        if self.path == "/api/prompt-translation":
            self.send_json(prompt_translation_state())
            return
        if self.path == "/api/prompt-translation/terms" or self.path.startswith("/api/prompt-translation/terms?"):
            self.send_json({"ok": True, "terms": list_prompt_translation_terms(parse_query_params(self.path).get("q", ""))})
            return
        if self.path == "/api/prompt-translation/presets":
            self.send_json({"ok": True, "presets": list_prompt_translation_presets()})
            return
        if self.path == "/api/prompt-translation/history" or self.path.startswith("/api/prompt-translation/history?"):
            limit = parse_query_params(self.path).get("limit", "50")
            self.send_json({"ok": True, "history": list_prompt_translation_history(int(limit or 50))})
            return
        if self.path == "/api/civitai/config":
            self.send_json(civitai_config_status())
            return
        if self.path.startswith("/api/workflows/") and self.path.endswith("/mapping/candidates"):
            workflow_id = self.path.split("/")[3]
            self.send_json(get_mapping_candidates(workflow_id))
            return
        if self.path.startswith("/api/workflows/") and self.path.endswith("/mapping"):
            workflow_id = self.path.split("/")[3]
            self.send_json(get_workflow_mapping(workflow_id))
            return
        if self.path.startswith("/api/assets/") and self.path.endswith("/thumbnail"):
            asset_id = self.path.split("/")[3]
            self.send_file_response(asset_thumbnail_path(asset_id))
            return
        if self.path.startswith("/api/assets/") and self.path.endswith("/file"):
            asset_id = self.path.split("/")[3]
            self.send_file_response(asset_file_path(asset_id))
            return
        if self.path.startswith("/api/assets/"):
            asset_id = self.path.split("/")[3]
            self.send_json(get_asset_detail(asset_id))
            return
        if self.path.startswith("/api/recipes/"):
            recipe_id = self.path.split("/")[3]
            self.send_json(get_recipe_detail(recipe_id))
            return
        if self.path.startswith("/api/comparisons/"):
            comparison_id = self.path.split("/")[3]
            self.send_json(get_comparison(comparison_id))
            return
        super().do_GET()

    def do_POST(self) -> None:
        try:
            if self.path == "/api/shutdown":
                client_host = self.client_address[0]
                if client_host not in LOCAL_SHUTDOWN_HOSTS:
                    self.send_json({"error": "shutdown is only available from localhost"}, 403)
                    return
                self.send_json({"ok": True, "message": "AI Media Factory Studio is shutting down."})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if self.path == "/api/workflows/register":
                self.send_json(register_workflow(self.read_body()))
                return
            if self.path.startswith("/api/workflows/") and self.path.endswith("/mapping"):
                workflow_id = self.path.split("/")[3]
                self.send_json(save_workflow_mapping(workflow_id, self.read_body()))
                return
            if self.path == "/api/generate":
                self.send_json(create_generation_job(self.read_body()))
                return
            if self.path == "/api/jobs/poll":
                self.send_json(poll_submitted_jobs())
                return
            if self.path == "/api/jobs/resync":
                self.send_json(resync_generation_jobs(self.read_body()))
                return
            if self.path == "/api/database/backup":
                payload = self.read_body()
                reason = str(payload.get("reason") or "manual")
                self.send_json(create_database_backup(reason))
                return
            if self.path == "/api/database/restore":
                self.send_json(restore_database_backup(self.read_body()))
                return
            if self.path == "/api/setup/state":
                self.send_json(save_setup_wizard_state(self.read_body()))
                return
            if self.path == "/api/civitai/lookup":
                self.send_json(lookup_civitai_model(self.read_body()))
                return
            if self.path == "/api/civitai/download-plan":
                self.send_json(civitai_download_plan(self.read_body()))
                return
            if self.path == "/api/civitai/download":
                self.send_json(download_civitai_asset(self.read_body()))
                return
            if self.path == "/api/civitai/download-jobs":
                self.send_json(create_civitai_download_job(self.read_body()))
                return
            if self.path.startswith("/api/civitai/download-jobs/") and self.path.endswith("/cancel"):
                job_id = self.path.split("/")[4]
                self.send_json(cancel_civitai_download_job(job_id))
                return
            if self.path == "/api/civitai/config":
                self.send_json(save_civitai_config(self.read_body()))
                return
            if self.path == "/api/asset-registry/locations":
                self.send_json(create_asset_registry_location(self.read_body()))
                return
            if self.path == "/api/asset-registry/scan":
                self.send_json(scan_asset_registry(self.read_body()))
                return
            if self.path == "/api/asset-registry/workflow-requirements/scan":
                self.send_json(scan_workflow_asset_requirements(self.read_body()))
                return
            if self.path == "/api/asset-registry/apply-civitai":
                self.send_json(apply_civitai_to_asset_registry(self.read_body()))
                return
            if self.path == "/api/prompt-translation/convert":
                self.send_json(convert_prompt_translation(self.read_body()))
                return
            if self.path == "/api/prompt-translation/terms":
                self.send_json(create_prompt_translation_term(self.read_body()))
                return
            if self.path == "/api/prompt-translation/presets":
                self.send_json(create_prompt_translation_preset(self.read_body()))
                return
            if self.path == "/api/recipes":
                self.send_json(create_recipe(self.read_body()))
                return
            if self.path == "/api/storage":
                self.send_json(create_storage_location(self.read_body()))
                return
            if self.path == "/api/storage/test":
                self.send_json(test_storage_location(self.read_body()))
                return
            if self.path == "/api/comparisons":
                self.send_json(create_comparison(self.read_body()))
                return
            if self.path.startswith("/api/comparisons/") and self.path.endswith("/duplicate"):
                comparison_id = self.path.split("/")[3]
                self.send_json(duplicate_comparison(comparison_id))
                return
            if self.path.startswith("/api/comparisons/") and self.path.endswith("/archive"):
                comparison_id = self.path.split("/")[3]
                self.send_json(update_comparison(comparison_id, {"status": "archived"}))
                return
            if self.path.startswith("/api/recipes/") and self.path.endswith("/use"):
                recipe_id = self.path.split("/")[3]
                self.send_json(use_recipe(recipe_id))
                return
            if self.path.startswith("/api/recipes/") and self.path.endswith("/duplicate"):
                recipe_id = self.path.split("/")[3]
                self.send_json(duplicate_recipe(recipe_id))
                return
            if self.path == "/api/settings/panel-state":
                self.send_json(save_panel_state(self.read_body()))
                return
            if self.path.startswith("/api/jobs/") and self.path.endswith("/poll"):
                job_id = self.path.split("/")[3]
                self.send_json(poll_job(job_id))
                return
            if self.path.startswith("/api/jobs/") and self.path.endswith("/regenerate"):
                job_id = self.path.split("/")[3]
                self.send_json(regenerate_job(job_id))
                return
            self.send_json({"error": "not_found"}, 404)
        except Exception as exc:
            self.send_json({"error": str(exc)}, 500)

    def do_DELETE(self) -> None:
        try:
            if self.path == "/api/civitai/config":
                self.send_json(delete_civitai_config())
                return
            self.send_json({"error": "not_found"}, 404)
        except Exception as exc:
            self.send_json({"error": str(exc)}, 500)

    def send_file_response(self, path: Path | None) -> None:
        if not path or not path.exists() or not path.is_file():
            self.send_json({"error": "file_not_found"}, 404)
            return
        mime = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PATCH(self) -> None:
        try:
            if self.path.startswith("/api/asset-registry/items/"):
                item_id = self.path.split("/")[4]
                self.send_json(update_asset_registry_item(item_id, self.read_body()))
                return
            if self.path.startswith("/api/prompt-translation/terms/"):
                term_id = self.path.split("/")[4]
                self.send_json(update_prompt_translation_term(term_id, self.read_body()))
                return
            if self.path.startswith("/api/prompt-translation/presets/"):
                preset_id = self.path.split("/")[4]
                self.send_json(update_prompt_translation_preset(preset_id, self.read_body()))
                return
            if self.path.startswith("/api/assets/"):
                asset_id = self.path.split("/")[3]
                self.send_json(update_asset(asset_id, self.read_body()))
                return
            if self.path.startswith("/api/storage/"):
                storage_id = self.path.split("/")[3]
                self.send_json(update_storage_location(storage_id, self.read_body()))
                return
            if self.path.startswith("/api/comparisons/"):
                comparison_id = self.path.split("/")[3]
                self.send_json(update_comparison(comparison_id, self.read_body()))
                return
            if self.path.startswith("/api/recipes/"):
                recipe_id = self.path.split("/")[3]
                self.send_json(update_recipe(recipe_id, self.read_body()))
                return
            self.send_json({"error": "not_found"}, 404)
        except Exception as exc:
            self.send_json({"error": str(exc)}, 500)


def register_workflow(payload: dict[str, Any]) -> dict[str, Any]:
    relative_path = str(payload.get("relative_path", "")).replace("\\", "/")
    if not relative_path:
        raise ValueError("relative_path is required")
    path = (ROOT / relative_path).resolve()
    if not path.exists() or ROOT not in path.parents:
        raise ValueError("workflow file is outside the workspace or missing")
    workflow_id = payload.get("workflow_id") or new_id("wf")
    name = payload.get("name") or path.stem
    with db() as con:
        con.execute(
            """
            INSERT INTO workflows (workflow_id, name, relative_path, notes, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(relative_path) DO UPDATE SET
              name = excluded.name,
              notes = excluded.notes,
              updated_at = datetime('now')
            """,
            (workflow_id, name, relative_path, payload.get("notes")),
        )
        con.execute(
            "INSERT INTO audit_logs (audit_id, action, entity_type, entity_id, detail_json) VALUES (?, 'register', 'workflow', ?, ?)",
            (new_id("aud"), workflow_id, json.dumps({"relative_path": relative_path}, ensure_ascii=False)),
        )
    return {"ok": True, "workflow_id": workflow_id, "relative_path": relative_path}


def get_workflow_or_fail(con: sqlite3.Connection, workflow_id: str) -> dict[str, Any]:
    workflow = row(con, "SELECT * FROM workflows WHERE workflow_id = ?", (workflow_id,))
    if not workflow:
        raise ValueError("workflow not found")
    return workflow


def get_mapping_candidates(workflow_id: str) -> dict[str, Any]:
    with db() as con:
        workflow = get_workflow_or_fail(con, workflow_id)
    workflow_json = read_workflow_json(workflow["relative_path"])
    return {
        "workflow_id": workflow_id,
        "candidates": detect_mapping_candidates(workflow_json),
        "nodes": workflow_nodes(workflow_json),
    }


def get_workflow_mapping(workflow_id: str) -> dict[str, Any]:
    with db() as con:
        workflow = get_workflow_or_fail(con, workflow_id)
        mappings = rows(
            con,
            "SELECT * FROM workflow_input_mappings WHERE workflow_id = ? AND is_enabled = 1 ORDER BY field_key",
            (workflow_id,),
        )
    return {"workflow": workflow, "mappings": mappings}


def save_workflow_mapping(workflow_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    mappings = payload.get("mappings", [])
    if not isinstance(mappings, list):
        raise ValueError("mappings must be a list")
    with db() as con:
        get_workflow_or_fail(con, workflow_id)
        con.execute("UPDATE workflow_input_mappings SET is_enabled = 0, updated_at = datetime('now') WHERE workflow_id = ?", (workflow_id,))
        saved = []
        for item in mappings:
            field_key = item.get("field_key")
            node_id = str(item.get("node_id") or "")
            input_key = item.get("input_key")
            if not field_key or not node_id or not input_key:
                continue
            mapping_id = item.get("mapping_id") or new_id("map")
            con.execute(
                """
                INSERT INTO workflow_input_mappings
                  (mapping_id, workflow_id, field_key, node_id, input_key, input_type, transform_json, is_enabled, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
                ON CONFLICT(workflow_id, field_key) DO UPDATE SET
                  node_id = excluded.node_id,
                  input_key = excluded.input_key,
                  input_type = excluded.input_type,
                  transform_json = excluded.transform_json,
                  is_enabled = 1,
                  updated_at = datetime('now')
                """,
                (
                    mapping_id,
                    workflow_id,
                    field_key,
                    node_id,
                    input_key,
                    item.get("input_type") or "text",
                    json.dumps(item.get("transform_json") or {}, ensure_ascii=False),
                ),
            )
            saved.append(field_key)
        con.execute(
            "INSERT INTO audit_logs (audit_id, action, entity_type, entity_id, detail_json) VALUES (?, 'save_mapping', 'workflow', ?, ?)",
            (new_id("aud"), workflow_id, json.dumps({"fields": saved}, ensure_ascii=False)),
        )
    return {"ok": True, "workflow_id": workflow_id, "saved_fields": saved}


def resolve_generation_output(con: sqlite3.Connection, job_id: str, content_scope: str) -> dict[str, Any]:
    output_root = configured_comfy_output_root(con)
    result: dict[str, Any] = {
        "content_scope": content_scope,
        "requested_storage_id": None,
        "resolved_output_prefix": build_output_prefix(job_id, content_scope),
        "validation_status": "ok",
        "fallback_reason": None,
        "comfy_output_root": str(output_root),
    }
    if content_scope != "adult_local":
        return result

    storage = row(
        con,
        """
        SELECT * FROM storage_locations
        WHERE content_scope = 'adult_local'
          AND usage_type = 'generated'
          AND is_enabled = 1
        ORDER BY is_default DESC, updated_at DESC
        LIMIT 1
        """,
    )
    if not storage:
        result.update(
            {
                "validation_status": "missing_storage",
                "fallback_reason": "Adult Local storage location is not configured.",
            }
        )
        return result

    status = storage_status(storage, output_root)
    result["requested_storage_id"] = storage["storage_id"]
    if not status["path_exists"]:
        result.update({"validation_status": "path_missing", "fallback_reason": "Adult Local storage path does not exist."})
        return result
    if not storage.get("is_available", 1):
        result.update({"validation_status": "unavailable", "fallback_reason": "Adult Local storage location is unavailable."})
        return result
    if not storage.get("writable", 1):
        result.update({"validation_status": "not_writable", "fallback_reason": "Adult Local storage location is not writable."})
        return result
    if not status.get("is_comfy_output_compatible"):
        result.update(
            {
                "validation_status": "outside_comfy_output_root",
                "fallback_reason": "Adult Local storage location is outside the ComfyUI output root.",
            }
        )
        return result

    relative_path = str(status.get("comfy_output_relative_path") or "").strip("/")
    if not relative_path or relative_path.startswith("/") or ".." in relative_path.split("/"):
        result.update(
            {
                "validation_status": "invalid_relative_prefix",
                "fallback_reason": "Adult Local storage path could not be converted to a safe relative prefix.",
            }
        )
        return result

    result["resolved_output_prefix"] = build_output_prefix(job_id, content_scope, relative_path)
    result["validation_status"] = "ok"
    return result


def create_generation_job(payload: dict[str, Any]) -> dict[str, Any]:
    job_id = new_id("job")
    content_scope = payload.get("mode") or payload.get("content_scope") or "sfw"
    if content_scope not in CONTENT_SCOPES:
        content_scope = "sfw"
    output_prefix = build_output_prefix(job_id, content_scope)
    workflow_id = payload.get("workflow_id")
    prompt = payload.get("prompt", "")
    negative = payload.get("negative_prompt", "")
    parameters = {
        "seed": payload.get("seed") or "random",
        "width": payload.get("width") or 1024,
        "height": payload.get("height") or 1024,
        "batch_size": payload.get("batch_size") or 1,
        "steps": payload.get("steps") or 20,
        "cfg": payload.get("cfg") or 7,
        "sampler": payload.get("sampler") or "",
        "scheduler": payload.get("scheduler") or "",
        "model": payload.get("model") or "",
        "lora": payload.get("lora") or "",
        "requested_filename_prefix": payload.get("filename_prefix") or "studio",
        "filename_prefix": output_prefix,
        "mode": content_scope,
    }
    status = "draft"
    comfy_prompt_id = None
    comfy_response: Any = None
    error = None
    prepared_payload: dict[str, Any] | None = None
    submitted_at = None
    requested_storage_id = None
    output_scope_validation_status = "not_checked"

    with db() as con:
        workflow = None
        if workflow_id:
            workflow = con.execute("SELECT * FROM workflows WHERE workflow_id = ?", (workflow_id,)).fetchone()
        output_resolution = resolve_generation_output(con, job_id, content_scope)
        output_prefix = output_resolution["resolved_output_prefix"]
        parameters["filename_prefix"] = output_prefix
        parameters["resolved_output_prefix"] = output_prefix
        parameters["output_scope_validation_status"] = output_resolution["validation_status"]
        parameters["requested_storage_id"] = output_resolution["requested_storage_id"]
        parameters["comfy_output_root"] = output_resolution["comfy_output_root"]
        requested_storage_id = output_resolution["requested_storage_id"]
        output_scope_validation_status = output_resolution["validation_status"]

        if content_scope == "adult_local" and output_resolution["validation_status"] != "ok":
            status = "simulation"
            error = (
                output_resolution["fallback_reason"]
                + " ComfyUI submission was blocked to avoid mixing Adult Local outputs."
            )
        elif workflow:
            mappings = rows(
                con,
                "SELECT * FROM workflow_input_mappings WHERE workflow_id = ? AND is_enabled = 1",
                (workflow_id,),
            )
            missing = missing_required_mappings(mappings, negative)
            if missing:
                status = "simulation"
                error = "Missing workflow mappings: " + ", ".join(missing)
            else:
                endpoint = get_setting(con, "comfy_endpoint", DEFAULT_COMFY)
                workflow_json = read_workflow_json(workflow["relative_path"])
                prepared_workflow, applied = apply_mappings(workflow_json, mappings, prompt, negative, parameters)
                prepared_payload = {"prompt": prepared_workflow, "client_id": CLIENT_ID}
                ok, response = post_json(f"{endpoint}/prompt", prepared_payload)
                if ok:
                    status = "submitted"
                    comfy_prompt_id = response.get("prompt_id")
                    comfy_response = response
                    parameters["applied_mappings"] = applied
                    submitted_at = now_iso()
                else:
                    status = "failed"
                    error = str(response)
        else:
            status = "draft"
            error = "No workflow selected. Job saved without ComfyUI submission."

        con.execute(
            """
            INSERT INTO generation_jobs
              (job_id, workflow_id, prompt, negative_prompt, parameters_json, status, comfy_prompt_id, comfy_response_json,
               error_message, prepared_payload_json, output_prefix, output_prefix_source, submitted_at,
               content_scope, requested_storage_id, resolved_output_prefix, output_scope_validation_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                workflow_id,
                prompt,
                negative,
                json.dumps(parameters, ensure_ascii=False),
                status,
                comfy_prompt_id,
                json.dumps(comfy_response, ensure_ascii=False) if comfy_response is not None else None,
                error,
                json.dumps(prepared_payload, ensure_ascii=False) if prepared_payload is not None else None,
                output_prefix if workflow else None,
                "scope_safe_output_mapping" if status == "submitted" else None,
                submitted_at,
                content_scope,
                requested_storage_id,
                output_prefix if workflow else None,
                output_scope_validation_status,
            ),
        )
        con.execute(
            "INSERT INTO audit_logs (audit_id, action, entity_type, entity_id, detail_json) VALUES (?, 'create', 'generation_job', ?, ?)",
            (
                new_id("aud"),
                job_id,
                json.dumps(
                    {
                        "status": status,
                        "scope": content_scope,
                        "storage_id": requested_storage_id,
                        "resolved_prefix": output_prefix,
                        "validation_result": output_scope_validation_status,
                        "fallback_reason": output_resolution.get("fallback_reason"),
                    },
                    ensure_ascii=False,
                ),
            ),
        )
    return {
        "ok": True,
        "job_id": job_id,
        "status": status,
        "comfy_prompt_id": comfy_prompt_id,
        "error": error,
        "content_scope": content_scope,
        "resolved_output_prefix": output_prefix,
        "output_scope_validation_status": output_scope_validation_status,
    }


def regenerate_job(job_id: str) -> dict[str, Any]:
    with db() as con:
        row = con.execute("SELECT * FROM generation_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not row:
            raise ValueError("job not found")
        params = json.loads(row["parameters_json"])
        payload = {
            "workflow_id": row["workflow_id"],
            "prompt": row["prompt"],
            "negative_prompt": row["negative_prompt"],
            **params,
        }
    return create_generation_job(payload)


def poll_submitted_jobs() -> dict[str, Any]:
    results = []
    with db() as con:
        job_ids = [
            item["job_id"]
            for item in rows(
                con,
                "SELECT job_id FROM generation_jobs WHERE status IN ('submitted', 'running') AND comfy_prompt_id IS NOT NULL ORDER BY created_at",
            )
        ]
    for job_id in job_ids:
        results.append(poll_job(job_id))
    return {"ok": True, "polled": results}


def resync_generation_jobs(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    include_completed = bool(payload.get("include_completed", False))
    try:
        limit = max(1, min(int(payload.get("limit", 50)), 200))
    except (TypeError, ValueError):
        limit = 50
    statuses = ["submitted", "running", "failed"]
    if include_completed:
        statuses.append("completed")
    placeholders = ",".join("?" for _ in statuses)
    with db() as con:
        job_ids = [
            item["job_id"]
            for item in rows(
                con,
                f"""
                SELECT job_id
                FROM generation_jobs
                WHERE comfy_prompt_id IS NOT NULL AND status IN ({placeholders})
                ORDER BY updated_at DESC, created_at DESC
                LIMIT ?
                """,
                (*statuses, limit),
            )
        ]
    results = []
    for job_id in job_ids:
        try:
            results.append(poll_job(job_id))
        except Exception as exc:
            results.append({"ok": False, "job_id": job_id, "error": str(exc)})
    with db() as con:
        summary = diagnostics_summary(con)
    return {"ok": True, "requested": len(job_ids), "include_completed": include_completed, "results": results, "diagnostics": summary}


def poll_job(job_id: str) -> dict[str, Any]:
    with db() as con:
        job = row(con, "SELECT * FROM generation_jobs WHERE job_id = ?", (job_id,))
        if not job:
            raise ValueError("job not found")
        if not job.get("comfy_prompt_id"):
            return {"ok": True, "job_id": job_id, "status": job["status"], "message": "no comfy prompt id"}
        endpoint = get_setting(con, "comfy_endpoint", DEFAULT_COMFY)
    ok, history = request_json(f"{endpoint}/history/{job['comfy_prompt_id']}", timeout=3.0)
    if not ok:
        with db() as con:
            con.execute(
                "UPDATE generation_jobs SET status = 'running', error_message = ?, updated_at = datetime('now') WHERE job_id = ?",
                (str(history), job_id),
            )
        return {"ok": False, "job_id": job_id, "status": "running", "error": str(history)}

    prompt_history = history.get(job["comfy_prompt_id"]) if isinstance(history, dict) else None
    if not prompt_history:
        with db() as con:
            con.execute("UPDATE generation_jobs SET status = 'running', updated_at = datetime('now') WHERE job_id = ?", (job_id,))
        return {"ok": True, "job_id": job_id, "status": "running", "outputs": 0}

    status_info = prompt_history.get("status", {}) if isinstance(prompt_history, dict) else {}
    completed = status_info.get("completed", True)
    if completed is False:
        with db() as con:
            con.execute("UPDATE generation_jobs SET status = 'running', updated_at = datetime('now') WHERE job_id = ?", (job_id,))
        return {"ok": True, "job_id": job_id, "status": "running", "outputs": 0}

    output_images = []
    for output in (prompt_history.get("outputs") or {}).values():
        for image in output.get("images", []) if isinstance(output, dict) else []:
            output_images.append(image)

    imported = import_job_outputs(job, output_images)
    final_status = "completed" if imported or not output_images else "failed"
    error = None if imported or not output_images else "ComfyUI history contained image outputs, but files were not found."
    with db() as con:
        con.execute(
            """
            UPDATE generation_jobs
            SET status = ?, output_count = ?, completed_at = datetime('now'), error_message = ?, updated_at = datetime('now')
            WHERE job_id = ?
            """,
            (final_status, len(imported), error, job_id),
        )
    return {"ok": True, "job_id": job_id, "status": final_status, "outputs": len(imported)}


def import_job_outputs(job: dict[str, Any], output_images: list[dict[str, Any]]) -> list[dict[str, Any]]:
    imported = []
    output_storage = ROOT / "output"
    for image_info in output_images:
        source = resolve_comfy_image(image_info)
        if source.suffix.lower() not in IMAGE_EXTENSIONS or not source.exists():
            continue
        asset_id = new_id("asset")
        output_id = new_id("out")
        relative_path = relative_to_storage(source, output_storage)
        width, height = image_dimensions(source)
        thumb_storage_id, thumb_relative_path = make_thumbnail(source, asset_id)
        with db() as con:
            existing = row(
                con,
                """
                SELECT go.output_id, go.asset_id
                FROM generation_job_outputs go
                WHERE go.job_id = ? AND go.source_path = ?
                """,
                (job["job_id"], str(source)),
            )
            if existing:
                imported.append(existing)
                continue
            con.execute(
                """
                INSERT INTO media_assets
                  (asset_id, storage_id, relative_path, thumbnail_storage_id, thumbnail_relative_path,
                   media_type, sha256, status, source_job_id, safety_zone, content_scope)
                VALUES (?, 'storage_default_output', ?, ?, ?, 'image', ?, 'candidate', ?, ?, ?)
                """,
                (
                    asset_id,
                    relative_path,
                    thumb_storage_id,
                    thumb_relative_path,
                    file_sha256(source),
                    job["job_id"],
                    json.loads(job.get("parameters_json") or "{}").get("mode", "sfw"),
                    json.loads(job.get("parameters_json") or "{}").get("mode", "sfw"),
                ),
            )
            con.execute(
                """
                INSERT INTO generation_job_outputs
                  (output_id, job_id, asset_id, source_path, file_name, media_type, width, height)
                VALUES (?, ?, ?, ?, ?, 'image', ?, ?)
                """,
                (output_id, job["job_id"], asset_id, str(source), source.name, width, height),
            )
            con.execute(
                "INSERT INTO audit_logs (audit_id, action, entity_type, entity_id, detail_json) VALUES (?, 'import_output', 'media_asset', ?, ?)",
                (new_id("aud"), asset_id, json.dumps({"source_path": str(source), "job_id": job["job_id"]}, ensure_ascii=False)),
            )
        imported.append({"output_id": output_id, "asset_id": asset_id, "source_path": str(source)})
    return imported


def asset_thumbnail_path(asset_id: str) -> Path | None:
    with db() as con:
        asset = row(con, "SELECT * FROM media_assets WHERE asset_id = ?", (asset_id,))
        if not asset:
            return None
        if asset.get("thumbnail_storage_id") and asset.get("thumbnail_relative_path"):
            storage = row(con, "SELECT * FROM storage_locations WHERE storage_id = ?", (asset["thumbnail_storage_id"],))
            if storage:
                path = (Path(storage["base_path"]) / asset["thumbnail_relative_path"]).resolve()
                if path.exists():
                    return path
    return asset_file_path(asset_id)


def asset_file_path(asset_id: str) -> Path | None:
    with db() as con:
        asset = row(con, "SELECT * FROM media_assets WHERE asset_id = ?", (asset_id,))
        if not asset:
            return None
        storage = row(con, "SELECT * FROM storage_locations WHERE storage_id = ?", (asset["storage_id"],))
        if not storage:
            return None
        base = Path(storage["base_path"]).resolve()
        path = (base / asset["relative_path"]).resolve()
        if base not in path.parents and path != base:
            return None
        return path


def get_asset_detail(asset_id: str) -> dict[str, Any]:
    with db() as con:
        asset = row(
            con,
            """
            SELECT
              ma.*,
              go.source_path,
              go.file_name,
              go.width AS output_width,
              go.height AS output_height,
              gj.prompt,
              gj.negative_prompt,
              gj.parameters_json,
              gj.output_prefix,
              gj.created_at AS job_created_at,
              gj.workflow_id,
              wf.name AS workflow_name
            FROM media_assets ma
            LEFT JOIN generation_jobs gj ON gj.job_id = ma.source_job_id
            LEFT JOIN generation_job_outputs go ON go.asset_id = ma.asset_id
            LEFT JOIN workflows wf ON wf.workflow_id = gj.workflow_id
            WHERE ma.asset_id = ?
            """,
            (asset_id,),
        )
        if not asset:
            raise ValueError("asset not found")
        asset["tags"] = asset_tags(con, asset_id)
    return {"asset": asset}


def sync_asset_tags(con: sqlite3.Connection, asset_id: str, tags: Any) -> list[str]:
    normalized = normalize_tags(tags)
    con.execute("DELETE FROM asset_tags WHERE asset_id = ?", (asset_id,))
    for name in normalized:
        tag_id = ensure_tag(con, name, "asset")
        con.execute("INSERT OR IGNORE INTO asset_tags (asset_id, tag_id) VALUES (?, ?)", (asset_id, tag_id))
    return normalized


def update_asset(asset_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    allowed_status = {"draft", "candidate", "approved", "rejected", "archived"}
    status = payload.get("status")
    rating = payload.get("rating")
    note = payload.get("note")
    comparison_note = payload.get("comparison_note")
    content_scope = payload.get("content_scope")
    board_note = payload.get("board_note")
    is_export_candidate = payload.get("is_export_candidate")
    tags = payload.get("tags")
    with db() as con:
        if status:
            if status not in allowed_status:
                raise ValueError("invalid status")
            con.execute("UPDATE media_assets SET status = ?, updated_at = datetime('now') WHERE asset_id = ?", (status, asset_id))
        if rating is not None:
            con.execute("UPDATE media_assets SET rating = ?, updated_at = datetime('now') WHERE asset_id = ?", (int(rating), asset_id))
        if note is not None:
            con.execute("UPDATE media_assets SET note = ?, updated_at = datetime('now') WHERE asset_id = ?", (str(note), asset_id))
        if comparison_note is not None:
            con.execute("UPDATE media_assets SET comparison_note = ?, updated_at = datetime('now') WHERE asset_id = ?", (str(comparison_note), asset_id))
        if board_note is not None:
            con.execute("UPDATE media_assets SET board_note = ?, updated_at = datetime('now') WHERE asset_id = ?", (str(board_note), asset_id))
        if is_export_candidate is not None:
            con.execute(
                "UPDATE media_assets SET is_export_candidate = ?, updated_at = datetime('now') WHERE asset_id = ?",
                (1 if is_export_candidate else 0, asset_id),
            )
        if content_scope is not None:
            if content_scope not in CONTENT_SCOPES:
                raise ValueError("invalid content scope")
            con.execute(
                "UPDATE media_assets SET content_scope = ?, safety_zone = ?, updated_at = datetime('now') WHERE asset_id = ?",
                (content_scope, content_scope, asset_id),
            )
        saved_tags = None
        if tags is not None:
            saved_tags = sync_asset_tags(con, asset_id, tags)
            con.execute("UPDATE media_assets SET updated_at = datetime('now') WHERE asset_id = ?", (asset_id,))
        con.execute(
            "INSERT INTO audit_logs (audit_id, action, entity_type, entity_id, detail_json) VALUES (?, 'update', 'media_asset', ?, ?)",
            (new_id("aud"), asset_id, json.dumps(payload, ensure_ascii=False)),
        )
    return {"ok": True, "asset_id": asset_id, "tags": saved_tags}


def create_comparison(payload: dict[str, Any]) -> dict[str, Any]:
    asset_ids = [str(item) for item in payload.get("asset_ids", []) if str(item)]
    asset_ids = list(dict.fromkeys(asset_ids))[:8]
    if len(asset_ids) < 2:
        raise ValueError("comparison requires at least two assets")
    comparison_id = new_id("cmp")
    name = str(payload.get("name") or f"Comparison {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    memo = str(payload.get("memo") or "")
    selection_result = str(payload.get("selection_result") or "")
    improvement_note = str(payload.get("improvement_note") or "")
    with db() as con:
        existing = {
            item["asset_id"]
            for item in rows(con, f"SELECT asset_id FROM media_assets WHERE asset_id IN ({','.join('?' for _ in asset_ids)})", tuple(asset_ids))
        }
        missing = [asset_id for asset_id in asset_ids if asset_id not in existing]
        if missing:
            raise ValueError("missing assets: " + ", ".join(missing))
        con.execute(
            """
            INSERT INTO comparison_sets (comparison_id, name, memo, selection_result, improvement_note)
            VALUES (?, ?, ?, ?, ?)
            """,
            (comparison_id, name, memo, selection_result, improvement_note),
        )
        for index, asset_id in enumerate(asset_ids):
            con.execute(
                "INSERT INTO comparison_set_items (comparison_id, asset_id, position, sort_order) VALUES (?, ?, ?, ?)",
                (comparison_id, asset_id, index, index),
            )
        con.execute(
            "INSERT INTO audit_logs (audit_id, action, entity_type, entity_id, detail_json) VALUES (?, 'create', 'comparison_set', ?, ?)",
            (new_id("aud"), comparison_id, json.dumps({"asset_ids": asset_ids}, ensure_ascii=False)),
        )
    return get_comparison(comparison_id)


def get_comparison(comparison_id: str) -> dict[str, Any]:
    with db() as con:
        comparison = row(con, "SELECT * FROM comparison_sets WHERE comparison_id = ?", (comparison_id,))
        if not comparison:
            raise ValueError("comparison not found")
        items = rows(
            con,
            asset_select_sql(
                """
                JOIN comparison_set_items csi ON csi.asset_id = ma.asset_id
                WHERE csi.comparison_id = ?
                """
            ).replace("ORDER BY ma.created_at DESC", "ORDER BY csi.sort_order ASC, csi.position ASC"),
            (comparison_id,),
        )
        hydrate_assets(con, items)
    return {"ok": True, "comparison": comparison, "assets": items}


def update_comparison(comparison_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    with db() as con:
        existing = row(con, "SELECT * FROM comparison_sets WHERE comparison_id = ?", (comparison_id,))
        if not existing:
            raise ValueError("comparison not found")
        fields = []
        params: list[Any] = []
        for key in ("name", "memo", "selection_result", "improvement_note", "status"):
            if key in payload:
                fields.append(f"{key} = ?")
                params.append(str(payload[key]))
        if fields:
            params.append(comparison_id)
            con.execute(
                f"UPDATE comparison_sets SET {', '.join(fields)}, updated_at = datetime('now') WHERE comparison_id = ?",
                tuple(params),
            )
    return get_comparison(comparison_id)


def duplicate_comparison(comparison_id: str) -> dict[str, Any]:
    detail = get_comparison(comparison_id)
    comparison = detail["comparison"]
    assets = detail["assets"]
    if len(assets) < 2:
        raise ValueError("comparison does not have enough available assets")
    return create_comparison(
        {
            "asset_ids": [asset["asset_id"] for asset in assets],
            "name": f"{comparison['name']} copy",
            "memo": comparison.get("memo") or "",
            "selection_result": comparison.get("selection_result") or "",
            "improvement_note": comparison.get("improvement_note") or "",
        }
    )


def recipe_payload_from_source(payload: dict[str, Any]) -> dict[str, Any]:
    source_asset_id = payload.get("source_asset_id")
    source_job_id = payload.get("source_job_id")
    with db() as con:
        asset = row(con, "SELECT * FROM media_assets WHERE asset_id = ?", (source_asset_id,)) if source_asset_id else None
        job_id = source_job_id or (asset.get("source_job_id") if asset else None)
        job = row(con, "SELECT * FROM generation_jobs WHERE job_id = ?", (job_id,)) if job_id else None
        if not job:
            raise ValueError("source job not found")
        mappings = rows(con, "SELECT * FROM workflow_input_mappings WHERE workflow_id = ? AND is_enabled = 1 ORDER BY field_key", (job["workflow_id"],))
        workflow = row(con, "SELECT * FROM workflows WHERE workflow_id = ?", (job["workflow_id"],)) if job.get("workflow_id") else None
        params = json.loads(job.get("parameters_json") or "{}")
        return {
            "source_asset_id": source_asset_id,
            "source_job_id": job_id,
            "workflow_id": job.get("workflow_id"),
            "workflow_version": workflow.get("version") if workflow else "v1",
            "workflow_mapping_snapshot": mappings,
            "positive_prompt": job.get("prompt") or "",
            "negative_prompt": job.get("negative_prompt") or "",
            "parameters_json": params,
            "output_settings_json": {"output_prefix": job.get("output_prefix")},
        }


def sync_recipe_tags(con: sqlite3.Connection, recipe_id: str, tags: Any) -> list[str]:
    normalized = normalize_tags(tags)
    con.execute("DELETE FROM recipe_tags WHERE recipe_id = ?", (recipe_id,))
    for name in normalized:
        tag_id = ensure_tag(con, name, "recipe")
        con.execute("INSERT OR IGNORE INTO recipe_tags (recipe_id, tag_id) VALUES (?, ?)", (recipe_id, tag_id))
    return normalized


def create_recipe(payload: dict[str, Any]) -> dict[str, Any]:
    source = recipe_payload_from_source(payload)
    recipe_id = new_id("recipe")
    name = str(payload.get("name") or "Untitled Recipe").strip() or "Untitled Recipe"
    description = str(payload.get("description") or "")
    tags = payload.get("tags") or []
    with db() as con:
        con.execute(
            """
            INSERT INTO recipes
              (recipe_id, name, description, source_asset_id, source_job_id, workflow_id, workflow_version,
               workflow_mapping_snapshot, positive_prompt, negative_prompt, parameters_json, output_settings_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                recipe_id,
                name,
                description,
                source["source_asset_id"],
                source["source_job_id"],
                source["workflow_id"],
                source["workflow_version"],
                json.dumps(source["workflow_mapping_snapshot"], ensure_ascii=False),
                source["positive_prompt"],
                source["negative_prompt"],
                json.dumps(source["parameters_json"], ensure_ascii=False),
                json.dumps(source["output_settings_json"], ensure_ascii=False),
            ),
        )
        sync_recipe_tags(con, recipe_id, tags)
        snapshot = row(con, "SELECT * FROM recipes WHERE recipe_id = ?", (recipe_id,))
        con.execute(
            "INSERT INTO recipe_versions (recipe_version_id, recipe_id, version, snapshot_json) VALUES (?, ?, 'v1', ?)",
            (new_id("rv"), recipe_id, json.dumps(snapshot, ensure_ascii=False)),
        )
        con.execute(
            "INSERT INTO audit_logs (audit_id, action, entity_type, entity_id, detail_json) VALUES (?, 'create', 'recipe', ?, ?)",
            (new_id("aud"), recipe_id, json.dumps({"source_job_id": source["source_job_id"]}, ensure_ascii=False)),
        )
    return {"ok": True, "recipe_id": recipe_id}


def get_recipe_detail(recipe_id: str) -> dict[str, Any]:
    with db() as con:
        recipe = row(
            con,
            """
            SELECT
              r.*,
              wf.name AS workflow_name,
              ma.relative_path AS source_relative_path,
              go.file_name AS source_file_name
            FROM recipes r
            LEFT JOIN workflows wf ON wf.workflow_id = r.workflow_id
            LEFT JOIN media_assets ma ON ma.asset_id = r.source_asset_id
            LEFT JOIN generation_job_outputs go ON go.asset_id = r.source_asset_id
            WHERE r.recipe_id = ?
            """,
            (recipe_id,),
        )
        if not recipe:
            raise ValueError("recipe not found")
        recipe["tags"] = recipe_tags(con, recipe_id)
    return {"recipe": recipe}


def update_recipe(recipe_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    allowed = {"active", "archived"}
    if payload.get("save_mode") == "duplicate_version":
        duplicate = duplicate_recipe(recipe_id, payload)
        return {"ok": True, "recipe_id": duplicate["recipe_id"], "duplicated": True}
    with db() as con:
        current = row(con, "SELECT * FROM recipes WHERE recipe_id = ?", (recipe_id,))
        if not current:
            raise ValueError("recipe not found")
        if "name" in payload:
            con.execute("UPDATE recipes SET name = ?, updated_at = datetime('now') WHERE recipe_id = ?", (str(payload["name"]), recipe_id))
        if "description" in payload:
            con.execute("UPDATE recipes SET description = ?, updated_at = datetime('now') WHERE recipe_id = ?", (str(payload["description"]), recipe_id))
        if "positive_prompt" in payload:
            con.execute("UPDATE recipes SET positive_prompt = ?, updated_at = datetime('now') WHERE recipe_id = ?", (str(payload["positive_prompt"]), recipe_id))
        if "negative_prompt" in payload:
            con.execute("UPDATE recipes SET negative_prompt = ?, updated_at = datetime('now') WHERE recipe_id = ?", (str(payload["negative_prompt"]), recipe_id))
        if "workflow_id" in payload:
            workflow_id = str(payload.get("workflow_id") or "")
            if workflow_id:
                exists = row(con, "SELECT workflow_id FROM workflows WHERE workflow_id = ?", (workflow_id,))
                if not exists:
                    raise ValueError("workflow not found")
            con.execute("UPDATE recipes SET workflow_id = ?, updated_at = datetime('now') WHERE recipe_id = ?", (workflow_id or None, recipe_id))
        if "parameters" in payload:
            params = payload["parameters"] if isinstance(payload["parameters"], dict) else {}
            con.execute(
                "UPDATE recipes SET parameters_json = ?, updated_at = datetime('now') WHERE recipe_id = ?",
                (json.dumps(params, ensure_ascii=False), recipe_id),
            )
        if "status" in payload:
            status = payload["status"]
            if status not in allowed:
                raise ValueError("invalid recipe status")
            con.execute("UPDATE recipes SET status = ?, updated_at = datetime('now') WHERE recipe_id = ?", (status, recipe_id))
        if "tags" in payload:
            sync_recipe_tags(con, recipe_id, payload["tags"])
            con.execute("UPDATE recipes SET updated_at = datetime('now') WHERE recipe_id = ?", (recipe_id,))
        snapshot = row(con, "SELECT * FROM recipes WHERE recipe_id = ?", (recipe_id,))
        con.execute(
            "INSERT INTO recipe_versions (recipe_version_id, recipe_id, version, snapshot_json) VALUES (?, ?, ?, ?)",
            (
                new_id("rv"),
                recipe_id,
                str(payload.get("version") or snapshot.get("version") or "v1"),
                json.dumps(snapshot, ensure_ascii=False),
            ),
        )
    return {"ok": True, "recipe_id": recipe_id}


def use_recipe(recipe_id: str) -> dict[str, Any]:
    with db() as con:
        recipe = row(con, "SELECT * FROM recipes WHERE recipe_id = ?", (recipe_id,))
        if not recipe:
            raise ValueError("recipe not found")
        con.execute("UPDATE recipes SET use_count = use_count + 1, updated_at = datetime('now') WHERE recipe_id = ?", (recipe_id,))
        recipe = row(con, "SELECT * FROM recipes WHERE recipe_id = ?", (recipe_id,))
        recipe["tags"] = recipe_tags(con, recipe_id)
    return {"ok": True, "recipe": recipe}


def duplicate_recipe(recipe_id: str, overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    detail = get_recipe_detail(recipe_id)["recipe"]
    overrides = overrides or {}
    new_id_value = new_id("recipe")
    params = overrides.get("parameters") if isinstance(overrides.get("parameters"), dict) else json.loads(detail.get("parameters_json") or "{}")
    next_version = str(overrides.get("version") or f"{detail.get('version') or 'v1'} copy")
    with db() as con:
        con.execute(
            """
            INSERT INTO recipes
              (recipe_id, name, description, source_asset_id, source_job_id, workflow_id, workflow_version,
               workflow_mapping_snapshot, positive_prompt, negative_prompt, parameters_json, output_settings_json,
               status, version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
            """,
            (
                new_id_value,
                str(overrides.get("name") or f"{detail['name']} copy"),
                str(overrides.get("description") if "description" in overrides else detail["description"]),
                detail["source_asset_id"],
                detail["source_job_id"],
                overrides.get("workflow_id") if "workflow_id" in overrides else detail["workflow_id"],
                detail["workflow_version"],
                detail["workflow_mapping_snapshot"],
                str(overrides.get("positive_prompt") if "positive_prompt" in overrides else detail["positive_prompt"]),
                str(overrides.get("negative_prompt") if "negative_prompt" in overrides else detail["negative_prompt"]),
                json.dumps(params, ensure_ascii=False),
                detail["output_settings_json"],
                next_version,
            ),
        )
        sync_recipe_tags(con, new_id_value, overrides.get("tags") if "tags" in overrides else detail.get("tags", []))
        snapshot = row(con, "SELECT * FROM recipes WHERE recipe_id = ?", (new_id_value,))
        con.execute(
            "INSERT INTO recipe_versions (recipe_version_id, recipe_id, version, snapshot_json) VALUES (?, ?, ?, ?)",
            (new_id("rv"), new_id_value, next_version, json.dumps(snapshot, ensure_ascii=False)),
        )
    return {"ok": True, "recipe_id": new_id_value}


def save_panel_state(payload: dict[str, Any]) -> dict[str, Any]:
    with db() as con:
        set_setting(con, "panel_state", payload)
    return {"ok": True}


def main() -> int:
    parser = argparse.ArgumentParser(description="AI Media Factory Studio local server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--init-only", action="store_true")
    args = parser.parse_args()
    run_migrations()
    if args.init_only:
        print(f"initialized {DB_PATH}")
        return 0
    os.chdir(STATIC)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"AI Media Factory Studio v{APP_VERSION}: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

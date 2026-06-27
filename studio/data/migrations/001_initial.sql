CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS storage_locations (
  storage_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_path TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'local',
  is_default INTEGER NOT NULL DEFAULT 0,
  is_available INTEGER NOT NULL DEFAULT 1,
  writable INTEGER NOT NULL DEFAULT 1,
  free_space_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL DEFAULT 'local_file',
  version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  job_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  prompt TEXT NOT NULL DEFAULT '',
  negative_prompt TEXT NOT NULL DEFAULT '',
  parameters_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  comfy_prompt_id TEXT,
  comfy_response_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
);

CREATE TABLE IF NOT EXISTS media_assets (
  asset_id TEXT PRIMARY KEY,
  storage_id TEXT,
  relative_path TEXT NOT NULL,
  thumbnail_storage_id TEXT,
  thumbnail_relative_path TEXT,
  media_type TEXT NOT NULL DEFAULT 'image',
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  rating INTEGER NOT NULL DEFAULT 0,
  source_job_id TEXT,
  safety_zone TEXT NOT NULL DEFAULT 'sfw',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (storage_id) REFERENCES storage_locations(storage_id),
  FOREIGN KEY (source_job_id) REFERENCES generation_jobs(job_id)
);

CREATE TABLE IF NOT EXISTS tags (
  tag_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'general',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (asset_id, tag_id),
  FOREIGN KEY (asset_id) REFERENCES media_assets(asset_id),
  FOREIGN KEY (tag_id) REFERENCES tags(tag_id)
);

CREATE TABLE IF NOT EXISTS ollama_profiles (
  profile_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model_name TEXT NOT NULL,
  endpoint TEXT NOT NULL DEFAULT 'http://127.0.0.1:11434',
  role TEXT NOT NULL DEFAULT 'prompt_assistant',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('001_initial');


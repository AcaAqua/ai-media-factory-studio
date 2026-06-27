CREATE TABLE IF NOT EXISTS asset_registry_locations (
  location_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  asset_kind TEXT NOT NULL,
  base_path TEXT NOT NULL,
  is_external INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  last_scanned_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_registry_locations_kind_path
  ON asset_registry_locations(asset_kind, base_path);

CREATE TABLE IF NOT EXISTS asset_registry_items (
  item_id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  asset_kind TEXT NOT NULL,
  name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  extension TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  source_url TEXT,
  license TEXT,
  creator TEXT,
  base_model TEXT,
  status TEXT NOT NULL DEFAULT 'unverified',
  notes TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(location_id) REFERENCES asset_registry_locations(location_id),
  UNIQUE(location_id, relative_path)
);

CREATE TABLE IF NOT EXISTS asset_scan_runs (
  scan_id TEXT PRIMARY KEY,
  location_id TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  scanned_count INTEGER NOT NULL DEFAULT 0,
  added_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  missing_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  FOREIGN KEY(location_id) REFERENCES asset_registry_locations(location_id)
);

CREATE INDEX IF NOT EXISTS idx_asset_registry_items_kind_status
  ON asset_registry_items(asset_kind, status);
CREATE INDEX IF NOT EXISTS idx_asset_registry_items_location
  ON asset_registry_items(location_id);
CREATE INDEX IF NOT EXISTS idx_asset_scan_runs_started
  ON asset_scan_runs(started_at);

INSERT OR IGNORE INTO asset_registry_locations
  (location_id, name, asset_kind, base_path, is_external, is_enabled, notes)
VALUES
  ('arl_models_checkpoints', 'Studio Checkpoints', 'checkpoint', 'models/checkpoints', 0, 1, 'Studio-managed checkpoint folder. Files are scanned in place.'),
  ('arl_models_loras', 'Studio LoRA', 'lora', 'models/loras', 0, 1, 'Studio-managed LoRA folder. Files are scanned in place.'),
  ('arl_models_vae', 'Studio VAE', 'vae', 'models/vae', 0, 1, 'Studio-managed VAE folder. Files are scanned in place.'),
  ('arl_models_controlnet', 'Studio ControlNet', 'controlnet', 'models/controlnet', 0, 1, 'Studio-managed ControlNet folder. Files are scanned in place.'),
  ('arl_models_upscalers', 'Studio Upscalers', 'upscaler', 'models/upscale_models', 0, 1, 'Studio-managed upscaler folder. Files are scanned in place.'),
  ('arl_workflows', 'Studio Workflows', 'workflow', 'workflows', 0, 1, 'Studio workflow folder. Workflow JSON files are scanned in place.');

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('008_asset_registry');

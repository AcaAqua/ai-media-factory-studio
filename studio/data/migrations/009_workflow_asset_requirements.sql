CREATE TABLE IF NOT EXISTS workflow_asset_requirements (
  requirement_id TEXT PRIMARY KEY,
  workflow_path TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  node_id TEXT NOT NULL,
  class_type TEXT NOT NULL,
  asset_kind TEXT NOT NULL,
  asset_name TEXT NOT NULL,
  input_key TEXT NOT NULL,
  matched_item_id TEXT,
  status TEXT NOT NULL DEFAULT 'missing',
  last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workflow_path, node_id, input_key, asset_name)
);

CREATE INDEX IF NOT EXISTS idx_workflow_asset_requirements_workflow
  ON workflow_asset_requirements(workflow_path);
CREATE INDEX IF NOT EXISTS idx_workflow_asset_requirements_status
  ON workflow_asset_requirements(status, asset_kind);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('009_workflow_asset_requirements');

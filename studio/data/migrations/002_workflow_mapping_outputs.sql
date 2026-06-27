CREATE TABLE IF NOT EXISTS workflow_input_mappings (
  mapping_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  node_id TEXT NOT NULL,
  input_key TEXT NOT NULL,
  input_type TEXT NOT NULL DEFAULT 'text',
  transform_json TEXT NOT NULL DEFAULT '{}',
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workflow_id, field_key),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
);

CREATE TABLE IF NOT EXISTS generation_job_outputs (
  output_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'image',
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, source_path),
  FOREIGN KEY (job_id) REFERENCES generation_jobs(job_id),
  FOREIGN KEY (asset_id) REFERENCES media_assets(asset_id)
);

ALTER TABLE generation_jobs ADD COLUMN prepared_payload_json TEXT;
ALTER TABLE generation_jobs ADD COLUMN completed_at TEXT;
ALTER TABLE generation_jobs ADD COLUMN output_count INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('002_workflow_mapping_outputs');

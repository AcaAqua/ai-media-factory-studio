ALTER TABLE generation_jobs ADD COLUMN output_prefix TEXT;
ALTER TABLE generation_jobs ADD COLUMN output_prefix_source TEXT;
ALTER TABLE generation_jobs ADD COLUMN submitted_at TEXT;

ALTER TABLE media_assets ADD COLUMN note TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS recipes (
  recipe_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_asset_id TEXT,
  source_job_id TEXT,
  workflow_id TEXT,
  workflow_version TEXT,
  workflow_mapping_snapshot TEXT NOT NULL DEFAULT '[]',
  positive_prompt TEXT NOT NULL DEFAULT '',
  negative_prompt TEXT NOT NULL DEFAULT '',
  parameters_json TEXT NOT NULL DEFAULT '{}',
  output_settings_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  version TEXT NOT NULL DEFAULT 'v1',
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (source_asset_id) REFERENCES media_assets(asset_id),
  FOREIGN KEY (source_job_id) REFERENCES generation_jobs(job_id),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
);

CREATE TABLE IF NOT EXISTS recipe_versions (
  recipe_version_id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL,
  version TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (recipe_id) REFERENCES recipes(recipe_id)
);

CREATE TABLE IF NOT EXISTS recipe_tags (
  recipe_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (recipe_id, tag_id),
  FOREIGN KEY (recipe_id) REFERENCES recipes(recipe_id),
  FOREIGN KEY (tag_id) REFERENCES tags(tag_id)
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('003_assets_recipes_prefix');

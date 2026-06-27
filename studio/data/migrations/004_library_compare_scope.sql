ALTER TABLE media_assets ADD COLUMN content_scope TEXT NOT NULL DEFAULT 'sfw';
ALTER TABLE media_assets ADD COLUMN comparison_note TEXT NOT NULL DEFAULT '';

ALTER TABLE storage_locations ADD COLUMN content_scope TEXT NOT NULL DEFAULT 'general';

UPDATE media_assets
SET content_scope = CASE
  WHEN safety_zone IN ('sfw', 'sensitive', 'adult_local') THEN safety_zone
  ELSE 'sfw'
END
WHERE content_scope IS NULL OR content_scope = '';

UPDATE storage_locations
SET content_scope = 'general'
WHERE content_scope IS NULL OR content_scope = '';

CREATE INDEX IF NOT EXISTS idx_media_assets_status ON media_assets(status);
CREATE INDEX IF NOT EXISTS idx_media_assets_rating ON media_assets(rating);
CREATE INDEX IF NOT EXISTS idx_media_assets_scope ON media_assets(content_scope);
CREATE INDEX IF NOT EXISTS idx_media_assets_created ON media_assets(created_at);
CREATE INDEX IF NOT EXISTS idx_media_assets_source_job ON media_assets(source_job_id);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_workflow ON generation_jobs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_prefix ON generation_jobs(output_prefix);
CREATE INDEX IF NOT EXISTS idx_asset_tags_asset ON asset_tags(asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_recipe_tags_recipe ON recipe_tags(recipe_id);
CREATE INDEX IF NOT EXISTS idx_recipe_tags_tag ON recipe_tags(tag_id);

CREATE TABLE IF NOT EXISTS comparison_sets (
  comparison_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  selection_result TEXT NOT NULL DEFAULT '',
  improvement_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comparison_set_items (
  comparison_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (comparison_id, asset_id),
  FOREIGN KEY (comparison_id) REFERENCES comparison_sets(comparison_id),
  FOREIGN KEY (asset_id) REFERENCES media_assets(asset_id)
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('004_library_compare_scope');

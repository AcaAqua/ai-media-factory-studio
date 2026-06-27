ALTER TABLE storage_locations ADD COLUMN usage_type TEXT NOT NULL DEFAULT 'generated';
ALTER TABLE storage_locations ADD COLUMN is_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE storage_locations ADD COLUMN last_checked_at TEXT;

ALTER TABLE media_assets ADD COLUMN is_export_candidate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_assets ADD COLUMN board_note TEXT NOT NULL DEFAULT '';

ALTER TABLE comparison_sets ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE comparison_set_items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE comparison_set_items
SET sort_order = position
WHERE sort_order = 0;

CREATE INDEX IF NOT EXISTS idx_storage_locations_scope ON storage_locations(content_scope);
CREATE INDEX IF NOT EXISTS idx_storage_locations_usage ON storage_locations(usage_type);
CREATE INDEX IF NOT EXISTS idx_storage_locations_enabled ON storage_locations(is_enabled);
CREATE INDEX IF NOT EXISTS idx_media_assets_export_candidate ON media_assets(is_export_candidate);
CREATE INDEX IF NOT EXISTS idx_media_assets_status_scope ON media_assets(status, content_scope);
CREATE INDEX IF NOT EXISTS idx_comparison_sets_status ON comparison_sets(status);
CREATE INDEX IF NOT EXISTS idx_comparison_set_items_sort ON comparison_set_items(comparison_id, sort_order);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('005_storage_board_comparison');

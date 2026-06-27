ALTER TABLE generation_jobs ADD COLUMN content_scope TEXT NOT NULL DEFAULT 'sfw';
ALTER TABLE generation_jobs ADD COLUMN requested_storage_id TEXT;
ALTER TABLE generation_jobs ADD COLUMN resolved_output_prefix TEXT;
ALTER TABLE generation_jobs ADD COLUMN output_scope_validation_status TEXT NOT NULL DEFAULT 'not_checked';

ALTER TABLE storage_locations ADD COLUMN comfy_output_relative_path TEXT;
ALTER TABLE storage_locations ADD COLUMN is_comfy_output_compatible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_locations ADD COLUMN last_validation_result TEXT;

UPDATE generation_jobs
SET content_scope = COALESCE(json_extract(parameters_json, '$.mode'), 'sfw')
WHERE content_scope = 'sfw';

CREATE INDEX IF NOT EXISTS idx_generation_jobs_scope_status ON generation_jobs(content_scope, status);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_storage ON generation_jobs(requested_storage_id);
CREATE INDEX IF NOT EXISTS idx_storage_locations_comfy_compatible ON storage_locations(is_comfy_output_compatible);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('006_output_scope_safety');

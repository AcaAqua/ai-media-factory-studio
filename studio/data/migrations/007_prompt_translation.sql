CREATE TABLE IF NOT EXISTS prompt_translation_terms (
  term_id TEXT PRIMARY KEY,
  source_text TEXT NOT NULL UNIQUE,
  target_text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  weight INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_translation_presets (
  preset_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  append_prompt TEXT NOT NULL DEFAULT '',
  append_negative TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_translation_history (
  history_id TEXT PRIMARY KEY,
  source_prompt TEXT NOT NULL DEFAULT '',
  translated_prompt TEXT NOT NULL DEFAULT '',
  source_negative TEXT NOT NULL DEFAULT '',
  translated_negative TEXT NOT NULL DEFAULT '',
  unconverted_terms_json TEXT NOT NULL DEFAULT '[]',
  preset_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prompt_translation_terms_enabled_source
  ON prompt_translation_terms(is_enabled, source_text);
CREATE INDEX IF NOT EXISTS idx_prompt_translation_terms_category
  ON prompt_translation_terms(category);
CREATE INDEX IF NOT EXISTS idx_prompt_translation_history_created
  ON prompt_translation_history(created_at);

INSERT OR IGNORE INTO prompt_translation_presets
  (preset_id, name, append_prompt, append_negative, is_default, is_enabled)
VALUES
  ('preset_quality_default', '品質重視',
   'masterpiece, best quality, detailed, soft lighting',
   'low quality, blurry, watermark, text, bad anatomy',
   1, 1),
  ('preset_photo_soft', '写真風・柔らかい光',
   'photorealistic, natural light, soft lighting, detailed background',
   'low quality, blurry, overexposed, watermark, text',
   0, 1),
  ('preset_illustration_clean', 'イラスト・清潔感',
   'clean illustration, soft colors, detailed, high quality',
   'low quality, messy lines, watermark, text, bad anatomy',
   0, 1);

INSERT OR IGNORE INTO prompt_translation_terms
  (term_id, source_text, target_text, category, weight, is_enabled)
VALUES
  ('pt_person_girl', '少女', 'girl', '人物', 10, 1),
  ('pt_person_woman', '女性', 'woman', '人物', 10, 1),
  ('pt_person_man', '男性', 'man', '人物', 10, 1),
  ('pt_person_child', '子供', 'child', '人物', 10, 1),
  ('pt_expression_smile', '笑顔', 'smile', '表情', 10, 1),
  ('pt_expression_gentle_smile', '優しい笑顔', 'gentle smile', '表情', 20, 1),
  ('pt_expression_serious', '真剣な表情', 'serious expression', '表情', 20, 1),
  ('pt_clothing_white_dress', '白いワンピース', 'white dress', '服装', 30, 1),
  ('pt_clothing_dress', 'ワンピース', 'dress', '服装', 10, 1),
  ('pt_clothing_suit', 'スーツ', 'suit', '服装', 10, 1),
  ('pt_place_seaside', '海辺', 'seaside', '場所', 10, 1),
  ('pt_place_city', '街中', 'city street', '場所', 10, 1),
  ('pt_place_forest', '森', 'forest', '場所', 10, 1),
  ('pt_place_room', '部屋', 'room', '場所', 10, 1),
  ('pt_time_sunset', '夕暮れ', 'sunset', '時間帯', 10, 1),
  ('pt_time_morning', '朝', 'morning', '時間帯', 10, 1),
  ('pt_time_night', '夜', 'night', '時間帯', 10, 1),
  ('pt_light_soft', '柔らかい光', 'soft light', '光', 20, 1),
  ('pt_light_backlight', '逆光', 'backlight', '光', 10, 1),
  ('pt_light_translucent', '透明感', 'translucent atmosphere', '画風', 10, 1),
  ('pt_style_anime', 'アニメ風', 'anime style', '画風', 10, 1),
  ('pt_style_photo', '写真風', 'photorealistic', '画風', 10, 1),
  ('pt_quality_detailed', '細かい描写', 'detailed', '品質', 10, 1),
  ('pt_quality_high', '高品質', 'high quality', '品質', 10, 1),
  ('pt_camera_closeup', 'アップ', 'close-up', 'カメラ', 10, 1),
  ('pt_camera_wide', '広角', 'wide angle', 'カメラ', 10, 1),
  ('pt_composition_center', '中央配置', 'center composition', '構図', 10, 1),
  ('pt_composition_full_body', '全身', 'full body', '構図', 10, 1),
  ('pt_negative_text', '文字', 'text', 'Negative', 10, 1),
  ('pt_negative_watermark', '透かし', 'watermark', 'Negative', 10, 1),
  ('pt_negative_blurry', 'ぼやけ', 'blurry', 'Negative', 10, 1),
  ('pt_negative_low_quality', '低品質', 'low quality', 'Negative', 10, 1);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('007_prompt_translation');

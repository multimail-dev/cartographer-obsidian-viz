CREATE TABLE IF NOT EXISTS saved_views (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  slug         TEXT NOT NULL,
  public_id    TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL,                 -- JSON blob, up to 64KB
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(user_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_saved_views_user ON saved_views(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_views_public ON saved_views(public_id);

-- Schema für die D1-Datenbank "metamediathek-feedback" (Binding: DB)
-- Einmalig in der Cloudflare-D1-Konsole ausführen.
CREATE TABLE IF NOT EXISTS feedback (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    INTEGER NOT NULL,          -- Unix-Millisekunden (Serverzeit)
  type  TEXT    NOT NULL,          -- 'feedback' | 'error' | 'events' | 'other'
  sid   TEXT,                      -- anonyme Session-ID des Clients
  ua    TEXT,                      -- User-Agent (gekürzt)
  build TEXT,                      -- App-Version (mm-build, z.B. "2026-08-15.1")
  body  TEXT    NOT NULL           -- komplette Einsendung als JSON
);
CREATE INDEX IF NOT EXISTS idx_feedback_ts    ON feedback(ts);
CREATE INDEX IF NOT EXISTS idx_feedback_type  ON feedback(type);
CREATE INDEX IF NOT EXISTS idx_feedback_build ON feedback(build);
-- Migration für bestehende Tabellen (einmalig):
--   ALTER TABLE feedback ADD COLUMN build TEXT;
--   CREATE INDEX IF NOT EXISTS idx_feedback_build ON feedback(build);
-- Ältere Zeilen ohne Spalte nachtragen (Version steckt im JSON der session_start-Events):
--   UPDATE feedback SET build = json_extract(body, '$.build') WHERE build IS NULL;

-- Redeploy-Trigger 2026-08-17: GitHub-Webhook-Stoerung verschluckte das Push-Event des PR-#6-Merges;
-- dieser Commit stoesst den Cloudflare-Pages-Build fuer main neu an. Kein inhaltlicher Effekt.

-- Embedding-Cache für das semantische Geschmacks-Matching (/api/embed):
CREATE TABLE IF NOT EXISTS embeddings (
  hash  TEXT PRIMARY KEY,     -- SHA-256 (hex) des eingebetteten Texts
  model TEXT NOT NULL,        -- z.B. '@cf/baai/bge-m3'
  v     TEXT NOT NULL,        -- Vektor, Int8-quantisiert, base64
  s     REAL NOT NULL,        -- Quantisierungs-Skala (float = int8 * s)
  ts    INTEGER NOT NULL      -- Unix-Millisekunden (Schreibzeitpunkt)
);

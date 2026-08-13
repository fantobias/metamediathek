-- Schema für die D1-Datenbank "metamediathek-feedback" (Binding: DB)
-- Einmalig in der Cloudflare-D1-Konsole ausführen.
CREATE TABLE IF NOT EXISTS feedback (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts   INTEGER NOT NULL,          -- Unix-Millisekunden (Serverzeit)
  type TEXT    NOT NULL,          -- 'feedback' | 'error' | 'events' | 'other'
  sid  TEXT,                      -- anonyme Session-ID des Clients
  ua   TEXT,                      -- User-Agent (gekürzt)
  body TEXT    NOT NULL           -- komplette Einsendung als JSON
);
CREATE INDEX IF NOT EXISTS idx_feedback_ts   ON feedback(ts);
CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback(type);

-- Requests are private operational data and are not portable account exports.
CREATE TABLE IF NOT EXISTS password_support_requests(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE SET NULL,email TEXT NOT NULL,identity_hash TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','verified','resolved','rejected')),created INTEGER NOT NULL,expires INTEGER NOT NULL,verified_by TEXT REFERENCES users(id) ON DELETE SET NULL,verified_at INTEGER,verification_note TEXT,password_stamp TEXT,resolved_at INTEGER);
CREATE INDEX IF NOT EXISTS password_support_identity ON password_support_requests(identity_hash,created);
CREATE INDEX IF NOT EXISTS password_support_status ON password_support_requests(status,created);
CREATE INDEX IF NOT EXISTS password_support_expiry ON password_support_requests(expires);

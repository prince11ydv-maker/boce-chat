-- Session-bound push credentials are runtime data, deliberately excluded from
-- portable exports. Reinstalling/restoring an app requires fresh opt-in.
CREATE TABLE IF NOT EXISTS push_devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_token TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN('web','android')),endpoint_hash TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,label TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS push_devices_owner ON push_devices(user_id,session_token);
CREATE TABLE IF NOT EXISTS push_queue(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,notification_id TEXT NOT NULL REFERENCES app_notifications(id) ON DELETE CASCADE,state TEXT NOT NULL CHECK(state IN('pending','sending','sent','failed')),attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL,lease TEXT,lease_until INTEGER,expires_at INTEGER NOT NULL,created INTEGER NOT NULL,last_code TEXT);
CREATE INDEX IF NOT EXISTS push_queue_due ON push_queue(state,next_attempt,lease_until);
CREATE INDEX IF NOT EXISTS push_queue_expiry ON push_queue(expires_at);

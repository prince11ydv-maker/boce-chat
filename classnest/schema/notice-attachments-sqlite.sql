-- Separate table preserves the existing notices INSERT shape.
CREATE TABLE IF NOT EXISTS notice_attachments(notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,filename TEXT NOT NULL UNIQUE,original_name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL CHECK(size>0 AND size<=20971520));

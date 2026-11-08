-- Profile choices organize the teacher dashboard; they do not grant access.
CREATE TABLE IF NOT EXISTS teacher_semesters(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,semester INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,updated INTEGER NOT NULL,PRIMARY KEY(user_id,semester));
CREATE INDEX IF NOT EXISTS teacher_semesters_semester ON teacher_semesters(semester,user_id);

-- Run as the database owner before the semester-aware application release.
IF COL_LENGTH(N'dbo.users',N'semester') IS NULL
  ALTER TABLE dbo.users ADD semester int NULL REFERENCES dbo.semesters(id);
GO
UPDATE dbo.users SET semester=COALESCE(
  (SELECT s.id FROM dbo.settings w JOIN dbo.semesters s ON s.id=w.semester WHERE w.id=1),
  (SELECT min(id) FROM dbo.semesters)
) WHERE semester IS NULL;
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE name=N'users_semester' AND object_id=OBJECT_ID(N'dbo.users'))
  CREATE INDEX users_semester ON dbo.users(semester);

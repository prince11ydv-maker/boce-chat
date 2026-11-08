-- Run as the database owner before the routine-aware application release.
IF OBJECT_ID(N'dbo.routines',N'U') IS NULL
  CREATE TABLE dbo.routines(
    semester int NOT NULL REFERENCES dbo.semesters(id),
    kind nvarchar(10) NOT NULL CHECK(kind IN('class','exam')),
    content nvarchar(max) NOT NULL,
    revision int NOT NULL CHECK(revision>0),
    updated nvarchar(24) NOT NULL,
    PRIMARY KEY(semester,kind)
  );

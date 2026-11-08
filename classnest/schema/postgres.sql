-- Application tables are private to the server. No browser Data API grants.
CREATE TABLE settings(id integer PRIMARY KEY CHECK(id=1),name text,institution text,semester integer NOT NULL);
CREATE TABLE semesters(id integer PRIMARY KEY,name text NOT NULL);
CREATE TABLE users(id text PRIMARY KEY,name text NOT NULL,email text UNIQUE NOT NULL,password text NOT NULL,role text NOT NULL DEFAULT 'pending' CHECK(role IN ('admin','member','teacher','pending','blocked')),created text NOT NULL,semester integer REFERENCES semesters(id),accounttype text NOT NULL DEFAULT 'student' CHECK(accounttype IN ('student','teacher')));
CREATE UNIQUE INDEX users_one_admin ON users(role) WHERE role='admin';
CREATE TABLE sessions(token text PRIMARY KEY,"userId" text NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires bigint NOT NULL);
CREATE TABLE auth_failures(identity text PRIMARY KEY,attempts integer NOT NULL,reset bigint NOT NULL);
CREATE TABLE rate_limits(identity text PRIMARY KEY,attempts integer NOT NULL,reset bigint NOT NULL);
CREATE TABLE subjects(id text PRIMARY KEY,semester integer REFERENCES semesters(id),name text NOT NULL,code text NOT NULL DEFAULT '',description text NOT NULL DEFAULT '',color text NOT NULL DEFAULT 'sage');
CREATE TABLE notes(id text PRIMARY KEY,"subjectId" text NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,title text NOT NULL,content text NOT NULL DEFAULT '',filename text,"originalName" text,mime text,size integer NOT NULL DEFAULT 0,"authorId" text NOT NULL REFERENCES users(id),created text NOT NULL);
CREATE TABLE notices(id text PRIMARY KEY,semester integer REFERENCES semesters(id),title text NOT NULL,content text NOT NULL,category text NOT NULL,pinned integer NOT NULL DEFAULT 0,"authorId" text REFERENCES users(id),created text NOT NULL);
CREATE TABLE threads(id text PRIMARY KEY,semester integer REFERENCES semesters(id),title text NOT NULL,content text NOT NULL,"authorId" text REFERENCES users(id),created text NOT NULL);
CREATE TABLE replies(id text PRIMARY KEY,"threadId" text REFERENCES threads(id) ON DELETE CASCADE,content text NOT NULL,"authorId" text REFERENCES users(id),created text NOT NULL);
CREATE TABLE events(id text PRIMARY KEY,semester integer REFERENCES semesters(id),title text NOT NULL,description text NOT NULL DEFAULT '',date text NOT NULL,kind text NOT NULL,location text NOT NULL DEFAULT '',"authorId" text REFERENCES users(id));
CREATE TABLE routines(semester integer NOT NULL REFERENCES semesters(id),kind text NOT NULL CHECK(kind IN('class','exam')),content text NOT NULL,revision integer NOT NULL CHECK(revision>0),updated text NOT NULL,PRIMARY KEY(semester,kind));
CREATE TABLE upload_tickets(id text PRIMARY KEY,"userId" text NOT NULL REFERENCES users(id),filename text UNIQUE NOT NULL,"originalName" text NOT NULL,mime text NOT NULL,size integer NOT NULL,created bigint NOT NULL,expires bigint NOT NULL,status text NOT NULL CHECK(status IN ('pending','complete','rejected')));
CREATE INDEX subjects_semester ON subjects(semester);
CREATE INDEX notes_subject_created ON notes("subjectId",created DESC);
CREATE INDEX notes_author ON notes("authorId");
CREATE INDEX sessions_user_expiry ON sessions("userId",expires DESC);
CREATE INDEX replies_thread ON replies("threadId");
CREATE INDEX replies_author ON replies("authorId");
CREATE INDEX notices_semester ON notices(semester);
CREATE INDEX notices_author ON notices("authorId");
CREATE INDEX threads_semester ON threads(semester);
CREATE INDEX threads_author ON threads("authorId");
CREATE INDEX events_semester ON events(semester);
CREATE INDEX events_author ON events("authorId");
CREATE INDEX tickets_expiry ON upload_tickets(expires);
CREATE INDEX tickets_user ON upload_tickets("userId");
CREATE INDEX rate_limits_expiry ON rate_limits(reset);
CREATE INDEX auth_failures_expiry ON auth_failures(reset);
DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['settings','semesters','users','sessions','auth_failures','rate_limits','subjects','notes','notices','threads','replies','events','upload_tickets','routines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated, PUBLIC',tbl);
  END LOOP;
END $$;

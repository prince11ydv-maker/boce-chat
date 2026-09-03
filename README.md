# BOCE Chat — Foundation Scaffold

A real, runnable starting point for BOCE Chat: an invite-only messaging +
social + community platform. This is the **foundation slice** — auth,
invitations, profiles/privacy, and real-time 1:1 messaging — built with
the actual architecture and security patterns the rest of the spec
(groups, communities, calls, feeds, admin dashboard…) will build on top of.

Nothing here is a mockup: the auth flow really hashes and verifies
passwords, the invite system really enforces one-time-use codes
atomically, and privacy settings are enforced in the API response, not
just hidden in the UI.

## Stack

- **Frontend:** Next.js 14 (App Router) + TypeScript + Tailwind
- **Backend:** Node.js + TypeScript + Express
- **Database:** PostgreSQL via Prisma
- **Cache / presence / rate limiting:** Redis
- **Real-time:** Socket.IO (Redis adapter, so it scales past one process)
- **Auth:** httpOnly JWT access token + opaque hashed refresh token

## Project layout

```
boce-chat/
├── apps/
│   ├── api/                 # Express API + Socket.IO server
│   │   ├── prisma/schema.prisma
│   │   └── src/
│   │       ├── config/      # env validation, prisma client, redis client
│   │       ├── middleware/  # auth, rate limiting, validation, error handling
│   │       ├── routes/      # → controllers
│   │       ├── controllers/ # request handling
│   │       ├── services/    # business logic (password, tokens, invites, privacy)
│   │       └── sockets/     # real-time: presence, chat gateway
│   └── web/                 # Next.js app
│       ├── app/              # login, register, and the authenticated shell
│       ├── components/       # nav, ui
│       └── lib/api.ts        # typed fetch wrapper
├── packages/shared/          # (reserved) types shared between api + web
└── docker-compose.yml        # local Postgres + Redis
```

## Getting started

```bash
# 1. Start local infra
docker compose up -d

# 2. Install dependencies (run once at the repo root)
npm install

# 3. Configure environment
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
# Edit apps/api/.env: set real random values for JWT_ACCESS_SECRET / JWT_REFRESH_SECRET

# 4. Set up the database
npm run prisma:generate
npm run prisma:migrate

# 5. Run both apps (two terminals)
npm run dev:api    # http://localhost:4000
npm run dev:web    # http://localhost:3000
```

You'll land on the sign-in screen. Since registration requires a valid
invitation code and there's no seed data yet, create one directly for
your first account:

```sql
-- run against the boce_chat database, after you've registered your first
-- (owner) account through a temporary code, OR seed one manually:
insert into invitations (id, code, "createdById", "maxUses", "useCount", status, "createdAt")
values (gen_random_uuid(), 'FOUNDER1', '<some-existing-user-id-or-a-placeholder-uuid>', 1, 0, 'ACTIVE', now());
```
In practice you'd build a small `seed.ts` script (or a one-off admin CLI
command) for this — it's on the roadmap below.

## What's implemented in this slice

- **Auth:** username/email + password registration and login, Argon2id
  password hashing, httpOnly cookie sessions, refresh-token rotation
  storage (hashed, never stored raw), session/device records, security
  logging on login attempts.
- **Invitations:** invite-only registration, atomic redemption (no
  race condition on a `maxUses: 1` code under concurrent signups),
  admin create/list/disable endpoints, public code-check endpoint.
- **Profiles & privacy:** locked fields (username, full name, DOB,
  school) can only change via an admin-reviewed `ProfileChangeRequest`;
  a single `privacy.service.ts` is the one place that decides "can this
  viewer see that field," used by every profile-serving endpoint so a
  new route can't accidentally leak private data.
- **Real-time 1:1 messaging:** Socket.IO gateway for send/typing/read
  receipts, REST endpoint for paginated history (never loads a full
  chat at once), a private "Saved Messages" self-chat created for every
  new user, disappearing-message timer field wired into message
  creation.
- **Server-side enforcement throughout:** every mutating route validates
  its body with Zod; role checks (`requireRole`) happen in middleware,
  not the frontend; chat membership is checked before any socket event
  touches a chat.
- **Frontend shell:** sign-in / register screens, an authenticated
  layout with a desktop sidebar + mobile bottom nav covering the spec's
  main navigation, and placeholder pages (with real empty states, not
  lorem ipsum) for every top-level section so the navigation structure
  is real and clickable today.

## Honest gaps — what this is *not* yet

This is one vertical slice of a 60-section spec. Deliberately not built
yet, in roughly the order I'd tackle them next:

1. **Groups & communities/channels** — same patterns as `Chat`/`ChatMember`,
   extended with roles and channel-level permission overrides.
2. **Posts, stories, feed ranking** — new `Post`/`Story` tables +
   privacy-aware feed queries reusing `privacy.service.ts`.
3. **Voice/video calls (WebRTC)** — signaling over the existing Socket.IO
   connection, a `calls`/`call_participants` schema, TURN/STUN config.
4. **True end-to-end encryption** — the schema has a `ciphertext` field
   and a comment flagging where key exchange belongs, but no E2E crypto
   is implemented yet; today, `body` is stored server-side in plaintext.
   Don't treat current messages as end-to-end encrypted.
5. **Admin dashboard UI** — the API-side role checks exist
   (`requireRole("ADMIN")`), but there's no dashboard frontend yet.
6. **Reports/moderation, polls, events, notifications delivery, media
   upload to S3-compatible storage, 2FA, OAuth (Google) and OTP (phone)
   auth, search, PWA service worker, i18n.**

Each of these follows the same shape already established here: a Prisma
model block, a service with the actual business rule, a Zod-validated
controller, and a route behind `requireAuth`/`requireRole`. That
repetition is intentional — it's what makes the codebase predictable to
extend.

## Security notes for anyone extending this

- Never trust a role or ID from the request body for authorization —
  always check `req.user` (set by `requireAuth` from the verified JWT).
- Any new "can user X see Y" check belongs in `privacy.service.ts`, not
  inlined in a controller — that's how leaks happen when a second
  endpoint is added later.
- Locked profile fields (`username`, `fullName`, `dateOfBirth`, `school`)
  must never be direct-writable by a user-facing update endpoint.

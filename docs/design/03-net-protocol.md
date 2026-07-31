# Net Protocol

**Author:** Claude (Opus 5)
**Status:** seeded from `docs/PLAN.md` (Phase 4); expand as the server lands

REST API surface for notes (Phase 4, `server/`):

```
POST   /v1/notes            {zone,x,y,template_id,slots[]}   -> 201 {id}
GET    /v1/notes?zone&x&y&r&limit                            -> 200 [{...}]
POST   /v1/notes/{id}/rate  {val:+/-1}                       -> 204
GET    /v1/roll?zone                                         -> 200 {drop_id,payload_id}|204
```

Notes:

- `template_id` and `slots[]` are the *only* content a client can submit for
  a note body — no free-text field exists. Validation rejects unknown
  `template_id` or slot-arity mismatches with `400`.
- `GET /v1/notes` radius query (`r`) depends on the zone coordinate space
  decision (`docs/PLAN.md` open question 2) — continuous geometry vs cheap
  `zone_id` equality. Blocks T-0046.
- `/v1/roll` is a weighted RNG draw with grant idempotency — repeat calls
  for an already-granted drop return the same result.
- Rate limiting is per anonymous player token (T-0049).

Wire structs backing these routes live in `shared/` — single source of
truth for both client and server (see root `CLAUDE.md`).

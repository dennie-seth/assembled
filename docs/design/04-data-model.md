# Data Model

**Author:** Claude (Opus 5)
**Status:** seeded from `docs/PLAN.md` (Phase 4); expand as the server lands

Postgres schema (Phase 4, `server/`), plain SQL migrations, no ORM:

```sql
-- immutable template tables, seeded from shared/ headers
note_templates(id SMALLINT PK, slots SMALLINT);   -- e.g. "Try {0} ahead"
note_words(id SMALLINT PK, category SMALLINT);

notes(
  id          BIGSERIAL PK,
  zone_id     INT       NOT NULL,
  pos_x       REAL      NOT NULL,
  pos_y       REAL      NOT NULL,
  template_id SMALLINT  NOT NULL REFERENCES note_templates,
  slot_a      SMALLINT  REFERENCES note_words,
  slot_b      SMALLINT  REFERENCES note_words,
  author      UUID      NOT NULL,     -- anon client token
  score       INT       NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON notes (zone_id, score DESC);
CREATE INDEX ON notes USING gist (point(pos_x, pos_y));

ratings(note_id BIGINT, voter UUID, val SMALLINT, PRIMARY KEY(note_id, voter));
secret_drops(id SERIAL PK, zone_id INT, weight INT, payload_id INT);
drop_grants(player UUID, drop_id INT, granted_at TIMESTAMPTZ, PRIMARY KEY(player, drop_id));
```

**This is the UGC guarantee.** FK constraints on `template_id`/`slot_*` make
arbitrary free text unrepresentable at the schema level — not a filter, a
structural impossibility.

`shared/note_templates.hpp` (T-0043) and this SQL seed generator must stay
in parity — enforced by a C++/SQL parity test.

-- T-0043: creates and seeds the four immutable lookup tables that make
-- arbitrary player text unrepresentable at the schema level (sql.md).
--
-- Tables created here:
--   note_templates  — template IDs + slot arity
--   note_words      — word IDs + category
--   archetype       — archetype IDs (shared between client and server)
--   anchor_tag      — (archetype_id, tag) pairs; contractual anchor surface
--
-- All INSERT statements use ON CONFLICT DO NOTHING so this migration is
-- idempotent: running it twice populates the same rows without error.
--
-- Seed data is the single source of truth defined in shared/note_templates.hpp.
-- The C++/SQL parity test (server/test/seed_parity_test.cpp) enforces that
-- these two never drift.

-- ─── note_templates ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS note_templates (
    id    SMALLINT PRIMARY KEY,
    slots SMALLINT NOT NULL CHECK (slots BETWEEN 0 AND 2)
);

-- 20 templates shipped at launch (02-notes-system.md §2).
-- slots: number of note_words slot fillings required (0=fixed/item-only,
--        1=slot_a only, 2=slot_a + slot_b).
INSERT INTO note_templates (id, slots) VALUES
    (1,  2), -- {ACTION} {QUALIFIER}
    (2,  2), -- {HAZARD} {DIRECTION}
    (3,  2), -- {OBJECT} {DIRECTION}
    (4,  2), -- {ACTION} {DIRECTION}
    (5,  1), -- {HAZARD}
    (6,  1), -- {ACTION}
    (7,  1), -- {DIRECTION}
    (8,  1), -- {OBJECT} here
    (9,  2), -- try {ACTION} {QUALIFIER}
    (10, 2), -- beware {HAZARD} {DIRECTION}
    (11, 2), -- {QUALIFIER}, {ACTION}
    (12, 1), -- I need help {DIRECTION}
    (13, 0), -- I need {ITEM_REF}              (item_ref column only)
    (14, 0), -- something is wrong             (fixed phrase)
    (15, 1), -- {OBJECT} opens with {ITEM_REF} (slot_a=OBJECT + item_ref)
    (16, 1), -- go {DIRECTION}
    (17, 2), -- {ACTION} the {OBJECT}
    (18, 2), -- {OBJECT} {QUALIFIER}
    (19, 1), -- watch for {HAZARD}
    (20, 0)  -- safe passage                   (fixed phrase)
ON CONFLICT DO NOTHING;

-- ─── note_words ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS note_words (
    id       SMALLINT PRIMARY KEY,
    -- category matches assembled::WordCategory enum in shared/note_templates.hpp:
    -- 1=DIRECTION 2=HAZARD 3=ACTION 4=OBJECT 5=QUALIFIER
    category SMALLINT NOT NULL CHECK (category BETWEEN 1 AND 5)
);

-- 56 words shipped at launch (02-notes-system.md §2).
-- ID ranges: 1-8 DIRECTION · 9-20 HAZARD · 21-32 ACTION · 33-48 OBJECT · 49-56 QUALIFIER
INSERT INTO note_words (id, category) VALUES
    -- DIRECTION (category 1) — ids 1-8
    (1,  1), -- ahead
    (2,  1), -- behind
    (3,  1), -- below
    (4,  1), -- above
    (5,  1), -- left
    (6,  1), -- right
    (7,  1), -- within
    (8,  1), -- beyond
    -- HAZARD (category 2) — ids 9-20
    (9,  2), -- the drop
    (10, 2), -- the watcher
    (11, 2), -- the sound
    (12, 2), -- the cold
    (13, 2), -- the still air
    (14, 2), -- the dark
    (15, 2), -- the heat
    (16, 2), -- the trap
    (17, 2), -- the gap
    (18, 2), -- the edge
    (19, 2), -- the beast
    (20, 2), -- the current
    -- ACTION (category 3) — ids 21-32
    (21, 3), -- wait
    (22, 3), -- run
    (23, 3), -- hide
    (24, 3), -- cross
    (25, 3), -- turn back
    (26, 3), -- listen
    (27, 3), -- do not
    (28, 3), -- proceed
    (29, 3), -- stop
    (30, 3), -- search
    (31, 3), -- climb
    (32, 3), -- descend
    -- OBJECT (category 4) — ids 33-48
    (33, 4), -- the door
    (34, 4), -- the lamp
    (35, 4), -- the bones
    (36, 4), -- the machine
    (37, 4), -- the seam
    (38, 4), -- the switch
    (39, 4), -- the lever
    (40, 4), -- the passage
    (41, 4), -- the key
    (42, 4), -- the lock
    (43, 4), -- the window
    (44, 4), -- the floor
    (45, 4), -- the wall
    (46, 4), -- the ceiling
    (47, 4), -- the pipe
    (48, 4), -- the hatch
    -- QUALIFIER (category 5) — ids 49-56
    (49, 5), -- slowly
    (50, 5), -- twice
    (51, 5), -- never
    (52, 5), -- only once
    (53, 5), -- if alone
    (54, 5), -- carefully
    (55, 5), -- quietly
    (56, 5)  -- quickly
ON CONFLICT DO NOTHING;

-- ─── archetype ────────────────────────────────────────────────────────────────

-- Archetype IDs are shared between client and server (02-notes-system.md §3,
-- 04-data-model.md §2). Source of truth: assembled::kArchetypeIds in
-- shared/note_templates.hpp.
CREATE TABLE IF NOT EXISTS archetype (
    id SMALLINT PRIMARY KEY
);

INSERT INTO archetype (id) VALUES
    (1), -- HOSPITAL
    (2), -- STATION
    (3), -- BRIDGE
    (4), -- MARKET
    (5)  -- ARCHIVE
ON CONFLICT DO NOTHING;

-- ─── anchor_tag ───────────────────────────────────────────────────────────────

-- Anchor tags are the contractual surface between archetypes and their
-- variants (02-notes-system.md §3, 04-data-model.md §2 INV-12).
-- Source of truth: assembled::kAnchorTags in shared/note_templates.hpp.
CREATE TABLE IF NOT EXISTS anchor_tag (
    archetype_id SMALLINT NOT NULL REFERENCES archetype,
    tag          SMALLINT NOT NULL,
    PRIMARY KEY (archetype_id, tag)
);

INSERT INTO anchor_tag (archetype_id, tag) VALUES
    -- HOSPITAL (archetype 1): 5 tags
    (1, 1), -- entrance
    (1, 2), -- ward_north
    (1, 3), -- ward_south
    (1, 4), -- basement
    (1, 5), -- roof
    -- STATION (archetype 2): 4 tags
    (2, 1), -- platform
    (2, 2), -- waiting_room
    (2, 3), -- tracks
    (2, 4), -- booth
    -- BRIDGE (archetype 3): 4 tags
    (3, 1), -- approach
    (3, 2), -- midpoint
    (3, 3), -- tower
    (3, 4), -- below
    -- MARKET (archetype 4): 5 tags
    (4, 1), -- gate
    (4, 2), -- stalls
    (4, 3), -- back_room
    (4, 4), -- cellar
    (4, 5), -- square
    -- ARCHIVE (archetype 5): 6 tags
    (5, 1), -- lobby
    (5, 2), -- stacks
    (5, 3), -- reading_room
    (5, 4), -- vault
    (5, 5), -- rooftop
    (5, 6)  -- basement
ON CONFLICT DO NOTHING;

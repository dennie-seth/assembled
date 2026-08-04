# 17 — Localization

> **Author:** Claude · **Reviewed:** pending · **Status:** v1, draft
> Related: **02 Notes System** §1–§2, **03 Net Protocol** §3, **09 Identity** §1, **13 Asset Pipeline**
> **Purpose:** the localization mechanism. Three systems already assume one exists; this specifies it. Previously uncovered.

## 1. Position

**Borrowed from Unreal's `FText`: display text is a *reference*, never a string.**

The design is already halfway there without having named it — notes travel as integer tuples, item types are `SMALLINT`, error codes are enums. What was missing is the discipline that keeps it that way, and the build check that proves it.

| `FText` property | Here |
|---|---|
| Text is a namespace + key, not a literal | Catalogue tables: `note_words`, `note_templates`, `item_type`, error enums |
| Immutable, resolved at display time | Server sends IDs only. The client resolves, always |
| Distinct type from raw string | `LocId` wrapper (§2) |
| Gather → export → translate → compile | Godot `.po` → `.translation` |
| Named format arguments | Required — §4 |
| ICU plural / gender rules | **Not adopted.** Sidestepped by §5 |

## 2. The Type Split

> **`LocId` and display text are different types.** An ID cannot be rendered; display text cannot be sent over the wire or written to the database.

A thin wrapper in the GDExtension — `LocId` is a POD integer with no `to_string()`. Resolution happens only through the translation layer. This makes the failure mode a compile error instead of a raw `47` appearing on screen in a shipped build.

**It also solves the seed phrase for free.** `09` §1 requires the phrase wordlist to be **non-localized** — a phrase written down on a Russian install must restore on an English one. Under the type split, phrase words are *identifiers*, not text. They are structurally exempt rather than exempt by a comment somebody might not read.

### What is and is not localized

| Localized | Never localized |
|---|---|
| Note vocabulary (56 words) and templates (~24) | **Seed-phrase wordlist** (`09` §1) |
| Item type names | Anchor tags — internal, never shown |
| Archetype names (*Hospital*, *Signal Tower*) | Archetype and variant IDs |
| Error-code messages (`03` §3) | Error code *numbers* |
| UI, first-run copy, collapse summary | `custody_depth`, counts — rendered as bare numerals (§5) |

## 3. Build Checks

Same class as INV-12 and P-4 — a declared set that must match, verified at build time rather than discovered at runtime.

| # | Check |
|---|---|
| **L-1** | Every `LocId` in the catalogue resolves in every **shipped** locale. A missing key fails the build |
| **L-2** | Every locale's version of a template declares **the same named slot set**. Reordering is allowed; adding, dropping, or renaming a slot is not |
| **L-3** | No locale contains a format placeholder that is positional rather than named |
| **L-4** | The seed-phrase wordlist has exactly one form and is absent from every translation catalogue |

A locale under construction is marked incomplete and excluded from the build rather than blocking it — otherwise L-1 makes starting a new translation impossible.

## 4. Templates Take Named Arguments

`02` §2 currently shows positional slots:

```
"{ACTION} {QUALIFIER}, {DIRECTION}"   -> "Hide slowly, below"
```

**Positional substitution cannot survive translation.** Russian, German, and Japanese all want different orderings, and some want the direction first. If the slots are positional the translator cannot reorder them without the arguments landing in the wrong places.

So each locale supplies its **own template string** with the **same named slots**, free to order them however the language wants. L-2 enforces the slot set; the ordering is the translator's business.

This is a change to `02` §2 — flagged to the design chat, not made here.

## 5. Two Constraints That Replace ICU

### 5.1 No numbers inside sentences

`07` §1 surfaces `custody_depth` as *"this passed through 14 universes before it reached you."* One such string drags in the full plural-rules dependency: Russian has three plural forms, Polish four.

**Numbers render beside text, never inside it.** The count is its own element; the words around it do not agree with it. No ICU, no plural tables, no per-locale numeric grammar.

This is also more consistent with the rest of the design, which already refuses to show the collapse clock as a number and carries it as colour instead (`01` §8).

### 5.2 Telegraphic register, grammatically inert vocabulary

Russian inflects for case. `"{OBJECT} opens with {ITEM_REF}"` needs the item in the **instrumental** case — *ключом*, not *ключ*. One stored form per word is not enough, and storing six case forms per word multiplies the vocabulary by six in every inflected language.

**The escape is the register.** Notes are **fragments, not sentences** — nominative, telegraphic, uninflected:

> *The watcher. Ahead.* — not *There is a watcher ahead.*

This is already the voice the design wants (`02` §2's Dark Souls reference), so the constraint costs nothing aesthetically and removes the morphology problem entirely.

**Consequent rule on vocabulary:** only grammatically inert parts of speech.

| Allowed | Avoid |
|---|---|
| Nouns, nominative singular | Adjectives that agree for gender or number |
| Adverbs | Verbs requiring a conjugated subject |
| Imperatives | Anything needing an article that inflects |

This constrains the **English** vocabulary too, since the word list is authored once and translated. `02` §12 **N-3** (final template and word list) should be authored against this rule from the start — retrofitting it means re-translating everything.

## 6. Pipeline

```
shared/ catalogue (IDs)      <- single source of IDs, client + server
  -> gather                     extract every LocId into a key list
  -> .po per locale             translator-facing, diffable, version-controlled
  -> compile                    Godot .translation resources
  -> validate                   L-1 through L-4
  -> ship                       client-side only; the server never holds strings
```

**The server never stores or sends display text in any language.** It holds IDs. This is what makes localization cost nothing at the protocol layer, and it is why `03` §3 specified enum error codes rather than messages.

**Adding a word is a client patch, not a server migration** — the ID space is shared via `shared/` (T-0043), and a client that does not know an ID renders a neutral placeholder rather than failing.

## 7. Consequences for Art

**Cyrillic at 16px is real work.** The UI font must carry Cyrillic glyphs at pixel scale, and most pixel fonts do not. This is an asset requirement, not a text one — it belongs in the Phase 6 inventory (A-2).

**Russian strings run 15–30% longer than English.** Any fixed-width UI element sized to English will overflow. At 384×216 there is very little slack, so text elements should be sized against the **longest shipped locale**, not English.

> Both of these argue for shipping Russian at v1 rather than later: they are cheap to accommodate while the UI is being designed and expensive to retrofit once every element is sized to English.

## 8. Scope for v1

**English + Russian.** Russian is chosen deliberately as the stress case — it inflects for case, has three plural forms, uses a non-Latin script, and expands string length. A design that survives Russian will survive most additions; one built only against English will not.

It is also the right register for the setting.

## 9. Open

| # | Question | Blocks |
|---|---|---|
| **L-A** | Pixel font with full Cyrillic coverage at 16px — source, licence, or authored? | Phase 6, A-2 |
| **L-B** | Does a client render an unknown ID as a placeholder, or hide the element? | T-0064 |
| **L-C** | Are archetype names localized, or treated as proper nouns left in English? | `02` N-3 |
| **L-D** | Translator workflow — who translates, and how is a `.po` round-trip reviewed? | launch |
| **L-E** | Does the collapse summary (`01` §6) need any string beyond a tier name and a count? | content |

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-02 | Initial — `FText`-borrowed type split, L-1…L-4 build checks, named template arguments, no-numbers-in-sentences and telegraphic-register rules replacing ICU, English + Russian at v1 | Claude, rev. pending |

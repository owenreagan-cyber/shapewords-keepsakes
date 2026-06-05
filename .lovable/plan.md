## Goal

Replace the single "Generate Best Possible Design" button with a two-step flow the user controls explicitly, harden the word filter for a Grade-4 classroom, drive color from the student's theme, and ship a true 5×10 @ 300 DPI JPG export.

## UI changes (`src/routes/index.tsx`)

Replace the single amber button in the AI Optimizer section with two stacked buttons (and keep Etsy Mode toggle above them):

1. **"Generate Words"** (primary, amber)
   - Calls Gemini word expansion only (no re-pack, no layout tweaks).
   - Runs the school-appropriate filter on the returned list before storing in `words` state.
   - Status: "Generating school-safe words…".
   - On success: re-pack once with current config so the canvas reflects the new vocabulary.

2. **"Best Framable Settings"** (secondary, dark)
   - Does NOT call Gemini. Operates on whatever words are currently loaded (seed or generated).
   - Forces a known-good config for legibility + density:
     - `etsyMode: true, emphasis: 4, density: 100, scaling: 22, adherence: 95, centerBias: 85, rotation: 15, randomness: 10`
     - `fontFamily`: pick from a theme map (sports → "Bebas Neue", dance → "Cormorant", boy → "Archivo Black", girl → "Outfit", default keeps current).
   - Builds a **3-color palette** matched to the theme/shape (see below), passes it as `palette` override into the render.
   - Re-packs up to 3 attempts, keeps highest `coverage + balanceScore`, then renders the winner once (clears canvas first).

The existing `handleGenerate` becomes two functions: `handleGenerateWords` and `handleBestSettings`. The 4-attempt refinement loop moves into `handleBestSettings`.

## School-appropriate filter (`src/lib/gemini.ts`)

Add a `BANNED_WORDS` set covering appearance/romantic/age-inappropriate terms (e.g. `cute, beautiful, sexy, hot, pretty, gorgeous, attractive, handsome, adorable, lovely`, plus any word with `love` outside `loving/loved/lovable` … finalized list in code). Export `sanitizeWords(entries)` that lowercases & filters, drops banned exact matches and substrings of banned roots, and ensures the student name survives. Apply it inside `callWordExpansion` before returning, AND in the route after seed expansion.

## Theme-driven 3-color palette

Add a helper in `src/lib/students.ts` (or a new `src/lib/themePalettes.ts`) that returns `[dark, mid, accent]` keyed by theme keywords:

- **Sports / Athletics / Energy / Leadership** → `["#0A0A0A", "#1E40AF", "#DC2626"]` (black + navy + red)
- **Dance / Performance / Artistic / Joy** → `["#1A0B2E", "#7C3AED", "#EC4899"]` (plum + violet + pink)
- **Boy themes (Adventure, Loyalty, default male shape)** → `["#0F172A", "#1E3A8A", "#F59E0B"]` (slate + navy + amber)
- **Girl themes (Warm Kindness, Elegance, Joy)** → `["#1F1147", "#9333EA", "#F472B6"]` (deep purple + violet + rose)
- Fallback: current `student.colorPalette` + `mix(primary, bg, 0.55)`.

`handleBestSettings` calls this helper, then passes the resulting array as `palette` through the existing `PackOptions.palette` field (already wired into the worker).

## 5×10 @ 300 DPI export (`src/routes/index.tsx`)

- Update `EXPORT_RES.tall` label to `"1500x3000px (5x10 @ 300 DPI)"` and set `w: 1500, h: 3000`.
- Add `ORIENTATION_OUTPUT_RES_5x10 = { portrait: { w: 1500, h: 3000 }, landscape: { w: 3000, h: 1500 } }`.
- `handleDownload`:
  - Render to `5x10` size by orientation.
  - Export as JPEG quality `0.95`.
  - Filename: `${nameField}_WordArt_5x10_300dpi.jpg`.
- Leave existing 8×10 preset available in the resolution dropdown; the download button always uses 5×10 per the request.

## Out of scope

- Worker packer internals (already tuned in the previous turn).
- Silhouette generation route.
- New sliders or preset entries.

## Verify

- Click "Generate Words" → words list refreshes, no `cute/beautiful/sexy` present, canvas re-packs with current settings.
- Click "Best Framable Settings" on a sports student → palette goes black/navy/red, name centered ~10% canvas, no glyph crossing the outline, minimal white space.
- Click "Download" → file is `*_5x10_300dpi.jpg`, 1500×3000 (portrait), opens in Preview at 5"×10" @ 300 DPI.

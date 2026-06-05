## Goal

Tighten `src/lib/wordPacker.worker.ts` so output is dense, legible, and strictly contained — no bleed, clear hierarchy, palette-driven color.

## Changes

### 1. Strict boundary adherence (`boxInsideMask`)
- Replace the 5×3 grid sample with a **four-corner test + perimeter sweep**: all 4 corners of the (inset) bbox MUST be `1` in the mask, plus 8 midpoint samples along the perimeter. Any miss → reject and continue the spiral.
- Add a fixed **edge margin** `EDGE_PAD = max(2px, minDim * 0.006)` shrinking every candidate box before the mask test, so glyphs never touch the silhouette edge.
- Keep the adherence-driven inset, but floor it at `EDGE_PAD`.
- Remove the canvas-boundary `< 4` check in favor of the unified `EDGE_PAD`.

### 2. Anchored placement & hierarchy
- **Tier 1 (name)**: lock to `(cx, cy)`, register its bbox in the grid FIRST (already done — verify ordering so no tier-2 word is placed before the name bbox is added).
- **Tier 2 (score ≥ 85)**: large multiplier — bump from `0.04·h` baseline to `0.05–0.065·h · scaleMul · emphasisMul`.
- **Tier 3 (40–84)**: medium, `~0.022·h`.
- **Tier 4 (10–39)**: small, `~0.013·h`.
- **Tier 5 (<50 pool)**: micro-filler, see §3.
- Sort by `importanceScore` desc (already done) — keep name forced to front.

### 3. Density & direction
- Keep Archimedean spiral with `GOLDEN_ANGLE` from center outward.
- **Rotation rule**: replace `rotChance` with a hard **80/20 split** — exactly 0° or 90°, no diagonals. Tier 1 + Tier 2 stay horizontal-only.
- **Tier 5 mortar**:
  - Min font floor **8pt** (absolute, not ratio).
  - Loop up to **400 attempts per word** shrinking from `0.012·h` down to 8pt in steps.
  - Drop early-exit (`if (!ok && i > 100) break`) so the algorithm keeps hunting gaps.
  - Always-on mask containment (already in place).

### 4. Color application from palette
- Accept the existing `primaryColor` / `accentColor` and add optional `palette: string[]` (ordered dark → light) through `PackOptions`. If absent, derive a 3-stop palette from `[primary, accent, mix(primary, bg, 0.55)]`.
- Tier 1 + Tier 2 → darkest/most vibrant entries (`palette[0]`, occasional `palette[1]` accent).
- Tier 3 → mix of `palette[0]` and `palette[1]`.
- Tier 4 → `palette[1]` dominant.
- Tier 5 micro-fillers → `palette[2]` (lightest), so they read as texture, never compete.
- Contrast guard: if a chosen color ≈ `bgColor`, fall back to `primary`.

## Files

- `src/lib/wordPacker.worker.ts` — boundary test, EDGE_PAD, tier sizing, 80/20 rotation, mortar loop, palette-tier color picker.
- `src/lib/wordPacker.ts` — extend `PackOptions` with optional `palette?: string[]`.
- `src/routes/index.tsx` — pass the active student's theme palette into `PackOptions.palette` (no UI change).

## Out of scope

- Silhouette generation route, fallback SVGs, outline thickness (already handled).
- New UI controls; tier thresholds remain as-is.
- Word-expansion / Gemini call site.

## Verify

Render Abby (teddy bear) and one athletic-theme student: confirm name centered, no word crosses the outline, tier-5 words visibly fill gaps in a lighter shade, no diagonal text.

## Root cause (confirmed in browser)

I reproduced Abby in the preview. After "Generate Words" the source list contains **162 unique words**, but only **6 are placed** (Abby, sweet, kind, caring, warm, gentle). Quality panel shows `162 unique · 0 duplicate`, coverage 81, balance 2.

The packer is healthy — the bug is **font sizing**. In `wordPacker.worker.ts` every tier's font size is computed from the **canvas height** (e.g. `height * 0.085` for the name, `height * 0.042` for tier 2). The teddy-bear silhouette only occupies a small fraction of the 3000x3750 canvas, so canvas-relative fonts become huge relative to the silhouette's interior. The name + a handful of tier-2 traits fill the whole shape and nothing else fits. The packer then bails after `MAX_CONSEC_FAIL` for tier 5.

The earlier change to add `wordCount`/`capWords` is fine — the input list is large; the placer is the bottleneck.

## Fix

Make all sizes silhouette-relative instead of canvas-relative.

### 1. `src/lib/wordPacker.worker.ts`

- Compute the **mask bounding box** (min/max x,y of filled cells) once per pack call and convert it to pixel space using canvas width/height.
- Derive a `shapeH = bbox.h` and `shapeMin = min(bbox.w, bbox.h)`; replace every `height * K` in tier 1–5 font-size formulas with `shapeH * K` (name target ~10% of `shapeH`, tier 2 ~4.2%, tier 3 ~1.9%, tier 4 ~1.15%, tier 5 ~1.0%, MIN_FONT_PT scaled from `shapeMin`).
- Replace `minDim` used for `EDGE_PAD`, search radius `startR`, and `maxR` with the bbox-derived `shapeMin` / bbox dimensions, so seeding / padding stay proportional to the shape.
- Keep the name anchored at `cx, cy` but clamp its width to `bbox.w * 0.55` instead of `width * 0.55` so it never overflows a narrow silhouette.
- Lower the tier-5 `MAX_CONSEC_FAIL` floor only after the bbox is mostly filled (raise budget to ~400) so small shapes still saturate.

### 2. `src/routes/index.tsx` — "Best Framable Settings"

- Reduce `scaling` default from 22 → 14 and `emphasis` from 4 → 3 now that sizing auto-fits the silhouette (otherwise tier 2 still dwarfs everything in a small shape).
- Keep `density: 100`, `adherence: 92` (drop 95 → 92 — at 95 the extra inset pad eats small silhouettes).
- Keep the 3-attempt best-of loop and palette override.

### 3. Verification

After the edit I'll re-run Abby in the preview and confirm placedCount jumps from 6 into the 80–150+ range with words filling the bear silhouette without overflowing it. I'll also spot-check one non-default shape (e.g. Grayson's football pose) to ensure landscape silhouettes still work.

## Files touched

- `src/lib/wordPacker.worker.ts` — bbox-based sizing + padding
- `src/routes/index.tsx` — Best Framable preset tweaks

No UI/structural changes; this is a sizing/math fix.
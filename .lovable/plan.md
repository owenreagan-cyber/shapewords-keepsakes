## Problem

The Abby output shows the exact two failure modes you flagged:

1. **The silhouette doesn't look like a bear.** It's just two stacked ovals (head + body) with no ears, arms, legs, or muzzle. That's because Gemini's image call is failing (console shows `Missing VITE_GEMINI_API_KEY in environment` — the key isn't reaching the running app) and the code falls back to `FALLBACK_BEAR_SVG`, which is literally two circles. Same root cause for every shape that "looks like a lady's dress" — the fallbacks are too generic.
2. **Words stick out past the outline.** The packer only checks the word's center + two corners against the mask, and tier‑3/4/5 words are placed with `Math.random() < adherence` — so a large fraction of words bypass the mask check entirely and land outside the shape.

For frame-quality keepsakes, both need to be fixed.

## Plan

### 1. Reliable, high-quality silhouettes (server-side, no browser key)

- Move shape generation off the browser `VITE_GEMINI_API_KEY` (which is leaking + currently undefined) onto a **TanStack server route** `/api/generate-silhouette` that calls the Lovable AI Gateway image endpoint with `LOVABLE_API_KEY`.
- Use `openai/gpt-image-2` (higher fidelity than `gemini-2.5-flash-image-preview`) with a tightened prompt: *pure black silhouette, plush-toy chunky proportions, instantly recognizable features (ears, snout, arms, legs for a bear), centered, 80% of frame, pure white background, no outline/text/shading*.
- Return PNG as data URL; client already handles data URLs in `buildMaskFromSvg`.
- Cache result per `(shape, style)` in `sessionStorage` so re-renders don't re-bill.

### 2. Hand-crafted fallbacks that actually look like the subject

Replace the generic two-circle `FALLBACK_BEAR_SVG` and the catch-all `FALLBACK_ANIMAL_SVG` with proper anatomically-shaped silhouettes (ears, muzzle, arms, legs, paws). Add real fallbacks for the common Grade-4 subjects (bear/teddy, dog, cat, horse, dolphin, unicorn, dragon, butterfly, rocket, etc.) so a Gateway failure still ships a frameable image.

### 3. Strict mask containment (no words outside the outline)

In `wordPacker.worker.ts`:

- Replace the 3-point mask test with a **dense edge-sample test**: sample ~12 points around the word's bounding box perimeter + interior; all must be inside the mask.
- Add a small **safety inset** (shrink each candidate box by ~2% before the mask test) so glyph ascenders/descenders don't poke out.
- **Always enforce `mustBeInMask = true`** for every tier instead of `Math.random() < adherence`. Use `adherence` only to relax the inset (high adherence → larger inset, tighter pack; low adherence → smaller inset, more fill) — never to skip the mask test.
- Drop words that can't fit after N attempts rather than placing them anywhere.

### 4. Outline that holds the shape

Keep the mask-derived outline added last turn, but make it slightly thicker (≈0.4% of canvas min-dim) and pure black so the framed print reads cleanly as a silhouette.

### 5. Verify

- Generate Abby (teddy bear), a dancer, a soccer kicker — confirm: recognizable shape, every word inside the outline, name centered and unclipped.
- Render at print resolution and visually QA before declaring done.

## Files touched

- `src/routes/api/generate-silhouette.ts` (new server route)
- `src/lib/gemini.ts` (call the server route instead of Gemini directly; rewrite fallback SVGs)
- `src/lib/wordPacker.worker.ts` (dense mask test, always-on containment, inset by adherence)
- `src/routes/index.tsx` (small wiring — outline thickness, cache)

## Out of scope

- New shapes beyond the existing student roster.
- UI/layout changes to the editor panel.
- Migrating word-expansion call off `VITE_GEMINI_API_KEY` (separate concern; flag for a follow-up if you want it server-side too).

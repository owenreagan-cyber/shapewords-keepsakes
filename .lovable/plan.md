# Fix unrecognizable silhouettes (teddy bear → "lady's dress")

## Root cause

`callShapeGen` in `src/lib/gemini.ts` asks **Gemini 2.5-flash (a text model)** to hand-write SVG `<path>` data for a teddy bear, dog, etc. Text LLMs cannot draw — even with a strict prompt, the model returned a generic oval blob (see the latest network response: one rounded path that looks like a dress/heart). No amount of prompt tuning fixes this; it is a capability limit, not a wording problem.

## Fix

Switch silhouette generation from "LLM writes SVG" to "image model draws a black silhouette PNG", then rasterize that PNG into the alpha mask the packer already consumes. The existing `buildMaskFromSvg` uses `<img>` + canvas, so it already works with any image source — we just give it a PNG data URL instead of an SVG string.

### Steps

1. **Add `callSilhouetteImage(description, style)` in `src/lib/gemini.ts`**
   - Call `gemini-2.5-flash-image-preview` (Nano Banana) via `:generateContent` with a prompt like: *"Solid pure-black silhouette of {description}, centered on pure white background, no outlines, no shading, no text, no gradient, recognizable iconic pose, fills ~80% of frame, square 1:1."*
   - Response includes `inlineData.data` (base64 PNG) — return as `data:image/png;base64,...`.

2. **Generalize the mask builder** in `src/lib/wordPacker.ts`
   - Rename/extend `buildMaskFromSvg` to `buildMaskFromImageSrc(src, maskSize)` accepting any image URL (svg data URL or png data URL). Threshold on luminance < 128 → mask=1. Keep the old name as a thin wrapper for backwards compatibility.

3. **Update `src/routes/index.tsx`**
   - Replace the three `callShapeGen(...)` call sites with `callSilhouetteImage(...)`.
   - Store the returned PNG data URL in place of `shapeSvg`. Pass it to `buildMaskFromImageSrc`.
   - Keep `FALLBACK_HEART_SVG` as the failure fallback (mask builder accepts both).

4. **No changes to the packer worker** — it already consumes a pre-rasterized `Uint8Array` mask.

## Technical notes

- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent?key=...`
- Request body uses `contents:[{parts:[{text: prompt}]}]` and `generationConfig:{ responseModalities:["IMAGE"] }`.
- Parse: `data.candidates[0].content.parts[].inlineData.data` (base64). MIME is in `inlineData.mimeType`.
- Image generation is slower (~3–6s) than text — keep the existing loading indicator; no new UI needed.
- The API key already in `.env` (`VITE_GEMINI_API_KEY`) has access to the image preview model.

## Out of scope

- No change to word expansion, packing algorithm, name sizing, or color logic.
- Not migrating to Lovable AI Gateway in this fix (separate concern).

Once you approve, I'll switch to build mode and make the edits.
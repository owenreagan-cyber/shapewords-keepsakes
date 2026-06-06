# ShapeWords Keepsakes

## Premium Invisible Shape Mask mode

The generator now supports a premium **Invisible Shape Mask** pipeline:

- SVG is used strictly as a placement/validation mask.
- When `invisibleShapeMode` is enabled (default), no silhouette outline/stroke/border/path is rendered.
- Layout runs through explicit 8 passes:
  1. Student name
  2. Anchor words
  3. Medium words
  4. Gap filling
  5. Micro-gap filling
  6. Shape refinement
  7. Visual balancing
  8. Final optimization

## Quality gates

Packing now evaluates:

- width profile similarity
- height profile similarity
- contour profile similarity
- region occupancy score
- overall silhouette similarity

Default thresholds:

- silhouette similarity: `>= 0.90`
- occupancy window: `0.88–0.95` (target `0.92`)
- orientation target: `75–85%` horizontal (`15–25%` vertical)
- dominant name score enforced before export

Exports are blocked when the final quality gate fails.

## Frameable composition

Printable presets include:

- 8x10
- 8.5x11
- 11x14
- 16x20

The mask is normalized for frame-ready composition with silhouette height fill targeting roughly `70–85%`.

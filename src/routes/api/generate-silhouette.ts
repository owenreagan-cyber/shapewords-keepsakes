import { createFileRoute } from "@tanstack/react-router";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/images/generations";

function buildPrompt(shape: string): string {
  return [
    `SUBJECT: ${shape}`,
    "",
    "Create a single bold black silhouette on a pure white background.",
    "",
    "MANDATORY VISUAL RULES — follow every one exactly:",
    "1. Background: pure white #FFFFFF, edge to edge, no gray, no cream, no texture.",
    "2. Silhouette: pure black #000000 only. Zero gray. Zero anti-aliasing halos. Zero shadows.",
    "3. The silhouette must be INSTANTLY recognizable to a 10-year-old child.",
    "   - Include all defining features: head shape, limbs, pose, any equipment.",
    "   - If a person: show the full body with clear head, torso, arms, legs in an active pose.",
    "   - If an athlete: show the sport-defining action (swing, kick, catch, skate stride).",
    "   - If an animal: show the characteristic pose (galloping, sitting, flying).",
    "4. Proportions: chunky and bold. Limbs must be thick (minimum 8% of body width).",
    "   No wire-thin arms or spindly legs — they will be unreadable at small sizes.",
    "5. The silhouette fills 75–85% of the square canvas. Centered.",
    "6. Flat 2D graphic style. No shading, no gradients, no 3D rendering.",
    "7. Crisp hard edges. Where black meets white, the edge must be sharp — not blurry.",
    "8. Single connected shape. No floating disconnected pieces.",
    "9. No text, no watermarks, no borders, no decorative frames.",
    "10. This will be used as a stencil mask for word-art typography. Interior area is critical.",
    "    The shape must have large fillable interior regions — not just an outline.",
  ].join("\n");
}

export const Route = createFileRoute("/api/generate-silhouette")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env.LOVABLE_API_KEY;
        if (!key) {
          return Response.json({ error: "Missing LOVABLE_API_KEY" }, { status: 500 });
        }
        let body: { shape?: string; style?: string };
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const shape = (body.shape || "").trim().slice(0, 300);
        if (!shape) {
          return Response.json({ error: "Missing shape" }, { status: 400 });
        }

        const prompt = buildPrompt(shape);
        const upstream = await fetch(GATEWAY, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "openai/gpt-image-2",
            prompt,
            size: "1024x1024",
            quality: "medium",
            n: 1,
          }),
        });

        if (!upstream.ok) {
          const text = await upstream.text().catch(() => "");
          return Response.json(
            { error: `Image gateway ${upstream.status}: ${text.slice(0, 500)}` },
            { status: upstream.status },
          );
        }
        const data = (await upstream.json()) as {
          data?: Array<{ b64_json?: string }>;
        };
        const b64 = data?.data?.[0]?.b64_json;
        if (!b64) {
          return Response.json({ error: "No image returned" }, { status: 502 });
        }
        return Response.json({ dataUrl: `data:image/png;base64,${b64}` });
      },
    },
  },
});

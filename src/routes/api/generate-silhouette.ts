import { createFileRoute } from "@tanstack/react-router";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/images/generations";

function buildPrompt(shape: string, style: string): string {
  return `A bold, solid pure-black silhouette of: ${shape}.
Style: ${style}. Print-quality keepsake silhouette art.

STRICT REQUIREMENTS:
- Pure white (#FFFFFF) background, edge to edge.
- Single solid black (#000000) silhouette only — NO outlines, NO shading, NO gradients, NO patterns, NO text, NO watermark, NO border.
- The subject must be INSTANTLY RECOGNIZABLE: include all characteristic features (ears, snout, eyes negative-space if needed, arms, legs, paws, tail, accessories) in a classic iconic pose.
- Chunky, thickened, plush-toy proportions so the silhouette has lots of internal area for text packing. No thin spindly limbs.
- Centered. Subject fills ~80% of a 1:1 square frame.
- Crisp clean edges. Flat 2D vector look. No 3D rendering. No photograph.`;
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
        const style = (body.style || "Premium Print").trim().slice(0, 100);
        if (!shape) {
          return Response.json({ error: "Missing shape" }, { status: 400 });
        }

        const prompt = buildPrompt(shape, style);
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
            quality: "low",
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

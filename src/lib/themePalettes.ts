// Theme-driven 3-color palette + font picker for "Best Framable Settings".

export type BestPreset = { palette: string[]; fontFamily: string };

const KEY = (s?: string) => (s || "").toLowerCase();

export function pickBestPreset(args: {
  theme?: string;
  shape?: string;
  traits?: string;
  fallbackPalette?: string[];
  fallbackFont?: string;
}): BestPreset {
  const hay = `${KEY(args.theme)} ${KEY(args.shape)} ${KEY(args.traits)}`;

  // Order matters: most specific first.
  if (/(dance|ballet|performance|artistic|joy|music|stage)/.test(hay)) {
    return { palette: ["#1A0B2E", "#7C3AED", "#EC4899"], fontFamily: "Cormorant Garamond" };
  }
  if (/(sport|athlet|soccer|basketball|football|baseball|energy|leadership|run|track|hockey|tennis)/.test(hay)) {
    return { palette: ["#0A0A0A", "#1E40AF", "#DC2626"], fontFamily: "Bebas Neue" };
  }
  if (/(boy|adventure|loyal|brave|explorer|knight|dragon|robot|truck|dino)/.test(hay)) {
    return { palette: ["#0F172A", "#1E3A8A", "#F59E0B"], fontFamily: "Oswald" };
  }
  if (/(girl|kindness|elegan|princess|flower|butterfly|unicorn|heart|warm)/.test(hay)) {
    return { palette: ["#1F1147", "#9333EA", "#F472B6"], fontFamily: "Playfair Display" };
  }

  const fallback = (args.fallbackPalette && args.fallbackPalette.length > 0)
    ? args.fallbackPalette
    : ["#0A0A0A", "#444444", "#999999"];
  return { palette: fallback, fontFamily: args.fallbackFont || "Montserrat" };
}

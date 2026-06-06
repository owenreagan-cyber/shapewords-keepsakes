// Theme-driven 3-color palette + font picker for "Best Framable Settings".

export type BestPreset = { palette: string[]; fontFamily: string };
type BestPresetArgs = {
  name?: string;
  theme?: string;
  shape?: string;
  traits?: string;
  words?: string[];
  fallbackPalette?: string[];
  fallbackFont?: string;
};

const KEY = (s?: string) => (s || "").toLowerCase();
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function hashText(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "").trim();
  if (!/^[\da-f]{6}$/i.test(normalized)) return null;
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b]
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function rgbToHsl(r: number, g: number, b: number) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (!delta) return { h: 0, s: 0, l: lightness * 100 };

  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;
  switch (max) {
    case rn:
      hue = (gn - bn) / delta + (gn < bn ? 6 : 0);
      break;
    case gn:
      hue = (bn - rn) / delta + 2;
      break;
    default:
      hue = (rn - gn) / delta + 4;
      break;
  }
  return { h: hue * 60, s: saturation * 100, l: lightness * 100 };
}

function hslToRgb(h: number, s: number, l: number) {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - chroma / 2;

  let rPrime = 0;
  let gPrime = 0;
  let bPrime = 0;
  if (hue < 60) [rPrime, gPrime, bPrime] = [chroma, x, 0];
  else if (hue < 120) [rPrime, gPrime, bPrime] = [x, chroma, 0];
  else if (hue < 180) [rPrime, gPrime, bPrime] = [0, chroma, x];
  else if (hue < 240) [rPrime, gPrime, bPrime] = [0, x, chroma];
  else if (hue < 300) [rPrime, gPrime, bPrime] = [x, 0, chroma];
  else [rPrime, gPrime, bPrime] = [chroma, 0, x];

  return {
    r: (rPrime + m) * 255,
    g: (gPrime + m) * 255,
    b: (bPrime + m) * 255,
  };
}

function tuneColor(hex: string, hueShift: number, saturationShift: number, lightnessShift: number) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const shifted = hslToRgb(hsl.h + hueShift, hsl.s + saturationShift, hsl.l + lightnessShift);
  return rgbToHex(shifted.r, shifted.g, shifted.b);
}

function ensureDarkPrimary(hex: string) {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#111111";
  const brightness = rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114;
  if (brightness <= 70) return hex;
  return tuneColor(hex, 0, 0, -38);
}

export function pickBestPreset(args: BestPresetArgs): BestPreset {
  const hay = `${KEY(args.theme)} ${KEY(args.shape)} ${KEY(args.traits)}`;

  // Order matters: most specific first.
  if (/(dance|ballet|performance|artistic|joy|music|stage)/.test(hay)) {
    return { palette: ["#1A0B2E", "#7C3AED", "#EC4899"], fontFamily: "Cormorant Garamond" };
  }
  if (
    /(sport|athlet|soccer|basketball|football|baseball|energy|leadership|run|track|hockey|tennis)/.test(
      hay,
    )
  ) {
    return { palette: ["#0A0A0A", "#1E40AF", "#DC2626"], fontFamily: "Bebas Neue" };
  }
  if (/(boy|adventure|loyal|brave|explorer|knight|dragon|robot|truck|dino)/.test(hay)) {
    return { palette: ["#0F172A", "#1E3A8A", "#F59E0B"], fontFamily: "Oswald" };
  }
  if (/(girl|kindness|elegan|princess|flower|butterfly|unicorn|heart|warm)/.test(hay)) {
    return { palette: ["#1F1147", "#9333EA", "#F472B6"], fontFamily: "Playfair Display" };
  }

  const fallback =
    args.fallbackPalette && args.fallbackPalette.length > 0
      ? args.fallbackPalette
      : ["#0A0A0A", "#444444", "#999999"];
  return { palette: fallback, fontFamily: args.fallbackFont || "Montserrat" };
}

export function pickPersonalizedPreset(args: BestPresetArgs): BestPreset {
  const base = pickBestPreset(args);
  const fallbackPalette = args.fallbackPalette?.length
    ? args.fallbackPalette
    : ["#0A0A0A", "#444444", "#999999"];
  const sourcePalette = [...base.palette, ...fallbackPalette].slice(0, 3);
  while (sourcePalette.length < 3) {
    sourcePalette.push(sourcePalette[sourcePalette.length - 1] ?? "#999999");
  }

  const signature = [
    KEY(args.name),
    KEY(args.theme),
    KEY(args.shape),
    KEY(args.traits),
    ...(args.words ?? []).map(KEY),
  ]
    .filter(Boolean)
    .join("|");
  const seed = hashText(signature);
  const hueShift = (seed % 19) - 9;
  const accentLift = ((seed >> 5) % 9) - 3;
  const supportLift = ((seed >> 9) % 11) - 5;

  return {
    fontFamily: base.fontFamily,
    palette: [
      ensureDarkPrimary(sourcePalette[0]),
      tuneColor(sourcePalette[1], hueShift, 6, accentLift),
      tuneColor(sourcePalette[2], Math.round(hueShift / 2), 3, supportLift + 8),
    ],
  };
}

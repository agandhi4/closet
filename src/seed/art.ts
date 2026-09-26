import { normalizeCategory } from '../web/wardrobe/garment';
import { GarmentCategory } from '../wardrobe/properties';

/**
 * The seed's garment photos: a flat-lay drawing of each garment's type in
 * its colours and pattern, as SVG (sharp renders it; the seed stores it
 * through Photos as its own cutout). Deterministic, drawn from the garment
 * alone, so no image file is committed and every run stores the same
 * pixels. Owner decision, 2026-09-26: generated art rather than stock
 * photos, which covered too few garments under a licence the repo can hold.
 *
 * A shape is a list of parts on an 800 px square: the body takes the
 * garment's colour and pattern, trims a shade of it, lines are seams and
 * edges, and a few fixed materials (soles, metal) keep their own colour.
 */

export const ART_SIZE = 800;

export interface ArtSubject {
  category: string;
  type: string | null;
  name: string | null;
  /** GARMENT_COLORS values, the first the main one. */
  colors: string[];
  pattern: string | null;
}

type Fill = 'main' | 'trim' | 'dark' | 'accent' | 'sole' | 'metal' | 'none';

interface Part {
  d: string;
  fill?: Fill;
  /** Seams and edges are thinner than outlines. */
  line?: 'outline' | 'seam' | 'none';
  width?: number;
  /** Drawn moved by [x, y] (the far shoe of a pair). */
  offset?: [number, number];
}

type Shape = Part[];

// ---- Colours ----------------------------------------------------------------

const COLORS: Record<string, string> = {
  red: '#b3312a',
  pink: '#e3a3b5',
  orange: '#d9772f',
  yellow: '#e2c14a',
  green: '#5f7a3c',
  blue: '#2f4c86',
  purple: '#6a4d95',
  black: '#26262a',
  white: '#f3f1ea',
  grey: '#8e9197',
  beige: '#d6c5a3',
  brown: '#7a5233',
  gold: '#c8a441',
  silver: '#b8bcc3',
  pattern: '#9a80b0',
  other: '#a3a3a3',
};

// Names say which blue or brown ("navy chinos", "khaki shorts"): the
// colour set is coarse on purpose, the drawing need not be.
const SHADES: [RegExp, string][] = [
  [/\bnavy\b/, '#1f2c4b'],
  [/\b(raw|selvedge|indigo)\b/, '#23304f'],
  [/\b(jeans|501s|511s|denim|trucker)\b/, '#48678f'],
  [/\bolive\b/, '#5b6136'],
  [/\bkhaki\b/, '#c4ad83'],
  [/\bcharcoal\b/, '#45474c'],
  [/\b(oat|stone|ecru)\b/, '#d8ccb3'],
  [/\b(iron rangers|chelsea|bean boots)\b/, '#7b4a28'],
  [/\b(loafers|dress shoes)\b/, '#6a3d22'],
];

function mainColor(subject: ArtSubject): string {
  const name = (subject.name ?? '').toLowerCase();
  // Without colours, the name may still say one ("black jeans").
  const first =
    subject.colors[0] ??
    Object.keys(COLORS).find((color) =>
      new RegExp(`\\b${color}\\b`).test(name),
    );
  const shade = SHADES.find(([pattern]) => pattern.test(name));
  // A shade only refines a colour the garment already has (no navy black jeans).
  if (
    shade &&
    (!first || ['blue', 'brown', 'green', 'beige', 'grey'].includes(first))
  ) {
    return shade[1];
  }
  return COLORS[first] ?? COLORS.grey;
}

function hex(value: string): [number, number, number] {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mixed toward black (amount > 0) or white (amount < 0). */
function shade(value: string, amount: number): string {
  const target = amount > 0 ? 0 : 255;
  const t = Math.abs(amount);
  return `#${hex(value)
    .map((c) => Math.round(c + (target - c) * t))
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')}`;
}

function luminance(value: string): number {
  const [r, g, b] = hex(value);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// ---- Shapes -----------------------------------------------------------------

// Tops share a torso and differ in sleeves, necks and bands.
const TORSO = 'L545 300 L545 650 Q400 664 255 650 L255 300';
const SHORT_SLEEVES =
  'M318 150 Q400 208 482 150 L565 176 L660 268 L602 330 L545 292 ' +
  TORSO +
  ' L198 330 L140 268 L235 176 Z';
const LONG_SLEEVES =
  'M318 150 Q400 208 482 150 L565 176 L640 292 L700 610 L636 626 L566 358 L545 318 ' +
  'L545 650 Q400 664 255 650 L255 318 L234 358 L164 626 L100 610 L160 292 L235 176 Z';
const CUFFS: Part[] = [
  { d: 'M700 610 L636 626 L630 598 L694 583 Z', fill: 'trim' },
  { d: 'M100 610 L164 626 L170 598 L106 583 Z', fill: 'trim' },
];
const HEM_BAND: Part = {
  d: 'M255 650 Q400 664 545 650 L545 618 Q400 632 255 618 Z',
  fill: 'trim',
};
const CREW_NECK: Part = {
  d: 'M318 150 Q400 208 482 150 Q400 228 318 150 Z',
  fill: 'trim',
};

function buttons(x: number, from: number, to: number, count: number): Part[] {
  return Array.from({ length: count }, (_, i): Part => {
    const y = from + ((to - from) * i) / Math.max(1, count - 1);
    return { d: circle(x, y, 7), fill: 'accent', line: 'none' };
  });
}

function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
}

const COLLAR: Part[] = [
  { d: 'M318 150 L400 214 L352 236 L300 170 Z', fill: 'trim' },
  { d: 'M482 150 L400 214 L448 236 L500 170 Z', fill: 'trim' },
];

const SHAPES: Record<string, () => Shape> = {
  't-shirt': () => [{ d: SHORT_SLEEVES }, CREW_NECK],
  'long-sleeve-tee': () => [{ d: LONG_SLEEVES }, CREW_NECK, ...CUFFS],
  shirt: () => [
    { d: LONG_SLEEVES },
    ...CUFFS,
    ...COLLAR,
    { d: 'M400 214 L400 650', line: 'seam' },
    ...buttons(412, 250, 610, 6),
    { d: 'M290 300 L350 300 L350 350 L290 350 Z', line: 'seam', fill: 'none' },
  ],
  polo: () => [
    { d: SHORT_SLEEVES },
    ...COLLAR,
    { d: 'M388 214 L388 320 L412 320 L412 214', line: 'seam', fill: 'none' },
    ...buttons(400, 240, 300, 3),
    { d: 'M602 330 L660 268', line: 'seam', width: 10 },
    { d: 'M198 330 L140 268', line: 'seam', width: 10 },
  ],
  blouse: () => [
    {
      d:
        'M318 150 Q400 230 482 150 L565 176 L640 292 L710 590 L640 610 L566 358 L545 330 ' +
        'Q590 520 580 660 Q400 690 220 660 Q210 520 255 330 L234 358 L160 610 L90 590 L160 292 L235 176 Z',
    },
    { d: 'M340 170 Q400 250 460 170', line: 'seam', fill: 'none' },
  ],
  tank: () => [
    {
      d: 'M310 150 Q400 250 490 150 L520 158 Q526 262 562 306 L562 650 Q400 664 238 650 L238 306 Q274 262 280 158 Z',
    },
    { d: 'M310 150 Q400 250 490 150', line: 'seam', fill: 'none', width: 8 },
  ],
  sweater: () => [{ d: LONG_SLEEVES }, CREW_NECK, ...CUFFS, HEM_BAND],
  cardigan: () => [
    { d: LONG_SLEEVES },
    ...CUFFS,
    HEM_BAND,
    { d: 'M318 150 L400 330 L482 150', line: 'seam', fill: 'none', width: 10 },
    { d: 'M400 330 L400 650', line: 'seam', width: 8 },
    ...buttons(414, 360, 600, 5),
  ],
  hoodie: () => [
    {
      d: 'M300 170 Q300 60 400 56 Q500 60 500 170 Q400 230 300 170 Z',
      fill: 'trim',
    },
    { d: LONG_SLEEVES },
    ...CUFFS,
    HEM_BAND,
    { d: 'M318 150 Q400 214 482 150 Q400 240 318 150 Z', fill: 'dark' },
    { d: 'M300 470 L500 470 L540 600 L260 600 Z', line: 'seam', fill: 'none' },
    { d: 'M375 200 L370 300 M425 200 L430 300', line: 'seam', width: 5 },
  ],
  sweatshirt: () => [
    { d: LONG_SLEEVES },
    CREW_NECK,
    ...CUFFS,
    HEM_BAND,
    { d: 'M385 200 L400 230 L415 200', line: 'seam', fill: 'none' },
  ],
  turtleneck: () => [
    { d: LONG_SLEEVES },
    { d: 'M322 96 L478 96 L482 160 Q400 190 318 160 Z', fill: 'trim' },
    {
      d: 'M340 112 L340 160 M370 112 L370 172 M400 112 L400 176 M430 112 L430 172 M460 112 L460 160',
      line: 'seam',
      width: 3,
    },
    ...CUFFS,
    HEM_BAND,
  ],

  jeans: () => trousers({ jeans: true }),
  chinos: () => trousers({ crease: true }),
  trousers: () => trousers({ crease: true, slim: true }),
  joggers: () => trousers({ cuffs: true, slim: true }),
  sweatpants: () => trousers({ cuffs: true }),
  leggings: () => trousers({ slim: true, bare: true }),
  shorts: () => [
    { d: 'M276 190 L524 190 L562 470 L420 488 L400 320 L380 488 L238 470 Z' },
    { d: 'M276 190 L524 190 L526 226 L274 226 Z', fill: 'trim' },
    { d: 'M400 226 L400 300', line: 'seam' },
    {
      d: 'M286 236 Q320 290 356 236 M444 236 Q480 290 514 236',
      line: 'seam',
      fill: 'none',
    },
  ],
  skirt: () => [
    { d: 'M300 170 L500 170 L600 640 Q400 668 200 640 Z' },
    { d: 'M300 170 L500 170 L504 208 L296 208 Z', fill: 'trim' },
  ],

  'day-dress': () => [
    {
      d:
        'M330 110 Q400 170 470 110 L540 132 L600 216 L556 256 L528 232 L520 330 ' +
        'Q600 520 640 700 Q400 736 160 700 Q200 520 280 330 L272 232 L244 256 L200 216 L260 132 Z',
    },
    { d: 'M280 330 Q400 350 520 330', line: 'seam', fill: 'none', width: 6 },
    { d: 'M330 110 L420 330', line: 'seam', fill: 'none' },
  ],
  'evening-dress': () => [
    {
      d: 'M318 110 Q400 170 482 110 L500 118 Q510 240 520 320 Q620 560 640 740 Q400 772 160 740 Q180 560 280 320 Q290 240 300 118 Z',
    },
  ],
  jumpsuit: () => [
    {
      d:
        'M330 90 Q400 150 470 90 L540 112 L596 196 L552 232 L526 214 L530 360 L580 740 L430 740 ' +
        'L400 440 L370 740 L220 740 L270 360 L274 214 L248 232 L204 196 L260 112 Z',
    },
    { d: 'M270 360 Q400 380 530 360', line: 'seam', fill: 'none', width: 8 },
  ],

  jacket: () => [
    ...coat(650),
    {
      d: 'M318 150 L400 250 L482 150 L500 176 L400 290 L300 176 Z',
      fill: 'trim',
    },
    ...buttons(412, 320, 600, 4),
    {
      d: 'M280 470 L360 470 L360 560 L280 560 Z M440 470 L520 470 L520 560 L440 560 Z M290 320 L350 320 L350 380 L290 380 Z',
      line: 'seam',
      fill: 'none',
    },
  ],
  'denim-jacket': () => [
    ...coat(590),
    { d: 'M255 590 L545 590 L545 548 L255 548 Z', fill: 'trim' },
    ...COLLAR,
    {
      d: 'M280 290 L360 290 L360 340 L280 340 Z M440 290 L520 290 L520 340 L440 340 Z',
      fill: 'trim',
    },
    { d: 'M270 380 L530 380', line: 'seam', fill: 'none' },
    ...buttons(412, 260, 530, 5),
  ],
  'leather-jacket': () => [
    ...coat(610),
    {
      d: 'M318 150 L260 240 L330 270 L400 200 Z M482 150 L540 240 L470 270 L420 230 Z',
      fill: 'trim',
    },
    { d: 'M470 180 L330 610', line: 'seam', width: 7 },
    { d: 'M255 580 L545 580', line: 'seam', width: 6 },
    { d: circle(476, 176, 9), fill: 'metal' },
    { d: 'M290 420 L360 400 M440 400 L510 420', line: 'seam', width: 6 },
  ],
  blazer: () => [
    ...coat(660),
    {
      d: 'M318 150 L280 250 L330 300 L400 440 L400 330 L360 250 Z',
      fill: 'trim',
    },
    {
      d: 'M482 150 L520 250 L470 300 L400 440 L400 330 L440 250 Z',
      fill: 'trim',
    },
    ...buttons(410, 470, 540, 2),
    {
      d: 'M280 540 L350 530 M450 530 L520 540 M450 330 L505 322',
      line: 'seam',
      width: 6,
    },
  ],
  coat: () => [
    ...coat(740),
    {
      d: 'M318 150 L270 260 L320 310 L400 460 L400 340 L360 260 Z',
      fill: 'trim',
    },
    {
      d: 'M482 150 L530 260 L480 310 L400 460 L400 340 L440 260 Z',
      fill: 'trim',
    },
    ...buttons(410, 490, 640, 3),
    { d: 'M290 580 L350 570 M450 570 L510 580', line: 'seam', width: 6 },
  ],
  parka: () => [
    { d: 'M296 176 Q290 50 400 44 Q510 50 504 176 Z', fill: 'trim' },
    ...coat(740),
    { d: 'M400 176 L400 740', line: 'seam', width: 7 },
    {
      d: 'M280 520 L370 520 L370 620 L280 620 Z M430 520 L520 520 L520 620 L430 620 Z',
      line: 'seam',
      fill: 'none',
    },
    { d: 'M255 420 L545 420', line: 'seam', fill: 'none' },
  ],
  puffer: () => [
    ...coat(640),
    ...quilting(250, 640, 5),
    { d: 'M318 150 L482 150 L486 196 L314 196 Z', fill: 'trim' },
    { d: 'M400 196 L400 640', line: 'seam', width: 6 },
  ],
  trench: () => [
    ...coat(740),
    {
      d: 'M318 150 L260 270 L320 320 L400 420 L400 330 L352 250 Z',
      fill: 'trim',
    },
    {
      d: 'M482 150 L540 270 L480 320 L400 420 L400 330 L448 250 Z',
      fill: 'trim',
    },
    { d: 'M255 470 L545 470 L545 500 L255 500 Z', fill: 'trim' },
    ...buttons(360, 440, 620, 3),
    ...buttons(440, 440, 620, 3),
    { d: 'M398 474 L420 474 L420 496 L398 496 Z', fill: 'metal' },
  ],
  'rain-jacket': () => [
    { d: 'M300 176 Q296 64 400 58 Q504 64 500 176 Z', fill: 'trim' },
    ...coat(640),
    { d: 'M400 176 L400 640', line: 'seam', width: 7 },
    { d: 'M290 470 L360 460 M440 460 L510 470', line: 'seam', width: 6 },
    { d: circle(400, 190, 8), fill: 'metal' },
  ],
  vest: () => [
    {
      d: 'M318 150 L482 150 L540 190 Q520 250 548 300 L548 640 Q400 656 252 640 L252 300 Q280 250 260 190 Z',
    },
    ...quilting(260, 640, 4, 252, 548),
    { d: 'M400 150 L400 640', line: 'seam', width: 6 },
  ],
  fleece: () => [
    { d: LONG_SLEEVES },
    ...CUFFS,
    HEM_BAND,
    { d: 'M322 120 L478 120 L482 170 Q400 200 318 170 Z', fill: 'trim' },
    { d: 'M400 130 L400 330', line: 'seam', width: 7 },
    { d: circle(400, 330, 8), fill: 'metal' },
    { d: 'M290 300 L360 300 L360 350 L290 350 Z', fill: 'trim' },
  ],

  sneakers: () => shoes(sneaker),
  'running-shoes': () => shoes(runner),
  boots: () => shoes(boot),
  loafers: () => shoes(loafer),
  'dress-shoes': () => shoes(oxford),
  sandals: () => shoes(sandal),
  slides: () => shoes(slide),
  heels: () => shoes(heel),

  hat: () => [
    { d: 'M150 520 Q400 440 650 520 Q640 580 400 590 Q160 580 150 520 Z' },
    { d: 'M260 510 Q270 300 400 290 Q530 300 540 510 Q400 540 260 510 Z' },
    { d: 'M262 470 Q400 500 538 470', line: 'seam', fill: 'none', width: 6 },
  ],
  cap: () => [
    { d: 'M220 480 Q230 250 420 240 Q600 250 600 470 Z' },
    { d: 'M200 470 Q120 500 140 560 Q300 540 420 480 Z', fill: 'trim' },
    {
      d: 'M420 240 L400 470 M420 240 Q330 300 300 470 M420 240 Q510 300 520 470',
      line: 'seam',
      fill: 'none',
    },
    { d: circle(420, 244, 12), fill: 'trim' },
  ],
  beanie: () => [
    { d: 'M250 460 Q250 200 400 190 Q550 200 550 460 Z' },
    { d: 'M236 450 L564 450 L570 580 L230 580 Z', fill: 'trim' },
    {
      d: 'M280 460 L280 570 M330 460 L330 575 M380 460 L380 578 M430 460 L430 578 M480 460 L480 575 M530 460 L530 570',
      line: 'seam',
      width: 4,
    },
  ],
  scarf: () => [
    { d: 'M270 120 L380 120 L380 600 L270 600 Z' },
    {
      d: 'M380 120 Q520 180 520 330 L520 690 L410 690 L410 330 Q410 240 380 230 Z',
    },
    {
      d: 'M270 600 L270 640 M290 600 L290 640 M310 600 L310 640 M330 600 L330 640 M350 600 L350 640 M370 600 L370 640',
      line: 'seam',
      width: 5,
    },
    {
      d: 'M410 690 L410 730 M432 690 L432 730 M454 690 L454 730 M476 690 L476 730 M498 690 L498 730 M520 690 L520 730',
      line: 'seam',
      width: 5,
    },
  ],
  gloves: () => [glove(260, false), glove(540, true)].flat(),
  belt: () => [
    { d: 'M100 360 L640 360 L640 430 L100 430 Z' },
    {
      d: 'M600 330 L720 330 L720 460 L600 460 Z M622 352 L698 352 L698 438 L622 438 Z',
      fill: 'metal',
    },
    {
      d: circle(200, 395, 8) + circle(260, 395, 8) + circle(320, 395, 8),
      fill: 'dark',
      line: 'none',
    },
  ],
  sunglasses: () => [
    {
      d: 'M150 340 L380 340 Q380 480 290 490 Q170 490 150 400 Z',
      fill: 'dark',
    },
    {
      d: 'M420 340 L650 340 Q630 490 510 490 Q420 480 420 340 Z',
      fill: 'dark',
    },
    {
      d: 'M380 360 Q400 340 420 360',
      line: 'outline',
      fill: 'none',
      width: 12,
    },
    { d: 'M150 350 L90 330 M650 350 L710 330', line: 'outline', width: 12 },
  ],
  tie: () => [
    { d: 'M360 100 L440 100 L420 170 L380 170 Z', fill: 'trim' },
    { d: 'M380 170 L420 170 L480 620 L400 700 L320 620 Z' },
  ],
  jewelry: () => [
    {
      d: 'M230 200 Q400 760 570 200',
      line: 'outline',
      fill: 'none',
      width: 14,
    },
    { d: circle(400, 470, 22), fill: 'main' },
  ],
  watch: () => [
    { d: 'M340 80 L460 80 L460 720 L340 720 Z' },
    { d: circle(400, 400, 120), fill: 'metal' },
    { d: circle(400, 400, 98), fill: 'accent' },
    {
      d: 'M400 400 L400 330 M400 400 L450 420',
      line: 'seam',
      fill: 'none',
      width: 8,
    },
  ],

  backpack: () => [
    {
      d: 'M250 180 Q250 120 400 120 Q550 120 550 180 L560 680 Q400 700 240 680 Z',
    },
    {
      d: 'M350 120 Q350 70 400 70 Q450 70 450 120',
      line: 'outline',
      fill: 'none',
      width: 14,
    },
    { d: 'M290 440 L510 440 L520 640 L280 640 Z', fill: 'trim' },
    { d: 'M290 440 L510 440', line: 'seam', width: 6 },
  ],
  tote: () => [
    { d: 'M200 320 L600 320 L640 700 L160 700 Z' },
    {
      d: 'M280 320 Q290 150 400 150 Q510 150 520 320',
      line: 'outline',
      fill: 'none',
      width: 20,
    },
    { d: 'M170 600 L630 600 L640 700 L160 700 Z', fill: 'accent' },
  ],
  crossbody: () => [
    {
      d: 'M230 330 Q260 90 400 90 Q540 90 570 330',
      line: 'outline',
      fill: 'none',
      width: 16,
    },
    {
      d: 'M200 360 Q210 260 400 250 Q590 260 600 360 L600 560 Q400 600 200 560 Z',
    },
    { d: 'M230 360 Q400 330 570 360', line: 'seam', fill: 'none', width: 7 },
  ],
  handbag: () => [
    {
      d: 'M290 330 Q300 170 400 170 Q500 170 510 330',
      line: 'outline',
      fill: 'none',
      width: 18,
    },
    { d: 'M220 320 L580 320 L620 640 L180 640 Z' },
    { d: 'M220 320 L580 320 L560 420 L240 420 Z', fill: 'trim' },
    { d: circle(400, 420, 14), fill: 'metal' },
  ],
  duffel: () => [
    {
      d: 'M150 340 Q150 290 200 290 L600 290 Q650 290 650 340 L650 580 Q650 620 600 620 L200 620 Q150 620 150 580 Z',
    },
    {
      d: 'M300 290 Q320 180 400 180 Q480 180 500 290',
      line: 'outline',
      fill: 'none',
      width: 18,
    },
    { d: 'M150 440 L650 440', line: 'seam', width: 7 },
    { d: 'M190 330 L190 580 M610 330 L610 580', line: 'seam', width: 5 },
  ],

  socks: () => [sock(300), sock(480)].flat(),
  umbrella: () => [
    { d: 'M390 110 L410 110 L410 150 L390 150 Z', fill: 'metal' },
    { d: 'M400 150 L460 600 L400 640 L340 600 Z' },
    {
      d: 'M400 150 L400 640 M400 150 L370 610 M400 150 L430 610',
      line: 'seam',
      width: 4,
    },
    {
      d: 'M392 640 L408 640 L408 700 Q408 740 440 740 Q468 740 468 712',
      line: 'outline',
      fill: 'none',
      width: 14,
    },
  ],
  folded: () => [
    { d: 'M180 260 L620 260 L620 600 L180 600 Z' },
    {
      d: 'M180 340 L620 340 M300 260 L300 600 M500 260 L500 600',
      line: 'seam',
    },
  ],
};

interface TrouserOptions {
  jeans?: boolean;
  crease?: boolean;
  cuffs?: boolean;
  slim?: boolean;
  bare?: boolean;
}

function trousers(options: TrouserOptions): Shape {
  const hem = options.slim ? 60 : 0;
  const legs =
    `M286 110 L514 110 L${548 - hem / 2} 720 L${428 + hem / 3} 720 L400 330 ` +
    `L${372 - hem / 3} 720 L${252 + hem / 2} 720 Z`;
  const parts: Part[] = [{ d: legs }];
  if (!options.bare) {
    parts.push({ d: 'M286 110 L514 110 L516 150 L284 150 Z', fill: 'trim' });
    parts.push({ d: 'M400 150 L400 290', line: 'seam' });
    parts.push({
      d: 'M292 160 Q330 220 360 160 M440 160 Q470 220 508 160',
      line: 'seam',
      fill: 'none',
    });
  }
  if (options.crease) {
    parts.push({
      d: 'M340 160 L316 715 M460 160 L484 715',
      line: 'seam',
      width: 3,
    });
  }
  if (options.jeans) {
    parts.push({
      d: 'M292 160 Q330 220 360 160 M440 160 Q470 220 508 160 M400 150 Q390 250 360 290',
      line: 'seam',
      fill: 'none',
      width: 4,
    });
  }
  if (options.cuffs) {
    const left = 252 + hem / 2;
    const right = 548 - hem / 2;
    parts.push({
      d: `M${left} 720 L${372 - hem / 3} 720 L${372 - hem / 3} 680 L${left + 2} 680 Z`,
      fill: 'trim',
    });
    parts.push({
      d: `M${428 + hem / 3} 720 L${right} 720 L${right - 2} 680 L${428 + hem / 3} 680 Z`,
      fill: 'trim',
    });
  }
  return parts;
}

// Long sleeves and a body down to `hem`: the jackets and coats.
function coat(hem: number): Part[] {
  return [
    {
      d:
        `M318 150 L400 176 L482 150 L570 176 L646 292 L706 ${hem - 20} L640 ${hem - 4} ` +
        `L566 358 L552 330 L552 ${hem} Q400 ${hem + 14} 248 ${hem} L248 330 L234 358 ` +
        `L160 ${hem - 4} L94 ${hem - 20} L154 292 L230 176 Z`,
    },
  ];
}

function quilting(
  from: number,
  to: number,
  rows: number,
  left = 248,
  right = 552,
): Part[] {
  return Array.from({ length: rows }, (_, i): Part => {
    const y = from + ((to - from) * (i + 1)) / (rows + 1);
    return {
      d: `M${left} ${y} Q400 ${y + 16} ${right} ${y}`,
      line: 'seam',
      fill: 'none',
      width: 6,
    };
  });
}

// A pair: the far shoe drawn behind and above the near one.
function shoes(one: () => Part[]): Shape {
  return [
    ...one().map((part) => ({
      ...part,
      offset: [60, -150] as [number, number],
    })),
    ...one(),
  ];
}

function sneaker(): Part[] {
  return [
    {
      d: 'M120 560 Q130 470 230 450 L360 420 Q420 380 470 380 L520 400 Q560 470 660 490 Q700 500 700 560 Z',
    },
    { d: 'M110 560 L710 560 L706 600 Q400 612 114 600 Z', fill: 'sole' },
    {
      d: 'M360 430 L400 470 M390 415 L430 455 M420 400 L460 440',
      line: 'seam',
      width: 6,
    },
    { d: 'M520 400 Q480 470 470 560', line: 'seam', fill: 'none' },
  ];
}

function runner(): Part[] {
  return [
    {
      d: 'M120 540 Q140 460 240 440 L370 400 Q430 360 490 370 L540 400 Q580 460 670 480 Q712 492 704 540 Z',
    },
    {
      d: 'M104 540 L716 540 Q712 610 640 616 L170 616 Q104 610 104 540 Z',
      fill: 'sole',
    },
    { d: 'M250 520 Q400 440 560 430', line: 'seam', fill: 'none', width: 10 },
    { d: 'M370 410 L410 450 M400 396 L440 436', line: 'seam', width: 6 },
  ];
}

function boot(): Part[] {
  return [
    {
      d: 'M360 170 L540 170 L550 420 Q600 470 680 490 Q716 500 710 560 L150 560 Q140 480 230 460 L350 430 Z',
    },
    { d: 'M140 560 L716 560 L716 604 L140 604 Z', fill: 'dark' },
    { d: 'M360 170 L540 170 L540 200 L360 200 Z', fill: 'trim' },
    { d: 'M550 420 Q480 480 470 560', line: 'seam', fill: 'none' },
  ];
}

function loafer(): Part[] {
  return [
    {
      d: 'M120 560 Q120 490 220 470 L380 450 Q440 420 520 430 Q600 470 680 500 Q712 520 706 560 Z',
    },
    { d: 'M112 560 L710 560 L708 590 L114 590 Z', fill: 'dark' },
    {
      d: 'M470 440 Q520 470 600 480 L590 505 Q520 500 460 470 Z',
      fill: 'trim',
    },
    { d: 'M380 450 Q460 500 540 470', line: 'seam', fill: 'none' },
  ];
}

function oxford(): Part[] {
  return [
    {
      d: 'M110 560 Q110 480 210 468 L400 440 Q460 410 520 420 Q610 470 700 510 Q724 530 712 560 Z',
    },
    {
      d: 'M100 560 L716 560 L714 586 L130 586 L130 620 L100 620 Z',
      fill: 'dark',
    },
    { d: 'M610 470 Q590 520 612 560', line: 'seam', fill: 'none' },
    { d: 'M440 436 L470 470 M470 426 L500 462', line: 'seam', width: 5 },
  ];
}

function sandal(): Part[] {
  return [
    { d: 'M120 540 L700 540 L700 590 L120 590 Z', fill: 'sole' },
    { d: 'M300 540 Q330 440 420 440 Q470 440 480 540 Z' },
    { d: 'M510 540 Q540 450 610 450 Q660 450 670 540 Z' },
    { d: circle(450, 470, 10), fill: 'metal' },
  ];
}

function slide(): Part[] {
  return [
    { d: 'M120 540 L700 540 L700 596 L120 596 Z', fill: 'sole' },
    { d: 'M380 540 Q390 420 520 420 Q640 420 660 540 Z' },
    { d: 'M430 470 L610 470 M430 500 L630 500', line: 'seam', width: 8 },
  ];
}

function heel(): Part[] {
  return [
    {
      d: 'M150 400 Q200 380 260 420 Q400 520 520 540 Q640 560 700 580 L690 600 L500 600 Q380 560 250 480 L220 640 L196 640 L200 470 Q160 440 150 400 Z',
    },
  ];
}

function glove(cx: number, mirror: boolean): Part[] {
  const s = mirror ? -1 : 1;
  const x = (v: number) => cx + s * v;
  return [
    {
      d:
        `M${x(-80)} 640 L${x(-90)} 400 L${x(-110)} 250 Q${x(-110)} 225 ${x(-88)} 225 L${x(-70)} 360 ` +
        `L${x(-60)} 180 Q${x(-60)} 155 ${x(-35)} 155 L${x(-24)} 340 L${x(-10)} 160 Q${x(-6)} 135 ${x(18)} 140 ` +
        `L${x(22)} 345 L${x(44)} 190 Q${x(50)} 168 ${x(70)} 176 L${x(66)} 380 L${x(120)} 330 Q${x(140)} 318 ${x(146)} 340 ` +
        `L${x(84)} 470 L${x(80)} 640 Z`,
    },
    {
      d: `M${x(-80)} 600 L${x(80)} 600 L${x(80)} 640 L${x(-80)} 640 Z`,
      fill: 'trim',
    },
  ];
}

function sock(cx: number): Part[] {
  return [
    {
      d: `M${cx - 50} 150 L${cx + 50} 150 L${cx + 50} 470 Q${cx + 50} 560 ${cx - 20} 610 L${cx - 110} 650 Q${cx - 160} 650 ${cx - 150} 600 Q${cx - 140} 570 ${cx - 50} 520 Z`,
    },
    {
      d: `M${cx - 50} 150 L${cx + 50} 150 L${cx + 50} 200 L${cx - 50} 200 Z`,
      fill: 'trim',
    },
  ];
}

// ---- Choosing a shape ---------------------------------------------------------

// Words people type for a shape (sparse's "grey tshirt", "work pants").
const NAME_WORDS: [RegExp, string][] = [
  [/\b(tee|t-?shirt)\b/, 't-shirt'],
  [/\bpants\b/, 'trousers'],
  [/\bbag\b/, 'tote'],
  [/\bsocks?\b/, 'socks'],
  [/\bumbrella\b/, 'umbrella'],
  [/\bdress\b/, 'day-dress'],
];

const CATEGORY_SHAPES: Record<string, string> = {
  [GarmentCategory.TOPS]: 't-shirt',
  [GarmentCategory.BOTTOMS]: 'trousers',
  [GarmentCategory.DRESSES]: 'day-dress',
  [GarmentCategory.OUTERWEAR]: 'jacket',
  [GarmentCategory.FOOTWEAR]: 'sneakers',
  [GarmentCategory.ACCESSORIES]: 'scarf',
  [GarmentCategory.BAGS]: 'tote',
};

/**
 * The shape for a garment: its type's, else a type or word its name
 * mentions ("puffer", "work pants"), else its category's; a custom
 * category gets a folded square.
 */
export function shapeOf(subject: ArtSubject): string {
  if (subject.type && subject.type in SHAPES) return subject.type;
  const name = (subject.name ?? '').toLowerCase();
  const named =
    Object.keys(SHAPES).find((shape) =>
      new RegExp(`\\b${shape}\\b`).test(name),
    ) ?? NAME_WORDS.find(([pattern]) => pattern.test(name))?.[1];
  return (
    named ?? CATEGORY_SHAPES[normalizeCategory(subject.category)] ?? 'folded'
  );
}

/** Every shape the art can draw (the art spec draws each once). */
export const ART_SHAPES: readonly string[] = Object.keys(SHAPES);

// ---- Rendering ------------------------------------------------------------------

/** The garment as an SVG document on a transparent ART_SIZE square. */
export function garmentSvg(subject: ArtSubject): string {
  const base = mainColor(subject);
  const second = subject.colors[1] ? COLORS[subject.colors[1]] : undefined;
  // Pale garments need a darker line to read on white.
  const outline = shade(base, luminance(base) > 0.7 ? 0.38 : 0.35);
  const fills: Record<Exclude<Fill, 'main' | 'none'>, string> = {
    trim: shade(base, luminance(base) > 0.2 ? 0.1 : -0.12),
    dark: shade(base, 0.45),
    accent: second ?? shade(base, luminance(base) > 0.5 ? 0.3 : -0.35),
    sole: '#f1eee6',
    metal: '#b9b3a4',
  };
  const pattern = patternDef(subject.pattern, base, second);
  const colours: PartColours = {
    body: pattern ? 'url(#pattern)' : base,
    fills,
    outline,
    seam: shade(base, luminance(base) > 0.5 ? 0.25 : -0.25),
  };
  const parts = SHAPES[shapeOf(subject)]().map((part) =>
    partSvg(part, colours),
  );
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ART_SIZE}" height="${ART_SIZE}" viewBox="0 0 ${ART_SIZE} ${ART_SIZE}">` +
    `<defs>${pattern ?? ''}</defs>` +
    `<g stroke-linejoin="round" stroke-linecap="round">${parts.join('')}</g></svg>`
  );
}

interface PartColours {
  /** The garment's colour, or its pattern. */
  body: string;
  fills: Record<Exclude<Fill, 'main' | 'none'>, string>;
  outline: string;
  seam: string;
}

function partSvg(part: Part, colours: PartColours): string {
  const line = part.line ?? 'outline';
  const stroke =
    line === 'none'
      ? ''
      : ` stroke="${line === 'seam' ? colours.seam : colours.outline}" stroke-width="${part.width ?? (line === 'seam' ? 4 : 6)}"`;
  const offset = part.offset
    ? ` transform="translate(${part.offset[0]} ${part.offset[1]})"`
    : '';
  return `<path d="${part.d}" fill="${fillOf(part, colours)}"${stroke}${offset}/>`;
}

function fillOf(part: Part, colours: PartColours): string {
  // A seam drawn without a fill of its own is only a line.
  if (part.fill === undefined) {
    return part.line === 'seam' ? 'none' : colours.body;
  }
  if (part.fill === 'none') return 'none';
  return part.fill === 'main' ? colours.body : colours.fills[part.fill];
}

function patternDef(
  pattern: string | null,
  base: string,
  second: string | undefined,
): string | undefined {
  const other = second ?? shade(base, luminance(base) > 0.5 ? 0.35 : -0.4);
  switch (pattern) {
    case 'stripes':
      return (
        `<pattern id="pattern" width="40" height="40" patternUnits="userSpaceOnUse">` +
        `<rect width="40" height="40" fill="${base}"/><rect y="24" width="40" height="12" fill="${other}"/></pattern>`
      );
    case 'check':
      return (
        `<pattern id="pattern" width="80" height="80" patternUnits="userSpaceOnUse">` +
        `<rect width="80" height="80" fill="${base}"/>` +
        `<rect x="0" y="30" width="80" height="22" fill="${other}" opacity="0.6"/>` +
        `<rect x="30" y="0" width="22" height="80" fill="${other}" opacity="0.6"/>` +
        `<rect x="64" y="0" width="4" height="80" fill="${shade(base, 0.5)}" opacity="0.7"/></pattern>`
      );
    case 'print':
    case 'floral':
    case 'graphic':
    case 'other':
      return (
        `<pattern id="pattern" width="60" height="60" patternUnits="userSpaceOnUse">` +
        `<rect width="60" height="60" fill="${base}"/><circle cx="15" cy="15" r="7" fill="${other}"/>` +
        `<circle cx="45" cy="45" r="7" fill="${other}"/></pattern>`
      );
    default:
      return undefined;
  }
}

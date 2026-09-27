import { categoryRole, type GarmentRole } from '../wardrobe/properties';
import { ART_SIZE, type ArtSubject, garmentMarkup } from './art';

/**
 * The seed's outfit selfies (#19): a mirror photo drawn from the outfit's
 * own garment art (art.ts) worn by a figure holding a phone, in a framed
 * mirror on a wall, as SVG. Deterministic, like the garment art: drawn from
 * the garments and the room alone, so no image file is committed and every
 * seed stores the same pixels. Opaque, as a photo is: it is stored as a
 * selfie keeps its background (no cutout).
 */

export const SELFIE_WIDTH = 900;
export const SELFIE_HEIGHT = 1200;

/** The rooms a selfie is taken in; the seed picks one by the day. */
const ROOMS = [
  { wall: '#e8e2d8', floor: '#b39373', frame: '#6c5644' },
  { wall: '#dde3e6', floor: '#8e8983', frame: '#2e2f33' },
  { wall: '#efe4d7', floor: '#a67c5a', frame: '#c6a674' },
] as const;
export const SELFIE_ROOMS = ROOMS.length;

const SKIN = '#c99a7c';
const HAIR = '#3a2a20';
const PHONE = '#1e1e21';

// Where each role is worn on the figure, as a square of the garment art
// (x, y, side) inside the mirror, the drawings' own margins allowed for:
// a collar at the neck, trousers from the shirt's hem, shoes on the floor.
// Drawn in this order, so a top is over the waist of its trousers and a
// layer over the top.
const PLACES: {
  roles: readonly GarmentRole[];
  x: number;
  y: number;
  side: number;
}[] = [
  { roles: ['bottom'], x: 200, y: 450, side: 500 },
  { roles: ['one-piece'], x: 170, y: 200, side: 560 },
  { roles: ['top'], x: 240, y: 190, side: 420 },
  { roles: ['layer'], x: 215, y: 175, side: 470 },
  { roles: ['footwear'], x: 340, y: 820, side: 220 },
];
// Accessories, bags and the rest hang beside the figure, a few at most.
const SIDE = { x: 585, y: 330, side: 140, step: 155, max: 4 };

/**
 * The mirror selfie of an outfit's garments in room `room` (any integer;
 * taken modulo the rooms), as an SVG document of SELFIE_WIDTH by
 * SELFIE_HEIGHT.
 */
export function mirrorSelfieSvg(
  garments: readonly ArtSubject[],
  room: number,
): string {
  const { wall, floor, frame } = ROOMS[Math.abs(room) % ROOMS.length];
  let drawn = 0;
  const wear = (subject: ArtSubject, x: number, y: number, side: number) =>
    `<svg x="${x}" y="${y}" width="${side}" height="${side}" viewBox="0 0 ${ART_SIZE} ${ART_SIZE}">` +
    `${garmentMarkup(subject, `garment-${drawn++}`)}</svg>`;
  const worn = PLACES.flatMap(({ roles, x, y, side }) =>
    garments
      .filter((g) => roles.includes(categoryRole(g.category)))
      .map((g) => wear(g, x, y, side)),
  );
  const placed = new Set(PLACES.flatMap((place) => place.roles));
  const beside = garments
    .filter((g) => !placed.has(categoryRole(g.category)))
    .slice(0, SIDE.max)
    .map((g, i) => wear(g, SIDE.x, SIDE.y + i * SIDE.step, SIDE.side));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SELFIE_WIDTH}" height="${SELFIE_HEIGHT}" viewBox="0 0 ${SELFIE_WIDTH} ${SELFIE_HEIGHT}">` +
    // The room: the wall and the floor it stands on.
    `<rect width="${SELFIE_WIDTH}" height="${SELFIE_HEIGHT}" fill="${wall}"/>` +
    `<rect y="1060" width="${SELFIE_WIDTH}" height="140" fill="${floor}"/>` +
    // The mirror: its frame, the glass and the room it reflects.
    `<rect x="150" y="50" width="600" height="1110" rx="28" fill="${frame}"/>` +
    `<rect x="175" y="75" width="550" height="1060" rx="16" fill="${wall}"/>` +
    `<rect x="175" y="985" width="550" height="150" fill="${floor}" opacity="0.85"/>` +
    // The figure behind the clothes: the head, then the neck.
    `<circle cx="450" cy="175" r="60" fill="${SKIN}"/>` +
    `<path d="M390 170 Q392 108 450 106 Q508 108 510 170 Q490 140 450 138 Q410 140 390 170Z" fill="${HAIR}"/>` +
    `<rect x="428" y="225" width="44" height="40" fill="${SKIN}"/>` +
    worn.join('') +
    beside.join('') +
    // The phone held up in front of the face, and the hand holding it.
    `<rect x="470" y="120" width="74" height="138" rx="12" fill="${PHONE}"/>` +
    `<circle cx="507" cy="265" r="24" fill="${SKIN}"/>` +
    // The glass's shine, over everything in the mirror.
    `<path d="M175 75 L330 75 L175 330 Z" fill="#ffffff" opacity="0.18"/>` +
    `<path d="M725 700 L725 900 L600 1135 L480 1135 Z" fill="#ffffff" opacity="0.1"/>` +
    '</svg>'
  );
}

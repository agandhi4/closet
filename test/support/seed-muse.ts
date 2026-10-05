import { Readable } from 'node:stream';
import pino from 'pino';
import sharp from 'sharp';
import { loadConfig } from '../../src/config';
import { initialCutoutState } from '../../src/cutout/state';
import { optionGroup } from '../../src/db/schema';
import { garmentSvg } from '../../src/seed/art';
import type { GarmentColor, Pattern } from '../../src/wardrobe/properties';
import type { OwnerDismissReason } from '../../src/wardrobe/suggestions';
import { createToken } from '../../src/web/auth/personal-tokens';
import { createPhotos, photosConfig } from '../../src/web/files/photos';
import { insertPhotoRow } from '../../src/web/files/queries';
import { insertGarment } from '../../src/web/wardrobe/queries';
import { decide, markSuggestion } from '../../src/web/wishlist/decisions';
import { userIdOf, withServerDb } from './server-db';

/**
 * Muse's needs and picks (#333) for `email`'s account (the demo persona's
 * under seedDemoAs, whose closet gives "Unlocks N" real answers): products
 * as a Muse round would leave them, each with the seed's generated art
 * (src/seed/art.ts, stored as its own cutout, like the persona's), written
 * through the app's writers: insertGarment, markSuggestion, decide.
 * Returns the ids test/muse.spec.ts navigates by.
 */

interface Product {
  name: string;
  brand: string;
  category: string;
  type: string;
  colors: GarmentColor[];
  pattern?: Pattern;
  price: string;
  note: string;
  url: string;
}

interface NeedSeed {
  name: string;
  budget: string | null;
  note: string;
  options: Product[];
}

const NEEDS: NeedSeed[] = [
  {
    name: 'A navy unstructured blazer',
    budget: '350',
    note: 'Your office days are an oxford and chinos. A soft navy blazer dresses every one of them up without turning them into a suit, and it goes over the grey merino too.',
    options: [
      {
        name: 'Navy unstructured wool blazer',
        brand: 'J.Crew',
        category: 'outerwear',
        type: 'blazer',
        colors: ['blue'],
        price: '298',
        note: 'Half-lined and soft-shouldered: it packs flat and sits well over a knit.',
        url: 'https://www.jcrew.com/p/navy-unstructured-blazer',
      },
      {
        name: 'Navy cotton-linen blazer',
        brand: 'Uniqlo',
        category: 'outerwear',
        type: 'blazer',
        colors: ['blue'],
        price: '79.90',
        note: 'The cheap way in: lighter, for May to September.',
        url: 'https://www.uniqlo.com/us/en/products/navy-cotton-linen-blazer',
      },
      {
        name: 'Navy hopsack blazer',
        brand: 'Suitsupply',
        category: 'outerwear',
        type: 'blazer',
        colors: ['blue'],
        price: '399',
        note: 'The most structured of the three, and over budget.',
        url: 'https://suitsupply.com/en-us/men/blazers/navy-hopsack-blazer',
      },
    ],
  },
  {
    name: 'Brown suede chelsea boots',
    budget: '250',
    note: 'Everything you own on your feet is white or black. Brown suede warms up the navy and the olive.',
    options: [
      {
        name: 'Brown suede chelsea boots',
        brand: 'Thursday',
        category: 'footwear',
        type: 'boots',
        colors: ['brown'],
        price: '199',
        note: 'Commando-free leather sole; resoleable.',
        url: 'https://thursdayboots.com/products/mens-duke-chelsea-boot-brown-suede',
      },
      {
        name: 'Snuff suede chelsea boots',
        brand: 'Grenson',
        category: 'footwear',
        type: 'boots',
        colors: ['brown'],
        price: '320',
        note: 'Over budget, but a Goodyear welt.',
        url: 'https://www.grenson.com/us/nolan-snuff-suede',
      },
    ],
  },
  {
    name: 'A grey crewneck sweatshirt',
    budget: '90',
    note: 'For the weekend rotation: your two hoodies do the job, but nothing smarter.',
    options: [
      {
        name: 'Heather grey loopback crewneck',
        brand: 'Reigning Champ',
        category: 'tops',
        type: 'sweatshirt',
        colors: ['grey'],
        price: '85',
        note: 'Heavy loopback that keeps its shape.',
        url: 'https://reigningchamp.com/products/midweight-terry-crewneck-heather-grey',
      },
      {
        name: 'Grey crewneck sweatshirt',
        brand: 'Uniqlo',
        category: 'tops',
        type: 'sweatshirt',
        colors: ['grey'],
        price: '39.90',
        note: 'Lighter weight, half the price.',
        url: 'https://www.uniqlo.com/us/en/products/grey-sweatshirt',
      },
    ],
  },
  {
    name: 'An olive field jacket',
    budget: '300',
    note: 'A mid-weight layer between the denim jacket and the parka.',
    options: [
      {
        name: 'Olive waxed field jacket',
        brand: 'Barbour',
        category: 'outerwear',
        type: 'jacket',
        colors: ['green'],
        price: '289',
        note: 'Rewaxable; it only gets better.',
        url: 'https://www.barbour.com/us/olive-waxed-field-jacket',
      },
    ],
  },
  {
    name: 'A light rain shell',
    budget: '200',
    note: 'Still looking: nothing packable in your palette yet.',
    options: [],
  },
  {
    name: 'Black dress loafers',
    budget: '250',
    note: 'Still looking for a penny loafer in your size.',
    options: [],
  },
  {
    name: 'A patterned silk scarf',
    budget: '120',
    note: 'One pattern at a time: a scarf could be it.',
    options: [
      {
        name: 'Paisley silk scarf',
        brand: 'Drake’s',
        category: 'accessories',
        type: 'scarf',
        colors: ['red', 'blue'],
        pattern: 'print',
        price: '115',
        note: 'Wine and navy, for the grey coat.',
        url: 'https://www.drakes.com/paisley-silk-scarf',
      },
    ],
  },
];

export interface MuseSeed {
  /** The need ids, in NEEDS order. */
  needs: number[];
  /** Each need's option ids, in NEEDS order. */
  options: number[][];
}

/**
 * Seeds NEEDS for `email` and decides a few as an owner would: the field
 * jacket chosen (Ready to buy), the scarf need set aside and the hopsack
 * blazer set aside as too pricey, so every section of the inbox shows.
 */
export async function seedMuseInbox(email: string): Promise<MuseSeed> {
  const config = loadConfig();
  const logger = pino({ level: 'silent' });
  return withServerDb(async (db) => {
    const ownerId = await userIdOf(db, email);
    const photos = createPhotos(photosConfig(config), db, logger);
    const token = await createToken(db, ownerId, 'Muse');
    if (!token.created) throw new Error(`${email} holds too many tokens`);
    const needs: number[] = [];
    const options: number[][] = [];
    for (const need of NEEDS) {
      const [row] = await db
        .insert(optionGroup)
        .values({
          ownerId,
          name: need.name,
          budget: need.budget,
          note: need.note,
          suggestedByTokenId: token.id,
        })
        .returning({ id: optionGroup.id });
      needs.push(row.id);
      const ids: number[] = [];
      for (const [index, product] of need.options.entries()) {
        const png = await sharp(
          Buffer.from(
            garmentSvg({
              category: product.category,
              type: product.type,
              name: product.name,
              colors: product.colors,
              pattern: product.pattern ?? null,
            }),
          ),
        )
          .png()
          .toBuffer();
        const stored = await photos.storeImage(
          {
            stream: Readable.from(png),
            mimetype: 'image/png',
            filename: `muse-${row.id}-${index}.png`,
          },
          0,
          { alphaIsCutout: true },
        );
        const photoId = await insertPhotoRow(db, {
          ...stored,
          createdById: ownerId,
          ...initialCutoutState('ready'),
        });
        const id = await insertGarment(
          db,
          ownerId,
          {
            name: product.name,
            category: product.category,
            type: product.type,
            brand: product.brand,
            colors: product.colors,
            pattern: product.pattern ?? null,
            size: null,
            notes: null,
            washingDetails: null,
            acquiredOn: null,
            price: product.price,
            sourceUrl: product.url,
          },
          photoId,
          'wishlist',
        );
        const marked = await markSuggestion(db, ownerId, id, {
          tokenId: token.id,
          groupId: row.id,
          note: product.note,
          rank: index + 1,
        });
        if (marked !== 'marked') throw new Error(`${product.name}: ${marked}`);
        ids.push(id);
      }
      options.push(ids);
    }
    const decided = async (
      decision: Parameters<typeof decide>[2],
    ): Promise<void> => {
      const outcome = await decide(db, ownerId, decision);
      if (!outcome.ok) throw new Error(`${decision.kind}: ${outcome.reason}`);
    };
    const tooPricey: OwnerDismissReason = 'too_pricey';
    await decided({
      kind: 'dismiss-pick',
      garmentId: options[0][2],
      reason: tooPricey,
      note: 'Over budget',
    });
    await decided({ kind: 'choose', garmentId: options[3][0] });
    await decided({
      kind: 'dismiss-group',
      groupId: needs[6],
      reason: 'not_now',
      note: null,
    });
    return { needs, options };
  });
}

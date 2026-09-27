import { createHash } from 'node:crypto';

/**
 * Seeded randomness for everything that must come out the same for the same
 * inputs: the seed personas' simulated history (src/seed/random.ts) and the
 * outfit generator's suggestions (src/wardrobe/generator.ts). Never
 * Math.random or the clock: a sequence is fully decided by its key, so a
 * persona reseeds byte for byte and a gallery page is the same page every
 * time it is asked for.
 */

export interface Random {
  /** A draw in [0, 1). */
  next(): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** A standard normal draw (Box-Muller). */
  gaussian(): number;
  /** The index `weights` points at, in proportion to them; -1 when all are 0. */
  weighted(weights: readonly number[]): number;
}

/** The sequence for `key`: its parts joined and hashed into sfc32's state. */
export function seededRandom(...key: (string | number)[]): Random {
  const seed = createHash('sha256').update(key.join('\u0000')).digest();
  const next = sfc32(
    seed.readUInt32LE(0),
    seed.readUInt32LE(4),
    seed.readUInt32LE(8),
    seed.readUInt32LE(12),
  );
  return {
    next,
    chance: (p) => next() < p,
    gaussian: () => {
      // 1 - next() is in (0, 1]: the log is finite.
      const radius = Math.sqrt(-2 * Math.log(1 - next()));
      return radius * Math.cos(2 * Math.PI * next());
    },
    weighted: (weights) => {
      const total = weights.reduce((sum, w) => sum + w, 0);
      if (total <= 0) return -1;
      let point = next() * total;
      for (let i = 0; i < weights.length; i += 1) {
        point -= weights[i];
        if (point < 0) return i;
      }
      return weights.length - 1;
    },
  };
}

// Small Fast Counter (Chris Doty-Humphrey's sfc32, as in PractRand): 128
// bits of state, fast, and good enough for simulated weather and outfits.
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

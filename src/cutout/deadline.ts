/**
 * Whether `work` settles within `ms`: true once it resolves, false when the
 * time runs out first. It keeps running either way; the caller decides what
 * to cut short. A rejection is passed on. For the cutout queue's shutdown
 * (CutoutQueue.stop, CutoutListener.close), which must never hang a deploy.
 */
export async function settlesWithin(
  work: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

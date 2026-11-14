import { appIconFile } from '../app-icon';
import type { ViewContext } from '../view-context';

/**
 * The app's icon and name above a signed-out page's content (sign in,
 * register, the invite landing): the first screen a household member sees
 * says what the app is. The icon is decorative, the name beside it labels it.
 */
export function BrandMark({ ctx }: { ctx: ViewContext }) {
  return (
    <div class="flex flex-col items-center gap-2">
      <img
        src={`/assets/${appIconFile(ctx.iconName, 192)}`}
        alt=""
        width="64"
        height="64"
        class="size-16 rounded-box"
      />
      <p class="font-serif text-2xl font-semibold">{ctx.appName}</p>
    </div>
  );
}

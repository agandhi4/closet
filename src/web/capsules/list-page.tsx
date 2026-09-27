import { imageUrl } from '../files/image-url';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { EmptyState, HangerIcon } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { capsuleUrl, wardrobeUrl } from '../wardrobe/urls';
import { WardrobeTabs } from '../wardrobe/wardrobe-tabs';
import type { CapsuleCard, StripGarment } from './queries';

export interface CapsulesModel {
  /** The closet (inCloset): the first and permanent capsule. */
  closet: { count: number; strip: StripGarment[] };
  capsules: CapsuleCard[];
  /** The shared wardrobe shown; undefined for the requester's own. */
  viewOwner: number | undefined;
  /** New capsule: the owner only. */
  isOwner: boolean;
}

/** "1 garment", "12 garments". */
export function garmentCount(count: number): string {
  return count === 1 ? t('GARMENT_COUNT_ONE') : t('GARMENT_COUNT', { count });
}

/**
 * GET /capsules: the wardrobe page's Capsules tab. The closet comes first,
 * as the capsule every other is carved from (it is not a row: it links to
 * the grid), then the wardrobe's capsules by name, each with its count and
 * its newest garments.
 */
export function CapsulesPage(props: {
  ctx: ViewContext;
  model: CapsulesModel;
}) {
  const { ctx, model } = props;
  const { viewOwner } = model;
  return (
    <Layout ctx={ctx} title={t('CAPSULES')}>
      <AppBar
        ctx={ctx}
        title={t('WARDROBE')}
        actions={
          model.isOwner && (
            <a href="/capsules/new" class="btn btn-primary btn-sm">
              + {t('NEW_CAPSULE')}
            </a>
          )
        }
      />
      <main class="p-4 pt-20 pb-24">
        <WardrobeTabs active="capsules" viewOwner={viewOwner} />
        <div class="flex flex-col gap-4 max-w-lg mx-auto">
          <Card
            href={wardrobeUrl(viewOwner)}
            name={t('CLOSET')}
            count={model.closet.count}
            strip={model.closet.strip}
          />
          {model.capsules.map((capsule) => (
            <Card
              href={capsuleUrl(capsule.id, viewOwner)}
              name={capsule.name}
              count={capsule.count}
              strip={capsule.strip}
            />
          ))}
        </div>
        {model.capsules.length === 0 && (
          <EmptyState
            message={t(model.isOwner ? 'NO_CAPSULES' : 'NO_CAPSULES_SHARED')}
          >
            {model.isOwner && (
              <a href="/capsules/new" class="btn btn-primary btn-sm">
                {t('ADD_FIRST_CAPSULE')}
              </a>
            )}
          </EmptyState>
        )}
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

function Card(props: {
  href: string;
  name: string;
  count: number;
  strip: StripGarment[];
}) {
  return (
    <a
      href={props.href}
      class="card bg-base-100 shadow-sm hover:shadow-md transition-shadow"
    >
      <div class="card-body p-4 gap-3">
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="card-title text-base">{props.name}</h2>
          <span class="text-sm text-base-content/60 shrink-0">
            {garmentCount(props.count)}
          </span>
        </div>
        {props.strip.length > 0 && (
          <div class="grid grid-cols-4 gap-2">
            {props.strip.map((garment) => (
              <StripThumb garment={garment} />
            ))}
          </div>
        )}
      </div>
    </a>
  );
}

/** A quarter of the card's width, square: the thumb variant, or the placeholder. */
function StripThumb({ garment }: { garment: StripGarment }) {
  return (
    <figure class="aspect-square rounded-box overflow-hidden bg-base-200">
      {garment.photo ? (
        <img
          src={imageUrl(garment.photo, 'thumb')}
          alt={garment.name ?? ''}
          class="object-cover w-full h-full"
          width="400"
          height="400"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div class="flex items-center justify-center w-full h-full text-base-content/30">
          <HangerIcon class="size-6" strokeWidth="1.5" />
        </div>
      )}
    </figure>
  );
}

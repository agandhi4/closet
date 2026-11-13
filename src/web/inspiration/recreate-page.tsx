import type {
  Agreement,
  PieceMatch,
  Recreation,
} from '../../wardrobe/recreate';
import { inspirationPhotoUrl } from '../files/image-url';
import type { RecreatePoolGarment } from '../gallery/queries';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { PageMain } from '../layout/page-main';
import { GarmentPicture } from '../layout/parts';
import { SnapStrip, SnapStripsInit, snapItem } from '../strip/snap-strip';
import type { ViewContext } from '../view-context';
import { categoryLabel } from '../wardrobe/garment';
import { lookName } from './look-name';
import { pieceName } from './piece-form';
import type { InspirationDetail, StoredPiece } from './queries';
import { inspirationPiecesUrl, inspirationUrl } from './urls';

/**
 * GET /inspiration/:id/recreate, "Recreate this look" (#22b): the look's
 * photo, then each piece the owner tagged with the closet's closest
 * garments (src/wardrobe/recreate.ts), the chosen one centred in a snap
 * strip and the alternates beside it, and the pieces nothing in the closet
 * is close to. Says when a match is not the closest because the closest
 * clashed with the rest, and which pieces it could not make go together.
 * Display only in 22b: saving the chosen set as an outfit and "Find this"
 * for a missing piece are 22c.
 */
export function RecreatePage(props: {
  ctx: ViewContext;
  look: InspirationDetail;
  recreation: Recreation<RecreatePoolGarment>;
}) {
  const { ctx, look, recreation } = props;
  const name = lookName(look);
  const matched = recreation.pieces.filter((p) => p.matches.length > 0).length;
  return (
    <Layout ctx={ctx} title={t('inspiration.RECREATE_TITLE', { title: name })}>
      <AppBar
        ctx={ctx}
        title={t('inspiration.RECREATE')}
        back={inspirationUrl(look.id)}
      />
      <PageMain class="p-4 pt-20 pb-24 flex flex-col gap-4">
        {look.photo && (
          <img
            src={inspirationPhotoUrl(look.photo, 'thumb')}
            alt={t('inspiration.PHOTO_ALT', { title: name })}
            class="w-full max-h-72 object-contain rounded-box bg-base-200"
            decoding="async"
          />
        )}
        {look.pieces.length === 0 ? (
          <div class="flex flex-col gap-2 items-start">
            <p class="text-sm text-muted">{t('inspiration.RECREATE_EMPTY')}</p>
            <a
              href={inspirationPiecesUrl(look.id)}
              class="btn btn-primary btn-sm"
            >
              {t('inspiration.TAG_PIECES')}
            </a>
          </div>
        ) : (
          <>
            <p class="font-semibold" data-recreate-count="">
              {t('inspiration.IN_CLOSET', {
                matched,
                of: look.pieces.length,
              })}
            </p>
            {recreation.unfixed.length > 0 && (
              <div role="status" class="alert alert-warning alert-soft text-sm">
                {t('inspiration.UNFIXED', {
                  pieces: recreation.unfixed
                    .map((index) => pieceName(look.pieces[index]))
                    .join(', '),
                })}
              </div>
            )}
            <ol class="flex flex-col gap-5">
              {look.pieces.map((piece, index) => (
                <PieceMatches
                  piece={piece}
                  matches={recreation.pieces[index].matches}
                  repicked={recreation.pieces[index].repicked}
                />
              ))}
            </ol>
            <SnapStripsInit />
          </>
        )}
      </PageMain>
      <Dock ctx={ctx} />
    </Layout>
  );
}

function PieceMatches(props: {
  piece: StoredPiece;
  matches: readonly PieceMatch<RecreatePoolGarment>[];
  repicked: boolean;
}) {
  const { piece, matches } = props;
  const name = pieceName(piece);
  const headingId = `recreate-piece-${piece.position}`;
  return (
    <li
      class="flex flex-col gap-2"
      aria-labelledby={headingId}
      data-recreate-piece={piece.position}
      data-missing={matches.length === 0 ? '' : undefined}
    >
      <h2 id={headingId} class="font-medium">
        {name}
      </h2>
      {matches.length === 0 ? (
        <p class="text-sm text-muted">{t('inspiration.MISSING')}</p>
      ) : (
        <>
          {props.repicked && (
            <p class="text-xs text-muted">{t('inspiration.REPICKED')}</p>
          )}
          <SnapStrip
            size="regular"
            label={t('inspiration.MATCHES_LABEL', { piece: name })}
            focusable
            // Room for the chosen tile's ring: the strip clips its overflow.
            class="py-1"
          >
            {matches.map((match, index) => (
              <MatchTile match={match} selected={index === 0} />
            ))}
          </SnapStrip>
        </>
      )}
    </li>
  );
}

function MatchTile(props: {
  match: PieceMatch<RecreatePoolGarment>;
  selected: boolean;
}) {
  const { garment, agrees } = props.match;
  const name = garment.name ?? categoryLabel(garment.category);
  return (
    <div
      {...snapItem({
        value: String(garment.id),
        selected: props.selected,
        size: 'regular',
        class: 'flex flex-col gap-1',
      })}
      data-match={garment.id}
    >
      <div class="aspect-square rounded-box bg-base-200 flex items-center justify-center overflow-hidden ring-primary group-data-[selected]/item:ring-2">
        <GarmentPicture photo={garment.photo} loading="lazy" />
      </div>
      <p class="text-sm font-medium line-clamp-1">{name}</p>
      <p class="text-xs text-muted line-clamp-2">
        {agreementText(agrees)}
        {!garment.available && ` · ${t('inspiration.NOT_AVAILABLE')}`}
      </p>
    </div>
  );
}

/** What the match shares with its piece: "Same type · Close color". */
function agreementText(agrees: Agreement): string {
  const parts = [
    agrees.type && t('inspiration.AGREES_TYPE'),
    agrees.color === 'exact' && t('inspiration.AGREES_COLOR'),
    agrees.color === 'close' && t('inspiration.AGREES_CLOSE_COLOR'),
    agrees.pattern && t('inspiration.AGREES_PATTERN'),
  ].filter((part): part is string => typeof part === 'string');
  return parts.length > 0 ? parts.join(' · ') : t('inspiration.AGREES_ROLE');
}

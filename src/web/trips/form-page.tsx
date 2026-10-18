import { PostForm } from '../auth/form';
import type { FieldErrors } from '../auth/validation';
import { FormField, inputAttributes } from '../form-field';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import type { ViewContext } from '../view-context';
import { TRIPS_PATH, tripUrl } from './urls';
import {
  TRIP_DESTINATION_MAX,
  TRIP_NAME_MAX,
  TRIP_NOTES_MAX,
  type TripField,
} from './validation';
import { CancelLink } from '../layout/parts';

export interface TripFormModel {
  /** Absent for a new trip. */
  tripId?: number;
  values: {
    name: string;
    destination: string;
    startsOn: string;
    endsOn: string;
    notes: string;
  };
  errors?: FieldErrors<TripField>;
}

/**
 * GET /trips/new and /trips/:id/edit, and their re-render with the messages
 * when a post is refused (400): a native post (PostForm), since htmx drops a
 * boosted 4xx. Disabled offline (`needsNetwork`): a cached copy opened in
 * the installed app without a connection would otherwise post into the
 * worker's offline page and lose what was typed. The destination is a name here; the trip page finds it on the
 * map (the weather's geocoding) for its forecast, and a new name clears the
 * old location. The edit form also deletes the trip (its outfits stay).
 */
export function TripFormPage(props: {
  ctx: ViewContext;
  model: TripFormModel;
}) {
  const { ctx, model } = props;
  const { tripId, values, errors = {} } = model;
  const editing = tripId !== undefined;
  const title = t(editing ? 'trips.EDIT' : 'trips.NEW');
  const back = editing ? tripUrl(tripId) : TRIPS_PATH;
  return (
    <Layout ctx={ctx} title={title}>
      <AppBar ctx={ctx} title={title} back={back} formPage />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        <PostForm
          action={editing ? tripUrl(tripId) : TRIPS_PATH}
          class="flex flex-col gap-4"
          needsNetwork
        >
          <FormField
            id="trip-name"
            label={t('NAME')}
            required
            messages={errors.name}
          >
            <input
              {...inputAttributes('trip-name', 'w-full', errors.name)}
              type="text"
              name="name"
              value={values.name}
              maxlength={TRIP_NAME_MAX}
              required
              placeholder={t('trips.NAME_PLACEHOLDER')}
            />
          </FormField>
          <FormField id="trip-destination" label={t('trips.DESTINATION')}>
            <input
              {...inputAttributes('trip-destination', 'w-full')}
              type="text"
              name="destination"
              value={values.destination}
              maxlength={TRIP_DESTINATION_MAX}
              autocomplete="off"
              placeholder={t('trips.DESTINATION_PLACEHOLDER')}
            />
          </FormField>
          <div class="grid grid-cols-2 gap-3">
            <DateField
              field="startsOn"
              label={t('trips.STARTS')}
              value={values.startsOn}
              errors={errors.startsOn}
            />
            <DateField
              field="endsOn"
              label={t('trips.ENDS')}
              value={values.endsOn}
              errors={errors.endsOn}
            />
          </div>
          <FormField id="trip-notes" label={t('NOTES')}>
            <textarea
              id="trip-notes"
              name="notes"
              class="textarea textarea-bordered w-full"
              rows={3}
              maxlength={TRIP_NOTES_MAX}
            >
              {values.notes}
            </textarea>
          </FormField>
          <div class="flex gap-2 mt-2">
            <button type="submit" class="btn btn-primary flex-1">
              {t('SAVE')}
            </button>
            <CancelLink href={back} />
          </div>
        </PostForm>
        {editing && (
          <button
            type="button"
            class="btn btn-error btn-outline btn-sm w-full mt-8"
            hx-delete={tripUrl(tripId)}
            hx-confirm={t('trips.CONFIRM_DELETE')}
            data-needs-network=""
          >
            {t('trips.DELETE')}
          </button>
        )}
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** The trip's first or last day: required, so marked. */
function DateField(props: {
  field: 'startsOn' | 'endsOn';
  label: string;
  value: string;
  errors: string[] | undefined;
}) {
  const id = `trip-${props.field}`;
  return (
    <FormField id={id} label={props.label} required messages={props.errors}>
      <input
        {...inputAttributes(id, 'w-full', props.errors)}
        type="date"
        name={props.field}
        value={props.value}
        required
      />
    </FormField>
  );
}

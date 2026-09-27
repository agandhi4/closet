import { PostForm } from '../auth/form';
import type { FieldErrors } from '../auth/validation';
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
 * boosted 4xx. The destination is a name here; the trip page finds it on the
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
        >
          <RequiredField
            field="name"
            type="text"
            label={t('NAME')}
            value={values.name}
            errors={errors.name}
            maxlength={TRIP_NAME_MAX}
            placeholder={t('trips.NAME_PLACEHOLDER')}
          />
          <div class="flex flex-col">
            <label class="label" for="trip-destination">
              <span class="label-text">{t('trips.DESTINATION')}</span>
            </label>
            <input
              id="trip-destination"
              type="text"
              name="destination"
              class="input input-bordered w-full"
              value={values.destination}
              maxlength={TRIP_DESTINATION_MAX}
              autocomplete="off"
              placeholder={t('trips.DESTINATION_PLACEHOLDER')}
            />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <RequiredField
              field="startsOn"
              type="date"
              label={t('trips.STARTS')}
              value={values.startsOn}
              errors={errors.startsOn}
            />
            <RequiredField
              field="endsOn"
              type="date"
              label={t('trips.ENDS')}
              value={values.endsOn}
              errors={errors.endsOn}
            />
          </div>
          <div class="flex flex-col">
            <label class="label" for="trip-notes">
              <span class="label-text">{t('NOTES')}</span>
            </label>
            <textarea
              id="trip-notes"
              name="notes"
              class="textarea textarea-bordered w-full"
              rows={3}
              maxlength={TRIP_NOTES_MAX}
            >
              {values.notes}
            </textarea>
          </div>
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

/** A required input with its label and its messages; red with them. */
function RequiredField(props: {
  field: TripField;
  type: 'text' | 'date';
  label: string;
  value: string;
  errors: string[] | undefined;
  maxlength?: number;
  placeholder?: string;
}) {
  const id = `trip-${props.field}`;
  const invalid = (props.errors?.length ?? 0) > 0;
  return (
    <div class="flex flex-col">
      <label class="label" for={id}>
        <span class="label-text">{props.label} *</span>
      </label>
      <input
        id={id}
        type={props.type}
        name={props.field}
        class={`input input-bordered w-full ${invalid ? 'input-error' : ''}`}
        value={props.value}
        maxlength={props.maxlength}
        required
        placeholder={props.placeholder}
        aria-invalid={invalid ? 'true' : undefined}
      />
      {props.errors?.map((message) => (
        <p class="text-error text-sm mt-1">{message}</p>
      ))}
    </div>
  );
}

import type { FieldErrors } from '../auth/validation';
import { FormField, inputAttributes } from '../form-field';
import { t } from '../i18n';
import { FormPage } from '../layout/form-page';
import type { ViewContext } from '../view-context';
import { TRIPS_PATH, tripUrl } from './urls';
import {
  TRIP_DESTINATION_MAX,
  TRIP_NAME_MAX,
  TRIP_NOTES_MAX,
  type TripField,
} from './validation';

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
 * when a post is refused (400), in the shared add/edit frame (`FormPage`:
 * a native post, disabled offline). The destination is a name here; the trip
 * page finds it on the map (the weather's geocoding) for its forecast, and a
 * new name clears the old location. The edit form also deletes the trip (its
 * outfits stay).
 */
export function TripFormPage(props: {
  ctx: ViewContext;
  model: TripFormModel;
}) {
  const { ctx, model } = props;
  const { tripId, values, errors = {} } = model;
  const editing = tripId !== undefined;
  return (
    <FormPage
      ctx={ctx}
      title={t(editing ? 'trips.EDIT' : 'trips.NEW')}
      back={editing ? tripUrl(tripId) : TRIPS_PATH}
      action={editing ? tripUrl(tripId) : TRIPS_PATH}
      submitLabel={t('SAVE')}
      remove={
        editing
          ? {
              url: tripUrl(tripId),
              confirm: t('trips.CONFIRM_DELETE'),
              label: t('trips.DELETE'),
            }
          : undefined
      }
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
    </FormPage>
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

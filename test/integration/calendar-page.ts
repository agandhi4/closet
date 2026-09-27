/**
 * Each day block of the week agenda keyed by its YYYY-MM-DD date, in page
 * order: the `<section data-day>` the page draws per day (its heading,
 * entries, open slots, looks and "+ Plan"), without the plan sheets, which
 * follow the week.
 */
export function dayColumns(html: string): Map<string, string> {
  const columns = new Map<string, string>();
  for (const match of html.matchAll(
    /<section[^>]*\sdata-day="(\d{4}-\d{2}-\d{2})"/g,
  )) {
    const end = html.indexOf('</section>', match.index);
    columns.set(match[1], html.slice(match.index, end));
  }
  return columns;
}

/**
 * The label of a day's "+ Plan" button, which opens its sheet (all day):
 * undefined on a day with open template slots, which open it instead.
 */
export function planButtonLabel(html: string, day: string): string | undefined {
  return new RegExp(`data-day-plan="${day}"[^>]*>([^<]*)<`)
    .exec(html)?.[1]
    .replace(/\s+/g, ' ')
    .trim();
}

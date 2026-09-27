/**
 * Each day column's HTML keyed by its YYYY-MM-DD date, in page order. A
 * column ends with its "+ Plan" link, which carries the date; the first
 * column starts after the mini month's table.
 */
export function dayColumns(html: string): Map<string, string> {
  const columns = new Map<string, string>();
  let start = html.indexOf('</table>');
  for (const match of html.matchAll(
    /href="\/calendar\/plan\?for=day:(\d{4}-\d{2}-\d{2})&occasion=all-day"/g,
  )) {
    columns.set(match[1], html.slice(start, match.index));
    start = match.index + match[0].length;
  }
  return columns;
}

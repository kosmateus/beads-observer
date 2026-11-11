/** Preserve Node's source-mapped counters, not just rounded percentages. */
export default async function* report(
  events: AsyncIterable<{ type: string; data: unknown }>,
) {
  for await (const event of events)
    if (event.type === 'test:coverage') yield JSON.stringify(event.data);
}

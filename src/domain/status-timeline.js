/** Durations cover retained audit transitions only, not an assumed complete lifecycle. */
export function statusTimeline(issue, events, now = Date.now()) {
  const transitions = [];
  const parse = (value) => {
    try {
      return typeof value === 'object' ? value : JSON.parse(value);
    } catch {
      return null;
    }
  };
  for (const event of events || []) {
    if (!['status_changed', 'closed', 'reopened'].includes(event.event_type))
      continue;
    const status =
      event.event_type === 'closed'
        ? 'closed'
        : event.event_type === 'reopened'
          ? 'open'
          : parse(event.new_value)?.status;
    const at = Date.parse(event.created_at);
    if (
      typeof status !== 'string' ||
      !status ||
      !Number.isFinite(at) ||
      at > now
    )
      return { reason: 'unavailable', transitions: [], totals: [] };
    transitions.push({ status, at, actor: event.actor || '', id: event.id });
  }
  transitions.sort((a, b) => a.at - b.at);
  if (!transitions.length)
    return { reason: 'unavailable', transitions: [], totals: [] };
  if (
    transitions.some(
      (item, i) =>
        i &&
        item.at === transitions[i - 1].at &&
        item.status !== transitions[i - 1].status,
    )
  )
    return { reason: 'ambiguous', transitions, totals: [] };
  if (transitions.at(-1).status !== issue.status)
    return { reason: 'mismatch', transitions, totals: [] };
  const segments = [];
  for (const item of transitions)
    if (segments.at(-1)?.status !== item.status) segments.push({ ...item });
  const totals = new Map();
  segments.forEach((item, i) => {
    item.until = segments[i + 1]?.at ?? now;
    item.durationMs = item.until - item.at;
    item.ongoing = i === segments.length - 1;
    totals.set(item.status, (totals.get(item.status) || 0) + item.durationMs);
  });
  return {
    reason: null,
    from: segments[0].at,
    asOf: now,
    transitions: segments,
    totals: [...totals].map(([status, durationMs]) => ({ status, durationMs })),
  };
}

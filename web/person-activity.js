/** Only explicitly attributed audit events and comments; no inferred author/history. */
export function personActivity(detail, actor) {
  return [
    ...(detail.statusEvents || [])
      .filter((event) => event.actor === actor)
      .map((event) => ({
        key: 'event:' + detail.id + ':' + (event.id || JSON.stringify(event)),
        issue: detail.id,
        title: detail.title,
        at: event.created_at,
        kind: 'event',
        eventType: event.event_type,
      })),
    ...(detail.comments || [])
      .filter((comment) => comment.author === actor)
      .map((comment) => ({
        key:
          'comment:' +
          detail.id +
          ':' +
          (comment.id || JSON.stringify(comment)),
        issue: detail.id,
        title: detail.title,
        at: comment.created_at,
        kind: 'comment',
        text: comment.text || comment.body || comment.content || '',
      })),
  ];
}

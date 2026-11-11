// OpenCode v2.1.3: Session.Message.Info, FileDiff.Info. Do not infer task completion.
const clip = (value, max = 4000) =>
  typeof value === 'string' ? value.slice(0, max) : '';
export function sessionView(info, messages, active, diffs, warnings = []) {
  const blocks = [];
  for (const message of messages.slice(-60)) {
    if (['user', 'system', 'synthetic'].includes(message.type))
      blocks.push({
        kind: message.type,
        text: clip(message.text),
        id: message.id,
      });
    if (message.type === 'shell')
      blocks.push({
        kind: 'tool',
        id: message.id,
        name: 'shell',
        command: clip(message.command),
        text: clip(message.output?.output),
        status: message.status,
        exit: message.exit,
        time: message.time,
      });
    if (message.type === 'assistant')
      for (const [index, part] of (message.content || []).entries()) {
        if (['text', 'reasoning'].includes(part.type))
          blocks.push({
            kind: part.type,
            id: message.id + ':' + index,
            text: clip(part.text),
            time: part.time,
          });
        if (part.type === 'tool')
          blocks.push({
            kind: 'tool',
            id: part.id,
            name: clip(part.name, 200),
            status: part.state?.status,
            command: clip(
              part.state?.input?.command ||
                part.state?.input?.filePath ||
                part.state?.input?.path ||
                part.state?.input?.code ||
                (part.state?.input
                  ? JSON.stringify(part.state.input, null, 2)
                  : ''),
            ),
            text: clip(
              (part.state?.content || [])
                .filter((x) => x.type === 'text')
                .map((x) => x.text)
                .join('\n'),
            ),
            error: clip(
              typeof part.state?.error === 'string'
                ? part.state.error
                : part.state?.error?.message,
            ),
            time: part.time,
          });
      }
  }
  const selected = blocks.slice(-80);
  return {
    sessionID: info.id,
    title: info.title || info.id,
    agent: info.agent,
    projectDirectory: info.location?.directory,
    status: active ? 'running' : info.outcome || 'idle',
    outcome: info.outcome,
    time: info.time,
    blocks: selected,
    scope: 'active-context',
    diffScope: 'latest-turn',
    warnings,
    limited:
      messages.length > 60 ||
      blocks.length > 80 ||
      blocks.some((x) => x.text?.length >= 4000),
    diffs: (diffs || []).slice(0, 20).map((x) => ({
      file: clip(x.file, 500),
      patch: clip(x.patch, 10000),
      additions: x.additions,
      deletions: x.deletions,
      status: x.status,
      truncated: x.patch?.length > 10000,
    })),
    diffLimited: diffs?.length > 20,
  };
}

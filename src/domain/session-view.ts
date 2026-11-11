// OpenCode v2.1.3: Session.Message.Info, FileDiff.Info. Do not infer task completion.
import type { SessionInfo, SessionMessage, SessionDiff } from '../types.js';
interface Block {
  kind: string;
  text: string;
  id: string;
  author:
    | 'human'
    | 'coordinator'
    | 'agent'
    | 'delegation'
    | 'system'
    | 'synthetic'
    | 'unknown';
  name?: string;
  command?: string;
  status?: string;
  exit?: number;
  time?: unknown;
  error?: string;
}
interface OriginAwareMessage extends SessionMessage {
  metadata?: Record<string, unknown>;
}
const clip = (value: unknown, max = 4000) =>
  typeof value === 'string' ? value.slice(0, max) : '';

function createdAt(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || !('created' in value))
    return undefined;
  const created = value.created;
  if (typeof created === 'number' && Number.isFinite(created)) return created;
  if (typeof created === 'string') {
    const parsed = Date.parse(created);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function orderedMessages(messages: OriginAwareMessage[]) {
  const indexed = messages.map((message, index) => ({ message, index }));
  const times = indexed.map(({ message }) => createdAt(message.time));
  const ordered = indexed
    .filter(({ index }) => times[index] !== undefined)
    .sort((a, b) => times[a.index]! - times[b.index]! || a.index - b.index);
  let cursor = 0;
  return indexed.map(({ message, index }) =>
    times[index] === undefined ? { message, index } : ordered[cursor++]!,
  );
}

function authorOf(message: OriginAwareMessage): Block['author'] {
  if (message.type === 'system') return 'system';
  if (message.type === 'synthetic') return 'synthetic';
  if (message.type === 'assistant') return 'agent';
  const origin = message.metadata?.origin;
  if (
    origin === 'human' ||
    origin === 'coordinator' ||
    origin === 'agent' ||
    origin === 'delegation' ||
    origin === 'system' ||
    origin === 'synthetic'
  )
    return origin;
  return 'unknown';
}

export function sessionView(
  info: SessionInfo,
  messages: OriginAwareMessage[],
  active: boolean,
  diffs: SessionDiff[] | undefined,
  warnings: string[] = [],
) {
  const blocks: Block[] = [];
  const ordered = orderedMessages(messages);
  const fallbackOccurrences = new Map<string, number>();
  for (const { message, index } of ordered.slice(-60)) {
    const author = authorOf(message);
    const created = createdAt(message.time);
    const fallbackBase =
      created === undefined
        ? `index-${index}:${message.type}`
        : `${created}:${message.type}`;
    const occurrence = fallbackOccurrences.get(fallbackBase) || 0;
    fallbackOccurrences.set(fallbackBase, occurrence + 1);
    const messageKey =
      typeof message.id === 'string' && message.id
        ? message.id
        : `${fallbackBase}:${occurrence}`;
    if (['user', 'system', 'synthetic'].includes(message.type))
      blocks.push({
        kind: message.type,
        text: clip(message.text),
        id: `${info.id}:message:${messageKey}`,
        author,
      });
    if (message.type === 'shell')
      blocks.push({
        kind: 'tool',
        id: `${info.id}:message:${messageKey}`,
        author,
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
            id: `${info.id}:message:${messageKey}:part:${part.id || index}`,
            author,
            text: clip(part.text),
            time: part.time,
          });
        if (part.type === 'tool')
          blocks.push({
            kind: 'tool',
            id: `${info.id}:message:${messageKey}:part:${part.id || index}`,
            author,
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
      truncated: (x.patch?.length ?? 0) > 10000,
    })),
    diffLimited: (diffs?.length ?? 0) > 20,
  };
}

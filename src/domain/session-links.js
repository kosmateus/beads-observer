/** Conservative evidence extraction. Only IDs in the current Beads workspace count. */
export function mentionedIssues(text, known) {
  const tokens = String(text || '').match(/[A-Za-z0-9][A-Za-z0-9_.-]*/g) || [];
  return [
    ...new Set(
      tokens
        .map((token) => (known.has(token) ? token : token.replace(/\.+$/, '')))
        .filter((token) => known.has(token)),
    ),
  ];
}
// Tokenize shell syntax without splitting quoted descriptions into fake commands.
// Dynamic expansion and here-documents are deliberately not interpreted.
function shellCommands(command) {
  if (
    typeof command !== 'string' ||
    command.includes('<<') ||
    command.includes('$(') ||
    command.includes('`')
  )
    return [];
  const commands = [];
  let tokens = [],
    token = '',
    started = false,
    quote = null;
  const word = () => {
    if (started) tokens.push(token);
    token = '';
    started = false;
  };
  const end = () => {
    word();
    if (tokens.length) commands.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) {
        quote = null;
        continue;
      }
      if (c === '\\' && quote === '"') {
        token += command[++i] || '';
        continue;
      }
      token += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === '\\') {
      token += command[++i] || '';
      started = true;
      continue;
    }
    if (c === '#' && !started) {
      while (i < command.length && command[i] !== '\n') i++;
      end();
      continue;
    }
    if (c === ';' || c === '\n' || c === '&' || c === '|') {
      end();
      continue;
    }
    if (/\s/.test(c)) {
      word();
      continue;
    }
    token += c;
    started = true;
  }
  if (quote) return [];
  end();
  return commands;
}
const booleanFlags = new Set([
  '--claim',
  '--readonly',
  '--json',
  '--force',
  '--silent',
  '--quiet',
  '--verbose',
  '--dry-run',
  '--no-daemon',
  '--no-auto-flush',
  '--no-auto-import',
]);
function commandEvidence(command, known) {
  for (const clean of shellCommands(command).reverse()) {
    let index = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(clean[index] || '')) index++;
    if (!/(^|\/)bd$/.test(clean[index++] || '')) continue;
    // Global boolean flags may precede the verb. Unknown options are not guessed.
    while (booleanFlags.has(clean[index])) index++;
    if (!['show', 'update', 'close', 'reopen'].includes(clean[index++]))
      continue;
    const ids = [];
    for (; index < clean.length; index++) {
      const token = clean[index];
      if (token === '--id') {
        if (known.has(clean[index + 1])) ids.push(clean[index + 1]);
        index++;
        continue;
      }
      if (token.startsWith('--id=')) {
        if (known.has(token.slice(5))) ids.push(token.slice(5));
        continue;
      }
      if (token.startsWith('-')) {
        if (!token.includes('=') && !booleanFlags.has(token) && token !== '--')
          index++;
        continue;
      }
      if (known.has(token)) ids.push(token);
    }
    if (ids.length) return { ids: [...new Set(ids)], source: 'beads-command' };
  }
  return null;
}
// A small lexical scanner, not eval: only literal command properties of actual
// tools.shell({...}) / tools["shell"]({...}) calls count in Code Mode input.
function executeCommands(code) {
  if (typeof code !== 'string') return [];
  const tokens = [];
  const pattern =
    /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g;
  for (const match of code.matchAll(pattern)) {
    const text = match[0];
    if (/^\s|^\/\//.test(text) || text.startsWith('/*')) continue;
    if (text[0] === '"' || text[0] === "'" || text[0] === '`') {
      if (text[0] === '`' && text.includes('${')) {
        tokens.push({ value: null, literal: true });
        continue;
      }
      const value = text
        .slice(1, -1)
        .replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|[\s\S])/g, (_, c) =>
          c[0] === 'u' || c[0] === 'x'
            ? String.fromCharCode(parseInt(c.slice(1), 16))
            : ({ n: '\n', r: '\r', t: '\t' }[c] ?? c),
        );
      tokens.push({ value, literal: true });
    } else tokens.push({ value: text, literal: false });
  }
  const commands = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].literal || tokens[i].value !== 'tools') continue;
    let j = i + 1,
      name;
    while (tokens[j]?.value === '.' || tokens[j]?.value === '[') {
      if (tokens[j].value === '.') {
        name = tokens[j + 1]?.value;
        j += 2;
      } else {
        if (!tokens[j + 1]?.literal || tokens[j + 2]?.value !== ']') break;
        name = tokens[j + 1].value;
        j += 3;
      }
    }
    if (
      name !== 'shell' ||
      tokens[j]?.value !== '(' ||
      tokens[j + 1]?.value !== '{'
    )
      continue;
    let depth = 1;
    for (let k = j + 2; k < tokens.length && depth; k++) {
      const t = tokens[k];
      if (!t.literal && ['{', '[', '('].includes(t.value)) depth++;
      if (!t.literal && ['}', ']', ')'].includes(t.value)) depth--;
      if (
        depth === 1 &&
        t.value === 'command' &&
        tokens[k + 1]?.value === ':' &&
        tokens[k + 2]?.literal &&
        [',', '}'].includes(tokens[k + 3]?.value) &&
        typeof tokens[k + 2].value === 'string'
      )
        commands.push(tokens[k + 2].value);
    }
  }
  return commands;
}
export function directSessionLink(messages, known) {
  for (const message of [...messages].reverse()) {
    if (message.type === 'assistant')
      for (const part of [...(message.content || [])].reverse()) {
        if (part.type !== 'tool' || part.state?.status === 'error') continue;
        const input = part.state?.input;
        const name = part.name || '';
        const commands =
          name === 'shell'
            ? [input?.command]
            : name === 'execute'
              ? executeCommands(input?.code)
              : [];
        for (const command of commands.reverse()) {
          const result = commandEvidence(command, known);
          if (result) return result;
        }
        // Structured Beads tools: explicit issue identifier, not arbitrary tool output.
        if (/(?:^|[_.:-])(?:beads|bd)(?:[_.:-]|$)/i.test(part.name || '')) {
          const ids = [
            ...new Set(
              [input?.issue_id, input?.issueId, input?.id].filter((id) =>
                known.has(id),
              ),
            ),
          ];
          if (ids.length) return { ids, source: 'beads-tool' };
        }
      }
    if (message.type === 'shell' && message.status !== 'error') {
      const result = commandEvidence(message.command, known);
      if (result) return result;
    }
    if (message.type === 'user') {
      const ids = mentionedIssues(message.text, known);
      if (ids.length) return { ids, source: 'prompt' };
    }
  }
  return null;
}
/** A parent relationship alone says nothing about a child's assigned task. */
export function resolveSessionLinks(
  sessions,
  known,
  manual,
  remembered = new Map(),
) {
  const result = new Map();
  for (const [id, session] of sessions) {
    let link = null;
    const explicit = manual.get(id);
    if (explicit?.length) link = { issueId: explicit.at(-1), source: 'manual' };
    else if (session) {
      const own = directSessionLink(session.messages, known);
      if (own)
        link =
          own.ids.length === 1
            ? { issueId: own.ids[0], source: own.source }
            : { ambiguous: true, source: own.source };
    }
    const saved = remembered.get(id);
    if (
      !link &&
      session &&
      ['prompt', 'beads-command', 'beads-tool'].includes(saved?.source) &&
      known.has(saved.issueId)
    )
      link = saved;
    result.set(id, link);
  }
  return result;
}

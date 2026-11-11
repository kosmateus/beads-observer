/** Browser-side wire contracts. This module has no server runtime dependencies. */
export type Translate = (key: string) => string;
export interface Capabilities {
  csrfToken: string;
}
export interface MutationResult {
  id: string;
  error?: string;
}
export interface Edge {
  source: string;
  target: string;
  type: string;
}
export interface AuditEvent {
  id?: string | number;
  actor?: string;
  created_at: string;
  event_type: string;
  old_value?: string;
  new_value?: string;
}
export interface Comment {
  id?: string | number;
  author?: string;
  created_at: string;
  text?: string;
  body?: string;
  content?: string;
}
export interface StatusTimeline {
  reason?: string;
  from?: string;
  asOf?: string;
  totals: { status: string; durationMs: number }[];
  transitions: {
    status: string;
    at: string;
    durationMs: number;
    ongoing?: boolean;
    actor?: string;
  }[];
}
export interface Issue {
  id: string;
  title: string;
  status: string;
  issue_type: string;
  labels: string[];
  dependencies: unknown[];
  priority?: number | null;
  assignee?: string;
  created_by?: string;
  description?: string;
  acceptance_criteria?: string;
  design?: string;
  notes?: string;
  created_at?: string;
  updated_at?: string;
  due_at?: string;
  defer_until?: string;
  closed_at?: string;
  close_reason?: string;
  ready?: boolean;
  blocked?: boolean;
  graphContext?: boolean;
  statusEvents?: AuditEvent[];
  statusEventsWarning?: string;
  comments?: Comment[];
  statusTimeline?: StatusTimeline;
}
export interface Activity extends Pick<Issue, 'id' | 'title' | 'status'> {
  actor: string;
  at: string;
  text: string;
}
export interface Snapshot {
  issues: Issue[];
  edges: Edge[];
  activity: Activity[];
  revision: number;
  project: string;
  projectId?: string;
  projectPath?: string;
  demo?: boolean;
  error?: string | null;
  updatedAt?: string | null;
  canCreate?: boolean;
  canEdit?: boolean;
  canRelate?: boolean;
  canReset?: boolean;
  location?: { path?: string };
  hostVersions?: string[];
  beadsVersion?: string;
}
export interface Project {
  id: string;
  name: string;
  cwd: string;
  hostVersions?: string[];
}
export interface PersonActivity {
  key: string;
  issue: string;
  title: string;
  at: string;
  kind: string;
  eventType?: string;
  text?: string;
}
export interface SessionBlock {
  id: string;
  kind: string;
  text: string;
  name?: string;
  status?: string;
  command?: string;
  error?: string;
  time?: { created?: string | number; completed?: string | number };
}
export interface Session {
  sessionID: string;
  title: string;
  status: string;
  connected?: boolean;
  agent?: string;
  linkSource?: string;
  parentSessionID?: string;
  limited?: boolean;
  warnings?: string[];
  blocks?: SessionBlock[];
  diffLimited?: boolean;
  diffs?: {
    file: string;
    additions: number;
    deletions: number;
    patch?: string;
    truncated?: boolean;
  }[];
}
export interface SessionResult {
  sessions: Session[];
  available?: boolean;
  warnings?: string[];
  error?: string;
  activity?: Record<string, Pick<Session, 'sessionID' | 'agent'>[]>;
}
export interface Sort {
  key: string;
  direction: string;
}
export interface ProjectView {
  view?: string;
  onlyReady?: boolean;
  onlyBlocked?: boolean;
  zoom?: number;
  edgeMode?: string;
  graphMode?: string;
  listMode?: string;
  listSort?: Sort;
  graphContext?: boolean;
  filters?: Record<string, string>;
}
export interface EpicView extends Sort {
  search: string;
}
export interface Position {
  node: Issue;
  x: number;
  y: number;
  cycle: boolean;
}

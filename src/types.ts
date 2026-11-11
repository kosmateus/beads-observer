import type { Observer } from './application/observer.js';
import type { statusTimeline } from './domain/status-timeline.js';

export interface Dependency {
  id?: string;
  issue_id?: string;
  depends_on_id?: string;
  type?: string;
  dependency_type?: string;
}
export interface StatusEvent {
  id?: string | number;
  event_type: string;
  new_value?: unknown;
  created_at: string;
  actor?: string;
}
export interface Issue {
  id: string;
  title: string;
  status: string;
  issue_type: string;
  labels: string[];
  dependencies: Dependency[];
  ready?: boolean;
  blocked?: boolean;
  assignee?: string;
  priority?: number;
  description?: string;
  created_at?: string;
  updated_at?: string;
  comments?: Record<string, unknown>[];
  statusEvents?: StatusEvent[];
  statusTimeline?: ReturnType<typeof statusTimeline>;
  [key: string]: unknown;
}
export interface Edge {
  source: string;
  target: string;
  type: string;
}
export interface Location {
  path: string;
  [key: string]: unknown;
}
export interface Snapshot {
  issues: Issue[];
  edges: Edge[];
  location?: Location;
  beadsVersion?: string | null;
}
export interface Activity {
  id: string;
  title: string;
  actor: string;
  at: string;
  text: string;
}
export interface ObserverState extends Snapshot {
  activity: Activity[];
  revision: number;
  project: string;
  demo: boolean;
  error: string | null;
  updatedAt: string | null;
}
export interface IssueDetail {
  id: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}
export interface IssueSource {
  snapshot(): Promise<Snapshot>;
  detail(id: string): Promise<IssueDetail | undefined>;
  activity?(id: string): Promise<IssueDetail>;
}
export interface Draft {
  title: string;
  description: string;
  type: string;
  priority: number;
  parent: string;
}
export interface Update {
  id: string;
  title: string;
  description: string;
  priority: number;
}
export interface Relation {
  issue: string;
  target: string;
  type: string;
}
export interface ResetPreview {
  path: string;
  identity: string;
  mode: string;
  preview: string;
}
export interface Writer {
  create?(draft: Draft): Promise<unknown>;
  update?(draft: Update): Promise<unknown>;
  addRelation?(draft: Relation): Promise<unknown>;
  resetPreview?(): Promise<ResetPreview>;
  reset?(path: string, identity: string, mode: string): Promise<void>;
}
export interface ProjectEntry {
  id: string;
  name: string;
  cwd: string;
  observer: Observer;
  hostVersions?: string[];
  writer?: Writer | null;
}
export interface ProjectOptions {
  cwd?: string;
  project?: string;
  bdPath?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  demo?: boolean;
  source?: IssueSource;
  writer?: Writer;
  hostVersions?: string[];
  opencodeVersion?: string | null;
}
export interface CanonicalProject extends ProjectOptions {
  id: string;
  cwd: string;
  project: string;
  bdPath: string;
  pollIntervalMs: number;
  timeoutMs: number;
}
export interface ServerOptions extends ProjectOptions {
  port?: number;
  empty?: boolean;
  runtimeId?: string;
  sessionDirectory?: string;
  runtimeDirectory?: string;
  nodePath?: string;
  projects?: (ProjectOptions | string)[];
}
export interface SessionMessage {
  id?: string;
  type: string;
  text?: unknown;
  command?: unknown;
  output?: { output?: unknown };
  status?: string;
  exit?: number;
  time?: unknown;
  content?: SessionPart[];
}
export interface SessionPart {
  id?: string;
  type: string;
  text?: unknown;
  time?: unknown;
  name?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    content?: { type: string; text?: string }[];
    error?: string | { message?: string };
  };
}
export interface SessionInfo {
  id: string;
  title?: string;
  agent?: string;
  location?: { directory?: string };
  outcome?: string;
  time?: unknown;
}
export interface SessionDiff {
  file?: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  status?: string;
}
export interface SessionLink {
  issueId?: string;
  ambiguous?: boolean;
  source: string;
}
export interface SessionRecord {
  projectId: string;
  sessionID: string;
  updatedAt: number;
  connected: boolean;
  status: string;
  issueIds?: string[];
  activeIssueId?: string;
  agent?: string;
  [key: string]: unknown;
}
export interface Lease {
  projects: ProjectOptions[];
  updatedAt: number;
  file: string;
}
export interface LeaseResult {
  projectIds: string[];
  errors: string[];
}
export interface HubHealth {
  application: string;
  protocol: number;
  runtimeId: string;
  version: string;
}
export function errorInfo(
  error: unknown,
): Error & { code?: string; status?: number; stderr?: string } {
  return error instanceof Error ? error : new Error(String(error));
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

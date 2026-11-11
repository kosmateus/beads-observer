import type { Plugin } from '@opencode/plugin';
import type { SessionDiff, SessionInfo, SessionMessage } from '../types.js';

/** Compatibility contracts for session methods not exposed by every V2 host. */
export type Activity = Record<string, unknown>;
export type ResponseData<T> = T | { data: T };
export interface RequestOptions {
  signal?: AbortSignal;
}
export interface SessionReference {
  sessionID: string;
}
export interface DiffRequest extends SessionReference {
  context?: number;
}
export interface OpenCodeAPI {
  active(options?: RequestOptions): Promise<ResponseData<Activity>>;
  diff(
    request: DiffRequest,
    options?: RequestOptions,
  ): Promise<ResponseData<SessionDiff[]>>;
}
export interface ObserverSessionInfo extends SessionInfo {
  parentID?: string;
  time?: { updated?: number; [key: string]: unknown };
}
export type SessionCatalog = ResponseData<{ id: string }[]> & {
  cursor?: { next?: string };
};
export interface ObserverContext {
  location?: { project?: { id?: string } };
  storage: Plugin.Context['storage'];
  session: {
    list(options: {
      cursor?: string;
      limit: number;
      project?: string;
      directory?: string;
      order?: 'desc';
    }): Promise<SessionCatalog>;
    get(request: SessionReference): Promise<ResponseData<ObserverSessionInfo>>;
    context(request: SessionReference): Promise<ResponseData<SessionMessage[]>>;
    active?(): Promise<ResponseData<Activity>>;
    diff?(request: DiffRequest): Promise<ResponseData<SessionDiff[]>>;
  };
  event: {
    subscribe(
      options: RequestOptions,
    ): AsyncIterable<string | { type?: string; data?: { sessionID?: string } }>;
  };
}
export interface SessionBridge {
  refresh(): Promise<void | null>;
  bind(sessionID: string, issueId: string): Promise<void>;
  close(): Promise<void>;
}

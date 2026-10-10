import {HttpClient} from '@angular/common/http';
import {Inject, Injectable} from '@angular/core';
import {SPEECHRECORDER_CONFIG, SpeechRecorderConfig} from 'speechrecorderng';
import {Observable} from 'rxjs';
import {normaliseApiEndPoint, projectPath, withQuery} from './api-base';
import type {ListView} from './validation/types';

/** One row of the list-source library (rest-api.md §3.5). */
export interface ListSummary {
  listId: string | number;
  name: string;
  lists: number;
  entries: number;
  /** Each list's id and size: what E12, E15 and W14 need, without every entry. */
  shape: ReadonlyArray<{id: string; entries: number}>;
  legacy: boolean;
  usedBy: ReadonlyArray<{scriptId: string | number; draft?: boolean; version?: number}>;
}

/**
 * The list-source library, read-only (rest-api.md §3.5): the lists a `prefill.source` placeholder draws
 * from. The checks read the library once per screen; the receiver does the drawing.
 */
@Injectable()
export class ListApiService {
  private readonly base: string;
  private readonly withCredentials: boolean;

  constructor(private readonly http: HttpClient,
              @Inject(SPEECHRECORDER_CONFIG) private readonly config?: SpeechRecorderConfig) {
    this.base = normaliseApiEndPoint(config);
    this.withCredentials = config?.withCredentials ?? false;
  }

  /** `GET project/{p}/list`. */
  list(projectId: string): Observable<ListSummary[]> {
    return this.http.get<ListSummary[]>(withQuery(projectPath(this.base, projectId, 'list'), this.config),
      {withCredentials: this.withCredentials});
  }
}

/** The lookup the checks take: a missing row is "does not exist", an unreadable library is "unknown". */
export function listLookupOf(library: ReadonlyArray<ListSummary> | null): (listId: string) => ListView | null | undefined {
  return (listId: string) => {
    if (library === null) {
      return undefined;
    }
    const row = library.find((entry) => String(entry.listId) === listId);
    return row === undefined ? null : {listId, lists: row.shape ?? []};
  };
}

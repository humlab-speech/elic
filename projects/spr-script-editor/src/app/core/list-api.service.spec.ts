import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {SPEECHRECORDER_CONFIG} from 'speechrecorderng';
import {ListApiService, listLookupOf, type ListSummary} from './list-api.service';

const ROW: ListSummary = {listId: 'sti', name: 'STI', lists: 2, entries: 5, shape: [{id: '1', entries: 3}, {id: '2', entries: 2}], legacy: false, usedBy: []};

describe('ListApiService', () => {
  it('reads the library from project/{p}/list', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ListApiService,
        {provide: SPEECHRECORDER_CONFIG, useValue: {apiEndPoint: 'api/v1', apiVersion: 2}}],
    });
    const http = TestBed.inject(HttpTestingController);
    let rows: ListSummary[] = [];
    TestBed.inject(ListApiService).list('Demo1').subscribe((value) => (rows = value));
    const request = http.expectOne((req) => req.url.includes('project/Demo1/list'));
    expect(request.request.method).toBe('GET');
    request.flush([ROW]);
    expect(rows).toEqual([ROW]);
    http.verify();
  });
});

describe('listLookupOf', () => {
  it('answers a row, "does not exist" and "unknown"', () => {
    expect(listLookupOf([ROW])('sti')).toEqual({listId: 'sti', lists: ROW.shape});
    expect(listLookupOf([ROW])('other')).toBeNull();
    expect(listLookupOf(null)('sti')).toBeUndefined();
  });
});

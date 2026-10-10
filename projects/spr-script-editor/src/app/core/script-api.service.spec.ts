import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {ApiType, SPEECHRECORDER_CONFIG, SpeechRecorderConfig} from 'speechrecorderng';
import {ScriptApiService} from './script-api.service';

function setup(config: SpeechRecorderConfig) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      {provide: SPEECHRECORDER_CONFIG, useValue: config},
      ScriptApiService,
    ],
  });
  return {
    service: TestBed.inject(ScriptApiService),
    http: TestBed.inject(HttpTestingController),
  };
}

/** `HttpRequest.url` keeps the query string; match on the path and parse the query separately. */
function pathOf(urlWithParams: string): string {
  return urlWithParams.split('?')[0];
}

function queryOf(urlWithParams: string): URLSearchParams {
  return new URLSearchParams(urlWithParams.split('?')[1] ?? '');
}

describe('ScriptApiService', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('builds the library list URL and the FILES-mode suffix in development', () => {
    const {service, http} = setup({apiEndPoint: 'test', apiType: ApiType.FILES, apiVersion: 1, withCredentials: true});

    service.list('Demo1').subscribe();

    const request = http.expectOne((req) => pathOf(req.urlWithParams) === 'test/project/Demo1/script.json');
    expect(queryOf(request.request.urlWithParams).has('requestUUID')).toBe(true);
    expect(request.request.withCredentials).toBe(true);
    request.flush([]);
  });

  it('builds the same paths relative to the REST base in production', () => {
    const {service, http} = setup({apiEndPoint: 'api/v1', apiType: ApiType.NORMAL, apiVersion: 1, withCredentials: true});

    service.list('Demo1').subscribe();
    service.version().subscribe();
    service.getScript(1245).subscribe();

    const list = http.expectOne((req) => pathOf(req.urlWithParams) === 'api/v1/project/Demo1/script');
    expect(queryOf(list.request.urlWithParams).toString()).toBe('');
    list.flush([]);

    http.expectOne((req) => pathOf(req.urlWithParams) === 'api/v1/version').flush({recorderVersion: '3.11.26'});
    http.expectOne((req) => pathOf(req.urlWithParams) === 'api/v1/script/1245').flush({sections: []});
  });

  it('reads one script from the fixtures in FILES mode', () => {
    const {service, http} = setup({apiEndPoint: 'test', apiType: ApiType.FILES, apiVersion: 1});

    service.getScript(1245).subscribe();

    const request = http.expectOne((req) => pathOf(req.urlWithParams) === 'test/script/1245.json');
    // The `.json` suffix above is the path half of the FILES contract; `requestUUID` is the other half, and
    // this is the only spec that exercises this call site (`list` covers it for the library list). Without
    // this the spec had no expectation of its own: it could only fail on the URL matcher.
    expect(queryOf(request.request.urlWithParams).has('requestUUID')).toBe(true);
    request.flush({scriptId: 1245, sections: []});
  });

  it('publishes the draft with its ETag and note', () => {
    const {service, http} = setup({apiEndPoint: 'api/v1', apiType: ApiType.NORMAL, apiVersion: 1, withCredentials: true});
    const emitted: unknown[] = [];

    service.publish('Demo1', 1245, {fromDraftEtag: '"A"', note: 'added repetition'}).subscribe((value) => emitted.push(value));

    const request = http.expectOne((req) => pathOf(req.urlWithParams) === 'api/v1/project/Demo1/script/1245/publish');
    expect(request.request.method).toBe('POST');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body).toEqual({fromDraftEtag: '"A"', note: 'added repetition'});
    expect(request.request.headers.get('Idempotency-Key'))
      .toBe('publish:1245:%22A%22:added%20repetition');
    request.flush({version: 4, publishedDate: '2026-10-03T10:00:00Z', minRecorderVersion: '3.12'});

    expect(emitted).toEqual([{version: 4, publishedDate: '2026-10-03T10:00:00Z', minRecorderVersion: '3.12'}]);
  });

  it('derives the publish key from the intent, so a retry of the same publish reuses it', () => {
    const {service, http} = setup({apiEndPoint: 'api/v1', apiType: ApiType.NORMAL, apiVersion: 1});
    const keyOf = (scriptId: number, body: {fromDraftEtag: string; note?: string}): string => {
      service.publish('Demo1', scriptId, body).subscribe();
      const request = http.expectOne((req) => pathOf(req.urlWithParams).endsWith(`/script/${scriptId}/publish`));
      request.flush({version: 1, publishedDate: '2026-10-08T00:00:00Z'});
      const key = request.request.headers.get('Idempotency-Key');
      if (key === null) {
        throw new Error('the publish request carried no Idempotency-Key');
      }
      return key;
    };

    const first = keyOf(1245, {fromDraftEtag: '"A"', note: 'n'});
    // The same intent: the operator's second click after a response they never saw. The server answers
    // the version it already froze rather than freezing another (rest-api §1.3).
    expect(keyOf(1245, {fromDraftEtag: '"A"', note: 'n'})).toBe(first);
    // A different draft, note or script is a different publish, and must not replay the first one.
    expect(keyOf(1245, {fromDraftEtag: '"B"', note: 'n'})).not.toBe(first);
    expect(keyOf(1245, {fromDraftEtag: '"A"', note: 'other'})).not.toBe(first);
    expect(keyOf(999, {fromDraftEtag: '"A"', note: 'n'})).not.toBe(first);
    // A missing note is the same intent as an empty one...
    expect(keyOf(1245, {fromDraftEtag: '"A"'})).toBe(keyOf(1245, {fromDraftEtag: '"A"', note: ''}));
    // ...and a note with a newline, a quote or non-ASCII stays a legal header value.
    const awkward = keyOf(1245, {fromDraftEtag: '"A"', note: 'line\nbreak "quoted" ünïcode'});
    expect(awkward).not.toContain('\n');
    expect(awkward).toContain('%C3%BC');

    // A note pasted at length is folded to a hash rather than inlined: a key is a header, and an
    // inlined 20 kB note made the receiver answer 431 before the route ran, where the same note in the
    // body published fine. The key must stay short, and still differ between long notes.
    const long = 'x'.repeat(5000);
    const longKey = keyOf(1245, {fromDraftEtag: '"A"', note: long});
    expect(longKey.length).toBeLessThan(80);
    expect(longKey).not.toContain('x'.repeat(10));
    expect(longKey).toBe(keyOf(1245, {fromDraftEtag: '"A"', note: long}), 'the same long note is the same intent');
    expect(longKey).not.toBe(keyOf(1245, {fromDraftEtag: '"A"', note: `${long}y`}), 'a different one is not');
    // The boundary itself is exact on both sides.
    const atLimit = 'y'.repeat(200);
    expect(keyOf(1245, {fromDraftEtag: '"A"', note: atLimit})).toContain(atLimit);
    expect(keyOf(1245, {fromDraftEtag: '"A"', note: `${atLimit}y`})).not.toContain('yyyy');
  });

  it('lists versions and reads one version', () => {
    const {service, http} = setup({apiEndPoint: 'api/v1', apiType: ApiType.NORMAL, apiVersion: 1});

    service.versions('Demo1', 1245).subscribe();
    const list = http.expectOne((req) => pathOf(req.urlWithParams) === 'api/v1/project/Demo1/script/1245/version');
    expect(list.request.method).toBe('GET');
    list.flush([{version: 3, publishedDate: '2026-10-02T10:00:00Z', note: ''}]);

    service.publishedVersion('Demo1', 1245, 3).subscribe();
    const one = http.expectOne((req) => pathOf(req.urlWithParams) === 'api/v1/project/Demo1/script/1245/version/3');
    expect(one.request.method).toBe('GET');
    one.flush({scriptId: 1245, sections: []});
  });

  it('restores a version with If-Match, then reads the new draft for its bytes', () => {
    const {service, http} = setup({apiEndPoint: 'api/v1', apiType: ApiType.NORMAL, apiVersion: 1});
    const emitted: Array<{text: string; etag: string | null}> = [];

    service.restoreVersion('Demo1', 1245, 3, '"A"').subscribe((value) => emitted.push(value));

    const restore = http.expectOne((req) => pathOf(req.urlWithParams) === 'api/v1/project/Demo1/script/1245/draft/_restore');
    expect(restore.request.method).toBe('POST');
    expect(restore.request.headers.get('If-Match')).toBe('"A"');
    expect(restore.request.body).toEqual({version: 3});
    restore.flush({scriptId: 1245, draftVersion: 9, etag: '"B"'});

    const read = http.expectOne((req) => pathOf(req.urlWithParams) === 'api/v1/project/Demo1/script/1245/draft');
    expect(read.request.method).toBe('GET');
    read.flush('{"name":"restored","sections":[]}', {headers: {ETag: '"B"'}});

    expect(emitted).toEqual([{text: '{"name":"restored","sections":[]}', etag: '"B"'}]);
  });

  it('creates a draft with If-None-Match: *, then reads its bytes', () => {
    const {service, http} = setup({apiEndPoint: 'api/v1', apiType: ApiType.NORMAL, apiVersion: 1});
    const emitted: Array<{text: string; etag: string | null}> = [];
    const body = '{"name":"migrated","sections":[]}';

    // The create form: a script with published versions and no draft (a migrated one) cannot use
    // If-Match, because the ETag it would name does not exist.
    service.createDraft('Demo1', 1, body).subscribe((value) => emitted.push(value));

    const create = http.expectOne((req) => pathOf(req.urlWithParams) === 'api/v1/project/Demo1/script/1/draft');
    expect(create.request.method).toBe('PUT');
    expect(create.request.headers.get('If-None-Match')).toBe('*');
    expect(create.request.headers.has('If-Match')).toBe(false);
    expect(create.request.body).toBe(body);
    create.flush({scriptId: 1, draftVersion: 1, etag: '"A"'});

    const read = http.expectOne((req) => pathOf(req.urlWithParams) === 'api/v1/project/Demo1/script/1/draft');
    expect(read.request.method).toBe('GET');
    read.flush(body, {headers: {ETag: '"A"'}});

    expect(emitted).toEqual([{text: body, etag: '"A"'}]);
  });

  it('patches script metadata and creates/duplicates scripts', () => {
    const {service, http} = setup({apiEndPoint: 'api/v1', apiType: ApiType.NORMAL, apiVersion: 1});

    service.patchScript('Demo1', 1245, {name: 'Read speech', archived: true}).subscribe();
    const patch = http.expectOne((req) => pathOf(req.urlWithParams) === 'api/v1/project/Demo1/script/1245');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({name: 'Read speech', archived: true});
    patch.flush({});

    service.createScript('Demo1', {name: 'New'}).subscribe();
    const create = http.expectOne((req) => pathOf(req.urlWithParams) === 'api/v1/project/Demo1/script');
    expect(create.request.method).toBe('POST');
    expect(create.request.body).toEqual({name: 'New'});
    create.flush({scriptId: '2000', draftVersion: 1, etag: '"0-0"'});

    service.duplicate('Demo1', {scriptId: 1245, version: 2}).subscribe();
    const duplicate = http.expectOne((req) => pathOf(req.urlWithParams) === 'api/v1/project/Demo1/script');
    expect(duplicate.request.body).toEqual({from: {scriptId: 1245, version: 2}});
    duplicate.flush({scriptId: '2001', draftVersion: 1, etag: '"0-0"'});
  });

  it('derives minRecorderVersion from the library feature table', () => {
    const {service} = setup({apiEndPoint: 'api/v1', apiType: ApiType.NORMAL, apiVersion: 1});

    expect(service.minRecorderVersion({sections: []})).toBeNull();
    const withPrefill = {
      sections: [{groups: [{promptItems: [{prefill: {source: 'list'}}]}]}],
    };
    expect(service.minRecorderVersion(withPrefill)).toBe('3.11.27');
  });
});

import {TestBed} from '@angular/core/testing';
import {HttpClient, provideHttpClient} from "@angular/common/http";
import {HttpTestingController, provideHttpClientTesting} from "@angular/common/http/testing";
import {
    Upload,
    UploadConfig,
    Uploader,
    UploaderStatus,
    UploaderStatusChangeEvent,
    UploadSet,
    UploadStatus
} from "./uploader";
import {SprDb} from "../db/inddb";

// Uploader uses window.setTimeout for retries. Tests run with real timers and small
// retry delays (20ms base, 40ms cap) plus generous wait margins.
function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Uploader', () => {
    let http: HttpClient;
    let httpMock: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [provideHttpClient(), provideHttpClientTesting()]
        });
        http = TestBed.inject(HttpClient);
        httpMock = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        httpMock.verify();
    });

    function uploader(cfg: UploadConfig = {}): Uploader {
        const upl = new Uploader(http, false, cfg);
        upl.DEBUG_DELAY = 0;
        return upl;
    }

    function collectEvents(upl: Uploader): Array<UploaderStatusChangeEvent> {
        const events = new Array<UploaderStatusChangeEvent>();
        upl.listener = (ue) => events.push(ue);
        return events;
    }

    function blob(size: number): Blob {
        return new Blob([new Uint8Array(size)]);
    }

    function networkError(): ProgressEvent {
        return new ProgressEvent('network');
    }

    /**
     * Empties the persisted upload queue. `indexedDB.deleteDatabase` is not usable here: the
     * application keeps its SprDb connection open, and a drop request blocks until every
     * connection closes, so its `onsuccess` never fires.
     */
    async function clearPersistedQueue(): Promise<void> {
        await new Promise<void>((resolve) => {
            SprDb.prepare().subscribe({
                next: (db) => {
                    try {
                        const tr = db.transaction(SprDb.UPLOAD_QUEUE_OBJECT_STORE_NAME, 'readwrite');
                        tr.objectStore(SprDb.UPLOAD_QUEUE_OBJECT_STORE_NAME).clear();
                        tr.oncomplete = () => resolve();
                        tr.onabort = () => resolve();
                        tr.onerror = () => resolve();
                    } catch {
                        // no queue store yet: nothing persisted, nothing to clear
                        resolve();
                    }
                },
                error: () => resolve(),
            });
        });
    }

    it('marks server persisted and reports DONE on a successful upload', () => {
        const upl = uploader();
        const events = collectEvents(upl);
        const serverPersistable = {serverPersisted: false};
        const ul = new Upload(blob(10), '/api/up', serverPersistable);
        upl.queueUpload(ul);
        const req = httpMock.expectOne('/api/up');
        expect(req.request.headers.get('Idempotency-Key')).toBe(ul.idempotencyKey);
        req.flush({});
        expect(ul.status).toBe(UploadStatus.DONE);
        expect(serverPersistable.serverPersisted).toBe(true);
        expect(events[events.length - 1].status).toBe(UploaderStatus.DONE);
        expect(events[events.length - 1].failedCount).toBe(0);
    });

    it('accepts any 2xx response by default (no strict ack)', () => {
        const upl = uploader();
        const ul = new Upload(blob(10), '/api/up');
        upl.queueUpload(ul);
        httpMock.expectOne('/api/up').flush('ignored body');
        expect(ul.status).toBe(UploadStatus.DONE);
    });

    it('requires {stored:true} response body when requireStoredAck is set', () => {
        const upl = uploader({requireStoredAck: true});
        const events = collectEvents(upl);
        const ul = new Upload(blob(10), '/api/up');
        upl.queueUpload(ul);
        httpMock.expectOne('/api/up').flush({stored: false});
        expect(ul.status).toBe(UploadStatus.FAILED);
        expect(events[events.length - 1].status).toBe(UploaderStatus.PARTIAL);
        expect(events[events.length - 1].failedCount).toBe(1);
    });

    it('succeeds with strict ack when the server confirms storage', () => {
        const upl = uploader({requireStoredAck: true});
        const ul = new Upload(blob(10), '/api/up');
        upl.queueUpload(ul);
        httpMock.expectOne('/api/up').flush({stored: true});
        expect(ul.status).toBe(UploadStatus.DONE);
    });

    it('retries after a network error with the same idempotency key', async () => {
        const upl = uploader({baseRetryDelayMs: 20, jitterRatio: 0});
        const ul = new Upload(blob(10), '/api/up');
        upl.queueUpload(ul);
        const first = httpMock.expectOne('/api/up');
        const firstKey = first.request.headers.get('Idempotency-Key');
        first.error(networkError());
        expect(ul.status).toBe(UploadStatus.ERR);
        await wait(10);
        httpMock.expectNone('/api/up');
        await wait(60);
        const retry = httpMock.expectOne('/api/up');
        expect(retry.request.headers.get('Idempotency-Key')).toBe(firstKey);
        retry.flush({});
        expect(ul.status).toBe(UploadStatus.DONE);
    });

    it('applies exponential backoff capped at maxRetryDelayMs', async () => {
        const upl = uploader({baseRetryDelayMs: 20, maxRetryDelayMs: 40, jitterRatio: 0});
        const ul = new Upload(blob(10), '/api/up');
        upl.queueUpload(ul);
        // attempt 1 fails
        httpMock.expectOne('/api/up').error(networkError());
        // delay 20ms
        await wait(60);
        httpMock.expectOne('/api/up').error(networkError());
        // delay 40ms (capped)
        await wait(100);
        httpMock.expectOne('/api/up').error(networkError());
        // drain the pending retry (capped 40ms) to keep the queue idle
        await wait(100);
        const fourth = httpMock.expectOne('/api/up');
        fourth.flush({});
        expect(ul.attemptCount).toBe(4);
    });

    it('stops retrying after maxAttempts and reports PARTIAL', async () => {
        const upl = uploader({maxAttempts: 3, baseRetryDelayMs: 20, jitterRatio: 0});
        const events = collectEvents(upl);
        const ul = new Upload(blob(10), '/api/up');
        upl.queueUpload(ul);
        httpMock.expectOne('/api/up').error(networkError());
        await wait(60);
        httpMock.expectOne('/api/up').error(networkError());
        await wait(60);
        httpMock.expectOne('/api/up').error(networkError());
        expect(ul.status).toBe(UploadStatus.FAILED);
        // no further retries
        await wait(150);
        httpMock.expectNone('/api/up');
        expect(events[events.length - 1].status).toBe(UploaderStatus.PARTIAL);
        expect(events[events.length - 1].failedCount).toBe(1);
    });

    it('fails terminally on 4xx without retrying and surfaces the server message', async () => {
        const upl = uploader();
        const events = collectEvents(upl);
        const serverPersistable = {serverPersisted: false};
        const ul = new Upload(blob(10), '/api/up', serverPersistable);
        upl.queueUpload(ul);
        httpMock.expectOne('/api/up').flush({error: 'unknown recording id'}, {status: 404, statusText: 'Not Found'});
        expect(ul.status).toBe(UploadStatus.FAILED);
        expect(serverPersistable.serverPersisted).toBe(false);
        // no retry timer scheduled
        await wait(150);
        httpMock.expectNone('/api/up');
        const lastEvent = events[events.length - 1];
        expect(lastEvent.status).toBe(UploaderStatus.PARTIAL);
        expect(lastEvent.lastError?.message).toContain('unknown recording id');
        expect(lastEvent.lastError?.terminal).toBe(true);
    });

    it('retries on 429 and 5xx responses', async () => {
        const upl = uploader({baseRetryDelayMs: 20, jitterRatio: 0});
        const ul = new Upload(blob(10), '/api/up');
        upl.queueUpload(ul);
        httpMock.expectOne('/api/up').flush({}, {status: 429, statusText: 'Too Many Requests'});
        await wait(60);
        httpMock.expectOne('/api/up').flush({}, {status: 503, statusText: 'Unavailable'});
        expect(ul.status).toBe(UploadStatus.ERR);
        // drain the pending retry
        await wait(60);
        httpMock.expectOne('/api/up').flush({});
        expect(ul.status).toBe(UploadStatus.DONE);
    });

    it('continues with the next upload after a terminal failure', () => {
        const upl = uploader();
        const events = collectEvents(upl);
        const failUl = new Upload(blob(10), '/api/fail');
        const okUl = new Upload(blob(10), '/api/ok');
        upl.queueUpload(failUl);
        upl.queueUpload(okUl);
        httpMock.expectOne('/api/fail').flush({error: 'bad'}, {status: 400, statusText: 'Bad Request'});
        httpMock.expectOne('/api/ok').flush({});
        expect(failUl.status).toBe(UploadStatus.FAILED);
        expect(okUl.status).toBe(UploadStatus.DONE);
        const lastEvent = events[events.length - 1];
        expect(lastEvent.status).toBe(UploaderStatus.PARTIAL);
        expect(lastEvent.failedCount).toBe(1);
    });

    it('retries failed uploads after retryFailedUploads()', () => {
        const upl = uploader();
        const events = collectEvents(upl);
        const ul = new Upload(blob(10), '/api/up');
        upl.queueUpload(ul);
        httpMock.expectOne('/api/up').flush({error: 'bad'}, {status: 404, statusText: 'Not Found'});
        expect(ul.status).toBe(UploadStatus.FAILED);
        upl.retryFailedUploads();
        httpMock.expectOne('/api/up').flush({});
        expect(ul.status).toBe(UploadStatus.DONE);
        expect(events[events.length - 1].status).toBe(UploaderStatus.DONE);
    });

    it('counts FormData string parts towards the queued size', () => {
        const upl = uploader();
        const events = collectEvents(upl);
        const fd = new FormData();
        fd.set('uuid', '1234567890');
        fd.set('chunkCount', '12');
        upl.queueUpload(new Upload(fd, '/api/prepare'));
        expect(events[events.length - 1].sizeQueued).toBeGreaterThan(0);
        httpMock.expectOne('/api/prepare').flush({});
    });

    it('does not double-schedule a retry when the listener re-enters the queue', async () => {
        const upl = uploader({baseRetryDelayMs: 20, jitterRatio: 0});
        const ul = new Upload(blob(10), '/api/up');
        const second = new Upload(blob(10), '/api/second');
        upl.listener = (ue) => {
            if (ue.status === UploaderStatus.ERR && second.status === UploadStatus.IDLE) {
                upl.queueUpload(second);
            }
        };
        upl.queueUpload(ul);
        httpMock.expectOne('/api/up').error(networkError());
        // the re-entrant queueUpload started the second upload
        httpMock.expectOne('/api/second').flush({});
        // the failed upload is retried exactly once when processing continues
        httpMock.expectOne('/api/up').flush({});
        await wait(150);
        httpMock.expectNone('/api/up');
        httpMock.expectNone('/api/second');
        // The request sequence above is what the spec is named for — a second retry would leave a pending
        // request for `expectNone` to catch. What it never asserted is the outcome that sequence implies:
        // both uploads reached DONE, rather than the requests having gone out and a status stuck mid-flight.
        expect(ul.status).toBe(UploadStatus.DONE);
        expect(second.status).toBe(UploadStatus.DONE);
    });

    it('stays sequential by default (one request in flight)', () => {
        const upl = uploader();
        const first = new Upload(blob(10), '/api/first');
        const second = new Upload(blob(10), '/api/second');
        upl.queueUpload(first);
        upl.queueUpload(second);
        httpMock.expectNone('/api/second');
        httpMock.expectOne('/api/first').flush({});
        httpMock.expectOne('/api/second').flush({});
        expect(first.status).toBe(UploadStatus.DONE);
        expect(second.status).toBe(UploadStatus.DONE);
    });

    it('uploads concurrently up to maxConcurrentUploads', () => {
        const upl = uploader({maxConcurrentUploads: 2});
        const events = collectEvents(upl);
        const first = new Upload(blob(10), '/api/first');
        const second = new Upload(blob(10), '/api/second');
        const third = new Upload(blob(10), '/api/third');
        upl.queueUpload(first);
        upl.queueUpload(second);
        upl.queueUpload(third);
        // capacity 2: the third upload waits
        httpMock.expectNone('/api/third');
        // completing one frees capacity for the third
        httpMock.expectOne('/api/first').flush({});
        httpMock.expectOne('/api/third').flush({});
        httpMock.expectOne('/api/second').flush({});
        expect(first.status).toBe(UploadStatus.DONE);
        expect(second.status).toBe(UploadStatus.DONE);
        expect(third.status).toBe(UploadStatus.DONE);
        expect(events[events.length - 1].status).toBe(UploaderStatus.DONE);
    });

    it('reports DONE only when the queue is empty and nothing is in flight', () => {
        const upl = uploader({maxConcurrentUploads: 3});
        const events = collectEvents(upl);
        upl.queueUpload(new Upload(blob(10), '/api/first'));
        upl.queueUpload(new Upload(blob(10), '/api/second'));
        // first completes while second is still in flight: no DONE yet
        httpMock.expectOne('/api/first').flush({});
        expect(events[events.length - 1].status).not.toBe(UploaderStatus.DONE);
        httpMock.expectOne('/api/second').flush({});
        expect(events[events.length - 1].status).toBe(UploaderStatus.DONE);
    });

    it('persists blob uploads and restores them with the same key after a reload', async () => {
        // clean state
        await clearPersistedQueue();
        // first uploader: upload fails terminally (maxAttempts 1), entry stays persisted
        const upl1 = uploader({persistQueue: true, maxAttempts: 1});
        const ul1 = new Upload(blob(10), '/api/persisted');
        upl1.queueUpload(ul1);
        const req1 = httpMock.expectOne('/api/persisted');
        const key = req1.request.headers.get('Idempotency-Key');
        req1.error(networkError());
        expect(ul1.status).toBe(UploadStatus.FAILED);
        // wait for the persistence put to commit
        await wait(50);
        // simulate a reload: a fresh uploader restores the persisted upload
        const upl2 = uploader({persistQueue: true});
        let restored = -1;
        await new Promise<void>((resolve) => {
            upl2.restorePersistedUploads().subscribe({next: (n) => { restored = n; }, complete: () => resolve()});
        });
        expect(restored).toBe(1);
        // the restored upload re-posts with the SAME idempotency key
        const req2 = httpMock.expectOne('/api/persisted');
        expect(req2.request.headers.get('Idempotency-Key')).toBe(key);
        req2.flush({});
        // wait for the persisted entry removal on success
        await wait(50);
        // a third uploader must not restore anything anymore
        const upl3 = uploader({persistQueue: true});
        let restored2 = -1;
        await new Promise<void>((resolve) => {
            upl3.restorePersistedUploads().subscribe({next: (n) => { restored2 = n; }, complete: () => resolve()});
        });
        expect(restored2).toBe(0);
        await clearPersistedQueue();
    });

    it('persists a FormData control request and restores it with its fields', async () => {
        await clearPersistedQueue();
        const upl1 = uploader({persistQueue: true, maxAttempts: 1});
        const form = new FormData();
        form.append('uuid', 'u-1');
        form.append('chunkCount', '3');
        upl1.queueUpload(new Upload(form, '/api/concat'));
        httpMock.expectOne('/api/concat').error(networkError());
        await wait(50);
        const upl2 = uploader({persistQueue: true});
        await new Promise<void>((resolve) => {
            upl2.restorePersistedUploads().subscribe({complete: () => resolve()});
        });
        const req = httpMock.expectOne('/api/concat');
        const body = req.request.body as FormData;
        expect(body.get('uuid')).toBe('u-1');
        expect(body.get('chunkCount')).toBe('3');
        req.flush({});
        await wait(50);
        await clearPersistedQueue();
    });

    it('retries uploads that gave up on transient errors, but not terminal ones', () => {
        const upl = uploader({maxAttempts: 1});
        const transient = new Upload(blob(10), '/api/transient');
        const terminal = new Upload(blob(10), '/api/terminal');
        upl.queueUpload(transient);
        httpMock.expectOne('/api/transient').error(networkError());
        upl.queueUpload(terminal);
        httpMock.expectOne('/api/terminal').flush('gone', {status: 404, statusText: 'Not Found'});
        expect(transient.status).toBe(UploadStatus.FAILED);
        expect(terminal.status).toBe(UploadStatus.FAILED);
        upl.retryTransientFailedUploads();
        httpMock.expectOne('/api/transient').flush({});
        httpMock.expectNone('/api/terminal');
        expect(transient.status).toBe(UploadStatus.DONE);
        expect(terminal.status).toBe(UploadStatus.FAILED);
    });

    it('fires onDone assigned after complete() once all uploads are done (late assignment)', () => {
        const upl = uploader();
        const set = new UploadSet();
        const ul = new Upload(blob(10), '/api/up');
        set.add(ul);
        set.complete();
        upl.queueUpload(ul);
        httpMock.expectOne('/api/up').flush({});
        // onDone assigned only after the upload already succeeded
        let doneCalled = 0;
        set.onDone = () => { doneCalled++; };
        expect(doneCalled).toBe(1);
    });

    it('fires onFail instead of onDone when a member upload fails terminally', () => {
        const upl = uploader();
        const set = new UploadSet();
        let doneCalled = 0;
        let failCalled = 0;
        set.onDone = () => { doneCalled++; };
        set.onFail = () => { failCalled++; };
        const ul = new Upload(blob(10), '/api/up');
        set.add(ul);
        set.complete();
        upl.queueUpload(ul);
        httpMock.expectOne('/api/up').flush({error: 'bad'}, {status: 404, statusText: 'Not Found'});
        expect(failCalled).toBe(1);
        expect(doneCalled).toBe(0);
    });
});

import { HttpClient, HttpErrorResponse, HttpHeaders } from "@angular/common/http";
import { timeout } from 'rxjs/operators'
import {Observable} from "rxjs";
import {UUID} from "../utils/utils";
import {SprLogger} from "../utils/logger";
import {SprDb} from "../db/inddb";

// state of an upload
export enum UploadStatus {IDLE = 1, UPLOADING = 2,  ABORT = 3, DONE = 0, ERR = -1, FAILED = -2}

// state of the uploader
// TRY_UPLOADING is uploading state after an error (for example if disconnected from server)
// PARTIAL is set when the queue has no startable upload, but at least one upload has terminally failed
export enum UploaderStatus { DONE = 0, UPLOADING = 1, TRY_UPLOADING = 2,NEXT = 3, ERR = -1, PARTIAL = 4}

// normalized description of a failed upload attempt
export interface UploadError {
    // HTTP status code; 0 for network errors, timeouts and other client side errors
    status: number;
    // normalized error message (server response body or exception message), truncated
    message: string;
    // true, if the upload must not be retried anymore
    terminal: boolean;
}

// upload configuration with sensible defaults
export interface UploadConfig {
    // total POST attempts incl. the first one. Default: 8
    maxAttempts?: number;
    // retry delay for the first retry in ms. Default: 1000
    baseRetryDelayMs?: number;
    // cap for the exponential retry delay in ms. Default: 60000
    maxRetryDelayMs?: number;
    // relative jitter applied to the retry delay (0..0.5). Default: 0.25
    jitterRatio?: number;
    // If true, a successful response body must be JSON with {stored:true} to count as stored. Default: false
    requireStoredAck?: boolean;
    // HTTP header name carrying the idempotency key. Default: 'Idempotency-Key'
    idempotencyHeader?: string;
    // Maximum number of POST requests in flight. Default: 1 (sequential).
    // When >1 the server must tolerate uploads arriving out of order, e.g. chunk POSTs
    // being in flight while the prepare request is still being processed.
    maxConcurrentUploads?: number;
    // If true, check via GET whether the server already holds a chunk before uploading it.
    // The server must answer GET {chunkUrl}/{chunkIdx} with 2xx (stored) or 404 (not stored).
    // Enables safe re-upload after a crash or reload. Default: false
    checkStoredChunkBeforeUpload?: boolean;
    // If true, persist uploads (audio Blobs and prepare/concat requests) to IndexedDB before POSTing and remove them on success.
    // Restore with Uploader.restorePersistedUploads() after a page reload. Default: true
    persistQueue?: boolean;
}

export const DEFAULT_UPLOAD_CONFIG: Required<UploadConfig> = {
    maxAttempts: 8,
    baseRetryDelayMs: 1000,
    maxRetryDelayMs: 60000,
    jitterRatio: 0.25,
    requireStoredAck: false,
    idempotencyHeader: 'Idempotency-Key',
    maxConcurrentUploads: 1,
    checkStoredChunkBeforeUpload: false,
    persistQueue: true
};

export class UploaderStatusChangeEvent {
    private readonly _sizeQueued:number;
    private readonly _sizeDone:number;
    private readonly _status: UploaderStatus;
    // number of terminally failed uploads currently in the queue
    readonly failedCount:number;
    // error of the first terminally failed upload, if any
    readonly lastError:UploadError|null;


    constructor(sizeQueued: number, sizeDone: number, status: UploaderStatus, failedCount: number = 0, lastError: UploadError|null = null) {
        this._sizeQueued = sizeQueued;
        this._sizeDone = sizeDone;
        this._status = status;
        this.failedCount = failedCount;
        this.lastError = lastError;
    }

    get sizeQueued():number {
        return this._sizeQueued;
    }

    get sizeDone():number {
        return this._sizeDone;
    }

    sizeInQueue(){
        return this._sizeQueued-this._sizeDone;
    }

    get status(): UploaderStatus {
        return this._status;
    }

    uploadDone(): boolean {
        return (this._sizeDone >= this._sizeQueued);
    }

    percentDone(): number {
        if (this._sizeQueued == 0) {
            // no data queued, we are "done"
            return 100;
        }
        let percent = Math.floor(this._sizeDone * 100 / this._sizeQueued);
        //console.log("Upload status: queued: "+this._sizeQueued+", done: "+this._sizeDone+", "+percent+"%")
        return percent;
    }

}

export interface ServerPersistable{
    serverPersisted:boolean;
}

export interface PersistedUploadEntry {
    idempotencyKey: string;
    url: string;
    // audio payload; absent for a control request (prepare/concat), which persists its fields instead
    blob?: Blob;
    // when it was queued; restores in this order (prepare, chunks, concat)
    queuedAt?: number;
    form?: Array<[string, string | Blob]>;
}

function isPersistedUploadEntry(value: unknown): value is PersistedUploadEntry {
    return value !== null && typeof value === 'object'
        && 'idempotencyKey' in value && typeof value.idempotencyKey === 'string'
        && 'url' in value && typeof value.url === 'string'
        && (('blob' in value && value.blob instanceof Blob)
            || ('form' in value && Array.isArray(value.form)));
}

export class Upload {

    get serverPersistable(): ServerPersistable | null {
        return this._serverPersistable;
    }

    private readonly _data:Blob|FormData;
    private readonly _url:string;

    status: UploadStatus;
    onDone:((upload:Upload)=>void) | null=null;
    onFail:((upload:Upload)=>void) | null=null;

    // idempotency key: sent with every POST attempt of this upload, identical across retries
    readonly idempotencyKey: string;
    // number of POST attempts already performed
    attemptCount: number=0;
    // error of the last failed attempt, if any
    lastError: UploadError|null=null;

    constructor(blob:Blob|FormData, url:string,private _serverPersistable:ServerPersistable|null=null, idempotencyKey?:string) {
        this._data = blob;
        this._url = url;
        this.status = UploadStatus.IDLE;
        this.idempotencyKey= idempotencyKey !== undefined ? idempotencyKey
            : ((typeof crypto!=='undefined' && typeof crypto.randomUUID==='function')?crypto.randomUUID():UUID.generate());
    }

    get url():string {
        return this._url;
    }

    get data():Blob|FormData {
        return this._data;
    }

    succeeded(){
        this.status=UploadStatus.DONE;
        // The upload is only marked as server persisted, if the server acknowledged it
        if(this._serverPersistable) {
            this._serverPersistable.serverPersisted = true;
            //console.debug("Single upload set server persisted: "+this.serverPersistable);
        }else{
            //console.debug("Server persistable not set.");
        }
        if(this.onDone){
            this.onDone(this);
        }
    }

    failed(err:UploadError){
        this.status=UploadStatus.FAILED;
        this.lastError=err;
        if(this.onFail){
            this.onFail(this);
        }
    }

    public toString = () : string => {
        let s=`Upload: Status: ${this.status}, URL: ${this._url}`;
        if(this._data instanceof Blob){
            s=s+`, Size: ${this._data.size}`;
        }else if(this._data instanceof  FormData){
            // TODO (iterate through parts ??)
        }
        return s;
    }
}

export class UploadHolder{

    onUploadSet:((upload:Upload)=>void)|null=null;

    get upload(): Upload | null {
        return this._upload;
    }

    set upload(value: Upload | null) {
        this._upload = value;
        if(this._upload && this.onUploadSet){
            this.onUploadSet(this._upload);
        }
    }
    private _upload:Upload|null=null;

}

export class UploadSet{

    private uploads: Array<Upload|UploadHolder>=new Array<Upload|UploadHolder>();
    private _complete=false;

    private _onDone:((uploadSet:UploadSet)=>void)|null=null;
    private _onFail:((uploadSet:UploadSet)=>void)|null=null;

    add(upload:Upload|UploadHolder){
        if(this._complete) {
            throw new Error('Cannot add upload to upload set. Upload set already complete.')
        }
        if(upload instanceof UploadHolder){
            upload.onUploadSet=(upl)=>{
                upl.onDone=()=>{
                    this.checkUploadStates();
                }
                upl.onFail=()=>{
                    this.checkUploadStates();
                }
                this.checkUploadStates();
            }
        }
        this.uploads.push(upload);
    }


    complete(){
        // Mark set as complete
        this._complete=true;

        // add listeners to each upload
        for(let upl of this.uploads){
            if(upl instanceof Upload) {
                upl.onDone = (upl: Upload) => {
                    this.checkUploadStates();
                }
                upl.onFail = (upl: Upload) => {
                    this.checkUploadStates();
                }
            }else if(upl instanceof UploadHolder){
                if(upl.upload){
                    upl.upload.onDone = (upl: Upload) => {
                        this.checkUploadStates();
                    }
                    upl.upload.onFail = (upl: Upload) => {
                        this.checkUploadStates();
                    }
                }
            }
        }

        // check immediately if already done
        this.checkUploadStates();
    }

    set onDone(value: ((uploadSet: UploadSet) => void) | null) {
        this._onDone = value;
        // Callbacks may be assigned after complete() has been called (async upload creation).
        // Re-check in that case, otherwise a late done callback would never fire.
        if(this._complete) {
            this.checkUploadStates();
        }
    }

    set onFail(value: ((uploadSet: UploadSet) => void) | null) {
        this._onFail = value;
        if(this._complete) {
            this.checkUploadStates();
        }
    }

    private checkUploadStates(){
        //console.debug("Check upload state...")
        if(this._complete){

            for(let upl of this.uploads){
                if(upl instanceof Upload) {
                    if (UploadStatus.FAILED === upl.status) {
                        // At least one upload has terminally failed
                        //console.debug("Check upload state: Upload failed.")
                        if(this._onFail) {
                            this._onFail(this);
                        }
                        return;
                    }
                    if (UploadStatus.DONE !== upl.status) {
                        // At least this upload is not yet done
                        // Do nothing
                        //console.debug("Check upload state: Upload not done.")
                        return;
                    }
                }else if(upl instanceof UploadHolder){
                    if(upl.upload){
                        if (UploadStatus.FAILED === upl.upload.status) {
                            // At least one upload has terminally failed
                            //console.debug("Check upload state: Upload (holder) failed.")
                            if(this._onFail) {
                                this._onFail(this);
                            }
                            return;
                        }
                        if (UploadStatus.DONE !== upl.upload.status) {
                            // At least this upload is not yet done
                            // Do nothing
                            //console.debug("Check upload state: Upload (holder) not done.")
                            return;
                        }
                    }else{
                        // The actual upload is not yet set
                        //console.debug("Check upload state: Upload (holder): upload not yet set.")
                        return;
                    }
                }
            }
            // set is complete and all upload parts are done, call done callback
            //console.debug("Check upload state: All done.")
            if(this._onDone) {
                this._onDone(this);
            }
        }
    }
}

export class Uploader {
    POST_MIN_TIMEOUT = 120000; // 2min plus ...
    POST_TIMEOUT_PER_KB = 1000;  // ... 1s per kB

    DEBUG_DELAY: number = 0;
    //DEBUG_DELAY:number=0;
    private status: UploaderStatus = UploaderStatus.DONE;
    private readonly que: Array<Upload>;
    listener: ((ue: UploaderStatusChangeEvent) => void) | null = null;
    private _sizeQueued: number = 0;
    private _sizeDone: number = 0;

    private retryTimerRunning = false;
    private retryTimerId: number | null = null;
    // guards against reentrant process() calls (listener callbacks may synchronously re-enter)
    private processing = false;
    // number of POST requests currently in flight
    private inflight = 0;

    private readonly uploadCfg: Required<UploadConfig>;

    private te:TextEncoder=new TextEncoder();

    constructor(private http: HttpClient, private withCredentials: boolean = false, uploadCfg: UploadConfig = {}) {
        this.que = new Array<Upload>();
        this.uploadCfg = Object.assign({}, DEFAULT_UPLOAD_CONFIG, uploadCfg);
        if (this.uploadCfg.maxConcurrentUploads < 1) {
            this.uploadCfg.maxConcurrentUploads = 1;
        }
        // Eight attempts last about two minutes; a longer outage used to leave the queue FAILED with
        // nothing to restart it. Coming back online retries what failed for want of a connection.
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => this.retryTransientFailedUploads());
        }
    }

    get failedUploads(): number {
        let cnt = 0;
        for (let ul of this.que) {
            if (ul.status === UploadStatus.FAILED) {
                cnt++;
            }
        }
        return cnt;
    }

    private lastFailedError(): UploadError|null {
        for (let ul of this.que) {
            if (ul.status === UploadStatus.FAILED && ul.lastError) {
                return ul.lastError;
            }
        }
        return null;
    }

    private dataSize(dt:Blob|FormData){
        let si=0;
        if(dt instanceof Blob){
            si=dt.size;
        }else if(dt instanceof  FormData){
            dt.forEach((v,k)=>{
                if(v instanceof File){
                    si+=v.size;
                }else if(typeof v ==='string'){
                    // encode to UTF-8 to get upload size
                    si+= this.te.encode(v).length;
                }
            })
        }
        return si;
    }

    private uploadSucceeded(ul:Upload) {

        this.inflight--;
        this.removePersistedUpload(ul);
        ul.succeeded();

        // remove upload from queue
        for (let i = 0; i < this.que.length; i++) {
            if (this.que[i] === ul) {
                // found, remove
                this.que.splice(i, 1);
                let ulSize = this.dataSize(ul.data);
                this._sizeDone += ulSize;
                break;
            }
        }
        // set to done for now...
        this.status = UploaderStatus.NEXT;
        // continue
        this.process();
    }

    // normalize any error into an UploadError and classify it (terminal vs. transient)
    private classifyError(err: unknown): UploadError {
        let status = 0;
        let message = '';
        if (err instanceof HttpErrorResponse) {
            status = err.status;
            // The response body may contain clues as to what went wrong
            // (Angular types HttpErrorResponse.error as any; narrow it defensively)
            const errBody: unknown = err.error;
            if (typeof errBody === 'string') {
                message = errBody;
            } else if (errBody !== null && typeof errBody === 'object') {
                if ('error' in errBody && typeof errBody.error === 'string') {
                    message = errBody.error;
                } else if ('message' in errBody && typeof errBody.message === 'string') {
                    message = errBody.message;
                }
            }
        }
        if (!message && err !== null && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
            message = err.message;
        }
        if (message.length > 200) {
            message = message.slice(0, 200);
        }
        // client side errors (network, timeout), request timeout, rate limiting and server errors are transient
        const terminal = !(status === 0 || status === 408 || status === 425 || status === 429 || status >= 500);
        return {status: status, message: message, terminal: terminal};
    }

    private ackSatisfied(resp: unknown): boolean {
        if (!this.uploadCfg.requireStoredAck) {
            return true;
        }
        return resp !== null && typeof resp === 'object' && 'stored' in resp && resp.stored === true;
    }

    private startUpload(ul:Upload) {

        ul.status = UploadStatus.UPLOADING;
        ul.attemptCount++;
        this.inflight++;
        if (UploaderStatus.ERR === this.status) {
            this.status = UploaderStatus.TRY_UPLOADING;
        } else {
            this.status = UploaderStatus.UPLOADING;
        }

        let dSize=this.dataSize(ul.data);
        let timeoutForDataSize=dSize*this.POST_TIMEOUT_PER_KB/1000;
        let timeoVal:number=Math.round(this.POST_MIN_TIMEOUT+timeoutForDataSize)
        // pipe(timeout()) is not the same as xhr.timeout
        // Note: a timeout aborts the request on the client side only. The server may still have
        // stored the payload. The idempotency key allows the server to deduplicate a retry.

        let uploadedUpload:Upload|null=null;
        let uploadFailedAck=false;
        //console.debug("Post upload: "+ul)
        let headers=new HttpHeaders().set(this.uploadCfg.idempotencyHeader,ul.idempotencyKey);
        this.http.post(ul.url,ul.data,{withCredentials:this.withCredentials,headers:headers}).pipe(timeout(timeoVal)).subscribe(
            {
                next: (resp)=>
                {
                    if (this.ackSatisfied(resp)) {
                        uploadedUpload = ul;
                        //console.debug('Next method called for upload: '+uploadedUpload)
                    } else {
                        uploadFailedAck=true;
                        this.inflight--;
                        this.processError(ul,{status: 200, message: 'Server did not confirm that the upload was stored.', terminal: true});
                    }
                }
                , error:(err: unknown) => {
                    if (err instanceof Error && !(err instanceof HttpErrorResponse)) {
                        // A client-side or network error occurred. Handle it accordingly.
                        SprLogger.error('Upload error occurred:', err.message);
                    } else if (err instanceof HttpErrorResponse) {
                        // The backend returned an unsuccessful response code.
                        // The response body may contain clues as to what went wrong,
                        SprLogger.error(`Upload error: Server returned code ${err.status}`);
                    }
                    this.inflight--;
                    this.processError(ul,this.classifyError(err))
                }, complete: () => {
                    //console.debug('Upload complete method called')
                    if (uploadedUpload) {
                        if (this.DEBUG_DELAY > 0) {
                            window.setTimeout(() => {
                                this.uploadSucceeded(ul);
                            }, this.DEBUG_DELAY);
                        } else {
                            this.uploadSucceeded(uploadedUpload)
                        }
                    } else if (!uploadFailedAck) {
                        SprLogger.error('Upload post complete, but upload not set in next method!')
                    }
                }
            });
    }

    private retryDelayMs(ul:Upload):number {
        // exponential backoff: base * 2^(attempt-1), capped, with jitter
        let exp = Math.min(ul.attemptCount - 1, 30);
        let delay = this.uploadCfg.baseRetryDelayMs * Math.pow(2, exp);
        delay = Math.min(delay, this.uploadCfg.maxRetryDelayMs);
        let jitter = this.uploadCfg.jitterRatio;
        if (jitter > 0) {
            delay = Math.round(delay * (1 - jitter + 2 * jitter * Math.random()));
        }
        return Math.max(0, delay);
    }

    private scheduleRetry(ul:Upload) {
        // Set the running flag before setTimeout: process() may run synchronously in between and
        // must be able to clear the timer (race condition otherwise).
        this.retryTimerRunning=true;
        this.retryTimerId=window.setTimeout(() => {
            this.retryTimerRunning=false;
            this.retryTimerId=null;
            //console.debug("Upload retry timer expired. Continue processing...")
            this.process();
        }, this.retryDelayMs(ul));
        //console.debug("Started upload retry timer "+delay+"ms ...")
    }

    private processError(ul:Upload, err:UploadError) {
        //console.debug("Process upload error...")
        ul.lastError = err;
        if (err.terminal || ul.attemptCount >= this.uploadCfg.maxAttempts) {
            if (err.terminal) {
                // a refusal (4xx) will be the same after a reload; keeping it would re-queue it for ever
                this.removePersistedUpload(ul);
            }
            ul.failed(err);
            // continue with the next upload in the queue resp. report the partial state
            this.status = UploaderStatus.ERR;
            this.process();
        } else {
            ul.status=UploadStatus.ERR;
            this.status = UploaderStatus.ERR;

            let ue = new UploaderStatusChangeEvent(this._sizeQueued, this._sizeDone, this.status, this.failedUploads, err);
            if (this.listener) {
                this.listener(ue);
            }

            this.scheduleRetry(ul);
        }
    }

    private process() {
        if (this.processing) {
            return;
        }
        this.processing = true;
        try {
            this.processInternal();
        } finally {
            this.processing = false;
        }
    }

    private processInternal() {
        // clear retry timer if set
        if(this.retryTimerRunning){
            if(this.retryTimerId) {
                window.clearTimeout(this.retryTimerId)
            }
            this.retryTimerRunning=false
            this.retryTimerId=null
            //console.debug("Cleared retry timer.")
        }

        let startedCnt = 0;

        //console.debug("Uploader status: "+this.status)

        let s = this.que.length;
        //console.debug(s+" uploads are in the queue.")

        // start uploads while concurrency capacity remains
        for (let i = 0; i < s && this.inflight < this.uploadCfg.maxConcurrentUploads; i++) {
            let ul = this.que[i];
            //console.log("Upload "+ul+" status:"+ul.status)
            if (ul.status === UploadStatus.IDLE) {
                //console.log("Upload "+ul+" startUpload")
                this.startUpload(ul);
                startedCnt++;
            }
        }
        // then retry previously failed (transient) uploads with remaining capacity
        for (let i = 0; i < s && this.inflight < this.uploadCfg.maxConcurrentUploads; i++) {
            let ul = this.que[i];
            if (ul.status === UploadStatus.ERR) {
                //console.debug("Start error state upload "+ul)
                this.startUpload(ul);
                startedCnt++;
            }
        }

        let failedCnt = this.failedUploads;
        if(s==0 && this.inflight===0){
            //console.debug("Upload done.")
            this.status = (failedCnt>0)?UploaderStatus.PARTIAL:UploaderStatus.DONE;
        }else if(startedCnt===0 && this.inflight===0 && s>0 && failedCnt>0){
            // nothing startable and nothing in flight: all remaining uploads terminally failed
            this.status = UploaderStatus.PARTIAL;
        }
        let ue = new UploaderStatusChangeEvent(this._sizeQueued, this._sizeDone, this.status, failedCnt, this.lastFailedError());
        if (this.listener) {
            this.listener(ue);
        }
    }

    queueUpload(ul: Upload) {
        if (ul) {
            let ulSize = this.dataSize(ul.data);
            this.que.push(ul);
            this._sizeQueued += ulSize;
            this.persistUpload(ul);
            this.process();
        }
    }

    // Persists an upload to IndexedDB so it can be re-queued after a page reload (see
    // restorePersistedUploads): the Blob of an audio upload, or the fields of a FormData control
    // request (prepare/concat).
    private persistUpload(ul: Upload): void {
        if (!this.uploadCfg.persistQueue) {
            return;
        }
        const data = ul.data;
        // The concat request must survive a reload as well as the chunks: without it the chunks
        // are on the server and the recording is never published.
        const fields: Array<[string, string | Blob]> = [];
        if (!(data instanceof Blob)) {
            data.forEach((value, name) => fields.push([name, value]));
        }
        const payload = data instanceof Blob ? {blob: data} : {form: fields};
        const entry = {idempotencyKey: ul.idempotencyKey, url: ul.url, queuedAt: Date.now(), ...payload};
        this.dbWrite('persist upload for later resume', (store) => store.put(entry));
    }

    private removePersistedUpload(ul: Upload): void {
        if (!this.uploadCfg.persistQueue) {
            return;
        }
        this.dbWrite('remove persisted upload', (store) => store.delete(ul.idempotencyKey));
    }

    // Writes to the persisted queue run one after the other, each waiting for its transaction to
    // commit: a fast upload used to delete its entry before the put had run, leaving a stale entry
    // that was uploaded again on every later page load.
    private dbChain: Promise<void> = Promise.resolve();

    private dbWrite(what: string, op: (store: IDBObjectStore) => void): void {
        this.dbChain = this.dbChain.then(() => new Promise<void>((resolve) => {
            let used = false;
            SprDb.prepare().subscribe({
                next: (db) => {
                    if (used) {
                        return;
                    }
                    used = true;
                    try {
                        const tr = db.transaction(SprDb.UPLOAD_QUEUE_OBJECT_STORE_NAME, 'readwrite');
                        op(tr.objectStore(SprDb.UPLOAD_QUEUE_OBJECT_STORE_NAME));
                        tr.oncomplete = () => resolve();
                        // quota exhausted, storage cleared, private mode: the upload still proceeds, unprotected
                        tr.onerror = tr.onabort = () => {
                            SprLogger.error('Could not ' + what + ': ' + tr.error);
                            resolve();
                        };
                    } catch (err) {
                        SprLogger.error('Could not ' + what + ': ' + err);
                        resolve();
                    }
                },
                error: (err: unknown) => {
                    SprLogger.error('Could not ' + what + ': ' + err);
                    resolve();
                }
            });
        }));
    }

    // Restores uploads persisted before a page reload and queues them again.
    // Restored uploads keep their idempotency keys, so the server can deduplicate
    // uploads that succeeded before the reload. Persisted entries are removed
    // once the restored upload succeeds.
    restorePersistedUploads(): Observable<number> {
        return new Observable<number>((subscriber) => {
            SprDb.prepare().subscribe({
                next: (db) => {
                    try {
                        const tr = db.transaction(SprDb.UPLOAD_QUEUE_OBJECT_STORE_NAME, 'readonly');
                        const req = tr.objectStore(SprDb.UPLOAD_QUEUE_OBJECT_STORE_NAME).getAll();
                        req.onsuccess = () => {
                            let restored = 0;
                            const entries: unknown = req.result;
                            if (Array.isArray(entries)) {
                                // initialisation can run more than once per page; a key already queued is not queued twice
                                const queued = new Set(this.que.map((ul) => ul.idempotencyKey));
                                const stored = entries.filter(isPersistedUploadEntry)
                                    .filter((entry) => !queued.has(entry.idempotencyKey))
                                    .sort((x, y) => (x.queuedAt ?? 0) - (y.queuedAt ?? 0));
                                for (const entry of stored) {
                                    let data: Blob | FormData;
                                    if (entry.blob instanceof Blob) {
                                        data = entry.blob;
                                    } else {
                                        data = new FormData();
                                        for (const [name, value] of entry.form ?? []) {
                                            data.append(name, value);
                                        }
                                    }
                                    this.queueUpload(new Upload(data, entry.url, null, entry.idempotencyKey));
                                    restored++;
                                }
                            }
                            subscriber.next(restored);
                            subscriber.complete();
                        };
                        req.onerror = () => {
                            subscriber.error(req.error ?? new Error('Could not read persisted upload queue.'));
                        };
                    } catch (err) {
                        subscriber.error(err);
                    }
                },
                error: (err: unknown) => {
                    subscriber.error(err);
                }
            });
        });
    }

    // Retries the uploads that gave up after repeated transient errors (network, 408/425/429/5xx).
    // A terminal answer (4xx) stays failed: asking again cannot change it.
    retryTransientFailedUploads():void {
        let retried = false;
        for (let ul of this.que) {
            if (ul.status === UploadStatus.FAILED && ul.lastError && !ul.lastError.terminal) {
                ul.status = UploadStatus.IDLE;
                ul.attemptCount = 0;
                ul.lastError = null;
                retried = true;
            }
        }
        if (retried) {
            this.process();
        }
    }

    retryFailedUploads():void {
        for (let ul of this.que) {
            if (ul.status === UploadStatus.FAILED) {
                ul.status = UploadStatus.IDLE;
                ul.attemptCount = 0;
                ul.lastError = null;
            }
        }
        this.process();
    }
}

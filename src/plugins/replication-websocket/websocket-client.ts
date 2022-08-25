import { replicateRxCollection, RxReplicationState } from '../replication';
import {
    WebsocketClientOptions,
    WebsocketMessageResponseType,
    WebsocketMessageType
} from './websocket-types';

import ReconnectingWebSocket from 'reconnecting-websocket';
import {
    WebSocket as IsomorphicWebSocket
} from 'isomorphic-ws';
import {
    getFromMapOrThrow,
    randomCouchString
} from '../../util';
import {
    filter,
    map,
    Subject,
    firstValueFrom
} from 'rxjs';
import { RxError, RxReplicationWriteToMasterRow } from '../../types';
import { newRxError } from '../../rx-error';

export type WebsocketWithRefCount = {
    url: string;
    socket: ReconnectingWebSocket;
    refCount: number;
    openPromise: Promise<void>;
    connect$: Subject<void>;
    message$: Subject<WebsocketMessageResponseType>;
    error$: Subject<RxError>
};

/**
 * Reuse the same socket even when multiple
 * collection replicate with the same server at once.
 */
export const WEBSOCKET_BY_URL: Map<string, WebsocketWithRefCount> = new Map();
export async function getWebSocket(
    url: string
): Promise<WebsocketWithRefCount> {
    let has = WEBSOCKET_BY_URL.get(url);
    if (!has) {
        const wsClient = new ReconnectingWebSocket(
            url,
            undefined,
            {
                WebSocket: IsomorphicWebSocket
            }
        );


        const connect$ = new Subject<void>();
        const openPromise = new Promise<void>(res => {
            wsClient.onopen = () => {
                connect$.next();
                res();
            };
        });

        const message$ = new Subject<WebsocketMessageResponseType>();
        wsClient.onmessage = (messageObj) => {
            const message: WebsocketMessageResponseType = JSON.parse(messageObj.data);
            message$.next(message);
        };

        const error$ = new Subject<any>();
        wsClient.onerror = (err) => {
            const emitError = newRxError('RC_STREAM', {
                errors: Array.isArray(err) ? err as any : [err],
                direction: 'pull'
            });
            error$.next(emitError);
        }


        has = {
            url,
            socket: wsClient,
            openPromise,
            refCount: 1,
            connect$,
            message$,
            error$
        };
        WEBSOCKET_BY_URL.set(url, has);
    } else {
        has.refCount = has.refCount + 1;
    }


    await has.openPromise;
    return has;
}

export function removeWebSocketRef(
    url: string
) {
    const obj = getFromMapOrThrow(WEBSOCKET_BY_URL, url);
    obj.refCount = obj.refCount - 1;
    if (obj.refCount === 0) {
        WEBSOCKET_BY_URL.delete(url);
        obj.connect$.complete();
        obj.socket.close();
    }
}



export async function replicateWithWebsocketServer<RxDocType, CheckpointType>(
    options: WebsocketClientOptions<RxDocType>
): Promise<RxReplicationState<RxDocType, CheckpointType>> {
    const socketState = await getWebSocket(options.url);
    const wsClient = socketState.socket;

    const messages$ = socketState.message$;

    let requestCounter = 0;
    const requestFlag = randomCouchString(10);
    function getRequestId() {
        const count = requestCounter++;
        return options.collection.database.token + '|' + requestFlag + '|' + count;
    }

    const streamRequest: WebsocketMessageType = {
        id: 'stream',
        collection: options.collection.name,
        method: 'masterChangeStream$',
        params: []
    }
    wsClient.send(JSON.stringify(streamRequest));

    const replicationState = replicateRxCollection<RxDocType, CheckpointType>({
        collection: options.collection,
        replicationIdentifier: 'websocket-' + options.url,
        pull: {
            batchSize: options.batchSize,
            stream$: messages$.pipe(
                filter(msg => msg.id === 'stream' && msg.collection === options.collection.name),
                map(msg => msg.result)
            ),
            async handler(lastPulledCheckpoint: CheckpointType, batchSize: number) {
                const requestId = getRequestId();
                const request: WebsocketMessageType = {
                    id: requestId,
                    collection: options.collection.name,
                    method: 'masterChangesSince',
                    params: [lastPulledCheckpoint, batchSize]
                }
                wsClient.send(JSON.stringify(request));
                const result = await firstValueFrom(
                    messages$.pipe(
                        filter(msg => msg.id === requestId),
                        map(msg => msg.result)
                    )
                );
                return result;
            }
        },
        push: {
            batchSize: options.batchSize,
            handler(docs: RxReplicationWriteToMasterRow<RxDocType>[]) {
                const requestId = getRequestId();
                const request: WebsocketMessageType = {
                    id: requestId,
                    collection: options.collection.name,
                    method: 'masterWrite',
                    params: [docs]
                }
                wsClient.send(JSON.stringify(request));
                return firstValueFrom(
                    messages$.pipe(
                        filter(msg => msg.id === requestId),
                        map(msg => msg.result)
                    )
                );
            }
        }
    });

    socketState.error$.subscribe(err => replicationState.subjects.error.next(err));

    /**
     * When the client goes offline and online again,
     * we have to send a 'RESYNC' signal because the client
     * might have missed out events while being offline.
     */
    socketState.connect$.subscribe(() => replicationState.reSync());


    return replicationState;
}
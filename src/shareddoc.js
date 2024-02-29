/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync.js';
import * as awarenessProtocol from 'y-protocols/awareness.js';

import * as encoding from 'lib0/encoding.js';
import * as decoding from 'lib0/decoding.js';
import debounce from 'lodash/debounce.js';

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;

// disable gc when using snapshots!
const gcEnabled = false;

const docs = new Map();

const messageSync = 0;
const messageAwareness = 1;

export const closeConn = (doc, conn) => {
  if (doc.conns.has(conn)) {
    const controlledIds = doc.conns.get(conn);
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null);

    if (doc.conns.size === 0) {
      docs.delete(doc.name);
    }
  }
  conn.close();
};

const send = (doc, conn, m) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn);
    return;
  }
  try {
    conn.send(m, (err) => err != null && closeConn(doc, conn));
  } catch (e) {
    closeConn(doc, conn);
  }
};

export const persistence = {
  fetch: fetch.bind(this),
  closeConn: closeConn.bind(this),
  get: async (docName, auth) => {
    const initalOpts = {};
    if (auth) {
      initalOpts.headers = new Headers({ Authorization: auth });
    }
    const initialReq = await persistence.fetch(docName, initalOpts);
    if (initialReq.ok) {
      return initialReq.text();
    } else if (initialReq.status === 404) {
      return '';
    } else {
      // eslint-disable-next-line no-console
      console.log(`unable to get resource: ${initialReq.status} - ${initialReq.statusText}`);
      throw new Error(`unable to get resource - status: ${initialReq.status}`);
    }
  },
  put: async (ydoc, content) => {
    const blob = new Blob([content], { type: 'text/html' });

    const formData = new FormData();
    formData.append('data', blob);

    const opts = { method: 'PUT', body: formData };
    const auth = Array.from(ydoc.conns.keys())
      .map((con) => con.auth);

    if (auth.length > 0) {
      opts.headers = new Headers({
        Authorization: [...new Set(auth)].join(','),
        'X-DA-Initiator': 'collab',
      });
    }

    const { ok, status, statusText } = await persistence.fetch(ydoc.name, opts);

    return {
      ok,
      status,
      statusText,
    };
  },
  invalidate: async (ydoc) => {
    const auth = Array.from(ydoc.conns.keys())
      .map((con) => con.auth);
    const authHeader = auth.length > 0 ? [...new Set(auth)].join(',') : undefined;

    const svrContent = await persistence.get(ydoc.name, authHeader);
    const aemMap = ydoc.getMap('aem');
    const cliContent = aemMap.get('content');
    if (svrContent !== cliContent) {
      // Only update the client if they're different
      aemMap.set('svrinv', svrContent);
    }
  },
  update: async (ydoc, current) => {
    let closeAll = false;
    try {
      const content = ydoc.getMap('aem').get('content');
      if (current !== content) {
        const { ok, status, statusText } = await persistence.put(ydoc, content);

        if (!ok) {
          closeAll = status === 401;
          throw new Error(`${status} - ${statusText}`);
        }
        // eslint-disable-next-line no-console
        console.log(content);
        return content;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
      ydoc.emit('error', [err]);
    }
    if (closeAll) {
      // We had an unauthorized from da-admin - lets reset the connections
      Array.from(ydoc.conns.keys())
        .forEach((con) => persistence.closeConn(ydoc, con));
    }
    return current;
  },
  bindState: async (docName, ydoc, conn) => {
    const persistedYdoc = new Y.Doc();
    const aemMap = persistedYdoc.getMap('aem');

    let current = await persistence.get(docName, conn.auth);

    aemMap.set('initial', current);

    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));

    ydoc.on('update', debounce(async () => {
      current = await persistence.update(ydoc, current);
    }, 2000, 10000));
  },
};

export const updateHandler = (update, _origin, doc) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeUpdate(encoder, update);
  const message = encoding.toUint8Array(encoder);
  doc.conns.forEach((_, conn) => send(doc, conn, message));
};

export class WSSharedDoc extends Y.Doc {
  constructor(name) {
    super({ gc: gcEnabled });
    this.name = name;
    this.conns = new Map();
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);

    const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
      const changedClients = added.concat(updated, removed);
      if (conn !== null) {
        const connControlledIDs = (this.conns.get(conn));
        if (connControlledIDs !== undefined) {
          added.forEach((clientID) => {
            connControlledIDs.add(clientID);
          });
          removed.forEach((clientID) => {
            connControlledIDs.delete(clientID);
          });
        }
      }
      // broadcast awareness update
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(encoder, awarenessProtocol
        .encodeAwarenessUpdate(this.awareness, changedClients));
      const buff = encoding.toUint8Array(encoder);
      this.conns.forEach((_, c) => {
        send(this, c, buff);
      });
    };
    this.awareness.on('update', awarenessChangeHandler);
    this.on('update', updateHandler);
  }
}

export function wait(milliseconds) {
  return new Promise((r) => {
    setTimeout(r, milliseconds);
  });
}

/* Get a promise that resolves when the document is bound to persistence.
   Multiple clients may be looking for the same document, but they should all
   wait using it until it's bound to the persistence.

   The first request here will create a promise that resolves when bindState
   has completed. This promise is also stored on the doc.promise field and is
   passed in on later calls on this doc as the existingPromise.
   On subsequent if there is already an existingPromise, then wait on that same
   promise. However if the promise hasn't resolved yet
   or there is no content in the doc, then wait for 500 ms to avoid all clients
   from getting connected at exactly the same time, which can result in editor
   content being duplicated. The promise is then replaced with a new promise that
   has the wait included. Subsequent calls will add a further wait and so on.
   Once the persistence is bound and the document has content, the same promise
   is returned, but that one is already resolved so it's available immediately.
 */
export const getBindPromise = async (docName, doc, conn, existingPromise, fnWait = wait) => {
  if (existingPromise) {
    const hasContent = doc.getMap('aem')?.has('content');
    if (doc.boundState && hasContent) {
      return existingPromise;
    } else {
      return fnWait(500).then(() => existingPromise);
    }
  } else {
    return persistence.bindState(docName, doc, conn)
      .then(() => {
        // eslint-disable-next-line no-param-reassign
        doc.boundState = true;
      });
  }
};

export const getYDoc = async (docname, conn, gc = true) => {
  let doc = docs.get(docname);
  if (doc === undefined) {
    doc = new WSSharedDoc(docname);
    doc.gc = gc;
    docs.set(docname, doc);
  }
  doc.conns.set(conn, new Set());
  doc.promise = getBindPromise(docname, doc, conn, doc.promise);

  await doc.promise;
  return doc;
};

// For testing
export const setYDoc = (docname, ydoc) => docs.set(docname, ydoc);

export const messageListener = (conn, doc, message) => {
  try {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case messageSync:
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);

        // If the `encoder` only contains the type of reply message and no
        // message, there is no need to send the message. When `encoder` only
        // contains the type of reply, its length is 1.
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder));
        }
        break;
      case messageAwareness: {
        awarenessProtocol
          .applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    doc.emit('error', [err]);
  }
};

export const invalidateFromAdmin = async (docName) => {
  const ydoc = docs.get(docName);
  if (ydoc) {
    await persistence.invalidate(ydoc);
    return true;
  }
  return false;
};

export const setupWSConnection = async (conn, docName) => {
  // eslint-disable-next-line no-param-reassign
  conn.binaryType = 'arraybuffer';
  // get doc, initialize if it does not exist yet
  const doc = await getYDoc(docName, conn, true);

  // listen and reply to events
  conn.addEventListener('message', (message) => messageListener(conn, doc, new Uint8Array(message.data)));

  // Check if connection is still alive
  conn.addEventListener('close', () => {
    closeConn(doc, conn);
  });
  // put the following in a variables in a block so the interval handlers don't keep in in
  // scope
  {
    // send sync step 1
    let encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(doc, conn, encoding.toUint8Array(encoder));
    const awarenessStates = doc.awareness.getStates();
    if (awarenessStates.size > 0) {
      encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(encoder, awarenessProtocol
        .encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys())));
      send(doc, conn, encoding.toUint8Array(encoder));
    }
  }
};

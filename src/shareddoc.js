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
import { aem2doc, doc2aem } from './collab.js';

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;

// disable gc when using snapshots!
const gcEnabled = false;

const docs = new Map();

const messageSync = 0;
const messageAwareness = 1;
const MAX_STORAGE_KEYS = 128;
const MAX_STORAGE_VALUE_SIZE = 131072;

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

export const readState = async (docName, storage) => {
  const stored = await storage.list();
  if (stored.size === 0) {
    // eslint-disable-next-line no-console
    console.log('No stored doc in persistence');
    return undefined;
  }

  if (stored.get('doc') !== docName) {
    // eslint-disable-next-line no-console
    console.log('Docname mismatch in persistence. Expected:', docName, 'found:', stored.get('doc'), 'Deleting storage');
    await storage.deleteAll();
    return undefined;
  }

  if (stored.has('docstore')) {
    return stored.get('docstore');
  }

  const data = [];
  for (let i = 0; i < stored.get('chunks'); i += 1) {
    const chunk = stored.get(`chunk_${i}`);
    data.push(...chunk);
  }
  return new Uint8Array(data);
};

export const storeState = async (docName, state, storage, chunkSize = MAX_STORAGE_VALUE_SIZE) => {
  await storage.deleteAll();

  let serialized;
  if (state.byteLength < chunkSize) {
    serialized = { docstore: state };
  } else {
    serialized = {};
    let j = 0;
    for (let i = 0; i < state.length; i += chunkSize, j += 1) {
      serialized[`chunk_${j}`] = state.slice(i, i + chunkSize);
    }

    if (j >= MAX_STORAGE_KEYS) {
      throw new Error('Object too big for worker storage');
    }

    serialized.chunks = j;
  }
  serialized.doc = docName;

  await storage.put(serialized);
};

export const persistence = {
  closeConn: closeConn.bind(this),
  get: async (docName, auth, daadmin) => {
    const initalOpts = {};
    if (auth) {
      initalOpts.headers = new Headers({ Authorization: auth });
    }
    const initialReq = await daadmin.fetch(docName, initalOpts);
    if (initialReq.ok) {
      return initialReq.text();
    } else if (initialReq.status === 404) {
      return '<main></main>';
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

    const { ok, status, statusText } = await ydoc.daadmin.fetch(ydoc.name, opts);

    return {
      ok,
      status,
      statusText,
    };
  },
  update: async (ydoc, current) => {
    let closeAll = false;
    try {
      const content = doc2aem(ydoc);
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
  bindState: async (docName, ydoc, conn, storage) => {
    let current = await persistence.get(docName, conn.auth, ydoc.daadmin);

    let restored = false;
    try {
      const stored = await readState(docName, storage);
      if (stored && stored.length > 0) {
        Y.applyUpdate(ydoc, stored);

        const fromStorage = doc2aem(ydoc);
        if (fromStorage === current) {
          restored = true;

          // eslint-disable-next-line no-console
          console.log('Restored from worker persistence', docName);
        }
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log('Problem restoring state from worker storage', error);
    }

    if (!restored) {
      setTimeout(() => {
        if (ydoc === docs.get(docName)) {
          // restore from da-admin
          aem2doc(current, ydoc);
          // eslint-disable-next-line no-console
          console.log('Restored from da-admin', docName);
        }
      }, 1000);
    }

    ydoc.on('update', async () => {
      if (ydoc === docs.get(docName)) { // make sure this ydoc is still active
        storeState(docName, Y.encodeStateAsUpdate(ydoc), storage);
      }
    });

    ydoc.on('update', debounce(async () => {
      if (ydoc === docs.get(docName)) {
        current = await persistence.update(ydoc, current);
      }
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

export const getYDoc = async (docname, conn, env, storage, gc = true) => {
  let doc = docs.get(docname);
  if (doc === undefined) {
    doc = new WSSharedDoc(docname);
    doc.gc = gc;
    docs.set(docname, doc);
  }

  if (!doc.conns.get(conn)) {
    doc.conns.set(conn, new Set());
  }

  doc.daadmin = env.daadmin;
  if (!doc.promise) {
    doc.promise = persistence.bindState(docname, doc, conn, storage);
  }

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
    // As we are closing all connections, the ydoc will be removed from the docs map
    ydoc.conns.forEach((_, c) => closeConn(ydoc, c));

    return true;
  }
  return false;
};

export const setupWSConnection = async (conn, docName, env, storage) => {
  // eslint-disable-next-line no-param-reassign
  conn.binaryType = 'arraybuffer';
  // get doc, initialize if it does not exist yet
  const doc = await getYDoc(docName, conn, env, storage, true);

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

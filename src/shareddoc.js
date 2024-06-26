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

// The local cache of ydocs
const docs = new Map();

const EMPTY_DOC = '<main></main>';
const messageSync = 0;
const messageAwareness = 1;
const MAX_STORAGE_KEYS = 128;
const MAX_STORAGE_VALUE_SIZE = 131072;

/**
 * Close the WebSocket connection for a document. If there are no connections left, remove
 * the ydoc from the local cache map.
 * @param {ydoc} doc - the ydoc to close the connection for.
 * @param {WebSocket} conn - the websocket connection to close.
 */
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

/**
 * Read the ydoc document state from durable object persistent storage. The format is as
 * in storeState function.
 * @param {string} docName - The document name
 * @param {TransactionalStorage} storage - The worker transactional storage
 * @returns {Uint8Array | undefined} - The stored state or undefined if not found
 */
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

    // Note cannot use the spread operator here, as that goes via the stack and may lead to
    // stack overflow.
    for (let j = 0; j < chunk.length; j += 1) {
      data.push(chunk[j]);
    }
  }
  return new Uint8Array(data);
};

/**
 * Store the document in durable object persistent storage. The document is stored as one or
 * more byte arrays. Durable persistent storage is tied to each durable object, so the storage only
 * applies to the current document.
 * The durable object storage saves an object (keys and values) but there is a limit to the size
 * of the values. So if the state is too large, it is split into chunks.
 * The layout of the stored object is as follows:
 * a. State size less than max storage value size:
 *    serialized.doc = document name
 *    serialized.docstore = state of the document
 * b. State size greater than max storage value size:
 *    serialized.doc = document name
 *    serialized.chunks = number of chunks
 *    serialized.chunk_0 = first chunk
 *    ...
 *    serialized.chunk_n = last chunk, where n = chunks - 1
 * @param {string} docName - The document name
 * @param {Uint8Array} state - The Yjs document state, as produced by Y.encodeStateAsUpdate()
 * @param {TransactionalStorage} storage - The worker transactional storage
 * @param {number} chunkSize - The chunk size
 */
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

export const showError = (ydoc, err) => {
  const em = ydoc.getMap('error');

  // Perform the change in a transaction to avoid seeing a partial error
  ydoc.transact(() => {
    em.set('timestamp', Date.now());
    em.set('message', err.message);
    em.set('stack', err.stack);
  });
};

export const persistence = {
  closeConn: closeConn.bind(this),

  /**
   * Get the document from da-admin. If da-admin doesn't have the doc, a new empty doc is
   * returned.
   * @param {string} docName - The document name
   * @param {string} auth - The authorization header
   * @param {object} daadmin - The da-admin worker service binding
   * @returns {Promise<string>} - The content of the document
   */
  get: async (docName, auth, daadmin) => {
    const initalOpts = {};
    if (auth) {
      initalOpts.headers = new Headers({ Authorization: auth });
    }
    const initialReq = await daadmin.fetch(docName, initalOpts);
    if (initialReq.ok) {
      return initialReq.text();
    } else if (initialReq.status === 404) {
      return EMPTY_DOC;
    } else {
      // eslint-disable-next-line no-console
      console.log(`unable to get resource: ${initialReq.status} - ${initialReq.statusText}`);
      throw new Error(`unable to get resource - status: ${initialReq.status}`);
    }
  },

  /**
   * Store the content in da-admin.
   * @param {WSSharedDoc} ydoc - The Yjs document, which among other things contains the service
   * binding to da-admin.
   * @param {string} content - The content to store
   * @returns {object} The response from da-admin.
   */
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

  /**
   * An update to the document has been received. Store it in da-admin.
   * @param {WSSharedDoc} ydoc - the ydoc that has been updated.
   * @param {string} current - the current content of the document previously
   * obtained from da-admin
   * @returns {string} - the new content of the document in da-admin.
   */
  update: async (ydoc, current) => {
    let closeAll = false;
    try {
      const content = doc2aem(ydoc);
      if (current !== content) {
        // Only store the document if it was actually changed.
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
      showError(ydoc, err);
    }
    if (closeAll) {
      // We had an unauthorized from da-admin - lets reset the connections
      Array.from(ydoc.conns.keys())
        .forEach((con) => persistence.closeConn(ydoc, con));
    }
    return current;
  },

  /**
   * Bind the Ydoc to the persistence layer.
   * @param {string} docName - the name of the document
   * @param {WSSharedDoc} ydoc - the new ydoc to be bound
   * @param {WebSocket} conn - the websocket connection
   * @param {TransactionalStorage} storage - the worker transactional storage object
   */
  bindState: async (docName, ydoc, conn, storage) => {
    let current;
    let restored = false;
    try {
      current = await persistence.get(docName, conn.auth, ydoc.daadmin);

      // Read the stored state from internal worker storage
      const stored = await readState(docName, storage);
      if (stored && stored.length > 0) {
        Y.applyUpdate(ydoc, stored);

        // Check if the state from the worker storage is the same as the current state in da-admin.
        // So for example if da-admin doesn't have the doc any more, or if it has been altered in
        // another way, we don't use the state of the worker storage.
        const fromStorage = doc2aem(ydoc);
        if (fromStorage === current) {
          restored = true;

          // eslint-disable-next-line no-console
          console.log('Restored from worker persistence', docName);
        }
      } else if (current === EMPTY_DOC) {
        // There is no stored state and the document is empty, which means
        // we have a new doc here, which doesn't need to be restored from da-admin
        restored = true;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log('Problem restoring state from worker storage', error);
      showError(ydoc, error);
    }

    if (!restored) {
      // If we weren't able to restore from worker storage, restore from da-admin
      setTimeout(() => {
        if (ydoc === docs.get(docName)) {
          const rootType = ydoc.getXmlFragment('prosemirror');
          ydoc.transact(() => {
            try {
              // clear document
              rootType.delete(0, rootType.length);
              // restore from da-admin
              aem2doc(current, ydoc);

              // eslint-disable-next-line no-console
              console.log('Restored from da-admin', docName);
            } catch (error) {
              // eslint-disable-next-line no-console
              console.log('Problem restoring state from da-admin', error);
              showError(ydoc, error);
            }
          });
        }
      }, 1000);
    }

    ydoc.on('update', async () => {
      // Whenever we receive an update on the document store it in the local storage
      if (ydoc === docs.get(docName)) { // make sure this ydoc is still active
        storeState(docName, Y.encodeStateAsUpdate(ydoc), storage);
      }
    });

    ydoc.on('update', debounce(async () => {
      // If we receive an update on the document, store it in da-admin, but debounce it
      // to avoid excessive da-admin calls.
      if (ydoc === docs.get(docName)) {
        current = await persistence.update(ydoc, current);
      }
    }, 2000, { maxWait: 10000 }));
  },
};

export const updateHandler = (update, _origin, doc) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeUpdate(encoder, update);
  const message = encoding.toUint8Array(encoder);
  doc.conns.forEach((_, conn) => send(doc, conn, message));
};

/**
 * Our specialisation of the YDoc.
 */
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

/**
 *
 * @param {string} docname - The name of the document
 * @param {WebSocket} conn - the WebSocket connection being initiated
 * @param {object} env - the durable object environment object
 * @param {TransactionalStorage} storage - the durable object storage object
 * @param {boolean} gc - whether garbage collection is enabled
 * @returns The Yjs document object, which may be shared across multiple sockets.
 */
export const getYDoc = async (docname, conn, env, storage, gc = true) => {
  let doc = docs.get(docname);
  if (doc === undefined) {
    // The doc is not yet in the cache, create a new one.
    doc = new WSSharedDoc(docname);
    doc.gc = gc;
    docs.set(docname, doc);
  }

  if (!doc.conns.get(conn)) {
    doc.conns.set(conn, new Set());
  }

  // Store the service binding to da-admin which we receive through the environment in the doc
  doc.daadmin = env.daadmin;
  if (!doc.promise) {
    // The doc is not yet bound to the persistence layer, do so now. The promise will be resolved
    // when bound.
    doc.promise = persistence.bindState(docname, doc, conn, storage);
  }

  // We wait for the promise, for second and subsequent connections to the same doc, this will
  // already be resolved.
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
    showError(doc, err);
  }
};

/**
 * Invalidate the worker storage for the document, which will ensure that when accessed
 * the worker will fetch the latest version of the document from the da-admin.
 * Invalidation is implemented by closing all client connections to the doc, which will
 * cause it to be reinitialised when accessed.
 * @param {string} docName - The name of the document
 * @returns true if the document was found and invalidated, false otherwise.
 */
export const invalidateFromAdmin = async (docName) => {
  // eslint-disable-next-line no-console
  console.log('Invalidate from Admin received', docName);
  const ydoc = docs.get(docName);
  if (ydoc) {
    // As we are closing all connections, the ydoc will be removed from the docs map
    ydoc.conns.forEach((_, c) => closeConn(ydoc, c));

    return true;
  } else {
    // eslint-disable-next-line no-console
    console.log('Document not found', docName);
  }
  return false;
};

/**
 * Called when a new (Yjs) WebSocket connection is being established.
 * @param {WebSocket} conn - The WebSocket connection
 * @param {string} docName - The name of the document
 * @param {object} env - The durable object environment object
 * @param {TransactionalStorage} storage - The worker transactional storage object
 * @returns {Promise<void>} - The return value of this
 */
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

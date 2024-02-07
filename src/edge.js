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
// eslint-disable-next-line max-classes-per-file
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync.js';
import * as awarenessProtocol from 'y-protocols/awareness.js';

import * as encoding from 'lib0/encoding.js';
import * as decoding from 'lib0/decoding.js';
import debounce from 'lodash/debounce.js';

// This is the Edge Worker, built using Durable Objects!

// ===============================
// Required Environment
// ===============================
//
// This worker, when deployed, must be configured with an environment binding:
// * rooms: A Durable Object namespace binding mapped to the DocRoom class.

// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
// try/catch and return errors to the client. You probably wouldn't want to use this in production
// code but it is convenient when debugging and iterating.
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get('Upgrade') === 'websocket') {
      // Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
      // won't show us the response body! So... let's send a WebSocket response with an error
      // frame instead.
      // eslint-disable-next-line no-undef
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({ error: err.stack }));
      pair[1].close(1011, 'Uncaught exception during session setup');
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response(err.stack, { status: 500 });
  }
}

async function handleApiRequest(name, request, env) {
  // We've received at API request. Route the request based on the path.

  // Each Durable Object has a 256-bit unique ID. IDs can be derived from string names, or
  // chosen randomly by the system.
  const id = env.rooms.idFromName(name);

  // Get the Durable Object stub for this room! The stub is a client object that can be used
  // to send messages to the remote Durable Object instance. The stub is returned immediately;
  // there is no need to await it. This is important because you would not want to wait for
  // a network round trip before you could start sending requests. Since Durable Objects are
  // created on-demand when the ID is first used, there's nothing to wait for anyway; we know
  // an object will be available somewhere to receive our requests.
  const roomObject = env.rooms.get(id);

  // eslint-disable-next-line no-console
  console.log(`FETCHING: ${name} ${id}`);

  // Send the request to the object. The `fetch()` method of a Durable Object stub has the
  // same signature as the global `fetch()` function, but the request is always sent to the
  // object, regardless of the request's URL.
  return roomObject.fetch(new URL(request.url), request);
}

// In modules-syntax workers, we use `export default` to export our script's main event handlers.
export default {
  async fetch(request, env) {
    return handleErrors(request, async () => {
      // We have received an HTTP request!
      let name = request.url;
      if (request.url.indexOf('?') > 0) {
        name = name.substring(0, request.url.indexOf('?'));
      }
      return handleApiRequest(name, request, env);
    });
  },
};

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;

// disable gc when using snapshots!
const gcEnabled = false;

const persistence = {
  bindState: async (docName, ydoc, conn) => {
    const persistedYdoc = new Y.Doc();
    const aemMap = persistedYdoc.getMap('aem');
    aemMap.set('initial', conn.initial);
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));
    let last = aemMap.get('initial');
    ydoc.on('update', debounce(async () => {
      try {
        const content = ydoc.getMap('aem').get('content');
        if (last !== content) {
          last = content;
          const blob = new Blob([content], { type: 'text/html' });

          const formData = new FormData();
          formData.append('data', blob);

          const opts = { method: 'PUT', body: formData };
          const auth = Array.from(ydoc.conns.keys())
            .map((con) => con.auth);

          if (auth.length > 0) {
            opts.headers = new Headers({ Authorization: [...new Set(auth)].join(',') });
          }

          const put = await fetch(docName, opts);
          if (!put.ok) {
            throw new Error(`${put.status} - ${put.statusText}`);
          }
          // eslint-disable-next-line no-console
          console.log(content);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(err);
        ydoc.emit('error', [err]);
      }
    }, 2000, 10000));
  },
};

const docs = new Map();

const messageSync = 0;
const messageAwareness = 1;

const closeConn = (doc, conn) => {
  if (doc.conns.has(conn)) {
    const controlledIds = doc.conns.get(conn);
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null);
  }
  conn.close();
};

const send = (doc, conn, m) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn);
  }
  try {
    conn.send(m, (err) => err != null && closeConn(doc, conn));
  } catch (e) {
    closeConn(doc, conn);
  }
};

export const updateHandler = (update, _origin, doc) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeUpdate(encoder, update);
  const message = encoding.toUint8Array(encoder);
  doc.conns.forEach((_, conn) => send(doc, conn, message));
};

class WSSharedDoc extends Y.Doc {
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

const getYDoc = async (docname, conn, gc = true) => {
  let doc = docs.get(docname);
  if (doc === undefined) {
    doc = new WSSharedDoc(docname);
    doc.gc = gc;
    if (persistence !== null) {
      await persistence.bindState(docname, doc, conn);
    }
    docs.set(docname, doc);
  }
  return doc;
};

const messageListener = (conn, doc, message) => {
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

const setupWSConnection = async (conn, docName) => {
  // eslint-disable-next-line no-param-reassign
  conn.binaryType = 'arraybuffer';
  // get doc, initialize if it does not exist yet
  const doc = await getYDoc(docName, conn, true);
  // eslint-disable-next-line no-param-reassign
  conn.initial = undefined;
  doc.conns.set(conn, new Set());
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

// =======================================================================================
// The Durable Object Class

// Implements a Durable Object that coordinates an individual doc room. Participants
// connect to the room using WebSockets, and the room broadcasts messages from each participant
// to all others.
export class DocRoom {
  constructor(controller, env) {
    // `controller.storage` provides access to our durable storage. It provides a simple KV
    // get()/put() interface.
    this.storage = controller.storage;

    // `env` is our environment bindings (discussed earlier).
    this.env = env;
  }

  // The system will call fetch() whenever an HTTP request is sent to this Object. Such requests
  // can only be sent from other Worker code, such as the code above; these requests don't come
  // directly from the internet. In the future, we will support other formats than HTTP for these
  // communications, but we started with HTTP for its familiarity.
  async fetch(request) {
    return handleErrors(request, async () => {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 400 });
      }

      const auth = new URL(request.url).searchParams.get('Authorization');

      let docName = request.url.substring(new URL(request.url).origin.length + 1)
        .replace('https:/admin.da.live', 'https://admin.da.live')
        .replace('http:/localhost', 'http://localhost');

      if (docName.indexOf('?') > 0) {
        docName = docName.substring(0, docName.indexOf('?'));
      }

      // Make sure we only work with da.live or localhost
      if (!docName.startsWith('https://admin.da.live/')
          && !docName.startsWith('https://stage-admin.da.live/')
          && !docName.startsWith('http://localhost:')) {
        return new Response('unable to get resource', { status: 404 });
      }

      let initial = '';

      // Check if we have the authorization for the room (this is a poor man's solution as right now
      // only da-admin knows). As a side effect we can use the result as the initial value if the
      // room doesn't exist yet.
      try {
        const opts = {};
        if (auth) {
          opts.headers = new Headers({ Authorization: auth });
        }
        const initialReq = await fetch(docName, opts);
        if (initialReq.ok) {
          initial = await initialReq.text();
        } else if (initialReq.status !== 404) {
          // eslint-disable-next-line no-console
          console.log(`${initialReq.status} - ${initialReq.statusText}`);
          return new Response('unable to get resource', { status: initialReq.status });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(err);
        return new Response('unable to get resource', { status: 500 });
      }

      // To accept the WebSocket request, we create a WebSocketPair (which is like a socketpair,
      // i.e. two WebSockets that talk to each other), we return one end of the pair in the
      // response, and we operate on the other end. Note that this API is not part of the
      // Fetch API standard; unfortunately, the Fetch API / Service Workers specs do not define
      // any way to act as a WebSocket server today.
      // eslint-disable-next-line no-undef
      const pair = new WebSocketPair();

      // We're going to take pair[1] as our end, and return pair[0] to the client.
      await this.handleSession(pair[1], docName, auth, initial);

      // Now we return the other end of the pair to the client.
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

  // handleSession() implements our WebSocket-based protocol.
  // eslint-disable-next-line class-methods-use-this
  async handleSession(webSocket, docName, auth, initial) {
    // Accept our end of the WebSocket. This tells the runtime that we'll be terminating the
    // WebSocket in JavaScript, not sending it elsewhere.
    webSocket.accept();
    // eslint-disable-next-line no-param-reassign
    webSocket.auth = auth;
    // eslint-disable-next-line no-param-reassign
    webSocket.initial = initial;

    // eslint-disable-next-line no-console
    console.log(`GET ${docName} with auth(${webSocket.auth ? webSocket.auth.substring(0, webSocket.auth.indexOf(' ')) : 'none'})`);
    await setupWSConnection(webSocket, docName);
  }
}

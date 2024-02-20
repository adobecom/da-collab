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
import { invalidateFromAdmin, setupWSConnection } from './shareddoc.js';

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

async function syncAdmin(url, request, env) {
  const doc = url.searchParams.get('doc');
  if (!doc) {
    return new Response('Bad', { status: 400 });
  }

  // eslint-disable-next-line no-console
  console.log('Room name:', doc);
  const id = env.rooms.idFromName(doc);
  const roomObject = env.rooms.get(id);

  return roomObject.fetch(new URL(`${doc}?api=syncAdmin`));
}

async function handleApiCall(url, request, env) {
  switch (url.pathname) {
    case '/api/v1/syncadmin':
      return syncAdmin(url, request, env);
    default:
      return new Response('Bad Request', { status: 400 });
  }
}

export async function handleApiRequest(request, env) {
  // We've received at API request.
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    return handleApiCall(url, request, env);
  }

  const auth = url.searchParams.get('Authorization');

  // We need to massage the path somewhat because on connections from localhost safari sends
  // a path with only one slash for some reason.
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

  // Check if we have the authorization for the room (this is a poor man's solution as right now
  // only da-admin knows).
  try {
    const opts = { method: 'HEAD' };
    if (auth) {
      opts.headers = new Headers({ Authorization: auth });
    }
    const initialReq = await fetch(docName, opts);
    if (!initialReq.ok && initialReq.status !== 404) {
      // eslint-disable-next-line no-console
      console.log(`${initialReq.status} - ${initialReq.statusText}`);
      return new Response('unable to get resource', { status: initialReq.status });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(err);
    return new Response('unable to get resource', { status: 500 });
  }

  // Each Durable Object has a 256-bit unique ID. Route the request based on the path.
  const id = env.rooms.idFromName(docName);

  // Get the Durable Object stub for this room! The stub is a client object that can be used
  // to send messages to the remote Durable Object instance. The stub is returned immediately;
  // there is no need to await it. This is important because you would not want to wait for
  // a network round trip before you could start sending requests. Since Durable Objects are
  // created on-demand when the ID is first used, there's nothing to wait for anyway; we know
  // an object will be available somewhere to receive our requests.
  const roomObject = env.rooms.get(id);

  // eslint-disable-next-line no-console
  console.log(`FETCHING: ${docName} ${id}`);

  const headers = [...request.headers, ['X-collab-room', docName]];
  if (auth) {
    headers.push(['Authorization', auth]);
  }
  const req = new Request(new URL(docName), { headers });
  // Send the request to the object. The `fetch()` method of a Durable Object stub has the
  // same signature as the global `fetch()` function, but the request is always sent to the
  // object, regardless of the request's URL.
  return roomObject.fetch(req);
}

// In modules-syntax workers, we use `export default` to export our script's main event handlers.
export default {
  async fetch(request, env) {
    return handleErrors(request, async () => handleApiRequest(request, env));
  },
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

  static async handleApiCall(url, request) {
    const qidx = request.url.indexOf('?');
    const baseURL = request.url.substring(0, qidx);

    const api = url.searchParams.get('api');
    switch (api) {
      case 'syncAdmin':
        if (await invalidateFromAdmin(baseURL)) {
          return new Response('OK', { status: 200 });
        } else {
          return new Response('Not Found', { status: 404 });
        }
      default:
        return new Response('Invalid API', { status: 400 });
    }
  }

  // The system will call fetch() whenever an HTTP request is sent to this Object. Such requests
  // can only be sent from other Worker code, such as the code above; these requests don't come
  // directly from the internet. In the future, we will support other formats than HTTP for these
  // communications, but we started with HTTP for its familiarity.
  async fetch(request) {
    const url = new URL(request.url);
    if (url.search.startsWith('?api=')) {
      return DocRoom.handleApiCall(url, request);
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 400 });
    }
    const auth = request.headers.get('Authorization');
    const docName = request.headers.get('X-collab-room');

    if (!docName) {
      return new Response('expected docName', { status: 400 });
    }

    // To accept the WebSocket request, we create a WebSocketPair (which is like a socketpair,
    // i.e. two WebSockets that talk to each other), we return one end of the pair in the
    // response, and we operate on the other end. Note that this API is not part of the
    // Fetch API standard; unfortunately, the Fetch API / Service Workers specs do not define
    // any way to act as a WebSocket server today.
    // eslint-disable-next-line no-undef
    const pair = new WebSocketPair();

    // We're going to take pair[1] as our end, and return pair[0] to the client.
    await this.handleSession(pair[1], docName, auth);

    // Now we return the other end of the pair to the client.
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // handleSession() implements our WebSocket-based protocol.
  // eslint-disable-next-line class-methods-use-this
  async handleSession(webSocket, docName, auth) {
    // Accept our end of the WebSocket. This tells the runtime that we'll be terminating the
    // WebSocket in JavaScript, not sending it elsewhere.
    webSocket.accept();
    // eslint-disable-next-line no-param-reassign
    webSocket.auth = auth;
    // eslint-disable-next-line no-console
    console.log(`setupWSConnection ${docName} with auth(${webSocket.auth
      ? webSocket.auth.substring(0, webSocket.auth.indexOf(' ')) : 'none'})`);
    await setupWSConnection(webSocket, docName);
  }
}

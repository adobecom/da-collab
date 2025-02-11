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
export async function handleErrors(request, func) {
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
// Admin APIs are forwarded to the durable object. They need the doc name as a query
// parameter on the url.
async function adminAPI(api, url, request, env) {
  const doc = url.searchParams.get('doc');
  if (!doc) {
    return new Response('Bad', { status: 400 });
  }

  // eslint-disable-next-line no-console
  console.log('Room name:', doc);
  const id = env.rooms.idFromName(doc);
  const roomObject = env.rooms.get(id);

  return roomObject.fetch(new URL(`${doc}?api=${api}`));
}

// A simple Ping API to check that the worker responds.
function ping(env) {
  const adminsb = env.daadmin !== undefined ? '"da-admin"' : '';

  const json = `{
  "status": "ok",
  "service_bindings": [${adminsb}]
}
`;
  return new Response(json, { status: 200 });
}

/** Handle the API calls. Supported API calls right now are:
 * /ping - returns a simple JSON response to check that the worker is up.
 * /syncadmin - sync the doc state with the state of da-admin. Any internal state
 *              for this document in the worker is cleared.
 * /deleteadmin - the document is deleted and should be removed from the worker internal state.
 * @param {URL} url - The request url
 * @param {Request} request - The request object
 * @param {Object} env - The worker environment
 */
async function handleApiCall(url, request, env) {
  switch (url.pathname) {
    case '/api/v1/ping':
      return ping(env);
    case '/api/v1/syncadmin':
      return adminAPI('syncAdmin', url, request, env);
    case '/api/v1/deleteadmin':
      return adminAPI('deleteAdmin', url, request, env);
    default:
      return new Response('Bad Request', { status: 400 });
  }
}

// This is where the requests for the worker come in. They can either be pure API requests or
// requests to set up a session with a Durable Object through a Yjs WebSocket.
export async function handleApiRequest(request, env) {
  let timingDaAdminHeadDuration;
  const timingStartTime = Date.now();

  // We've received a pure API request - handle it and return.
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    return handleApiCall(url, request, env);
  }

  let authActions;
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

    const timingBeforeDaAdminHead = Date.now();
    const initialReq = await env.daadmin.fetch(docName, opts);
    timingDaAdminHeadDuration = Date.now() - timingBeforeDaAdminHead;

    if (!initialReq.ok && initialReq.status !== 404) {
      // eslint-disable-next-line no-console
      console.log(`${initialReq.status} - ${initialReq.statusText}`);
      return new Response('unable to get resource', { status: initialReq.status });
    }

    const daActions = initialReq.headers.get('X-da-actions') ?? '';
    [, authActions] = daActions.split('=');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(err);
    return new Response('unable to get resource', { status: 500 });
  }

  const timingBeforeDocRoomGet = Date.now();
  // Each Durable Object has a 256-bit unique ID. Route the request based on the path.
  const id = env.rooms.idFromName(docName);

  // Get the Durable Object stub for this room! The stub is a client object that can be used
  // to send messages to the remote Durable Object instance. The stub is returned immediately;
  // there is no need to await it. This is important because you would not want to wait for
  // a network round trip before you could start sending requests. Since Durable Objects are
  // created on-demand when the ID is first used, there's nothing to wait for anyway; we know
  // an object will be available somewhere to receive our requests.
  const roomObject = env.rooms.get(id);
  const timingDocRoomGetDuration = Date.now() - timingBeforeDocRoomGet;

  // eslint-disable-next-line no-console
  console.log(`FETCHING: ${docName} ${id}`);

  const headers = [...request.headers,
    ['X-collab-room', docName],
    ['X-timing-start', timingStartTime],
    ['X-timing-da-admin-head-duration', timingDaAdminHeadDuration],
    ['X-timing-docroom-get-duration', timingDocRoomGetDuration],
    ['X-auth-actions', authActions],
  ];
  if (auth) {
    headers.push(['Authorization', auth]);
  }
  const req = new Request(new URL(docName), { headers });
  // Send the request to the Durable Object. The `fetch()` method of a Durable Object stub has the
  // same signature as the global `fetch()` function, but the request is always sent to the
  // object, regardless of the hostname in the request's URL.
  return roomObject.fetch(req);
}

// In modules-syntax workers, we use `export default` to export our script's main event handlers.
// This is the main entry point for the worker.
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

  // Handle the API calls. Supported API calls right now are to sync the doc with the da-admin
  // state or to indicate that the document has been deleted from da-admin.
  // The implementation of these two is currently identical.
  // eslint-disable-next-line class-methods-use-this
  async handleApiCall(url, request) {
    const qidx = request.url.indexOf('?');
    const baseURL = request.url.substring(0, qidx);

    const api = url.searchParams.get('api');
    switch (api) {
      case 'deleteAdmin':
        if (await invalidateFromAdmin(baseURL)) {
          return new Response(null, { status: 204 });
        } else {
          return new Response('Not Found', { status: 404 });
        }
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

  // Isolated for testing
  static newWebSocketPair() {
    // eslint-disable-next-line no-undef
    return new WebSocketPair();
  }

  // The system will call fetch() whenever an HTTP request is sent to this Object. Such requests
  // can only be sent from other Worker code, such as the code above; these requests don't come
  // directly from the internet. In the future, we will support other formats than HTTP for these
  // communications, but we started with HTTP for its familiarity.
  //
  // Note that strangely enough in a unit testing env returning a Response with status 101 isn't
  // allowed by the runtime, so we can set an alternative 'success' code here for testing.
  async fetch(request, _opts, successCode = 101) {
    const url = new URL(request.url);

    // If it's a pure API call then handle it and return.
    if (url.search.startsWith('?api=')) {
      return this.handleApiCall(url, request);
    }

    // If we get here, we're expecting this to be a WebSocket request.
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 400 });
    }
    const auth = request.headers.get('Authorization');
    const authActions = request.headers.get('X-auth-actions') ?? '';
    const docName = request.headers.get('X-collab-room');

    if (!docName) {
      return new Response('expected docName', { status: 400 });
    }

    const timingBeforeSetupWebsocket = Date.now();
    // To accept the WebSocket request, we create a WebSocketPair (which is like a socketpair,
    // i.e. two WebSockets that talk to each other), we return one end of the pair in the
    // response, and we operate on the other end. Note that this API is not part of the
    // Fetch API standard; unfortunately, the Fetch API / Service Workers specs do not define
    // any way to act as a WebSocket server today.
    const pair = DocRoom.newWebSocketPair();

    // We're going to take pair[1] as our end, and return pair[0] to the client.
    const timingData = await this.handleSession(pair[1], docName, auth, authActions);
    const timingSetupWebSocketDuration = Date.now() - timingBeforeSetupWebsocket;

    const reqHeaders = request.headers;
    const respheaders = new Headers();
    respheaders.set('X-1-timing-da-admin-head-duration', reqHeaders.get('X-timing-da-admin-head-duration'));
    respheaders.set('X-2-timing-docroom-get-duration', reqHeaders.get('X-timing-docroom-get-duration'));
    respheaders.set('X-4-timing-da-admin-get-duration', timingData.get('timingDaAdminGetDuration'));
    respheaders.set('X-5-timing-read-state-duration', timingData.get('timingReadStateDuration'));
    respheaders.set('X-7-timing-setup-websocket-duration', timingSetupWebSocketDuration);
    respheaders.set('X-9-timing-full-duration', Date.now() - reqHeaders.get('X-timing-start'));

    // Now we return the other end of the pair to the client.
    return new Response(null, { status: successCode, headers: respheaders, webSocket: pair[0] });
  }

  /**
   * Implements our WebSocket-based protocol.
   * @param {WebSocket} webSocket - The WebSocket connection to the client
   * @param {string} docName - The document name
   * @param {string} auth - The authorization header
   */
  async handleSession(webSocket, docName, auth, authActions) {
    // Accept our end of the WebSocket. This tells the runtime that we'll be terminating the
    // WebSocket in JavaScript, not sending it elsewhere.
    webSocket.accept();
    // eslint-disable-next-line no-param-reassign
    webSocket.auth = auth;

    if (!authActions.split(',').includes('write')) {
      // eslint-disable-next-line no-param-reassign
      webSocket.readOnly = true;
    }
    // eslint-disable-next-line no-console
    console.log(`setupWSConnection ${docName} with auth(${webSocket.auth
      ? webSocket.auth.substring(0, webSocket.auth.indexOf(' ')) : 'none'})`);
    const timingData = await setupWSConnection(webSocket, docName, this.env, this.storage);
    return timingData;
  }
}

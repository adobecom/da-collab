const Y = require('yjs')
const syncProtocol = require('y-protocols/dist/sync.cjs')
const awarenessProtocol = require('y-protocols/dist/awareness.cjs')

const encoding = require('lib0/dist/encoding.cjs')
const decoding = require('lib0/dist/decoding.cjs')
const map = require('lib0/dist/map.cjs')

const debounce = require('lodash.debounce')

// This is the Edge Chat Demo Worker, built using Durable Objects!

// ===============================
// Introduction to Modules
// ===============================
//
// The first thing you might notice, if you are familiar with the Workers platform, is that this
// Worker is written differently from others you may have seen. It even has a different file
// extension. The `mjs` extension means this JavaScript is an ES Module, which, among other things,
// means it has imports and exports. Unlike other Workers, this code doesn't use
// `addEventListener("fetch", handler)` to register its main HTTP handler; instead, it _exports_
// a handler, as we'll see below.
//
// This is a new way of writing Workers that we expect to introduce more broadly in the future. We
// like this syntax because it is *composable*: You can take two workers written this way and
// merge them into one worker, by importing the two Workers' exported handlers yourself, and then
// exporting a new handler that call into the other Workers as appropriate.
//
// This new syntax is required when using Durable Objects, because your Durable Objects are
// implemented by classes, and those classes need to be exported. The new syntax can be used for
// writing regular Workers (without Durable Objects) too, but for now, you must be in the Durable
// Objects beta to be able to use the new syntax, while we work out the quirks.
//
// To see an example configuration for uploading module-based Workers, check out the wrangler.toml
// file or one of our Durable Object templates for Wrangler:
//   * https://github.com/cloudflare/durable-objects-template
//   * https://github.com/cloudflare/durable-objects-rollup-esm
//   * https://github.com/cloudflare/durable-objects-webpack-commonjs

// ===============================
// Required Environment
// ===============================
//
// This worker, when deployed, must be configured with an environment binding:
// * rooms: A Durable Object namespace binding mapped to the ChatRoom class.
//
// Incidentally, in pre-modules Workers syntax, "bindings" (like KV bindings, secrets, etc.)
// appeared in your script as global variables, but in the new modules syntax, this is no longer
// the case. Instead, bindings are now delivered in an "environment object" when an event handler
// (or Durable Object class constructor) is called. Look for the variable `env` below.
//
// We made this change, again, for composability: The global scope is global, but if you want to
// call into existing code that has different environment requirements, then you need to be able
// to pass the environment as a parameter instead.
//
// Once again, see the wrangler.toml file to understand how the environment is configured.

// =======================================================================================
// The regular Worker part...
//
// This section of the code implements a normal Worker that receives HTTP requests from external
// clients. This part is stateless.


// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
// try/catch and return errors to the client. You probably wouldn't want to use this in production
// code but it is convenient when debugging and iterating.
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      // Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
      // won't show us the response body! So... let's send a WebSocket response with an error
      // frame instead.
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack}));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, {status: 500});
    }
  }
}

// In modules-syntax workers, we use `export default` to export our script's main event handlers.
// Here, we export one handler, `fetch`, for receiving HTTP requests. In pre-modules workers, the
// fetch handler was registered using `addEventHandler("fetch", event => { ... })`; this is just
// new syntax for essentially the same thing.
//
// `fetch` isn't the only handler. If your worker runs on a Cron schedule, it will receive calls
// to a handler named `scheduled`, which should be exported here in a similar way. We will be
// adding other handlers for other types of events over time.
export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      // We have received an HTTP request! 
      let name = request.url;
      if (request.url.indexOf('?') > 0) {
        name = name.substring(0, request.url.indexOf('?'))
      }
      return handleApiRequest(name, request, env);
    });
  }
}


async function handleApiRequest(name, request, env) {
  // We've received at API request. Route the request based on the path.

      // Each Durable Object has a 256-bit unique ID. IDs can be derived from string names, or
      // chosen randomly by the system.
      let id = env.rooms.idFromName(name);
      
      // Get the Durable Object stub for this room! The stub is a client object that can be used
      // to send messages to the remote Durable Object instance. The stub is returned immediately;
      // there is no need to await it. This is important because you would not want to wait for
      // a network round trip before you could start sending requests. Since Durable Objects are
      // created on-demand when the ID is first used, there's nothing to wait for anyway; we know
      // an object will be available somewhere to receive our requests.
      let roomObject = env.rooms.get(id);

      console.log("FETCHING: " + name + " " + id);

      // Send the request to the object. The `fetch()` method of a Durable Object stub has the
      // same signature as the global `fetch()` function, but the request is always sent to the
      // object, regardless of the request's URL.
      return roomObject.fetch(new URL(request.url), request);
}

const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1
const wsReadyStateClosing = 2 // eslint-disable-line
const wsReadyStateClosed = 3 // eslint-disable-line

// disable gc when using snapshots!
const gcEnabled = false

/**
 * @type {{bindState: function(string,WSSharedDoc):Promise<void>, writeState:function(string,WSSharedDoc):Promise<any>, provider: any}|null}
 */
let persistence = {

    bindState: async (docName, ydoc, conn) => {

      const persistedYdoc = new Y.Doc();
      let initalReq;
      try {
        const opts = {};
        if (conn.auth) {
          opts.headers = new Headers({ 'Authorization' : conn.auth });
        }
        initalReq = await fetch(docName, opts);
      } catch (err) {
        console.log(err);
        throw err;
      }

      const aemMap = persistedYdoc.getMap("aem");
      if (initalReq.ok) {
        const inital = await initalReq.text();
        aemMap.set("initial", inital);
      } else if (initalReq.status === 404) {
        aemMap.set('initial', '');
      } else {
        throw `${initalReq.status} - ${initalReq.statusText}`;
      }
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc))
      let last = aemMap.get("initial");
      ydoc.on("update", debounce(async () => {
        try {
          const content = ydoc.getMap("aem").get("content");
          if (last !== content) {
            last = content;
            const blob = new Blob([content], { type: 'text/html' });

            const formData = new FormData();
            formData.append('data', blob);

            const opts = { method: 'PUT', body: formData };
            const auth = Array.from(ydoc.conns.keys())
              .map((con) => con.auth);

            if (auth.length > 0) {
              opts.headers = new Headers({ 'Authorization' : [...new Set(auth)].join(',') });
            }

            console.log(opts);

            const put = await fetch(docName, opts);
            if (!put.ok) {
              throw `${put.status} - ${put.statusText}`;
            }
            console.log(content);
          }
        } catch (err) {
          console.error(err)
          ydoc.emit('error', [err])
        }
      }, 2000, 10000));
    },
    writeState: async (docName, ydoc) => {}
  }



/**
 * @type {Map<string,WSSharedDoc>}
 */
const docs = new Map()

const messageSync = 0
const messageAwareness = 1
// const messageAuth = 2

/**
 * @param {Uint8Array} update
 * @param {any} origin
 * @param {WSSharedDoc} doc
 */
const updateHandler = (update, origin, doc) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeUpdate(encoder, update)
  const message = encoding.toUint8Array(encoder)
  doc.conns.forEach((_, conn) => send(doc, conn, message))
}

class WSSharedDoc extends Y.Doc {
  /**
   * @param {string} name
   */
  constructor (name) {
    super({ gc: gcEnabled })
    this.name = name
    /**
     * Maps from conn to set of controlled user ids. Delete all user ids from awareness when this conn is closed
     * @type {Map<Object, Set<number>>}
     */
    this.conns = new Map()
    /**
     * @type {awarenessProtocol.Awareness}
     */
    this.awareness = new awarenessProtocol.Awareness(this)
    this.awareness.setLocalState(null)
    /**
     * @param {{ added: Array<number>, updated: Array<number>, removed: Array<number> }} changes
     * @param {Object | null} conn Origin is the connection that made the change
     */
    const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
      const changedClients = added.concat(updated, removed)
      if (conn !== null) {
        const connControlledIDs = /** @type {Set<number>} */ (this.conns.get(conn))
        if (connControlledIDs !== undefined) {
          added.forEach(clientID => { connControlledIDs.add(clientID) })
          removed.forEach(clientID => { connControlledIDs.delete(clientID) })
        }
      }
      // broadcast awareness update
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients))
      const buff = encoding.toUint8Array(encoder)
      this.conns.forEach((_, c) => {
        send(this, c, buff)
      })
    }
    this.awareness.on('update', awarenessChangeHandler)
    this.on('update', updateHandler)
  }
}

/**
 * Gets a Y.Doc by name, whether in memory or on disk
 *
 * @param {string} docname - the name of the Y.Doc to find or create
 * @param {boolean} gc - whether to allow gc on the doc (applies only when created)
 * @return {WSSharedDoc}
 */
const getYDoc = async (docname, conn, gc = true) => {
  let doc = docs.get(docname)
  if (doc === undefined) {
    doc = new WSSharedDoc(docname)
    doc.gc = gc
    if (persistence !== null) {
      await persistence.bindState(docname, doc, conn)
    }
    docs.set(docname, doc)
  }
  return doc
}

/**
 * @param {any} conn
 * @param {WSSharedDoc} doc
 * @param {Uint8Array} message
 */
const messageListener = (conn, doc, message) => {
  try {
    const encoder = encoding.createEncoder()
    const decoder = decoding.createDecoder(message)
    const messageType = decoding.readVarUint(decoder)
    switch (messageType) {
      case messageSync:
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn)

        // If the `encoder` only contains the type of reply message and no
        // message, there is no need to send the message. When `encoder` only
        // contains the type of reply, its length is 1.
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder))
        }
        break
      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn)
        break
      }
    }
  } catch (err) {
    console.error(err)
    doc.emit('error', [err])
  }
}

/**
 * @param {WSSharedDoc} doc
 * @param {any} conn
 */
const closeConn = (doc, conn) => {
  if (doc.conns.has(conn)) {
    /**
     * @type {Set<number>}
     */
    // @ts-ignore
    const controlledIds = doc.conns.get(conn)
    doc.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null)
  }
  conn.close()
}

/**
 * @param {WSSharedDoc} doc
 * @param {any} conn
 * @param {Uint8Array} m
 */
const send = (doc, conn, m) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn)
  }
  try {
    conn.send(m, /** @param {any} err */ err => { err != null && closeConn(doc, conn) })
  } catch (e) {
    closeConn(doc, conn)
  }
}

/**
 * @param {any} conn
 * @param {any} req
 * @param {any} opts
 */
const setupWSConnection = async (conn, docName) => {
  conn.binaryType = 'arraybuffer'
  // get doc, initialize if it does not exist yet
  const doc = await getYDoc(docName, conn, true)
  doc.conns.set(conn, new Set())
  // listen and reply to events
  conn.addEventListener('message', /** @param {ArrayBuffer} message */ message => messageListener(conn, doc, new Uint8Array(message.data)))

  // Check if connection is still alive
  conn.addEventListener('close', () => {
    closeConn(doc, conn)
  })
  // put the following in a variables in a block so the interval handlers don't keep in in
  // scope
  {
    // send sync step 1
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeSyncStep1(encoder, doc)
    send(doc, conn, encoding.toUint8Array(encoder))
    const awarenessStates = doc.awareness.getStates()
    if (awarenessStates.size > 0) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys())))
      send(doc, conn, encoding.toUint8Array(encoder))
    }
  }
}

// =======================================================================================
// The ChatRoom Durable Object Class

// ChatRoom implements a Durable Object that coordinates an individual chat room. Participants
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
    return await handleErrors(request, async () => {
      if (request.headers.get("Upgrade") != "websocket") {
        return new Response("expected websocket", {status: 400});
      }

      // To accept the WebSocket request, we create a WebSocketPair (which is like a socketpair,
      // i.e. two WebSockets that talk to each other), we return one end of the pair in the
      // response, and we operate on the other end. Note that this API is not part of the
      // Fetch API standard; unfortunately, the Fetch API / Service Workers specs do not define
      // any way to act as a WebSocket server today.
      let pair = new WebSocketPair();

      // We're going to take pair[1] as our end, and return pair[0] to the client.
      await this.handleSession(request, pair[1]);

      // Now we return the other end of the pair to the client.
      return new Response(null, { status: 101, webSocket: pair[0] });
        
    });
  }

  // handleSession() implements our WebSocket-based chat protocol.
  async handleSession(request, webSocket) {
    // Accept our end of the WebSocket. This tells the runtime that we'll be terminating the
    // WebSocket in JavaScript, not sending it elsewhere.
    webSocket.accept();
    webSocket.auth = new URL(request.url).searchParams.get('Authorization')
    
    let docName = request.url.substring(new URL(request.url).origin.length + 1).replace('https:/admin.da.live', 'https://admin.da.live').replace('http:/localhost', 'http://localhost');
    if (docName.indexOf('?') > 0) {
      docName = docName.substring(0, docName.indexOf('?'))
    }
    console.log(`GET ${docName} with auth(${webSocket.auth ? webSocket.auth.substring(0, webSocket.auth.indexOf(' ')) : 'none'})`);
    await setupWSConnection(webSocket, docName);
  }
}
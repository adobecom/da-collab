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
import assert from 'assert';

import {
  closeConn, getYDoc, invalidateFromAdmin, messageListener, persistence, setupWSConnection, setYDoc, updateHandler, WSSharedDoc,
} from '../src/shareddoc.js';
import { uint8Array } from 'lib0/prng.js';

function isSubArray(full, sub) {
  if (sub.length === 0) {
    return true;
  }

  const candidateIdxs = [];
  for (let i = 0; i < full.length; i++) {
    if (full[i] === sub[0]) {
      candidateIdxs.push(i);
    }
  }

  nextCandidate:
  for (let i = 0; i < candidateIdxs.length; i++) {
    for (let j = 0; j < sub.length; j++) {
      if (sub[j] !== full[candidateIdxs[i] + j]) {
        break nextCandidate;
      }
    }
    return true;
  }

  return false;
}

function getAsciiChars(str) {
  const codes = [];

  const strArr = Array.from(str);
  for (const c of strArr) {
    codes.push(c.charCodeAt(0));
  }
  return codes;
}

describe('Collab Test Suite', () => {
  it('Test updateHandler', () => {
    const conn = {
      isClosed: false,
      message: null,
      readyState: 1, // wsReadyStateOpen
      has() {
        return true;
      },
      close() {
        this.isClosed = true;
      },
      send(m) {
        this.message = m;
      },
    };

    const deleted = [];
    const conns = {
      forEach(f) {
        f(null, conn);
      },
      has(c) {
        return c === conn;
      },
      get: () => 123,
      delete(id) { deleted.push(id); },
    };

    const update = new Uint8Array([21, 31]);
    const doc = { conns };

    updateHandler(update, null, doc);

    assert(conn.isClosed === false);
    assert.deepStrictEqual(deleted, []);
    assert.deepStrictEqual(update, conn.message.slice(-2));
  });

  it('Test updateHandler closes first', () => {
    const conn1 = {
      isClosed: false,
      message: null,
      readyState: 42, // unknown code, causes to close
      has() {
        return true;
      },
      close() {
        this.isClosed = true;
      },
      send(m) {
        this.message = m;
      },
    };
    const conn2 = { ...conn1 }; // clone conn1 into conn2

    // We have multiple connections here
    const fe = (func) => {
      func(null, conn1);
      func(null, conn2);
    };

    const deleted = [];
    const conns = {
      forEach: fe,
      has(c) {
        return c === conn1 || c === conn2;
      },
      get: () => 123,
      delete(id) { deleted.push(id); },
    };

    const update = new Uint8Array([99, 98, 97, 96]);
    const doc = { conns };

    updateHandler(update, null, doc);

    assert(conn1.isClosed === true);
    assert(conn2.isClosed === true);
    assert.deepStrictEqual(deleted, [conn1, conn2]);
    assert.deepStrictEqual(update, conn1.message.slice(-4));
    assert.deepStrictEqual(update, conn2.message.slice(-4));
  });

  it('Test persistence get ok', async () => {
    persistence.fetch = async (url, opts) => {
      assert.equal(url, 'foo');
      assert.equal(opts.method, undefined);
      assert(opts.headers === undefined);
      return { ok: true, text: async () => 'content', status: 200, statusText: 'OK' };
    };
    const result = await persistence.get('foo', undefined);
    assert.equal(result, 'content');
  });

  it('Test persistence get auth', async () => {
    persistence.fetch = async (url, opts) => {
      assert.equal(url, 'foo');
      assert.equal(opts.method, undefined);
      assert.equal(opts.headers.get('authorization'), 'auth');
      return { ok: true, text: async () => 'content', status: 200, statusText: 'OK' };
    };
    const result = await persistence.get('foo', 'auth');
    assert.equal(result, 'content');
  });

  it('Test persistence get 404', async () => {
    persistence.fetch = async (url, opts) => {
      assert.equal(url, 'foo');
      assert.equal(opts.method, undefined);
      assert.equal(opts.headers.get('authorization'), 'auth');
      return { ok: false, text: async () => { throw new Error(); }, status: 404, statusText: 'Not Found' };
    };
    const result = await persistence.get('foo', 'auth');
    assert.equal(result, '');
  });

  it('Test persistence get throws', async () => {
    persistence.fetch = async (url, opts) => {
      assert.equal(url, 'foo');
      assert.equal(opts.method, undefined);
      assert.equal(opts.headers.get('authorization'), 'auth');
      return { ok: false, text: async () => { throw new Error(); }, status: 500, statusText: 'Error' };
    };
    try {
      const result = await persistence.get('foo', 'auth');
      assert.fail("Expected get to throw");
    } catch (E) {
      // expected
    }
  });

  it('Test persistence put ok', async () => {
    persistence.fetch = async (url, opts) => {
      assert.equal(url, 'foo');
      assert.equal(opts.method, 'PUT');
      assert(opts.headers === undefined);
      assert.equal(await opts.body.get('data').text(), 'test');
      return { ok: true, status: 200, statusText: 'OK'};
    };
    const result = await persistence.put({ name: 'foo', conns: new Map()}, 'test');
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.statusText, 'OK');
  });

  it('Test persistence put auth', async () => {
    persistence.fetch = async (url, opts) => {
      assert.equal(url, 'foo');
      assert.equal(opts.method, 'PUT');
      assert.equal(opts.headers.get('authorization'), 'auth');
      assert.equal(opts.headers.get('X-DA-Initiator'), 'collab');
      assert.equal(await opts.body.get('data').text(), 'test');
      return { ok: false, status: 401, statusText: 'Unauth'};
    };
    const result = await persistence.put({ name: 'foo', conns: new Map().set({ auth: 'auth' }, new Set())}, 'test');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.statusText, 'Unauth');
  });

  it('Test persistence update does not put if no change', async () => {
    const docMap = new Map();
    docMap.set('content', 'Svr content');

    const mockYDoc = {
      conns: { keys() { return [ {} ] }},
      name: 'http://foo.bar/0/123.html',
      getMap(nm) { return nm === 'aem' ? docMap : null }
    };

    persistence.put = async (ydoc, content) => {
      assert.fail("update should not have happend");
    }

    const result = await persistence.update(mockYDoc, 'Svr content');
    assert.equal(result, 'Svr content');
  });

  it('Test persistence update does put if change', async () => {
    const docMap = new Map();
    docMap.set('content', 'Svr content update');

    const mockYDoc = {
      conns: { keys() { return [ {} ] }},
      name: 'http://foo.bar/0/123.html',
      getMap(nm) { return nm === 'aem' ? docMap : null }
    };

    let called = false;
    persistence.put = async (ydoc, content) => {
      assert.equal(ydoc, mockYDoc);
      assert.equal(content, 'Svr content update');
      called = true;
      return { ok: true, status: 201, statusText: 'Created'};
    }

    let calledCloseCon = false;
    persistence.closeConn = (doc, conn) => {
      calledCloseCon = true;
    }

    const result = await persistence.update(mockYDoc, 'Svr content');
    assert.equal(result, 'Svr content update');
    assert(called);
    assert(!calledCloseCon);
  });

  it('Test persistence update closes all on auth failure', async () => {
    const docMap = new Map();
    docMap.set('content', 'Svr content update');

    const mockYDoc = {
      conns: new Map().set('foo', 'bar'),
      name: 'http://foo.bar/0/123.html',
      getMap(nm) { return nm === 'aem' ? docMap : null },
      emit: () => {},
    };

    let called = false;
    persistence.put = async (ydoc, content) => {
      assert.equal(ydoc, mockYDoc);
      assert.equal(content, 'Svr content update');
      called = true;
      return { ok: false, status: 401, statusText: 'Unauthorized'};
    }

    let calledCloseCon = false;
    persistence.closeConn = (doc, conn) => {
      assert.equal(doc, mockYDoc);
      assert.equal(conn, 'foo');
      calledCloseCon = true;
    }

    const result = await persistence.update(mockYDoc, 'Svr content');
    assert.equal(result, 'Svr content');
    assert(called);
    assert(calledCloseCon);
  });

  it('Test invalidateFromAdmin', async () => {
    const oldFun = persistence.invalidate;

    const calledWith = [];
    const mockInvalidate = async (ydoc) => {
      calledWith.push(ydoc.name);
    }

    const mockYDoc = {};
    mockYDoc.name = 'http://blah.di.blah/a/ha.html';
    setYDoc(mockYDoc.name, mockYDoc);

    try {
      persistence.invalidate = mockInvalidate;

      assert.equal(0, calledWith.length, 'Precondition');
      assert(!await invalidateFromAdmin('http://foo.bar/123.html'));
      assert.equal(0, calledWith.length);

      assert(await invalidateFromAdmin('http://blah.di.blah/a/ha.html'));
      assert.deepStrictEqual(['http://blah.di.blah/a/ha.html'], calledWith);
    } finally {
      persistence.invalidate = oldFun;
    }
  });

  it('Test persistence invalidate', async () => {
    const conn1 = { auth: 'auth1' };
    const conn2 = { auth: 'auth2' };

    const docMap = new Map();
    docMap.set('content', 'Cli content');

    const mockYDoc = {
      conns: { keys() { return [ conn1, conn2 ] }},
      name: 'http://foo.bar/0/123.html',
      getMap(nm) { return nm === 'aem' ? docMap : null }
    };

    const getCalls = [];
    const mockGet = (docName, auth) => {
      getCalls.push(docName);
      getCalls.push(auth);
      return 'Svr content';
    };

    const savedGet = persistence.get;
    try {
      persistence.get = mockGet;
      await persistence.invalidate(mockYDoc);

      assert.equal('Svr content', docMap.get('svrinv'));
      assert.equal(2, getCalls.length);
      assert.equal('http://foo.bar/0/123.html', getCalls[0]);
      assert.equal(['auth1,auth2'], getCalls[1]);
    } finally {
      persistence.get = savedGet;
    }
  });

  it('Test persistence invalidate does nothing if client up to date', async () => {
    const docMap = new Map();
    docMap.set('content', 'Svr content');

    const mockYDoc = {
      conns: { keys() { return [ {} ] }},
      name: 'http://foo.bar/0/123.html',
      getMap(nm) { return nm === 'aem' ? docMap : null }
    };

    const getCalls = [];
    const mockGet = (docName, auth) => {
      getCalls.push(docName);
      getCalls.push(auth);
      return 'Svr content';
    };

    const savedGet = persistence.get;
    try {
      persistence.get = mockGet;
      await persistence.invalidate(mockYDoc);

      assert(docMap.get('svrinv') === undefined,
        'Update should not be sent to client');
    } finally {
      persistence.get = savedGet;
    }
  });

  it('Test close connection', async () => {
    const awarenessEmitted = []
    const mockDoc = {
      awareness: {
        emit(_, chg) { awarenessEmitted.push(chg); },
        name: 'http://foo.bar/q/r.html',
        states: new Map()
      },
      conns: new Map(),
    };
    mockDoc.awareness.states.set('123', null);
    const docs = setYDoc(mockDoc.name, mockDoc);

    const called = [];
    const mockConn = {
      close() { called.push('close'); }
    };
    const ids = new Set();
    ids.add('123');
    mockDoc.conns.set(mockConn, ids);

    assert.equal(0, called.length, 'Precondition');
    assert(docs.get(mockDoc.name), 'Precondition');
    closeConn(mockDoc, mockConn);
    assert.deepStrictEqual(['close'], called);
    assert.equal(0, mockDoc.conns.size);
    assert.deepStrictEqual(['123'], awarenessEmitted[0][0].removed,
      'removeAwarenessStates should be called');

    assert.equal(docs.get(mockDoc.name), undefined,
      'Document should be removed from global map');

    assert(docs.get(mockDoc.name) === undefined, 'Should have been removed from docs map');
  });

  it('Test close unknown connection', async () => {
    const mockDoc = {
      conns: new Map(),
    };

    const called = [];
    const mockConn = {
      close() { called.push('close'); }
    };

    assert.equal(0, called.length, 'Precondition');
    closeConn(mockDoc, mockConn);
    assert.deepStrictEqual(['close'], called);
  });

  it('Test bindState', async () => {
    const savedGet = persistence.get;
    const savedUpd = persistence.update;

    const docName = 'http://lalala.com/ha/ha/ha.html';
    const testYDoc = new Y.Doc();
    const mockConn = {
      auth: 'myauth'
    };

    try {
      persistence.get = async (nm, au) => `Get: ${nm}-${au}`;
      const updated = new Map();
      persistence.update = async (d, v) => updated.set(d, v);

      assert.equal(0, updated.size, 'Precondition');
      await persistence.bindState(docName, testYDoc, mockConn, 0, 0);

      assert.equal(testYDoc.getMap('aem').get('initial'),
        'Get: http://lalala.com/ha/ha/ha.html-myauth');
    } finally {
      persistence.get = savedGet;
      persistence.update = savedUpd;
    }
  })

  it('Test getYDoc', async () => {
    const savedBS = persistence.bindState;

    try {
      const bsCalls = [];
      persistence.bindState = (dn, d, c) => {
        bsCalls.push({dn, d, c});
      };

      const docName = 'http://www.acme.org/somedoc.html';
      const mockConn = {};

      assert.equal(0, bsCalls.length, 'Precondition');
      const doc = await getYDoc(docName, mockConn);
      assert.equal(1, bsCalls.length);
      assert.equal(bsCalls[0].dn, docName);
      assert.equal(bsCalls[0].d, doc);
      assert.equal(bsCalls[0].c, mockConn);

      const doc2 = await getYDoc(docName, mockConn);
      assert.equal(1, bsCalls.length, 'Should not have called bindstate again');
      assert.equal(doc, doc2);
    } finally {
      persistence.bindState = savedBS;
    }
  });

  it('Test WSSharedDoc', () => {
    const doc = new WSSharedDoc('hello');
    assert.equal(doc.name, 'hello');
    assert.equal(doc.awareness.getLocalState(), null);

    const conn = {
      isClosed: false,
      message: null,
      readyState: 1, // wsReadyStateOpen
      has() {
        return true;
      },
      close() {
        this.isClosed = true;
      },
      send(m) {
        this.message = m;
      },
    };

    doc.conns.set(conn, 'conn1');
    doc.awareness.setLocalState('foo');
    assert(conn.isClosed === false);
    const fooAsUint8Arr = new Uint8Array(getAsciiChars('foo'));
    assert(isSubArray(conn.message, fooAsUint8Arr));
  });

  it('Test WSSharedDoc awarenessHandler', () => {
    const docName = 'http://a.b.c/d.html';

    const doc = new WSSharedDoc(docName);
    doc.awareness.setLocalState('barrr');

    assert.deepStrictEqual([updateHandler], Array.from(doc._observers.get('update')));
    const ah = Array.from(doc.awareness._observers.get('update'));
    assert.equal(1, ah.length);

    assert.equal(0, doc.conns.size, 'Should not yet be any connections');

    const sentMessages = [];
    const mockConn = {
      readyState: 1, // wsReadyStateOpen
      send(m, e) { sentMessages.push({m, e}); }
    };
    doc.conns.set(mockConn, new Set());

    ah[0]({added: [], updated: [doc.clientID], removed: []}, mockConn);

    const barrAsUint8Arr = new Uint8Array(getAsciiChars('barrr'));
    assert(isSubArray(sentMessages[0].m, barrAsUint8Arr));
  });

  it('Test setupWSConnection', async () => {
    const savedBind = persistence.bindState;

    try {
      const bindCalls = [];
      persistence.bindState = (nm, d, c) => bindCalls.push({nm, d, c});

      const docName = 'https://somewhere.com/somedoc.html';
      const eventListeners = new Map();
      const closeCalls = [];
      const mockConn = {
        addEventListener(msg, fun) { eventListeners.set(msg, fun); },
        close() { closeCalls.push('close'); },
        readyState: 1, // wsReadyStateOpen
        send() {}
      };

      assert.equal(0, bindCalls.length, 'Precondition');
      assert.equal(0, eventListeners.size, 'Precondition');
      await setupWSConnection(mockConn, docName);

      assert.equal('arraybuffer', mockConn.binaryType);
      assert.equal(1, bindCalls.length);
      assert.equal(docName, bindCalls[0].nm);
      assert.equal(docName, bindCalls[0].d.name);
      assert.equal(mockConn, bindCalls[0].c);

      const closeLsnr = eventListeners.get('close');
      assert(closeLsnr);
      const messageLsnr = eventListeners.get('message');
      assert(messageLsnr);
      // TODO maybe test more around the message listener?

      assert.equal(0, closeCalls.length, 'Should not yet have recorded any close calls');
      closeLsnr();
      assert.deepStrictEqual(['close'], closeCalls);
    } finally {
      persistence.bindState = savedBind;
    }
  });

  it('Test setupWSConnection sync step 1', async () => {
    const savedBind = persistence.bindState;

    try {
      persistence.bindState = (nm, d, c) => {};

      const docName = 'https://somewhere.com/mydoc.html';
      const closeCalls = [];
      const sendCalls = [];
      const mockConn = {
        addEventListener() {},
        close() { closeCalls.push('close'); },
        readyState: 1, // wsReadyStateOpen
        send(m, e) { sendCalls.push({m, e}); }
      };

      const awarenessStates = new Map();
      awarenessStates.set('foo', 'blahblahblah');
      const awareness = {
        getStates: () => awarenessStates,
        meta: awarenessStates,
        states: awarenessStates
      };

      const ydoc = await getYDoc(docName, mockConn, true);
      ydoc.awareness = awareness;

      await setupWSConnection(mockConn, docName);

      assert.equal(0, closeCalls.length);
      assert.equal(2, sendCalls.length);
      assert.deepStrictEqual([0, 0, 1, 0], Array.from(sendCalls[0].m));
      assert(isSubArray(sendCalls[1].m, getAsciiChars('blahblahblah')));
    } finally {
      persistence.bindState = savedBind;
    }
  });

  it('Test message listener Sync', () => {
    const connSent = []
    const conn = {
      readyState: 0, // wsReadyState
      send(m, r) { connSent.push({m, r}); }
    };

    const emitted = []
    const doc = new Y.Doc();
    doc.emit = (t, e) => emitted.push({t, e});
    doc.getMap('foo').set('bar', 'hello');

    const message = [0, 0, 1, 0];

    messageListener(conn, doc, new Uint8Array(message));
    assert.equal(1, connSent.length);
    assert(isSubArray(connSent[0].m, new Uint8Array(getAsciiChars('hello'))));

    for (let i = 0; i < emitted.length; i++) {
      assert(emitted[i].t !== 'error');
    }
  });

  it('Test message listener awareness', () => {
    // A fabricated message
    const message = [
      1, 247, 1, 1, 187, 143, 251, 213, 14, 21, 238, 1, 123, 34, 99, 117, 114, 115, 111,
      114, 34, 58, 123, 34, 97, 110, 99, 104, 111, 114, 34, 58, 123, 34, 116, 121, 112,
      101, 34, 58, 123, 34, 99, 108, 105, 101, 110, 116, 34, 58, 51, 49, 51, 52, 57, 50,
      57, 54, 56, 55, 44, 34, 99, 108, 111, 99, 107, 34, 58, 49, 57, 125, 44, 34, 116,
      110, 97, 109, 101, 34, 58, 110, 117, 108, 108, 44, 34, 105, 116, 101, 109, 34, 58,
      123, 34, 99, 108, 105, 101, 110, 116, 34, 58, 51, 49, 51, 52, 57, 50, 57, 54, 56,
      55, 44, 34, 99, 108, 111, 99, 107, 34, 58, 50, 48, 125, 44, 34, 97, 115, 115, 111,
      99, 34, 58, 48, 125, 44, 34, 104, 101, 97, 100, 34, 58, 123, 34, 116, 121, 112,
      101, 34, 58, 123, 34, 99, 108, 105, 101, 110, 116, 34, 58, 51, 49, 51, 52, 57, 50,
      57, 54, 56, 55, 44, 34, 99, 108, 111, 99, 107, 34, 58, 49, 57, 125, 44, 34, 116,
      110, 97, 109, 101, 34, 58, 110, 117, 108, 108, 44, 34, 105, 116, 101, 109, 34, 58,
      123, 34, 99, 108, 105, 101, 110, 116, 34, 58, 51, 49, 51, 52, 57, 50, 57, 54, 56,
      55, 44, 34, 99, 108, 111, 99, 107, 34, 58, 50, 48, 125, 44, 34, 97, 115, 115, 111,
      99, 34, 58, 48, 125, 125, 125 ];

      const awarenessEmitted = [];
      const awareness = {
        emit(t, d) { awarenessEmitted.push({t, d}); },
        meta: new Map(),
        states: new Map()
      };

      const docEmitted = [];
      const doc = new Y.Doc();
      doc.awareness = awareness;
      doc.emit = (t, e) => docEmitted.push({t, e});

      const conn = {};
      messageListener(conn, doc, new Uint8Array(message));

      assert(awarenessEmitted.length > 0);
      for (let i = 0; i < awarenessEmitted.length; i++) {
        assert(awarenessEmitted[i].t === 'change' ||
          awarenessEmitted[i].t === 'update');
        assert.deepStrictEqual([3938371515], awarenessEmitted[i].d[0].added)
        assert.equal(awarenessEmitted[i].d[1], conn);
      }

      for (let i = 0; i < docEmitted.length; i++) {
        assert(docEmitted[i].t !== 'error');
      }
    });
});

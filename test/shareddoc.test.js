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
import esmock from 'esmock';

import {
  closeConn, getYDoc, invalidateFromAdmin, messageListener, persistence,
  readState, setupWSConnection, setYDoc, showError, storeState, updateHandler, WSSharedDoc,
} from '../src/shareddoc.js';
import { aem2doc, doc2aem } from '../src/collab.js';

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

function wait(milliseconds) {
  return new Promise((r) => {
    setTimeout(r, milliseconds);
  });
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
      readyState: 42, // unknown code, causes to close
      has() {
        return true;
      },
      close() {
        this.isClosed = true;
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
  });

  it('Test persistence get ok', async () => {
    const daadmin = {};
    daadmin.fetch = async (url, opts) => {
      assert.equal(url, 'foo');
      assert.equal(opts.method, undefined);
      assert(opts.headers === undefined);
      return { ok: true, text: async () => 'content', status: 200, statusText: 'OK' };
    };
    const result = await persistence.get('foo', undefined, daadmin);
    assert.equal(result, 'content');
  });

  it('Test persistence get auth', async () => {
    const daadmin = {};
    daadmin.fetch = async (url, opts) => {
      assert.equal(url, 'foo');
      assert.equal(opts.method, undefined);
      assert.equal(opts.headers.get('authorization'), 'auth');
      return { ok: true, text: async () => 'content', status: 200, statusText: 'OK' };
    };
    const result = await persistence.get('foo', 'auth', daadmin);
    assert.equal(result, 'content');
  });

  it('Test persistence get 404', async () => {
    const daadmin = {};
    daadmin.fetch = async (url, opts) => {
      assert.equal(url, 'foo');
      assert.equal(opts.method, undefined);
      assert.equal(opts.headers.get('authorization'), 'auth');
      return { ok: false, text: async () => { throw new Error(); }, status: 404, statusText: 'Not Found' };
    };
    const result = await persistence.get('foo', 'auth', daadmin);
    assert.equal(result, null);
  });

  it('Test persistence get throws', async () => {
    const daadmin = {};
    daadmin.fetch = async (url, opts) => {
      assert.equal(url, 'foo');
      assert.equal(opts.method, undefined);
      assert.equal(opts.headers.get('authorization'), 'auth');
      return { ok: false, text: async () => { throw new Error(); }, status: 500, statusText: 'Error' };
    };
    try {
      const result = await persistence.get('foo', 'auth', daadmin);
      assert.fail("Expected get to throw");
    } catch (error) {
      // expected
      assert(error.toString().includes('unable to get resource - status: 500'));
    }
  });

  it('Test persistence put ok', async () => {
    const daadmin = {};
    daadmin.fetch = async (url, opts) => {
      assert.equal(url, 'foo');
      assert.equal(opts.method, 'PUT');
      assert(opts.headers === undefined);
      assert.equal(await opts.body.get('data').text(), 'test');
      return { ok: true, status: 200, statusText: 'OK'};
    };
    const result = await persistence.put({ name: 'foo', conns: new Map(), daadmin }, 'test');
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.statusText, 'OK');
  });

  it('Test persistence put auth', async () => {
    const daadmin = {};
    daadmin.fetch = async (url, opts) => {
      assert.equal(url, 'foo');
      assert.equal(opts.method, 'PUT');
      assert.equal(opts.headers.get('authorization'), 'auth');
      assert.equal(opts.headers.get('X-DA-Initiator'), 'collab');
      assert.equal(await opts.body.get('data').text(), 'test');
      return { ok: false, status: 200, statusText: 'okidoki'};
    };
    const result = await persistence.put({
      name: 'foo',
      conns: new Map().set({ auth: 'auth', authActions: ['read', 'write'] }, new Set()),
      daadmin
    }, 'test');
    assert.equal(result.ok, false);
    assert.equal(result.status, 200);
    assert.equal(result.statusText, 'okidoki');
  });

  it('Test persistence put auth no perm', async () => {
    const daadmin = {};
    daadmin.fetch = async (url, opts) => {
      assert.equal(url, 'bar');
      assert.equal(opts.method, 'PUT');
      assert(!opts.headers);
      assert.equal(await opts.body.get('data').text(), 'toast');
      return { ok: false, status: 401, statusText: 'Unauth'};
    };
    const result = await persistence.put({
      name: 'bar',
      conns: new Map().set({ auth: 'auth', readOnly: true }, new Set()),
      daadmin
    }, 'toast');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.statusText, 'Unauth');
  });

  it('Test persistence update does not put if no change', async () => {
    const mockDoc2Aem = () => 'Svr content';
    const pss = await esmock(
      '../src/shareddoc.js', {
        '../src/collab.js': {
          doc2aem: mockDoc2Aem
        }
      });

    pss.persistence.put = async (ydoc, content) => {
      assert.fail("update should not have happend");
    }

    const mockYDoc = {
      conns: { keys() { return [ {} ] }},
      name: 'http://foo.bar/0/123.html',
    };

    pss.persistence.put = async (ydoc, content) => {
      assert.fail("update should not have happend");
    }

    const result = await pss.persistence.update(mockYDoc, 'Svr content');
    assert.equal(result, 'Svr content');
  });

  it('Test persistence update does put if change', async () => {
    const mockDoc2Aem = () => 'Svr content update';
    const pss = await esmock(
      '../src/shareddoc.js', {
        '../src/collab.js': {
          doc2aem: mockDoc2Aem
        }
      });

    const mockYDoc = {
      conns: { keys() { return [ {} ] }},
      name: 'http://foo.bar/0/123.html',
    };

    let called = false;
    pss.persistence.put = async (ydoc, content) => {
      assert.equal(ydoc, mockYDoc);
      assert.equal(content, 'Svr content update');
      called = true;
      return { ok: true, status: 201, statusText: 'Created'};
    }

    let calledCloseCon = false;
    pss.persistence.closeConn = (doc, conn) => {
      calledCloseCon = true;
    }

    const result = await pss.persistence.update(mockYDoc, 'Svr content');
    assert.equal(result, 'Svr content update');
    assert(called);
    assert(!calledCloseCon);
  });

  it('Test persistence update closes all on auth failure', async () => {
    const mockDoc2Aem = () => 'Svr content update';
    const pss = await esmock(
      '../src/shareddoc.js', {
        '../src/collab.js': {
          doc2aem: mockDoc2Aem
        }
      });

    const mockYDoc = {
      conns: new Map().set('foo', 'bar'),
      name: 'http://foo.bar/0/123.html',
      getMap(nm) { return nm === 'error' ? new Map() : null },
      transact: (f) => f(),
    };

    let called = false;
    pss.persistence.put = async (ydoc, content) => {
      assert.equal(ydoc, mockYDoc);
      assert.equal(content, 'Svr content update');
      called = true;
      return { ok: false, status: 401, statusText: 'Unauthorized'};
    }

    let calledCloseCon = false;
    pss.persistence.closeConn = (doc, conn) => {
      assert.equal(doc, mockYDoc);
      assert.equal(conn, 'foo');
      calledCloseCon = true;
    }

    const result = await pss.persistence.update(mockYDoc, 'Svr content');
    assert.equal(result, 'Svr content');
    assert(called);
    assert(calledCloseCon);
  });

  it('Test invalidateFromAdmin', async () => {
    const docName = 'http://blah.di.blah/a/ha.html';

    const closeCalled = [];
    const conn1 = { close: () => closeCalled.push('close1') };
    const conn2 = { close: () => closeCalled.push('close2') };
    const conns = new Map();
    conns.set(conn1, new Set());
    conns.set(conn2, new Set());

    const testYDoc = new WSSharedDoc(docName);
    testYDoc.conns = conns;

    const m = setYDoc(docName, testYDoc);

    assert(m.has(docName), 'Precondition');
    invalidateFromAdmin(docName);
    assert(!m.has(docName), 'Document should have been removed from global map');

    const res1 = ['close1', 'close2'];
    const res2 = ['close2', 'close1'];
    assert(res1.toString() === closeCalled.toString()
      || res2.toString() === closeCalled.toString());
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

  it('Test bindState read from da-admin', async () => {
    const aem2DocCalled = [];
    const mockAem2Doc = (sc, yd) => aem2DocCalled.push(sc, yd);
    const pss = await esmock(
      '../src/shareddoc.js', {
        '../src/collab.js': {
          aem2doc: mockAem2Doc,
        }
      });

    const docName = 'http://lalala.com/ha/ha/ha.html';
    const testYDoc = new Y.Doc();
    testYDoc.daadmin = 'daadmin';
    const mockConn = {
      auth: 'myauth',
      authActions: ['read']
    };
    pss.setYDoc(docName, testYDoc);

    const mockStorage = { list: () => new Map() };

    pss.persistence.get = async (nm, au, ad) => `Get: ${nm}-${au}-${ad}`;
    const updated = new Map();
    pss.persistence.update = async (d, v) => updated.set(d, v);

    assert.equal(0, updated.size, 'Precondition');
    await pss.persistence.bindState(docName, testYDoc, mockConn, mockStorage);

    assert.equal(0, aem2DocCalled.length, 'Precondition, it\'s important to handle the doc setting async');

    // give the async methods a change to finish
    await wait(1500);

    assert.equal(2, aem2DocCalled.length);
    assert.equal('Get: http://lalala.com/ha/ha/ha.html-myauth-daadmin', aem2DocCalled[0]);
    assert.equal(testYDoc, aem2DocCalled[1]);
  }).timeout(5000);

  it('Test bindState gets empty doc on da-admin 404', async() => {
    const mockdebounce = (f) => async () => await f();
    const pss = await esmock(
      '../src/shareddoc.js', {
        'lodash/debounce.js': {
          default: mockdebounce
        }
      });

    const docName = 'http://foobar.com/mydoc.html';

    const ydocUpdateCB = [];
    const testYDoc = new Y.Doc();
    testYDoc.on = (ev, f) => { if (ev === 'update') ydocUpdateCB.push(f); }
    pss.setYDoc(docName, testYDoc);

    const called = []
    const mockStorage = {
      deleteAll: async () => called.push('deleteAll'),
      list: async () => new Map(),
    };

    // When da-admin returns 404, get returns null
    pss.persistence.get = async () => null;
    const updateCalled = [];
    pss.persistence.update = async (_, cur)  => updateCalled.push(cur);

    const savedSetTimeout = globalThis.setTimeout;
    const setTimeoutCalls = []
    try {
      globalThis.setTimeout = () => setTimeoutCalls.push('setTimeout');

      await pss.persistence.bindState(docName, testYDoc, {}, mockStorage);
    } finally {
      globalThis.setTimeout = savedSetTimeout;
    }

    assert.deepStrictEqual(['deleteAll'], called);
    assert.equal(0, setTimeoutCalls.length,
      'Should not have called setTimeout as there is no document to restore from da-admin');

    assert.equal(0, updateCalled.length, 'Precondition');
    assert.equal(2, ydocUpdateCB.length);

    await ydocUpdateCB[0]();
    await ydocUpdateCB[1]();
    assert.deepStrictEqual(['<main></main>'], updateCalled);
  });

  it('Test bindstate read from worker storage', async () => {
    const docName = 'https://admin.da.live/source/foo/bar.html';

    // Prepare the (mocked) storage
    const testDoc = new Y.Doc();
    testDoc.getMap('foo').set('someattr', 'somevalue');
    const storedYDoc = Y.encodeStateAsUpdate(testDoc);
    const stored = new Map();
    stored.set('docstore', storedYDoc);
    stored.set('doc', docName);

    // Create a new YDoc which will be initialised from storage
    const ydoc = new Y.Doc();
    const conn = {};
    const storage = { list: async () => stored };

    const savedGet = persistence.get;
    try {
      persistence.get = (d) => {
        if (d === docName) {
          return `
<body>
  <header></header>
  <main><div></div></main>
  <footer></footer>
</body>
`;
        }
      };

      await persistence.bindState(docName, ydoc, conn, storage);

      assert.equal('somevalue', ydoc.getMap('foo').get('someattr'));
    } finally {
      persistence.get = savedGet;
    }
  });

  it('Test bindstate falls back to daadmin on worker storage error', async () => {
    const docName = 'https://admin.da.live/source/foo/bar.html';
    const ydoc = new Y.Doc();
    setYDoc(docName, ydoc);

    const storage = { list: async () => { throw new Error('yikes') } };

    const savedGet = persistence.get;
    const savedSetTimeout = globalThis.setTimeout;
    try {
      globalThis.setTimeout = (f) => f(); // run timeout method instantly

      persistence.get = async () => `
        <body>
        <header></header>
        <main><div>From daadmin</div></main>
        <footer></footer>
        </body>`;
      await persistence.bindState(docName, ydoc, {}, storage);

      assert(doc2aem(ydoc).includes('<div><p>From daadmin</p></div>'));
    } finally {
      persistence.get = savedGet;
      globalThis.setTimeout = savedSetTimeout;
    }
  });

  it('test persistence update on storage update', async () => {
    const mockdebounce = (f) => async () => await f();
    const pss = await esmock(
      '../src/shareddoc.js', {
        'lodash/debounce.js': {
          default: mockdebounce
        }
      });

    const docName = 'https://admin.da.live/source/foo/bar.html';
    const storage = { list: async () => new Map() };
    const updObservers = [];
    const ydoc = new Y.Doc();
    ydoc.on = (ev, fun) => {
      if (ev === 'update') {
        updObservers.push(fun);
      }
    };
    pss.setYDoc(docName, ydoc);

    const savedSetTimeout = globalThis.setTimeout;
    const savedGet = pss.persistence.get;
    const savedPut = pss.persistence.put;
    try {
      globalThis.setTimeout = (f) => {
        // Restore the global function
        globalThis.setTimeout = savedSetTimeout;
        f();
      };

      pss.persistence.get = async () => '<main><div>oldcontent</div></main>';
      const putCalls = []
      pss.persistence.put = async (yd, c) => {
        if (yd === ydoc && c.includes('newcontent')) {
          putCalls.push(c);
          return { ok: true, status: 200 };
        }
      };

      await pss.persistence.bindState(docName, ydoc, {}, storage);

      aem2doc('<main><div>newcontent</div></main>', ydoc);

      assert.equal(2, updObservers.length);
      await updObservers[0]();
      await updObservers[1]();
      assert.equal(1, putCalls.length);
      assert.equal(`<body>
  <header></header>
  <main><div><p>newcontent</p></div></main>
  <footer></footer>
</body>`, putCalls[0].trim());
    } finally {
      globalThis.setTimeout = savedSetTimeout;
      pss.persistence.get = savedGet;
      pss.persistence.put = savedPut;
    }
  });

  it('test bind to new doc doesnt set empty server content', async () => {
    const docName = 'https://admin.da.live/source/foo.html';

    const serviceBinding = {
      fetch: async (u) => {
        if (u === docName) {
          return { status: 404 };
        }
      }
    };

    const ydoc = new Y.Doc();
    ydoc.daadmin = serviceBinding;
    setYDoc(docName, ydoc);
    const conn = {};
    const storage = {
      deleteAll: async () => {},
      list: async () => new Map(),
    };

    const setTimeoutCalled = [];
    const savedSetTimeout = globalThis.setTimeout;
    try {
      globalThis.setTimeout = (f) => {
        // Restore the global function
        globalThis.setTimeout = savedSetTimeout;
        setTimeoutCalled.push('setTimeout');
        f();
      };

      await persistence.bindState(docName, ydoc, conn, storage);
      assert.equal(0, setTimeoutCalled.length, 'SetTimeout should not have been called');
    } finally {
      globalThis.setTimeout = savedSetTimeout;
    }
  });

  it('test bind to empty doc that was stored before updates ydoc', async () => {
    const docName = 'https://admin.da.live/source/foo.html';

    const serviceBinding = {
      fetch: async (u) => {
        if (u === docName) {
          return { status: 404 };
        }
      }
    };

    const ydoc = new Y.Doc();
    ydoc.daadmin = serviceBinding;
    setYDoc(docName, ydoc);
    const conn = {};

    const deleteAllCalled = [];
    const stored = new Map();
    stored.set('docstore', new Uint8Array([254, 255]));
    stored.set('chunks', 17); // should be ignored
    stored.set('doc', docName);
    const storage = {
      deleteAll: async () => deleteAllCalled.push(true),
      list: async () => stored,
    };

    const setTimeoutCalled = [];
    const savedSetTimeout = globalThis.setTimeout;
    try {
      globalThis.setTimeout = (f) => {
        // Restore the global function
        globalThis.setTimeout = savedSetTimeout;
        setTimeoutCalled.push('setTimeout');
        f();
      };

      await persistence.bindState(docName, ydoc, conn, storage);
      assert.deepStrictEqual([true], deleteAllCalled);
      assert.equal(1, setTimeoutCalled.length, 'SetTimeout should have been called to update the doc');
    } finally {
      globalThis.setTimeout = savedSetTimeout;
    }
  });

  it('test persist state in worker storage on update', async () => {
    const docName = 'https://admin.da.live/source/foo/bar.html';

    const updObservers = [];
    const ydoc = new Y.Doc();
    // mock out the 'on' function on the ydoc
    ydoc.on = (ev, fun) => {
      if (ev === 'update') {
        updObservers.push(fun);
      }
    };
    setYDoc(docName, ydoc);

    const conn = {};
    const called = [];
    const storage = {
      deleteAll: async () => called.push('deleteAll'),
      list: async () => new Map(),
      put: async (obj) => called.push(obj)
    };

    const savedSetTimeout = globalThis.setTimeout;
    const savedGet = persistence.get;
    try {
      globalThis.setTimeout = (f) => {
        // Restore the global function
        globalThis.setTimeout = savedSetTimeout;
        f();
      };
      persistence.get = async () => '<main><div>myinitial</div></main>';

      await persistence.bindState(docName, ydoc, conn, storage);
      assert(doc2aem(ydoc).includes('myinitial'));
      assert.equal(2, updObservers.length);

      ydoc.getMap('yah').set('a', 'bcd');
      await updObservers[0]();
      await updObservers[1]();

      // check that it was stored
      assert.equal(2, called.length);
      assert.equal('deleteAll', called[0]);

      const ydoc2 = new Y.Doc();
      Y.applyUpdate(ydoc2, called[1].docstore);

      assert.equal('bcd', ydoc2.getMap('yah').get('a'));
      assert(doc2aem(ydoc2).includes('myinitial'));
    } finally {
      globalThis.setTimeout = savedSetTimeout;
      persistence.get = savedGet;
    }
  });

  it('Test getYDoc', async () => {
    const savedBS = persistence.bindState;

    try {
      const bsCalls = [];
      persistence.bindState = async (dn, d, c) => {
        bsCalls.push({dn, d, c});
      };

      const docName = 'http://www.acme.org/somedoc.html';
      const mockConn = {};

      assert.equal(0, bsCalls.length, 'Precondition');
      const doc = await getYDoc(docName, mockConn, {}, {});
      assert.equal(1, bsCalls.length);
      assert.equal(bsCalls[0].dn, docName);
      assert.equal(bsCalls[0].d, doc);
      assert.equal(bsCalls[0].c, mockConn);

      const daadmin = { foo: 'bar' }
      const env = { daadmin };
      const doc2 = await getYDoc(docName, mockConn, env, {});
      assert.equal(1, bsCalls.length, 'Should not have called bindstate again');
      assert.equal(doc, doc2);
      assert.equal('bar', doc.daadmin.foo, 'Should have bound daadmin now');
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
      persistence.bindState = async (nm, d, c, s) => {
        bindCalls.push({nm, d, c, s});
        return new Map();
      }

      const docName = 'https://somewhere.com/somedoc.html';
      const eventListeners = new Map();
      const closeCalls = [];
      const mockConn = {
        addEventListener(msg, fun) { eventListeners.set(msg, fun); },
        close() { closeCalls.push('close'); },
        readyState: 1, // wsReadyStateOpen
        send() {}
      };

      const daadmin = { a: 'b' };
      const env = { daadmin };
      const storage = { foo: 'bar' };

      assert.equal(0, bindCalls.length, 'Precondition');
      assert.equal(0, eventListeners.size, 'Precondition');
      await setupWSConnection(mockConn, docName, env, storage);

      assert.equal('arraybuffer', mockConn.binaryType);
      assert.equal(1, bindCalls.length);
      assert.equal(docName, bindCalls[0].nm);
      assert.equal(docName, bindCalls[0].d.name);
      assert.equal('b', bindCalls[0].d.daadmin.a);
      assert.equal(mockConn, bindCalls[0].c);
      assert.deepStrictEqual(storage, bindCalls[0].s)

      const closeLsnr = eventListeners.get('close');
      assert(closeLsnr);
      const messageLsnr = eventListeners.get('message');
      assert(messageLsnr);

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
      persistence.bindState = async (nm, d, c, s) => new Map();

      const docName = 'https://somewhere.com/myotherdoc.html';
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

      const ydoc = await getYDoc(docName, mockConn, {}, {}, true);
      ydoc.awareness = awareness;

      await setupWSConnection(mockConn, docName, {}, {});

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

  it('readState not chunked', async () => {
    const docName = 'http://foo.bar/doc123.html';
    const stored = new Map();
    stored.set('docstore', new Uint8Array([254, 255]));
    stored.set('chunks', 17); // should be ignored
    stored.set('doc', docName);

    const storage = { list: async () => stored };

    const data = await readState(docName, storage);
    assert.deepStrictEqual(new Uint8Array([254, 255]), data);
  });

  it('readState doc mismatch', async () => {
    const docName = 'http://foo.bar/doc123.html';
    const stored = new Map();
    stored.set('docstore', new Uint8Array([254, 255]));
    stored.set('chunks', 17); // should be ignored
    stored.set('doc', 'http://foo.bar/doc456.html');

    const storageCalled = [];
    const storage = {
      list: async () => stored,
      deleteAll: async () => storageCalled.push('deleteAll'),
    };

    const data = await readState(docName, storage);
    assert.equal(data, undefined);
    assert.deepStrictEqual(['deleteAll'], storageCalled);
  });

  it('readState chunked', async () => {
    const stored = new Map();
    stored.set('chunk_0', new Uint8Array([1, 2, 3]));
    stored.set('chunk_1', new Uint8Array([4, 5]));
    stored.set('chunks', 2);
    stored.set('doc', 'mydoc');

    const storage = { list: async () => stored };

    const data = await readState('mydoc', storage);
    assert.deepStrictEqual(new Uint8Array([1, 2, 3, 4, 5]), data);
  })

  it('storeState not chunked', async () => {
    const docName = 'https://some.where/far/away.html';
    const state = new Uint8Array([1, 2, 3, 4, 5]);

    const called = [];
    const storage = {
      deleteAll: async () => called.push('deleteAll'),
      put: (obj) => called.push(obj)
    };

    await storeState(docName, state, storage, 10);

    assert.equal(2, called.length);
    assert.equal('deleteAll', called[0]);
    assert.deepStrictEqual(state, called[1].docstore);
    assert.equal(docName, called[1].doc);
  });

  it('storeState chunked', async () => {
    const state = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const called = [];
    const storage = {
      deleteAll: async () => called.push('deleteAll'),
      put: (obj) => called.push(obj)
    };

    await storeState('somedoc', state, storage, 4);

    assert.equal(2, called.length);
    assert.equal('deleteAll', called[0]);
    assert.equal(3, called[1].chunks);
    assert.equal('somedoc', called[1].doc);
    assert.deepStrictEqual(new Uint8Array([1, 2, 3, 4]), called[1].chunk_0);
    assert.deepStrictEqual(new Uint8Array([5, 6, 7, 8]), called[1].chunk_1);
    assert.deepStrictEqual(new Uint8Array([9]), called[1].chunk_2);
  });

  it('Test showError', () => {
    const errorMap = new Map();
    const called = [];
    const mockYDoc = {
      getMap(nm) { return nm === 'error' ? errorMap : null; },
      transact(f) {
        called.push('transact');
        f();
      }
    };

    let error = new Error('foo');

    showError(mockYDoc, error);
    assert.equal('foo', errorMap.get('message'));
    assert(errorMap.get('timestamp') > 0);
    assert(errorMap.get('stack').includes('shareddoc.test.js'),
      'The stack trace should contain the name of this test file');
    assert.deepStrictEqual(['transact'], called);
  })
});

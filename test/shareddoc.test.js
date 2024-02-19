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
import assert from 'assert';
import { invalidateFromAdmin, updateHandler, WSSharedDoc, persistence, setYDoc} from '../src/shareddoc.js';

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
    const fooAsUint8Arr = new Uint8Array(['f'.charCodeAt(0), 'o'.charCodeAt(0), 'o'.charCodeAt(0)]);
    assert(isSubArray(conn.message, fooAsUint8Arr));
  });

  it('Test persistence put ok', async () =>{
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

  it('Test persistence put auth', async () =>{
    persistence.fetch = async (url, opts) => {
      assert.equal(url, 'foo');
      assert.equal(opts.method, 'PUT');
      assert.equal(opts.headers.get('authorization'), 'auth');
      assert.equal(await opts.body.get('data').text(), 'test');
      return { ok: false, status: 401, statusText: 'Unauth'};
    };
    const result = await persistence.put({ name: 'foo', conns: new Map().set({ auth: 'auth' }, new Set())}, 'test');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.statusText, 'Unauth');
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
});

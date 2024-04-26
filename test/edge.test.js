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

import defaultEdge, { DocRoom, handleApiRequest, handleErrors } from '../src/edge.js';
import { persistence, setYDoc } from '../src/shareddoc.js';

function hash(str) {
  let hash = 0;
  for (let i = 0, len = str.length; i < len; i++) {
      let chr = str.charCodeAt(i);
      hash = (hash << 5) - hash + chr;
      hash |= 0; // Convert to 32bit integer
  }
  return hash;
}

describe('Worker test suite', () => {
  it('Test deleteAdmin', async () => {
    const expectedHash = hash('https://some.where/some/doc.html');
    const req = {
      url: 'http://localhost:9999/api/v1/deleteadmin?doc=https://some.where/some/doc.html'
    };

    const roomFetchCalls = []
    const room = {
      fetch(url) {
        roomFetchCalls.push(url.toString());
        return new Response(null, { status: 200 });
      }
    };
    const rooms = {
      idFromName(nm) { return hash(nm) },
      get(id) {
        if (id === expectedHash) {
          return room;
        }
      }
    }
    const env = { rooms };

    const resp = await handleApiRequest(req, env);
    assert.equal(200, resp.status);
    assert.deepStrictEqual(roomFetchCalls, ['https://some.where/some/doc.html?api=deleteAdmin'])
  });

  it('Test syncAdmin request without doc', async () => {
    const req = {
      url: 'http://localhost:12345/api/v1/syncadmin'
    };
    const rooms = {};
    const env = { rooms };

    const resp = await handleApiRequest(req, env);
    assert.equal(400, resp.status, 'Doc wasnt set so should return a 400 for invalid');
    assert.equal('Bad', await resp.text());
  });

  it('Test handle syncAdmin request', async () => {
    const expectedHash = hash('http://foobar.com/a/b/c.html');
    const req = {
      url: 'http://localhost:12345/api/v1/syncadmin?doc=http://foobar.com/a/b/c.html'
    };

    const roomFetchCalls = []
    const room = {
      fetch(url) {
        roomFetchCalls.push(url.toString());
        return new Response(null, { status: 200 });
      }
    };
    const rooms = {
      idFromName(nm) { return hash(nm) },
      get(id) {
        if (id === expectedHash) {
          return room;
        }
      }
    }
    const env = { rooms };

    assert.equal(roomFetchCalls.length, 0, 'Precondition');
    const resp = await handleApiRequest(req, env);
    assert.equal(200, resp.status);
    assert.deepStrictEqual(roomFetchCalls, ['http://foobar.com/a/b/c.html?api=syncAdmin'])
  });

  it('Test handle syncAdmin request via default export', async () => {
    const expectedHash = hash('http://foobar.com/a/b/c.html');
    const req = {
      url: 'http://localhost:12345/api/v1/syncadmin?doc=http://foobar.com/a/b/c.html'
    };

    const roomFetchCalls = []
    const room = {
      fetch(url) {
        roomFetchCalls.push(url.toString());
        return new Response(null, { status: 200 });
      }
    };
    const rooms = {
      idFromName(nm) { return hash(nm) },
      get(id) {
        if (id === expectedHash) {
          return room;
        }
      }
    }
    const env = { rooms };

    assert.equal(roomFetchCalls.length, 0, 'Precondition');
    const resp = await defaultEdge.fetch(req, env);
    assert.equal(200, resp.status);
    assert.deepStrictEqual(roomFetchCalls, ['http://foobar.com/a/b/c.html?api=syncAdmin'])
  });

  it('Test unknown API', async () => {
    const req = {
      url: 'http://localhost:12345/api/v1/foobar'
    };

    const resp = await handleApiRequest(req, null);
    assert.equal(400, resp.status, 'Doc wasnt set so should return a 400 for invalid');
    assert.equal('Bad Request', await resp.text());
  });

  it('Docroom deleteFromAdmin', async () => {
    const aemMap = new Map();
    const ydocName = 'http://foobar.com/q.html';
    const mockYdoc = {
      getMap(name) { return name === 'aem' ? aemMap : null; }
    };
    setYDoc(ydocName, mockYdoc);

    const req = {
      url: `${ydocName}?api=deleteAdmin`
    };

    const storageMap = new Map();
    storageMap.set('docstore', 'mystore');
    storageMap.set('doc', ydocName);
    const storageCalled = [];
    const mockStorage = {
      deleteAll: () => storageCalled.push('deleteAll'),
      get: (fields) => {
        if (['docstore', 'chunks', 'doc'].every((v,i)=> v === fields[i])) {
          return storageMap;
        }
      }
    };
    const dr = new DocRoom({ storage: mockStorage }, null);

    const resp = await dr.fetch(req)
    assert.equal(204, resp.status);
    assert.deepStrictEqual(['deleteAll'], storageCalled);
    assert.equal(' ', aemMap.get('svrinv'));
  });

  it('Docroom deleteFromAdmin not found', async () => {
    const req = {
      url: `https://blah.blah/blah.html?api=deleteAdmin`
    };

    const storedMap = new Map();
    storedMap.set('doc', 'anotherdoc');
    const mockStorage = { get: () => storedMap };
    const dr = new DocRoom({ storage: mockStorage }, null);
    const resp = await dr.fetch(req)
    assert.equal(404, resp.status);
  });

  it('Docroom syncFromAdmin', async () => {
    const aemMap = new Map();
    const ydocName = 'http://foobar.com/a/b/c.html';
    const mockYdoc = {
      conns: [],
      name: ydocName,
      getMap(name) { return name === 'aem' ? aemMap : null; }
    };
    setYDoc(ydocName, mockYdoc);

    const req = {
      url: `${ydocName}?api=syncAdmin`
    };

    const storageCalled = [];
    const mockStorage = { deleteAll: () => storageCalled.push('deleteAll') };
    const dr = new DocRoom({ storage: mockStorage }, null);

    const mockFetch = async (url) => {
      if (url === ydocName) {
        return new Response('Document content', { status: 200 });
      }
      return null;
    }
    const oldPFectch = persistence.fetch;
    persistence.fetch = mockFetch;

    try {
      assert(!aemMap.get('svrinv'), 'Precondition');
      const resp = await dr.fetch(req)

      assert.equal(200, resp.status);
      assert.equal('Document content', aemMap.get('svrinv'));
      assert.deepStrictEqual(['deleteAll'], storageCalled);
    } finally {
      persistence.fetch = oldPFectch;
    }
  });

  it('Unknown doc update request gives 404', async () => {
    const dr = new DocRoom({ storage: null }, null);
    dr.callGlobalFetch = async () => new Response(null, { status: 418 });

    const req = {
      url: 'http://foobar.com/a/b/d/e/f.html?api=syncAdmin'
    };
    const resp = await dr.fetch(req)

    assert.equal(404, resp.status);
  });

  it('Unknown DocRoom API call gives 400', async () => {
    const dr = new DocRoom({ storage: null }, null);
    const req = {
      url: 'http://foobar.com/a.html?api=blahblahblah'
    };
    const resp = await dr.fetch(req)

    assert.equal(400, resp.status);
  });

  it('Test DocRoom fetch', async () => {
    const savedNWSP = DocRoom.newWebSocketPair;
    const savedBS = persistence.bindState;

    try {
      const bindCalled = [];
      persistence.bindState = async (nm, d, c) => bindCalled.push({nm, d, c});

      const wspCalled = [];
      const wsp0 = {};
      const wsp1 = {
        accept() { wspCalled.push('accept'); },
        addEventListener(type) { wspCalled.push(`addEventListener ${type}`); },
        close() { wspCalled.push('close'); }
      }
      DocRoom.newWebSocketPair = () => [wsp0, wsp1];

      const daadmin = { blah: 1234 };
      const dr = new DocRoom({ storage: null }, { daadmin });
      const headers = new Map();
      headers.set('Upgrade', 'websocket');
      headers.set('Authorization', 'au123');
      headers.set('X-collab-room', 'http://foo.bar/1/2/3.html');

      const req = {
        headers,
        url: 'http://localhost:4711/'
      };
      const resp = await dr.fetch(req, {}, 306);
      assert.equal(306 /* fabricated websocket response code */, resp.status);

      assert.equal(1, bindCalled.length);
      assert.equal('http://foo.bar/1/2/3.html', bindCalled[0].nm);
      assert.equal('1234', bindCalled[0].d.daadmin.blah);

      assert.equal('au123', wsp1.auth);

      const acceptIdx = wspCalled.indexOf('accept');
      const alMessIdx = wspCalled.indexOf('addEventListener message');
      const alClsIdx = wspCalled.indexOf('addEventListener close');
      const clsIdx = wspCalled.indexOf('close');

      assert(acceptIdx >= 0);
      assert(alMessIdx > acceptIdx);
      assert(alClsIdx > alMessIdx);
      assert(clsIdx > alClsIdx);
    } finally {
      DocRoom.newWebSocketPair = savedNWSP;
      persistence.bindState = savedBS;
    }
  });

  it('Test DocRoom fetch expects websocket', async () => {
    const dr = new DocRoom({ storage: null }, null);

    const req = {
      headers: new Map(),
      url: 'http://localhost:4711/'
    };
    const resp = await dr.fetch(req);
    assert.equal(400, resp.status, 'Expected a Websocket');
  });

  it('Test DocRoom fetch expects document name', async () => {
    const dr = new DocRoom({ storage: null }, null);
    const headers = new Map();
    headers.set('Upgrade', 'websocket');
    headers.set('Authorization', 'au123');

    const req = {
      headers,
      url: 'http://localhost:4711/'
    };
    const resp = await dr.fetch(req);
    assert.equal(400, resp.status, 'Expected a document name');
  });

  it('Test handleErrors success', async () => {
    const f = () => 42;

    const res = await handleErrors(null, f);
    assert.equal(42, res);
  });

  it('Test HandleError error', async () => {
    const f = () => { throw new Error('testing'); }

    const req = {
      headers: new Map()
    };
    const res = await handleErrors(req, f);
    assert.equal(500, res.status);
  });

  it('Test handleApiRequest', async () => {
    const headers = new Map();
    headers.set('myheader', 'myval');
    const req = {
      url: 'http://do.re.mi/https://admin.da.live/laaa.html?Authorization=qrtoefi',
      headers
    }

    const roomFetchCalled = [];
    const myRoom = {
      fetch(req) {
        roomFetchCalled.push(req);
        return new Response(null, { status: 306 });
      }
    }

    const rooms = {
      idFromName(nm) { return `id${hash(nm)}`; },
      get(id) { return id === 'id1255893316' ? myRoom : null; }
    }
    const env = { rooms };

    const mockFetchCalled = [];
    const mockFetch = async (url, opts) => {
      mockFetchCalled.push({ url, opts });
      return new Response(null, { status: 200 });
    };
    const res = await handleApiRequest(req, env, mockFetch);
    assert.equal(306, res.status);

    assert.equal(1, mockFetchCalled.length);
    const mfreq = mockFetchCalled[0];
    assert.equal('https://admin.da.live/laaa.html', mfreq.url);
    assert.equal('HEAD', mfreq.opts.method);

    assert.equal(1, roomFetchCalled.length);

    const rfreq = roomFetchCalled[0];
    assert.equal('https://admin.da.live/laaa.html', rfreq.url);
    assert.equal('qrtoefi', rfreq.headers.get('Authorization'));
    assert.equal('myval', rfreq.headers.get('myheader'));
    assert.equal('https://admin.da.live/laaa.html', rfreq.headers.get('X-collab-room'));
  });

  it('Test handleApiRequest via Service Binding', async () => {
    const headers = new Map();
    headers.set('myheader', 'myval');
    const req = {
      url: 'http://do.re.mi/https://admin.da.live/laaa.html?Authorization=lala',
      headers
    }

    const mockFetch = async (url, opts) => {
      if (opts.method === 'HEAD'
        && url === 'https://admin.da.live/laaa.html'
        && opts.headers.get('Authorization') === 'lala') {
        return new Response(null, {status: 410});
      }
    };

    // This is how a service binding is exposed to the program, via env
    const env = {
      daadmin: { fetch : mockFetch }
    };

    const res = await handleApiRequest(req, env);
    assert.equal(410, res.status);
  });

  it('Test handleApiRequest wrong host', async () => {
    const req = {
      url: 'http://do.re.mi/https://some.where.else/hihi.html',
    }

    const res = await handleApiRequest(req, {});
    assert.equal(404, res.status);
  });

  it('Test handleApiRequest not authorized', async () => {
    const req = {
      url: 'http://do.re.mi/https://admin.da.live/hihi.html',
    }

    const mockFetch = async (url, opts) => new Response(null, {status: 401});

    const res = await handleApiRequest(req, {}, mockFetch);
    assert.equal(401, res.status);
  });

  it('Test ping API', async () => {
    const req = {
      url: 'http://do.re.mi/api/v1/ping',
    }

    const res = await defaultEdge.fetch(req, {});
    assert.equal(200, res.status);
    const json = await res.json();
    assert.equal('ok', json.status);
    assert.deepStrictEqual([], json.service_bindings);
  });

  it('Test ping API with service binding', async () => {
    const req = {
      url: 'http://some.host.name/api/v1/ping',
    }

    const res = await defaultEdge.fetch(req, { daadmin: {}});
    assert.equal(200, res.status);
    const json = await res.json();
    assert.equal('ok', json.status);
    assert.deepStrictEqual(['da-admin'], json.service_bindings);
  });
});
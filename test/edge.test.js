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

import { DocRoom, handleApiRequest } from '../src/edge.js';
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

  it('Test unknown API', async () => {
    const req = {
      url: 'http://localhost:12345/api/v1/foobar'
    };

    const resp = await handleApiRequest(req, null);
    assert.equal(400, resp.status, 'Doc wasnt set so should return a 400 for invalid');
    assert.equal('Bad Request', await resp.text());
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

    const dr = new DocRoom({ storage: null }, null);

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
});
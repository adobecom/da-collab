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

import { Schema } from 'prosemirror-model';
import { addListNodes } from 'prosemirror-schema-list';
import { tableNodes } from 'prosemirror-tables';

function parseLocDOM(locTag) {
  return [{
    tag: locTag,

    // Do we need to add this to the contentElement function?
    // Only parse the content of the node, not the temporary elements
    // const deleteThese = dom.querySelectorAll('[loc-temp-dom]');
    // deleteThese.forEach((e) => e.remove());
    contentElement: (dom) => dom,
  }];
}

/* Base nodes taken from prosemirror-schema-basic */
const baseNodes = {
  doc: {
    content: 'block+',
  },
  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM() {
      return ['p', 0];
    },
  },
  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM() {
      return ['blockquote', 0];
    },
  },
  horizontal_rule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM() {
      return ['hr'];
    },
  },
  heading: {
    attrs: { level: { default: 1 } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [
      { tag: 'h1', attrs: { level: 1 } },
      { tag: 'h2', attrs: { level: 2 } },
      { tag: 'h3', attrs: { level: 3 } },
      { tag: 'h4', attrs: { level: 4 } },
      { tag: 'h5', attrs: { level: 5 } },
      { tag: 'h6', attrs: { level: 6 } },
    ],
    toDOM(node) {
      return [`h${node.attrs.level}`, 0];
    },
  },
  code_block: {
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM() {
      return ['pre', ['code', 0]];
    },
  },
  text: {
    group: 'inline',
  },
  image: {
    inline: true,
    attrs: {
      src: {},
      alt: { default: null },
      title: { default: null },
    },
    group: 'inline',
    draggable: true,
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs(dom) {
          return {
            src: dom.getAttribute('src'),
            title: dom.getAttribute('title'),
            alt: dom.getAttribute('alt'),
          };
        },
      },
    ],
    toDOM(node) {
      const { src, alt, title } = node.attrs;
      return ['img', { src, alt, title }];
    },
  },
  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM() {
      return ['br'];
    },
  },
  // DA Regional Edit tags
  loc_added: {
    group: 'block',
    content: 'block+',
    parseDOM: parseLocDOM('da-loc-added'),
    toDOM: () => ['da-loc-added', { contenteditable: false }, 0],
  },
  loc_deleted: {
    group: 'block',
    content: 'block+',
    parseDOM: parseLocDOM('da-loc-deleted'),
    toDOM: () => ['da-loc-deleted', { contenteditable: false }, 0],
  },
};

const baseMarks = {
  link: {
    attrs: {
      href: {},
      title: { default: null },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs(dom) {
          return { href: dom.getAttribute('href'), title: dom.getAttribute('title') };
        },
      },
    ],
    toDOM(node) {
      const { href, title } = node.attrs;
      return ['a', { href, title }, 0];
    },
  },
  em: {
    parseDOM: [
      { tag: 'i' },
      { tag: 'em' },
      { style: 'font-style=italic' },
      { style: 'font-style=normal', clearMark: (m) => m.type.name === 'em' },
    ],
    toDOM() {
      return ['em', 0];
    },
  },
  strong: {
    parseDOM: [
      { tag: 'strong' },
      // This works around a Google Docs misbehavior where
      // pasted content will be inexplicably wrapped in `<b>`
      // tags with a font-weight normal.
      { tag: 'b', getAttrs: (node) => node.style.fontWeight !== 'normal' && null },
      { style: 'font-weight=400', clearMark: (m) => m.type.name === 'strong' },
      { style: 'font-weight', getAttrs: (value) => /^(bold(er)?|[5-9]\d{2,})$/.test(value) && null },
    ],
    toDOM() {
      return ['strong', 0];
    },
  },
  code: {
    parseDOM: [{ tag: 'code' }],
    toDOM() {
      return ['code', 0];
    },
  },
};

const baseSchema = new Schema({ nodes: baseNodes, marks: baseMarks });

function addLocNodes(nodes) {
  if (!nodes.content.includes('loc_deleted')) {
    nodes.content.push('loc_deleted');
    nodes.content.push();
    nodes.content.push('loc_added');
    nodes.content.push();
  }
  return nodes;
}

function addCustomMarks(marks) {
  const sup = {
    parseDOM: [{ tag: 'sup' }, { clearMark: (m) => m.type.name === 'sup' }],
    toDOM() { return ['sup', 0]; },
  };

  const sub = {
    parseDOM: [{ tag: 'sub' }, { clearMark: (m) => m.type.name === 'sub' }],
    toDOM() { return ['sub', 0]; },
  };

  const contextHighlight = { toDOM: () => ['span', { class: 'highlighted-context' }, 0] };

  return marks
    .addToEnd('sup', sup)
    .addToEnd('sub', sub)
    .addToEnd('contextHighlightingMark', contextHighlight);
}

function getImageNodeWithHref() {
  // due to bug in y-prosemirror, add href to image node
  // which will be converted to a wrapping <a> tag
  return {
    inline: true,
    attrs: {
      src: { validate: 'string' },
      alt: { default: null, validate: 'string|null' },
      title: { default: null, validate: 'string|null' },
      href: { default: null, validate: 'string|null' },
    },
    group: 'inline',
    draggable: true,
    parseDOM: [{
      tag: 'img[src]',
      getAttrs(dom) {
        return {
          src: dom.getAttribute('src'),
          title: dom.getAttribute('title'),
          alt: dom.getAttribute('alt'),
          href: dom.getAttribute('href'),
        };
      },
    }],
    toDOM(node) {
      const {
        src,
        alt,
        title,
        href,
      } = node.attrs;
      return ['img', {
        src,
        alt,
        title,
        href,
      }];
    },
  };
}

function getTableNodeSchema() {
  const getTableAttrs = (dom) => ({
    dataId: dom.getAttribute('dataId') || null,
  });

  const schema = tableNodes({ tableGroup: 'block', cellContent: 'block+' });
  schema.table.attrs = { dataId: { default: null } };
  schema.table.parseDOM = [{ tag: 'table', getAttrs: (dom) => getTableAttrs(dom) }];
  schema.table.toDOM = (node) => ['table', node.attrs, ['tbody', 0]];
  return schema;
}

// Note: until getSchema() is separated in its own module, this function needs to be kept in-sync
// with the getSchema() function in da-live blocks/edit/prose/index.js
export function getSchema() {
  const { marks, nodes: baseSchemaNodes } = baseSchema.spec;
  const withLocNodes = addLocNodes(baseSchemaNodes);
  const withListnodes = addListNodes(withLocNodes, 'block+', 'block');
  const withTableNodes = withListnodes.append(getTableNodeSchema());
  const nodes = withTableNodes.update('image', getImageNodeWithHref());
  const customMarks = addCustomMarks(marks);
  return new Schema({ nodes, marks: customMarks });
}

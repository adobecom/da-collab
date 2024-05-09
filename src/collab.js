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
import {
  prosemirrorToYXmlFragment, yDocToProsemirror,
} from 'y-prosemirror';
import {
  DOMParser, DOMSerializer, Schema,
} from 'prosemirror-model';
import { addListNodes } from 'prosemirror-schema-list';
import {
  tableNodes,
} from 'prosemirror-tables';
import { schema as baseSchema } from 'prosemirror-schema-basic';
import { fromHtml } from 'hast-util-from-html';
import { matches } from 'hast-util-select';

function getSchema() {
  const { marks, nodes: baseNodes } = baseSchema.spec;
  const withListnodes = addListNodes(baseNodes, 'block+', 'block');
  const nodes = withListnodes.append(tableNodes({ tableGroup: 'block', cellContent: 'block+' }));
  const contextHighlightingMark = { toDOM: () => ['span', { class: 'highlighted-context' }, 0] };
  const customMarks = marks.addToEnd('contextHighlightingMark', contextHighlightingMark);
  return new Schema({ nodes, marks: customMarks });
}

function convertSectionBreak(node) {
  if (!node) return;
  if (node.children) {
    node.children.forEach(convertSectionBreak);
  }
  if (node.tagName === 'p' && node.children && node.children.length === 1) {
    if (node.children[0].type === 'text' && node.children[0].text === '---') {
      node.children.clear();
      // eslint-disable-next-line no-param-reassign
      node.tagName = 'hr';
    }
  }
}

export function aem2doc(html, ydoc) {
  const tree = fromHtml(html, { fragment: true });
  const main = tree.children.find((child) => child.tagName === 'main');
  (main.children || []).forEach((parent) => {
    if (parent.tagName === 'div' && parent.children) {
      const children = [];
      let modified = false;
      parent.children.forEach((child) => {
        if (child.tagName === 'div' && child.properties.className?.length > 0) {
          modified = true;
          children.push({
            type: 'element', tagName: 'p', children: [], properties: {},
          });
          const classes = Array.from(child.properties.className);
          const name = classes.shift();
          const blockName = classes.length > 0 ? `${name} (${classes.join(', ')})` : name;
          const rows = [...child.children];
          const maxCols = rows.reduce((cols, row) => (
            row.children?.length > cols ? row.children?.length : cols), 0);

          const table = {
            type: 'element', tagName: 'table', children: [], properties: {},
          };
          children.push(table);
          const headerRow = {
            type: 'element', tagName: 'tr', children: [], properties: {},
          };

          const td = {
            type: 'element', tagName: 'td', children: [{ type: 'text', value: blockName }], properties: { colspan: maxCols },
          };

          headerRow.children.push(td);
          table.children.push(headerRow);
          rows.filter((row) => row.tagName === 'div').forEach((row) => {
            const tr = {
              type: 'element', tagName: 'tr', children: [], properties: {},
            };
            const cells = (row.children ? [...row.children] : [row]).filter((cell) => cell.type !== 'text' || (cell.value && cell.value.trim() !== '\n' && cell.value.trim() !== ''));
            cells.forEach((cell, idx) => {
              const tdi = {
                type: 'element', tagName: 'td', children: [], properties: {},
              };
              if (cells.length < maxCols && idx === cells.length - 1) {
                tdi.properties.colspan = maxCols - idx;
              }
              tdi.children.push(cells[idx]);
              tr.children.push(tdi);
            });
            table.children.push(tr);
          });
          children.push({
            type: 'element', tagName: 'p', children: [], properties: {},
          });
        } else {
          children.push(child);
        }
      });
      if (modified) {
        // eslint-disable-next-line no-param-reassign
        parent.children = children;
      }
    }
  });
  convertSectionBreak(main);
  let count = 0;
  main.children = main.children.flatMap((node) => {
    const result = [];
    if (node.tagName === 'div') {
      if (count > 0) {
        result.push({
          type: 'element', tagName: 'p', children: [], properties: {},
        });
        result.push({
          type: 'element', tagName: 'hr', children: [], properties: {},
        });
        result.push({
          type: 'element', tagName: 'p', children: [], properties: {},
        });
        result.push(...node.children);
      } else {
        result.push(node);
      }
      count += 1;
    } else {
      result.push(node);
    }
    return result;
  });
  const handler2 = {
    get(target, prop) {
      const source = target;
      if (prop === 'firstChild') {
        if (target.children.length === 0) return null;
        for (let i = 0; i < target.children.length - 1; i += 1) {
          source.children[i].nextSibling = new Proxy(target.children[i + 1], handler2);
          if (i > 0) {
            source.children[i].previousSibling = new Proxy(target.children[i - 1], handler2);
          } else {
            source.children[i].previousSibling = new Proxy(
              target.children[target.children.length - 1],
              handler2,
            );
          }
        }
        return new Proxy(target.children[0], handler2);
      }
      if (prop === 'nodeType') {
        return target.type === 'text' ? 3 : 1;
      }
      if (prop === 'nodeValue') {
        return target.value;
      }

      if (prop === 'nextSibling') {
        return target.nextSibling;
      }

      if (prop === 'previousSibling') {
        return target.previousSibling;
      }

      if (prop === 'nodeName') {
        return target.tagName?.toUpperCase();
      }

      if (prop === 'matches') {
        return (selector) => matches(selector, target);
      }

      if (prop === 'getAttribute') {
        return (name) => (target.properties ? target.properties[name] : undefined);
      }

      if (prop === 'hasAttribute') {
        return (name) => target.properties && target.properties[name];
      }

      if (prop === 'style') {
        return {};
      }

      return Reflect.get(target, prop);
    },
  };
  const json = DOMParser.fromSchema(getSchema()).parse(new Proxy(main, handler2));
  prosemirrorToYXmlFragment(json, ydoc.getXmlFragment('prosemirror'));
}

function tohtml(node) {
  let attributes = Object.entries(node.attributes).map(([key, value]) => ` ${key}="${value}"`).join('');
  if (!node.children || node.children.length === 0) {
    if (node.type === 'text') {
      return node.text;
    }
    if (node.type === 'p') return '';
    if (node.type === 'img' && !node.attributes.loading) {
      attributes += ' loading="lazy"';
    }
    if (node.type === 'img') {
      return `<picture><source srcset="${node.attributes.src}"><source srcset="${node.attributes.src}" media="(min-width: 600px)"><${node.type}${attributes}></picture>`;
    }

    const result = node.type !== 'br' ? `<${node.type}${attributes}></${node.type}>` : `<${node.type}>`;

    return result;
  }
  let { children } = node;
  if (node.type === 'li') {
    if (children.length === 1) {
      if (children[0].type === 'p') {
        children = children[0].children;
      }
    }
  }
  if (node.type === 'p') {
    if (children.length === 1) {
      if (children[0].type === 'img') {
        return children.map((child) => tohtml(child)).join('');
      }
    }
  }
  return `<${node.type}${attributes}>${children.map((child) => tohtml(child)).join('')}</${node.type}>`;
}

function toBlockCSSClassNames(text) {
  if (!text) return [];
  const names = [];
  const idx = text.lastIndexOf('(');
  if (idx >= 0) {
    names.push(text.substring(0, idx));
    names.push(...text.substring(idx + 1).split(','));
  } else {
    names.push(text);
  }

  return names.map((name) => name
    .toLowerCase()
    .replace(/[^0-9a-z]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, ''))
    .filter((name) => !!name);
}

export function doc2aem(ydoc) {
  const schema = getSchema();
  const json = yDocToProsemirror(schema, ydoc);

  const fragment = { type: 'div', children: [], attributes: {} };
  const handler3 = {
    get(target, prop) {
      const source = target;
      if (prop === 'createDocumentFragment') {
        return () => new Proxy(fragment, handler3);
      }
      if (prop === 'appendChild') {
        return (node) => target.children.push(node);
      }
      if (prop === 'createElement') {
        return (type) => new Proxy({ type, children: [], attributes: [] }, handler3);
      }
      if (prop === 'createTextNode') {
        return (content) => new Proxy({ type: 'text', text: content, attributes: {} }, handler3);
      }
      if (prop === 'setAttribute') {
        return (name, value) => {
          source.attributes[name] = value;
        };
      }
      return Reflect.get(target, prop);
    },
  };

  DOMSerializer.fromSchema(schema)
    .serializeFragment(json.content, { document: new Proxy({}, handler3) });

  // convert table to blocks
  const { children } = fragment;
  fragment.children = [];
  children.forEach((child) => {
    if (child.type === 'table') {
      const rows = child.children[0].children;
      const nameRow = rows.shift();
      const className = toBlockCSSClassNames(nameRow.children[0].children[0].children[0].text).join(' ');
      const block = { type: 'div', attributes: { class: className }, children: [] };
      fragment.children.push(block);
      rows.forEach((row) => {
        const div = { type: 'div', attributes: {}, children: [] };
        block.children.push(div);
        row.children.forEach((col) => {
          div.children.push({ type: 'div', attributes: {}, children: col.children });
        });
      });
    } else {
      fragment.children.push(child);
    }
  });
  // convert sections

  const section = { type: 'div', attributes: {}, children: [] };
  const sections = [...fragment.children].reduce((acc, child) => {
    if (child.type === 'hr') {
      acc.push({ type: 'div', attributes: {}, children: [] });
    } else {
      acc[acc.length - 1].children.push(child);
    }
    return acc;
  }, [section]);

  const text = sections.map((s) => tohtml(s)).join('');
  return `
<body>
  <header></header>
  <main>${text}</main>
  <footer></footer>
</body>
`;
}

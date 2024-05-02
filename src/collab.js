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
import { prosemirrorJSONToYXmlFragment, yDocToProsemirrorJSON } from 'y-prosemirror';
import { Schema } from 'prosemirror-model';
import { addListNodes } from 'prosemirror-schema-list';
import {
  tableNodes,
} from 'prosemirror-tables';
import { schema as baseSchema } from 'prosemirror-schema-basic';

function toTag(dom, content, type) {
  let attributes = dom.length > 1 ? ' ' : '';
  const attrs = {};
  if (dom.length > 1) {
    Object.entries(dom[1]).forEach(([key, value]) => {
      attributes += value ? `${key}="${value}" ` : `${key}`;
      attrs[key] = value;
    });
  }
  if (attributes === ' ') attributes = '';
  if (dom[0] === 'img') {
    return `<picture><source srcset="${attrs.src}"><source srcset="${attrs.src}" media="(min-width: 600px)"><${dom[0]}${attributes}${content ? `>${content}</${dom[0]}>` : '/>'}</picture>`;
  }
  if (dom[0] === 'p' && content === '---') {
    return '<hr/>';
  }
  return `<${dom[0]}${attributes}${type && type.isBlock ? `>${content}</${dom[0]}>` : '/>'}`;
}

function node2html(node, schema) {
  const schemaNode = schema.nodes[node.type];
  if (schemaNode.isBlock && node.content) {
    const mapped = schemaNode.spec.toDOM ? schemaNode.spec.toDOM(node) : ['div'];
    return toTag(mapped, node.content.map((child) => node2html(child, schema)).join(''), schemaNode);
  }
  if (schemaNode.spec.toDOM) return toTag(schemaNode.spec.toDOM(node));
  if (!node.type === 'text') return '';
  if (!node.marks) return node.text;
  return `${node.marks.map((mark) => `<${mark.type}>`).join('')}${node.text}${node.marks.map((mark) => `</${mark.type}>`).join('')}`;
}

function getSchema() {
  const { marks, nodes: baseNodes } = baseSchema.spec;
  const withListnodes = addListNodes(baseNodes, 'block+', 'block');
  const nodes = withListnodes.append(tableNodes({ tableGroup: 'block', cellContent: 'block+' }));
  const contextHighlightingMark = { toDOM: () => ['span', { class: 'highlighted-context' }, 0] };
  const customMarks = marks.addToEnd('contextHighlightingMark', contextHighlightingMark);
  return new Schema({ nodes, marks: customMarks });
}

export async function aem2prose(html, schema, rewriter = new HTMLRewriter()) {
  const json = { type: 'doc', content: [] };
  let current = json;
  let currentText;
  let marks = [];
  class NodeHandler {
    constructor(rule, node, mark = false) {
      this.rule = rule;
      this.node = node;
      this.mark = mark;
    }

    element(element) {
      if (this.mark) {
        if (currentText) {
          current.content.push({ type: 'text', text: currentText, marks });
          currentText = undefined;
        }

        const parent = marks;
        currentText = undefined;
        marks = Array.from(marks);
        const currentMark = { type: this.node.name, attrs: {} };
        Object.entries(this.node.attrs).forEach(([name, value]) => {
          const attrs = {};
          for (const [attrName, attrValue] of element.attributes) {
            attrs[attrName] = attrValue;
          }
          if (attrs[name]) {
            currentMark.attrs[name] = attrs[name];
          } else if (value.hasDefault) {
            currentMark.attrs[name] = value.default;
          }
        });
        marks.push(currentMark);
        element.onEndTag(() => {
          if (currentText) {
            current.content.push({ type: 'text', text: currentText, marks });
            currentText = undefined;
          }
          marks = parent;
        });
        return;
      }
      const parent = current;
      current = {
        type: this.node.name, content: [], attrs: {}, marks: Array.from(marks),
      };
      Object.entries(this.node.attrs).forEach(([name, value]) => {
        const attrs = {};
        for (const [attrName, attrValue] of element.attributes) {
          attrs[attrName] = attrValue;
        }
        if (attrs[name]) {
          current.attrs[name] = attrs[name];
        } else if (value.hasDefault) {
          current.attrs[name] = value.default;
        }
      });
      if (currentText) {
        parent.content.push({ type: 'text', text: currentText, marks });
        currentText = undefined;
      }
      parent.content.push(current);
      if (this.node.isBlock) {
        element.onEndTag(() => {
          if (currentText) {
            current.content.push({ type: 'text', text: currentText, marks });
            currentText = undefined;
          }
          marks = [];
        });
      } else {
        current = parent;
        marks = [];
      }
    }

    text(text) {
      currentText = currentText ? `${currentText}${text.text}` : text.text;
    }
  }

  Object.values(schema.nodes).filter((node) => node.spec.parseDOM).forEach((node) => {
    node.spec.parseDOM.forEach((rule) => {
      rewriter.on(rule.tag, new NodeHandler(rule, node));
    });
  });
  Object.values(schema.marks).filter((mark) => mark.spec.parseDOM).forEach((mark) => {
    mark.spec.parseDOM.filter((rule) => rule.tag).forEach((rule) => {
      rewriter.on(rule.tag, new NodeHandler(rule, mark, true));
    });
  });
  const resp = await rewriter.transform(new Response(html));
  await resp.text();
  return json;
}

export async function aem2doc(html, ydoc, rewriter = new HTMLRewriter()) {
  const schema = getSchema();
  const json = await aem2prose(html, schema, rewriter);
  prosemirrorJSONToYXmlFragment(schema, json, ydoc.getXmlFragment('prosemirror'));
}

export function prose2aem(json, schema) {
  const html = `
<body>
  <header></header>
  <main>${node2html(json, schema)}</main>
  <footer></footer>
</body>
`;
  return html;
}
export function doc2aem(ydoc) {
  const json = yDocToProsemirrorJSON(ydoc);
  const schema = getSchema();
  return prose2aem(json, schema);
}

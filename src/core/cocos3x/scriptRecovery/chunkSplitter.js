'use strict';

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

/**
 * Split a chunk file (one .js with N System.register(...) calls) into N modules.
 *
 * Each output module has:
 *  - name: derived from the registerId tail (without .ts/.js extension)
 *  - registerId: the original module id string
 *  - deps: array of dep id strings
 *  - setterBindings: [{ dep, bindings: [{local, imported}] }]
 *  - ast: File AST containing only the execute() body
 *  - source: the original chunk text (kept as fallback)
 */
async function splitChunks(chunk) {
  const { name, source, preminified = false } = chunk;
  let ast;
  try {
    ast = parser.parse(source, { sourceType: 'script', allowReturnOutsideFunction: true });
  } catch (err) {
    return [{ name, registerId: null, deps: [], setterBindings: [], exportParam: null, ast: null, source, preminified }];
  }

  const modules = [];
  traverse(ast, {
    CallExpression(p) {
      const callee = p.node.callee;
      if (
        !(t.isMemberExpression(callee) &&
          t.isIdentifier(callee.object, { name: 'System' }) &&
          t.isIdentifier(callee.property, { name: 'register' }))
      ) return;

      const args = p.node.arguments;
      if (args.length < 2) return;

      let registerId = null;
      let depsNode;
      let factory;
      if (t.isStringLiteral(args[0]) && t.isArrayExpression(args[1])) {
        registerId = args[0].value;
        depsNode = args[1];
        factory = args[2];
      } else if (t.isArrayExpression(args[0])) {
        depsNode = args[0];
        factory = args[1];
      } else {
        return;
      }
      if (!t.isFunctionExpression(factory) && !t.isArrowFunctionExpression(factory)) return;

      const deps = depsNode.elements
        .filter((el) => t.isStringLiteral(el))
        .map((el) => el.value);

      // Container-wrapper detection: src/chunks/bundle.js (the vendor mega-
      // chunk that carries fairygui/crypto-js/tslib/…) wraps its inner
      // System.register calls in an outer `System.register([], function(_export,
      // _context){ return { execute: function () { …inner registers… } }; })`.
      // If we accept the outer match and `p.skip()`, every inner register is
      // lost. Heuristic: anonymous (no registerId) + empty deps + factory body
      // contains nested `System.register(...)` calls → treat as container and
      // continue traversal instead of emitting a module.
      if (registerId === null && deps.length === 0 && factoryHasNestedRegister(factory)) {
        return; // do NOT skip — let traverse descend into the inner registers
      }

      const modName = deriveModuleName(registerId, name, modules.length);
      // Capture the factory's first parameter name — terser/webcrack rename
      // `_export` to a single letter (e.g. `e`, `r`). esmRebuilder needs this
      // to recognize export calls like `e("BloomType", ...)`.
      const exportParam = (factory.params && factory.params[0] && t.isIdentifier(factory.params[0]))
        ? factory.params[0].name
        : null;
      // Capture the second parameter (`_context`). SystemJS exposes
      // `_context.meta.url` and `_context.import`; recovered modules from
      // CommonJS-via-cjs-loader vendors (clipper, tslib, fp.cjs) read
      // `_context.meta.url`. esmRebuilder shims this to `import.meta.url`.
      const contextParam = (factory.params && factory.params[1] && t.isIdentifier(factory.params[1]))
        ? factory.params[1].name
        : null;
      const result = extractFactoryBody(factory, exportParam);
      const setterBindings = result.setterBindings.map((s) => ({
        dep: deps[s._index],
        bindings: s.bindings,
      }));
      // Aggregate the module's own export inventory. The cross-bundle resolver
      // (Layer 4.6) uses this to decide whether a same-name candidate in
      // another bundle satisfies an importer's named-binding set. Three
      // sources contribute:
      //   (a) setter-level reexports (already parsed above)
      //   (b) execute-body `_export("Name", ...)` and `_export({a:..,b:..})`
      //       calls — common in barrel modules and ccclass declarations
      //   (c) `default` flagged separately so resolver can match `import x from`
      const exportsSet = new Set();
      let hasDefault = false;
      for (const s of setterBindings) {
        for (const b of s.bindings) {
          if (b.reexport && b.exported) {
            if (b.exported === 'default') hasDefault = true;
            else exportsSet.add(b.exported);
          }
        }
      }
      if (result.bodyAst && exportParam) {
        collectExecuteBodyExports(result.bodyAst, exportParam, exportsSet, (isDefault) => { if (isDefault) hasDefault = true; });
      }
      modules.push({
        name: modName,
        registerId,
        deps,
        setterBindings,
        exportParam,
        contextParam,
        exports: exportsSet,
        hasDefault,
        ast: result.bodyAst,
        source,
        preminified,
      });
      p.skip();
    },
  });

  if (modules.length === 0) {
    return [{ name, registerId: null, deps: [], setterBindings: [], exportParam: null, ast: null, source, preminified }];
  }
  return modules;
}

function deriveModuleName(registerId, fallback, index) {
  if (registerId) {
    const tail = registerId.split('/').pop() || `mod${index}`;
    return tail.replace(/\.(ts|js|mjs)$/i, '');
  }
  return `${fallback.replace(/\.js$/, '')}_${index}`;
}

// Walk the factory body to see if it contains a nested `System.register(...)`
// call. Used to recognise the bundle.js container wrapper described above.
// Cheap synchronous traversal — no babel-traverse, just an inline visitor.
function factoryHasNestedRegister(factory) {
  let found = false;
  function visit(node) {
    if (found || !node || typeof node !== 'object') return;
    if (node.type === 'CallExpression') {
      const c = node.callee;
      if (
        c && c.type === 'MemberExpression' &&
        c.object && c.object.type === 'Identifier' && c.object.name === 'System' &&
        c.property && c.property.type === 'Identifier' && c.property.name === 'register'
      ) {
        found = true;
        return;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      const v = node[key];
      if (Array.isArray(v)) for (const c of v) visit(c);
      else if (v && typeof v === 'object' && v.type) visit(v);
    }
  }
  visit(factory.body);
  return found;
}

function extractFactoryBody(factory, exportParam) {
  const out = { setterBindings: [], bodyAst: null };
  const ret = factory.body.body.find((s) => t.isReturnStatement(s));
  if (!ret || !t.isObjectExpression(ret.argument)) return out;

  for (const prop of ret.argument.properties) {
    if (!t.isObjectProperty(prop) && !t.isObjectMethod(prop)) continue;
    const key = t.isIdentifier(prop.key) ? prop.key.name : (t.isStringLiteral(prop.key) ? prop.key.value : null);
    if (key === 'setters' && t.isObjectProperty(prop) && t.isArrayExpression(prop.value)) {
      out.setterBindings = parseSetters(prop.value, exportParam);
    } else if (key === 'execute') {
      const fn = t.isObjectMethod(prop) ? prop : (t.isFunctionExpression(prop.value) || t.isArrowFunctionExpression(prop.value) ? prop.value : null);
      if (fn) {
        const body = t.isObjectMethod(prop) ? prop.body.body : fn.body.body;
        out.bodyAst = t.file(t.program(body));
      }
    }
  }
  return out;
}

function parseSetters(arrayExpr, exportParam) {
  return arrayExpr.elements.map((fn, i) => {
    if (!t.isFunctionExpression(fn) && !t.isArrowFunctionExpression(fn)) {
      return { dep: null, bindings: [], _index: i };
    }
    const param = fn.params[0];
    const paramName = t.isIdentifier(param) ? param.name : null;
    const bindings = [];
    if (paramName) {
      // Collect identifiers locally assigned to an object expression and the
      // properties added to them (`var o = {}; o.X = t.Y`). After the loop we
      // know which `o`s are anonymous re-export collectors so we can fold
      // `_export(o)` into per-property re-exports.
      const collectors = new Map(); // name -> [{ exported, imported }]
      for (const stmt of fn.body.body) {
        if (t.isVariableDeclaration(stmt)) {
          for (const d of stmt.declarations) {
            if (
              t.isIdentifier(d.id) &&
              t.isObjectExpression(d.init) &&
              d.init.properties.length === 0
            ) {
              collectors.set(d.id.name, []);
            }
          }
          continue;
        }
        if (!t.isExpressionStatement(stmt)) continue;
        const exprs = t.isSequenceExpression(stmt.expression)
          ? stmt.expression.expressions
          : [stmt.expression];
        for (const e of exprs) {
          // `o.Foo = t.Bar` — collector property assignment (preludes
          // `_export(o)` later in the setter).
          if (
            t.isAssignmentExpression(e) &&
            t.isMemberExpression(e.left) &&
            !e.left.computed &&
            t.isIdentifier(e.left.object) &&
            collectors.has(e.left.object.name) &&
            t.isIdentifier(e.left.property) &&
            t.isMemberExpression(e.right) &&
            t.isIdentifier(e.right.object, { name: paramName }) &&
            (t.isIdentifier(e.right.property) || t.isStringLiteral(e.right.property))
          ) {
            const exported = e.left.property.name;
            const imported = t.isIdentifier(e.right.property)
              ? e.right.property.name
              : e.right.property.value;
            collectors.get(e.left.object.name).push({ exported, imported });
            continue;
          }
          // `_export("Name", t.X)` — single named re-export.
          if (
            exportParam &&
            t.isCallExpression(e) &&
            t.isIdentifier(e.callee, { name: exportParam }) &&
            e.arguments.length === 2 &&
            t.isStringLiteral(e.arguments[0]) &&
            t.isMemberExpression(e.arguments[1]) &&
            t.isIdentifier(e.arguments[1].object, { name: paramName }) &&
            (t.isIdentifier(e.arguments[1].property) || t.isStringLiteral(e.arguments[1].property))
          ) {
            const exported = e.arguments[0].value;
            const importedNode = e.arguments[1].property;
            const imported = t.isIdentifier(importedNode) ? importedNode.name : importedNode.value;
            bindings.push({ reexport: true, exported, imported });
            continue;
          }
          // `_export(o)` where `o` is a known collector — fold properties.
          if (
            exportParam &&
            t.isCallExpression(e) &&
            t.isIdentifier(e.callee, { name: exportParam }) &&
            e.arguments.length === 1 &&
            t.isIdentifier(e.arguments[0]) &&
            collectors.has(e.arguments[0].name)
          ) {
            for (const r of collectors.get(e.arguments[0].name)) {
              bindings.push({ reexport: true, exported: r.exported, imported: r.imported });
            }
            continue;
          }
          // `_export(t)` — re-export the whole namespace (`export * from`).
          if (
            exportParam &&
            t.isCallExpression(e) &&
            t.isIdentifier(e.callee, { name: exportParam }) &&
            e.arguments.length === 1 &&
            t.isIdentifier(e.arguments[0], { name: paramName })
          ) {
            bindings.push({ reexport: true, namespace: true });
            continue;
          }
          if (!t.isAssignmentExpression(e) || !t.isIdentifier(e.left)) continue;
          // `local = ns.prop` — named import binding.
          if (
            t.isMemberExpression(e.right) &&
            t.isIdentifier(e.right.object, { name: paramName })
          ) {
            const local = e.left.name;
            const importedNode = e.right.property;
            const imported = t.isIdentifier(importedNode)
              ? importedNode.name
              : (t.isStringLiteral(importedNode) ? importedNode.value : local);
            bindings.push({ local, imported });
            continue;
          }
          // `local = ns` — whole-namespace receiver (import * as local).
          if (t.isIdentifier(e.right, { name: paramName })) {
            bindings.push({ local: e.left.name, namespace: true });
            continue;
          }
        }
      }
    }
    return { dep: null, bindings, _index: i };
  });
}

module.exports = { splitChunks };

/**
 * Walk the execute() body and aggregate `_export("Name", ...)` and
 * `_export({a:..,b:..})` calls into the exports set. `default` is reported via
 * the markDefault callback. Used by the cross-bundle resolver to know what a
 * module actually exports beyond its setter-level re-exports.
 */
function collectExecuteBodyExports(bodyAst, exportParam, exportsSet, markDefault) {
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' &&
        node.callee && node.callee.type === 'Identifier' &&
        node.callee.name === exportParam) {
      const args = node.arguments || [];
      // _export("Name", ...) — single named export
      if (args.length >= 1 && args[0] && args[0].type === 'StringLiteral') {
        if (args[0].value === 'default') markDefault(true);
        else exportsSet.add(args[0].value);
      }
      // _export({ a: .., b: .. }) — bulk named export
      else if (args.length === 1 && args[0] && args[0].type === 'ObjectExpression') {
        for (const p of args[0].properties) {
          if (p.type === 'ObjectProperty' && !p.computed) {
            const k = p.key;
            const name = k && k.type === 'Identifier' ? k.name
              : (k && k.type === 'StringLiteral' ? k.value : null);
            if (name) {
              if (name === 'default') markDefault(true);
              else exportsSet.add(name);
            }
          }
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      const v = node[key];
      if (Array.isArray(v)) for (const c of v) visit(c);
      else if (v && typeof v === 'object' && v.type) visit(v);
    }
  }
  visit(bodyAst);
}

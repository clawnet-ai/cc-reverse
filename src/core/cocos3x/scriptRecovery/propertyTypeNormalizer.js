'use strict';

const t = require('@babel/types');
const traverseMod = require('@babel/traverse');
const traverse = traverseMod.default || traverseMod;

/**
 * Layer 4.5: normalize Cocos `@property({ type: String|Number|Boolean })`
 * decorator calls.
 *
 * Cocos 3.x emits a runtime warning for each property where:
 *   - `type` is a JS native constructor (String/Number/Boolean) instead of
 *     the engine wrapper (CCString/CCFloat/CCBoolean), OR
 *   - `type` is specified at all when the default value is already a
 *     typed literal — the engine can infer in that case.
 *
 * Source webpack/rollup output for these decorators looks like:
 *     var $ = _decorator.property;
 *     ... $({ type: String, tooltip: '...' })
 * or after partial restoration:
 *     _decorator.property({ type: Number, ... })
 *
 * Strategy:
 *   - Find call expressions whose callee resolves to `_decorator.property`
 *     either directly (`X.property(...)`) or via a top-level alias
 *     (`var $ = X.property` where X is the `_decorator` binding).
 *   - When the single argument is an ObjectExpression with a `type`
 *     property whose value is the Identifier String / Number / Boolean,
 *     drop that property entirely. The companion `initializer: function
 *     () { return ""; }` (string default) etc. already informs the engine.
 *   - If the object becomes empty after the drop, replace the call's
 *     argument list with no arguments (i.e. `$()`), which is valid for
 *     Cocos's `@property`.
 *
 * Conservative: untouched whenever `type` is anything other than these
 * three identifiers, so user-explicit `cc.Node` / class refs / array
 * sentinels are preserved.
 */

const NATIVE_TYPE_IDS = new Set(['String', 'Number', 'Boolean']);

async function normalizePropertyTypes(modules) {
  for (const mod of modules) {
    if (!mod || !mod.ast) continue;
    try {
      const aliasNames = collectPropertyAliases(mod.ast);
      stripNativeTypeProperty(mod.ast, aliasNames);
    } catch (_err) {
      // Fail-closed: leave AST untouched on traversal errors so we don't
      // regress the rest of the recovery pipeline.
    }
  }
  return modules;
}

/**
 * Walk the top-level Program for declarators of the form
 *   var <name> = <something>.property
 * Returns a Set of <name> strings. We use a syntactic match — the
 * member-expression object is not inspected because the `_decorator`
 * symbol is already minified and aliased above this layer.
 */
function collectPropertyAliases(ast) {
  const out = new Set();
  const program = ast.program || ast;
  if (!Array.isArray(program.body)) return out;
  for (const stmt of program.body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const d of stmt.declarations) {
      if (
        t.isIdentifier(d.id) &&
        t.isMemberExpression(d.init) &&
        !d.init.computed &&
        t.isIdentifier(d.init.property, { name: 'property' })
      ) {
        out.add(d.id.name);
      }
    }
  }
  return out;
}

function stripNativeTypeProperty(ast, aliasNames) {
  traverse(ast, {
    CallExpression(p) {
      if (!isPropertyCall(p.node.callee, aliasNames)) return;
      if (p.node.arguments.length !== 1) return;
      const arg = p.node.arguments[0];
      if (!t.isObjectExpression(arg)) return;
      const filtered = [];
      let dropped = false;
      for (const prop of arg.properties) {
        if (
          t.isObjectProperty(prop) &&
          !prop.computed &&
          t.isIdentifier(prop.key, { name: 'type' }) &&
          t.isIdentifier(prop.value) &&
          NATIVE_TYPE_IDS.has(prop.value.name)
        ) {
          dropped = true;
          continue;
        }
        filtered.push(prop);
      }
      if (!dropped) return;
      if (filtered.length === 0) {
        p.node.arguments = [];
      } else {
        arg.properties = filtered;
      }
    },
  });
}

function isPropertyCall(callee, aliasNames) {
  // `X.property(...)` — direct member-expression form.
  if (
    t.isMemberExpression(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.property, { name: 'property' })
  ) {
    return true;
  }
  // `<alias>(...)` where alias was bound to `X.property` at top level.
  if (t.isIdentifier(callee) && aliasNames.has(callee.name)) return true;
  return false;
}

module.exports = { normalizePropertyTypes };

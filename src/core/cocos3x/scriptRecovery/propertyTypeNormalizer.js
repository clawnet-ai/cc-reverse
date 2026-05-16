'use strict';

const t = require('@babel/types');
const traverseMod = require('@babel/traverse');
const traverse = traverseMod.default || traverseMod;

/**
 * Layer 4.5: normalize Cocos `@property({ type: ... })` decorator calls.
 *
 * Two transforms:
 *
 * (a) Scalar native → drop. `@property({ type: String|Number|Boolean })`
 *     emits a runtime warning because the JS native constructor isn't a
 *     recognized cc serialization type. The companion `initializer` already
 *     tells the engine what default to use, so the type entry is redundant
 *     and we just remove it. If the property object becomes empty after the
 *     drop, the call becomes `$()`.
 *
 * (b) Array native → engine wrapper. `@property({ type: [String] })`
 *     (array-element shape) does NOT have a meaningful initializer fallback
 *     because the property IS an array — we can't drop the type. Cocos
 *     requires the engine wrapper constructors here: CCString / CCFloat /
 *     CCBoolean. Without the rewrite, the editor logs e.g. `The type of
 *     "X.foo" must be CCString, not String.` for every offending property.
 *     Number maps to CCFloat (the safer default — CCInteger only fits when
 *     we know all elements are int, which the recovered source doesn't tell
 *     us). After rewriting, we append a side-effect: ensure the surrounding
 *     module imports the wrapper(s) from "cc".
 */

const NATIVE_TYPE_IDS = new Set(['String', 'Number', 'Boolean']);
const ARRAY_NATIVE_TO_WRAPPER = {
  String: 'CCString',
  Number: 'CCFloat',
  Boolean: 'CCBoolean',
};

async function normalizePropertyTypes(modules) {
  for (const mod of modules) {
    if (!mod || !mod.ast) continue;
    try {
      const aliasNames = collectPropertyAliases(mod.ast);
      stripNativeTypeProperty(mod.ast, aliasNames);
      const wrappersUsed = rewriteArrayNativeTypes(mod.ast, aliasNames);
      // Pass (c): inject inferred `type:` into bare `$()` / `$({...})` calls
      // that lack one. Cocos warns `You are explicitly specifying \`undefined\`
      // type to cc property "<name>" of cc class "<class>"` whenever a
      // @property decorator runs without a type entry and the runtime can't
      // dig one out of TS design-type metadata.
      const fillerWrappers = fillMissingTypesFromFieldTypes(mod.ast, aliasNames, mod.fieldTypes || {});
      for (const w of fillerWrappers) wrappersUsed.add(w);
      if (wrappersUsed.size > 0) ensureCcImports(mod.ast, wrappersUsed);
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

// Rewrite `type: [String|Number|Boolean]` (single-element array form Cocos
// uses to declare array-typed properties) into the engine wrapper
// constructor: `[CCString]` / `[CCFloat]` / `[CCBoolean]`. Returns the set
// of wrapper identifiers that were introduced so the caller can ensure
// matching `import { CCString } from "cc"` exists.
function rewriteArrayNativeTypes(ast, aliasNames) {
  const introduced = new Set();
  traverse(ast, {
    CallExpression(p) {
      if (!isPropertyCall(p.node.callee, aliasNames)) return;
      if (p.node.arguments.length !== 1) return;
      const arg = p.node.arguments[0];
      if (!t.isObjectExpression(arg)) return;
      for (const prop of arg.properties) {
        if (
          !t.isObjectProperty(prop) ||
          prop.computed ||
          !t.isIdentifier(prop.key, { name: 'type' })
        ) continue;
        if (!t.isArrayExpression(prop.value)) continue;
        if (prop.value.elements.length !== 1) continue;
        const el = prop.value.elements[0];
        if (!t.isIdentifier(el)) continue;
        const wrapper = ARRAY_NATIVE_TO_WRAPPER[el.name];
        if (!wrapper) continue;
        prop.value.elements[0] = t.identifier(wrapper);
        introduced.add(wrapper);
      }
    },
  });
  return introduced;
}

// Ensure `import { <wrapper> } from "cc"` covers each name in `wrappers`.
// Mutates an existing cc import declaration's specifier list when present;
// otherwise prepends a fresh import. We don't rename via local aliases —
// the rewritten array element identifier matches the wrapper name verbatim.
function ensureCcImports(ast, wrappers) {
  const program = ast.program || ast;
  if (!Array.isArray(program.body)) return;
  let ccImport = null;
  for (const stmt of program.body) {
    if (
      t.isImportDeclaration(stmt) &&
      t.isStringLiteral(stmt.source) &&
      stmt.source.value === 'cc'
    ) {
      ccImport = stmt;
      break;
    }
  }
  const existing = new Set();
  if (ccImport) {
    for (const s of ccImport.specifiers) {
      if (t.isImportSpecifier(s) && t.isIdentifier(s.imported)) {
        existing.add(s.imported.name);
      }
    }
  }
  const toAdd = [];
  for (const w of wrappers) {
    if (existing.has(w)) continue;
    toAdd.push(t.importSpecifier(t.identifier(w), t.identifier(w)));
  }
  if (toAdd.length === 0) return;
  if (ccImport) {
    ccImport.specifiers.push(...toAdd);
  } else {
    program.body.unshift(
      t.importDeclaration(toAdd, t.stringLiteral('cc'))
    );
  }
}

module.exports = { normalizePropertyTypes };

// Map an inferred-type string from typeInferer to a Cocos serialization type
// identifier suitable as the `type:` decorator entry. Returns null when the
// inference is too vague (e.g. 'any') or shouldn't be materialized as a type
// (array forms also skipped — Cocos serialization for arrays requires the
// element type, which we don't capture in fieldTypes).
function fieldTypeToDecorator(inferred) {
  if (typeof inferred !== 'string') return null;
  switch (inferred) {
    case 'string': return { name: 'CCString', wrapper: true };
    case 'number': return { name: 'CCFloat', wrapper: true };
    case 'boolean': return { name: 'CCBoolean', wrapper: true };
    default: return null; // arrays / 'any' / 'cc.Node' etc. — leave alone
  }
}

// Scan `<descriptorVar> = applyDecoratedDescriptor(<proto>, "<fieldName>",
// [<decoratorVar>, ...], { ... })` shapes and build decoratorVar → {fieldName,
// initializerType}. The runtime helper is emitted by Babel's class-properties
// transform when decorators target instance fields; we can't pattern-match
// the helper by identity (its name is minified) so we match by call shape:
// 4 args, second is a StringLiteral (field name), third is an ArrayExpression
// of decorator variables. The 4th arg's `initializer: function() { return
// <literal>; }` gives us a fallback type when typeInferer didn't observe the
// field in any scene (common for component-private state).
function buildDecoratorToFieldName(ast) {
  const out = new Map();
  traverse(ast, {
    CallExpression(p) {
      const args = p.node.arguments;
      if (!args || args.length < 4) return;
      if (!t.isStringLiteral(args[1])) return;
      if (!t.isArrayExpression(args[2])) return;
      const fieldName = args[1].value;
      const initializerType = extractInitializerLiteralType(args[3]);
      for (const el of args[2].elements) {
        if (t.isIdentifier(el) && !out.has(el.name)) {
          out.set(el.name, { fieldName, initializerType });
        }
      }
    },
  });
  return out;
}

// Read the 4th arg of applyDecoratedDescriptor — an object with
// `initializer: function() { return <expr>; }` — and return a typeInferer-
// compatible type string ('string' / 'number' / 'boolean') when the return
// value is a primitive literal. Anything more complex returns null.
function extractInitializerLiteralType(descArg) {
  if (!t.isObjectExpression(descArg)) return null;
  for (const prop of descArg.properties) {
    if (
      !t.isObjectProperty(prop) ||
      prop.computed ||
      !t.isIdentifier(prop.key, { name: 'initializer' })
    ) continue;
    const fn = prop.value;
    if (!t.isFunctionExpression(fn) && !t.isArrowFunctionExpression(fn)) return null;
    let returned = null;
    if (t.isBlockStatement(fn.body)) {
      for (const stmt of fn.body.body) {
        if (t.isReturnStatement(stmt)) { returned = stmt.argument; break; }
      }
    } else {
      returned = fn.body;
    }
    if (!returned) return null;
    if (t.isStringLiteral(returned)) return 'string';
    if (t.isNumericLiteral(returned)) return 'number';
    if (t.isBooleanLiteral(returned)) return 'boolean';
    // `-1`, `void 0`, etc. — UnaryExpression on a NumericLiteral counts.
    if (t.isUnaryExpression(returned) && t.isNumericLiteral(returned.argument)) {
      return 'number';
    }
    return null;
  }
  return null;
}

// Inject inferred `type:` entries into `@property` decorator calls that
// currently have no type, using the decorator-variable → field-name map plus
// `mod.fieldTypes`. Pattern: top-level `<dvar> = <propertyCall>` (sometimes
// `var <dvar> = ...` or part of a sequence/var-declaration), where
// propertyCall is `$()` or `$({ /* no type */ ... })`. Returns the set of
// wrapper names introduced so the caller can ensure cc imports.
function fillMissingTypesFromFieldTypes(ast, aliasNames, fieldTypes) {
  const introduced = new Set();
  const decoratorToField = buildDecoratorToFieldName(ast);
  if (decoratorToField.size === 0) return introduced;

  // For every `<dvar> = $(...)` or `var <dvar> = $(...)` form, see if dvar
  // maps back to a known field. Only inject when the initializer is NOT a
  // primitive literal — Cocos auto-infers cc.String/cc.Float/cc.Boolean from
  // a primitive default, so an explicit `type:` becomes redundant and warns.
  function tryInject(dvarName, callNode) {
    if (!callNode || !t.isCallExpression(callNode)) return;
    if (!isPropertyCall(callNode.callee, aliasNames)) return;
    const hit = decoratorToField.get(dvarName);
    if (!hit) return;
    // Cocos auto-infers the cc serialization type from a primitive initializer
    // (`return ""` → cc.String, `return -1` → cc.Float, `return false` →
    // cc.Boolean). Re-stating it via `type: CCString` triggers the "No needs
    // to indicate the 'cc.String' attribute" warning. So: only inject when the
    // initializer is NOT a primitive literal (missing initializer, or returns
    // null / undefined / an object that the engine can't infer from).
    if (hit.initializerType) return;
    let inferred = fieldTypes ? fieldTypes[hit.fieldName] : undefined;
    if (!inferred || inferred === 'any') return;
    const decorator = fieldTypeToDecorator(inferred);
    if (!decorator) return;

    // If the property call already has a `type:` entry, skip — we only fill
    // gaps, never overwrite. Likewise skip when call has unexpected shape.
    let argObj = callNode.arguments[0];
    if (argObj && !t.isObjectExpression(argObj)) return;
    if (argObj) {
      for (const prop of argObj.properties) {
        if (
          t.isObjectProperty(prop) &&
          !prop.computed &&
          t.isIdentifier(prop.key, { name: 'type' })
        ) return;
      }
    } else {
      argObj = t.objectExpression([]);
      callNode.arguments = [argObj];
    }
    argObj.properties.unshift(
      t.objectProperty(t.identifier('type'), t.identifier(decorator.name))
    );
    if (decorator.wrapper) introduced.add(decorator.name);
  }

  traverse(ast, {
    AssignmentExpression(p) {
      if (p.node.operator !== '=') return;
      if (!t.isIdentifier(p.node.left)) return;
      tryInject(p.node.left.name, p.node.right);
    },
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id)) return;
      tryInject(p.node.id.name, p.node.init);
    },
  });

  return introduced;
}

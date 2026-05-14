'use strict';

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const { parse } = require('@babel/parser');

/**
 * Layer 3: undo TypeScript ES5 helpers (__extends, __decorate) and restore
 * native class + decorator syntax.
 *
 * Implementation note: webcrack's `unminify` pass handles `__extends` (it
 * recognizes the IIFE shape and emits a class). For `__decorate` we run a
 * focused post-pass because webcrack 2.16.x leaves the assignment form alone
 * (it cannot prove decorators are side-effect-free in general). Cocos always
 * uses pure decorator factories so the transform is sound for our domain.
 */
async function restoreClasses(ast, _mod) {
  if (!ast) return null;

  // Fast path: when the chunk has already been webcrack'd at the engine
  // level (mod.preminified === true), __extends/__decorate are already
  // collapsed and the per-module webcrack hop is pure overhead. Skip
  // straight to the structural folds, which are no-ops when the AST is
  // already clean. Saves ~870 ms × N modules on slgq-class chunks.
  if (_mod && _mod.preminified) {
    foldExtendsIife(ast);
    foldDecorate(ast);
    return ast;
  }

  // 1. Hand off to webcrack for __extends collapsing. Webcrack consumes source
  //    text, not AST — we round-trip via generator/parse.
  const before = generate(ast, { compact: false }).code;
  let mid;
  try {
    let webcrackFn;
    try {
      // CommonJS path (webcrack ships dist/index.cjs).
      ({ webcrack: webcrackFn } = require('webcrack'));
    } catch (cjsErr) {
      // Fallback to dynamic ESM import.
      const mod = await import('webcrack');
      webcrackFn = mod.webcrack || (mod.default && mod.default.webcrack);
    }
    if (typeof webcrackFn !== 'function') throw new Error('webcrack not callable');
    const result = await webcrackFn(before, {
      jsx: false,
      mangle: false,
      unminify: true,
      deobfuscate: false,
      unpack: false,
    });
    mid = parse(result.code, {
      sourceType: 'module',
      plugins: ['decorators-legacy', 'classProperties'],
    });
  } catch (_err) {
    // Fail-closed: keep original AST.
    mid = ast;
  }

  // 2. Fold any leftover `var X = (function(_super){ __extends(X,_super); ... return X; }(Super))`
  //    IIFE that webcrack only stripped parentheses from. This produces a
  //    native ClassDeclaration so step 3 can attach decorators.
  foldExtendsIife(mid);

  // 3. Fold standalone `Class = __decorate([...], Class);` assignments into
  //    `@decorator class Class { ... }` declarations.
  foldDecorate(mid);

  return mid;
}

/**
 * Detect statement-level `var X = (function(_super){ __extends(X,_super); ... return X; }(Super));`
 * (with or without the outer ParenthesizedExpression) and rewrite it to a
 * native `class X extends Super { ... }` declaration.
 *
 * MVP scope (sufficient for the Cocos domain):
 *   - constructor `function X(params){ body }` → `constructor(params){ body }`,
 *     unless the body is a pure super-forwarder (`return _super.apply(this, arguments) || this;`
 *     or `return _super.call(this, ...args) || this;`), in which case constructor is omitted
 *     and the JS engine's default constructor handles forwarding.
 *   - prototype methods `X.prototype.m = function(params){ body }` → `m(params){ body }`.
 *   - prototype non-function fields and static assignments are dropped (rare in
 *     compiled cocos scripts; can be added later if needed).
 */
function foldExtendsIife(ast) {
  // Pre-scan top-level declarations to count name occurrences. Babel's
  // traverse() throws "Duplicate declaration" eagerly during scope-build,
  // before our visitors run, so we can't rely on per-node guards. Instead we
  // collect every top-level declared identifier upfront; if a name appears
  // more than once at top level, folding the IIFE for that name would create
  // a redeclaration the engine refuses to load. Skip it.
  const conflictNames = computeTopLevelConflicts(ast);

  // Babel's scope-build can throw "Duplicate declaration" for AST that we
  // produced earlier in the pipeline (e.g. when esmRebuilder emits both
  // `export let X` and a sibling `var X`). Swallow the throw — the pre-scan
  // above already prevents us from making the situation worse, and any IIFE
  // we couldn't traverse simply stays in its current form.
  try {
    traverse(ast, {
    VariableDeclaration(path) {
      // Only handle top-level / block-level `var X = ...;` with a single declarator.
      const decls = path.node.declarations;
      if (decls.length !== 1) return;
      const decl = decls[0];
      if (!t.isIdentifier(decl.id) || !decl.init) return;

      const className = decl.id.name;
      let match = matchExtendsIife(decl.init, className);
      let innerCtorName = className;
      let helperIdx = 0;
      if (!match) {
        // Fallback: outer var name differs from inner ctor name, e.g.
        //   var xt = function(t){ function n(e,i){...} e(n,t); i(n,[...]); return n; }(d);
        // Webcrack's babel-loose output for minified bundles regularly emits this
        // shape — `n` is the inner ctor while `xt` is the user-visible binding.
        // Treat it as `class xt extends d { ... }`.
        const anon = matchAnonExtendsIife(decl.init);
        if (!anon) return;
        match = anon;
        innerCtorName = anon.innerCtorName;
        helperIdx = anon.helperIdx;
      }

      const { superExpr, fnBody, superParamName } = match;
      const members = buildClassMembers(fnBody, innerCtorName, superParamName, [helperIdx]);
      if (members === null) return; // structure didn't match expectations; skip

      // Bail if the outer name collides with a sibling top-level declaration
      // (e.g. `let GameKeyMgr = {...}` later in the module). Folding would
      // produce a duplicate-identifier SyntaxError that the engine refuses to
      // load. Better to leave the IIFE intact than to brick the whole module.
      if (conflictNames.has(className)) return;

      const classDecl = t.classDeclaration(
        t.identifier(className),
        superExpr,
        t.classBody(members),
      );
      // Remove the existing `var X` binding before replacing, otherwise Babel's
      // scope tracker raises "Duplicate declaration" when the new ClassDeclaration
      // tries to register the same name in the same block scope.
      if (path.scope && path.scope.removeBinding) {
        path.scope.removeBinding(className);
      }
      path.replaceWith(classDecl);
    },

    // Anonymous IIFE-class wrapped in `new`:
    //   var X = new (function(_super){ <helper>(__c, _super); function __c(){...}
    //                                   __c.prototype.m = ...; return __c; }(Super))();
    // Here `X` is an instance of an anonymous subclass. Replace the inner
    // CallExpression with a ClassExpression so the outer `new ()` invokes a
    // real ES6 class — required because `_super.apply(this, args)` throws
    // 'cannot be invoked without new' against an ES6 base class.
    NewExpression(path) {
      const callee = unwrapParen(path.node.callee);
      // We need a CallExpression of an IIFE that returns the ctor function.
      if (!t.isCallExpression(callee)) return;
      const innerMatch = matchAnonExtendsIife(callee);
      if (!innerMatch) return;
      const { superExpr, fnBody, superParamName, innerCtorName, helperIdx } = innerMatch;
      const members = buildClassMembers(fnBody, innerCtorName, superParamName, [helperIdx]);
      if (members === null) return;
      const classExpr = t.classExpression(
        null,
        superExpr,
        t.classBody(members),
      );
      path.node.callee = classExpr;
    },
  });
  } catch (e) {
    if (!/Duplicate declaration/.test(String(e && e.message))) throw e;
  }
}

// Variant of matchExtendsIife for the anonymous case: the IIFE body declares
// an inner ctor (any name) instead of using the outer `var X`.
function matchAnonExtendsIife(initRaw) {
  const init = unwrapParen(initRaw);
  if (!t.isCallExpression(init)) return null;
  if (init.arguments.length !== 1) return null;
  const superExpr = init.arguments[0];

  const callee = unwrapParen(init.callee);
  if (!t.isFunctionExpression(callee)) return null;
  if (callee.params.length !== 1 || !t.isIdentifier(callee.params[0])) return null;
  const superParamName = callee.params[0].name;

  const body = callee.body.body;
  if (body.length < 2) return null;

  // Last statement: return <innerCtor>;
  const last = body[body.length - 1];
  if (!t.isReturnStatement(last)) return null;
  if (!t.isIdentifier(last.argument)) return null;
  const innerCtorName = last.argument.name;

  // Scan for the helper call <helper>(<innerCtor>, <superParam>) anywhere in the body.
  // The minified anonymous form often emits `function i(){}` first, then `e(i,t);`.
  let helperIdx = -1;
  for (let i = 0; i < body.length - 1; i++) {
    const s = body[i];
    if (!t.isExpressionStatement(s)) continue;
    const fc = s.expression;
    if (!t.isCallExpression(fc)) continue;
    if (!t.isIdentifier(fc.callee)) continue;
    if (fc.arguments.length !== 2) continue;
    if (!t.isIdentifier(fc.arguments[0], { name: innerCtorName })) continue;
    if (!t.isIdentifier(fc.arguments[1], { name: superParamName })) continue;
    helperIdx = i;
    break;
  }
  if (helperIdx < 0) return null;

  return { superExpr, fnBody: body, superParamName, innerCtorName, helperIdx };
}

function unwrapParen(node) {
  while (node && (t.isParenthesizedExpression?.(node) || node.type === 'ParenthesizedExpression')) {
    node = node.expression;
  }
  return node;
}

function matchExtendsIife(initRaw, className) {
  const init = unwrapParen(initRaw);
  if (!t.isCallExpression(init)) return null;
  if (init.arguments.length !== 1) return null;
  const superExpr = init.arguments[0];

  const callee = unwrapParen(init.callee);
  if (!t.isFunctionExpression(callee)) return null;
  if (callee.params.length !== 1 || !t.isIdentifier(callee.params[0])) return null;
  // The IIFE's parameter is the "_super" placeholder. In unminified webpack
  // output it's literally `_super`; in minified bundles webcrack didn't
  // rename it, so it's a single-letter identifier (e.g. `t`). Match against
  // whatever the function declared, then verify the body uses that same name.
  const superParamName = callee.params[0].name;

  const body = callee.body.body;
  if (body.length < 2) return null;

  // First statement: <extendsHelper>(<className>, <superParamName>);
  // The helper itself may be `__extends` (TS), `_extends`, `__inherits`,
  // or — in minified bundles — a single-letter identifier (e.g. `e`).
  // We don't validate the helper name; the (className, superParam) shape
  // and the trailing `return <className>;` are sufficient signal.
  const first = body[0];
  if (!t.isExpressionStatement(first)) return null;
  const fcall = first.expression;
  if (!t.isCallExpression(fcall)) return null;
  if (!t.isIdentifier(fcall.callee)) return null;
  if (fcall.arguments.length !== 2) return null;
  if (!t.isIdentifier(fcall.arguments[0], { name: className })) return null;
  if (!t.isIdentifier(fcall.arguments[1], { name: superParamName })) return null;

  // Last statement: return <className>;
  const last = body[body.length - 1];
  if (!t.isReturnStatement(last)) return null;
  if (!t.isIdentifier(last.argument, { name: className })) return null;

  return { superExpr, fnBody: body, superParamName };
}

function buildClassMembers(fnBody, className, superParamName, skipIdxList) {
  const members = [];
  const skip = new Set(skipIdxList || []);
  // Iterate the IIFE body skipping the trailing return and any helper-call indices.
  for (let i = 0; i < fnBody.length - 1; i++) {
    if (skip.has(i)) continue;
    const stmt = fnBody[i];

    // Constructor: `function ClassName(params) { body }`
    if (t.isFunctionDeclaration(stmt) && stmt.id && stmt.id.name === className) {
      if (isPureSuperForwarder(stmt.body, stmt.params, superParamName)) continue; // omit, default ctor suffices
      const ctorBody = rewriteCtorBody(stmt.body, superParamName);
      if (ctorBody === null) return null; // bail — emit nothing, keep IIFE intact
      const ctor = t.classMethod(
        'constructor',
        t.identifier('constructor'),
        stmt.params,
        ctorBody,
      );
      members.push(ctor);
      continue;
    }

    // Prototype assignment: `ClassName.prototype.<name> = <value>;`
    if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression, { operator: '=' })) {
      const left = stmt.expression.left;
      const right = stmt.expression.right;
      if (
        t.isMemberExpression(left) &&
        t.isMemberExpression(left.object) &&
        t.isIdentifier(left.object.object, { name: className }) &&
        t.isIdentifier(left.object.property, { name: 'prototype' }) &&
        !left.computed &&
        !left.object.computed &&
        t.isIdentifier(left.property)
      ) {
        if (t.isFunctionExpression(right)) {
          const methodBody = rewriteMethodBody(right.body, superParamName, left.property.name);
          const method = t.classMethod(
            'method',
            t.identifier(left.property.name),
            right.params,
            methodBody,
          );
          members.push(method);
        }
        // non-function prototype fields: drop in MVP
        continue;
      }
      // static assignments like `ClassName.foo = ...` — drop in MVP.
    }
    // anything else (helper var decls, etc.) — drop in MVP.
  }
  return members;
}

// Rewrite babel-loose constructor body:
//   var r;
//   (r = SUP.call(this, ...) || this).field = ...;
//   return r;
// into:
//   super(...);
//   this.field = ...;
// Conservative: returns null (caller bails) when shape isn't recognized.
function rewriteCtorBody(block, superParamName) {
  const out = [];
  let aliasName = null; // the `r` in `var r; (r = SUP.call(this,...)||this).x = ...;`

  for (let i = 0; i < block.body.length; i++) {
    const stmt = block.body[i];

    // Skip `var r;` (alias declaration, no initializer)
    if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1) {
      const d = stmt.declarations[0];
      if (t.isIdentifier(d.id) && !d.init) {
        // Tentatively the alias; finalized when we see the assign-to-super pattern.
        if (!aliasName) aliasName = d.id.name;
        continue;
      }
    }

    // Recognize the loose super call:
    //   (alias = SUP.call(this, ARGS) || this).field = VALUE;   → super(ARGS); this.field = VALUE;
    //   (alias = SUP.call(this, ARGS) || this);                 → super(ARGS);
    //    alias = SUP.call(this, ARGS) || this;                  → super(ARGS);
    //    SUP.call(this, ARGS);                                  → super(ARGS);
    //    return SUP.call(this, ARGS) || this;                   → super(ARGS);
    if (t.isExpressionStatement(stmt)) {
      const e = stmt.expression;

      // Trailing field write: (alias = ... || this).field = VALUE;
      if (
        t.isAssignmentExpression(e, { operator: '=' }) &&
        t.isMemberExpression(e.left) &&
        !e.left.computed &&
        t.isIdentifier(e.left.property)
      ) {
        const obj = e.left.object;
        const inner = matchAliasedSuperOr(obj, superParamName, aliasName);
        if (inner) {
          out.push(t.expressionStatement(t.callExpression(t.super(), inner.args)));
          out.push(t.expressionStatement(t.assignmentExpression(
            '=',
            t.memberExpression(t.thisExpression(), e.left.property),
            e.right,
          )));
          continue;
        }
      }

      // Plain alias = ... || this;
      const aliasOnly = matchAliasedSuperOr(e, superParamName, aliasName);
      if (aliasOnly) {
        out.push(t.expressionStatement(t.callExpression(t.super(), aliasOnly.args)));
        continue;
      }

      // Bare SUP.call(this, ARGS);
      const bare = matchSuperCall(e, superParamName);
      if (bare) {
        out.push(t.expressionStatement(t.callExpression(t.super(), bare)));
        continue;
      }

      // Other: rewrite stray `aliasName.X` references → `this.X`.
      out.push(rewriteAliasRefs(stmt, aliasName));
      continue;
    }

    if (t.isReturnStatement(stmt)) {
      // return alias;  → drop (implicit `this` after super())
      // return SUP.call(this, ARGS) || this; → super(ARGS);
      if (stmt.argument && t.isIdentifier(stmt.argument, { name: aliasName || '__never__' })) {
        continue;
      }
      if (stmt.argument) {
        const sc = matchAliasedSuperOr(stmt.argument, superParamName, aliasName);
        if (sc) {
          out.push(t.expressionStatement(t.callExpression(t.super(), sc.args)));
          continue;
        }
        const bare = matchSuperCall(stmt.argument, superParamName);
        if (bare) {
          out.push(t.expressionStatement(t.callExpression(t.super(), bare)));
          continue;
        }
      }
      // Unrecognized return; bail.
      return null;
    }

    // Other statements: rewrite alias refs and pass through.
    out.push(rewriteAliasRefs(stmt, aliasName));
  }

  return t.blockStatement(out);
}

// Match `SUP.call(this, ...args)` or `SUP.apply(this, args)` → return the args
// that should be forwarded as super(...).
function matchSuperCall(node, superParamName) {
  if (!t.isCallExpression(node)) return null;
  const callee = node.callee;
  if (!t.isMemberExpression(callee) || callee.computed) return null;
  if (!t.isIdentifier(callee.object, { name: superParamName })) return null;
  if (!t.isIdentifier(callee.property)) return null;
  if (node.arguments.length < 1 || !t.isThisExpression(node.arguments[0])) return null;
  if (callee.property.name === 'call') {
    return node.arguments.slice(1);
  }
  if (callee.property.name === 'apply') {
    if (node.arguments.length === 2) {
      return [t.spreadElement(node.arguments[1])];
    }
  }
  return null;
}

// Match `(alias = SUP.call(this, ARGS) || this)` shape (with or without alias).
function matchAliasedSuperOr(node, superParamName, aliasName) {
  let inner = node;
  if (t.isAssignmentExpression(node, { operator: '=' }) && t.isIdentifier(node.left)) {
    if (aliasName && node.left.name !== aliasName) return null;
    inner = node.right;
  }
  if (t.isLogicalExpression(inner, { operator: '||' }) && t.isThisExpression(inner.right)) {
    inner = inner.left;
  }
  const args = matchSuperCall(inner, superParamName);
  if (!args) return null;
  return { args };
}

// Replace every `alias.<X>` MemberExpression with `this.<X>` in-place.
function rewriteAliasRefs(node, aliasName) {
  if (!aliasName) return node;
  // Light-weight in-place walk; avoids importing @babel/traverse for sub-trees.
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (n.type === 'MemberExpression' && n.object && n.object.type === 'Identifier' && n.object.name === aliasName) {
      n.object = t.thisExpression();
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'leadingComments' || k === 'trailingComments') continue;
      visit(n[k]);
    }
  };
  visit(node);
  return node;
}

// Rewrite a prototype method body: replace `SUP.prototype.X.call(this, args)` →
// `super.X(args)`. Conservative; unknown shapes are left intact.
function rewriteMethodBody(block, superParamName, _methodName) {
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (
      n.type === 'CallExpression' &&
      n.callee && n.callee.type === 'MemberExpression' && !n.callee.computed &&
      n.callee.property && n.callee.property.type === 'Identifier' &&
      (n.callee.property.name === 'call' || n.callee.property.name === 'apply') &&
      n.callee.object && n.callee.object.type === 'MemberExpression' && !n.callee.object.computed &&
      n.callee.object.property && n.callee.object.property.type === 'Identifier' &&
      n.callee.object.object && n.callee.object.object.type === 'MemberExpression' && !n.callee.object.object.computed &&
      n.callee.object.object.object && n.callee.object.object.object.type === 'Identifier' &&
      n.callee.object.object.object.name === superParamName &&
      n.callee.object.object.property && n.callee.object.object.property.name === 'prototype' &&
      n.arguments.length >= 1 && n.arguments[0].type === 'ThisExpression'
    ) {
      const methodId = n.callee.object.property; // X
      const isApply = n.callee.property.name === 'apply';
      n.callee = t.memberExpression(t.super(), methodId);
      n.arguments = isApply
        ? (n.arguments.length === 2 ? [t.spreadElement(n.arguments[1])] : [])
        : n.arguments.slice(1);
      return;
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'leadingComments' || k === 'trailingComments') continue;
      visit(n[k]);
    }
  };
  visit(block);
  return block;
}

function isPureSuperForwarder(blockBody, params, superParamName) {
  const stmts = blockBody.body;
  if (stmts.length !== 1) return false;
  const ret = stmts[0];
  if (!t.isReturnStatement(ret) || !ret.argument) return false;

  // Accept `<superParam>.<call|apply>(...) || this`
  let expr = ret.argument;
  if (t.isLogicalExpression(expr, { operator: '||' }) && t.isThisExpression(expr.right)) {
    expr = expr.left;
  }
  if (!t.isCallExpression(expr)) return false;
  const callee = expr.callee;
  if (
    !t.isMemberExpression(callee) ||
    !t.isIdentifier(callee.object, { name: superParamName }) ||
    !t.isIdentifier(callee.property)
  ) return false;
  const method = callee.property.name;
  if (method !== 'call' && method !== 'apply') return false;

  // First arg must be `this`.
  if (expr.arguments.length < 1 || !t.isThisExpression(expr.arguments[0])) return false;

  // Pure forwarder: `_super.apply(this, arguments)` (params irrelevant) OR
  // `_super.call(this, p1, p2, ...)` matching declared params 1:1.
  if (method === 'apply') {
    return expr.arguments.length === 2 && t.isIdentifier(expr.arguments[1], { name: 'arguments' });
  }
  // call: ensure passed args match declared params positionally.
  const passed = expr.arguments.slice(1);
  if (passed.length !== params.length) return false;
  for (let i = 0; i < passed.length; i++) {
    const p = params[i];
    if (!t.isIdentifier(p) || !t.isIdentifier(passed[i], { name: p.name })) return false;
  }
  return true;
}

/**
 * Find statements of the form:
 *   X = __decorate([d1, d2, ...], X);
 * and merge the decorator list into the most recent `class X { ... }` declaration
 * appearing earlier in the same Program. Then remove the standalone assignment.
 */
function foldDecorate(ast) {
  traverse(ast, {
    Program(path) {
      const body = path.node.body;
      const toRemove = [];
      for (let i = 0; i < body.length; i++) {
        const stmt = body[i];
        const target = matchDecorateAssign(stmt);
        if (!target) continue;
        const { className, decorators } = target;
        let attached = false;
        for (let j = i - 1; j >= 0; j--) {
          const decl = unwrapClassDecl(body[j]);
          if (decl && t.isClassDeclaration(decl) && decl.id && decl.id.name === className) {
            decl.decorators = (decl.decorators || []).concat(decorators);
            attached = true;
            break;
          }
        }
        if (attached) toRemove.push(i);
      }
      for (let k = toRemove.length - 1; k >= 0; k--) body.splice(toRemove[k], 1);
    },
  });
}

function matchDecorateAssign(stmt) {
  if (!t.isExpressionStatement(stmt)) return null;
  const expr = stmt.expression;
  if (!t.isAssignmentExpression(expr, { operator: '=' })) return null;
  if (!t.isIdentifier(expr.left)) return null;
  if (!t.isCallExpression(expr.right)) return null;
  if (!t.isIdentifier(expr.right.callee, { name: '__decorate' })) return null;
  const args = expr.right.arguments;
  if (args.length < 2 || !t.isArrayExpression(args[0])) return null;
  if (!t.isIdentifier(args[1]) || args[1].name !== expr.left.name) return null;
  return {
    className: expr.left.name,
    decorators: args[0].elements.filter(Boolean).map((el) => t.decorator(el)),
  };
}

function unwrapClassDecl(stmt) {
  if (t.isClassDeclaration(stmt)) return stmt;
  if (t.isExportNamedDeclaration(stmt) && t.isClassDeclaration(stmt.declaration)) return stmt.declaration;
  if (t.isExportDefaultDeclaration(stmt) && t.isClassDeclaration(stmt.declaration)) return stmt.declaration;
  return null;
}

// True if any other top-level statement in the same Program declares `name`
// (var/let/const, function, class, export-let, etc.). The current declarator
// (`path`) itself is excluded.
function hasSiblingDeclarationOfName(path, name) {
  const program = path.findParent((p) => p.isProgram());
  if (!program) return false;
  const ownNode = path.node;
  const body = program.node.body;
  for (const stmt of body) {
    if (stmt === ownNode) continue;
    if (declarationDeclares(stmt, name, ownNode)) return true;
  }
  return false;
}

// Walk a Program and return the Set of top-level identifier names that are
// declared more than once. We use this to suppress IIFE→class folds that
// would create duplicate declarations the engine rejects with SyntaxError.
function computeTopLevelConflicts(ast) {
  const counts = new Map();
  if (!ast || !ast.program || !Array.isArray(ast.program.body)) return new Set();
  for (const stmt of ast.program.body) {
    for (const name of declaredNames(stmt)) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  const dupes = new Set();
  for (const [name, n] of counts) if (n > 1) dupes.add(name);
  return dupes;
}

function declaredNames(stmt) {
  if (!stmt) return [];
  if (t.isClassDeclaration(stmt) && stmt.id) return [stmt.id.name];
  if (t.isFunctionDeclaration(stmt) && stmt.id) return [stmt.id.name];
  if (t.isVariableDeclaration(stmt)) {
    const out = [];
    for (const d of stmt.declarations) {
      if (t.isIdentifier(d.id)) out.push(d.id.name);
    }
    return out;
  }
  if (t.isExportNamedDeclaration(stmt) && stmt.declaration) return declaredNames(stmt.declaration);
  if (t.isExportDefaultDeclaration(stmt) && stmt.declaration) return declaredNames(stmt.declaration);
  return [];
}

function declarationDeclares(stmt, name, exclude) {
  if (!stmt || stmt === exclude) return false;
  if (t.isClassDeclaration(stmt) && stmt.id && stmt.id.name === name) return true;
  if (t.isFunctionDeclaration(stmt) && stmt.id && stmt.id.name === name) return true;
  if (t.isVariableDeclaration(stmt)) {
    for (const d of stmt.declarations) {
      if (t.isIdentifier(d.id, { name })) return true;
    }
  }
  if (t.isExportNamedDeclaration(stmt) && stmt.declaration) {
    return declarationDeclares(stmt.declaration, name, exclude);
  }
  if (t.isExportDefaultDeclaration(stmt) && stmt.declaration) {
    return declarationDeclares(stmt.declaration, name, exclude);
  }
  return false;
}

module.exports = { restoreClasses };

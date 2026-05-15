'use strict';

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;

/**
 * Layer 1.6: when a leaf module (e.g. `GameOverAction`) participates in an
 * import cycle and uses a sibling cycle module as its `extends` super-class
 * (via Babel's `inheritsLoose(child, parent)` IIFE pattern), defer the super
 * binding so module-init can complete even when the post-order DFS of cocos's
 * SystemJS loader hasn't executed the super module yet.
 *
 * Why this exists
 * ---------------
 * cycleBreaker can convert *runtime-only* edges to namespace imports — that
 * solves cycles whose breakable bindings are inside method bodies. But when a
 * leaf module's `extends` reference is itself part of a cycle (e.g. cocos
 * editor independently imports every ccclass file, exposing leaf-as-entry DFS
 * paths the original game's scene-driven entry never hits), the leaf's
 * top-level `inheritsLoose(child, parentLocal)` runs while `parentLocal` is
 * still `undefined`, throwing "Cannot read properties of undefined (reading
 * 'prototype')".
 *
 * Strategy
 * --------
 * For each module that
 *   a) lives inside a residual SCC reported by cycleBreaker,
 *   b) imports another SCC member as a *named* binding,
 *   c) passes that binding as the IIFE actual argument that drives the
 *      Babel `inheritsLoose` super-class hookup,
 * rewrite the importer module so that:
 *   - The named import is converted to a namespace import (`__cycdep_X`).
 *   - The IIFE actual argument becomes `__cycdep_X.Imported || class {}`,
 *     i.e. a placeholder class is used until the real super lands.
 *   - All references to the IIFE formal parameter inside the IIFE body are
 *     rewritten to `__cycdep_X.Imported`, so methods invoked at runtime
 *     resolve through the namespace member access (lazy by design).
 *   - The module appends `queueMicrotask(() => Object.setPrototypeOf(...))`
 *     to retroactively fix the prototype chain once the entire SystemJS
 *     register graph has finished synchronous execution.
 *
 * Decorators (`@ccclass`, `@property`) only inspect the class body and class
 * id — they do not capture the super class — so the fix-up is invisible to
 * cocos's editor reflection.
 *
 * Limitations
 * -----------
 *  - Only handles the Babel `inheritsLoose(child, parent)` IIFE shape — the
 *    only shape cc-reverse currently recovers from cocos 3.x outputs.
 *  - `instanceof Super` and `Reflect.getPrototypeOf(Sub)` performed during
 *    module init (before the microtask runs) will see the placeholder class.
 *    cocos's editor + runtime reflection happens after module init so this
 *    is safe in practice.
 */
async function deferCycleSuperClasses(modules, cycleSccs, _context) {
  const errors = [];
  if (!Array.isArray(modules) || !Array.isArray(cycleSccs) || cycleSccs.length === 0) {
    return { errors, rewritten: [] };
  }

  const rewritten = [];
  // Build name -> module index for SCC membership lookup keyed by basename
  // (matches cycleBreaker's basename-keyed graph).
  const moduleByName = new Map();
  for (const m of modules) {
    if (m && m.name && !moduleByName.has(m.name)) moduleByName.set(m.name, m);
  }

  for (const scc of cycleSccs) {
    const sccNames = new Set();
    for (const m of scc) if (m && m.name) sccNames.add(m.name);
    for (const m of scc) {
      try {
        const changed = rewriteModuleSupers(m, sccNames);
        if (changed) rewritten.push({ module: m.name, supers: changed });
      } catch (err) {
        errors.push({ layer: 'cycleSuperRewriter', module: m && m.name, message: err.message });
      }
    }
  }

  return { errors, rewritten };
}

function depBasename(dep) {
  if (typeof dep !== 'string') return null;
  const m = dep.match(/(?:^|\/)([^/]+?)(\.[mc]?[jt]s)?$/);
  if (!m) return null;
  return m[1];
}

function rewriteModuleSupers(mod, sccNames) {
  if (!mod || !mod.ast || !Array.isArray(mod.setterBindings)) return null;
  // Map: setter local name -> { dep, imported, sccName }
  const inSccLocals = new Map();
  for (const setter of mod.setterBindings) {
    const base = depBasename(setter.dep);
    if (!base || !sccNames.has(base) || base === mod.name) continue;
    for (const b of setter.bindings) {
      if (!b || !b.local) continue;
      if (b.namespace || b.reexport) continue;
      if (!b.imported) continue;
      inSccLocals.set(b.local, { dep: setter.dep, imported: b.imported, sccName: base, setter });
    }
  }
  if (!inSccLocals.size) return null;

  // Find IIFE actual argument that is one of inSccLocals — that is the super
  // local feeding `inheritsLoose(child, parent)`. We search for the precise
  // Babel pattern: a CallExpression whose callee is a FunctionExpression
  // containing `inheritsLoose(_, t)` (or the same call after minification) at
  // the IIFE body's top level, and whose first argument is an Identifier we
  // tracked.
  const matches = [];
  traverse(mod.ast, {
    CallExpression(p) {
      const node = p.node;
      const callee = node.callee;
      if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) return;
      if (!callee.params.length) return;
      const formalParam = callee.params[0];
      if (!t.isIdentifier(formalParam)) return;
      if (!node.arguments.length) return;
      const arg0 = node.arguments[0];
      if (!t.isIdentifier(arg0)) return;
      if (!inSccLocals.has(arg0.name)) return;
      // Confirm the body uses `inheritsLoose(_, formalParam)` (or `i(_, t)`
      // after minification, which we cannot pattern-match by helper name —
      // require a CallExpression whose 2nd arg is the formal param).
      if (!iifeBodyUsesFormalAsSuper(callee.body, formalParam.name)) return;
      const info = inSccLocals.get(arg0.name);
      matches.push({ callPath: p, calleePath: p.get('callee'), formalName: formalParam.name, super: info, iife: callee });
    },
  });

  if (!matches.length) return null;

  const rewrites = [];
  for (const match of matches) {
    const nsName = ensureNamespaceImport(mod, match.super);
    const importedId = t.memberExpression(t.identifier(nsName), t.identifier(match.super.imported));
    // 1) Replace IIFE actual arg with `nsName.Imported || class {}`
    match.callPath.node.arguments[0] = t.logicalExpression(
      '||',
      t.memberExpression(t.identifier(nsName), t.identifier(match.super.imported)),
      t.classExpression(null, null, t.classBody([]))
    );
    // 2) Rewrite all references to `formalName` inside the IIFE body to `nsName.Imported`.
    rewriteFormalReferences(match.calleePath, match.formalName, nsName, match.super.imported);
    rewrites.push({ super: match.super.imported, ns: nsName });
  }

  // 3) Append the microtask prototype-chain repair statement(s).
  appendPrototypeChainRepair(mod, rewrites);

  return rewrites;
}

function iifeBodyUsesFormalAsSuper(blockOrExpr, formalName) {
  let found = false;
  const visitor = {
    CallExpression(p) {
      if (found) return;
      const args = p.node.arguments;
      if (args.length >= 2 && t.isIdentifier(args[1]) && args[1].name === formalName) {
        // Best-effort: any call that takes the formal as its 2nd arg is
        // either inheritsLoose or a callsite that pipes super through.
        found = true;
      }
    },
  };
  // blockOrExpr might be a BlockStatement or expression body of arrow fn
  if (t.isBlockStatement(blockOrExpr)) {
    traverse(t.file(t.program(blockOrExpr.body)), visitor);
  } else if (blockOrExpr) {
    traverse(t.file(t.program([t.expressionStatement(blockOrExpr)])), visitor);
  }
  return found;
}

function ensureNamespaceImport(mod, superInfo) {
  // Convert the named setter to a namespace setter (sharing the dep). If the
  // dep already has a namespace setter elsewhere, reuse its local name.
  for (const s of mod.setterBindings) {
    if (s.dep !== superInfo.dep) continue;
    const ns = s.bindings.find((b) => b.namespace);
    if (ns) return ns.local;
  }
  // Mutate IN PLACE: replace this dep's setter bindings with a single
  // namespace specifier. We must NOT push a sibling setter for the same
  // dep — Cocos editor's SystemJS dep-list dedupes per module specifier
  // but the executor still walks setters by index, so a duplicate dep
  // emits a "ghost" setter that gets fed an unrelated module's namespace
  // (off-by-one alignment), causing
  //   "Cannot read properties of undefined (reading 'ActionBase')".
  // The original named local (e.g. `s`) had all its references already
  // rewritten to `__cycdep_X.Imported` by rewriteFormalReferences, so it
  // is safe to drop.
  const safe = (depBasename(superInfo.dep) || 'dep').replace(/[^A-Za-z0-9_]/g, '_');
  const nsName = makeUniqueIdent(mod, `__cycdep_${safe}`);
  const target = mod.setterBindings.find((s) => s.dep === superInfo.dep);
  if (target) {
    target.bindings = [{ local: nsName, namespace: true }];
  } else {
    mod.setterBindings.push({
      dep: superInfo.dep,
      bindings: [{ local: nsName, namespace: true }],
    });
  }
  return nsName;
}

function rewriteFormalReferences(iifePath, formalName, nsName, importedName) {
  iifePath.traverse({
    Identifier(p) {
      if (p.node.name !== formalName) return;
      if (!p.isReferencedIdentifier()) return;
      // Skip the formal param declaration itself (parent is the function node).
      if (p.parentPath.isFunctionExpression() || p.parentPath.isArrowFunctionExpression()) {
        if (Array.isArray(p.parentPath.node.params) && p.parentPath.node.params.includes(p.node)) return;
      }
      // Skip references shadowed by a nested scope binding for the same name.
      const binding = p.scope.getBinding(formalName);
      // The IIFE itself owns the binding; only rewrite references whose
      // closest binding lives in the IIFE scope.
      if (binding && binding.scope !== iifePath.scope) return;
      p.replaceWith(t.memberExpression(t.identifier(nsName), t.identifier(importedName)));
      p.skip();
    },
  });
}

function appendPrototypeChainRepair(mod, rewrites) {
  // Build:
  //   queueMicrotask(function () {
  //     if (typeof __cycdep_X !== 'undefined' && __cycdep_X.Imported) {
  //       try { Object.setPrototypeOf(Local, __cycdep_X.Imported); } catch(_){ }
  //       try { Object.setPrototypeOf(Local.prototype, __cycdep_X.Imported.prototype); } catch(_){ }
  //     }
  //   });
  // We must reference the leaf class by its export name. cc-reverse stores
  // exported names as a Set on `mod.exports`. The leaf class is whichever
  // export is a class — heuristic: pick the only top-level _export("X", ...)
  // that takes a class-shaped expression, OR fall back to the module name.
  if (!mod.ast || !mod.ast.program) return;

  const targetName = guessLeafExportName(mod);
  if (!targetName) return;

  const stmts = [];
  for (const rw of rewrites) {
    const memberAccess = t.memberExpression(t.identifier(rw.ns), t.identifier(rw.super));
    const protoAccess = t.memberExpression(memberAccess, t.identifier('prototype'));
    const leafIdent = t.identifier(targetName);
    const leafProto = t.memberExpression(t.identifier(targetName), t.identifier('prototype'));
    const setProto = t.tryStatement(
      t.blockStatement([
        t.expressionStatement(
          t.callExpression(
            t.memberExpression(t.identifier('Object'), t.identifier('setPrototypeOf')),
            [leafIdent, t.cloneNode(memberAccess)]
          )
        ),
        t.expressionStatement(
          t.callExpression(
            t.memberExpression(t.identifier('Object'), t.identifier('setPrototypeOf')),
            [leafProto, t.cloneNode(protoAccess)]
          )
        ),
      ]),
      t.catchClause(t.identifier('_e'), t.blockStatement([])),
      null
    );
    const guard = t.ifStatement(
      t.logicalExpression(
        '&&',
        t.binaryExpression('!==', t.unaryExpression('typeof', t.identifier(rw.ns)), t.stringLiteral('undefined')),
        t.cloneNode(memberAccess)
      ),
      t.blockStatement([setProto])
    );
    stmts.push(guard);
  }

  const microtaskCall = t.expressionStatement(
    t.callExpression(t.identifier('queueMicrotask'), [
      t.functionExpression(null, [], t.blockStatement(stmts)),
    ])
  );
  mod.ast.program.body.push(microtaskCall);
}

function guessLeafExportName(mod) {
  // Prefer module name if it appears in mod.exports; else return the first
  // exported symbol that we can locate.
  if (mod.exports && mod.exports.has && mod.exports.has(mod.name)) return mod.name;
  if (mod.exports && mod.exports.size) {
    for (const x of mod.exports) if (x && x !== 'default') return x;
  }
  // Fall back to scanning the AST for a top-level `_export("Name", ...)`
  // call, which is the SystemJS export form before esmRebuilder runs.
  if (!mod.ast || !mod.ast.program) return mod.name || null;
  const exportParam = mod.exportParam;
  for (const stmt of mod.ast.program.body) {
    if (!t.isExpressionStatement(stmt)) continue;
    const expr = stmt.expression;
    if (!t.isCallExpression(expr)) continue;
    if (!t.isIdentifier(expr.callee)) continue;
    if (exportParam && expr.callee.name !== exportParam) continue;
    if (!expr.arguments.length) continue;
    const arg0 = expr.arguments[0];
    if (t.isStringLiteral(arg0) && arg0.value !== 'default') return arg0.value;
  }
  return mod.name || null;
}

function makeUniqueIdent(mod, base) {
  const used = new Set();
  if (mod.ast && mod.ast.program) {
    for (const stmt of mod.ast.program.body) collectTopIdents(stmt, used);
  }
  for (const s of mod.setterBindings || []) {
    for (const b of s.bindings || []) if (b.local) used.add(b.local);
  }
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

function collectTopIdents(node, set) {
  if (!node) return;
  if (node.type === 'VariableDeclaration') {
    for (const d of node.declarations) {
      if (d.id && d.id.type === 'Identifier') set.add(d.id.name);
    }
  } else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
    if (node.id && node.id.name) set.add(node.id.name);
  }
}

module.exports = { deferCycleSuperClasses };

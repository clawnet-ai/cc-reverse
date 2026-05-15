'use strict';

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;

/**
 * Layer 2.5: detect SystemJS-style import cycles between recovered modules
 * and break one safe edge per SCC by converting it to a namespace import
 * with lazy member access.
 *
 * Why this exists
 * ---------------
 * The original SystemJS loader handles circular module graphs via live setter
 * bindings: each module is registered up-front, deps that are not yet executed
 * still own a binding object whose members get filled in later. ESM's static
 * binding model can't replicate that for *named* specifiers when the imported
 * symbol is consumed at module-init time (e.g. `inheritsLoose(child, parent)`
 * or `class Foo extends Parent`) — by the time the cycle reaches the late
 * member, the named import is still `undefined` and the call throws.
 *
 * Real-world example from slgq:
 *   ActionBase → TriggerActionMgr → SubActionGroup → ActionBase  (cycle)
 *                                                  ↘ GameOverAction → ActionBase
 *   GameOverAction.ts:34 calls `inheritsLoose(class, ActionBase)` while
 *   ActionBase's own top-level IIFE has not yet finished — `ActionBase` is
 *   undefined → "Cannot read properties of undefined (reading 'prototype')".
 *
 * Strategy
 * --------
 *  1. Build a basename-keyed module index across the input batch.
 *  2. Build an edge list importer→dep where the dep resolves to a known mod.
 *  3. Find SCCs (Tarjan).
 *  4. For each SCC of size ≥ 2, classify each binding on each intra-SCC edge:
 *       - `init` = referenced at top level (extends, helper-call args, etc.)
 *       - `runtime` = referenced only inside function/method bodies
 *     Pick the first edge whose every binding is `runtime` and rewrite it.
 *  5. Rewrite a chosen edge by converting its setter from named bindings to a
 *     single namespace binding, and replacing each `localId` reference in the
 *     importer's AST with `nsName.importedName`. The deferred member access
 *     resolves successfully once the cycle has settled.
 *  6. If no SCC edge qualifies, push a `cycleBreaker` error so the user sees
 *     where to fix the source manually instead of getting a runtime crash.
 *
 * Limitations (intentional, minimal version)
 * ------------------------------------------
 *  - Single basename collisions across bundles use last-writer-wins; the
 *    cycle is only broken when the candidate forms a real cycle, so the
 *    risk is bounded.
 *  - Only handles same-name `./X[.ext]` style deps in setterBindings.
 *  - One edge per SCC. If higher-arity SCCs require multiple breaks, this
 *    will report and bail.
 *  - Does not touch reexport/namespace bindings — only named imports.
 */
async function breakCycles(modules, _context) {
  const errors = [];
  if (!Array.isArray(modules) || modules.length === 0) {
    return { errors };
  }

  const byName = new Map();
  for (const m of modules) {
    if (!m || !m.name) continue;
    if (!byName.has(m.name)) byName.set(m.name, m);
  }

  const indexOf = new Map();
  modules.forEach((m, i) => indexOf.set(m, i));

  // adj[i] = list of { to, setter } edges sourced from module i.
  const adj = modules.map(() => []);
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];
    if (!m || !Array.isArray(m.setterBindings)) continue;
    for (const setter of m.setterBindings) {
      const base = depBasename(setter.dep);
      if (!base) continue;
      const cand = byName.get(base);
      if (!cand || cand === m) continue;
      const j = indexOf.get(cand);
      if (j === undefined) continue;
      adj[i].push({ to: j, setter });
    }
  }

  // Iterate: each pass breaks at most one runtime edge per SCC, then
  // re-runs Tarjan. SCCs that share a runtime edge collapse on the first
  // break; nested cycles inside a "super-SCC" need additional passes.
  // We bound passes by the number of edges to guarantee termination.
  const removedEdges = new Set();
  const maxPasses = adj.reduce((s, l) => s + l.length, 0) + 2;
  for (let pass = 0; pass < maxPasses; pass++) {
    const liveAdj = adj.map((list, from) =>
      list.filter((e) => !removedEdges.has(edgeKey(from, e.to, e.setter)))
    );
    const sccs = tarjan(liveAdj);
    if (process.env.CC_REVERSE_DEBUG_CYCLE && pass === 0) {
      for (const scc of sccs) {
        if (scc.length < 2) continue;
        console.error('[cycleBreaker SCC]', scc.map((i) => modules[i] && modules[i].name).join(' ↔ '));
      }
    }
    let changedThisPass = false;
    for (const scc of sccs) {
      if (scc.length < 2) continue;
      const inScc = new Set(scc);
      let broken = false;
      for (const i of scc) {
        if (broken) break;
        const m = modules[i];
        for (const e of liveAdj[i]) {
          if (!inScc.has(e.to)) continue;
          const setter = e.setter;
          const bindings = setter.bindings;
          if (!bindings || !bindings.length) continue;
          if (bindings.some((b) => b.reexport || b.namespace)) continue;
          const allRuntime = bindings.every((b) => {
            if (!b.local) return false;
            return classifyUsage(m.ast, b.local) === 'runtime';
          });
          if (!allRuntime) continue;
          rewriteEdgeToNamespace(m, setter);
          removedEdges.add(edgeKey(i, e.to, setter));
          broken = true;
          changedThisPass = true;
          break;
        }
      }
      if (!broken) {
        const names = scc.map((i) => modules[i] && modules[i].name).join(' ↔ ');
        // Only report the first time we see this exact SCC composition.
        const sig = `unbreakable import cycle: ${names}`;
        if (!errors.some((er) => er.message === sig)) {
          errors.push({ layer: 'cycleBreaker', message: `${sig} (no edge has only runtime bindings)` });
        }
      }
    }
    if (!changedThisPass) break;
  }

  return { errors };
}

function edgeKey(from, to, setter) {
  return `${from}->${to}@${setter.dep}`;
}

function depBasename(dep) {
  if (typeof dep !== 'string') return null;
  const m = dep.match(/(?:^|\/)([^/]+?)(\.[mc]?[jt]s)?$/);
  if (!m) return null;
  return m[1];
}

/**
 * Walk `bodyAst` looking for references to `localName`. Returns:
 *   - 'init'    if any reference appears at module top level (depth 0)
 *   - 'runtime' if all references are inside function/method bodies
 *   - 'unused'  if there are no references
 */
function classifyUsage(bodyAst, localName) {
  if (!bodyAst) return 'unused';
  let initTime = false;
  let runtime = false;
  try {
    traverse(bodyAst, {
      Identifier(p) {
        if (p.node.name !== localName) return;
        if (!p.isReferencedIdentifier()) return;
        // Skip references shadowed by an inner binding (var/param/function/
        // class declaration). These belong to local code, not the import.
        const binding = p.scope.getBinding(localName);
        if (binding) return;
        let cur = p.parentPath;
        let inFn = false;
        while (cur) {
          if (cur.isFunction() || cur.isObjectMethod() || cur.isClassMethod()) {
            inFn = true; break;
          }
          cur = cur.parentPath;
        }
        if (inFn) runtime = true;
        else initTime = true;
      },
    });
  } catch (_err) {
    // Best-effort; treat as init-time so we don't accidentally break.
    return 'init';
  }
  if (initTime) return 'init';
  if (runtime) return 'runtime';
  return 'unused';
}

function rewriteEdgeToNamespace(mod, setter) {
  const safe = (depBasename(setter.dep) || 'dep').replace(/[^A-Za-z0-9_]/g, '_');
  const nsName = makeUniqueIdent(mod, `__cycdep_${safe}`);

  const map = new Map();
  for (const b of setter.bindings) {
    if (b.namespace || b.reexport) continue;
    if (b.local) map.set(b.local, b.imported);
  }
  if (!map.size) return;

  rewriteRefs(mod.ast, map, nsName);
  setter.bindings = [{ local: nsName, namespace: true }];
}

function makeUniqueIdent(mod, base) {
  const used = new Set();
  if (mod.ast && mod.ast.program) {
    for (const stmt of mod.ast.program.body) collectTopIdents(stmt, used);
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

function rewriteRefs(ast, localToImported, nsName) {
  if (!ast) return;
  try {
    traverse(ast, {
      Identifier(p) {
        if (!localToImported.has(p.node.name)) return;
        if (!p.isReferencedIdentifier()) return;
        // Skip refs shadowed by an inner declaration — only rewrite truly
        // free references that bind to the SystemJS setter local.
        if (p.scope.getBinding(p.node.name)) return;
        const imported = localToImported.get(p.node.name);
        p.replaceWith(
          t.memberExpression(t.identifier(nsName), t.identifier(imported))
        );
        p.skip();
      },
    });
  } catch (_err) {
    // swallow — keeping original AST is safer than crashing the layer
  }
}

function tarjan(adj) {
  const n = adj.length;
  let index = 0;
  const stack = [];
  const onStack = new Array(n).fill(false);
  const indices = new Array(n).fill(-1);
  const lowlink = new Array(n).fill(0);
  const sccs = [];

  function strongconnect(start) {
    // iterative to avoid recursion limits on big graphs
    const work = [{ v: start, i: 0 }];
    indices[start] = index;
    lowlink[start] = index;
    index++;
    stack.push(start);
    onStack[start] = true;

    while (work.length) {
      const top = work[work.length - 1];
      const v = top.v;
      const edges = adj[v];
      if (top.i < edges.length) {
        const w = edges[top.i++].to;
        if (indices[w] === -1) {
          indices[w] = index;
          lowlink[w] = index;
          index++;
          stack.push(w);
          onStack[w] = true;
          work.push({ v: w, i: 0 });
        } else if (onStack[w]) {
          lowlink[v] = Math.min(lowlink[v], indices[w]);
        }
      } else {
        if (lowlink[v] === indices[v]) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack[w] = false;
            comp.push(w);
          } while (w !== v);
          sccs.push(comp);
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].v;
          lowlink[parent] = Math.min(lowlink[parent], lowlink[v]);
        }
      }
    }
  }

  for (let v = 0; v < n; v++) {
    if (indices[v] === -1) strongconnect(v);
  }
  return sccs;
}

module.exports = { breakCycles };

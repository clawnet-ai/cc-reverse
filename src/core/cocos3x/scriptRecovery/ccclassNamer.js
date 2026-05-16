'use strict';

const t = require('@babel/types');
const traverseMod = require('@babel/traverse');
const traverse = traverseMod.default || traverseMod;

/**
 * Layer 4: extract ccclass name + UUID from cclegacy._RF.push/_RF.push calls
 * and from @ccclass decorator. Strip the _RF push/pop scaffolding.
 */
async function applyCcclassNames(modules, _context) {
  for (const mod of modules) {
    mod.ccclassName = null;
    mod.uuid = null;
    mod.uuidMap = {};
    if (!mod.ast) continue;

    const meta = extractRfPush(mod.ast);
    let ccclassName = meta.className;
    const uuid = meta.uuid;

    if (!ccclassName) ccclassName = extractCcclassDecoratorName(mod.ast);

    if (ccclassName) renameClassId(mod.ast, ccclassName);

    mod.ccclassName = ccclassName || null;
    mod.uuid = uuid || null;
    if (uuid && ccclassName) {
      mod.uuidMap = { [uuid]: { className: ccclassName, moduleName: mod.name } };
    }

    // Inner anonymous ccclasses: when the original chunk emitted
    // `_export("Name", (..., ccclass(IIFE), ...))` for a nested class, the
    // recovered file ends up with `var local = (..., ccclass(IIFE), ...)` plus
    // `export { local as Name }` (or `export let Name = ...`), and the
    // `ccclass()` call has no name argument. Cocos then warns
    // "Can not serialize 'Outer.field' because the specified type is anonymous".
    // We inject the exported name as the ccclass argument.
    nameInnerCcclasses(mod.ast, ccclassName);
  }
  return modules;
}

function extractRfPush(ast) {
  const out = { uuid: null, className: null };
  const toRemove = [];
  traverse(ast, {
    ExpressionStatement(p) {
      const expr = p.node.expression;
      if (!t.isCallExpression(expr)) return;
      const isPush = isRfMember(expr.callee, 'push');
      const isPop = isRfMember(expr.callee, 'pop');
      if (!isPush && !isPop) return;
      if (isPush && expr.arguments.length >= 3) {
        const uuidArg = expr.arguments[1];
        const nameArg = expr.arguments[2];
        if (t.isStringLiteral(uuidArg)) out.uuid = uuidArg.value;
        if (t.isStringLiteral(nameArg)) out.className = nameArg.value;
      }
      toRemove.push(p);
    },
  });
  for (const p of toRemove) p.remove();
  return out;
}

function isRfMember(node, which) {
  if (!t.isMemberExpression(node)) return false;
  if (!t.isIdentifier(node.property, { name: which })) return false;
  const obj = node.object;
  if (t.isIdentifier(obj, { name: '_RF' })) return true;
  if (
    t.isMemberExpression(obj) &&
    t.isIdentifier(obj.property, { name: '_RF' })
  ) return true;
  return false;
}

function extractCcclassDecoratorName(ast) {
  let name = null;
  traverse(ast, {
    ClassDeclaration(p) {
      if (name) return;
      const decorators = p.node.decorators || [];
      for (const dec of decorators) {
        const expr = dec.expression;
        if (!t.isCallExpression(expr)) continue;
        if (!t.isIdentifier(expr.callee, { name: 'ccclass' })) continue;
        const arg = expr.arguments[0];
        if (t.isStringLiteral(arg)) { name = arg.value; return; }
        if (t.isObjectExpression(arg)) {
          const nameProp = arg.properties.find(
            (pr) => t.isObjectProperty(pr) && t.isIdentifier(pr.key, { name: 'name' }) && t.isStringLiteral(pr.value)
          );
          if (nameProp) { name = nameProp.value.value; return; }
        }
      }
    },
  });
  return name;
}

/**
 * Detect the "dual class+instance export" SystemJS pattern:
 *   class <classLocal> extends X {}
 *   export { <classLocal> as _<newName> };
 *   export let <newName> = new <classLocal>(...);
 *
 * If matched, rename the class to `_<newName>` (its own export alias) instead
 * of `<newName>`, so the singleton keeps the bare public name. Returns the
 * effective rename target (`_<newName>` if dual-export, else `newName`).
 *
 * Original SystemJS shape:
 *   var d = _export("_X", IIFE_class); _export("X", new d);
 * The class is the alias-named export (`_X`), the singleton is the bare name (`X`).
 */
function detectDualExportRenameTarget(ast, newName) {
  if (!ast || !ast.program) return newName;
  const aliasName = '_' + newName;
  const body = ast.program.body;

  // Find an `export let <newName> = new <localClass>(...)` and remember localClass.
  let singletonClassLocal = null;
  for (const stmt of body) {
    if (!t.isExportNamedDeclaration(stmt)) continue;
    const decl = stmt.declaration;
    if (!t.isVariableDeclaration(decl)) continue;
    for (const d of decl.declarations) {
      if (!t.isIdentifier(d.id, { name: newName })) continue;
      if (!d.init || !t.isNewExpression(d.init)) continue;
      if (!t.isIdentifier(d.init.callee)) continue;
      singletonClassLocal = d.init.callee.name;
      break;
    }
    if (singletonClassLocal) break;
  }
  if (!singletonClassLocal) return newName;

  // Find an `export { <singletonClassLocal> as _<newName> }` re-export.
  let aliasReexportFound = false;
  for (const stmt of body) {
    if (!t.isExportNamedDeclaration(stmt)) continue;
    if (stmt.declaration) continue;
    for (const spec of stmt.specifiers || []) {
      if (!t.isExportSpecifier(spec)) continue;
      if (!t.isIdentifier(spec.local, { name: singletonClassLocal })) continue;
      if (!t.isIdentifier(spec.exported, { name: aliasName })) continue;
      aliasReexportFound = true;
      break;
    }
    if (aliasReexportFound) break;
  }
  if (!aliasReexportFound) return newName;

  // Confirm <singletonClassLocal> is a class at top level.
  let isClass = false;
  for (const stmt of body) {
    if (t.isClassDeclaration(stmt) && stmt.id && stmt.id.name === singletonClassLocal) {
      isClass = true; break;
    }
  }
  if (!isClass) return newName;

  // Drop the now-redundant `export { local as _newName }` — after we rename the
  // class to `_newName`, the class declaration itself will export it by name.
  for (let i = body.length - 1; i >= 0; i--) {
    const stmt = body[i];
    if (!t.isExportNamedDeclaration(stmt) || stmt.declaration) continue;
    stmt.specifiers = (stmt.specifiers || []).filter((spec) => {
      if (!t.isExportSpecifier(spec)) return true;
      return !(
        t.isIdentifier(spec.local, { name: singletonClassLocal }) &&
        t.isIdentifier(spec.exported, { name: aliasName })
      );
    });
    if (!stmt.specifiers.length && !stmt.source) body.splice(i, 1);
  }

  // Promote the class declaration to `export class _newName ...` so the alias
  // remains exported after we redirect the rename target.
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];
    if (t.isClassDeclaration(stmt) && stmt.id && stmt.id.name === singletonClassLocal) {
      body[i] = t.exportNamedDeclaration(stmt, []);
      break;
    }
  }

  return aliasName;
}

function renameClassId(ast, newName) {
  newName = detectDualExportRenameTarget(ast, newName);
  // First pass: if some other top-level binding already owns `newName`
  // (typical case: webcrack restored a sibling `export let GameKeyMgr = {
  // EventType: u, ...}` namespace alongside `var u = (IIFE)`), rename the
  // colliding binding to a deconflicted local name and rewrite its export
  // so the public name `newName` remains exported by the class. Otherwise
  // the engine fails parse with 'Identifier already declared'.
  traverse(ast, {
    Program(programPath) {
      const programScope = programPath.scope;
      const existing = programScope.getOwnBinding(newName);
      if (!existing) return;

      let candidate = newName + 'Ns';
      let n = 2;
      while (programScope.hasBinding(candidate)) {
        candidate = newName + 'Ns' + n++;
      }

      // Locate the offending declaration before renaming, so we can
      // convert `export let X = {...}` into `let X = {...}` (dropping the
      // export) — the class declaration will provide the public X.
      const bindingPath = existing.path;
      const declStmtPath = bindingPath && bindingPath.parentPath;
      const exportWrapper = declStmtPath && declStmtPath.parentPath;
      const wrapsExport = exportWrapper && exportWrapper.isExportNamedDeclaration();

      try {
        programScope.rename(newName, candidate);
      } catch (_e) {
        return;
      }

      // After rename, the binding's identifier is `candidate`. If it was
      // wrapped in `export let ...`, unwrap so we don't double-export
      // `newName` (the class wins as the public binding).
      if (wrapsExport && exportWrapper.node && exportWrapper.node.declaration) {
        const inner = exportWrapper.node.declaration;
        try { exportWrapper.replaceWith(inner); } catch (_e) { /* best-effort */ }
      }
    },
  });

  traverse(ast, {
    ClassDeclaration(p) {
      if (!p.node.id || p.node.id.name === newName) return;
      const oldName = p.node.id.name;
      try {
        p.scope.rename(oldName, newName);
      } catch (_e) {
        // ignore — fallback below sets the id directly
      }
      if (p.node.id && p.node.id.name === oldName) p.node.id.name = newName;
      p.stop();
    },
  });
}

module.exports = { applyCcclassNames };

/**
 * Inject the exported name as the first argument of `ccclass()` calls that
 * were emitted with no name. The original chunk used SystemJS
 * `_export("Name", expr)` to label inner classes; after esmRebuilder this
 * becomes either `var local = expr; export { local as Name }` or
 * `export let Name = expr`, but the inner `ccclass(IIFE)` call itself stays
 * argument-less. Cocos serialization then treats the class as anonymous.
 *
 * Skips the top-level ccclass (already named via @ccclass("Foo") or _RF.push).
 */
function collectCcclassAliases(ast) {
  const aliases = new Set(['ccclass']);
  traverse(ast, {
    VariableDeclarator(p) {
      const init = p.node.init;
      if (!init) return;
      if (
        t.isMemberExpression(init) &&
        t.isIdentifier(init.property, { name: 'ccclass' }) &&
        t.isIdentifier(p.node.id)
      ) {
        aliases.add(p.node.id.name);
      }
    },
  });
  return aliases;
}

function nameInnerCcclasses(ast, topName) {
  if (!ast || !ast.program) return;
  const body = ast.program.body;
  const localToExported = new Map(); // local var name → public export name
  const localToInit = new Map();      // local var name → init expression node
  const ccclassAliases = collectCcclassAliases(ast);

  for (const stmt of body) {
    if (t.isVariableDeclaration(stmt)) {
      for (const d of stmt.declarations) {
        if (t.isIdentifier(d.id) && d.init) {
          localToInit.set(d.id.name, d.init);
        }
      }
    }
    if (t.isExportNamedDeclaration(stmt)) {
      // `export { local as Name }` (no declaration, has specifiers)
      if (!stmt.declaration && stmt.specifiers) {
        for (const spec of stmt.specifiers) {
          if (
            t.isExportSpecifier(spec) &&
            t.isIdentifier(spec.local) &&
            t.isIdentifier(spec.exported)
          ) {
            localToExported.set(spec.local.name, spec.exported.name);
          }
        }
      }
      // `export let Name = expr` — Name is both local and exported.
      if (t.isVariableDeclaration(stmt.declaration)) {
        for (const d of stmt.declaration.declarations) {
          if (t.isIdentifier(d.id) && d.init) {
            localToInit.set(d.id.name, d.init);
            localToExported.set(d.id.name, d.id.name);
          }
        }
      }
    }
  }

  for (const [local, exportedName] of localToExported) {
    if (exportedName === 'default') continue;
    if (topName && exportedName === topName) continue;
    const init = localToInit.get(local);
    if (!init) continue;
    injectCcclassName(init, exportedName, ccclassAliases);
  }
}

// Walk `expr` and inject `name` into the first bare `ccclass(IIFE)` call we
// find. Bare = first argument is not already a StringLiteral. We stop after
// the first injection because each export label maps to one inner class.
function injectCcclassName(node, name, aliases) {
  let injected = false;
  function isCcclassCallee(callee) {
    if (t.isIdentifier(callee) && aliases.has(callee.name)) return true;
    if (
      t.isMemberExpression(callee) &&
      t.isIdentifier(callee.property, { name: 'ccclass' })
    ) return true;
    return false;
  }
  function visit(n) {
    if (injected || !n || typeof n !== 'object') return;
    if (
      n.type === 'CallExpression' &&
      isCcclassCallee(n.callee) &&
      (n.arguments.length === 0 || !t.isStringLiteral(n.arguments[0]))
    ) {
      n.arguments.unshift(t.stringLiteral(name));
      injected = true;
      return;
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) visit(c);
      else if (v && typeof v === 'object' && v.type) visit(v);
    }
  }
  visit(node);
}

import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import babelGen from '@babel/generator';
import { applyCcclassNames } from '../../src/core/cocos3x/scriptRecovery/ccclassNamer.js';

const generate = babelGen.default || babelGen;

function makeModule(src, opts = {}) {
  return {
    name: opts.name || 'Player',
    ast: parse(src, { sourceType: 'module', plugins: ['decorators-legacy', 'classProperties'] }),
    deps: opts.deps || [],
    setterBindings: [],
    source: src,
  };
}

describe('Layer 4: ccclassNamer', () => {
  it('extracts uuid+name from cclegacy._RF.push and removes the call', async () => {
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass } = _decorator;
      cclegacy._RF.push({}, "abcd1234-uuid", "Player", undefined);
      @ccclass('Player')
      class Player extends Component {}
      cclegacy._RF.pop();
    `;
    const mod = makeModule(src);
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('Player');
    expect(out[0].uuid).toBe('abcd1234-uuid');
    expect(out[0].uuidMap).toEqual({ 'abcd1234-uuid': { className: 'Player', moduleName: 'Player' } });
    const code = generate(out[0].ast).code;
    expect(code).not.toMatch(/_RF\.(push|pop)/);
    expect(code).toMatch(/class\s+Player/);
  });

  it('renames a minified class id to the ccclassName from decorator', async () => {
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass } = _decorator;
      cclegacy._RF.push({}, "ffff-uuid", "Enemy", undefined);
      @ccclass('Enemy')
      class t extends Component {}
      cclegacy._RF.pop();
    `;
    const mod = makeModule(src, { name: 't' });
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('Enemy');
    const code = generate(out[0].ast).code;
    expect(code).toMatch(/class\s+Enemy\s+extends/);
  });

  it('falls back to ccclass decorator when _RF.push is absent', async () => {
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass } = _decorator;
      @ccclass('Foo')
      class Foo extends Component {}
    `;
    const mod = makeModule(src, { name: 'Foo' });
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('Foo');
    expect(out[0].uuid).toBeNull();
  });

  it('handles decorator argument as object { name }', async () => {
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass } = _decorator;
      @ccclass({ name: 'Bar' })
      class Bar extends Component {}
    `;
    const mod = makeModule(src, { name: 'Bar' });
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('Bar');
  });

  it('renames class self-references along with the declaration', async () => {
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass } = _decorator;
      cclegacy._RF.push({}, "self-uuid", "Player", undefined);
      @ccclass('Player')
      class t extends Component {
        static spawn() { return t.create(); }
        static create() { return new t(); }
      }
      cclegacy._RF.pop();
    `;
    const mod = makeModule(src, { name: 't' });
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('Player');
    const code = generate(out[0].ast).code;
    expect(code).toMatch(/class\s+Player\s+extends/);
    expect(code).toMatch(/Player\.create\(\)/);
    expect(code).toMatch(/new\s+Player\(\)/);
    expect(code).not.toMatch(/\bt\.create\b/);
    expect(code).not.toMatch(/\bnew\s+t\b/);
  });

  it('handles bare _RF.push (no cclegacy. prefix)', async () => {
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass } = _decorator;
      _RF.push({}, "bare-uuid", "Bare", undefined);
      @ccclass('Bare')
      class Bare extends Component {}
      _RF.pop();
    `;
    const mod = makeModule(src, { name: 'Bare' });
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('Bare');
    expect(out[0].uuid).toBe('bare-uuid');
    expect(out[0].uuidMap).toEqual({ 'bare-uuid': { className: 'Bare', moduleName: 'Bare' } });
    const code = generate(out[0].ast).code;
    expect(code).not.toMatch(/_RF\.(push|pop)/);
  });

  it('renames colliding namespace export so the class can claim the public name', async () => {
    // Mimics post-classRestorer state for files like GameKeyMgr.ts:
    //   - `class u extends Event` (class-restorer left it as `u`)
    //   - sibling `export let GameKeyMgr = { EventType: u, ... }` namespace
    // _RF.push announces the class should be named `GameKeyMgr`. Without
    // collision-handling, both `class GameKeyMgr` and `let GameKeyMgr` end
    // up at top level and the engine refuses to parse the module.
    const src = `
      import { Event } from 'cc';
      cclegacy._RF.push({}, "uuid-aaaa", "GameKeyMgr", undefined);
      class u extends Event { constructor(e) { super(e); } }
      export { u as EventType };
      export let GameKeyMgr = { EventType: u, allKey: [] };
    `;
    const mod = makeModule(src);
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('GameKeyMgr');
    const code = generate(out[0].ast).code;
    expect(code).toMatch(/class\s+GameKeyMgr\s+extends\s+Event/);
    // The namespace object must lose its public name (renamed locally) and
    // its export wrapper must be dropped — the class is the public one.
    expect(code).not.toMatch(/export\s+let\s+GameKeyMgr\b/);
    expect(code).toMatch(/let\s+GameKeyMgrNs\b/);
    // Internal references to the original `u` should be redirected to the
    // class — `EventType: u` becomes `EventType: GameKeyMgr` inside the
    // namespace object literal.
    expect(code).toMatch(/EventType:\s*GameKeyMgr/);
  });

  it('dual class+instance export: class is renamed to its own export alias, not the singleton name', async () => {
    // Mimics post-classRestorer state for files like STGameEnemySystem.ts where
    // the original SystemJS pattern was:
    //   var d = _export("_STGameEnemySystem", IIFE);
    //   _export("STGameEnemySystem", new d);
    // After esmRebuilder + classRestorer we get:
    //   class d extends c {}
    //   export { d as _STGameEnemySystem };
    //   export let STGameEnemySystem = new d;
    // _RF.push announces ccclass name `STGameEnemySystem` — the singleton.
    // If renameClassId blindly renames `d` → `STGameEnemySystem`, both the
    // class and the `export let STGameEnemySystem = new ...` collide and
    // Cocos rejects the module with `Identifier already declared`.
    // Correct behaviour: rename the class to its own export alias `_STGameEnemySystem`
    // so the singleton keeps the bare public name.
    const src = `
      import { Component } from 'cc';
      cclegacy._RF.push({}, "uuid-stge", "STGameEnemySystem", undefined);
      class d extends Component { init() { return 1; } }
      export { d as _STGameEnemySystem };
      export let STGameEnemySystem = new d();
    `;
    const mod = makeModule(src, { name: 'STGameEnemySystem' });
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('STGameEnemySystem');
    const code = generate(out[0].ast).code;
    // Class takes the alias name (matches SystemJS's `_export("_X", ...)` choice).
    expect(code).toMatch(/class\s+_STGameEnemySystem\s+extends\s+Component/);
    // Singleton keeps the bare public name.
    expect(code).toMatch(/export\s+let\s+STGameEnemySystem\s*=\s*new\s+_STGameEnemySystem\(\)/);
    // The named-export re-export becomes redundant — the class is exported by name.
    // Either `export { _STGameEnemySystem }` directly or via `export class` is fine,
    // but there must be no `export { _ as _STGameEnemySystem }` self-alias.
    expect(code).not.toMatch(/export\s+\{\s*_STGameEnemySystem\s+as\s+_STGameEnemySystem\s*\}/);
    // No double-declaration.
    const matches = code.match(/\bSTGameEnemySystem\b/g) || [];
    // Should appear: in singleton declaration LHS and (possibly) inside _RF/uuid map removal residue (none).
    // We just assert there's no `class STGameEnemySystem` in the output.
    expect(code).not.toMatch(/class\s+STGameEnemySystem\b/);
  });

  it('injects exported name into bare aliased ccclass(IIFE) call for inner classes', async () => {
    // Mimics CombinationLock.ts: outer ccclass is named via _RF.push("CombinationLock"),
    // but inner anonymous ccclass `j` (alias Q for ccclass) needs naming from
    // the `export { j as PasswordNode }` label, else Cocos warns "anonymous".
    const src = `
      import { _decorator } from 'cc';
      var s = _decorator;
      var Q = s.ccclass;
      var U = s.property;
      cclegacy._RF.push({}, "uuid-combo", "CombinationLock", undefined);
      var j = Q((function PasswordNodeCtor() { return function () {}; })());
      export { j as PasswordNode };
      @ccclass('CombinationLock')
      class CombinationLock {}
      cclegacy._RF.pop();
    `;
    const mod = makeModule(src, { name: 'CombinationLock' });
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('CombinationLock');
    const code = generate(out[0].ast).code;
    expect(code).toMatch(/Q\(\s*"PasswordNode"/);
  });

  it('injects name into export let Name = ccclass(IIFE) form', async () => {
    const src = `
      import { _decorator } from 'cc';
      var s = _decorator;
      var Q = s.ccclass;
      export let MyInner = Q((function () { return function () {}; })());
    `;
    const mod = makeModule(src, { name: 'mod' });
    const out = await applyCcclassNames([mod]);
    const code = generate(out[0].ast).code;
    expect(code).toMatch(/Q\(\s*"MyInner"/);
  });

  it('does not re-name the top-level ccclass via inner-class pass', async () => {
    // top-level `Foo` is named via _RF.push; if it's also `export { x as Foo }`,
    // the inner pass must skip it (topName === exportedName).
    const src = `
      import { _decorator } from 'cc';
      var Q = _decorator.ccclass;
      cclegacy._RF.push({}, "u", "Foo", undefined);
      var x = Q(function(){});
      export { x as Foo };
    `;
    const mod = makeModule(src, { name: 'Foo' });
    const out = await applyCcclassNames([mod]);
    const code = generate(out[0].ast).code;
    expect(code).not.toMatch(/Q\(\s*"Foo"/);
  });

  it('passthrough: module without class is unchanged and has null fields', async () => {
    const mod = { name: 'plain', ast: parse('var x = 1;', { sourceType: 'module' }), deps: [], setterBindings: [], source: 'var x = 1;' };
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBeNull();
    expect(out[0].uuid).toBeNull();
  });
});

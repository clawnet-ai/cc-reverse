import { describe, it, expect } from 'vitest';
import babelParser from '@babel/parser';
import babelGenerator from '@babel/generator';
import { breakCycles } from '../../src/core/cocos3x/scriptRecovery/cycleBreaker.js';

const parse = (src) =>
  (babelParser.parse || babelParser)(src, { sourceType: 'module' });
const generate = (ast) => (babelGenerator.default || babelGenerator)(ast).code;

function mkMod(name, src, deps, setterBindings) {
  return {
    name,
    deps,
    setterBindings,
    ast: parse(src),
  };
}

describe('Layer 1.5: cycleBreaker', () => {
  it('breaks a 2-node cycle on the runtime-only edge', async () => {
    // A → B (runtime-only use of `B`)  and  B → A (uses A as `extends`/init)
    // Expect: A's import-from-B becomes a namespace, refs become ns.B.
    const aSrc = `
      function helper() { return B.create(); }
    `;
    const bSrc = `
      class C extends A { method() { return 1; } }
    `;
    const a = mkMod('A', aSrc, ['./B'], [
      { dep: './B', bindings: [{ local: 'B', imported: 'B' }] },
    ]);
    const b = mkMod('B', bSrc, ['./A'], [
      { dep: './A', bindings: [{ local: 'A', imported: 'A' }] },
    ]);

    const r = await breakCycles([a, b], {});
    expect(r.errors).toEqual([]);
    // A's setter for ./B should have been switched to namespace
    expect(a.setterBindings[0].bindings[0].namespace).toBe(true);
    const aCode = generate(a.ast);
    expect(aCode).toMatch(/__cycdep_B\.B\.create\(\)/);
    // B's setter for ./A is unchanged (init-time reference there)
    expect(b.setterBindings[0].bindings[0].namespace).toBeUndefined();
  });

  it('reports when no edge has only runtime bindings', async () => {
    // A → B (init-time: extends)  and  B → A (init-time: extends)
    const aSrc = `class C extends B {}`;
    const bSrc = `class D extends A {}`;
    const a = mkMod('A', aSrc, ['./B'], [
      { dep: './B', bindings: [{ local: 'B', imported: 'B' }] },
    ]);
    const b = mkMod('B', bSrc, ['./A'], [
      { dep: './A', bindings: [{ local: 'A', imported: 'A' }] },
    ]);

    const r = await breakCycles([a, b], {});
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].layer).toBe('cycleBreaker');
    expect(r.errors[0].message).toMatch(/unbreakable import cycle/);
  });

  it('leaves acyclic graphs untouched', async () => {
    const aSrc = `class C extends B {}`;
    const a = mkMod('A', aSrc, ['./B'], [
      { dep: './B', bindings: [{ local: 'B', imported: 'B' }] },
    ]);
    const b = mkMod('B', `export const x = 1;`, [], []);
    const before = JSON.stringify(a.setterBindings);
    const r = await breakCycles([a, b], {});
    expect(r.errors).toEqual([]);
    expect(JSON.stringify(a.setterBindings)).toBe(before);
  });

  it('breaks the realistic ActionBase ↔ TriggerActionMgr ↔ SubActionGroup cycle', async () => {
    // ActionBase only uses TriggerActionMgr inside a method (runtime).
    const actionBaseSrc = `
      class ActionBaseImpl {
        run() { return TriggerActionMgr.fire(); }
      }
    `;
    // TriggerActionMgr uses SubActionGroup as extends (init).
    const triggerSrc = `
      class TriggerImpl extends SubActionGroup {}
    `;
    // SubActionGroup uses ActionBase as extends (init) AND GameOverAction (init).
    const subSrc = `
      class SubImpl extends ActionBase {}
      const x = new GameOverAction();
    `;
    // GameOverAction uses ActionBase as extends (init).
    const gameOverSrc = `
      class GO extends ActionBase {}
    `;

    const actionBase = mkMod('ActionBase', actionBaseSrc, ['./TriggerActionMgr'], [
      { dep: './TriggerActionMgr', bindings: [{ local: 'TriggerActionMgr', imported: 'TriggerActionMgr' }] },
    ]);
    const trigger = mkMod('TriggerActionMgr', triggerSrc, ['./SubActionGroup'], [
      { dep: './SubActionGroup', bindings: [{ local: 'SubActionGroup', imported: 'SubActionGroup' }] },
    ]);
    const sub = mkMod('SubActionGroup', subSrc, ['./ActionBase', './GameOverAction'], [
      { dep: './ActionBase', bindings: [{ local: 'ActionBase', imported: 'ActionBase' }] },
      { dep: './GameOverAction', bindings: [{ local: 'GameOverAction', imported: 'GameOverAction' }] },
    ]);
    const gameOver = mkMod('GameOverAction', gameOverSrc, ['./ActionBase'], [
      { dep: './ActionBase', bindings: [{ local: 'ActionBase', imported: 'ActionBase' }] },
    ]);

    const r = await breakCycles([actionBase, trigger, sub, gameOver], {});
    expect(r.errors).toEqual([]);
    // The break should land on actionBase → trigger (the only runtime edge).
    expect(actionBase.setterBindings[0].bindings[0].namespace).toBe(true);
    const code = generate(actionBase.ast);
    expect(code).toMatch(/__cycdep_TriggerActionMgr\.TriggerActionMgr\.fire/);
  });

  it('does not rewrite identifiers shadowed by inner declarations (var/param/function)', async () => {
    // The original SystemJS setter `function(e){ a = e.MainCom }` exposes
    // `MainCom` via the local `a`. The execute() body usually has many
    // unrelated `var a`, parameter `a`, for-loop `a`, etc. cycleBreaker
    // must NOT rewrite those shadowed `a` refs into `__cycdep_MainCom.MainCom`.
    const aSrc = `
      var top = a.Inst;
      function shadow1() {
        for (var a = 1; a <= 3; a++) {
          console.log(a);
        }
      }
      function shadow2(a) { return a + 1; }
      function freeUse() { return a.fire(); }
    `;
    const bSrc = `class C extends A {}`;
    const a = mkMod('A', aSrc, ['./B'], [
      { dep: './B', bindings: [{ local: 'a', imported: 'MainCom' }] },
    ]);
    const b = mkMod('B', bSrc, ['./A'], [
      { dep: './A', bindings: [{ local: 'A', imported: 'A' }] },
    ]);

    const r = await breakCycles([a, b], {});
    // The init-time `var top = a.Inst` makes the binding init-time, so the
    // edge A→B is not breakable. cycleBreaker should report it but must not
    // touch any of the shadowed `a` identifiers.
    const code = generate(a.ast);
    expect(code).toMatch(/for\s*\(var a = 1; a <= 3; a\+\+\)/);
    expect(code).toMatch(/function shadow2\(a\)\s*\{\s*return a \+ 1;/);
    // Free `a.Inst` and `a.fire()` are not rewritten because the edge was
    // not chosen for breaking (init-time `var top = a.Inst` exists).
    expect(code).toMatch(/var top = a\.Inst;/);
    expect(code).toMatch(/return a\.fire\(\);/);
  });

  it('rewrites only free references when edge is breakable, leaving shadowed names intact', async () => {
    // Pure-runtime edge with shadowing: only `a.fire()` and `a.run()` (free
    // refs in nested fns) should rewrite; the shadowed `a` inside `shadow1`
    // and `shadow2` must stay bare.
    const aSrc = `
      function shadow1() {
        for (var a = 1; a <= 3; a++) { console.log(a); }
      }
      function shadow2(a) { return a + 1; }
      function freeUse1() { return a.fire(); }
      function freeUse2() { return a.run(); }
    `;
    const bSrc = `class C extends A {}`;
    const a = mkMod('A', aSrc, ['./B'], [
      { dep: './B', bindings: [{ local: 'a', imported: 'MainCom' }] },
    ]);
    const b = mkMod('B', bSrc, ['./A'], [
      { dep: './A', bindings: [{ local: 'A', imported: 'A' }] },
    ]);

    const r = await breakCycles([a, b], {});
    expect(r.errors).toEqual([]);
    const code = generate(a.ast);
    expect(code).toMatch(/for\s*\(var a = 1; a <= 3; a\+\+\)/);
    expect(code).toMatch(/function shadow2\(a\)\s*\{\s*return a \+ 1;/);
    expect(code).toMatch(/__cycdep_B\.MainCom\.fire\(\)/);
    expect(code).toMatch(/__cycdep_B\.MainCom\.run\(\)/);
  });

  it('does not touch namespace or reexport bindings', async () => {
    const a = mkMod('A', `B.x();`, ['./B'], [
      { dep: './B', bindings: [{ local: 'B', namespace: true }] },
    ]);
    const b = mkMod('B', `class C extends A {}`, ['./A'], [
      { dep: './A', bindings: [{ local: 'A', imported: 'A' }] },
    ]);
    const before = JSON.stringify(a.setterBindings);
    const r = await breakCycles([a, b], {});
    // No breakable edge — runtime-only edge has namespace bindings (skipped).
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(a.setterBindings)).toBe(before);
  });
});

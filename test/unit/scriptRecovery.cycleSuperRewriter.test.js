import { describe, it, expect } from 'vitest';
import babelParser from '@babel/parser';
import babelGenerator from '@babel/generator';
import { breakCycles } from '../../src/core/cocos3x/scriptRecovery/cycleBreaker.js';
import { deferCycleSuperClasses } from '../../src/core/cocos3x/scriptRecovery/cycleSuperRewriter.js';

const parse = (src) =>
  (babelParser.parse || babelParser)(src, { sourceType: 'module' });
const generate = (ast) => (babelGenerator.default || babelGenerator)(ast).code;

function mkMod(name, src, deps, setterBindings, exports = []) {
  return {
    name,
    deps,
    setterBindings,
    exports: new Set(exports),
    exportParam: '_e',
    ast: parse(src),
  };
}

describe('Layer 1.6: cycleSuperRewriter', () => {
  it('defers super class for a leaf-like extends inside a cycle SCC', async () => {
    // GO module: top-level IIFE pattern from Babel — `(function(t){ i(e,t); ... return e; }(s))`
    // where s = ActionBase setter local. ActionBase ↔ TM ↔ SG ↔ GO; only init-time edges remain
    // for this leaf so cycleBreaker leaves the leaf untouched.
    const goSrc = `
      var v;
      var h;
      _e("GameOverAction", v = function (t) {
        function e() {
          return t.call.apply(t, [this].concat([])) || this;
        }
        i(e, t);
        e.prototype.onTrigger = function () {
          t.prototype.onTrigger.call(this);
        };
        return e;
      }(s));
      h = v;
    `;
    const abSrc = `class AB {}`;
    const tmSrc = `class TM extends AB {}`;
    const sgSrc = `class SG extends GO {}`;

    const go = mkMod('GameOverAction', goSrc, ['./ActionBase'], [
      { dep: './ActionBase', bindings: [{ local: 's', imported: 'ActionBase' }] },
    ], ['GameOverAction']);
    const ab = mkMod('ActionBase', abSrc, ['./TriggerActionMgr'], [
      { dep: './TriggerActionMgr', bindings: [{ local: 'TM', imported: 'TriggerActionMgr' }] },
    ]);
    const tm = mkMod('TriggerActionMgr', tmSrc, ['./SubActionGroup'], [
      { dep: './SubActionGroup', bindings: [{ local: 'SG', imported: 'SubActionGroup' }] },
    ]);
    const sg = mkMod('SubActionGroup', sgSrc, ['./GameOverAction', './ActionBase'], [
      { dep: './GameOverAction', bindings: [{ local: 'GO', imported: 'GameOverAction' }] },
      { dep: './ActionBase', bindings: [{ local: 'AB', imported: 'ActionBase' }] },
    ]);

    const r = await breakCycles([go, ab, tm, sg], {});
    expect(Array.isArray(r.sccs)).toBe(true);
    const r2 = await deferCycleSuperClasses([go, ab, tm, sg], r.sccs, {});
    expect(r2.errors).toEqual([]);
    // GO was rewritten: namespace import added, IIFE arg uses `|| class{}`,
    // body refs to `t` rewritten to `__cycdep_ActionBase.ActionBase`.
    const goCode = generate(go.ast);
    expect(goCode).toMatch(/__cycdep_ActionBase\.ActionBase \|\| class \{\}/);
    expect(goCode).toMatch(/i\(e, __cycdep_ActionBase\.ActionBase\)/);
    expect(goCode).toMatch(/__cycdep_ActionBase\.ActionBase\.prototype\.onTrigger\.call\(this\)/);
    expect(goCode).toMatch(/queueMicrotask/);
    expect(goCode).toMatch(/Object\.setPrototypeOf\(GameOverAction, __cycdep_ActionBase\.ActionBase\)/);
    expect(goCode).toMatch(/Object\.setPrototypeOf\(GameOverAction\.prototype, __cycdep_ActionBase\.ActionBase\.prototype\)/);
    // The original named setter is preserved (we add a sibling namespace setter).
    expect(go.setterBindings.find((s) => s.bindings.some((b) => b.namespace))).toBeDefined();
  });

  it('does nothing for modules outside any SCC', async () => {
    const aSrc = `var v = function(t){ i(e,t); return e; }(s);`;
    const a = mkMod('A', aSrc, ['./B'], [
      { dep: './B', bindings: [{ local: 's', imported: 'B' }] },
    ]);
    const before = generate(a.ast);
    const r2 = await deferCycleSuperClasses([a], [], {});
    expect(r2.errors).toEqual([]);
    expect(generate(a.ast)).toBe(before);
  });

  it('does not rewrite IIFE formal references in nested shadowing scopes', async () => {
    const aSrc = `
      _e("A", function (t) {
        function e() { return t.call.apply(t, [this]); }
        i(e, t);
        function inner(t) { return t + 1; }   // shadow
        return e;
      }(s));
    `;
    const bSrc = `class B extends A {}`;
    const a = mkMod('A', aSrc, ['./B'], [
      { dep: './B', bindings: [{ local: 's', imported: 'B' }] },
    ], ['A']);
    const b = mkMod('B', bSrc, ['./A'], [
      { dep: './A', bindings: [{ local: 'A', imported: 'A' }] },
    ], ['B']);

    const r = await breakCycles([a, b], {});
    const r2 = await deferCycleSuperClasses([a, b], r.sccs, {});
    expect(r2.errors).toEqual([]);
    const code = generate(a.ast);
    // Nested `function inner(t)` has its own `t` — must remain bare.
    expect(code).toMatch(/function inner\(t\)\s*\{\s*return t \+ 1;/);
    // Outer formal references are rewritten.
    expect(code).toMatch(/__cycdep_B\.B/);
  });
});

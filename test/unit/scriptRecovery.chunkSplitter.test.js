import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitChunks } from '../../src/core/cocos3x/scriptRecovery/chunkSplitter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fixture = readFileSync(
  path.join(__dirname, '../fixtures/scriptRecovery/system-register-2-modules.js'),
  'utf8'
);

describe('Layer 1: chunkSplitter', () => {
  it('splits a chunk file containing 2 System.register calls into 2 modules', async () => {
    const out = await splitChunks({ name: 'a.js', source: fixture });
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('Player');
    expect(out[1].name).toBe('Enemy');
    expect(out[0].registerId).toBe('chunks:///_virtual/Player.ts');
    expect(out[0].deps).toEqual(['cc']);
    expect(out[1].deps).toEqual(['cc', './Player']);
    expect(out[0].ast).toBeTruthy();
    expect(out[0].ast.type).toBe('File');
  });

  it('returns one passthrough module if no System.register is found', async () => {
    const out = await splitChunks({ name: 'plain.js', source: 'var x = 1;' });
    expect(out).toHaveLength(1);
    expect(out[0].registerId).toBeNull();
  });

  it('extracts setter bindings (var → import name mapping)', async () => {
    const out = await splitChunks({ name: 'a.js', source: fixture });
    const playerSetter = out[0].setterBindings;
    expect(playerSetter).toEqual([
      { dep: 'cc', bindings: [{ local: '_decorator', imported: '_decorator' }, { local: 'Component', imported: 'Component' }] }
    ]);
  });

  it('captures whole-namespace setter (`local = ns`) as namespace binding', async () => {
    // Mirrors SQConfig.ts: each SQLevelN setter receives the entire module
    // object (`function(t){ o=t }`) instead of a destructured property.
    // Without namespace recognition, the binding is silently dropped.
    const src = `
      System.register("chunks:///_virtual/SQConfig.ts",["./SQLevel1.ts","./SQLevel2.ts"],
        (function(e){var o,i;return{setters:[function(t){o=t},function(t){i=t}],
          execute:function(){var m={1:o,2:i};}}}));
    `;
    const out = await splitChunks({ name: 'sq.js', source: src });
    expect(out).toHaveLength(1);
    expect(out[0].setterBindings).toEqual([
      { dep: './SQLevel1.ts', bindings: [{ local: 'o', namespace: true }] },
      { dep: './SQLevel2.ts', bindings: [{ local: 'i', namespace: true }] },
    ]);
  });

  it('captures contextParam (second factory param) for cjs-loader vendor wrappers', async () => {
    // Vendor wrappers like clipper/tslib read `_context.meta.url`. The minified
    // factory param name may be a single letter; splitter must record it so
    // esmRebuilder can inject the import.meta.url shim.
    const src = `
      System.register("chunks:///_virtual/clipper.ts",[],
        (function(e,t){var n=t.meta.url;return{setters:[],execute:function(){}}}));
    `;
    const out = await splitChunks({ name: 'clipper.js', source: src });
    expect(out[0].exportParam).toBe('e');
    expect(out[0].contextParam).toBe('t');
  });

  it('detects setter re-exports: _export("X", t.Y) → reexport binding', async () => {
    const src = `
      System.register("chunks:///_virtual/index.ts",["./A.ts"],
        (function(e){return{setters:[function(t){e("Foo",t.Bar)}],execute:function(){}}}));
    `;
    const out = await splitChunks({ name: 'index.js', source: src });
    expect(out[0].setterBindings).toEqual([
      { dep: './A.ts', bindings: [{ reexport: true, exported: 'Foo', imported: 'Bar' }] },
    ]);
  });

  it('folds `var o={};o.X=t.X;_export(o)` collector pattern into per-prop reexports', async () => {
    const src = `
      System.register("chunks:///_virtual/index.ts",["./A.ts"],
        (function(e){return{setters:[function(t){var o={};o.X=t.X;o.Y=t.Z;e(o)}],execute:function(){}}}));
    `;
    const out = await splitChunks({ name: 'index.js', source: src });
    expect(out[0].setterBindings).toEqual([
      { dep: './A.ts', bindings: [
        { reexport: true, exported: 'X', imported: 'X' },
        { reexport: true, exported: 'Y', imported: 'Z' },
      ] },
    ]);
  });

  it('treats `_export(t)` (bare namespace re-export) as namespace reexport', async () => {
    const src = `
      System.register("chunks:///_virtual/index.ts",["./A.ts"],
        (function(e){return{setters:[function(t){e(t)}],execute:function(){}}}));
    `;
    const out = await splitChunks({ name: 'index.js', source: src });
    expect(out[0].setterBindings).toEqual([
      { dep: './A.ts', bindings: [{ reexport: true, namespace: true }] },
    ]);
  });

  it('aggregates exports / hasDefault from setter reexports and execute-body _export calls', async () => {
    // Mixed barrel: re-exports `Foo` from setter, declares `Bar` and `default`
    // in execute body via _export(). Resolver needs both forms to decide
    // whether a candidate satisfies an importer's binding set.
    const src = `
      System.register("chunks:///_virtual/index.ts",["./A.ts"],
        (function(e){var x;return{setters:[function(t){e("Foo",t.Bar)}],
          execute:function(){e("Bar",x);e("default",{lib:1})}}}));
    `;
    const out = await splitChunks({ name: 'index.js', source: src });
    expect(out[0].exports).toBeInstanceOf(Set);
    expect([...out[0].exports].sort()).toEqual(['Bar', 'Foo']);
    expect(out[0].hasDefault).toBe(true);
  });

  it('aggregates _export({a:..,b:..}) object-literal calls into exports set', async () => {
    const src = `
      System.register("chunks:///_virtual/barrel.ts",[],
        (function(e){return{setters:[],execute:function(){e({alpha:1,beta:2})}}}));
    `;
    const out = await splitChunks({ name: 'b.js', source: src });
    expect([...out[0].exports].sort()).toEqual(['alpha', 'beta']);
    expect(out[0].hasDefault).toBe(false);
  });

  it('parses comma-list setter (SequenceExpression) into multiple bindings', async () => {
    // Minified setter: `function(e){i=e.cclegacy,n=e.Vec2}` — one statement,
    // two assignments comma-joined.
    const src = `
      System.register("chunks:///_virtual/X.ts",["cc"],
        (function(e){var i,n;return{setters:[function(e){i=e.cclegacy,n=e.Vec2}],
          execute:function(){}}}));
    `;
    const out = await splitChunks({ name: 'x.js', source: src });
    expect(out[0].setterBindings).toEqual([
      { dep: 'cc', bindings: [
        { local: 'i', imported: 'cclegacy' },
        { local: 'n', imported: 'Vec2' },
      ] },
    ]);
  });
});

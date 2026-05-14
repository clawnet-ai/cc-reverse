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

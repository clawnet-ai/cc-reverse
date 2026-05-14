import { describe, it, expect } from 'vitest';
import babelGenerator from '@babel/generator';
const generate = babelGenerator.default || babelGenerator;
import { rebuildEsm } from '../../src/core/cocos3x/scriptRecovery/esmRebuilder.js';
import { splitChunks } from '../../src/core/cocos3x/scriptRecovery/chunkSplitter.js';

const fixture = `
System.register("chunks:///_virtual/Player.ts", ["cc"], function (_export, _context) {
  "use strict";
  var Component, Player;
  _export("default", void 0);
  return {
    setters: [function (_cc) { Component = _cc.Component; }],
    execute: function () {
      Player = class Player extends Component { onLoad() {} };
      _export("default", Player);
      _export("HELPER", 42);
    }
  };
});
`;

describe('Layer 2: esmRebuilder', () => {
  it('emits import statements from setterBindings', async () => {
    const [mod] = await splitChunks({ name: 'a.js', source: fixture });
    const ast = await rebuildEsm(mod.ast, mod);
    const code = generate(ast).code;
    expect(code).toMatch(/import\s*\{\s*Component\s*\}\s*from\s*['"]cc['"]/);
  });

  it('rewrites _export("name", value) → export named binding (or default)', async () => {
    const [mod] = await splitChunks({ name: 'a.js', source: fixture });
    const ast = await rebuildEsm(mod.ast, mod);
    const code = generate(ast).code;
    expect(code).toMatch(/export\s+default\s+Player/);
    expect(code).toMatch(/export\s+(?:const|let|var)?\s*HELPER/);
  });

  it('passthrough on null ast', async () => {
    const result = await rebuildEsm(null, { name: 'x', deps: [], setterBindings: [] });
    expect(result).toBeNull();
  });

  it('injects _context shim when factory body references contextParam', async () => {
    const src = `
      System.register("chunks:///_virtual/clipper.ts",[],
        (function(e,t){var n=t.meta.url;return{setters:[],execute:function(){var u=t.meta.url;}}}));
    `;
    const [mod] = await splitChunks({ name: 'clipper.js', source: src });
    const ast = await rebuildEsm(mod.ast, mod);
    const code = generate(ast).code;
    expect(mod.contextParam).toBe('t');
    expect(code).toMatch(/const\s+t\s*=\s*\{[\s\S]*meta:\s*\{[\s\S]*url:\s*import\.meta\.url/);
  });

  it('does not inject _context shim when contextParam is unreferenced', async () => {
    const src = `
      System.register("chunks:///_virtual/x.ts",["cc"],
        (function(e,t){var c;return{setters:[function(x){c=x.cclegacy}],execute:function(){c.foo();}}}));
    `;
    const [mod] = await splitChunks({ name: 'x.js', source: src });
    const ast = await rebuildEsm(mod.ast, mod);
    const code = generate(ast).code;
    expect(code).not.toMatch(/const\s+t\s*=\s*\{[\s\S]*import\.meta\.url/);
  });

  it('emits `export { Y as X } from ...` for setter-level reexport bindings', async () => {
    const src = `
      System.register("chunks:///_virtual/index.ts",["./A.ts"],
        (function(e){return{setters:[function(t){e("Foo",t.Bar)}],execute:function(){}}}));
    `;
    const [mod] = await splitChunks({ name: 'index.js', source: src });
    const ast = await rebuildEsm(mod.ast, mod);
    const code = generate(ast).code;
    expect(code).toMatch(/export\s*\{\s*Bar\s+as\s+Foo\s*\}\s*from\s*['"]\.\/A['"]/);
  });

  it('emits `export * from` for bare namespace re-export setters', async () => {
    const src = `
      System.register("chunks:///_virtual/index.ts",["./A.ts"],
        (function(e){return{setters:[function(t){e(t)}],execute:function(){}}}));
    `;
    const [mod] = await splitChunks({ name: 'index.js', source: src });
    const ast = await rebuildEsm(mod.ast, mod);
    const code = generate(ast).code;
    expect(code).toMatch(/export\s*\*\s*from\s*['"]\.\/A['"]/);
  });

  it('emits `import * as local` for namespace bindings', async () => {
    // SQConfig.ts setter shape: `function(t){ o = t }` — whole module object.
    const src = `
      System.register("chunks:///_virtual/M.ts",["./Lv1.ts","./Lv2.ts","cc"],
        function(e){var o,i,c;return{setters:[
          function(t){o=t;},
          function(t){i=t;},
          function(t){c=t.cclegacy;}
        ],execute:function(){var m={1:o,2:i};}};});
    `;
    const [mod] = await splitChunks({ name: 'm.js', source: src });
    const ast = await rebuildEsm(mod.ast, mod);
    const code = generate(ast).code;
    expect(code).toMatch(/import\s*\*\s*as\s+o\s+from\s*['"]\.\/Lv1['"]/);
    expect(code).toMatch(/import\s*\*\s*as\s+i\s+from\s*['"]\.\/Lv2['"]/);
    expect(code).toMatch(/import\s*\{\s*cclegacy\s+as\s+c\s*\}\s*from\s*['"]cc['"]/);
  });
});

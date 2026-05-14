import { describe, it, expect } from 'vitest';
import babelParser from '@babel/parser';
import babelGenerator from '@babel/generator';
import { restoreClasses } from '../../src/core/cocos3x/scriptRecovery/classRestorer.js';

const parse = babelParser.parse || babelParser;
const generate = babelGenerator.default || babelGenerator;

describe('Layer 3: classRestorer', () => {
  it('collapses __extends IIFE into class extends (or fails closed)', async () => {
    const src = `
      var __extends = (this && this.__extends) || function (d, b) { for (var p in b) d[p] = b[p]; function __() { this.constructor = d; } d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __()); };
      var Player = (function (_super) {
        __extends(Player, _super);
        function Player() { return _super.call(this) || this; }
        Player.prototype.onLoad = function () { console.log('p'); };
        return Player;
      }(Component));
    `;
    const ast = parse(src, { sourceType: 'module' });
    const out = await restoreClasses(ast, { name: 'Player' });
    const code = generate(out).code;
    expect(code).toMatch(/class\s+Player\s+extends\s+Component/);
    expect(code).toMatch(/onLoad\s*\(\s*\)/);
    expect(code).not.toMatch(/__extends\s*\(\s*Player/);
  });

  it('collapses __decorate(..., Class) into a decorator', async () => {
    // Use a pre-collapsed class declaration so foldDecorate can do its job
    // independently of whether webcrack is loaded.
    const src = `
      class Player extends Component {
        constructor() { super(); }
      }
      Player = __decorate([ccclass('Player')], Player);
      export default Player;
    `;
    const ast = parse(src, {
      sourceType: 'module',
      plugins: ['decorators-legacy', 'classProperties'],
    });
    const out = await restoreClasses(ast, { name: 'Player' });
    const code = generate(out).code;
    expect(code).toMatch(/@ccclass\(['"]Player['"]\)/);
    expect(code).not.toMatch(/__decorate/);
  });

  it('collapses minified __extends IIFE (single-letter helper + super param)', async () => {
    // Mimics webcrack-output for a minified bundle: helper renamed to `e`,
    // _super renamed to `t`. classRestorer must derive superParamName from
    // the function's actual first param rather than literal '_super'.
    const src = `
      var Player = (function (t) {
        e(Player, t);
        function Player() { return t.apply(this, arguments) || this; }
        Player.prototype.onLoad = function () { console.log('p'); };
        return Player;
      }(Component));
    `;
    const ast = parse(src, { sourceType: 'module' });
    const out = await restoreClasses(ast, { name: 'Player', preminified: true });
    const code = generate(out).code;
    expect(code).toMatch(/class\s+Player\s+extends\s+Component/);
    expect(code).toMatch(/onLoad\s*\(\s*\)/);
    expect(code).not.toMatch(/e\(Player/);
  });

  it('rewrites anonymous IIFE-class instantiation to native class', async () => {
    // var Ve = new (function(t){ function i(){return t.apply(this,arguments)||this}
    //                            e(i,t); i.prototype.m = function(){}; return i; }(Super))();
    // Without rewrite, `new (Super)()` via apply throws on ES6 base classes.
    const src = `
      var Ve = new (function (t) {
        function i() { return t.apply(this, arguments) || this; }
        e(i, t);
        i.prototype.getSpriteFrame = function (n) { return n; };
        return i;
      }(SpriteAtlas))();
    `;
    const ast = parse(src, { sourceType: 'module' });
    const out = await restoreClasses(ast, { name: 'mod', preminified: true });
    const code = generate(out).code;
    expect(code).toMatch(/new\s+class\s+extends\s+SpriteAtlas/);
    expect(code).toMatch(/getSpriteFrame/);
    expect(code).not.toMatch(/e\(i,\s*t\)/);
  });

  it('collapses var X = (IIFE)(Super) where inner ctor name differs from outer var', async () => {
    // Webcrack-output for minified bundles often emits
    //   var xt = function(t){ function n(e,i){...} e(n,t); ...; return n; }(d);
    // — outer var `xt`, inner ctor `n`. Without folding, the leftover
    // `e(n,t)`/`i(n,[...])` calls reference helpers that are out of scope at
    // runtime and throw `ReferenceError: e is not defined`.
    const src = `
      var xt = function (t) {
        function n(a, b) { return t.call(this, a, b) || this; }
        e(n, t);
        n.prototype.captureTouch = function () { return this; };
        i(n, [{ key: "sender", get: function () { return this; } }]);
        return n;
      }(BaseClass);
    `;
    const ast = parse(src, { sourceType: 'module' });
    const out = await restoreClasses(ast, { name: 'xt', preminified: true });
    const code = generate(out).code;
    expect(code).toMatch(/class\s+xt\s+extends\s+BaseClass/);
    expect(code).toMatch(/captureTouch/);
    expect(code).not.toMatch(/e\(n,\s*t\)/);
  });

  it('passthrough on null ast', async () => {
    expect(await restoreClasses(null, { name: 'x' })).toBeNull();
  });
});

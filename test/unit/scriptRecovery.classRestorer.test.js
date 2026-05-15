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

  it('rewrites loose-mode super.call/apply in constructor body to super(...)', async () => {
    const src = `
      var GameKeyMgr = function (n) {
        function GameKeyMgr(e, i) {
          var r;
          (r = n.call(this, "ChangeKey", { key: i, add: e }) || this).data = undefined;
          return r;
        }
        e(GameKeyMgr, n);
        return GameKeyMgr;
      }(BaseEvent);
    `;
    const ast = parse(src, { sourceType: 'module' });
    const out = await restoreClasses(ast, { name: 'GameKeyMgr', preminified: true });
    const code = generate(out).code;
    expect(code).toMatch(/class\s+GameKeyMgr\s+extends\s+BaseEvent/);
    expect(code).toMatch(/super\(\s*"ChangeKey"/);
    expect(code).toMatch(/this\.data\s*=\s*undefined/);
    expect(code).not.toMatch(/n\.call\(this/);
  });

  it('skips fold when outer name collides with sibling top-level declaration', async () => {
    // Module already declares `let GameKeyMgr = {...}` later. Folding the IIFE
    // into `class GameKeyMgr extends r` would produce a duplicate identifier.
    const src = `
      var GameKeyMgr = function (n) {
        function GameKeyMgr() { return n.call(this) || this; }
        e(GameKeyMgr, n);
        return GameKeyMgr;
      }(BaseEvent);
      let GameKeyMgr2 = { stuff: 1 };
      var GameKeyMgr = { other: 2 };
    `;
    const ast = parse(src, { sourceType: 'module' });
    // Should NOT throw and should NOT collapse the IIFE (because outer name
    // is later re-declared).
    const out = await restoreClasses(ast, { name: 'GameKeyMgr', preminified: true });
    const code = generate(out).code;
    expect(code).not.toMatch(/class\s+GameKeyMgr/);
    // IIFE may or may not still be there, but the import must remain syntactically valid.
    expect(code).toContain('GameKeyMgr');
  });

  it('rewrites Babel rest-args super.call.apply(SUP, [this].concat(args)) shape', async () => {
    // Babel-loose output for `class X extends Y { constructor(...args){ super(...args); this.f = 1; } }`:
    //   var X = function(_super){ function X(){ var _this;
    //     for(var _len=arguments.length, args=new Array(_len), _key=0; _key<_len; _key++){ args[_key]=arguments[_key]; }
    //     return (_this = _super.call.apply(_super, [this].concat(args)) || this).f = 1, _this;
    //   } e(X,_super); return X; }(Base);
    // Without rewrite, the IIFE collapses to `class X extends Y` but the body
    // still references `_super` — which after IIFE removal is undefined and
    // throws ReferenceError: Must call super constructor in derived class...
    // Note: alias `t` has no `var t;` declaration in the body (it's hoisted
    // by Babel to the outer factory or just elided when minified).
    const src = `
      var STGamePegSystem = function (n) {
        function STGamePegSystem() {
          for (var o = arguments.length, m = new Array(o), i = 0; i < o; i++) { m[i] = arguments[i]; }
          (t = n.call.apply(n, [this].concat(m)) || this).pegCfgMap = {};
          this.pegRoot = null;
        }
        e(STGamePegSystem, n);
        return STGamePegSystem;
      }(BaseRoundPhaseHandler);
    `;
    const ast = parse(src, { sourceType: 'module' });
    const out = await restoreClasses(ast, { name: 'STGamePegSystem', preminified: true });
    const code = generate(out).code;
    expect(code).toMatch(/class\s+STGamePegSystem\s+extends\s+BaseRoundPhaseHandler/);
    expect(code).toMatch(/super\(\s*\.\.\.\s*m\s*\)/);
    expect(code).toMatch(/this\.pegCfgMap\s*=\s*\{\s*\}/);
    expect(code).toMatch(/this\.pegRoot\s*=\s*null/);
    expect(code).not.toMatch(/n\.call\.apply\(n/);
  });

  it('passthrough on null ast', async () => {
    expect(await restoreClasses(null, { name: 'x' })).toBeNull();
  });

  it('captures prototype methods assigned via local proto-alias (CryptoJS shape)', async () => {
    // Original CryptoJS-style emit: `var s = h.prototype; s._doReset = function(){...}`.
    // Without alias awareness, classRestorer used to drop those methods and emit
    // an empty `class h extends n {}`, which made downstream `n._createHelper(h)`
    // crash at runtime because h had no _doReset / _doFinalize.
    const src = `
      var __extends = function(d, b){};
      var h = (function (_super) {
        __extends(h, _super);
        function h() { return _super.apply(this, arguments) || this; }
        var s = h.prototype;
        s._doReset = function () { this._hash = 1; };
        s._doProcessBlock = function (m, i) { return m[i]; };
        return h;
      }(Hasher));
    `;
    const ast = parse(src, { sourceType: 'module' });
    const out = await restoreClasses(ast, { name: 'h' });
    const code = generate(out).code;
    expect(code).toMatch(/class\s+h\s+extends\s+Hasher/);
    expect(code).toMatch(/_doReset\s*\(\s*\)/);
    expect(code).toMatch(/_doProcessBlock\s*\(\s*m\s*,\s*i\s*\)/);
    // The alias-decl must not survive
    expect(code).not.toMatch(/var\s+s\s*=\s*h\.prototype/);
  });

  it('lifts static assignments inside the IIFE onto the class as static members', async () => {
    // CryptoJS attaches helpers like Hasher._createHelper on the constructor
    // itself inside the IIFE body. They were dropped as "static assignments
    // — drop in MVP", which made downstream `n._createHelper(h)` blow up at
    // runtime with TypeError. Now they should be preserved as ES6 static
    // class members.
    const src = `
      var __extends = function(d, b){};
      var Hasher = (function (_super) {
        __extends(Hasher, _super);
        function Hasher() { return _super.apply(this, arguments) || this; }
        Hasher._createHelper = function (algo) { return function (msg, key) { return new algo(key).finalize(msg); }; };
        Hasher._XFORM_MODE = 1;
        var s = Hasher.prototype;
        s.reset = function () { this._x = 0; };
        return Hasher;
      }(BaseAlgo));
    `;
    const ast = parse(src, { sourceType: 'module' });
    const out = await restoreClasses(ast, { name: 'Hasher' });
    const code = generate(out).code;
    expect(code).toMatch(/class\s+Hasher\s+extends\s+BaseAlgo/);
    expect(code).toMatch(/static\s+_createHelper\s*\(\s*algo\s*\)/);
    expect(code).toMatch(/static\s+_XFORM_MODE\s*=\s*1/);
    expect(code).toMatch(/reset\s*\(\s*\)/);
  });
});

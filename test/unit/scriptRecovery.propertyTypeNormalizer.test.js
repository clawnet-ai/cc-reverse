import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import babelGenerator from '@babel/generator';
const generate = babelGenerator.default || babelGenerator;
import { normalizePropertyTypes } from '../../src/core/cocos3x/scriptRecovery/propertyTypeNormalizer.js';

function ast(src) {
  return parse(src, { sourceType: 'module', plugins: ['decorators-legacy', 'classProperties'] });
}

describe('Layer 4.5: propertyTypeNormalizer', () => {
  it('drops `type: String` when alias of _decorator.property is invoked', async () => {
    const src = `
      var o = _decorator;
      var $ = o.property;
      var d = $({ type: String, tooltip: '动画名' });
      var n = $({ type: Number, tooltip: '帧数' });
      var b = $({ type: Boolean, tooltip: '循环' });
    `;
    const a = ast(src);
    await normalizePropertyTypes([{ ast: a }]);
    const code = generate(a).code;
    expect(code).not.toMatch(/type:\s*String/);
    expect(code).not.toMatch(/type:\s*Number/);
    expect(code).not.toMatch(/type:\s*Boolean/);
    expect(code).toMatch(/tooltip:\s*['"]动画名['"]/);
  });

  it('removes the whole argument object when only `type` was present', async () => {
    const src = `
      var $ = o.property;
      var x = $({ type: Number });
    `;
    const a = ast(src);
    await normalizePropertyTypes([{ ast: a }]);
    const code = generate(a).code;
    expect(code).toMatch(/\$\(\)/);
  });

  it('preserves non-native types (custom class refs, cc.* values)', async () => {
    const src = `
      var $ = o.property;
      var x = $({ type: SpriteAtlas });
      var y = $({ type: [FrameAnimClipInfo] });
    `;
    const a = ast(src);
    await normalizePropertyTypes([{ ast: a }]);
    const code = generate(a).code;
    expect(code).toMatch(/type:\s*SpriteAtlas/);
    expect(code).toMatch(/type:\s*\[FrameAnimClipInfo\]/);
  });

  it('handles direct `_decorator.property({...})` call form', async () => {
    const src = `
      _decorator.property({ type: String, tooltip: 'x' });
    `;
    const a = ast(src);
    await normalizePropertyTypes([{ ast: a }]);
    const code = generate(a).code;
    expect(code).not.toMatch(/type:\s*String/);
    expect(code).toMatch(/tooltip:\s*['"]x['"]/);
  });

  it('skips modules without ast safely', async () => {
    await expect(normalizePropertyTypes([{ ast: null }, null])).resolves.toBeTruthy();
  });

  it('rewrites `type: [String|Number|Boolean]` to engine wrappers and adds cc imports', async () => {
    const src = `
      import { _decorator } from "cc";
      var o = _decorator;
      var $ = o.property;
      var a = $({ type: [String], displayName: 'a' });
      var b = $({ type: [Number] });
      var c = $({ type: [Boolean] });
    `;
    const a = ast(src);
    await normalizePropertyTypes([{ ast: a }]);
    const code = generate(a).code;
    expect(code).toMatch(/type:\s*\[CCString\]/);
    expect(code).toMatch(/type:\s*\[CCFloat\]/);
    expect(code).toMatch(/type:\s*\[CCBoolean\]/);
    // Imports should be merged into the existing `from "cc"` declaration.
    expect(code).toMatch(/import\s*\{[^}]*CCString[^}]*\}\s*from\s*['"]cc['"]/);
    expect(code).toMatch(/CCFloat/);
    expect(code).toMatch(/CCBoolean/);
  });

  it('rewrites array native types when imported as aliases (`import { String as s } from "cc"`)', async () => {
    const src = `
      import { _decorator as c, String as s, Number as n, Boolean as b } from "cc";
      var $ = c.property;
      var d = $({ type: [s], displayName: 'ids' });
      var e = $({ type: [n] });
      var f = $({ type: [b] });
      var g = $({ type: s });
    `;
    const a = ast(src);
    await normalizePropertyTypes([{ ast: a }]);
    const code = generate(a).code;
    expect(code).toMatch(/type:\s*\[CCString\]/);
    expect(code).toMatch(/type:\s*\[CCFloat\]/);
    expect(code).toMatch(/type:\s*\[CCBoolean\]/);
    // Scalar aliased `type: s` should also be dropped (cocos auto-infers).
    expect(code).not.toMatch(/type:\s*s\b/);
    expect(code).toMatch(/import\s*\{[^}]*CCString[^}]*\}\s*from\s*['"]cc['"]/);
  });

  it('leaves non-native array element types alone', async () => {
    const src = `
      var $ = o.property;
      var x = $({ type: [SpriteAtlas] });
    `;
    const a = ast(src);
    await normalizePropertyTypes([{ ast: a }]);
    const code = generate(a).code;
    expect(code).toMatch(/type:\s*\[SpriteAtlas\]/);
    expect(code).not.toMatch(/CCString|CCFloat|CCBoolean/);
  });

  it('inserts a cc import declaration when none existed', async () => {
    const src = `
      var $ = o.property;
      var a = $({ type: [String] });
    `;
    const a = ast(src);
    await normalizePropertyTypes([{ ast: a }]);
    const code = generate(a).code;
    expect(code).toMatch(/import\s*\{\s*CCString\s*\}\s*from\s*["']cc["']/);
  });

  it('injects inferred `type:` into bare $() calls when fieldTypes provides one (no primitive initializer)', async () => {
    const src = `
      var $ = o.property;
      var Q = $();
      t(H.prototype, "isUseTimeScale", [Q], { initializer: function () { return null; } });
    `;
    const a = ast(src);
    await normalizePropertyTypes([{ ast: a, fieldTypes: { isUseTimeScale: 'boolean' } }]);
    const code = generate(a).code;
    expect(code).toMatch(/\$\(\{\s*type:\s*CCBoolean\s*\}\)/);
    expect(code).toMatch(/CCBoolean.*from\s*["']cc["']/s);
  });

  it('injects inferred `type:` into $({...}) calls without a type entry (no primitive initializer)', async () => {
    const src = `
      var $ = o.property;
      var D = $({ displayName: '进场动画' });
      t(N.prototype, "enterAnim", [D], { initializer: function () { return null; } });
    `;
    const a = ast(src);
    await normalizePropertyTypes([{ ast: a, fieldTypes: { enterAnim: 'string' } }]);
    const code = generate(a).code;
    expect(code).toMatch(/type:\s*CCString/);
    expect(code).toMatch(/displayName:\s*['"]进场动画['"]/);
  });

  it('does not overwrite an existing `type:` entry', async () => {
    const src = `
      var $ = o.property;
      var p = $({ type: SpriteAtlas });
      t(N.prototype, "atlas", [p], {});
    `;
    const a = ast(src);
    await normalizePropertyTypes([{ ast: a, fieldTypes: { atlas: 'string' } }]);
    const code = generate(a).code;
    expect(code).toMatch(/type:\s*SpriteAtlas/);
    expect(code).not.toMatch(/CCString/);
  });

  it('leaves $() alone when fieldTypes has no entry or only `any`', async () => {
    const src = `
      var $ = o.property;
      var Q = $();
      t(H.prototype, "unknownField", [Q], {});
    `;
    const a = ast(src);
    await normalizePropertyTypes([{ ast: a, fieldTypes: { unknownField: 'any' } }]);
    const code = generate(a).code;
    expect(code).toMatch(/\$\(\)/);
    expect(code).not.toMatch(/CCString|CCFloat|CCBoolean/);
  });

  it('does NOT inject `type:` when initializer returns a primitive literal (engine auto-infers)', async () => {
    const src = `
      var $ = o.property;
      var Q = $();
      t(H.prototype, "isAuto", [Q], { initializer: function () { return false; } });
    `;
    const a = ast(src);
    await normalizePropertyTypes([{ ast: a, fieldTypes: {} }]);
    const code = generate(a).code;
    expect(code).toMatch(/\$\(\)/);
    expect(code).not.toMatch(/CCBoolean/);
  });

  it('does NOT inject `type:` even with fieldTypes when initializer is a primitive (avoids redundant decorator warning)', async () => {
    const src = `
      var $ = o.property;
      var A = $();
      var B = $();
      t(H.prototype, "name", [A], { initializer: function () { return ""; } });
      t(H.prototype, "speed", [B], { initializer: function () { return -1; } });
    `;
    const a = ast(src);
    await normalizePropertyTypes([{ ast: a, fieldTypes: { name: 'string', speed: 'number' } }]);
    const code = generate(a).code;
    expect(code).not.toMatch(/CCString|CCFloat/);
  });
});

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
});

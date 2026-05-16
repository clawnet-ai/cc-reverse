import { describe, it, expect } from 'vitest';
import { buildImageSubMetas } from '../../src/core/cocos3x/engine3x.js';

describe('buildImageSubMetas (3x image .meta sub-asset map)', () => {
  const parentLong = 'e192053f-cc78-4617-b68c-927472f0b62d';
  const parentShort = 'bd81f6e8-11ce-4169-a9e0-83b314bf7bc3';

  it('emits a texture entry for @6c48a siblings', () => {
    const siblings = [
      { hash: '6c48a', klass: 'cc.Texture2D', doc: null },
    ];
    const subMetas = buildImageSubMetas({
      parentUuid: parentLong,
      displayName: parentShort,
      siblings,
    });
    expect(subMetas['6c48a']).toBeDefined();
    expect(subMetas['6c48a'].importer).toBe('texture');
    expect(subMetas['6c48a'].uuid).toBe(`${parentLong}@6c48a`);
    expect(subMetas['6c48a'].displayName).toBe(parentShort);
    expect(subMetas['6c48a'].id).toBe('6c48a');
    expect(subMetas['6c48a'].name).toBe('texture');
    expect(subMetas['6c48a'].userData.imageUuidOrDatabaseUri).toBe(parentLong);
  });

  it('emits a sprite-frame entry for @f9941 siblings, lifting fields from the doc', () => {
    const doc = [{
      __type__: 'cc.SpriteFrame',
      content: {
        name: 'BG1',
        rect: { x: 0, y: 0, width: 501, height: 834 },
        offset: { x: 0, y: 0 },
        originalSize: { width: 501, height: 834 },
        rotated: false,
        pivot: { x: 0.5, y: 0.5 },
      },
      _textureSource: { __uuid__: `${parentLong}@6c48a` },
    }];
    const subMetas = buildImageSubMetas({
      parentUuid: parentLong,
      displayName: parentShort,
      siblings: [
        { hash: '6c48a', klass: 'cc.Texture2D', doc: null },
        { hash: 'f9941', klass: 'cc.SpriteFrame', doc },
      ],
    });
    const sf = subMetas['f9941'];
    expect(sf).toBeDefined();
    expect(sf.importer).toBe('sprite-frame');
    expect(sf.uuid).toBe(`${parentLong}@f9941`);
    expect(sf.displayName).toBe('BG1');
    expect(sf.name).toBe('BG1');
    expect(sf.userData.rawTextureUuid).toBe(`${parentLong}@6c48a`);
    expect(sf.userData.trimX).toBe(0);
    expect(sf.userData.trimY).toBe(0);
    expect(sf.userData.width).toBe(501);
    expect(sf.userData.height).toBe(834);
    expect(sf.userData.rawWidth).toBe(501);
    expect(sf.userData.rawHeight).toBe(834);
    expect(sf.userData.rotated).toBe(false);
  });

  it('returns empty map for no siblings', () => {
    const subMetas = buildImageSubMetas({
      parentUuid: parentLong,
      displayName: parentShort,
      siblings: [],
    });
    expect(subMetas).toEqual({});
  });
});

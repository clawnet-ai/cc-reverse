import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { augmentImageSubMetas } from '../../src/core/cocos3x/engine3x.js';

/**
 * Post-process integration: after unpackBundle has emitted every sub-asset
 * file individually, augmentImageSubMetas walks the bundle dir, finds image
 * parents that have @hash siblings, and rewrites the parent .meta to
 * declare them in its subMetas map.
 */
describe('augmentImageSubMetas (3x post-process pass)', () => {
  it('injects sprite-frame + texture entries into the parent image .meta', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-imgmeta-'));
    const dir = path.join(tmp, 'main', '_packed', 'bd');
    fs.mkdirSync(dir, { recursive: true });

    const parentShort = 'bdgfboEc5Baangg7MUv3vD';
    // parentLong is whatever decodeUuid(parentShort) produces; the meta's
    // payload uuid is what augmentImageSubMetas looks up.
    const { uuidUtils } = await import('../../src/utils/uuidUtils.js');
    const parentLong = uuidUtils.decodeUuid(parentShort);

    // Pre-existing parent image meta (empty subMetas — what writeAssetMeta produced).
    fs.writeFileSync(path.join(dir, `${parentLong}.jpg`), Buffer.from([0xff]));
    fs.writeFileSync(path.join(dir, `${parentLong}.jpg.meta`), JSON.stringify({
      ver: '1.0.27',
      importer: 'image',
      imported: true,
      uuid: parentLong,
      files: ['.jpg', '.json'],
      subMetas: {},
      userData: { type: 'texture' },
    }));
    // Standalone parent json import doc (already written by pipeline).
    fs.writeFileSync(path.join(dir, `${parentLong}.json`),
      JSON.stringify([{ __type__: 'cc.ImageAsset', content: { fmt: '1', w: 0, h: 0 } }, -1]));

    // The @hash sub-asset files cc-reverse already emits (short-uuid filenames).
    fs.writeFileSync(path.join(dir, `${parentShort}@6c48a.json.meta`),
      JSON.stringify({ ver: '1.2.7', uuid: `${parentShort}@6c48a`, importer: 'asset' }));
    fs.writeFileSync(path.join(dir, `${parentShort}@f9941.json.meta`),
      JSON.stringify({ ver: '2.0.1', uuid: `${parentShort}@f9941`, importer: 'json' }));
    fs.writeFileSync(path.join(dir, `${parentShort}@f9941.json`), JSON.stringify([{
      __type__: 'cc.SpriteFrame',
      content: {
        name: 'BG1',
        rect: { x: 0, y: 0, width: 501, height: 834 },
        offset: { x: 0, y: 0 },
        originalSize: { width: 501, height: 834 },
        rotated: false,
        pivot: { x: 0.5, y: 0.5 },
      },
      _textureSource: { __uuid__: `${parentShort}@6c48a` },
    }]));

    const cfg = {
      name: 'main',
      uuids: [
        parentShort,
        `${parentShort}@6c48a`,
        `${parentShort}@f9941`,
      ],
    };
    const bundleOut = path.join(tmp, 'main');

    await augmentImageSubMetas({ cfg, bundleOut });

    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${parentLong}.jpg.meta`), 'utf-8'));
    expect(meta.subMetas['6c48a']).toBeDefined();
    expect(meta.subMetas['6c48a'].importer).toBe('texture');
    expect(meta.subMetas['f9941']).toBeDefined();
    expect(meta.subMetas['f9941'].importer).toBe('sprite-frame');
    expect(meta.subMetas['f9941'].displayName).toBe('BG1');
    expect(meta.subMetas['f9941'].userData.rawTextureUuid).toBe(`${parentLong}@6c48a`);
    // Also rewrites the standalone @hash .meta uuid into long form so editor
    // doesn't reassign on import.
    const subTexMeta = JSON.parse(fs.readFileSync(path.join(dir, `${parentShort}@6c48a.json.meta`), 'utf-8'));
    expect(subTexMeta.uuid).toBe(`${parentShort}@6c48a`);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is a no-op when a bundle has no @hash uuids', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-imgmeta-noop-'));
    const cfg = { name: 'main', uuids: ['plain-uuid-1', 'plain-uuid-2'] };
    await expect(augmentImageSubMetas({ cfg, bundleOut: tmp })).resolves.toBeUndefined();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

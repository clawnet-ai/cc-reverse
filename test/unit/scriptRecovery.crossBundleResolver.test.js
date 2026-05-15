import { describe, it, expect } from 'vitest';
import { resolveCrossBundleDeps } from '../../src/core/cocos3x/scriptRecovery/crossBundleResolver.js';

// Helpers --------------------------------------------------------------

function mkMod({ name, bundle, ccclassName, deps = [], setterBindings = [], exports = [], hasDefault = false }) {
  return {
    name,
    bundle,
    ccclassName: ccclassName || null,
    deps,
    setterBindings,
    exports: new Set(exports),
    hasDefault,
  };
}

describe('Layer 4.6: crossBundleResolver', () => {
  it('rewrites JMSystem ./index → ../bundle/index when same-bundle barrel lacks default', () => {
    // main/JMSystem imports default from "./index" (CryptoJS shape).
    // main/index has no default, only a few named re-exports (RTExt barrel).
    // bundle/index is the CryptoJS barrel — has default.
    const mainIndex = mkMod({ name: 'index', bundle: 'main', exports: ['RTExt'], hasDefault: false });
    const bundleIndex = mkMod({ name: 'index', bundle: 'bundle', exports: ['lib', 'enc'], hasDefault: true });
    const jmSystem = mkMod({
      name: 'JMSystem',
      bundle: 'main',
      deps: ['./index'],
      setterBindings: [
        { dep: './index', bindings: [{ local: 'i', imported: 'default' }] },
      ],
    });
    const out = resolveCrossBundleDeps([mainIndex, bundleIndex, jmSystem]);
    expect(out.errors).toEqual([]);
    expect(jmSystem.resolvedDeps.get('./index')).toBe('../bundle/index');
  });

  it('keeps ./index local when same-bundle candidate satisfies named imports', () => {
    const mainIndex = mkMod({ name: 'index', bundle: 'main', exports: ['Foo'], hasDefault: false });
    const consumer = mkMod({
      name: 'Consumer',
      bundle: 'main',
      deps: ['./index'],
      setterBindings: [
        { dep: './index', bindings: [{ local: 'f', imported: 'Foo' }] },
      ],
    });
    resolveCrossBundleDeps([mainIndex, consumer]);
    expect(consumer.resolvedDeps.has('./index')).toBe(false);
  });

  it('does not rewrite when multiple cross-bundle candidates satisfy', () => {
    const mainIndex = mkMod({ name: 'index', bundle: 'main', exports: [], hasDefault: false });
    const bundleA = mkMod({ name: 'index', bundle: 'a', exports: ['x'], hasDefault: true });
    const bundleB = mkMod({ name: 'index', bundle: 'b', exports: ['x'], hasDefault: true });
    const importer = mkMod({
      name: 'Importer',
      bundle: 'main',
      deps: ['./index'],
      setterBindings: [
        { dep: './index', bindings: [{ local: 'd', imported: 'default' }] },
      ],
    });
    resolveCrossBundleDeps([mainIndex, bundleA, bundleB, importer]);
    expect(importer.resolvedDeps.has('./index')).toBe(false);
  });

  it('namespace import treats empty-export candidate as unsatisfying and looks cross-bundle', () => {
    const mainNs = mkMod({ name: 'foo', bundle: 'main', exports: [], hasDefault: false });
    const bundleNs = mkMod({ name: 'foo', bundle: 'bundle', exports: ['a', 'b'], hasDefault: false });
    const consumer = mkMod({
      name: 'C',
      bundle: 'main',
      deps: ['./foo'],
      setterBindings: [
        { dep: './foo', bindings: [{ local: 'ns', namespace: true }] },
      ],
    });
    resolveCrossBundleDeps([mainNs, bundleNs, consumer]);
    expect(consumer.resolvedDeps.get('./foo')).toBe('../bundle/foo');
  });

  it('falls through (no rewrite) when no candidate satisfies', () => {
    const mainIndex = mkMod({ name: 'index', bundle: 'main', exports: ['Foo'], hasDefault: false });
    const importer = mkMod({
      name: 'I',
      bundle: 'main',
      deps: ['./index'],
      setterBindings: [
        { dep: './index', bindings: [{ local: 'd', imported: 'default' }] },
      ],
    });
    resolveCrossBundleDeps([mainIndex, importer]);
    expect(importer.resolvedDeps.has('./index')).toBe(false);
  });

  it('ignores non-./ deps (cc, ./../, absolute paths)', () => {
    const importer = mkMod({
      name: 'I',
      bundle: 'main',
      deps: ['cc', '../other/foo'],
      setterBindings: [
        { dep: 'cc', bindings: [{ local: 'c', imported: 'Component' }] },
        { dep: '../other/foo', bindings: [{ local: 'f', imported: 'foo' }] },
      ],
    });
    resolveCrossBundleDeps([importer]);
    expect(importer.resolvedDeps.size).toBe(0);
  });

  it('adds module name (without extension) when dep ends in .ts/.js', () => {
    const target = mkMod({ name: 'index', bundle: 'bundle', exports: [], hasDefault: true });
    const main = mkMod({ name: 'index', bundle: 'main', exports: [], hasDefault: false });
    const importer = mkMod({
      name: 'I',
      bundle: 'main',
      deps: ['./index.ts'],
      setterBindings: [
        { dep: './index.ts', bindings: [{ local: 'd', imported: 'default' }] },
      ],
    });
    resolveCrossBundleDeps([main, target, importer]);
    // Both keys present so the emitter matches its post-strip text and
    // any callers using the original dep string also resolve.
    expect(importer.resolvedDeps.get('./index')).toBe('../bundle/index');
    expect(importer.resolvedDeps.get('./index.ts')).toBe('../bundle/index');
  });
});

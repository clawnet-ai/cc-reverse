'use strict';

const { splitChunks: defaultSplit } = require('./chunkSplitter');
const { rebuildEsm: defaultRebuild } = require('./esmRebuilder');
const { breakCycles: defaultCycleBreaker } = require('./cycleBreaker');
const { deferCycleSuperClasses: defaultCycleSuperRewriter } = require('./cycleSuperRewriter');
const { restoreClasses: defaultRestore } = require('./classRestorer');
const { applyCcclassNames: defaultNamer } = require('./ccclassNamer');
const { inferFieldTypes: defaultInferer } = require('./typeInferer');
const { normalizePropertyTypes: defaultPropTypeNorm } = require('./propertyTypeNormalizer');
const { resolveCrossBundleDeps: defaultCrossBundleResolver } = require('./crossBundleResolver');
const { emitTsProject: defaultEmitter } = require('./tsProjectEmitter');

/**
 * Drive the 6-layer script recovery pipeline.
 *
 * @param {object} input
 * @param {Array<{name:string, source:string}>} input.chunks
 * @param {object} [input.layers] — overrides per layer for testing
 * @param {object} [input.context] — shared context passed to layers 4-6
 * @returns {Promise<{modules: Array, errors: Array, emit: object|null}>}
 */
async function runScriptRecoveryPipeline(input) {
  const { chunks = [], layers = {}, context = {} } = input;
  const split = layers.chunkSplitter || defaultSplit;
  const rebuild = layers.esmRebuilder || defaultRebuild;
  const cycleBreaker = layers.cycleBreaker || defaultCycleBreaker;
  const cycleSuperRewriter = layers.cycleSuperRewriter || defaultCycleSuperRewriter;
  const restore = layers.classRestorer || defaultRestore;
  const namer = layers.ccclassNamer || defaultNamer;
  const inferer = layers.typeInferer || defaultInferer;
  const propTypeNorm = layers.propertyTypeNormalizer || defaultPropTypeNorm;
  const crossBundleResolver = layers.crossBundleResolver || defaultCrossBundleResolver;
  const emitter = layers.tsProjectEmitter; // emitter is opt-in (engine wires it)
  const errors = [];

  let modules = [];
  for (const chunk of chunks) {
    try {
      const split1 = await split(chunk);
      modules = modules.concat(split1);
    } catch (err) {
      errors.push({ layer: 'chunkSplitter', chunk: chunk.name, message: err.message });
    }
  }

  // Layer 1.5: detect SystemJS-style import cycles and break a single safe
  // edge per SCC by converting it to a deferred namespace member access. Must
  // run BEFORE esmRebuilder so it can mutate setterBindings + the pre-ESM
  // execute body identifiers in one shot.
  let residualSccs = [];
  try {
    const r = await cycleBreaker(modules, context);
    if (r && Array.isArray(r.errors)) errors.push(...r.errors);
    if (r && Array.isArray(r.sccs)) residualSccs = r.sccs;
  } catch (err) {
    errors.push({ layer: 'cycleBreaker', message: err.message });
  }

  // Layer 1.6: for residual SCCs (where cycleBreaker could not eliminate
  // every init-time edge), rewrite leaf modules so their `extends Super`
  // hookup tolerates the super being undefined at module-init time and
  // gets retroactively repaired in a microtask. Pre-ESM so we can still
  // mutate setterBindings to add a namespace import alongside the named
  // import being deferred.
  try {
    const r = await cycleSuperRewriter(modules, residualSccs, context);
    if (r && Array.isArray(r.errors)) errors.push(...r.errors);
  } catch (err) {
    errors.push({ layer: 'cycleSuperRewriter', message: err.message });
  }

  for (const m of modules) {
    try { m.ast = await rebuild(m.ast, m); }
    catch (err) { errors.push({ layer: 'esmRebuilder', module: m.name, message: err.message }); }
  }

  for (const m of modules) {
    try { m.ast = await restore(m.ast, m); }
    catch (err) { errors.push({ layer: 'classRestorer', module: m.name, message: err.message }); }
  }

  // Layer 4 sees the whole module set so UUID maps can dedupe across files.
  try {
    modules = (await namer(modules, context)) || modules;
  } catch (err) {
    errors.push({ layer: 'ccclassNamer', message: err.message });
  }

  try {
    modules = (await inferer(modules, context)) || modules;
  } catch (err) {
    errors.push({ layer: 'typeInferer', message: err.message });
  }

  // Layer 4.5: drop `type: String|Number|Boolean` from @property decorator
  // calls to silence Cocos editor warnings. Pure AST cleanup — placed after
  // class restoration so it sees the alias `var $ = _decorator.property`.
  try {
    modules = (await propTypeNorm(modules, context)) || modules;
  } catch (err) {
    errors.push({ layer: 'propertyTypeNormalizer', message: err.message });
  }

  // Layer 4.6: resolve cross-bundle deps by export-symbol satisfaction.
  // Annotates each module with a `resolvedDeps` map; the emitter consults it
  // before applying its regex-based fallback rewrite. Fixes the
  // `main/JMSystem.ts → main/index.ts (RTExt barrel)` mis-resolution by
  // routing it to `bundle/index.ts` (CryptoJS barrel with default export).
  try {
    crossBundleResolver(modules, context);
  } catch (err) {
    errors.push({ layer: 'crossBundleResolver', message: err.message });
  }

  let emit = null;
  if (emitter) {
    try {
      emit = await emitter(modules, context);
    } catch (err) {
      errors.push({ layer: 'tsProjectEmitter', message: err.message });
    }
  }

  return { modules, errors, emit };
}

module.exports = { runScriptRecoveryPipeline };

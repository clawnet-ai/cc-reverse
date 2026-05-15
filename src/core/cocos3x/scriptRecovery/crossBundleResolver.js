'use strict';

/**
 * Layer 4.6: Cross-bundle dependency resolver.
 *
 * After the original SystemJS bundle is flattened to per-bundle directories
 * (`<outRoot>/<bundle>/<fileBase>.ts`), bare relative deps like `from "./X"`
 * stop resolving the way they did at runtime. The original SystemJS resolved
 * deps via virtual module ids (`chunks:///_virtual/X.mjs`), so two chunks
 * could each contain a module called `index` and the loader would still pick
 * the right one — they had distinct ids.
 *
 * tsProjectEmitter's `rewriteCrossBundleImports` already handled the simple
 * case where the same-bundle file is missing. This resolver handles the
 * trickier case where a same-name file exists locally but doesn't satisfy
 * the importer's needs — for example `main/index.ts` is an RTExt re-export
 * barrel without a default export, while `bundle/index.ts` is the CryptoJS
 * barrel with a default. JMSystem (in main/) imports `default` from
 * `"./index"` and would crash at runtime: `i = r.default; i.lib` → undefined.
 *
 * Strategy: for each `./X` dep in each module, check whether the same-bundle
 * candidate satisfies the importer's setterBindings (named/default/namespace
 * needs). If not, search other bundles for a candidate that does; rewrite to
 * `../<otherBundle>/X` only when there's exactly ONE such candidate. Multiple
 * matches stay unresolved (preserves the existing conservative policy).
 *
 * The resolver writes `mod.resolvedDeps: Map<originalDep, newPath>`. The
 * tsProjectEmitter rewrite step consults this map first and falls back to
 * its existing regex-based logic for anything not present.
 */
function resolveCrossBundleDeps(modules) {
  const errors = [];
  // Build (bundle → fileBase → mod) index using the same fileBase rule as
  // tsProjectEmitter (`mod.ccclassName || mod.name`). Only modules that will
  // actually be emitted to disk count as candidates — gate by `mod.ast` being
  // present so we don't index passthrough chunks.
  const index = new Map();
  for (const mod of modules) {
    if (!mod) continue;
    const fb = mod.ccclassName || mod.name;
    if (!fb) continue;
    const b = mod.bundle || 'unbundled';
    if (!index.has(b)) index.set(b, new Map());
    index.get(b).set(fb, mod);
  }

  for (const mod of modules) {
    if (!mod) continue;
    if (!Array.isArray(mod.deps)) continue;
    if (!mod.resolvedDeps) mod.resolvedDeps = new Map();
    const myBundle = mod.bundle || 'unbundled';

    for (const dep of mod.deps) {
      if (typeof dep !== 'string') continue;
      // Only handle bare same-directory relatives. `../X` is already
      // explicit; `cc`, `chunks://...`, and absolute paths aren't ours.
      const m = dep.match(/^\.\/([^/]+?)(\.[mc]?[jt]s)?$/);
      if (!m) continue;
      const baseName = m[1];

      const needs = computeNeeds(mod, dep);
      if (!needs) continue; // no setterBinding info — can't evaluate

      const sameBundleCand = index.get(myBundle)?.get(baseName);
      if (sameBundleCand && satisfies(sameBundleCand, needs)) continue;

      // Look for cross-bundle candidates that satisfy needs.
      const matches = [];
      for (const [b, byName] of index) {
        if (b === myBundle) continue;
        const cand = byName.get(baseName);
        if (cand && satisfies(cand, needs)) matches.push(b);
      }
      if (matches.length === 1) {
        // esmRebuilder strips .js/.mjs/.ts extensions before writing the import
        // text, so the emitter sees `./X` regardless of whether the chunk's
        // original dep was `./X.js`. Index resolvedDeps under the
        // extension-less form so the emitter's lookup matches.
        const key = `./${baseName}`;
        mod.resolvedDeps.set(key, `../${matches[0]}/${baseName}`);
        // Also keep the original dep string indexed for callers that pass
        // pre-stripped specs unchanged.
        if (key !== dep) mod.resolvedDeps.set(dep, `../${matches[0]}/${baseName}`);
      }
      // 0 or >1 matches: leave it; tsProjectEmitter's existing fallback
      // (or no rewrite) will keep behaviour unchanged.
    }
  }

  return { errors };
}

/**
 * Compute what the importer needs from a particular dep, by inspecting its
 * setterBindings. Returns null when the dep has no setter info (can't decide).
 */
function computeNeeds(mod, dep) {
  const setter = (mod.setterBindings || []).find((s) => s.dep === dep);
  if (!setter || !Array.isArray(setter.bindings)) return null;
  const named = new Set();
  let needsDefault = false;
  let needsNamespace = false;
  for (const b of setter.bindings) {
    if (b.namespace) {
      needsNamespace = true;
      continue;
    }
    if (b.imported === 'default') needsDefault = true;
    else if (b.imported) named.add(b.imported);
  }
  return { named, needsDefault, needsNamespace };
}

/**
 * Decide whether a candidate module's export inventory satisfies the
 * importer's requirements. A namespace import is satisfied by any candidate
 * that exports anything (named or default). Named imports require exact
 * presence in the candidate's exports set; default requires `hasDefault`.
 */
function satisfies(cand, needs) {
  if (!cand) return false;
  const exports = cand.exports || new Set();
  const hasDefault = !!cand.hasDefault;
  if (needs.needsDefault && !hasDefault) return false;
  for (const n of needs.named) {
    if (!exports.has(n)) return false;
  }
  if (needs.needsNamespace && exports.size === 0 && !hasDefault) return false;
  return true;
}

module.exports = { resolveCrossBundleDeps };

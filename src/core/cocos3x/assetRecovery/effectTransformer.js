'use strict';

// Cocos Creator 3.x EffectAsset reconstruction.
//
// At runtime an EffectAsset is a JSON document with compiled GLSL strings.
// Cocos Editor's `.effect` importer however expects the *source* form:
//
//   CCEffect %{ <yaml: techniques/passes/properties> }%
//   CCProgram <name> %{ <glsl> }%
//   ...
//
// This module rebuilds the source form from the runtime JSON. It is
// best-effort — the JSON contains everything the engine needs, but a few
// editor-only niceties (anchors, comments, original property ordering,
// linear/srgb hints) are lost. The result is good enough for the editor to
// re-import the effect and for materials to bind to it.

const KNOWN_BUILTINS = new Set([
  'builtin-unlit',
  'builtin-standard',
  'builtin-pbr',
  'builtin-toon',
  'builtin-particle',
  'builtin-particle-trail',
  'builtin-particle-gpu',
  'builtin-billboard',
  'builtin-skybox',
  'builtin-terrain',
  'builtin-spine',
  'builtin-sprite',
  'builtin-graphics',
  'builtin-clear-stencil',
  'builtin-occlusion-query',
  'builtin-debug-renderer',
  'copy-pass',
  'profiler',
  'splash-screen',
  'tone-mapping',
  'post-process',
  'bloom',
  'fxaa',
]);

// gfx enum decoders — values come from `cc.gfx.BlendFactor` / `Cull` etc.
const BLEND_FACTOR = ['zero', 'one', 'src_alpha', 'dst_alpha', 'one_minus_src_alpha', 'one_minus_dst_alpha', 'src_color', 'dst_color', 'one_minus_src_color', 'one_minus_dst_color', 'src_alpha_saturate', 'constant_color', 'one_minus_constant_color', 'constant_alpha', 'one_minus_constant_alpha'];
const BLEND_OP = ['add', 'sub', 'rev_sub', 'min', 'max'];
const CULL_MODE = ['none', 'front', 'back'];
const COMPARE_FUNC = ['never', 'less', 'equal', 'less_equal', 'greater', 'not_equal', 'greater_equal', 'always'];
const STENCIL_OP = ['zero', 'keep', 'replace', 'incr', 'decr', 'invert', 'incr_wrap', 'decr_wrap'];
const POLYGON_MODE = ['fill', 'point', 'line'];
const SHADE_MODEL = ['gouraud', 'flat'];

// gfx Type enum (subset). Maps to GLSL types for property declarations.
const GFX_TYPE = {
  13: 'vec4',     // FLOAT4
  12: 'vec3',     // FLOAT3
  11: 'vec2',     // FLOAT2
  10: 'float',    // FLOAT
  16: 'mat4',
  15: 'mat3',
  14: 'mat2',
  20: 'int',
  21: 'ivec2',
  22: 'ivec3',
  23: 'ivec4',
  28: 'sampler2D',
  29: 'samplerCube',
};

function isBuiltinEffect(asset) {
  if (!asset) return false;
  const name = asset._name || '';
  // Strip any directory prefix — Cocos engine ships builtins under
  // editor/assets/effects/{internal,for2d,pipeline,util,...}/ and the JSON's
  // _name field carries the full sub-path (e.g. "for2d/builtin-sprite",
  // "pipeline/post-process/tone-mapping"). Only the basename matters for
  // builtin recognition.
  const base = name.split('/').pop();
  if (KNOWN_BUILTINS.has(base)) return true;
  if (base.startsWith('builtin-')) return true;
  return false;
}

function transformEffectAsset(jsonText) {
  let asset;
  try {
    const parsed = JSON.parse(jsonText);
    asset = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return null;
  }
  if (!asset || asset.__type__ !== 'cc.EffectAsset') return null;
  // Builtin effects are owned by the engine — once references are decoded to
  // their real long uuids (see rehydrate decodeUuid), materials resolve
  // straight to the engine's copy. Emitting our own .effect/.meta would just
  // collide with the engine asset on the same uuid.
  if (isBuiltinEffect(asset)) return { skip: true, name: asset._name };

  const yaml = buildYaml(asset);
  const programs = buildPrograms(asset);

  let out = '';
  if (asset._name) out += `// ${asset._name}\n`;
  out += 'CCEffect %{\n' + indent(yaml, 2) + '\n}%\n';
  for (const p of programs) {
    out += `\nCCProgram ${p.name} %{\n${indent(p.body.trim(), 2)}\n}%\n`;
  }
  return { skip: false, source: out, name: asset._name || '' };
}

function buildYaml(asset) {
  const techniques = asset.techniques || [];
  const lines = [];
  lines.push('techniques:');
  for (const tech of techniques) {
    const head = tech.name ? `- name: ${quoteIfNeeded(tech.name)}` : '-';
    lines.push(head);
    if (Array.isArray(tech.passes)) {
      lines.push('  passes:');
      for (const pass of tech.passes) emitPass(lines, pass, asset);
    }
  }
  return lines.join('\n');
}

function emitPass(lines, pass, asset) {
  // Resolve "vert"/"frag" entry names from the program string. Programs in
  // the JSON look like "<basename>|<vsName>:vert|<fsName>:frag". We expose
  // both halves separately for the YAML.
  const stages = splitProgramName(pass.program);
  const head = '    -';
  let first = true;
  function add(line) {
    if (first) { lines.push(`${head} ${line}`); first = false; }
    else lines.push(`      ${line}`);
  }
  if (stages.vert) add(`vert: ${stages.vert}`);
  if (stages.frag) add(`frag: ${stages.frag}`);
  if (pass.phase) add(`phase: ${quoteIfNeeded(pass.phase)}`);
  if (typeof pass.priority === 'number') add(`priority: ${pass.priority}`);
  if (typeof pass.propertyIndex === 'number') add(`propertyIndex: ${pass.propertyIndex}`);
  if (pass.primitive) add(`primitive: ${pass.primitive}`);

  if (pass.rasterizerState) {
    add('rasterizerState:');
    pushKv(lines, pass.rasterizerState, '        ', { cullMode: CULL_MODE, polygonMode: POLYGON_MODE, shadeModel: SHADE_MODEL });
  }
  if (pass.depthStencilState) {
    add('depthStencilState:');
    pushKv(lines, pass.depthStencilState, '        ', {
      depthFunc: COMPARE_FUNC,
      stencilFuncFront: COMPARE_FUNC, stencilFuncBack: COMPARE_FUNC,
      stencilFailOpFront: STENCIL_OP, stencilFailOpBack: STENCIL_OP,
      stencilZFailOpFront: STENCIL_OP, stencilZFailOpBack: STENCIL_OP,
      stencilPassOpFront: STENCIL_OP, stencilPassOpBack: STENCIL_OP,
    });
  }
  if (pass.blendState) {
    add('blendState:');
    if (Array.isArray(pass.blendState.targets)) {
      lines.push('        targets:');
      for (const t of pass.blendState.targets) {
        lines.push('        -');
        pushKv(lines, t, '          ', {
          blend: null,
          blendSrc: BLEND_FACTOR, blendDst: BLEND_FACTOR,
          blendSrcAlpha: BLEND_FACTOR, blendDstAlpha: BLEND_FACTOR,
          blendEq: BLEND_OP, blendAlphaEq: BLEND_OP,
        });
      }
    }
    if (typeof pass.blendState.isA2C === 'boolean') lines.push(`        isA2C: ${pass.blendState.isA2C}`);
    if (Array.isArray(pass.blendState.blendColor)) lines.push(`        blendColor: ${JSON.stringify(pass.blendState.blendColor)}`);
  }
  if (pass.properties) {
    add('properties:');
    emitProperties(lines, pass.properties, '        ');
  }
  if (pass.migrations) {
    add('migrations:');
    emitYamlObject(lines, pass.migrations, '        ');
  }
}

function pushKv(lines, obj, indentStr, enums) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    let val = v;
    const en = enums && Object.prototype.hasOwnProperty.call(enums, k) ? enums[k] : null;
    if (en && typeof v === 'number' && en[v]) val = en[v];
    if (typeof val === 'object') {
      lines.push(`${indentStr}${k}:`);
      emitYamlObject(lines, val, indentStr + '  ');
    } else if (typeof val === 'string') {
      lines.push(`${indentStr}${k}: ${quoteIfNeeded(val)}`);
    } else {
      lines.push(`${indentStr}${k}: ${val}`);
    }
  }
}

function emitProperties(lines, props, indentStr) {
  for (const [name, def] of Object.entries(props)) {
    const parts = [];
    if (def.value !== undefined) {
      const v = Array.isArray(def.value) ? `[${def.value.join(', ')}]` : JSON.stringify(def.value);
      parts.push(`value: ${v}`);
    }
    if (typeof def.type === 'number' && GFX_TYPE[def.type] && def.value === undefined) {
      // No default value, just declare a sampler/uniform — keep type hint.
      parts.push(`type: ${GFX_TYPE[def.type]}`);
    }
    if (def.target) parts.push(`target: ${quoteIfNeeded(def.target)}`);
    if (def.linear !== undefined) parts.push(`linear: ${def.linear}`);
    if (def.editor) parts.push(`editor: ${inlineFlow(def.editor)}`);
    lines.push(`${indentStr}${name}: { ${parts.join(', ')} }`);
  }
}

function emitYamlObject(lines, obj, indentStr) {
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item && typeof item === 'object') {
        lines.push(`${indentStr}-`);
        emitYamlObject(lines, item, indentStr + '  ');
      } else {
        lines.push(`${indentStr}- ${formatScalar(item)}`);
      }
    }
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') {
        lines.push(`${indentStr}${k}:`);
        emitYamlObject(lines, v, indentStr + '  ');
      } else {
        lines.push(`${indentStr}${k}: ${formatScalar(v)}`);
      }
    }
    return;
  }
  lines.push(`${indentStr}${formatScalar(obj)}`);
}

function inlineFlow(o) {
  if (Array.isArray(o)) return `[${o.map(inlineFlow).join(', ')}]`;
  if (o && typeof o === 'object') {
    const parts = Object.entries(o).map(([k, v]) => `${k}: ${inlineFlow(v)}`);
    return `{ ${parts.join(', ')} }`;
  }
  return formatScalar(o);
}

function formatScalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return quoteIfNeeded(v);
  return JSON.stringify(v);
}

function quoteIfNeeded(s) {
  if (typeof s !== 'string') return JSON.stringify(s);
  if (s === '' || /[:#&*!|>'"%@`{}\[\],]/.test(s) || /^\s|\s$/.test(s) || /^(true|false|null|yes|no|on|off|~)$/i.test(s) || /^-?\d/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

// "<basename>|<vsName>:vert|<fsName>:frag" → { vert, frag }
function splitProgramName(program) {
  if (!program || typeof program !== 'string') return {};
  const parts = program.split('|');
  const out = {};
  for (const p of parts) {
    if (p.endsWith(':vert')) out.vert = p;
    else if (p.endsWith(':frag')) out.frag = p;
  }
  return out;
}

function buildPrograms(asset) {
  // Collect property value lengths across all passes — used to downgrade
  // UBO members that the compiler packed into vec4 slots back to their
  // authored scalar/vec2/vec3 types so usage like `if (x < threshold)` keeps
  // matching scalar arithmetic in GLSL.
  const propLen = collectPropertyLengths(asset);
  const programs = [];
  for (const sh of asset.shaders || []) {
    const stages = splitProgramName(sh.name);
    const glsl = sh.glsl1 || sh.glsl3 || sh.glsl4 || {};
    if (stages.vert && glsl.vert) {
      programs.push({ name: stages.vert.split(':')[0], body: postProcessGlsl(glsl.vert, sh, propLen) });
    }
    if (stages.frag && glsl.frag) {
      programs.push({ name: stages.frag.split(':')[0], body: postProcessGlsl(glsl.frag, sh, propLen) });
    }
  }
  // Dedup by name (vert/frag from multiple shaders of the same effect repeat).
  const seen = new Set();
  return programs.filter((p) => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
}

// Engine-provided builtin uniforms, grouped by the chunk that declares them
// in editor/assets/chunks/builtin/uniforms/. The compiled glsl1 has these
// expanded as bare uniforms — Cocos's source effect compiler rejects bare
// vector/matrix uniforms (EFX2201). We strip them here and emit the matching
// `#include <builtin/uniforms/...>` so the editor's preprocessor re-supplies
// the declarations from the engine's chunk library. Names collected from the
// engine's *.chunk files (Cocos Creator 3.8.x).
const BUILTIN_CHUNKS = {
  'cc-global': [
    'cc_cameraPos', 'cc_exposure', 'cc_screenSize', 'cc_nativeSize', 'cc_screenScale',
    'cc_time', 'cc_mainLitDir', 'cc_mainLitColor', 'cc_ambientSky', 'cc_ambientGround',
    'cc_fogColor', 'cc_fogBase', 'cc_fogAdd', 'cc_nearFar', 'cc_viewPort',
    'cc_matView', 'cc_matViewInv', 'cc_matProj', 'cc_matProjInv',
    'cc_matViewProj', 'cc_matViewProjInv',
    'cc_surfaceTransform', 'cc_probeInfo', 'cc_debug_view_mode',
  ],
  'cc-local': [
    'cc_matWorld', 'cc_matWorldIT', 'cc_lightingMapUVParam', 'cc_localShadowBias',
    'cc_reflectionProbeData1', 'cc_reflectionProbeData2',
    'cc_reflectionProbeBlendData1', 'cc_reflectionProbeBlendData2',
  ],
  'cc-shadow': [
    'cc_matLightView', 'cc_matLightProj', 'cc_matLightInvProj', 'cc_matLightViewProj',
    'cc_shadowInvProjDepthInfo', 'cc_shadowProjDepthInfo', 'cc_shadowProjInfo',
    'cc_shadowNFLSInfo', 'cc_shadowWHPBInfo', 'cc_shadowLPNNInfo',
    'cc_shadowColor', 'cc_planarNDInfo',
  ],
  'cc-shadow-map': ['cc_shadowMap', 'cc_spotShadowMap'],
  'cc-csm': [
    'cc_matCSMViewProj', 'cc_csmViewDir0', 'cc_csmViewDir1', 'cc_csmViewDir2',
    'cc_csmAtlas', 'cc_csmProjDepthInfo', 'cc_csmProjInfo', 'cc_csmSplitsInfo',
  ],
  'cc-forward-light': [
    'cc_lightPos', 'cc_lightColor', 'cc_lightDir', 'cc_lightSizeRangeAngle',
    'cc_lightBoundingSizeVS',
  ],
  'cc-light-map': ['cc_lightingMap'],
  'cc-environment': ['cc_environment'],
  'cc-diffusemap': ['cc_diffuseMap'],
  'cc-skinning': [
    'cc_jointAnimInfo', 'cc_jointTexture', 'cc_jointTextureInfo',
    'cc_joints', 'cc_realtimeJoint',
  ],
  'cc-morph': [
    'cc_PositionDisplacements', 'cc_NormalDisplacements', 'cc_TangentDisplacements',
    'cc_displacementWeights', 'cc_displacementTextureInfo',
  ],
  'cc-sh': [
    'cc_sh_linear_const_r', 'cc_sh_linear_const_g', 'cc_sh_linear_const_b',
    'cc_sh_quadratic_r', 'cc_sh_quadratic_g', 'cc_sh_quadratic_b', 'cc_sh_quadratic_a',
  ],
  'cc-reflection-probe': [
    'cc_reflectionProbeCubemap', 'cc_reflectionProbePlanarMap',
    'cc_reflectionProbeDataMap', 'cc_reflectionProbeBlendCubemap',
  ],
  'cc-world-bound': ['cc_worldBoundCenter', 'cc_worldBoundHalfExtents'],
};

// Internal (non-uniform) chunks: each owns a UBO block name and/or symbols
// (functions/macros) that user effects pull in via `#include`. The compiled
// glsl1 inlines these declarations; we detect them and emit the include.
const BUILTIN_INTERNAL_CHUNKS = {
  'builtin/internal/alpha-test': {
    blocks: ['ALPHA_TEST_DATA'],
    symbols: ['ALPHA_TEST'],
  },
  'builtin/internal/embedded-alpha': {
    blocks: [],
    symbols: ['CCSampleWithAlphaSeparated'],
  },
};
const BLOCK_TO_INTERNAL_CHUNK = (() => {
  const m = new Map();
  for (const [chunk, info] of Object.entries(BUILTIN_INTERNAL_CHUNKS)) {
    for (const b of info.blocks) m.set(b, chunk);
  }
  return m;
})();
const SYMBOL_TO_INTERNAL_CHUNK = (() => {
  const m = new Map();
  for (const [chunk, info] of Object.entries(BUILTIN_INTERNAL_CHUNKS)) {
    for (const s of info.symbols) m.set(s, chunk);
  }
  return m;
})();
// Reverse map: cc_name → owning chunk basename
const UNIFORM_TO_CHUNK = (() => {
  const m = new Map();
  for (const [chunk, names] of Object.entries(BUILTIN_CHUNKS)) {
    for (const n of names) m.set(n, chunk);
  }
  return m;
})();

// Match `[layout(...)] uniform [highp|mediump|lowp] <type> <name>;` (single-line).
// Only applies to non-sampler, non-block uniforms. Captures name in group 4.
const BARE_UNIFORM_RE = /^([\t ]*)(?:layout\s*\([^)]*\)\s*)?uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(\w+)\s+(\w+)\s*(?:\[[^\]]*\])?\s*;[\t ]*$/;

// Walk all passes' properties and record the authored value cardinality for
// each property name — 1 → float, 2 → vec2, 3 → vec3, 4 → vec4, 9 → mat3,
// 16 → mat4. Used to downgrade UBO members that std140 packing widened.
function collectPropertyLengths(asset) {
  const map = new Map();
  for (const tech of asset.techniques || []) {
    for (const pass of tech.passes || []) {
      const props = pass.properties || {};
      for (const [name, def] of Object.entries(props)) {
        if (def && Array.isArray(def.value)) {
          if (!map.has(name)) map.set(name, def.value.length);
        }
      }
    }
  }
  return map;
}

function lengthToGlsl(len) {
  switch (len) {
    case 1: return 'float';
    case 2: return 'vec2';
    case 3: return 'vec3';
    case 4: return 'vec4';
    case 9: return 'mat3';
    case 16: return 'mat4';
    default: return null;
  }
}

// Strip top-level `void <SYMBOL>(...) { ... }` definitions whose name is
// owned by a known internal chunk. Preserves nesting via brace-depth.
function stripInternalSymbols(src) {
  if (!SYMBOL_TO_INTERNAL_CHUNK.size) return src;
  const symbolAlt = [...SYMBOL_TO_INTERNAL_CHUNK.keys()].map(escapeRe).join('|');
  // Allow any return type before the symbol (void / vec4 / float / ...).
  const re = new RegExp(`(^|\\n)[ \\t]*\\w[\\w \\t]*\\b(${symbolAlt})\\s*\\(`, 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    const startMatch = m.index + (m[1] ? m[1].length : 0);
    // Find the matching `)` then the next `{` then walk braces to closing `}`.
    let i = re.lastIndex; // sits right after `(`
    let depth = 1;
    while (i < src.length && depth > 0) { const c = src[i++]; if (c === '(') depth++; else if (c === ')') depth--; }
    while (i < src.length && src[i] !== '{' && src[i] !== ';') i++;
    if (src[i] === ';') { // forward decl, keep walking past it
      out += src.slice(last, i + 1);
      last = i + 1; re.lastIndex = i + 1; continue;
    }
    if (src[i] !== '{') break;
    depth = 1; i++;
    while (i < src.length && depth > 0) { const c = src[i++]; if (c === '{') depth++; else if (c === '}') depth--; }
    out += src.slice(last, startMatch);
    last = i;
    re.lastIndex = i;
  }
  out += src.slice(last);
  return out;
}

// Strip `uniform <BLOCK_NAME> { ... };` inline declarations whose block name
// is owned by a known internal chunk.
function stripInternalUboBlocks(src) {
  if (!BLOCK_TO_INTERNAL_CHUNK.size) return src;
  const blockAlt = [...BLOCK_TO_INTERNAL_CHUNK.keys()].map(escapeRe).join('|');
  const re = new RegExp(`(^|\\n)[ \\t]*uniform\\s+(${blockAlt})\\s*\\{`, 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    const startMatch = m.index + (m[1] ? m[1].length : 0);
    let i = re.lastIndex; // right after `{`
    let depth = 1;
    while (i < src.length && depth > 0) { const c = src[i++]; if (c === '{') depth++; else if (c === '}') depth--; }
    // skip optional `;`
    while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
    if (src[i] === ';') i++;
    out += src.slice(last, startMatch);
    last = i;
    re.lastIndex = i;
  }
  out += src.slice(last);
  return out;
}

// Detect which internal chunks the original (pre-strip) source uses, by
// scanning for any of their owned symbol/block names.
function collectInternalChunkUses(src) {
  const used = new Set();
  for (const [name, chunk] of SYMBOL_TO_INTERNAL_CHUNK) {
    const re = new RegExp(`\\b${escapeRe(name)}\\b`);
    if (re.test(src)) used.add(chunk);
  }
  for (const [name, chunk] of BLOCK_TO_INTERNAL_CHUNK) {
    const re = new RegExp(`\\b${escapeRe(name)}\\b`);
    if (re.test(src)) used.add(chunk);
  }
  return used;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Strip the canonical `void main () { gl_Position = vert(); }` and
// `void main () { gl_FragColor = frag(); }` wrappers that the runtime
// glsl1 carries. Cocos's source-effect compiler synthesizes its own main()
// from the entry point named in `vert:`/`frag:`, so leaving ours in
// triggers "function already has a body".
function stripCocosMainWrapper(src) {
  return src.replace(/\n?\s*void\s+main\s*\(\s*\)\s*\{\s*gl_(?:Position|FragColor)\s*=\s*\w+\s*\(\s*\)\s*;\s*\}\s*/g, '\n');
}

// Names commonly defined inside the engine's `common.chunk` /
// `common-define.chunk`. When the runtime glsl1 inlines these as
// `#pragma define NAME VALUE`, the engine preprocessor performs textual
// substitution on subsequent `#ifndef NAME` etc., yielding
// `#ifndef <value>` which is invalid GLSL. Strip them — the proper
// definitions arrive via builtin chunk includes already in scope.
const COMMON_PRAGMA_DEFINES = new Set([
  'QUATER_PI', 'HALF_PI', 'PI', 'PI2', 'PI4',
  'INV_QUATER_PI', 'INV_HALF_PI', 'INV_PI', 'INV_PI2', 'INV_PI4',
  'EPSILON', 'EPSILON_LOWP', 'LOG2', 'EXP_VALUE',
  'FP_MAX', 'FP_SCALE', 'FP_SCALE_INV', 'GRAY_VECTOR',
  'LIGHT_MAP_TYPE_DISABLED', 'LIGHT_MAP_TYPE_ALL_IN_ONE',
  'LIGHT_MAP_TYPE_INDIRECT_OCCLUSION',
  'REFLECTION_PROBE_TYPE_NONE', 'REFLECTION_PROBE_TYPE_CUBE',
  'REFLECTION_PROBE_TYPE_PLANAR', 'REFLECTION_PROBE_TYPE_BLEND',
  'REFLECTION_PROBE_TYPE_BLEND_AND_SKYBOX',
  'LIGHT_TYPE_DIRECTIONAL', 'LIGHT_TYPE_SPHERE', 'LIGHT_TYPE_SPOT',
  'LIGHT_TYPE_POINT', 'LIGHT_TYPE_RANGED_DIRECTIONAL',
  'IS_DIRECTIONAL_LIGHT', 'IS_SPHERE_LIGHT', 'IS_SPOT_LIGHT',
  'IS_POINT_LIGHT', 'IS_RANGED_DIRECTIONAL_LIGHT',
  'TONE_MAPPING_ACES', 'TONE_MAPPING_LINEAR',
  'SURFACES_MAX_TRANSMIT_DEPTH_VALUE',
  'CC_SURFACES_DEBUG_VIEW_SINGLE', 'CC_SURFACES_DEBUG_VIEW_COMPOSITE_AND_MISC',
]);
function stripCommonPragmaDefines(src) {
  const lines = src.split('\n');
  const kept = [];
  // Both `#pragma define NAME ...` and the post-conversion `#define NAME ...`
  // need to be stripped — the runtime glsl1 may carry either depending on the
  // compiler version, and both pollute the engine preprocessor's macro table.
  const PRAG = /^\s*(?:#pragma\s+define|#define)\s+(\w+)\b/;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const pragMatch = ln.match(PRAG);
    if (pragMatch && COMMON_PRAGMA_DEFINES.has(pragMatch[1])) {
      continue;
    }
    // `#ifndef NAME` / `#endif` guard around a single dropped pragma.
    const guard = ln.match(/^\s*#ifndef\s+(\w+)\s*$/);
    if (guard && COMMON_PRAGMA_DEFINES.has(guard[1])) {
      // Look ahead: skip if the body is only matching defines, then #endif.
      let j = i + 1;
      while (j < lines.length && PRAG.test(lines[j])) j++;
      if (j < lines.length && /^\s*#endif\b/.test(lines[j])) {
        i = j;
        continue;
      }
    }
    kept.push(ln);
  }
  return kept.join('\n');
}

function postProcessGlsl(src, shader, propLen) {
  if (typeof src !== 'string' || !src) return src;
  const blocks = Array.isArray(shader && shader.blocks) ? shader.blocks : [];
  // Map each user-block-member name → owning block index, so we can drop
  // bare uniforms that the JSON says belong inside a block.
  const memberToBlock = new Map(); // name → blockIndex
  for (let i = 0; i < blocks.length; i++) {
    for (const m of (blocks[i].members || [])) memberToBlock.set(m.name, i);
  }
  // Mark blocks that come from a builtin internal chunk — those block
  // declarations must not be re-synthesized; the include re-supplies them.
  const skipBlockIdx = new Set();
  for (let i = 0; i < blocks.length; i++) {
    if (BLOCK_TO_INTERNAL_CHUNK.has(blocks[i].name)) skipBlockIdx.add(i);
  }

  // Pre-pass: strip inlined function bodies that belong to internal chunks
  // (the compiler embedded them into the glsl1 output). We match `void NAME(`
  // through the matching closing brace via a brace-depth counter so we
  // tolerate nested `{}` blocks.
  const stripped0 = stripInternalSymbols(src);
  // Also strip inline UBO blocks whose name is owned by an internal chunk
  // (e.g. `uniform ALPHA_TEST_DATA { ... };`) — the include re-supplies them.
  const stripped1 = stripInternalUboBlocks(stripped0);
  // Strip the trailing `void main () { gl_Position = vert(); }` /
  // `gl_FragColor = frag();` wrappers — Cocos's source compiler appends them
  // automatically, so leaving ours in produces "function already has a body".
  const stripped2 = stripCocosMainWrapper(stripped1);
  // Strip `#pragma define` lines for symbols that come from common builtin
  // chunks (PI/EPSILON/LIGHT_TYPE_*/CC_SURFACES_*). When the engine later
  // expands these macros into preprocessor directives like `#ifndef NAME`,
  // an inlined define rewrites it to `#ifndef <value>` which is a syntax
  // error. The engine's own chunks supply the real definitions.
  const stripped = stripCommonPragmaDefines(stripped2);
  const usedInternalChunks = collectInternalChunkUses(src);

  const lines = stripped.split('\n');
  const out = [];
  const usedChunks = new Set();
  for (const line of lines) {
    const m = line.match(BARE_UNIFORM_RE);
    if (m) {
      const type = m[2];
      const name = m[3];
      // Keep sampler*/image* declarations (samplers may stand alone in GLSL).
      if (/^sampler/.test(type) || /^image/.test(type)) { out.push(line); continue; }
      // Drop builtin cc_* uniforms — the include will re-supply them. Pick
      // the chunk that actually declares this name; fall back to cc-global
      // for unknown cc_* names so something gets included rather than nothing.
      if (name.startsWith('cc_')) {
        usedChunks.add(UNIFORM_TO_CHUNK.get(name) || 'cc-global');
        continue;
      }
      // Drop user uniforms that the JSON declares inside a block — a
      // synthesized `uniform <Block> { ... };` will replace them. If the
      // owning block is itself an internal-chunk block, the include covers it.
      if (memberToBlock.has(name)) continue;
    }
    // Also catch cc_* references in code (function bodies) so we still pull
    // in the chunk even when the bare-uniform pre-decl was already removed.
    const refs = line.match(/\bcc_[A-Za-z0-9_]+/g);
    if (refs) {
      for (const r of refs) {
        const chunk = UNIFORM_TO_CHUNK.get(r);
        if (chunk) usedChunks.add(chunk);
      }
    }
    out.push(line);
  }

  // Synthesize block declarations from JSON metadata. Insert them after the
  // first `precision …;` line so they appear at top-level uniform scope.
  // Skip blocks owned by internal chunks — their include re-supplies them.
  const blockDecls = blocks.map((b, i) => {
    if (skipBlockIdx.has(i)) return null;
    const members = (b.members || [])
      .map((mm) => {
        // Prefer the authored property cardinality when the compiler widened
        // a scalar/vec2/vec3 to vec4 for std140 packing. Without this, code
        // like `if (color.a < alphaThreshold) discard;` triggers EFX2406
        // because float < vec4 is a type mismatch.
        const authored = propLen && propLen.get(mm.name);
        const fromLen = authored ? lengthToGlsl(authored) : null;
        const type = fromLen || gfxTypeToGlsl(mm.type);
        const count = typeof mm.count === 'number' && mm.count > 1 ? `[${mm.count}]` : '';
        return `  ${type} ${mm.name}${count};`;
      })
      .join('\n');
    return `uniform ${b.name} {\n${members}\n};`;
  }).filter(Boolean);
  const header = [];
  // Stable order: cc-global first, then cc-local, then everything else
  // alphabetically — matches what hand-authored Cocos effects typically do.
  const ordered = [...usedChunks].sort((a, b) => {
    const order = (n) => n === 'cc-global' ? 0 : n === 'cc-local' ? 1 : 2;
    return order(a) - order(b) || a.localeCompare(b);
  });
  for (const chunk of ordered) header.push(`#include <builtin/uniforms/${chunk}>`);
  // Internal chunks (alpha-test, embedded-alpha, etc.) — include only the
  // ones actually referenced by the original (pre-strip) source.
  for (const chunk of [...usedInternalChunks].sort()) {
    header.push(`#include <${chunk}>`);
  }
  if (blockDecls.length) header.push(...blockDecls);
  if (!header.length) return out.join('\n');

  // Find precision line; otherwise prepend at top.
  let insertAt = 0;
  for (let i = 0; i < out.length; i++) {
    if (/^\s*precision\s+/.test(out[i])) { insertAt = i + 1; break; }
  }
  out.splice(insertAt, 0, ...header);
  return out.join('\n');
}

function gfxTypeToGlsl(type) {
  return GFX_TYPE[type] || 'float';
}

function indent(text, n) {
  const pad = ' '.repeat(n);
  return text.split('\n').map((l) => l ? pad + l : l).join('\n');
}

module.exports = { transformEffectAsset, isBuiltinEffect };

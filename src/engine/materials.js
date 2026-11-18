// Custom shading on top of three.js materials: sky, satellite ground, buildings with
// night-time windows, and road/rail ribbons that glow after dark.
import * as THREE from 'three';

export function skyMaterial(U) {
  return new THREE.ShaderMaterial({
    uniforms: { uSun: { value: new THREE.Vector3(0, 1, 0) }, uTime: U.uTime },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w * 0.99999; }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSun; uniform float uTime; varying vec3 vDir;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main() {
        vec3 d = normalize(vDir); float h = d.y; float el = uSun.y;
        float day = smoothstep(-0.04, 0.28, el), night = 1.0 - smoothstep(-0.22, -0.03, el);
        float dusk = clamp(1.0 - day - night, 0.0, 1.0);
        vec2 sxz = normalize(uSun.xz + 1e-5), dxz = normalize(d.xz + 1e-5);
        float toward = 0.5 + 0.5 * dot(sxz, dxz);
        vec3 zen = vec3(0.24, 0.42, 0.70) * day + vec3(0.10, 0.13, 0.30) * dusk + vec3(0.004, 0.006, 0.016) * night;
        vec3 hor = vec3(0.76, 0.77, 0.77) * day + mix(vec3(0.45, 0.36, 0.42), vec3(1.0, 0.52, 0.26), toward) * dusk
                 + vec3(0.05, 0.05, 0.07) * night;
        hor = mix(hor, vec3(1.0, 0.75, 0.5), day * (1.0 - smoothstep(0.05, 0.35, el)) * toward * 0.6);
        float t = pow(1.0 - clamp(h, 0.0, 1.0), 3.0);
        vec3 col = mix(zen, hor, t);
        col += vec3(0.10, 0.06, 0.035) * pow(1.0 - clamp(h, 0.0, 1.0), 12.0) * night;
        if (h < 0.0) col = hor * 0.85;
        float sd = dot(d, normalize(uSun));
        col += vec3(1.0, 0.85, 0.6) * pow(max(sd, 0.0), 300.0) * 1.5 * (1.0 - night);
        col += vec3(1.0, 0.95, 0.85) * smoothstep(0.99955, 0.9998, sd) * 30.0 * (1.0 - night);
        if (night > 0.0 && h > 0.02) {
          float s = hash(floor(d * 420.0));
          if (s > 0.9975) col += vec3(0.8, 0.85, 1.0) * night * (0.4 + 0.6 * sin(uTime * 2.0 + s * 900.0)) * smoothstep(0.02, 0.2, h);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide, depthWrite: false, depthTest: false,
  });
}

export function groundMaterial(map, aux, U) {
  // aux texture channels: r = street lights, g = water, b = shading around buildings
  const m = new THREE.MeshLambertMaterial({ map });
  m.userData.perTile = true;
  m.userData.aux = aux;
  m.customProgramCacheKey = () => 'hyd-ground-14';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uAux: { value: aux }, uNight: U.uNight, uSunView: U.uSunView, uTime: U.uTime, uSkyH: U.uSkyH, uSkyZ: U.uSkyZ });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGW;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\n vGW = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uAux; uniform float uNight; uniform float uTime; uniform vec3 uSunView; uniform vec3 uSkyH; uniform vec3 uSkyZ; varying vec2 vGW;
        float gh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(gh(i), gh(i + vec2(1, 0)), f.x), mix(gh(i + vec2(0, 1)), gh(i + vec2(1, 1)), f.x), f.y); }
        // water waves: twelve travelling sine waves from scattered directions and sizes (deep-water speeds), so no regular rows appear
        // x = height, yz = slope (world x/z)
        vec3 waves(vec2 p, float t, float fw) {
          vec3 r = vec3(0.0);
          p += vec2(gn(p * 0.07 + 3.0 + t * 0.03), gn(p * 0.07 + 11.0 - t * 0.03)) * 5.0;
          for (int i = 0; i < 12; i++) {
            float fi = float(i), ang = fi * 2.399 + 0.5, k = 0.35 * pow(1.4, fi);
            vec2 d = vec2(cos(ang), sin(ang));
            float a = 0.05 * pow(k, -0.85) * (1.0 - smoothstep(0.35, 1.0, k * fw));   // a wave smaller than a few pixels fades out (no shimmer)
            float ph = dot(d, p) * k + t * sqrt(9.8 * k) * 0.45 + fi * 1.7;
            r.x += a * sin(ph);
            r.yz += d * (a * k * cos(ph));
          }
          return r;
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 mk = texture2D(uAux, vMapUv).rgb;
        // gentle grade: Sentinel-2 colours are deep and saturated; pull toward a warm, hazy daylight look
        float lg = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        float built = smoothstep(0.0, 0.35, mk.b);                       // near buildings: pale, clean urban ground like a street map
        vec3 urban = vec3(lg * 0.55 + 0.46) * vec3(1.02, 1.0, 0.95);
        diffuseColor.rgb = mix(vec3(lg), diffuseColor.rgb, 0.78) * vec3(1.14, 1.09, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, urban, built * 0.6);
        float gr = diffuseColor.g - max(diffuseColor.r, diffuseColor.b) * 0.92;           // keep real greens (parks, trees) alive
        float bare = 1.0 - smoothstep(0.0, 0.06, gr);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.66, 0.62, 0.55) * (0.8 + 0.4 * lg), bare * 0.45);   // flatten blotchy bare earth
        diffuseColor.rgb *= 1.0 - 0.3 * mk.b;
        // water: clear teal with soft depth patches, a pale shallow rim at the shore and moving ripples
        float wet = smoothstep(0.35, 0.65, mk.g);
        float wfade = fwidth(vGW.x);                            // small waves fade out with distance (no shimmer)
        vec3 wvG = vec3(0.0);                                                                // wave height and slope, worked out once and used by the shading below
        if (wet > 0.0) wvG = waves(vGW, uTime, wfade);
        if (wet > 0.0) {
          float dp = gn(vGW * 0.012) * 0.6 + gn(vGW * 0.05 + 7.0) * 0.4;
          vec3 deep = vec3(0.03, 0.11, 0.14), shallow = vec3(0.10, 0.24, 0.22);          // dark body; the sky reflection on top gives the colour
          vec3 wc = mix(vec3(0.06, 0.17, 0.19), mix(shallow, deep, smoothstep(0.2, 0.8, dp)), 0.6);
          float rim = 1.0 - smoothstep(0.55, 1.0, mk.g);                                  // only near the shore line
          wc = mix(wc, vec3(0.38, 0.44, 0.38), rim * 0.4);
          float rip = gn(vGW * 0.9 + vec2(uTime * 0.35, uTime * 0.2)) * 0.6 + gn(vGW * 2.3 - vec2(uTime * 0.25, 0.0)) * 0.4;
          wc *= 0.98 + 0.04 * rip;
          vec3 wv = wvG;
          wc *= 1.0 + clamp(wv.x * 1.8, -0.35, 0.3);                                                        // crests catch light, troughs go darker
          diffuseColor.rgb = mix(diffuseColor.rgb, wc, wet * 0.95);
        }
        // close-up grain so the 10 m imagery does not look smeared underfoot
        float fw = fwidth(vGW.x);
        float grain = (gn(vGW * 0.35) - 0.5) * 0.10 + (gn(vGW * 1.7) - 0.5) * 0.08 * (1.0 - smoothstep(0.5, 3.0, fw));
        diffuseColor.rgb *= 1.0 + grain;`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        {
          vec3 vdir = normalize(vViewPosition);
          vec2 rp = vMapUv * 3000.0;
          vec3 wn = normalize(normal + vec3(sin(rp.x + uTime * 1.3) * 0.03, 0.0, cos(rp.y * 1.1 + uTime) * 0.03));
          if (mk.g > 0.35) {                              // real moving slopes on water: sun glitter that travels with the waves
            vec3 wv2 = wvG;
            wn = normalize(normal + (viewMatrix * vec4(-wv2.y, 0.0, -wv2.z, 0.0)).xyz * 0.85);
          }
          float spec = pow(max(dot(reflect(-uSunView, wn), vdir), 0.0), 90.0);
          totalEmissiveRadiance += vec3(1.0, 0.9, 0.75) * spec * mk.g * 2.2 * (1.0 - uNight);
          if (mk.g > 0.05) {                              // the water mirrors the sky: stronger toward the horizon, broken up by the moving waves
            vec3 up = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
            vec3 rr = reflect(-vdir, wn);
            vec3 sk = mix(uSkyH, uSkyZ, clamp(dot(rr, up) * 1.6, 0.0, 1.0));
            float nv = clamp(dot(wn, vdir), 0.0, 1.0);
            float fr = clamp(0.04 + 0.96 * pow(1.0 - nv, 4.5), 0.0, 1.0);
            totalEmissiveRadiance += sk * fr * smoothstep(0.1, 0.6, mk.g) * 0.42;
          }
          totalEmissiveRadiance += vec3(1.0, 0.56, 0.2) * uNight * (mk.r * 0.0 + mk.b * 0.07);
        }`);
  };
  return m;
}

export function buildingMaterial(U, atlas) {
  // Walls sample the procedural facade atlas (see textures.js) using per-vertex facade
  // coordinates: uv.x = style code * 1000 + bays along the wall, uv.y = floors above ground.
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uNight: U.uNight, uSkyH: U.uSkyH, uSkyZ: U.uSkyZ, uFacade: { value: atlas.color }, uFacadeMask: { value: atlas.mask } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP; varying vec2 vFUv; varying vec3 vWN;')
      .replace('#include <fog_vertex>', `#include <fog_vertex>
        vWP = (modelMatrix * vec4(transformed, 1.0)).xyz; vFUv = uv; vWN = normalize(mat3(modelMatrix) * objectNormal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight; uniform vec3 uSkyH; uniform vec3 uSkyZ; uniform sampler2D uFacade; uniform sampler2D uFacadeMask; varying vec3 vWP; varying vec2 vFUv; varying vec3 vWN;
        float skyRefl = 0.0; vec3 skyCol = vec3(0.0);
        float hsh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float glass = 0.0, sign = 0.0, lit = 0.0; vec3 tint = vec3(1.0);
        if (vFUv.x >= 0.0) {
          float code = floor(vFUv.x / 1000.0);
          float style = mod(code, 6.0), noShop = step(6.0, code);
          vec2 p = vec2(vFUv.x - code * 1000.0, vFUv.y);
          vec2 cell = fract(p), id = floor(p) + floor(vWP.xz / 61.0) * 17.0;
          float row = (p.y < 1.0 && noShop < 0.5) ? 0.0 : 1.0;
          vec2 auv = vec2((style + cell.x) / 6.0, (row + cell.y) / 2.0);
          vec2 gx = dFdx(p) / vec2(6.0, 2.0), gy = dFdy(p) / vec2(6.0, 2.0);
          vec3 mul = textureGrad(uFacade, auv, gx, gy).rgb;
          vec2 mk = textureGrad(uFacadeMask, auv, gx, gy).rg;
          glass = mk.r; sign = mk.g;
          float h = hsh(id);
          bool office = (style > 1.5 && style < 2.5) || (style > 3.5 && style < 4.5);
          // interiors: mostly dark glass, a minority with muted curtains or blinds
          vec3 curtain = mix(vec3(0.52, 0.47, 0.40), vec3(0.66, 0.65, 0.62), hsh(id + 1.3)) * (0.7 + 0.35 * hsh(id + 5.1));
          vec3 dark = vec3(0.045, 0.055, 0.07) * (0.7 + 0.8 * hsh(id + 3.1));
          vec3 interior = h > (office ? 0.9 : 0.72) ? curtain : dark;
          vec3 wall = diffuseColor.rgb * mul;
          // weathering: dirt near street level, rain streaks under sills, patchy large-scale tone
          float base = mix(0.72, 1.0, smoothstep(0.0, 2.2, vFUv.y));
          float streak = 1.0 - 0.14 * hsh(vec2(id.x, 9.7)) * smoothstep(0.55, 0.0, cell.y);
          float tone = 0.93 + 0.12 * hsh(floor(p * vec2(0.35, 0.28)) + floor(vWP.xz / 23.0));
          wall *= base * streak * tone;
          wall *= 1.0 - 0.2 * (1.0 - smoothstep(0.0, 0.08, cell.y));                    // projecting floor slab edge
          wall *= 1.0 + 0.05 * smoothstep(0.9, 1.0, cell.y);                           // lit lip under the next slab
          wall *= 1.0 - 0.07 * smoothstep(0.88, 1.0, cell.x) - 0.07 * (1.0 - smoothstep(0.0, 0.12, cell.x));   // column strips between bays
          diffuseColor.rgb = mix(wall, interior, glass * 0.95);
          // sky reflection in glass: fresnel + slight vertical gradient (added as emission so it survives shadow)
          vec3 V = normalize(vWP - cameraPosition), N = normalize(vWN);
          float fr = pow(1.0 - clamp(dot(-V, N), 0.0, 1.0), 3.0);
          vec3 R = reflect(V, N);
          skyCol = mix(uSkyH, uSkyZ, clamp(R.y * 1.6, 0.0, 1.0));
          skyRefl = glass * (office ? 0.85 : 0.34) * (0.35 + 0.65 * fr) * (0.85 + 0.3 * smoothstep(0.0, 30.0, vFUv.y));
          lit = step(hsh(id * 1.71 + 0.3), 0.33);
          tint = mix(vec3(1.0, 0.68, 0.38), vec3(0.85, 0.92, 1.0), step(0.8, hsh(id + 9.1)));
          if (office) { lit = step(hsh(vec2(id.y, floor(id.x / 4.0))), 0.28); tint = vec3(0.85, 0.92, 1.0); }
        } else {
          // flat terrace: slab joints every 1.6 m, patchy waterproofing and stains
          vec2 rq = vWP.xz / 1.6, rf = abs(fract(rq) - 0.5);
          float joint = smoothstep(0.46, 0.5, max(rf.x, rf.y));
          float n = hsh(floor(vWP.xz / 2.5)), blot = hsh(floor(vWP.xz / 7.0) + 3.0), stain = hsh(floor(vWP.xz / 1.3) + 11.0);
          diffuseColor.rgb *= (0.86 + 0.14 * n) * (1.0 - 0.07 * joint) * (blot > 0.85 ? 0.9 : 1.0) * (0.96 + 0.04 * stain);
        }`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        totalEmissiveRadiance += (tint * glass * lit * 0.6 + diffuseColor.rgb * sign * 1.0) * uNight + skyCol * skyRefl;`);
  };
  return m;
}

export function roadMaterial(map, U, order, glow = 0.0) {
  const m = new THREE.MeshLambertMaterial({ map, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 - order * 2 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.62, 0.28) * uNight * ${glow.toFixed(2)};   // sodium street lights`);
  };
  return m;
}

// Vertex-coloured paint / kerb material that picks up the same sodium glow at night as the roads.
export function paintMaterial(U, glow, offset) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: offset[0], polygonOffsetUnits: offset[1] });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        totalEmissiveRadiance += (vec3(1.0, 0.62, 0.28) * 0.5 + diffuseColor.rgb * 0.5) * uNight * ${glow.toFixed(2)};`);
  };
  return m;
}

// Street lamp: dark pole, warm head that lights up at night (head vertices are the bright ones).
export function lampMaterial(U) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        totalEmissiveRadiance += step(0.8, diffuseColor.r) * vec3(1.0, 0.72, 0.38) * uNight * 2.2;`);
  };
  return m;
}

// Soft warm pool of light on the ground under each lamp (additive, fades with distance, off by day).
export function poolMaterial(U) {
  return new THREE.ShaderMaterial({
    uniforms: { uNight: U.uNight },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -30,
    vertexShader: `varying vec2 vP; varying float vD;
      void main() { vP = position.xz; vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0); vD = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uNight; varying vec2 vP; varying float vD;
      void main() {
        float r = length(vP); if (r > 1.0) discard;
        float a = pow(1.0 - r, 1.7) * (1.0 - smoothstep(500.0, 1400.0, vD)) * uNight;
        gl_FragColor = vec4(vec3(1.0, 0.58, 0.24) * a * 0.42, 1.0);
      }`,
  });
}

export function glowMaterial(U, glow, strength, extra = {}) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, ...extra });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n totalEmissiveRadiance += vec3(${glow.map((v) => v.toFixed(3)).join(',')}) * uNight * ${strength.toFixed(3)};`);
  };
  return m;
}

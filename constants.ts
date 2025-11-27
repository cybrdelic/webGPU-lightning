

export const BOILERPLATE_SHADER_WGSL = `
struct Uniforms {
  resolution: vec2f,
  // 8 bytes
  time: f32,
  dt: f32,
  // 16 bytes (Aligned)
  cameraPos: vec4f,
  // 32 bytes (Aligned)
  mouse: vec4f, // xy = coords, z = click, w = scroll
  
  // -- Params Start at Offset 48 --
  animSpeed: f32,       // 48 (Index 12)
  detail: f32,          // 52 (Index 13)
  vignette: f32,        // 56 (Index 14)
  metallic: f32,        // 60 (Index 15)
  
  baseColor: vec4f,     // 64 (Index 16-19) - ALIGN 16
  
  grainStrength: f32,   // 80 (Index 20)
  lightAz: f32,         // 84 (Index 21)
  lightEl: f32,         // 88 (Index 22)
  isRendering: f32,     // 92 (Index 23)
  
  aberrationStrength: f32, // 96 (Index 24)
  electricSpeed: f32,      // 100 (Index 25)
  electricIntensity: f32,  // 104 (Index 26)
  
  // WebGPU Implicitly pads to 112 to align vec4f
  
  electricColor: vec4f,    // 112 (Index 28-31) - ALIGN 16
  
  audio: vec4f,            // 128 (Index 32-35) - ALIGN 16
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var channel0: texture_2d<f32>;
@group(0) @binding(2) var sampler0: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var pos = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );

  var output: VertexOutput;
  output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  output.uv = pos[vertexIndex] * 0.5 + 0.5;
  return output;
}

// --- CONSTANTS ---
const PI = 3.14159265359;
const EPSILON = 0.0001; 

// --- UTILS ---
fn rotate(p: vec3f, angle: f32, axis: vec3f) -> vec3f {
    let a = normalize(axis);
    let s = sin(angle);
    let c = cos(angle);
    let r = 1.0 - c;
    let m = mat3x3f(
        a.x*a.x*r+c,     a.y*a.x*r-a.z*s, a.z*a.x*r+a.y*s,
        a.x*a.y*r+a.z*s, a.y*a.y*r+c,     a.z*a.y*r-a.x*s,
        a.x*a.z*r-a.y*s, a.y*a.z*r+a.x*s, a.z*a.z*r+c
    );
    return m * p;
}

// 3D Noise
fn hash(p: vec3f) -> f32 {
    let p3 = fract(p * 0.1031);
    let d = dot(p3, vec3f(p3.y + 19.19, p3.z + 19.19, p3.x + 19.19));
    return fract((p3.x + p3.y) * p3.z + d); 
}

fn noise(p: vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(mix(hash(i + vec3f(0,0,0)), hash(i + vec3f(1,0,0)), u.x),
            mix(hash(i + vec3f(0,1,0)), hash(i + vec3f(1,1,0)), u.x), u.y),
        mix(mix(hash(i + vec3f(0,0,1)), hash(i + vec3f(1,0,1)), u.x),
            mix(hash(i + vec3f(0,1,1)), hash(i + vec3f(1,1,1)), u.x), u.y), u.z
    );
}

// Standard FBM for Surfaces
fn fbm(p: vec3f) -> f32 {
    var val = 0.0;
    var amp = 0.5;
    var pp = p;
    for(var i=0; i<4; i++) {
        val += amp * noise(pp);
        pp *= 2.02;
        amp *= 0.5;
    }
    return val;
}

// CHAOTIC ARC NOISE
// Uses opposing octave drifts to prevent "flowing water" look.
// Returns a ridged pattern that writhes in place.
fn sparkNoise(p: vec3f, t: f32) -> f32 {
    var val = 0.0;
    var amp = 1.0;
    var pp = p;
    
    // 3 Octaves of chaotic motion
    for(var i=0; i<3; i++) {
        // Each octave moves in a different direction
        let drift = vec3f(
            sin(t * 0.5 + f32(i)), 
            t * (1.0 + f32(i) * 0.5), 
            cos(t * 0.3 + f32(i) * 2.0)
        );
        
        // Ridged Noise: abs(n - 0.5) creates sharp "veins"
        let n = noise(pp + drift);
        val += amp * abs(n - 0.5); 
        
        pp = pp * 2.1 + vec3f(4.03, 1.2, 9.1); 
        amp *= 0.5;
    }
    // Remap to emphasize the sharp ridges
    return 1.0 - (val * 1.5); 
}

// --- FRACTAL GEOMETRY ---
fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn sdFractal(p: vec3f) -> f32 {
    let warp = u.audio.y * 0.2;
    var z = p;
    
    // Rotate the entire fractal domain over time
    z = rotate(z, u.time * u.animSpeed * 0.05, vec3f(0.0, 1.0, 0.0));
    z = rotate(z, u.time * u.animSpeed * 0.02, vec3f(1.0, 0.0, 1.0));
    
    var scale = 1.0;
    let iter = 4;
    var trap = 1000.0;
    
    // KIFS / Menger-like Fold
    for(var i = 0; i < iter; i++) {
        z = abs(z);
        if(z.x < z.y) { let t = z.x; z.x = z.y; z.y = t; }
        if(z.x < z.z) { let t = z.x; z.x = z.z; z.z = t; }
        if(z.y < z.z) { let t = z.y; z.y = z.z; z.z = t; }
        
        z = z * 2.0 - 1.2 * (u.detail * 0.5 + 0.5); 
        z.z += sin(z.x * 2.0 + u.time) * warp * 0.05;
        scale *= 2.0;
        trap = min(trap, length(z));
    }
    
    let boxDist = sdBox(z, vec3f(1.2, 1.2, 4.0)) / scale;
    let sphereDist = (length(z) - 2.5) / scale;
    
    return max(boxDist, sphereDist);
}

fn map(p: vec3f) -> vec2f {
    let finalObj = sdFractal(p) - 0.01; 
    
    let floorHeight = -2.2;
    let floorDist = p.y - floorHeight;
    
    if (finalObj < floorDist) {
        return vec2f(finalObj, 1.0); 
    }
    return vec2f(floorDist, 2.0); 
}

fn calcNormal(p: vec3f) -> vec3f {
    let e = vec2f(EPSILON, 0.0);
    return normalize(vec3f(
        map(p + e.xyy).x - map(p - e.xyy).x,
        map(p + e.yxy).x - map(p - e.yxy).x,
        map(p + e.yyx).x - map(p - e.yyx).x
    ));
}

fn getAO(p: vec3f, n: vec3f) -> f32 {
    var occ = 0.0;
    var sca = 1.0;
    for(var i = 0; i < 5; i++) {
        let h = 0.01 + 0.12 * f32(i) / 4.0;
        let d = map(p + h * n).x;
        occ += (h - d) * sca;
        sca *= 0.95;
    }
    return clamp(1.0 - 3.0 * occ, 0.0, 1.0) * (0.5 + 0.5 * n.y);
}

fn getShadow(ro: vec3f, rd: vec3f, tmin: f32, tmax: f32, k: f32) -> f32 {
    var res = 1.0;
    var t = tmin;
    for(var i = 0; i < 32; i++) {
        let h = map(ro + rd * t).x;
        res = min(res, k * h / t);
        t += clamp(h, 0.002, 0.2); 
        if(res < 0.001 || t > tmax) { break; }
    }
    return clamp(res, 0.0, 1.0);
}

// --- PBR MATH ---
fn distributionGGX(N: vec3f, H: vec3f, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let NdotH2 = NdotH * NdotH;
    let num = a2;
    var denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;
    return num / max(denom, 0.00001);
}

fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
    let r = (roughness + 1.0);
    let k = (r * r) / 8.0;
    let num = NdotV;
    let denom = NdotV * (1.0 - k) + k;
    return num / max(denom, 0.00001);
}

fn geometrySmith(N: vec3f, V: vec3f, L: vec3f, roughness: f32) -> f32 {
    let NdotV = max(dot(N, V), 0.0);
    let NdotL = max(dot(N, L), 0.0);
    let ggx2 = geometrySchlickGGX(NdotV, roughness);
    let ggx1 = geometrySchlickGGX(NdotL, roughness);
    return ggx1 * ggx2;
}

fn fresnelSchlick(cosTheta: f32, F0: vec3f) -> vec3f {
    return F0 + (vec3f(1.0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn getSky(rd: vec3f) -> vec3f {
    var col = mix(vec3f(0.01, 0.015, 0.02), vec3f(0.05, 0.05, 0.06), rd.y * 0.5 + 0.5);
    
    // Key
    let kPos = normalize(vec3f(-0.5, 0.8, 0.5));
    let kSpec = max(dot(rd, kPos), 0.0);
    col += vec3f(2.0, 2.1, 2.3) * smoothstep(0.9, 0.99, kSpec) * 4.0;
    
    // Rim
    let rPos = normalize(vec3f(0.0, 0.5, -1.0));
    let rSpec = max(dot(rd, rPos), 0.0);
    col += vec3f(3.0) * pow(rSpec, 100.0) * 2.0;

    return col;
}

fn renderPBR(p: vec3f, n: vec3f, v: vec3f, baseColor: vec3f, metallic: f32, roughness: f32, ao: f32) -> vec3f {
    var F0 = vec3f(0.04); 
    F0 = mix(F0, baseColor, metallic);
    var Lo = vec3f(0.0);
    
    let lights = array<vec4f, 3>(
        vec4f(-2.0, 5.0, 3.0, 10.0), 
        vec4f(5.0, 2.0, -3.0, 5.0),  
        vec4f(0.0, 4.0, -5.0, 8.0)   
    );
    let lCols = array<vec3f, 3>(
        vec3f(1.0, 0.95, 0.9),
        vec3f(0.8, 0.85, 1.0),
        vec3f(1.0, 1.0, 1.0)
    );

    for(var i=0; i<3; i++) {
        let lPos = lights[i].xyz;
        let lPower = lights[i].w;
        let lCol = lCols[i];
        
        let Lvector = lPos - p;
        let dist = length(Lvector);
        let L = normalize(Lvector);
        let H = normalize(v + L);
        
        let attenuation = 1.0 / (dist * dist);
        let radiance = lCol * lPower * attenuation;
        
        var shadow = 1.0;
        if(i == 0) {
            shadow = getShadow(p + n * 0.01, L, 0.05, dist, 16.0);
        }
        
        let NDF = distributionGGX(n, H, roughness);
        let G = geometrySmith(n, v, L, roughness);
        let F = fresnelSchlick(max(dot(H, v), 0.0), F0);
        
        let num = NDF * G * F;
        let den = 4.0 * max(dot(n, v), 0.0) * max(dot(n, L), 0.0) + 0.0001;
        let specular = num / den;
        
        let kS = F;
        var kD = vec3f(1.0) - kS;
        kD *= (1.0 - metallic);
        
        let NdotL = max(dot(n, L), 0.0);
        Lo += (kD * baseColor / PI + specular) * radiance * NdotL * shadow;
    }
    
    // IBL
    let kS = fresnelSchlick(max(dot(n, v), 0.0), F0);
    let kD = (vec3f(1.0) - kS) * (1.0 - metallic);
    let irradiance = getSky(n) * 0.15;
    let diffuse = irradiance * baseColor;
    let r = reflect(-v, n);
    let reflection = getSky(r); 
    let specIBL = reflection * (1.0 - roughness); 
    let ambient = (kD * diffuse + specIBL * kS) * ao;
    
    return Lo + ambient;
}

fn raymarch(ro: vec3f, rd: vec3f) -> vec3f {
    var t = 0.0;
    var m = -1.0;
    var hit = false;
    
    for(var i = 0; i < 160; i++) { 
        let pos = ro + rd * t;
        let h = map(pos);
        
        if(h.x < EPSILON) {
            m = h.y;
            hit = true;
            break;
        }
        
        if(t > 30.0) { break; }
        t += h.x * 0.7; 
    }
    
    if (hit) {
        return vec3f(t, m, 1.0); 
    } else {
        return vec3f(t, -1.0, 0.0); 
    }
}

// ARCING ELECTRICITY LOGIC
fn getGlow(ro: vec3f, rd: vec3f, maxT: f32) -> vec3f {
    var acc = vec3f(0.0);
    
    // Continuous time variable for smooth but rapid motion
    // Multiplied by speed to control chaos rate
    let tParams = u.time * u.electricSpeed * 2.0;
    
    // Raymarch the volume
    var t = 0.5;
    let tEnd = min(maxT, 15.0);
    
    // Dithering to break banding
    t += hash(rd * u.time) * 0.2;
    
    for(var i=0; i<35; i++) {
        if(t > tEnd) { break; }
        let pos = ro + rd * t;
        
        // Only evaluate if near surface to save perf
        let geoD = sdFractal(pos);
        
        if (geoD < 0.4) {
            // Evaluates chaotic noise field at this position
            let noiseVal = sparkNoise(pos * 3.5, tParams);
            
            // "Arc Shell"
            // We want the region where the noise field crosses a specific threshold.
            // Since sparkNoise returns 0..1 (roughly), we look for a narrow band.
            let distToLine = abs(noiseVal - 0.4);
            
            // Physics: Inverse Square Falloff with Epsilon
            let intensity = 0.0003 / (distToLine * distToLine * distToLine + 0.000001);
            
            // Masking:
            // 1. Must be close to surface (geoD)
            // 2. Animated Branching Mask to create breaks/segments in the arc
            // We animate this mask too so gaps don't stay static.
            let branchMask = smoothstep(0.35, 0.55, noise(pos * 4.0 + vec3f(0.0, tParams * 0.5, 0.0)));
            
            // Thermal Core Color
            let heat = smoothstep(5.0, 60.0, intensity);
            let color = mix(u.electricColor.rgb, vec3f(1.0, 1.0, 1.0), heat);
            
            let surfaceFade = smoothstep(0.3, 0.0, geoD);
            
            acc += color * intensity * surfaceFade * branchMask * u.electricIntensity * 0.002;
        }
        
        t += 0.15;
    }
    
    return acc;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    let ro = u.cameraPos.xyz;
    let ta = vec3f(0.0, -0.5, 0.0);
    let ww = normalize(ta - ro);
    let uu = normalize(cross(ww, vec3f(0.0, 1.0, 0.0)));
    let vv = normalize(cross(uu, ww));
    
    var finalColor = vec3f(0.0);
    var aaSamples = 1;
    if (u.isRendering > 0.5) { aaSamples = 2; }
    
    for (var i = 0; i < aaSamples; i++) {
        var offset = vec2f(0.0);
        if (aaSamples > 1) {
             let r1 = fract(sin(f32(i)*12.9898 + uv.x) * 43758.5453);
             let r2 = fract(cos(f32(i)*4.1414 + uv.y) * 53211.5543);
             offset = (vec2f(r1, r2) - 0.5) / u.resolution;
        }
        
        let p = (-u.resolution + 2.0 * (uv + offset) * u.resolution) / u.resolution.y;
        let rd = normalize(p.x * uu + p.y * vv + 2.0 * ww);
        
        let res = raymarch(ro, rd);
        let t = res.x;
        let m = res.y;
        let hit = res.z;
        
        var col = getSky(rd) * 0.05; 
        
        if (hit > 0.5) {
            let pos = ro + rd * t;
            var nor = calcNormal(pos);
            let view = -rd;
            
            var albedo = u.baseColor.rgb;
            var roughness = u.detail; 
            var metallic = u.metallic;
            var ao = getAO(pos, nor);
            
            let micro = fbm(pos * 8.0);
            
            if (m > 1.5) { 
                // Floor
                let f = fbm(pos * 2.0);
                albedo = vec3f(0.05) + f * 0.02;
                roughness = 0.3 + f * 0.2;
                metallic = 0.0;
                let bump = normalize(vec3f(fbm(pos*10.0), 0.5, fbm(pos*10.0 + 1.0)));
                nor = normalize(nor + bump * 0.05);
                let falloff = exp(-length(pos.xz) * 0.1);
                roughness = mix(roughness, 1.0, 1.0 - falloff);
                
                // Reflections of lightning on floor
                let tParams = u.time * u.electricSpeed * 2.0;
                let sparkN = sparkNoise(pos * 3.5, tParams);
                let arcVal = abs(sparkN - 0.4);
                let electricGlow = 0.0003 / (arcVal * arcVal * arcVal + 0.00001);
                albedo += u.electricColor.rgb * electricGlow * u.electricIntensity * 0.02;
                
            } else {
                // Fractal
                let curv = clamp(1.0 - ao, 0.0, 1.0);
                albedo = mix(albedo, vec3f(0.8, 0.7, 0.5), micro * 0.2); 
                roughness = mix(roughness, 0.8, curv); 
                metallic = mix(metallic, 0.0, curv * 0.5); 
                let scratches = noise(pos * 50.0 * vec3f(1.0, 10.0, 1.0));
                roughness += scratches * 0.1;
                let noiseN = fbm(pos * 20.0);
                nor = normalize(nor + vec3f(noiseN) * 0.02);
            }

            col = renderPBR(pos, nor, view, albedo, metallic, roughness, ao);
            
            // Reflections
            if (u.isRendering > 0.5 && roughness < 0.5) {
                 let rDir = reflect(rd, nor);
                 let refRes = raymarch(pos + nor * 0.05, rDir);
                 if (refRes.z > 0.5) {
                     let rPos = pos + nor * 0.05 + rDir * refRes.x;
                     let rNor = calcNormal(rPos);
                     let rAO = getAO(rPos, rNor);
                     let rLight = renderPBR(rPos, rNor, -rDir, u.baseColor.rgb, u.metallic, 0.5, rAO);
                     let F0 = mix(vec3f(0.04), albedo, metallic);
                     let F = fresnelSchlick(max(dot(nor, view), 0.0), F0);
                     col = mix(col, rLight, F * (1.0 - roughness));
                 }
            }
            col = mix(col, vec3f(0.01, 0.015, 0.02), 1.0 - exp(-0.02 * t * t));
        }
        
        // --- ADD ELECTRICITY GLOW ---
        if (u.electricIntensity > 0.01) {
            let electricity = getGlow(ro, rd, t);
            col += electricity;
        }

        finalColor += col;
    }
    
    finalColor /= f32(aaSamples);
    
    // Post
    let q = uv;
    finalColor *= 0.5 + 0.5 * pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), u.vignette);
    
    let noiseG = fract(sin(dot(uv * u.resolution, vec2f(12.9898, 78.233) * u.time)) * 43758.5453);
    finalColor += (noiseG - 0.5) * u.grainStrength;
    
    // ACES Tone Mapping
    let exposed = finalColor * 1.5;
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    finalColor = clamp((exposed * (a * exposed + b)) / (exposed * (c * exposed + d) + e), vec3f(0.0), vec3f(1.0));
    finalColor = pow(finalColor, vec3f(1.0 / 2.2));
    
    return vec4f(finalColor, 1.0);
}
`
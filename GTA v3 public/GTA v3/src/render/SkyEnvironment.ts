import * as THREE from 'three';
import { solarState } from '../game/dayNight';

const vertexShader = `
varying vec3 vDirection;
void main() {
  vDirection = position;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = clip.xyww;
}`;

const fragmentShader = `
uniform vec3 zenith, horizon, sunDirection, moonDirection;
uniform float daylight, night, twilight, windTime;
varying vec3 vDirection;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + 1.0), f.x), f.y);
}
float fbm(vec2 p) {
  float n = 0.0, a = .55;
  mat2 turn = mat2(.8, -.6, .6, .8);
  for(int i = 0; i < 5; i++) { n += a * noise(p); p = turn * p * 2.03 + 13.7; a *= .48; }
  return n;
}
void main() {
  vec3 ray = normalize(vDirection);
  float height = max(ray.y, 0.0);
  vec3 color = mix(horizon, zenith, pow(height, .48));
  float towardSun = max(dot(ray, sunDirection), 0.0);
  float horizonBand = exp(-height * 8.0);
  color += vec3(.65, .13, .025) * twilight * horizonBand * pow(towardSun, 3.0);
  color = mix(color, horizon * .75, 1.0-smoothstep(-.35, 0.0, ray.y));

  // Sparse, subpixel-soft stars; the same celestial coordinates wrap at midnight.
  vec2 starCoord = vec2(atan(ray.z, ray.x) / 6.2831853 + .5, asin(clamp(ray.y,-1.0,1.0)) / 3.14159265 + .5) * vec2(720.,360.);
  vec2 cell = floor(starCoord), local = fract(starCoord);
  float seed = hash(cell);
  vec2 center = vec2(hash(cell + 2.7), hash(cell + 9.2)) * .6 + .2;
  float star = exp(-dot(local-center,local-center) * mix(170.,460.,seed));
  star *= step(.989, seed) * night * smoothstep(.015,.24,height);
  color += vec3(.78,.87,1.0) * star * (1.1 + .25 * sin(windTime * .8 + seed * 100.));

  float sunDot = dot(ray, sunDirection);
  float sunVisible = smoothstep(-.04,.015,sunDirection.y);
  float sunDisc = smoothstep(cos(.017), cos(.0135), sunDot);
  color += vec3(1.0,.69,.3) * exp((sunDot-1.0)*110.) * .55 * sunVisible;
  color += mix(vec3(4.0,1.2,.25),vec3(5.0,4.3,2.9),daylight) * sunDisc * sunVisible;

  vec3 moonEast = normalize(cross(vec3(0,1,0), moonDirection));
  vec3 moonNorth = cross(moonDirection,moonEast);
  vec2 moonUV = vec2(dot(ray,moonEast),dot(ray,moonNorth)) / .022;
  float moonR = dot(moonUV,moonUV);
  float moonDisc = (1.0-smoothstep(.91,1.0,moonR)) * step(.99,dot(ray,moonDirection));
  float relief = .72 + .28 * noise(moonUV*10.0+31.0) - .2*noise(moonUV*4.0+7.0);
  float moonShade = max(.13,dot(normalize(vec3(moonUV,sqrt(max(0.,1.-moonR)))),normalize(vec3(.45,.25,.86))));
  float moonVisible = smoothstep(-.035,.02,moonDirection.y);
  color += vec3(.37,.48,.72) * exp((dot(ray,moonDirection)-1.)*240.) * .14 * moonVisible;
  color = mix(color,vec3(.84,.89,1.) * relief * moonShade * 1.65, moonDisc*moonVisible);

  // Two wind-driven layers: soft cumulus with a shaded underside and high wisps.
  vec2 uv = ray.xz / (height + .24) * 1.75 + vec2(windTime*.006,windTime*.0018);
  float density = fbm(uv);
  float cloud = smoothstep(.47,.69,density) * smoothstep(.015,.18,ray.y);
  float wisps = smoothstep(.62,.78,fbm(uv*vec2(.75,2.1)+vec2(30.,windTime*.001))) * .28;
  cloud = clamp(cloud+wisps*smoothstep(.03,.25,ray.y),0.,.97);
  float rim = smoothstep(.47,.57,density) * (1.-smoothstep(.57,.68,density));
  vec3 cloudBottom = mix(vec3(.022,.036,.071),vec3(.46,.56,.67),daylight);
  vec3 cloudTop = mix(vec3(.09,.13,.22),vec3(1.08,1.10,1.08),daylight);
  vec3 cloudColor = mix(cloudBottom,cloudTop,smoothstep(.48,.76,density));
  cloudColor += vec3(1.,.28,.07) * twilight * (.25 + .75*pow(towardSun,4.));
  cloudColor += vec3(1.,.87,.60) * rim * pow(towardSun,12.) * sunVisible * .65;
  color = mix(color,cloudColor,cloud*.92);
  gl_FragColor = vec4(color,1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** A single sky pass: no downloaded textures or per-cloud lights. */
export class SkyEnvironment {
  readonly hemisphere = new THREE.HemisphereLight('#deefff', '#85846a', 1.9);
  readonly dome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private windTime = 0;
  private readonly dayTop = new THREE.Color('#347cc4');
  private readonly dayHorizon = new THREE.Color('#c2e0ef');
  private readonly nightTop = new THREE.Color('#050d26');
  private readonly nightHorizon = new THREE.Color('#263952');
  private readonly duskTop = new THREE.Color('#505983');
  private readonly duskHorizon = new THREE.Color('#f2ad79');
  private readonly dayAmbient = new THREE.Color('#d6e9ff');
  private readonly nightAmbient = new THREE.Color('#6f90d0');
  private readonly dayGround = new THREE.Color('#aaa083');
  private readonly nightGround = new THREE.Color('#263348');
  private readonly warmSun = new THREE.Color('#ffad65');
  private readonly highSun = new THREE.Color('#fff2d5');
  private readonly moonLight = new THREE.Color('#91b5fa');
  private readonly lightDirection = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene, private readonly sun: THREE.DirectionalLight) {
    const material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader, side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() },
        sunDirection: { value: new THREE.Vector3() }, moonDirection: { value: new THREE.Vector3() },
        daylight: { value: 1 }, night: { value: 0 }, twilight: { value: 0 }, windTime: { value: 0 } },
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), material);
    this.dome.name = 'procedural-day-night-sky';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 1000;
    scene.add(this.dome, this.hemisphere);
  }

  update(hour: number, dt: number, camera: THREE.Camera, target: { x: number; z: number }) {
    this.windTime += Math.max(0, Number.isFinite(dt) ? dt : 0);
    const sky = solarState(hour), uniforms = this.dome.material.uniforms;
    this.dome.position.copy(camera.position);
    uniforms.zenith.value.copy(this.nightTop).lerp(this.dayTop, sky.daylight).lerp(this.duskTop, sky.twilight * .5);
    uniforms.horizon.value.copy(this.nightHorizon).lerp(this.dayHorizon, sky.daylight).lerp(this.duskHorizon, sky.twilight * .76);
    uniforms.sunDirection.value.set(sky.sun.x, sky.sun.y, sky.sun.z);
    uniforms.moonDirection.value.set(sky.moon.x, sky.moon.y, sky.moon.z);
    uniforms.daylight.value = sky.daylight; uniforms.night.value = sky.night;
    uniforms.twilight.value = sky.twilight; uniforms.windTime.value = this.windTime;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(uniforms.horizon.value); fog.near = 135; fog.far = 410 - sky.night * 55;
    this.hemisphere.color.copy(this.nightAmbient).lerp(this.dayAmbient, sky.daylight);
    this.hemisphere.groundColor.copy(this.nightGround).lerp(this.dayGround, sky.daylight);
    this.hemisphere.intensity = .65 + sky.daylight * 1.5;
    const moonUp = sky.sun.y < 0;
    const source = moonUp ? sky.moon : sky.sun;
    this.lightDirection.set(source.x, Math.max(.04, source.y), source.z).normalize();
    this.sun.position.set(target.x, 0, target.z).addScaledVector(this.lightDirection, 165);
    this.sun.target.position.set(target.x, 0, target.z);
    this.sun.target.updateMatrixWorld();
    this.sun.color.copy(moonUp ? this.moonLight : this.warmSun);
    if (!moonUp) this.sun.color.lerp(this.highSun, Math.min(1, sky.sun.y * 2.4));
    this.sun.intensity = moonUp ? .48 * Math.min(1, source.y * 5) : 3.05 * Math.min(1, source.y * 5);
    return sky;
  }
}

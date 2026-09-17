import * as THREE from 'three';

export type GroundSurface = 'sidewalk' | 'courtyard' | 'promenade' | 'curb';

// One repeat covers eight metres, regardless of the size/orientation of a batch.
const REPEAT_METRES = 8;
const RESOLUTION = 1024;

type StonePattern = {
  columns: number; rows: number; stagger: boolean;
  stone: [number, number, number]; joint: [number, number, number]; seed: number;
};

function hash(x: number, y: number, seed: number) {
  let value = Math.imul(x + seed, 374761393) ^ Math.imul(y + seed, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

/** Seamless limestone: individual stones, recessed joints, soft edges and fine grain. */
function stoneTextures(pattern: StonePattern, anisotropy: number) {
  const colorCanvas = document.createElement('canvas'), reliefCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = reliefCanvas.width = reliefCanvas.height = RESOLUTION;
  const colorContext = colorCanvas.getContext('2d')!, reliefContext = reliefCanvas.getContext('2d')!;
  const color = colorContext.createImageData(RESOLUTION, RESOLUTION);
  const relief = reliefContext.createImageData(RESOLUTION, RESOLUTION);
  const tileWidth = RESOLUTION / pattern.columns, tileHeight = RESOLUTION / pattern.rows;
  const jointWidth = 1.05, bevelWidth = 1.6;
  for (let y = 0; y < RESOLUTION; y++) {
    const row = Math.floor((y + .5) / tileHeight), tileY = (y + .5) % tileHeight;
    const offset = pattern.stagger && row % 2 ? tileWidth / 2 : 0;
    for (let x = 0; x < RESOLUTION; x++) {
      const shiftedX = x + .5 + offset;
      const column = Math.floor(shiftedX / tileWidth) % pattern.columns, tileX = shiftedX % tileWidth;
      const edgeDistance = Math.min(tileX, tileWidth - tileX, tileY, tileHeight - tileY);
      const edge = THREE.MathUtils.smoothstep(edgeDistance, jointWidth, jointWidth + bevelWidth);
      const variation = (hash(column, row, pattern.seed) - .5) * 22;
      const grain = (hash(x, y, pattern.seed + 37) - .5) * 7;
      const mottling = (hash(Math.floor(x / 8), Math.floor(y / 8), pattern.seed + 93) - .5) * 3;
      const index = (y * RESOLUTION + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const stone = pattern.stone[channel] + variation + grain + mottling;
        color.data[index + channel] = THREE.MathUtils.lerp(pattern.joint[channel] + grain * .4, stone, edge);
      }
      color.data[index + 3] = 255;
      // Red stores height, green roughness; a single linear texture serves both maps.
      relief.data[index] = 85 + edge * 125 + grain * .6;
      relief.data[index + 1] = 252 - edge * (15 + hash(column, row, pattern.seed + 11) * 12);
      relief.data[index + 2] = 0;
      relief.data[index + 3] = 255;
    }
  }
  colorContext.putImageData(color, 0, 0);
  reliefContext.putImageData(relief, 0, 0);
  const map = new THREE.CanvasTexture(colorCanvas), surface = new THREE.CanvasTexture(reliefCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  for (const texture of [map, surface]) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = Math.max(1, Math.min(8, anisotropy));
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
  }
  return { map, surface };
}

function stoneMaterial(kind: GroundSurface, textures: ReturnType<typeof stoneTextures>, tint = '#ffffff') {
  const material = new THREE.MeshStandardMaterial({
    color: tint, map: textures.map, bumpMap: textures.surface, bumpScale: .025,
    roughnessMap: textures.surface, roughness: 1, metalness: 0,
  });
  material.name = `ground-${kind}`;
  material.userData.groundSurface = kind;
  material.onBeforeCompile = shader => {
    // Use the final instance transform: default unit-box UVs would stretch the same
    // tile over a 400 m courtyard or a whole sidewalk. Project the narrow sides too.
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      #include <project_vertex>
      vec4 pavingPosition = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        pavingPosition = instanceMatrix * pavingPosition;
      #endif
      pavingPosition = modelMatrix * pavingPosition;
      vec3 pavingNormal = inverseTransformDirection(transformedNormal, viewMatrix);
      vec2 pavingUv = pavingPosition.xz;
      if (abs(pavingNormal.y) < 0.5) {
        pavingUv = abs(pavingNormal.x) > abs(pavingNormal.z) ? pavingPosition.zy : pavingPosition.xy;
      }
      pavingUv /= ${REPEAT_METRES.toFixed(1)};
      vMapUv = (mapTransform * vec3(pavingUv, 1.0)).xy;
      vBumpMapUv = (bumpMapTransform * vec3(pavingUv, 1.0)).xy;
      vRoughnessMapUv = (roughnessMapTransform * vec3(pavingUv, 1.0)).xy;
    `);
  };
  material.customProgramCacheKey = () => 'portside-world-paving-v1';
  return material;
}

export function createGroundMaterials(anisotropy: number) {
  const sidewalk = stoneTextures({ columns: 8, rows: 12, stagger: true,
    stone: [199, 195, 180], joint: [139, 143, 130], seed: 17 }, anisotropy);
  const courtyard = stoneTextures({ columns: 16, rows: 24, stagger: true,
    stone: [165, 170, 157], joint: [115, 126, 119], seed: 83 }, anisotropy);
  const promenade = stoneTextures({ columns: 8, rows: 8, stagger: false,
    stone: [209, 197, 175], joint: [148, 148, 131], seed: 137 }, anisotropy);
  const materials: Record<GroundSurface, THREE.MeshStandardMaterial> = {
    sidewalk: stoneMaterial('sidewalk', sidewalk),
    courtyard: stoneMaterial('courtyard', courtyard),
    promenade: stoneMaterial('promenade', promenade),
    curb: stoneMaterial('curb', sidewalk, '#fff6df'),
  };
  return { materials, textures: [sidewalk.map, sidewalk.surface, courtyard.map, courtyard.surface, promenade.map, promenade.surface] };
}

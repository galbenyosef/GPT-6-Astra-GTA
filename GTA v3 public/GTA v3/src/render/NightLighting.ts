import * as THREE from 'three';
import type { Vehicle } from '../game/types';

/** Batched lamp pools and two headlights keep the night readable at low cost. */
export class NightLighting {
  private readonly pools: THREE.InstancedMesh;
  private readonly glow: THREE.CanvasTexture;
  private readonly poolMaterial: THREE.MeshBasicMaterial;
  private readonly headlights: THREE.SpotLight[] = [];

  constructor(scene: THREE.Scene, lamps: readonly THREE.Vector3[], private readonly bulbs: THREE.MeshStandardMaterial,
    private readonly windows: readonly THREE.MeshStandardMaterial[]) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,226,167,.65)');
    gradient.addColorStop(.35, 'rgba(255,205,133,.36)');
    gradient.addColorStop(1, 'rgba(255,185,110,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
    this.glow = new THREE.CanvasTexture(canvas);
    this.glow.colorSpace = THREE.SRGBColorSpace;
    this.poolMaterial = new THREE.MeshBasicMaterial({ map: this.glow, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
    this.pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.poolMaterial, lamps.length);
    this.pools.name = 'street-lamp-light-pools';
    const transform = new THREE.Object3D();
    lamps.forEach((position, index) => {
      transform.position.copy(position); transform.position.y = .105;
      transform.rotation.x = -Math.PI / 2; transform.scale.set(8, 8, 1);
      transform.updateMatrix(); this.pools.setMatrixAt(index, transform.matrix);
    });
    this.pools.computeBoundingSphere(); scene.add(this.pools);
    for (let i = 0; i < 2; i++) {
      const light = new THREE.SpotLight('#e3edff', 0, 46, .43, .65, 1.35);
      light.name = `driver-headlight-${i}`;
      scene.add(light, light.target); this.headlights.push(light);
    }
  }

  update(night: number, vehicle?: Vehicle) {
    this.bulbs.emissive.set('#ffce7f'); this.bulbs.emissiveIntensity = night * 3;
    this.poolMaterial.opacity = night * .7;
    this.pools.visible = night > .005;
    for (const material of this.windows) { material.emissive.set('#ffbe79'); material.emissiveIntensity = night * .36; }
    for (let index = 0; index < this.headlights.length; index++) {
      const light = this.headlights[index];
      light.intensity = vehicle?.active ? night * 48 : 0;
      if (!vehicle) continue;
      const side = (index ? 1 : -1) * vehicle.width * .3;
      const forward = vehicle.depth * .48;
      const x = vehicle.x + Math.cos(vehicle.yaw) * side + Math.sin(vehicle.yaw) * forward;
      const z = vehicle.z - Math.sin(vehicle.yaw) * side + Math.cos(vehicle.yaw) * forward;
      light.position.set(x, .9, z);
      light.target.position.set(x + Math.sin(vehicle.yaw) * 24, .1, z + Math.cos(vehicle.yaw) * 24);
      light.target.updateMatrixWorld();
    }
  }

  dispose() { this.glow.dispose(); }
}

import type { BuildingArchitecture, GameState, Point, World } from '../game/types';

const BUILDING_COLORS: Record<BuildingArchitecture, string> = {
  apartment: '#839181', warehouse: '#b3a188', office: '#82aeb5',
  townhouse: '#bd9f87', supermarket: '#b4bd8a', civic: '#ded0a0',
};

export function Minimap({ world, state, expanded, onToggle }: { world: World; state: GameState; expanded: boolean; onToggle: () => void }) {
  const controlled = state.vehicles.find(v => v.id === state.player.vehicleId) ?? state.player;
  const target = state.mission.phase === 'deliver' ? world.destination : state.mission.phase === 'collect' ? state.vehicles.find(v => v.kind === 'mission')! : world.pickup;
  const coord = (n: number) => n + world.size / 2;
  const markerScale = world.size / 284;
  const points = (items: Point[]) => items.map(p => `${coord(p.x)},${coord(p.z)}`).join(' ');
  const active = ['available', 'collect', 'deliver'].includes(state.mission.phase);
  // Draw a road-aligned route between the nearest streets, with short access spurs.
  const nearest = (n: number) => world.roads.reduce((a, b) => Math.abs(n - a) < Math.abs(n - b) ? a : b);
  const route = state.mission.phase === 'deliver' ? [controlled, { x: nearest(controlled.x), z: controlled.z }, { x: nearest(controlled.x), z: nearest(target.z) }, { x: nearest(target.x), z: nearest(target.z) }, { x: nearest(target.x), z: target.z }, target] : [controlled, target];
  return <button className={`minimap panel ${expanded ? 'expanded' : ''}`} onClick={e => { e.currentTarget.blur(); onToggle(); }} aria-label={expanded ? 'Collapse city map' : 'Expand city map'}>
    <div className="map-header"><span>CITY MAP</span><span className="north">N ↑</span></div>
    <svg className="map-svg" viewBox={`0 0 ${world.size} ${world.size}`} role="img" aria-label="Live map of Portside: your white arrow, yellow objective, red police, outlined armored units, amber helicopter, and moving traffic">
      <rect width={world.size} height={world.size} rx="12" fill="#234a47" />
      <rect x="9" y="9" width={world.size - 18} height={world.size - 18} rx="9" fill="#50635a" />
      {world.roads.map(n => <g key={n}><rect x={coord(n) - (world.roadWidth + 4) / 2} width={world.roadWidth + 4} y="9" height={world.size - 18} fill="#293e3c"/><rect y={coord(n) - (world.roadWidth + 4) / 2} height={world.roadWidth + 4} x="9" width={world.size - 18} fill="#293e3c"/></g>)}
      {world.buildings.map(b => <rect key={b.id} x={coord(b.x) - b.width / 2} y={coord(b.z) - b.depth / 2} width={b.width} height={b.depth} rx="2" fill={BUILDING_COLORS[b.architecture ?? 'apartment']} opacity=".8"/>)}
      <circle cx={coord(world.restricted.x)} cy={coord(world.restricted.z)} r={world.restricted.radius} fill="#ef8c76" fillOpacity=".24" stroke="#ef8c76" strokeWidth="1" strokeDasharray="3 3" />
      {active && <polyline points={points(route)} fill="none" stroke="#e1f69b" strokeWidth={2.3 * markerScale} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={`${4 * markerScale} ${4 * markerScale}`}/>}
      {state.vehicles.filter(v => v.active && v.id !== state.player.vehicleId).map(v => v.model === 'armored' && v.kind === 'police'
        ? <g key={v.id} className="map-armored" transform={`translate(${coord(v.x)} ${coord(v.z)}) rotate(${-v.yaw * 180 / Math.PI}) scale(${markerScale})`}><title>Armored police unit</title><rect x="-3.5" y="-5" width="7" height="10" rx="1.2" fill="#6b3931" stroke="#ffb29b" strokeWidth="1.5"/><path d="M-2-2H2M0-4V0" stroke="#ffb29b" strokeWidth="1"/></g>
        : <rect key={v.id} x={coord(v.x) - 1.6} y={coord(v.z) - 2.7} width="3.2" height="5.4" rx="1" transform={`rotate(${-v.yaw * 180 / Math.PI} ${coord(v.x)} ${coord(v.z)})`} fill={v.kind === 'police' ? '#ff8c82' : v.kind === 'mission' ? '#e7fa9d' : '#a4b7aa'} />)}
      {state.officers.filter(officer => officer.state !== 'riding' && officer.state !== 'dead').map(officer => <circle key={officer.id} cx={coord(officer.x)} cy={coord(officer.z)} r={2.2 * markerScale} fill="#ff8c82" stroke="#422d2b" strokeWidth={markerScale}/>) }
      {state.police.helicopter && <g className="map-helicopter" transform={`translate(${coord(state.police.helicopter.x)} ${coord(state.police.helicopter.z)}) rotate(${-state.police.helicopter.yaw * 180 / Math.PI}) scale(${markerScale})`}><title>Armed police helicopter</title><circle r="10" fill="#352c22" fillOpacity=".8" stroke="#ffd38b" strokeWidth=".8"/><path d="M-2-5Q0-7 2-5L2 1 0 4-2 1ZM0 3V8M-3 7H3M-8-2H8" fill="#ffd38b" stroke="#ffd38b" strokeWidth="1.6" strokeLinecap="round"/><path d="M-4-5V2M4-5V2" stroke="#ffd38b" strokeWidth="1"/></g>}
      {active && <g transform={`translate(${coord(target.x)} ${coord(target.z)}) scale(${markerScale})`}><circle r="8" fill="#dcef97" fillOpacity=".18"/><rect x="-3.5" y="-3.5" width="7" height="7" transform="rotate(45)" fill="#e0f796" stroke="#233c32" strokeWidth="1.5"/></g>}
      <g transform={`translate(${coord(controlled.x)} ${coord(controlled.z)}) rotate(${-controlled.yaw * 180 / Math.PI + 180}) scale(${markerScale})`}><circle r="8" fill="#f9fff0" fillOpacity=".15"/><path d="M0-6 4.5 5 0 2.5-4.5 5Z" fill="#ffffff" stroke="#27483e" strokeWidth="1"/></g>
    </svg>
    {expanded && <div className="map-legend"><span><i className="legend-objective"/>Objective</span><span><i className="legend-police"/>Police</span><span><i className="legend-armored"/>Armored unit</span><span><i className="legend-air"/>Helicopter</span></div>}
    <div className="map-footer"><span><i className="live-dot"/> PORTSIDE ISLAND · N TO TOGGLE</span><span>{expanded ? '−' : '+'}</span></div>
  </button>;
}

import React, { useRef, useMemo, useCallback, useState, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Stars, Html } from '@react-three/drei';
import * as THREE from 'three';
import {
  makeGlowSprite, makeRadarSweepTexture, makeJupiterTex, makeSaturnTex,
  makeSaturnRingTex, makeMarsTex, makeMercuryTex, makeVenusTex, makeUranusTex, makeNeptuneTex,
} from './worldGlobeTextures.js';

// Textures self-hosted from mrdoob/three.js examples/textures/planets (NASA
// Visible Earth imagery, as used throughout the three.js example gallery).
const EARTH_MAP = '/textures/earth_atmos_2048.jpg';
const EARTH_BUMP = '/textures/earth_normal_2048.jpg';
const EARTH_SPEC = '/textures/earth_specular_2048.jpg';

const GLOBE_RADIUS = 2;
const GOLD = '#bcefff';
const EARTH_ROTATE_SPEED = 0.025; // rad/s

function latLonToVec3(lat, lon, r) {
  const phi = (lat * Math.PI) / 180;
  const theta = (lon * Math.PI) / 180;
  return new THREE.Vector3(
    r * Math.cos(phi) * Math.cos(theta),
    r * Math.sin(phi),
    -r * Math.cos(phi) * Math.sin(theta),
  );
}

function tangentQuaternion(position) {
  const normal = position.clone().normalize();
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
}

function GlobeMesh() {
  const { gl } = useThree();
  const [mapTex, bumpTex, specTex] = useMemo(() => {
    const loader = new THREE.TextureLoader();
    const maxAniso = gl.capabilities.getMaxAnisotropy();
    const load = (url) => {
      const t = loader.load(url);
      t.anisotropy = maxAniso;
      return t;
    };
    return [load(EARTH_MAP), load(EARTH_BUMP), load(EARTH_SPEC)];
  }, [gl]);

  return (
    <mesh>
      <sphereGeometry args={[GLOBE_RADIUS, 96, 96]} />
      <meshPhongMaterial
        map={mapTex}
        bumpMap={bumpTex}
        bumpScale={0.15}
        specularMap={specTex}
        specular={new THREE.Color(0x223355)}
        shininess={10}
        emissive={new THREE.Color(0x1a1408)}
        emissiveIntensity={0.15}
      />
    </mesh>
  );
}

function Atmosphere() {
  return (
    <>
      <mesh scale={1.015}>
        <sphereGeometry args={[GLOBE_RADIUS, 32, 32]} />
        <meshStandardMaterial color="#bcefff" transparent opacity={0.08} side={THREE.BackSide} />
      </mesh>
      <mesh scale={1.045}>
        <sphereGeometry args={[GLOBE_RADIUS, 32, 32]} />
        <meshStandardMaterial color="#bcefff" transparent opacity={0.04} side={THREE.BackSide} />
      </mesh>
    </>
  );
}

function GridLines() {
  const geo = useMemo(() => {
    const pts = [];
    const r = GLOBE_RADIUS * 1.003;
    for (let lat = -80; lat <= 80; lat += 20) {
      const phi = (lat * Math.PI) / 180;
      for (let i = 0; i <= 128; i++) {
        const lon = (i / 128) * 2 * Math.PI;
        pts.push(r * Math.cos(phi) * Math.cos(lon), r * Math.sin(phi), -r * Math.cos(phi) * Math.sin(lon));
      }
    }
    for (let lon = 0; lon < 360; lon += 30) {
      const theta = (lon * Math.PI) / 180;
      for (let i = 0; i <= 64; i++) {
        const phi = ((i / 64) * 180 - 90) * (Math.PI / 180);
        pts.push(r * Math.cos(phi) * Math.cos(theta), r * Math.sin(phi), -r * Math.cos(phi) * Math.sin(theta));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);

  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color="#bcefff" transparent opacity={0.12} />
    </lineSegments>
  );
}

/** Visibility toggle shared by markers/radar riding on the rotating globe:
 * checks the object's actual WORLD-space position (not a stale local-space
 * value) against the camera direction, so it stays correct as the globe spins. */
function useFrontFacingVisibility(groupRef) {
  const scratch = useMemo(() => new THREE.Vector3(), []);
  return (camera) => {
    if (!groupRef.current) return true;
    groupRef.current.getWorldPosition(scratch);
    return scratch.normalize().dot(camera.position.clone().normalize());
  };
}

function RadarSweep({ centerLat, centerLon }) {
  const sweepRef = useRef(null);
  const groupRef = useRef(null);
  const tex = useMemo(() => makeRadarSweepTexture(), []);
  const position = useMemo(
    () => latLonToVec3(centerLat, centerLon, GLOBE_RADIUS * 1.012),
    [centerLat, centerLon],
  );
  const quaternion = useMemo(() => tangentQuaternion(position), [position]);
  const facing = useFrontFacingVisibility(groupRef);

  useFrame(({ camera }, delta) => {
    if (sweepRef.current) sweepRef.current.rotation.z -= delta * ((Math.PI * 2) / 6);
    if (groupRef.current) groupRef.current.visible = facing(camera) > 0.55;
  });

  return (
    <group ref={groupRef} position={position} quaternion={quaternion}>
      <mesh ref={sweepRef}>
        <circleGeometry args={[0.42, 64]} />
        <meshBasicMaterial map={tex} transparent depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function CityMarker({ city, onSelect }) {
  const glowTex = useMemo(() => makeGlowSprite(), []);
  const ringRef = useRef(null);
  const groupRef = useRef(null);
  const [hovered, setHovered] = useState(false);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);
  const position = useMemo(
    () => latLonToVec3(city.lat, city.lon, GLOBE_RADIUS * 1.008),
    [city.lat, city.lon],
  );
  const quaternion = useMemo(() => tangentQuaternion(position), [position]);
  const facing = useFrontFacingVisibility(groupRef);

  useFrame(({ clock, camera }) => {
    if (ringRef.current) {
      const t = ((clock.elapsedTime + phase) % 2) / 2;
      ringRef.current.scale.setScalar(1 + t * 2.2);
      ringRef.current.material.opacity = Math.max(0, 0.55 * (1 - t));
    }
    if (groupRef.current) groupRef.current.visible = facing(camera) > 0.08;
  });

  return (
    <group ref={groupRef} position={position} quaternion={quaternion}>
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          onSelect(city);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = 'auto';
        }}
      >
        <circleGeometry args={[0.11, 24]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh>
        <circleGeometry args={[0.028, 24]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      <sprite scale={[0.09, 0.09, 0.09]}>
        <spriteMaterial map={glowTex} transparent depthWrite={false} opacity={0.9} />
      </sprite>
      <mesh ref={ringRef}>
        <ringGeometry args={[0.035, 0.045, 32]} />
        <meshBasicMaterial color={GOLD} transparent depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      {hovered && (
        <Html zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
          <div className="-translate-x-1/2 -translate-y-[220%] whitespace-nowrap text-[14px] font-bold text-white px-2 py-0.5 rounded bg-black/70 border border-gold/40">
            {city.name}
          </div>
        </Html>
      )}
    </group>
  );
}

/** Earth + graticule + radar + city markers, spinning together on the polar
 * axis so markers stay glued to their real coordinates as the globe turns. */
function RotatingGlobe({ centerLat, centerLon, cities, onSelectCity, rotRef }) {
  const groupRef = useRef(null);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y += delta * EARTH_ROTATE_SPEED;
    rotRef.current = groupRef.current.rotation.y;
  });

  return (
    <group ref={groupRef}>
      <GlobeMesh />
      <GridLines />
      <RadarSweep centerLat={centerLat} centerLon={centerLon} />
      {cities.map((city) => (
        <CityMarker key={city.id} city={city} onSelect={onSelectCity} />
      ))}
    </group>
  );
}

// ─── Sun & solar system ──────────────────────────────────────────────────────

function Sun() {
  const groupRef = useRef(null);
  useFrame(({ clock }) => {
    if (groupRef.current) {
      const t = clock.elapsedTime * 0.04;
      groupRef.current.position.set(Math.cos(t) * 18, 4, Math.sin(t) * 18);
    }
  });

  const coronaMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#fff4a0',
    transparent: true,
    opacity: 0.15,
    side: THREE.BackSide,
  }), []);

  return (
    <group ref={groupRef} position={[18, 4, 0]}>
      <mesh>
        <sphereGeometry args={[0.45, 24, 24]} />
        <meshBasicMaterial color="#ffe060" />
      </mesh>
      <mesh scale={1.6}>
        <sphereGeometry args={[0.45, 16, 16]} />
        <primitive object={coronaMat} />
      </mesh>
      <pointLight intensity={4.5} color="#fff8e0" distance={80} decay={1.2} />
    </group>
  );
}

/** Faint orbit ring drawn in the ecliptic plane. */
function OrbitPath({ dist }) {
  const line = useMemo(() => {
    const pts = [];
    const N = 256;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push(Math.cos(a) * dist, 0, Math.sin(a) * dist);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({ color: '#1a2a5a', transparent: true, opacity: 0.20 });
    return new THREE.Line(geo, mat);
  }, [dist]);

  return <primitive object={line} />;
}

function Planet({ radius, dist, speed, incl, color, roughness = 0.75, map, ringTex }) {
  const ref = useRef(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime * speed;
    ref.current.position.set(
      Math.cos(t) * dist,
      Math.sin(t * 0.35) * dist * incl,
      Math.sin(t) * dist,
    );
  });

  return (
    <group ref={ref}>
      <mesh>
        <sphereGeometry args={[radius, 36, 36]} />
        <meshStandardMaterial
          map={map}
          color={map ? '#ffffff' : color}
          roughness={roughness}
          metalness={0.04}
        />
      </mesh>
      {ringTex && (
        <mesh rotation={[Math.PI * 0.46, 0.18, 0.14]}>
          <ringGeometry args={[radius * 1.38, radius * 2.55, 128]} />
          <meshBasicMaterial map={ringTex} transparent side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

function SolarSystem() {
  const mercuryMap = useMemo(() => makeMercuryTex(), []);
  const venusMap = useMemo(() => makeVenusTex(), []);
  const marsMap = useMemo(() => makeMarsTex(), []);
  const jupiterMap = useMemo(() => makeJupiterTex(), []);
  const saturnMap = useMemo(() => makeSaturnTex(), []);
  const saturnRing = useMemo(() => makeSaturnRingTex(), []);
  const uranusMap = useMemo(() => makeUranusTex(), []);
  const neptuneMap = useMemo(() => makeNeptuneTex(), []);

  return (
    <>
      <group key="mercury">
        <OrbitPath dist={22} />
        <Planet radius={0.10} dist={22} speed={0.074} incl={0.08} color="#8a7e70" roughness={0.92} map={mercuryMap} />
      </group>
      <group key="venus">
        <OrbitPath dist={30} />
        <Planet radius={0.20} dist={30} speed={0.050} incl={0.04} color="#f0d888" roughness={0.55} map={venusMap} />
      </group>
      <group key="mars">
        <OrbitPath dist={45} />
        <Planet radius={0.13} dist={45} speed={0.028} incl={0.17} color="#c04828" roughness={0.88} map={marsMap} />
      </group>
      <group key="jupiter">
        <OrbitPath dist={75} />
        <Planet radius={0.75} dist={75} speed={0.012} incl={0.06} color="#c2956a" roughness={0.55} map={jupiterMap} />
      </group>
      <group key="saturn">
        <OrbitPath dist={110} />
        <Planet radius={0.60} dist={110} speed={0.008} incl={0.18} color="#d4b870" roughness={0.50} map={saturnMap} ringTex={saturnRing} />
      </group>
      <group key="uranus">
        <OrbitPath dist={148} />
        <Planet radius={0.38} dist={148} speed={0.005} incl={0.48} color="#78d4dc" roughness={0.40} map={uranusMap} />
      </group>
      <group key="neptune">
        <OrbitPath dist={185} />
        <Planet radius={0.36} dist={185} speed={0.003} incl={0.10} color="#2858c8" roughness={0.40} map={neptuneMap} />
      </group>
    </>
  );
}

// ─── Intro camera flight ─────────────────────────────────────────────────────

const INTRO_START = new THREE.Vector3(0, 1.4, 24);
const INTRO_DURATION = 2.6;
// Far enough that the full globe (radius 2, fov 42) fits inside the frame
// with room to spare, so the starfield is visible around it too.
const CAM_DIST = 6.4;

/** Flies the camera in from far away, arcing past the globe before settling
 * on the framed target — the swoop comes for free from lerping between two
 * positions that aren't on the same line through the origin. Recomputes the
 * target every frame from the globe's current spin so it always lands on
 * Turkey, not wherever Turkey was when the flight started. */
function IntroCameraRig({ centerLat, centerLon, rotRef, onComplete }) {
  const { camera } = useThree();
  const progressRef = useRef(0);
  const doneRef = useRef(false);

  useFrame((_, delta) => {
    if (doneRef.current) return;
    progressRef.current = Math.min(1, progressRef.current + delta / INTRO_DURATION);
    const eased = 1 - Math.pow(1 - progressRef.current, 3);
    const latR = (centerLat * Math.PI) / 180;
    const lonR = (centerLon * Math.PI) / 180 + (rotRef.current ?? 0);
    const endPos = new THREE.Vector3(
      CAM_DIST * Math.cos(latR) * Math.cos(lonR),
      CAM_DIST * Math.sin(latR),
      -CAM_DIST * Math.cos(latR) * Math.sin(lonR),
    );
    camera.position.lerpVectors(INTRO_START, endPos, eased);
    camera.lookAt(0, 0, 0);
    if (progressRef.current >= 1) {
      doneRef.current = true;
      onComplete?.();
    }
  });

  return null;
}

function Scene({ cities, onSelectCity, centerLat, centerLon, introPlaying, onIntroComplete }) {
  const controlsRef = useRef(null);
  const rotRef = useRef(0);

  return (
    <>
      <ambientLight intensity={2.2} />
      <directionalLight position={[5, 3, 6]} intensity={1.4} color="#fff8f0" />
      <directionalLight position={[-5, 3, -4]} intensity={1} color="#d0e8ff" />
      <Stars radius={260} depth={90} count={5000} factor={4} saturation={0} fade speed={0.3} />
      <Sun />
      <SolarSystem />
      <Atmosphere />
      <RotatingGlobe centerLat={centerLat} centerLon={centerLon} cities={cities} onSelectCity={onSelectCity} rotRef={rotRef} />
      {introPlaying && (
        <IntroCameraRig centerLat={centerLat} centerLon={centerLon} rotRef={rotRef} onComplete={onIntroComplete} />
      )}
      <OrbitControls
        ref={controlsRef}
        enabled={!introPlaying}
        enablePan={false}
        minDistance={2.6}
        maxDistance={220}
        rotateSpeed={0.45}
        zoomSpeed={0.7}
        dampingFactor={0.08}
        enableDamping
      />
    </>
  );
}

export default function WorldGlobe({ cities, onSelectCity, centerLat = 39, centerLon = 33 }) {
  const [introPlaying, setIntroPlaying] = useState(true);
  const [tabVisible, setTabVisible] = useState(!document.hidden);

  const handleSelect = useCallback((city) => onSelectCity?.(city), [onSelectCity]);
  const handleIntroComplete = useCallback(() => setIntroPlaying(false), []);

  // This is a decorative background scene (full orbit-camera solar system +
  // Earth), so its render loop shouldn't keep spending CPU/GPU while the tab
  // is in the background.
  useEffect(() => {
    const onVisibilityChange = () => setTabVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  return (
    <Canvas
      camera={{ position: INTRO_START.toArray(), fov: 42, far: 2000 }}
      style={{ background: 'transparent' }}
      dpr={Math.min(window.devicePixelRatio, 2)}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      frameloop={tabVisible ? 'always' : 'never'}
    >
      <Scene
        cities={cities}
        onSelectCity={handleSelect}
        centerLat={centerLat}
        centerLon={centerLon}
        introPlaying={introPlaying}
        onIntroComplete={handleIntroComplete}
      />
    </Canvas>
  );
}

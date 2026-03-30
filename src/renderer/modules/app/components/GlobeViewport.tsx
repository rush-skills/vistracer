/* eslint-disable react/no-unknown-property */
import React, { useMemo, useRef, useEffect } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Line } from "@react-three/drei";
import * as THREE from "three";
import type { TracerouteRun } from "@common/ipc";
import {
  buildArcDescriptors,
  EARTH_RADIUS_UNITS,
  latLngToVector3,
  hopIndexToColor,
  calculateSunDirection
} from "@renderer/lib/globe";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import "./GlobeViewport.css";

interface GlobeViewportProps {
  run?: TracerouteRun;
  selectedHopIndex?: number;
}

const CountryBorders: React.FC = () => {
  const [borderLines, setBorderLines] = React.useState<THREE.Vector3[][]>([]);

  React.useEffect(() => {
    // Load GeoJSON for country borders
    fetch('./world.geojson')
      .then(res => res.json())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GeoJSON shape varies; full typing not worth the complexity
      .then((geojson: { features?: Array<{ geometry: any }> }) => {
        const lines: THREE.Vector3[][] = [];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GeoJSON feature geometry is polymorphic
        geojson.features?.forEach((feature: { geometry: any }) => {
          const geometry = feature.geometry;
          if (!geometry) return;

          const processCoordinates = (coords: number[][]) => {
            const points = coords.map(([lon, lat]) =>
              latLngToVector3(lat, lon, EARTH_RADIUS_UNITS + 0.02)
            );
            if (points.length > 1) {
              lines.push(points);
            }
          };

          if (geometry.type === 'Polygon') {
            geometry.coordinates.forEach((ring: number[][]) => {
              processCoordinates(ring);
            });
          } else if (geometry.type === 'MultiPolygon') {
            geometry.coordinates.forEach((polygon: number[][][]) => {
              polygon.forEach((ring: number[][]) => {
                processCoordinates(ring);
              });
            });
          }
        });

        setBorderLines(lines);
      })
      .catch(err => console.warn('Failed to load country borders:', err));
  }, []);

  return (
    <group>
      {borderLines.map((points, idx) => (
        <Line
          key={idx}
          points={points.map(p => p.toArray() as [number, number, number])}
          color="#ffffff"
          lineWidth={0.8}
          opacity={0.25}
          transparent
        />
      ))}
    </group>
  );
};

const DynamicSunLight: React.FC = () => {
  const lightRef = React.useRef<THREE.DirectionalLight>(null);
  const lastUpdateRef = React.useRef<number>(0);

  // Update sun position every second
  useFrame((_, delta) => {
    lastUpdateRef.current += delta;

    if (lastUpdateRef.current >= 1.0 && lightRef.current) {
      const sunDirection = calculateSunDirection();
      // Position the light far from the Earth in the direction of the sun
      const distance = 100;
      lightRef.current.position.set(
        sunDirection.x * distance,
        sunDirection.y * distance,
        sunDirection.z * distance
      );
      lastUpdateRef.current = 0;
    }
  });

  // Initialize with current sun position
  const initialSunDirection = React.useMemo(() => calculateSunDirection(), []);
  const initialPosition = React.useMemo(() => {
    const distance = 100;
    return [
      initialSunDirection.x * distance,
      initialSunDirection.y * distance,
      initialSunDirection.z * distance
    ] as [number, number, number];
  }, [initialSunDirection]);

  return (
    <directionalLight
      ref={lightRef}
      position={initialPosition}
      intensity={1.6}
      castShadow={false}
    />
  );
};

const CameraController: React.FC<{ run?: TracerouteRun; selectedHopIndex?: number }> = ({ run, selectedHopIndex }) => {
  const { camera } = useThree();
  const lastHopCountRef = useRef<number>(0);
  const lastSelectedHopRef = useRef<number | undefined>(undefined);
  const targetPositionRef = useRef<THREE.Vector3 | null>(null);
  const animationProgressRef = useRef<number>(0);
  const initialCameraPositionRef = useRef<THREE.Vector3>(new THREE.Vector3());

  // Helper function to animate camera to a hop position
  const animateToHop = useRef((latitude: number, longitude: number) => {
    const hopPosition = latLngToVector3(
      latitude,
      longitude,
      EARTH_RADIUS_UNITS
    );

    // Position camera to look at this point from the same distance as current camera
    const currentDistance = camera.position.length();
    const targetDirection = hopPosition.clone().normalize();
    const targetPosition = targetDirection.multiplyScalar(currentDistance);

    targetPositionRef.current = targetPosition;
    initialCameraPositionRef.current = camera.position.clone();
    animationProgressRef.current = 0; // Start animation
  });

  // Update the animateToHop function when camera changes
  useEffect(() => {
    animateToHop.current = (latitude: number, longitude: number) => {
      const hopPosition = latLngToVector3(
        latitude,
        longitude,
        EARTH_RADIUS_UNITS
      );

      const currentDistance = camera.position.length();
      const targetDirection = hopPosition.clone().normalize();
      const targetPosition = targetDirection.multiplyScalar(currentDistance);

      targetPositionRef.current = targetPosition;
      initialCameraPositionRef.current = camera.position.clone();
      animationProgressRef.current = 0;
    };
  }, [camera]);

  // Detect new hops with geo data
  useEffect(() => {
    if (!run) {
      lastHopCountRef.current = 0;
      return;
    }

    const hopsWithGeo = run.hops.filter(hop => hop.geo);
    const currentHopCount = hopsWithGeo.length;

    // New hop detected
    if (currentHopCount > lastHopCountRef.current && currentHopCount > 0) {
      const latestHop = hopsWithGeo[currentHopCount - 1];

      if (latestHop.geo) {
        animateToHop.current(latestHop.geo.latitude, latestHop.geo.longitude);
      }
    }

    lastHopCountRef.current = currentHopCount;
  }, [run]);

  // Animate when user selects a hop
  useEffect(() => {
    // Only animate if the selection actually changed and we have a valid selection
    if (selectedHopIndex === lastSelectedHopRef.current) {
      return;
    }

    lastSelectedHopRef.current = selectedHopIndex;

    if (!run || selectedHopIndex === undefined) {
      return;
    }

    const selectedHop = run.hops.find(hop => hop.hopIndex === selectedHopIndex);
    if (selectedHop?.geo) {
      animateToHop.current(selectedHop.geo.latitude, selectedHop.geo.longitude);
    }
  }, [selectedHopIndex, run]);

  // Animate camera on each frame using spherical interpolation
  useFrame((_, delta) => {
    if (targetPositionRef.current && animationProgressRef.current < 1) {
      // Smooth animation over ~1.5 seconds
      const animationSpeed = 0.8; // Lower = slower, smoother
      animationProgressRef.current = Math.min(1, animationProgressRef.current + delta * animationSpeed);

      // Ease-in-out function for smooth acceleration and deceleration
      const easeProgress = animationProgressRef.current < 0.5
        ? 2 * animationProgressRef.current * animationProgressRef.current
        : 1 - Math.pow(-2 * animationProgressRef.current + 2, 2) / 2;

      // Spherical interpolation: normalize both positions, slerp, then scale to maintain distance
      const startNormalized = initialCameraPositionRef.current.clone().normalize();
      const endNormalized = targetPositionRef.current.clone().normalize();
      const distance = initialCameraPositionRef.current.length();

      // Use quaternion-based slerp for smooth rotation on the sphere
      const startQuat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        startNormalized
      );
      const endQuat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        endNormalized
      );

      const currentQuat = new THREE.Quaternion().slerpQuaternions(
        startQuat,
        endQuat,
        easeProgress
      );

      // Convert back to position
      const newDirection = new THREE.Vector3(0, 0, 1).applyQuaternion(currentQuat);
      camera.position.copy(newDirection.multiplyScalar(distance));

      // Keep camera looking at center (the Earth)
      camera.lookAt(0, 0, 0);
    }
  });

  return null;
};

const Earth: React.FC = () => {
  const { gl } = useThree();
  const meshRef = React.useRef<THREE.Mesh>(null);
  const materialRef = React.useRef<THREE.MeshStandardMaterial>(null);
  const lightDirectionUniformRef = React.useRef<{ value: THREE.Vector3 } | null>(null);
  const [textures, setTextures] = React.useState<{
    day: THREE.Texture | null;
    night: THREE.Texture | null;
  }>({ day: null, night: null });
  const [texturesReady, setTexturesReady] = React.useState(false);

  React.useEffect(() => {
    const textureLoader = new THREE.TextureLoader();

    console.log('Loading Earth textures...');

    // Load day texture
    textureLoader.load(
      './earthmap10k.jpg',
      (texture) => {
        console.log('Day texture loaded successfully');
        texture.anisotropy = Math.min(16, gl.capabilities.getMaxAnisotropy());
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        setTextures(prev => ({ ...prev, day: texture }));
      },
      undefined,
      (error) => {
        console.error('Failed to load day texture:', error);
      }
    );

    // Load night texture
    textureLoader.load(
      './earthlights10k.jpg',
      (texture) => {
        console.log('Night texture loaded successfully');
        texture.anisotropy = Math.min(16, gl.capabilities.getMaxAnisotropy());
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        setTextures(prev => ({ ...prev, night: texture }));
      },
      undefined,
      (error) => {
        console.error('Failed to load night texture:', error);
      }
    );
  }, [gl]);

  // Update material when textures change and add custom shader for day/night blend
  React.useEffect(() => {
    if (materialRef.current && textures.day && textures.night) {
      materialRef.current.map = textures.day;
      materialRef.current.emissiveMap = textures.night;

      // Custom shader to blend city lights only on the dark side
      materialRef.current.onBeforeCompile = (shader) => {
        // Add uniform for light direction - initialize with current sun position
        const initialSunDirection = calculateSunDirection();
        shader.uniforms.lightDirection = { value: initialSunDirection };
        // Store reference so we can update it in useFrame
        lightDirectionUniformRef.current = shader.uniforms.lightDirection;

        // Modify vertex shader to pass world normal
        shader.vertexShader = shader.vertexShader.replace(
          '#include <common>',
          `
          #include <common>
          varying vec3 vWorldNormal;
          `
        );

        shader.vertexShader = shader.vertexShader.replace(
          '#include <worldpos_vertex>',
          `
          #include <worldpos_vertex>
          vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
          `
        );

        // Modify fragment shader to use world space normal
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          `
          #include <common>
          uniform vec3 lightDirection;
          varying vec3 vWorldNormal;
          `
        );

        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `
          #ifdef USE_EMISSIVEMAP
            vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
            // Calculate lighting using world space normal (won't rotate with globe)
            float lightIntensity = dot(normalize(vWorldNormal), normalize(lightDirection));
            // Only show city lights on the dark side (smooth transition)
            float nightFactor = smoothstep(0.12, -0.08, lightIntensity);
            // Adjust the brightness of the night lights
            vec3 adjustedEmissive = emissiveColor.rgb * 0.75;
            totalEmissiveRadiance *= adjustedEmissive * nightFactor;
          #else
            totalEmissiveRadiance *= vec3(1.0);
          #endif
          `
        );
      };

      materialRef.current.needsUpdate = true;
      console.log('Applied day/night textures with custom shader');

      // Mark textures as ready and make mesh visible
      setTexturesReady(true);
      if (meshRef.current) {
        meshRef.current.visible = true;
      }
    }
  }, [textures]);

  // Update sun direction based on current time
  // Update every second to reflect real-time day/night cycle
  const lastUpdateRef = React.useRef<number>(0);
  useFrame((_, delta) => {
    lastUpdateRef.current += delta;

    // Update sun direction every second
    if (lastUpdateRef.current >= 1.0 && lightDirectionUniformRef.current) {
      const sunDirection = calculateSunDirection();
      lightDirectionUniformRef.current.value.copy(sunDirection);
      lastUpdateRef.current = 0;
    }
  });

  return (
    <mesh ref={meshRef} visible={texturesReady}>
      <sphereGeometry args={[EARTH_RADIUS_UNITS, 128, 128]} />
      <meshStandardMaterial
        ref={materialRef}
        color="#f5f5f5"
        emissive="#ffffff"
        emissiveIntensity={0.9}
        roughness={0.9}
        metalness={0.08}
      />
    </mesh>
  );
};

const HopMarkers: React.FC<{ run: TracerouteRun; selectedHopIndex?: number }> = ({
  run,
  selectedHopIndex
}) => {
  const setSelectedHop = useTracerouteStore((state) => state.setSelectedHop);

  // Sort hops so that the selected hop is rendered last (appears on top)
  const sortedHops = useMemo(() => {
    const hopsWithGeo = run.hops.filter((hop) => hop.geo);

    if (selectedHopIndex === undefined) {
      return hopsWithGeo;
    }

    // Separate selected hop from others
    const selectedHop = hopsWithGeo.find((hop) => hop.hopIndex === selectedHopIndex);
    const otherHops = hopsWithGeo.filter((hop) => hop.hopIndex !== selectedHopIndex);

    // Return with selected hop at the end
    return selectedHop ? [...otherHops, selectedHop] : hopsWithGeo;
  }, [run.hops, selectedHopIndex]);

  return (
    <group>
      {sortedHops.map((hop) => {
        const position = latLngToVector3(hop.geo!.latitude, hop.geo!.longitude, EARTH_RADIUS_UNITS + 0.05);
        const isSelected = hop.hopIndex === selectedHopIndex;
        const color = hopIndexToColor(hop.hopIndex);

        return (
          <mesh
            key={`hop-${hop.hopIndex}`}
            position={position.toArray() as [number, number, number]}
            onClick={() => setSelectedHop(hop.hopIndex)}
          >
            <sphereGeometry args={[isSelected ? 0.16 : 0.12, 24, 24]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={isSelected ? 0.8 : 0.4} />
          </mesh>
        );
      })}
    </group>
  );
};

const ArcLines: React.FC<{ run: TracerouteRun }> = ({ run }) => {
  const arcs = useMemo(() => buildArcDescriptors(run.hops), [run.hops]);

  return (
    <group>
      {arcs.map((arc) => (
        <Line
          key={arc.id}
          points={arc.points.map((point) => point.toArray() as [number, number, number])}
          color={arc.color}
          lineWidth={2.5}
        />
      ))}
    </group>
  );
};


export const GlobeViewport: React.FC<GlobeViewportProps> = ({ run, selectedHopIndex }) => {
  const hasRenderableHops = Boolean(run?.hops?.some((hop) => hop.geo));
  const captureActive = useTracerouteStore((state) => state.captureActive);

  return (
    <section className="globe-viewport">
      <Canvas
        camera={{ position: [0, 0, 14], fov: 50, near: 0.1, far: 1000 }}
        gl={{ preserveDrawingBuffer: true }}
      >
        <ambientLight intensity={0.35} />
        {/* Dynamic sun light that follows real-time day/night cycle */}
        <DynamicSunLight />
        <CameraController run={run} selectedHopIndex={selectedHopIndex} />
        <Earth />
        <CountryBorders />
        {run && hasRenderableHops && (
          <>
            <ArcLines run={run} />
            <HopMarkers run={run} selectedHopIndex={selectedHopIndex} />
          </>
        )}
        <OrbitControls
          enablePan={false}
          enableZoom
          enableRotate
          minDistance={6}
          maxDistance={30}
          enabled={!captureActive}
        />
      </Canvas>
      {/* {!run && (
        <div style={{
          position: 'absolute',
          bottom: '2rem',
          left: '50%',
          transform: 'translateX(-50%)',
          textAlign: 'center',
          pointerEvents: 'none'
        }}>
          <p style={{
            fontSize: '0.95rem',
            opacity: 0.6,
            margin: 0,
            maxWidth: '260px'
          }}>
            Run a traceroute to animate the globe
          </p>
        </div>
      )} */}
      {run && !hasRenderableHops && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          textAlign: 'center',
          pointerEvents: 'none'
        }}>
          <p style={{
            fontSize: '0.95rem',
            opacity: 0.6,
            margin: 0
          }}>
            Waiting for geolocation data…
          </p>
        </div>
      )}
    </section>
  );
};

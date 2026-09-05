// =====================================================================
//  3D 主場景：月球（寫實貼圖＋冰藍大氣光暈）、紅色單分子線、
//  星塵、星空，以及隨捲動行進的相機路徑（鏡頭推進月球）。
// =====================================================================
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Stars, Sparkles, useTexture } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, ToneMapping } from "@react-three/postprocessing";
import * as THREE from "three";
import { Suspense, useEffect, useMemo, useRef } from "react";

export const MOON_POS = new THREE.Vector3(2.7, 0.15, 0);
const MOON_R = 2.6;

/* ---------- 相機路徑關鍵影格（p = 捲動進度 0→1） ---------- */
const CAM_PTS: [number, number, number][] = [
  [0.4, 0.5, 9.8], // hero：月球全景，偏右
  [1.1, 0.25, 6.6], // about：推進
  [0.3, -1.05, 5.2], // skills：拉低視角，月球在右上
  [-1.9, 0.85, 6.6], // projects：繞到另一側
  [-2.9, 1.6, 12.6], // contact：拉遠告別
];
const LOOK_PTS: [number, number, number][] = [
  [2.6, 0.15, 0],
  [2.6, 0.15, -0.2],
  [2.0, -0.7, -0.9],
  [0.7, 0.55, -0.7],
  [-1.2, 0.3, 0],
];

function clamp01(x: number) {
  return Math.min(1, Math.max(0, x));
}

/* ================= Moon ================= */
function Moon() {
  const tex = useTexture("/textures/moon.jpg");
  const mesh = useRef<THREE.Mesh>(null);

  useEffect(() => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
  }, [tex]);

  useFrame((_, dt) => {
    if (mesh.current) mesh.current.rotation.y += dt * 0.025;
  });

  return (
    <group position={MOON_POS}>
      <mesh ref={mesh}>
        <sphereGeometry args={[MOON_R, 96, 96]} />
        <meshStandardMaterial map={tex} roughness={0.92} metalness={0.02} />
      </mesh>
      {/* 冰藍大氣光暈（fresnel rim，additive） */}
      <AtmosphereGlow radius={MOON_R * 1.045} color="#9fd9ff" power={2.0} strength={0.9} />
      <AtmosphereGlow radius={MOON_R * 1.3} color="#ff9fe5" power={3.2} strength={0.16} />
    </group>
  );
}

function AtmosphereGlow({
  radius,
  color,
  power,
  strength,
}: {
  radius: number;
  color: string;
  power: number;
  strength: number;
}) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        uniforms: {
          c: { value: new THREE.Color(color) },
          p: { value: power },
          s: { value: strength },
        },
        vertexShader: /* glsl */ `
          varying vec3 vN;
          varying vec3 vV;
          void main() {
            vN = normalize(normalMatrix * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vV = -mv.xyz;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 c;
          uniform float p;
          uniform float s;
          varying vec3 vN;
          varying vec3 vV;
          void main() {
            float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
            float a = pow(rim, p) * s;
            gl_FragColor = vec4(c, a);
          }
        `,
      }),
    [color, power, strength]
  );

  return (
    <mesh material={mat} scale={radius / MOON_R}>
      <sphereGeometry args={[MOON_R, 64, 64]} />
    </mesh>
  );
}

/* ================= Monowire（單分子線） ================= */
type Wire = { curve: THREE.CatmullRomCurve3; phase: number };

function makeWire(i: number): Wire {
  const baseY = 1.2 + i * 1.9;
  const pts: THREE.Vector3[] = [];
  const n = 8;
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    pts.push(
      new THREE.Vector3(
        -14 + 28 * t,
        baseY + Math.sin(t * Math.PI * 2 + i * 2.2) * 1.7 + (Math.random() - 0.5) * 0.6,
        3.6 - Math.sin(t * Math.PI) * 2.2 + (Math.random() - 0.5) * 0.8
      )
    );
  }
  return { curve: new THREE.CatmullRomCurve3(pts), phase: Math.random() * Math.PI * 2 };
}

const WIRES: Wire[] = [makeWire(0), makeWire(1), makeWire(2)];

function Monowire({ wire, index }: { wire: Wire; index: number }) {
  const group = useRef<THREE.Group>(null);
  const geo = useMemo(() => new THREE.TubeGeometry(wire.curve, 240, 0.016, 8, false), [wire]);

  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    const t = clock.elapsedTime;
    g.rotation.z = Math.sin(t * 0.22 + wire.phase) * 0.1 + index * 0.05;
    g.rotation.y = Math.sin(t * 0.14 + wire.phase) * 0.06;
    g.position.y = Math.sin(t * 0.32 + wire.phase + index) * 0.55;
    const s = 1 + Math.sin(t * 2.1 + wire.phase) * 0.035;
    g.scale.set(s, 1, s);
  });

  return (
    <group ref={group}>
      <mesh geometry={geo}>
        <meshBasicMaterial color={[2.4, 0.16, 0.3]} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ================= Camera Rig（捲動推進 + 滑鼠視差） ================= */
function CameraRig() {
  const { camera } = useThree();
  const camCurve = useMemo(() => new THREE.CatmullRomCurve3(CAM_PTS.map((p) => new THREE.Vector3(...p))), []);
  const lookCurve = useMemo(() => new THREE.CatmullRomCurve3(LOOK_PTS.map((p) => new THREE.Vector3(...p))), []);

  const state = useRef({
    p: 0,
    look: new THREE.Vector3(2.6, 0.15, 0),
    mouse: new THREE.Vector2(0, 0),
  });
  // m-15：捲動範圍快取——只在掛載 / resize / load / 字型載入後量測；
  // frame loop 只讀 window.scrollY（廉價讀取），不再每幀 scrollHeight 強制 layout。
  const maxScrollRef = useRef(0);

  useEffect(() => {
    const measure = () => {
      maxScrollRef.current = document.documentElement.scrollHeight - window.innerHeight;
    };
    measure();
    const onRecalc = () => measure();
    window.addEventListener("resize", onRecalc, { passive: true });
    window.addEventListener("load", onRecalc, { passive: true });
    const t = window.setTimeout(onRecalc, 800); // 字型載入後校正
    let alive = true;
    if (document.fonts?.ready) {
      document.fonts.ready
        .then(() => {
          if (alive) onRecalc();
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
      window.removeEventListener("resize", onRecalc);
      window.removeEventListener("load", onRecalc);
      window.clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return; // touch 滾動不更新視差（防月球跟手晃）
      state.current.mouse.set(
        (e.clientX / window.innerWidth) * 2 - 1,
        -((e.clientY / window.innerHeight) * 2 - 1)
      );
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const s = state.current;

    const max = maxScrollRef.current;
    const targetP = max > 0 ? clamp01(window.scrollY / max) : 0;
    s.p += (targetP - s.p) * (1 - Math.exp(-dt * 2.4));

    const camPos = camCurve.getPoint(s.p);
    const lookBase = lookCurve.getPoint(s.p);

    // 滑鼠視差：微微偏移視線與鏡頭
    const mx = s.mouse.x;
    const my = s.mouse.y;
    const damp = 1 - Math.exp(-dt * 3);

    camera.position.x += (camPos.x + mx * 0.28 - camera.position.x) * damp;
    camera.position.y += (camPos.y + my * 0.18 - camera.position.y) * damp;
    camera.position.z += (camPos.z - camera.position.z) * damp;

    s.look.x += (lookBase.x + mx * 0.55 - s.look.x) * damp;
    s.look.y += (lookBase.y + my * 0.35 - s.look.y) * damp;
    s.look.z += (lookBase.z - s.look.z) * damp;
    camera.lookAt(s.look);
  });

  return null;
}

/* ================= Scene ================= */
function SceneContents() {
  return (
    <>
      <color attach="background" args={["#060609"]} />
      <ambientLight intensity={0.24} />
      <directionalLight position={[8, 6, 10]} intensity={1.7} color="#e6f2ff" />
      <pointLight position={[-9, -4, 7]} intensity={80} decay={2} color="#ff9fe5" />
      <pointLight position={[7, -6, -9]} intensity={70} decay={2} color="#8fd6ff" />

      <Suspense fallback={null}>
        <Moon />
      </Suspense>
      <Monowires />
      <Sparkles count={320} scale={[26, 16, 12]} position={[0, 0, -3]} size={2.1} speed={0.22} opacity={0.5} color="#cdeaff" />
      <Stars radius={85} depth={45} count={2600} factor={3.2} saturation={0} fade speed={0.5} />
      <CameraRig />
    </>
  );
}

function Monowires() {
  return (
    <>
      {WIRES.map((w, i) => (
        <Monowire key={i} wire={w} index={i} />
      ))}
    </>
  );
}

interface Scene3DProps {
  /** Boot 碎裂 overlay 未退場前為 false → frameloop="never"：被不透明 Boot 蓋住時不空轉 GPU */
  active: boolean;
  /** WebGL context 遺失時上報（PortfolioPage 收到後切 FallbackBackdrop 靜態背景） */
  onFatal?: () => void;
}

export default function Scene3D({ active, onFatal }: Scene3DProps) {
  return (
    <Canvas
      dpr={[1, 1.5]}
      frameloop={active ? "always" : "never"}
      camera={{ fov: 55, near: 0.1, far: 220, position: [0.4, 0.5, 9.8] }}
      gl={{ antialias: false, powerPreference: "high-performance", alpha: false }}
      onCreated={({ gl }) => {
        // m-14：GPU 過載/驅動重設造成 context lost → preventDefault + 上報降級，
        // 避免黑畫面 / 整屏閃爍後永遠不恢復（R3F 的 onCreated 只在掛載時執行一次）
        const onLost = (e: Event) => {
          e.preventDefault();
          onFatal?.();
        };
        gl.domElement.addEventListener("webglcontextlost", onLost, false);
      }}
    >
      <SceneContents />
      <EffectComposer multisampling={4}>
        <Bloom intensity={0.85} luminanceThreshold={0.5} luminanceSmoothing={0.25} mipmapBlur radius={0.7} />
        <Vignette eskil={false} offset={0.16} darkness={0.55} />
        <ToneMapping mode={THREE.ACESFilmicToneMapping} />
      </EffectComposer>
    </Canvas>
  );
}

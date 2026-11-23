import { useFrame } from '@react-three/fiber'
import { type ReactNode, type RefObject, useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  type Group,
  type Material,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3
} from 'three'
import { game, useGame } from '../game/game'
import { PART_NAMES, type PartName } from '../game/wreck'
import type {
  AircraftSpec,
  AirlinerShape,
  BomberShape,
  HelicopterShape,
  RotorSpec,
  Shape,
  ShuttleShape
} from '../sim/aircraft'
import { useDisposal } from './dispose'

const QUARTER_TURN = Math.PI / 2
const UP = new Vector3(0, 1, 0)
// Largest control surface angles in radians
const AILERON_TRAVEL = 0.35
const ELEVATOR_TRAVEL = 0.4
const RUDDER_TRAVEL = 0.45
const FLAP_TRAVEL = 0.6
const AIRBRAKE_TRAVEL = 1

// Radians the pilot turns their head before the airframe outside comes into sight
const LOOKING_OUT = 0.5
// Colours the paint burns to after a crash on land
const SOOT = new Color('#3a3733')

type Paint = Record<'body' | 'accent' | 'dark' | 'glass' | 'red' | 'green', MeshStandardMaterial>

/** Shared by every aircraft model: its materials, and the parts it breaks into. */
type Airframe = {
  root: RefObject<Group | null>
  parts: RefObject<(Group | null)[]>
  paint: Paint
  spec: AircraftSpec
}

/**
 * Keeps an aircraft model on the flight model, or on its wreckage after a crash.
 * Hides it in cockpit view and scorches the paint once it burns.
 */
function useAirframe(spec: AircraftSpec, body: string, accent: string): Airframe {
  const root = useRef<Group>(null)
  const parts = useRef<(Group | null)[]>([])
  const colors = useMemo(
    () => ({ body: new Color(body), accent: new Color(accent), dark: new Color('#1e2226') }),
    [body, accent]
  )
  const paint = useMemo<Paint>(
    () => ({
      body: new MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 }),
      accent: new MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 }),
      dark: new MeshStandardMaterial({ roughness: 0.6 }),
      glass: new MeshStandardMaterial({ color: '#16252f', roughness: 0.08, metalness: 0.6 }),
      red: new MeshStandardMaterial({
        color: '#ff2a1a',
        emissive: '#ff2a1a',
        emissiveIntensity: 3
      }),
      green: new MeshStandardMaterial({
        color: '#19ff5a',
        emissive: '#19ff5a',
        emissiveIntensity: 3
      })
    }),
    []
  )
  useDisposal(paint)

  useFrame(() => {
    const { sim, wreck } = game
    if (!root.current) return
    if (wreck.active) {
      // The parts are placed in world space, each following its piece of wreckage
      root.current.position.set(0, 0, 0)
      root.current.quaternion.identity()
      root.current.visible = true
      parts.current.forEach((part, i) => {
        part?.position.copy(wreck.pieces[i].position)
        part?.quaternion.copy(wreck.pieces[i].orientation)
      })
    } else {
      root.current.position.copy(sim.position)
      root.current.quaternion.copy(sim.orientation)
      // The bombsight looks out from under the belly, past where the airframe would be.
      // From the seat, the wings and engines come into sight as the pilot looks out to the
      // side, except in the B-2, whose seat sits inside its double-sided skin.
      const { camera, bombsight } = game.getState()
      const lookingOut =
        camera === 'cockpit' &&
        Math.abs(game.look.yaw) > LOOKING_OUT &&
        spec.shape.type !== 'bomber'
      root.current.visible = (camera === 'chase' || lookingOut) && !bombsight
      parts.current.forEach((part, i) => {
        part?.position.copy(spec.breakup[i].rest)
        part?.quaternion.identity()
      })
    }
    // Paint burns black within a second of a crash on land
    const burnt = wreck.active && sim.crash !== 'water' ? Math.min(1, wreck.time * 1.5) * 0.85 : 0
    for (const key of ['body', 'accent', 'dark'] as const) {
      paint[key].color.copy(colors[key]).lerp(SOOT, burnt)
    }
  })
  return { root, parts, paint, spec }
}

/** One breakable part of the aircraft. Children use aircraft body coordinates. */
function Part(props: { airframe: Airframe; name: PartName; children: ReactNode }) {
  const index = PART_NAMES.indexOf(props.name)
  const { rest } = props.airframe.spec.breakup[index]
  return (
    <group
      ref={group => {
        props.airframe.parts.current[index] = group
      }}
      position={rest}
    >
      <group position={[-rest.x, -rest.y, -rest.z]}>{props.children}</group>
    </group>
  )
}

/** Cylinder running from one point to another, for struts and gear legs. */
function Strut(props: {
  from: [number, number, number]
  to: [number, number, number]
  radius: number
  material: MeshStandardMaterial
}) {
  const { position, quaternion, length } = useMemo(() => {
    const start = new Vector3(...props.from)
    const span = new Vector3(...props.to).sub(start)
    return {
      position: start.clone().addScaledVector(span, 0.5),
      quaternion: new Quaternion().setFromUnitVectors(UP, span.clone().normalize()),
      length: span.length()
    }
  }, [props.from, props.to])
  return (
    <mesh castShadow material={props.material} position={position} quaternion={quaternion}>
      <cylinderGeometry args={[props.radius, props.radius, length, 8]} />
    </mesh>
  )
}

/** Wheel with its axle across the aircraft, centred on `position`. */
function Wheel(props: {
  position: [number, number, number]
  radius: number
  material: MeshStandardMaterial
}) {
  return (
    <mesh castShadow material={props.material} position={props.position} rotation-z={QUARTER_TURN}>
      <cylinderGeometry args={[props.radius, props.radius, props.radius * 0.6, 16]} />
    </mesh>
  )
}

/** The aircraft in the world: the type picked in the menu, built from breakable parts. */
export function Aircraft() {
  const spec = useGame(state => state.flown)
  const { shape } = spec
  return (
    <>
      {shape.type === 'airliner' &&
        (shape.variant === 'concorde' ? (
          <ConcordeModel key={spec.id} spec={spec} shape={shape} />
        ) : (
          <AirlinerModel key={spec.id} spec={spec} shape={shape} />
        ))}
      {shape.type === 'fighter' && <FighterModel key={spec.id} spec={spec} shape={shape} />}
      {shape.type === 'bomber' && <BomberModel key={spec.id} spec={spec} shape={shape} />}
      {shape.type === 'propeller' &&
        (shape.variant === 'mustang' ? (
          <MustangModel key={spec.id} spec={spec} shape={shape} />
        ) : (
          <PropellerModel key={spec.id} spec={spec} shape={shape} />
        ))}
      {shape.type === 'shuttle' && <ShuttleModel key={spec.id} spec={spec} shape={shape} />}
      {shape.type === 'helicopter' && spec.rotor && (
        <HelicopterModel key={spec.id} spec={spec} shape={shape} rotor={spec.rotor} />
      )}
      <Cockpit spec={spec} />
    </>
  )
}

type PropellerShape = Extract<Shape, { type: 'propeller' }>

/**
 * Single-engine propeller aircraft sized from its specification: high or low wing,
 * fixed or retractable gear. The nose points along -Z, matching the flight model.
 */
function PropellerModel({ spec, shape }: { spec: AircraftSpec; shape: PropellerShape }) {
  const airframe = useAirframe(spec, shape.paint, shape.accent)
  const { paint } = airframe
  const disc = useMemo(
    () =>
      new MeshStandardMaterial({
        color: '#cfd4d8',
        transparent: true,
        opacity: 0.14,
        side: DoubleSide,
        depthWrite: false
      }),
    []
  )
  const propeller = useRef<Group>(null)
  const blades = useRef<Group>(null)
  const blur = useRef<Group>(null)
  const beacon = useRef<Group>(null)
  const lamp = useRef<Group>(null)
  const noseGear = useRef<Group>(null)
  const leftGear = useRef<Group>(null)
  const rightGear = useRef<Group>(null)
  const leftFlap = useRef<Group>(null)
  const rightFlap = useRef<Group>(null)
  const leftAileron = useRef<Group>(null)
  const rightAileron = useRef<Group>(null)
  const leftBrake = useRef<Group>(null)
  const rightBrake = useRef<Group>(null)
  const elevator = useRef<Group>(null)
  const rudder = useRef<Group>(null)

  useFrame(({ clock }, delta) => {
    const { sim, pilot, wreck } = game
    const c = pilot.controls
    if (propeller.current && blades.current && blur.current) {
      const spinning = game.getState().status === 'flying' ? sim.rpm : 0
      propeller.current.rotation.z -= (spinning / 60) * Math.PI * 2 * delta
      // Above idle the blades blur into a disc
      blades.current.visible = spinning < 900
      blur.current.visible = spinning > 400
    }
    // The red beacon on the fin flashes once a second
    if (beacon.current) beacon.current.visible = !wreck.active && clock.elapsedTime % 1 < 0.12
    if (lamp.current) lamp.current.visible = pilot.landingLights && !wreck.active

    if (spec.retractableGear) {
      const retract = (1 - sim.gearPosition) * QUARTER_TURN
      for (const leg of [noseGear, leftGear, rightGear]) {
        if (leg.current) leg.current.visible = sim.gearPosition > 0.03
      }
      if (noseGear.current) noseGear.current.rotation.x = -retract
      if (leftGear.current) leftGear.current.rotation.z = retract
      if (rightGear.current) rightGear.current.rotation.z = -retract
    }
    const flap = sim.flapPosition * FLAP_TRAVEL
    if (leftFlap.current) leftFlap.current.rotation.x = flap
    if (rightFlap.current) rightFlap.current.rotation.x = flap
    if (leftAileron.current) leftAileron.current.rotation.x = c.roll * AILERON_TRAVEL
    if (rightAileron.current) rightAileron.current.rotation.x = -c.roll * AILERON_TRAVEL
    const airbrake = -sim.speedBrakePosition * AIRBRAKE_TRAVEL
    if (leftBrake.current) leftBrake.current.rotation.x = airbrake
    if (rightBrake.current) rightBrake.current.rotation.x = airbrake
    if (elevator.current) elevator.current.rotation.x = -(c.pitch + c.trim * 0.3) * ELEVATOR_TRAVEL
    if (rudder.current) rudder.current.rotation.y = c.yaw * RUDDER_TRAVEL
  })

  const radius = shape.cabinRadius
  const cabinFront = shape.noseZ + 0.9
  const cabinBack = 0.6
  const halfSpan = spec.wingSpan / 2
  const chord = spec.chord
  const [nose, leftMain, rightMain] = spec.contactPoints.map(point => point.position)
  const wheel = 0.21

  /** Gear leg from a mount on the airframe down to its wheel. It swings around the mount. */
  const leg = (
    mount: [number, number, number],
    wheelBottom: Vector3,
    ref: RefObject<Group | null>,
    size: number
  ) => (
    <group ref={ref} position={mount}>
      <Strut
        from={[0, 0, 0]}
        to={[wheelBottom.x - mount[0], wheelBottom.y + size - mount[1], wheelBottom.z - mount[2]]}
        radius={0.045}
        material={paint.dark}
      />
      <Wheel
        position={[
          wheelBottom.x - mount[0],
          wheelBottom.y + size - mount[1],
          wheelBottom.z - mount[2]
        ]}
        radius={size}
        material={paint.dark}
      />
    </group>
  )
  /** Height of the wing's underside at a distance from the centreline. */
  const underWing = (x: number) => shape.wingY + Math.abs(x) * Math.sin(shape.dihedral) - 0.09
  const mainLeg = (bottom: Vector3, ref: RefObject<Group | null>) =>
    shape.highWing
      ? leg([Math.sign(bottom.x) * radius * 0.7, -radius * 0.75, bottom.z], bottom, ref, wheel)
      : leg([bottom.x, underWing(bottom.x), bottom.z], bottom, ref, wheel)

  const wing = (side: 1 | -1) => (
    <>
      <group position={[0, shape.wingY, 0.15]} rotation-z={shape.dihedral * side}>
        {/* A flattened cylinder on its side gives the wing rounded leading and trailing edges */}
        <mesh
          castShadow
          material={paint.body}
          position={[(halfSpan / 2 + 0.05) * side, 0, 0]}
          rotation-z={QUARTER_TURN}
          scale={[0.11, 1, 1]}
        >
          <cylinderGeometry args={[chord / 2, chord / 2, halfSpan - 0.1, 20]} />
        </mesh>
        <mesh
          castShadow
          material={paint.accent}
          position={[halfSpan * side, 0, 0]}
          scale={[0.25, 0.1, chord / 2]}
        >
          <sphereGeometry args={[1, 12, 8]} />
        </mesh>
        <mesh
          material={side === 1 ? paint.green : paint.red}
          position={[(halfSpan + 0.22) * side, 0, -0.2]}
        >
          <sphereGeometry args={[0.06, 8, 6]} />
        </mesh>
        {spec.flapLabels.length > 1 && (
          <group
            ref={side === 1 ? rightFlap : leftFlap}
            position={[halfSpan * 0.34 * side, -0.02, chord / 2 - 0.03]}
          >
            <mesh castShadow material={paint.body} position={[0, 0, 0.2]}>
              <boxGeometry args={[halfSpan * 0.43, 0.06, 0.42]} />
            </mesh>
          </group>
        )}
        <group
          ref={side === 1 ? rightAileron : leftAileron}
          position={[halfSpan * 0.77 * side, -0.02, chord / 2 - 0.03]}
        >
          <mesh castShadow material={paint.body} position={[0, 0, 0.18]}>
            <boxGeometry args={[halfSpan * 0.4, 0.06, 0.38]} />
          </mesh>
        </group>
        {/* Airbrake panel: hinged at its front edge, it lifts out of the top of the wing */}
        <group
          ref={side === 1 ? rightBrake : leftBrake}
          position={[halfSpan * 0.4 * side, 0.09, 0.05]}
        >
          <mesh castShadow material={paint.accent} position={[0, 0, 0.2]}>
            <boxGeometry args={[halfSpan * 0.3, 0.03, 0.4]} />
          </mesh>
        </group>
      </group>
      {shape.highWing && (
        <Strut
          from={[radius * 0.8 * side, -radius * 0.6, 0.1]}
          to={[halfSpan * 0.5 * side, shape.wingY - 0.08, 0.15]}
          radius={0.04}
          material={paint.body}
        />
      )}
      {!shape.highWing &&
        mainLeg(side === 1 ? rightMain : leftMain, side === 1 ? rightGear : leftGear)}
    </>
  )

  return (
    <group ref={airframe.root}>
      <Part airframe={airframe} name="fuselage">
        <mesh
          castShadow
          material={paint.body}
          position={[0, 0, (cabinFront + cabinBack) / 2]}
          rotation-x={QUARTER_TURN}
        >
          <cylinderGeometry args={[radius, radius, cabinBack - cabinFront, 20]} />
        </mesh>
        <mesh
          castShadow
          material={paint.body}
          position={[0, 0.06, (cabinBack + shape.tailZ) / 2]}
          rotation-x={QUARTER_TURN}
        >
          <cylinderGeometry args={[0.14, radius, shape.tailZ - cabinBack, 20]} />
        </mesh>
        {/* Cheat line along the cabin */}
        <mesh
          material={paint.accent}
          position={[0, 0.02, (cabinFront + cabinBack) / 2]}
          rotation-x={QUARTER_TURN}
          scale={[1.05, 1, 0.33]}
        >
          <cylinderGeometry args={[radius, radius, cabinBack - cabinFront, 20, 1, true]} />
        </mesh>
        {shape.highWing ? (
          // Windscreen and side windows wrap the cabin under the wing
          <mesh
            material={paint.glass}
            position={[0, radius * 0.38, -0.55]}
            scale={[radius * 1.03, radius * 0.6, 1]}
          >
            <sphereGeometry args={[1, 20, 14]} />
          </mesh>
        ) : (
          <mesh
            material={paint.glass}
            position={[0, radius * 0.67, spec.camera.eye.z + 0.1]}
            scale={[radius * 0.83, radius * 0.8, 1.15]}
          >
            <sphereGeometry args={[1, 20, 14]} />
          </mesh>
        )}
        {leg([0, -radius * 0.75, nose.z], nose, noseGear, 0.19)}
        {shape.highWing && mainLeg(leftMain, leftGear)}
        {shape.highWing && mainLeg(rightMain, rightGear)}
      </Part>

      <Part airframe={airframe} name="nose">
        {/* Landing light */}
        <group ref={lamp} position={[0, -radius * 0.6, shape.noseZ + 0.35]}>
          <mesh>
            <sphereGeometry args={[0.1, 8, 6]} />
            <meshBasicMaterial color="#fffbe6" toneMapped={false} />
          </mesh>
        </group>
        <mesh
          castShadow
          material={paint.body}
          position={[0, 0, shape.noseZ + 0.45]}
          rotation-x={QUARTER_TURN}
        >
          <cylinderGeometry args={[radius, radius * 0.68, 0.9, 20]} />
        </mesh>
        <mesh
          material={paint.accent}
          position={[0, 0, shape.noseZ + 0.04]}
          rotation-x={QUARTER_TURN}
        >
          <cylinderGeometry args={[radius * 0.69, radius * 0.64, 0.1, 20]} />
        </mesh>
        <group ref={propeller} position={[0, 0, shape.noseZ - 0.02]}>
          <mesh material={paint.dark} position={[0, 0, -0.18]} rotation-x={-QUARTER_TURN}>
            <coneGeometry args={[0.2, 0.42, 16]} />
          </mesh>
          <group ref={blades}>
            {[0, Math.PI].map(turn => (
              <group key={turn} rotation-z={turn}>
                <mesh
                  castShadow
                  material={paint.dark}
                  position={[0, shape.propRadius / 2, 0]}
                  scale={[1, 1, 0.25]}
                >
                  <cylinderGeometry args={[0.03, 0.09, shape.propRadius, 8]} />
                </mesh>
              </group>
            ))}
          </group>
          <group ref={blur}>
            <mesh material={disc}>
              <circleGeometry args={[shape.propRadius, 32]} />
            </mesh>
          </group>
        </group>
      </Part>

      <Part airframe={airframe} name="leftWing">
        {wing(-1)}
      </Part>
      <Part airframe={airframe} name="rightWing">
        {wing(1)}
      </Part>

      <Part airframe={airframe} name="tail">
        <mesh
          castShadow
          material={paint.body}
          position={[0, 0.2, shape.tailZ - 0.5]}
          rotation-z={QUARTER_TURN}
          scale={[0.1, 1, 1]}
        >
          <cylinderGeometry args={[0.42, 0.42, shape.tailSpan, 16]} />
        </mesh>
        <group ref={elevator} position={[0, 0.2, shape.tailZ - 0.12]}>
          <mesh castShadow material={paint.body} position={[0, 0, 0.2]}>
            <boxGeometry args={[shape.tailSpan, 0.05, 0.42]} />
          </mesh>
        </group>
        <mesh
          castShadow
          material={paint.accent}
          position={[0, 0.2 + shape.finHeight / 2, shape.tailZ - 0.55]}
          scale={[0.1, 1, 1]}
        >
          <cylinderGeometry args={[0.3, 0.5, shape.finHeight, 16]} />
        </mesh>
        <group ref={rudder} position={[0, 0.2 + shape.finHeight / 2, shape.tailZ - 0.1]}>
          <mesh castShadow material={paint.accent} position={[0, 0, 0.2]}>
            <boxGeometry args={[0.07, shape.finHeight * 0.96, 0.4]} />
          </mesh>
        </group>
        <group ref={beacon} position={[0, 0.26 + shape.finHeight, shape.tailZ - 0.55]}>
          <mesh material={paint.red}>
            <sphereGeometry args={[0.08, 8, 6]} />
          </mesh>
        </group>
      </Part>
    </group>
  )
}

/** Flat panel with the outline `points` (x, z pairs) in the XZ plane, `thickness` tall. */
function plateGeometry(points: [number, number][], thickness: number) {
  const half = thickness / 2
  const positions: number[] = []
  const corner = (index: number, y: number) => {
    const [x, z] = points[index % points.length]
    positions.push(x, y, z)
  }
  for (let i = 1; i < points.length - 1; i++) {
    // Top and bottom faces, fanned out from the first corner
    for (const index of [0, i + 1, i]) corner(index, half)
    for (const index of [0, i, i + 1]) corner(index, -half)
  }
  for (let i = 0; i < points.length; i++) {
    for (const [index, y] of [
      [i, half],
      [i + 1, half],
      [i, -half],
      [i + 1, half],
      [i + 1, -half],
      [i, -half]
    ]) {
      corner(index, y)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.computeVertexNormals()
  return geometry
}

/** Mirrors an outline across the centreline for the left-hand side. */
const mirrored = (points: [number, number][]): [number, number][] =>
  points.map(([x, z]) => [-x, z] as [number, number]).reverse()

type Outline = [number, number][]

/** Outlines and layout that differ between the two fighters. Outlines are (x, z) pairs. */
const FIGHTERS = {
  f16: {
    wing: [
      [0.85, -0.8],
      [4.6, 2.3],
      [4.6, 3.3],
      [0.85, 3.1]
    ] as Outline,
    strake: [
      [0.45, -3.4],
      [0.85, -0.8],
      [0.85, 1.2],
      [0.45, 1.2]
    ] as Outline,
    flaperon: [
      [0.9, 0],
      [4.5, 0.2],
      [4.5, 0.55],
      [0.9, 0.75]
    ] as Outline,
    flaperonZ: 3.15,
    stabilator: [
      [0.6, -1],
      [2.8, 0.25],
      [2.8, 0.95],
      [0.6, 0.8]
    ] as Outline,
    // Height and distance aft, turned upright when built
    fin: [
      [0.6, 3.9],
      [3.4, 6.25],
      [3.4, 7.15],
      [0.6, 7.3]
    ] as Outline,
    // Sideways position and outward lean of each fin
    fins: [[0, 0]],
    bodyWidth: 1.3,
    noseWidth: 1,
    canopyZ: -3.3,
    chinIntake: true,
    missiles: 4.72
  },
  f35: {
    wing: [
      [1.5, -1],
      [5.3, 2.5],
      [5.3, 3.5],
      [1.5, 3.7]
    ] as Outline,
    strake: [
      [0.7, -4.6],
      [1.5, -1],
      [1.5, 1.2],
      [0.7, 1.2]
    ] as Outline,
    flaperon: [
      [1.6, 0],
      [5.2, -0.15],
      [5.2, 0.3],
      [1.6, 0.75]
    ] as Outline,
    flaperonZ: 3.7,
    stabilator: [
      [1.3, -1],
      [3.6, 0.5],
      [3.6, 1.1],
      [1.3, 1.1]
    ] as Outline,
    fin: [
      [0.5, 4.4],
      [2.8, 6.3],
      [2.8, 7],
      [0.5, 7.2]
    ] as Outline,
    fins: [
      [1.25, 0.42],
      [-1.25, -0.42]
    ],
    bodyWidth: 1.95,
    noseWidth: 1.35,
    canopyZ: -4.1,
    chinIntake: false,
    missiles: 0
  }
}

/** Jet fighter: blended body, swept wing, bubble canopy, and an all-moving tailplane. */
function FighterModel(props: { spec: AircraftSpec; shape: Extract<Shape, { type: 'fighter' }> }) {
  const { spec, shape } = props
  const layout = FIGHTERS[shape.variant]
  const airframe = useAirframe(spec, shape.paint, shape.accent)
  const { paint } = airframe
  const geometry = useMemo(
    () => ({
      rightWing: plateGeometry(layout.wing, 0.14),
      leftWing: plateGeometry(mirrored(layout.wing), 0.14),
      rightStrake: plateGeometry(layout.strake, 0.16),
      leftStrake: plateGeometry(mirrored(layout.strake), 0.16),
      rightFlaperon: plateGeometry(layout.flaperon, 0.1),
      leftFlaperon: plateGeometry(mirrored(layout.flaperon), 0.1),
      rightStabilator: plateGeometry(layout.stabilator, 0.1),
      leftStabilator: plateGeometry(mirrored(layout.stabilator), 0.1),
      fin: plateGeometry(layout.fin, 0.14).rotateZ(QUARTER_TURN)
    }),
    [layout]
  )
  const flames = useMemo(() => {
    const glow = { transparent: true, depthWrite: false, toneMapped: false }
    return {
      outer: new MeshBasicMaterial({ ...glow, color: '#ff6a14', opacity: 0.55 }),
      core: new MeshBasicMaterial({ ...glow, color: '#ffe9a8', opacity: 0.9 })
    }
  }, [])
  const burner = useRef<Group>(null)
  const beacon = useRef<Group>(null)
  const lamp = useRef<Group>(null)
  const noseGear = useRef<Group>(null)
  const leftGear = useRef<Group>(null)
  const rightGear = useRef<Group>(null)
  const leftFlaperon = useRef<Group>(null)
  const rightFlaperon = useRef<Group>(null)
  const leftStabilator = useRef<Group>(null)
  const rightStabilator = useRef<Group>(null)
  const leftBrake = useRef<Group>(null)
  const rightBrake = useRef<Group>(null)

  useFrame(({ clock }) => {
    const { sim, pilot, wreck } = game
    const c = pilot.controls
    if (burner.current) {
      burner.current.visible = sim.afterburner && !wreck.active
      // The flame flickers in length
      burner.current.scale.z = 0.85 + Math.random() * 0.3
    }
    if (beacon.current) beacon.current.visible = !wreck.active && clock.elapsedTime % 1 < 0.12
    if (lamp.current) lamp.current.visible = pilot.landingLights && !wreck.active

    const retract = (1 - sim.gearPosition) * QUARTER_TURN
    for (const leg of [noseGear, leftGear, rightGear]) {
      if (leg.current) leg.current.visible = sim.gearPosition > 0.03
    }
    if (noseGear.current) noseGear.current.rotation.x = -retract
    if (leftGear.current) leftGear.current.rotation.x = retract
    if (rightGear.current) rightGear.current.rotation.x = retract

    // Flaperons droop together as flaps and move against each other to roll
    const flap = sim.flapPosition * 0.35
    if (leftFlaperon.current) leftFlaperon.current.rotation.x = flap + c.roll * 0.3
    if (rightFlaperon.current) rightFlaperon.current.rotation.x = flap - c.roll * 0.3
    // The whole tailplane moves, and helps the roll
    const pitch = -(c.pitch + c.trim * 0.3) * 0.35
    if (leftStabilator.current) leftStabilator.current.rotation.x = pitch + c.roll * 0.12
    if (rightStabilator.current) rightStabilator.current.rotation.x = pitch - c.roll * 0.12
    if (leftBrake.current) leftBrake.current.rotation.y = -sim.speedBrakePosition * 0.9
    if (rightBrake.current) rightBrake.current.rotation.y = sim.speedBrakePosition * 0.9
  })

  const [nose, leftMain, rightMain] = spec.contactPoints.map(point => point.position)
  const leg = (bottom: Vector3, ref: RefObject<Group | null>, size: number) => (
    <group ref={ref} position={[bottom.x * 0.75, -0.6, bottom.z]}>
      <Strut
        from={[0, 0, 0]}
        to={[bottom.x * 0.25, bottom.y + size + 0.6, 0]}
        radius={0.07}
        material={paint.dark}
      />
      <Wheel
        position={[bottom.x * 0.25, bottom.y + size + 0.6, 0]}
        radius={size}
        material={paint.dark}
      />
    </group>
  )
  const wing = (side: 1 | -1) => (
    <>
      <mesh
        castShadow
        material={paint.body}
        geometry={side === 1 ? geometry.rightWing : geometry.leftWing}
      />
      <group ref={side === 1 ? rightFlaperon : leftFlaperon} position={[0, 0, layout.flaperonZ]}>
        <mesh
          castShadow
          material={paint.body}
          geometry={side === 1 ? geometry.rightFlaperon : geometry.leftFlaperon}
        />
      </group>
      {layout.missiles > 0 && (
        <mesh
          castShadow
          material={paint.accent}
          position={[layout.missiles * side, 0, 2.7]}
          rotation-x={QUARTER_TURN}
        >
          <cylinderGeometry args={[0.07, 0.07, 2.9, 8]} />
        </mesh>
      )}
      <mesh
        material={side === 1 ? paint.green : paint.red}
        position={[layout.wing[1][0] * side, 0, layout.wing[1][1]]}
      >
        <sphereGeometry args={[0.07, 8, 6]} />
      </mesh>
    </>
  )

  return (
    <group ref={airframe.root}>
      <Part airframe={airframe} name="fuselage">
        {/* Wide, flattened centre body that blends into the wings */}
        <mesh
          castShadow
          material={paint.body}
          position={[0, 0, 0.5]}
          rotation-x={QUARTER_TURN}
          scale={[layout.bodyWidth, 1, 0.82]}
        >
          <cylinderGeometry args={[0.85, 0.75, 6, 24]} />
        </mesh>
        <mesh
          castShadow
          material={paint.body}
          position={[0, 0, 5.25]}
          rotation-x={QUARTER_TURN}
          scale={[layout.bodyWidth * 0.88, 1, 0.9]}
        >
          <cylinderGeometry args={[0.62, 0.85, 3.5, 24]} />
        </mesh>
        <mesh castShadow material={paint.dark} position={[0, 0, 7.3]} rotation-x={QUARTER_TURN}>
          <cylinderGeometry args={[0.5, 0.64, 0.7, 24, 1, true]} />
        </mesh>
        <mesh castShadow material={paint.body} geometry={geometry.rightStrake} />
        <mesh castShadow material={paint.body} geometry={geometry.leftStrake} />
        {layout.chinIntake ? (
          <>
            <mesh
              castShadow
              material={paint.body}
              position={[0, -0.72, -0.9]}
              rotation-x={QUARTER_TURN}
              scale={[1, 1, 0.55]}
            >
              <cylinderGeometry args={[0.62, 0.58, 4.2, 20]} />
            </mesh>
            <mesh material={paint.dark} position={[0, -0.72, -3.01]} scale={[1, 0.55, 1]}>
              <circleGeometry args={[0.5, 20]} />
            </mesh>
          </>
        ) : (
          // One slanted intake on each side of the cockpit
          [-1, 1].map(side => (
            <group key={side} position={[1.05 * side, -0.1, -2.2]}>
              <mesh castShadow material={paint.body} position={[0, 0, 1.4]}>
                <boxGeometry args={[0.85, 0.95, 3.4]} />
              </mesh>
              <mesh material={paint.dark} position={[0, 0, -0.31]}>
                <planeGeometry args={[0.7, 0.8]} />
              </mesh>
            </group>
          ))
        )}
        <group ref={burner} position={[0, 0, 7.6]}>
          <mesh material={flames.outer} position={[0, 0, 2.1]} rotation-x={QUARTER_TURN}>
            <coneGeometry args={[0.47, 4.2, 16, 1, true]} />
          </mesh>
          <mesh material={flames.core} position={[0, 0, 1.1]} rotation-x={QUARTER_TURN}>
            <coneGeometry args={[0.28, 2.2, 16, 1, true]} />
          </mesh>
        </group>
        {/* Airbrakes: two panels that swing out from the sides of the tail */}
        <group ref={leftBrake} position={[-0.72 * layout.bodyWidth * 0.8, 0, 5.9]}>
          <mesh castShadow material={paint.accent} position={[0, 0, 0.55]}>
            <boxGeometry args={[0.06, 0.7, 1.1]} />
          </mesh>
        </group>
        <group ref={rightBrake} position={[0.72 * layout.bodyWidth * 0.8, 0, 5.9]}>
          <mesh castShadow material={paint.accent} position={[0, 0, 0.55]}>
            <boxGeometry args={[0.06, 0.7, 1.1]} />
          </mesh>
        </group>
        {leg(leftMain, leftGear, 0.3)}
        {leg(rightMain, rightGear, 0.3)}
      </Part>

      <Part airframe={airframe} name="nose">
        <mesh
          castShadow
          material={paint.accent}
          position={[0, 0, -6.3]}
          rotation-x={-QUARTER_TURN}
          scale={[layout.noseWidth, 1, 1]}
        >
          <coneGeometry args={[0.42, 2.4, 24]} />
        </mesh>
        <mesh
          castShadow
          material={paint.body}
          position={[0, 0, -3.8]}
          rotation-x={QUARTER_TURN}
          scale={[layout.noseWidth, 1, 1]}
        >
          <cylinderGeometry args={[0.76, 0.42, 2.6, 24]} />
        </mesh>
        <mesh material={paint.glass} position={[0, 0.58, layout.canopyZ]} scale={[0.46, 0.55, 1.8]}>
          <sphereGeometry args={[1, 24, 16]} />
        </mesh>
        {leg(nose, noseGear, 0.24)}
        {/* Landing light */}
        <group ref={lamp} position={[0, nose.y + 0.9, nose.z - 0.15]}>
          <mesh>
            <sphereGeometry args={[0.1, 8, 6]} />
            <meshBasicMaterial color="#fffbe6" toneMapped={false} />
          </mesh>
        </group>
      </Part>

      <Part airframe={airframe} name="leftWing">
        {wing(-1)}
      </Part>
      <Part airframe={airframe} name="rightWing">
        {wing(1)}
      </Part>

      <Part airframe={airframe} name="tail">
        {layout.fins.map(([x, lean]) => (
          <group key={x} position={[x, 0, 0]} rotation-z={-lean}>
            <mesh castShadow material={paint.body} geometry={geometry.fin} />
          </group>
        ))}
        <group ref={rightStabilator} position={[0, -0.05, 6.3]}>
          <mesh castShadow material={paint.body} geometry={geometry.rightStabilator} />
        </group>
        <group ref={leftStabilator} position={[0, -0.05, 6.3]}>
          <mesh castShadow material={paint.body} geometry={geometry.leftStabilator} />
        </group>
        <group ref={beacon} position={[0, 0.95, 4.2]}>
          <mesh material={paint.red}>
            <sphereGeometry args={[0.09, 8, 6]} />
          </mesh>
        </group>
      </Part>
    </group>
  )
}

/**
 * Fuselage tube from nose to tail in two pieces, split where the aircraft breaks apart.
 * Texture coordinates run along the body (u) and around it from the belly (v).
 */
function fuselageGeometry(shape: AirlinerShape) {
  const stations = 56
  const around = 28
  const { radius, tall, noseZ, tailZ } = shape
  const noseLength = radius * 2.6
  const tailLength = radius * 6
  const positions: number[] = []
  const uvs: number[] = []
  for (let i = 0; i <= stations; i++) {
    const along = i / stations
    const z = noseZ + along * (tailZ - noseZ)
    // Rounded nose, constant cabin, then a tail cone that sweeps upward
    const intoNose = Math.max(0, 1 - (z - noseZ) / noseLength)
    const intoTail = Math.max(0, (z - (tailZ - tailLength)) / tailLength)
    const r = radius * Math.max(0.04, Math.sqrt(1 - intoNose ** 2.2) * (1 - 0.9 * intoTail ** 1.5))
    const lift = radius * (0.75 * intoTail ** 2 - 0.25 * intoNose ** 2)
    for (let j = 0; j <= around; j++) {
      const angle = (j / around) * Math.PI * 2
      positions.push(r * Math.sin(angle), -r * Math.cos(angle) * tall + lift, z)
      uvs.push(along, j / around)
    }
  }
  const split = Math.round(stations * 0.2)
  const section = (from: number, to: number) => {
    const index: number[] = []
    for (let i = from; i < to; i++) {
      for (let j = 0; j < around; j++) {
        const a = i * (around + 1) + j
        const b = a + around + 1
        index.push(a, a + 1, b, b, a + 1, b + 1)
      }
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
    geometry.setIndex(index)
    geometry.computeVertexNormals()
    return geometry
  }
  return { nose: section(0, split), body: section(split, stations) }
}

/** Paints the fuselage: belly, cabin windows on each deck, cockpit windows, and a cheat line. */
function liveryTexture(shape: AirlinerShape) {
  const canvas = document.createElement('canvas')
  canvas.width = 2048
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Airliner paint needs a 2D canvas, which this browser refused')
  const { width, height } = canvas
  // Canvas rows run around the fuselage: 0 at the belly, 0.25 on the right, 0.5 on top
  const row = (around: number) => (1 - around) * height
  ctx.fillStyle = shape.paint
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#b9bdc0'
  ctx.fillRect(0, row(0.1), width, height)
  ctx.fillRect(0, 0, width, row(0.9))
  ctx.fillStyle = shape.accent
  for (const side of [0.215, 0.785]) ctx.fillRect(width * 0.05, row(side) - 2, width * 0.84, 4)
  ctx.fillStyle = '#1b2530'
  const decks = shape.decks === 2 ? [0.262, 0.345] : [0.285]
  const pitch = (0.52 / (shape.tailZ - shape.noseZ)) * width
  for (const deck of decks) {
    for (const around of [deck, 1 - deck]) {
      for (let x = width * 0.13; x < width * 0.83; x += pitch) {
        ctx.fillRect(x, row(around) - 3, pitch * 0.45, 6)
      }
    }
  }
  // Cockpit windows wrap the top of the nose
  ctx.fillRect(width * 0.035, row(0.44), width * 0.022, row(0.3) - row(0.44))
  ctx.fillRect(width * 0.035, row(0.7), width * 0.022, row(0.56) - row(0.7))
  ctx.fillRect(width * 0.028, row(0.56), width * 0.012, row(0.44) - row(0.56))
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 8
  return texture
}

/** Geometry and paint for an airliner's fuselage, wings, moving panels, and tail. */
export function airlinerParts(shape: AirlinerShape) {
  const { wing, radius } = shape
  const rootX = radius * 0.85
  const outline: Outline = [
    [rootX, wing.rootZ],
    [wing.halfSpan, wing.tipZ],
    [wing.halfSpan, wing.tipZ + wing.tipChord],
    [rootX + (wing.halfSpan - rootX) * 0.32, wing.rootZ + wing.rootChord * 0.78],
    [rootX, wing.rootZ + wing.rootChord]
  ]
  // Trailing-edge panels: flaps inboard, spoilers ahead of them
  const trailing = (from: number, to: number, chord: number, back: number): Outline => {
    const edge = (share: number) =>
      wing.rootZ +
      wing.rootChord * 0.8 +
      (wing.tipZ + wing.tipChord - wing.rootZ - wing.rootChord * 0.8) * share
    const x1 = rootX + (wing.halfSpan - rootX) * from
    const x2 = rootX + (wing.halfSpan - rootX) * to
    return [
      [x1, edge(from) - chord * (1 - back)],
      [x2, edge(to) - chord * 0.6 * (1 - back)],
      [x2, edge(to) + chord * 0.6 * back],
      [x1, edge(from) + chord * back]
    ]
  }
  const flap = trailing(0.06, 0.7, wing.rootChord * 0.24, 0.9)
  const spoiler = trailing(0.2, 0.68, wing.rootChord * 0.16, -0.6)
  const stabChord = shape.tailSpan * 0.36
  const stabZ = shape.tailZ - stabChord - radius * 0.9
  const stab: Outline = [
    [radius * 0.25, stabZ],
    [shape.tailSpan / 2, stabZ + shape.tailSpan * 0.3],
    [shape.tailSpan / 2, stabZ + shape.tailSpan * 0.3 + stabChord * 0.4],
    [radius * 0.25, stabZ + stabChord]
  ]
  const finChord = shape.finHeight * 0.95
  const finZ = shape.tailZ - finChord - radius * 0.6
  const fin: Outline = [
    [0, finZ],
    [shape.finHeight, finZ + shape.finHeight * 0.72],
    [shape.finHeight, finZ + shape.finHeight * 0.72 + finChord * 0.36],
    [0, finZ + finChord]
  ]
  const thick = wing.rootChord * 0.055
  return {
    fuselage: fuselageGeometry(shape),
    skin: new MeshStandardMaterial({
      map: liveryTexture(shape),
      roughness: 0.38,
      metalness: 0.1
    }),
    wings: [plateGeometry(mirrored(outline), thick), plateGeometry(outline, thick)],
    flaps: [plateGeometry(mirrored(flap), thick * 0.5), plateGeometry(flap, thick * 0.5)],
    spoilers: [plateGeometry(mirrored(spoiler), thick * 0.2), plateGeometry(spoiler, thick * 0.2)],
    stabs: [plateGeometry(mirrored(stab), thick * 0.5), plateGeometry(stab, thick * 0.5)],
    fin: plateGeometry(fin, thick * 0.6).rotateZ(QUARTER_TURN),
    thick
  }
}

/** Left and right wheel on each axle of a gear truck, as [side, axle] pairs. */
const wheelSpots = (axles: number) =>
  Array.from({ length: axles * 2 }, (_, i): [number, number] => [i % 2 ? 1 : -1, Math.floor(i / 2)])

/** Jet airliner sized from its specification: one or two decks, two or four engines. */
function AirlinerModel({ spec, shape }: { spec: AircraftSpec; shape: AirlinerShape }) {
  const airframe = useAirframe(spec, shape.paint, shape.accent)
  const { paint } = airframe
  const { wing, radius } = shape
  const top = radius * shape.tall
  const length = shape.tailZ - shape.noseZ
  const tailLift = radius * 0.75

  const built = useMemo(() => airlinerParts(shape), [shape])
  useDisposal(built)

  const flaps = useRef<(Group | null)[]>([])
  const spoilers = useRef<(Group | null)[]>([])
  const stabs = useRef<Group>(null)
  const gear = useRef<(Group | null)[]>([])
  const beacon = useRef<Group>(null)
  const strobes = useRef<(Group | null)[]>([])
  const lamps = useRef<(Group | null)[]>([])

  useFrame(({ clock }) => {
    const { sim, pilot, wreck } = game
    const blink = clock.elapsedTime % 1.2
    if (beacon.current) beacon.current.visible = !wreck.active && clock.elapsedTime % 1 < 0.12
    for (const strobe of strobes.current) {
      if (strobe) strobe.visible = !wreck.active && (blink < 0.05 || (blink > 0.15 && blink < 0.2))
    }
    for (const lamp of lamps.current) if (lamp) lamp.visible = pilot.landingLights && !wreck.active
    // Flaps slide back and down as they extend
    for (const flap of flaps.current) {
      if (!flap) continue
      flap.position.set(
        0,
        -sim.flapPosition * built.thick * 1.6,
        sim.flapPosition * wing.rootChord * 0.1
      )
      flap.rotation.x = sim.flapPosition * 0.12
    }
    for (const spoiler of spoilers.current) {
      if (spoiler)
        spoiler.position.y = built.thick * 0.6 + sim.speedBrakePosition * built.thick * 1.4
    }
    if (stabs.current) stabs.current.rotation.x = -pilot.controls.pitch * 0.12
    // Gear legs swing sideways into the wing roots, the nose leg forward
    const retract = (1 - sim.gearPosition) * QUARTER_TURN
    gear.current.forEach((leg, i) => {
      if (!leg) return
      leg.visible = sim.gearPosition > 0.03
      if (i === 0) leg.rotation.x = retract
      else leg.rotation.z = i % 2 ? retract : -retract
    })
  })

  const [nose, leftMain, rightMain] = spec.contactPoints.map(point => point.position)
  const tyre = -nose.y * 0.16
  /** Gear leg with a truck of wheels. `pairs` is how many axles the truck has. */
  const leg = (index: number, bottom: Vector3, pairs: number, mountY: number) => {
    const drop = bottom.y + tyre - mountY
    return (
      <group
        key={index}
        ref={group => {
          gear.current[index] = group
        }}
        position={[bottom.x, mountY, bottom.z]}
      >
        <Strut from={[0, 0, 0]} to={[0, drop, 0]} radius={tyre * 0.22} material={paint.dark} />
        {wheelSpots(pairs).map(([side, axle]) => (
          <Wheel
            key={`${axle} ${side}`}
            position={[side * tyre * 0.75, drop, (axle - (pairs - 1) / 2) * tyre * 2.3]}
            radius={index === 0 ? tyre * 0.8 : tyre}
            material={paint.dark}
          />
        ))}
      </group>
    )
  }
  const trucks = spec.mass > 300_000 ? 3 : spec.mass > 120_000 ? 2 : 1

  const wingPart = (side: 0 | 1) => {
    const sign = side === 1 ? 1 : -1
    const tipSize = wing.tipChord
    return (
      <>
        <group position={[0, wing.y, 0]} rotation-z={wing.dihedral * sign}>
          <mesh castShadow material={paint.body} geometry={built.wings[side]} />
          <group
            ref={group => {
              flaps.current[side] = group
            }}
          >
            <mesh castShadow material={paint.body} geometry={built.flaps[side]} />
          </group>
          <group
            ref={group => {
              spoilers.current[side] = group
            }}
          >
            <mesh material={paint.accent} geometry={built.spoilers[side]} />
          </group>
          {/* Wingtip device: blended sharklet, split scimitar, or a fence above and below */}
          {wing.tip !== 'raked' && (
            <mesh
              castShadow
              material={paint.accent}
              position={[
                wing.halfSpan * sign,
                wing.tip === 'sharklet' ? tipSize * 0.6 : 0,
                wing.tipZ + tipSize * 0.7
              ]}
              rotation-z={wing.tip === 'sharklet' ? -0.25 * sign : 0}
            >
              <boxGeometry
                args={[0.12, tipSize * (wing.tip === 'sharklet' ? 1.3 : 1.6), tipSize * 0.75]}
              />
            </mesh>
          )}
          <mesh
            material={side === 1 ? paint.green : paint.red}
            position={[wing.halfSpan * sign, 0, wing.tipZ]}
          >
            <sphereGeometry args={[0.16, 8, 6]} />
          </mesh>
          <group
            ref={group => {
              strobes.current[side] = group
            }}
            position={[wing.halfSpan * sign, 0, wing.tipZ + tipSize]}
          >
            <mesh>
              <sphereGeometry args={[0.2, 8, 6]} />
              <meshBasicMaterial color="#ffffff" toneMapped={false} />
            </mesh>
          </group>
        </group>
        {shape.engines.map(([x, z]) => {
          const wingUnder = wing.y + x * Math.sin(wing.dihedral) - built.thick
          return (
            <group key={x} position={[x * sign, shape.engineY, z]}>
              <mesh
                castShadow
                material={paint.body}
                position={[0, 0, shape.engineLength / 2]}
                rotation-x={QUARTER_TURN}
              >
                <cylinderGeometry
                  args={[
                    shape.engineRadius * 0.7,
                    shape.engineRadius,
                    shape.engineLength,
                    28,
                    1,
                    true
                  ]}
                />
              </mesh>
              <mesh material={paint.accent} position={[0, 0, 0.15]} rotation-x={QUARTER_TURN}>
                <cylinderGeometry
                  args={[shape.engineRadius * 1.02, shape.engineRadius * 0.96, 0.3, 28, 1, true]}
                />
              </mesh>
              <mesh
                material={paint.dark}
                position={[0, 0, shape.engineLength * 0.12]}
                rotation-y={Math.PI}
              >
                <circleGeometry args={[shape.engineRadius * 0.97, 28]} />
              </mesh>
              <mesh
                material={paint.dark}
                position={[0, 0, shape.engineLength * 1.02]}
                rotation-x={QUARTER_TURN}
              >
                <coneGeometry args={[shape.engineRadius * 0.45, shape.engineLength * 0.45, 16]} />
              </mesh>
              {/* Pylon up to the wing */}
              <mesh
                castShadow
                material={paint.body}
                position={[
                  0,
                  (wingUnder - shape.engineY + shape.engineRadius) / 2,
                  shape.engineLength * 0.65
                ]}
              >
                <boxGeometry
                  args={[
                    0.3,
                    Math.max(0.2, wingUnder - shape.engineY - shape.engineRadius * 0.6),
                    shape.engineLength * 0.9
                  ]}
                />
              </mesh>
            </group>
          )
        })}
        {leg(side + 1, side === 1 ? rightMain : leftMain, trucks, wing.y - built.thick)}
        <group
          ref={group => {
            lamps.current[side] = group
          }}
          position={[radius * 1.3 * sign, wing.y, wing.rootZ + 0.4]}
        >
          <mesh>
            <sphereGeometry args={[0.28, 10, 8]} />
            <meshBasicMaterial color="#fffbe6" toneMapped={false} />
          </mesh>
        </group>
      </>
    )
  }

  return (
    <group ref={airframe.root}>
      <Part airframe={airframe} name="fuselage">
        <mesh castShadow material={built.skin} geometry={built.fuselage.body} />
        <group ref={beacon} position={[0, top + 0.15, 0]}>
          <mesh material={paint.red}>
            <sphereGeometry args={[0.25, 8, 6]} />
          </mesh>
        </group>
      </Part>
      <Part airframe={airframe} name="nose">
        <mesh castShadow material={built.skin} geometry={built.fuselage.nose} />
        {leg(0, nose, 1, -radius * 0.8)}
      </Part>
      <Part airframe={airframe} name="leftWing">
        {wingPart(0)}
      </Part>
      <Part airframe={airframe} name="rightWing">
        {wingPart(1)}
      </Part>
      <Part airframe={airframe} name="tail">
        <group ref={stabs} position={[0, tailLift * 0.55, shape.tailZ - length * 0.07]}>
          <group position={[0, 0, -(shape.tailZ - length * 0.07)]}>
            <mesh castShadow material={paint.body} geometry={built.stabs[0]} />
            <mesh castShadow material={paint.body} geometry={built.stabs[1]} />
          </group>
        </group>
        <mesh
          castShadow
          material={paint.accent}
          geometry={built.fin}
          position={[0, top * 0.7 + tailLift * 0.5, 0]}
        />
      </Part>
    </group>
  )
}

// Concorde: where the nose hinges down, and how far it droops at full travel
const NOSE_HINGE_Z = -25.2
const NOSE_HINGE_Y = -1.1
const NOSE_DROOP = (12.5 * Math.PI) / 180
// Wing stations from root to tip as [x, leading edge z, trailing edge z, thickness]
const CONCORDE_WING: WingStation[] = [
  [1.2, -14, 24.2, 0.75],
  [2, -8, 24.2, 0.7],
  [3, -2.5, 24.2, 0.62],
  [4.3, 3, 24.2, 0.52],
  [6, 8.5, 24.1, 0.42],
  [8, 13, 24, 0.32],
  [10, 17, 23.9, 0.24],
  [11.6, 20.2, 23.8, 0.18],
  [12.8, 22.4, 23.7, 0.12]
]
// Elevons along the trailing edge: inboard x, outboard x
const ELEVONS: [number, number][] = [
  [1.4, 5],
  [5.2, 8.8],
  [9, 12.4]
]
const ELEVON_CHORD = 2.2

/** Radius and centreline height of Concorde's fuselage at a station along the body. */
function concordeSection(z: number) {
  const { radius, noseZ, tailZ } = CONCORDE_BODY
  // A long needle nose, a constant cabin, then a tail cone that sweeps up
  const intoNose = Math.max(0, 1 - (z - noseZ) / 9)
  const intoTail = Math.max(0, (z - (tailZ - 11.5)) / 11.5)
  const r = radius * Math.max(0.03, (1 - intoNose ** 1.7) * (1 - 0.78 * intoTail ** 1.4))
  return { r, lift: 0.75 * intoTail ** 2 - 0.15 * intoNose ** 2 }
}

const CONCORDE_BODY = { radius: 1.45, tall: 1.05, noseZ: -32, tailZ: 29.7 }

/**
 * Concorde's fuselage in three pieces: the drooping nose ahead of the hinge, the cockpit
 * section, and the cabin and tail. Texture u runs along the whole body.
 */
function concordeFuselage() {
  const { tall, noseZ, tailZ } = CONCORDE_BODY
  const around = 28
  const build = (from: number, to: number, stations: number) => {
    const positions: number[] = []
    const uvs: number[] = []
    for (let i = 0; i <= stations; i++) {
      const z = from + ((to - from) * i) / stations
      const { r, lift } = concordeSection(z)
      for (let j = 0; j <= around; j++) {
        const angle = (j / around) * Math.PI * 2
        positions.push(r * Math.sin(angle), -r * Math.cos(angle) * tall + lift, z)
        uvs.push((z - noseZ) / (tailZ - noseZ), j / around)
      }
    }
    const index: number[] = []
    for (let i = 0; i < stations; i++) {
      for (let j = 0; j < around; j++) {
        const a = i * (around + 1) + j
        const b = a + around + 1
        index.push(a, a + 1, b, b, a + 1, b + 1)
      }
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
    geometry.setIndex(index)
    geometry.computeVertexNormals()
    return geometry
  }
  return {
    droop: build(noseZ, NOSE_HINGE_Z, 16),
    cockpit: build(NOSE_HINGE_Z, -16, 10),
    body: build(-16, tailZ, 40)
  }
}

/** White paint, a blue and a red line along the windows, small cabin windows, and the windscreen. */
function concordeLivery(paint: string, accent: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 2048
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Concorde paint needs a 2D canvas, which this browser refused')
  const { width, height } = canvas
  const { noseZ, tailZ } = CONCORDE_BODY
  const u = (z: number) => ((z - noseZ) / (tailZ - noseZ)) * width
  // Canvas rows run around the fuselage: 0 at the belly, 0.25 on the right, 0.5 on top
  const row = (around: number) => (1 - around) * height
  ctx.fillStyle = paint
  ctx.fillRect(0, 0, width, height)
  for (const side of [0.3, 0.7]) {
    const below = side < 0.5 ? -1 : 1
    ctx.fillStyle = accent
    ctx.fillRect(u(-24), row(side + below * 0.035) - 2, u(25) - u(-24), 4)
    ctx.fillStyle = '#b3262d'
    ctx.fillRect(u(-24), row(side + below * 0.05) - 1, u(25) - u(-24), 2)
    // Concorde's windows are famously small
    ctx.fillStyle = '#1b2530'
    for (let z = -21; z < 15; z += 0.52) ctx.fillRect(u(z), row(side) - 3, u(0.22) - u(0), 6)
  }
  // Windscreen behind the hinge, and the visor that covers it on the nose
  ctx.fillStyle = '#16202a'
  ctx.fillRect(u(-25), row(0.62), u(-23.7) - u(-25), row(0.38) - row(0.62))
  ctx.fillRect(u(-27.4), row(0.56), u(-25.4) - u(-27.4), row(0.44) - row(0.56))
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 8
  return texture
}

/** Spanwise wing stations from root to tip as [x, leading edge z, trailing edge z, thickness]. */
type WingStation = [number, number, number, number]

/**
 * One half of a wing as a solid of top and bottom skins between spanwise stations, thickest
 * a third of the way back and thin at both edges. `side` -1 mirrors it to the left, and
 * `skins` picks the top, the bottom, or both, so the two can take different paint.
 */
function wingGeometry(
  stations: WingStation[],
  side: 1 | -1,
  skins: 'both' | 'top' | 'bottom' = 'both'
) {
  const positions: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    // Two triangles a-b-c and a-c-d, wound to face outward on the right half
    const order = side === 1 ? [a, b, c, a, c, d] : [a, c, b, a, d, c]
    for (const point of order) positions.push(point[0] * side, point[1], point[2])
  }
  const signs = skins === 'both' ? [1, -1] : [skins === 'top' ? 1 : -1]
  for (let i = 0; i < stations.length - 1; i++) {
    const [x1, le1, te1, t1] = stations[i]
    const [x2, le2, te2, t2] = stations[i + 1]
    const mid1 = le1 + (te1 - le1) * 0.35
    const mid2 = le2 + (te2 - le2) * 0.35
    for (const sign of signs) {
      const y1 = (sign * t1) / 2
      const y2 = (sign * t2) / 2
      const front = [
        [x1, 0, le1],
        [x1, y1, mid1],
        [x2, y2, mid2],
        [x2, 0, le2]
      ]
      const back = [
        [x1, y1, mid1],
        [x1, 0, te1],
        [x2, 0, te2],
        [x2, y2, mid2]
      ]
      for (const panel of [front, back]) {
        if (sign === 1) quad(panel[0], panel[1], panel[2], panel[3])
        else quad(panel[0], panel[3], panel[2], panel[1])
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.computeVertexNormals()
  return geometry
}

/** The stations between `from` and `to` metres out, cut exactly at both ends. */
function wingSlice(stations: WingStation[], from: number, to: number): WingStation[] {
  const at = (x: number): WingStation => {
    const i = Math.max(0, stations.findIndex(([next]) => next >= x) - 1)
    const [a, b] = [stations[i], stations[Math.min(i + 1, stations.length - 1)]]
    const t = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0])
    return [x, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]
  }
  return [at(from), ...stations.filter(([x]) => x > from && x < to), at(to)]
}

/** Concorde: slender body, ogival delta wing, four engines in two nacelles, and a drooping nose. */
function ConcordeModel({ spec, shape }: { spec: AircraftSpec; shape: AirlinerShape }) {
  const airframe = useAirframe(spec, shape.paint, shape.accent)
  const { paint } = airframe
  const built = useMemo(
    () => ({
      fuselage: concordeFuselage(),
      skin: new MeshStandardMaterial({
        map: concordeLivery(shape.paint, shape.accent),
        roughness: 0.35,
        metalness: 0.1
      }),
      wings: [wingGeometry(CONCORDE_WING, -1), wingGeometry(CONCORDE_WING, 1)],
      elevons: ELEVONS.map(([inner, outer]) =>
        plateGeometry(
          [
            [inner, 0],
            [outer, 0],
            [outer, ELEVON_CHORD * 0.95],
            [inner, ELEVON_CHORD]
          ],
          0.1
        )
      ),
      fin: plateGeometry(
        [
          [0, 15.5],
          [8.6, 25.4],
          [8.6, 27.2],
          [0, 27.4]
        ],
        0.38
      ).rotateZ(QUARTER_TURN),
      rudder: plateGeometry(
        [
          [0.2, 0],
          [8.4, 0],
          [8.4, 1.5],
          [0.2, 1.9]
        ],
        0.24
      ).rotateZ(QUARTER_TURN)
    }),
    [shape]
  )
  useDisposal(built)

  const flames = useMemo(() => {
    const glow = { transparent: true, depthWrite: false, toneMapped: false }
    return {
      outer: new MeshBasicMaterial({ ...glow, color: '#ff7a24', opacity: 0.5 }),
      core: new MeshBasicMaterial({ ...glow, color: '#ffe9a8', opacity: 0.85 })
    }
  }, [])
  const nose = useRef<Group>(null)
  const elevons = useRef<(Group | null)[]>([])
  const rudder = useRef<Group>(null)
  const burners = useRef<(Group | null)[]>([])
  const gear = useRef<(Group | null)[]>([])
  const beacon = useRef<Group>(null)
  const strobes = useRef<(Group | null)[]>([])
  const lamps = useRef<(Group | null)[]>([])

  useFrame(({ clock }) => {
    const { sim, pilot, wreck } = game
    const c = pilot.controls
    const blink = clock.elapsedTime % 1.2
    if (beacon.current) beacon.current.visible = !wreck.active && blink < 0.12
    for (const strobe of strobes.current) {
      if (strobe) strobe.visible = !wreck.active && (blink < 0.05 || (blink > 0.15 && blink < 0.2))
    }
    for (const lamp of lamps.current) if (lamp) lamp.visible = pilot.landingLights && !wreck.active
    // The nose droops 5° at the middle notch and 12.5° at full
    if (nose.current) nose.current.rotation.x = -sim.flapPosition * NOSE_DROOP
    // Elevons do the work of elevators and ailerons together
    elevons.current.forEach((elevon, i) => {
      if (!elevon) return
      const right = i >= ELEVONS.length
      const roll = c.roll * 0.3 * (right ? -1 : 1)
      elevon.rotation.x = -(c.pitch + c.trim * 0.3) * 0.3 + roll
    })
    if (rudder.current) rudder.current.rotation.y = -c.yaw * 0.35
    const flame = 0.85 + Math.random() * 0.3
    for (const burner of burners.current) {
      if (!burner) continue
      burner.visible = sim.afterburner && !wreck.active
      burner.scale.z = flame
    }
    // Main legs fold inward under the wing, the nose leg forward
    const retract = (1 - sim.gearPosition) * QUARTER_TURN
    gear.current.forEach((leg, i) => {
      if (!leg) return
      leg.visible = sim.gearPosition > 0.03
      if (i === 0) leg.rotation.x = retract
      else leg.rotation.z = i === 1 ? -retract : retract
    })
  })

  const [noseWheel, leftMain, rightMain] = spec.contactPoints.map(point => point.position)
  const wingY = shape.wing.y
  /** A tall gear leg ending in a truck of `pairs` axles. */
  const leg = (index: number, bottom: Vector3, pairs: number, mountY: number, tyre: number) => {
    const drop = bottom.y + tyre - mountY
    return (
      <group
        key={index}
        ref={group => {
          gear.current[index] = group
        }}
        position={[bottom.x, mountY, bottom.z]}
      >
        <Strut from={[0, 0, 0]} to={[0, drop, 0]} radius={0.16} material={paint.dark} />
        {wheelSpots(pairs).map(([side, axle]) => (
          <Wheel
            key={`${axle} ${side}`}
            position={[side * tyre * 0.8, drop, (axle - (pairs - 1) / 2) * tyre * 2.4]}
            radius={tyre}
            material={paint.dark}
          />
        ))}
      </group>
    )
  }
  const wingPart = (side: 0 | 1) => {
    const sign = side === 1 ? 1 : -1
    const nacelleX = 3.35 * sign
    const tip = CONCORDE_WING[CONCORDE_WING.length - 1]
    return (
      <>
        <group position={[0, wingY, 0]} rotation-z={shape.wing.dihedral * sign}>
          <mesh castShadow material={paint.body} geometry={built.wings[side]} />
          {built.elevons.map((geometry, i) => (
            <group
              key={ELEVONS[i][0]}
              ref={group => {
                elevons.current[side * ELEVONS.length + i] = group
              }}
              position={[0, 0, 24.2]}
              scale={[sign, 1, 1]}
            >
              <mesh castShadow material={paint.body} geometry={geometry} />
            </group>
          ))}
          <mesh
            material={side === 1 ? paint.green : paint.red}
            position={[tip[0] * sign, 0, tip[1] + 0.3]}
          >
            <sphereGeometry args={[0.16, 8, 6]} />
          </mesh>
          <group
            ref={group => {
              strobes.current[side] = group
            }}
            position={[tip[0] * sign, 0, tip[1] + 0.9]}
          >
            <mesh>
              <sphereGeometry args={[0.2, 8, 6]} />
              <meshBasicMaterial color="#ffffff" toneMapped={false} />
            </mesh>
          </group>
        </group>
        {/* Two engines side by side in one nacelle, with intakes ahead of the wing's spar */}
        <group position={[nacelleX, shape.engineY, 0]}>
          <mesh castShadow material={paint.body} position={[0, 0, 16.8]}>
            <boxGeometry args={[3.1, 1.55, 19.5]} />
          </mesh>
          <mesh castShadow material={paint.body} position={[0, 0.55, 16.8]}>
            <boxGeometry args={[2.6, 0.5, 19.5]} />
          </mesh>
          {[-0.78, 0.78].map(x => (
            <group key={x} position={[x, 0, 0]}>
              {/* Intake mouth, raked back at the bottom */}
              <mesh material={paint.dark} position={[0, 0, 7.04]} rotation-x={-0.25}>
                <planeGeometry args={[1.35, 1.25]} />
              </mesh>
              <mesh material={paint.dark} position={[0, 0, 26.9]} rotation-x={QUARTER_TURN}>
                <cylinderGeometry args={[0.55, 0.62, 0.8, 16, 1, true]} />
              </mesh>
              <group
                ref={group => {
                  burners.current[side * 2 + (x > 0 ? 1 : 0)] = group
                }}
                position={[0, 0, 27.3]}
              >
                <mesh material={flames.outer} position={[0, 0, 2.6]} rotation-x={QUARTER_TURN}>
                  <coneGeometry args={[0.55, 5.2, 14, 1, true]} />
                </mesh>
                <mesh material={flames.core} position={[0, 0, 1.3]} rotation-x={QUARTER_TURN}>
                  <coneGeometry args={[0.32, 2.6, 14, 1, true]} />
                </mesh>
              </group>
            </group>
          ))}
        </group>
        {leg(side + 1, side === 1 ? rightMain : leftMain, 2, wingY - 0.3, 0.62)}
        <group
          ref={group => {
            lamps.current[side] = group
          }}
          position={[1.9 * sign, wingY - 0.3, -10]}
        >
          <mesh>
            <sphereGeometry args={[0.22, 10, 8]} />
            <meshBasicMaterial color="#fffbe6" toneMapped={false} />
          </mesh>
        </group>
      </>
    )
  }

  return (
    <group ref={airframe.root}>
      <Part airframe={airframe} name="fuselage">
        <mesh castShadow material={built.skin} geometry={built.fuselage.body} />
        <group ref={beacon} position={[0, 1.6, 2]}>
          <mesh material={paint.red}>
            <sphereGeometry args={[0.22, 8, 6]} />
          </mesh>
        </group>
      </Part>
      <Part airframe={airframe} name="nose">
        <mesh castShadow material={built.skin} geometry={built.fuselage.cockpit} />
        {/* The nose swings down about a hinge below the windscreen */}
        <group position={[0, NOSE_HINGE_Y, NOSE_HINGE_Z]}>
          <group ref={nose}>
            <group position={[0, -NOSE_HINGE_Y, -NOSE_HINGE_Z]}>
              <mesh castShadow material={built.skin} geometry={built.fuselage.droop} />
            </group>
          </group>
        </group>
        {leg(0, noseWheel, 1, -1.3, 0.5)}
      </Part>
      <Part airframe={airframe} name="leftWing">
        {wingPart(0)}
      </Part>
      <Part airframe={airframe} name="rightWing">
        {wingPart(1)}
      </Part>
      <Part airframe={airframe} name="tail">
        <group position={[0, 1.2, 0]}>
          <mesh castShadow material={paint.body} geometry={built.fin} />
          <group ref={rudder} position={[0, 0, 27.4]}>
            <mesh castShadow material={paint.body} geometry={built.rudder} />
          </group>
        </group>
      </Part>
    </group>
  )
}

/** Spanwise stations of the flying wing: distance out, and the skin's height above and below. */
const BOMBER_STATIONS: [x: number, top: number, bottom: number][] = [
  [0, 1.5, 1.3],
  [2.5, 1.4, 1.2],
  [4.25, 1.1, 1],
  [8.5, 0.55, 0.45],
  [13.5, 0.35, 0.3],
  [20, 0.22, 0.18],
  [26.2, 0.04, 0.04]
]
// Stations inboard of this belong to the centre body, which breaks away from the wings
const BOMBER_BODY = 8.5
// Elevons and, outboard, the split drag rudders along the straight outer trailing edge
const BOMBER_SURFACES: [from: number, to: number][] = [
  [13.8, 19.8],
  [20.2, 25.6]
]
const BOMBER_SURFACE_CHORD = 1.6

/** Leading and trailing edge of the bomber's outline at `x` metres out, as z positions. */
function bomberEdges(outline: [number, number][], x: number) {
  const [nose, tip] = outline
  const lead = nose[1] + ((tip[1] - nose[1]) * x) / tip[0]
  // The trailing edge runs from the wingtip back to the centre, so search it in that order
  const trailing = outline.slice(2)
  let trail = trailing[trailing.length - 1][1]
  for (let i = 0; i < trailing.length - 1; i++) {
    const [x1, z1] = trailing[i]
    const [x2, z2] = trailing[i + 1]
    if (x <= x1 && x >= x2) {
      trail = z1 + ((z2 - z1) * (x1 - x)) / (x1 - x2 || 1)
      break
    }
  }
  return { lead, trail }
}

/**
 * One side of the flying wing between two distances out, from the outline and the
 * stations' thickness: deepest a third of the way back, thin at both edges.
 */
export function flyingWingGeometry(shape: BomberShape, from: number, to: number, side: 1 | -1) {
  const positions: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    const order = side === 1 ? [a, b, c, a, c, d] : [a, c, b, a, d, c]
    for (const point of order) positions.push(point[0] * side, point[1], point[2])
  }
  const stations = BOMBER_STATIONS.filter(([x]) => x >= from && x <= to)
  for (let i = 0; i < stations.length - 1; i++) {
    const [x1, top1, bottom1] = stations[i]
    const [x2, top2, bottom2] = stations[i + 1]
    const one = bomberEdges(shape.outline, x1)
    const two = bomberEdges(shape.outline, x2)
    const mid1 = one.lead + (one.trail - one.lead) * 0.33
    const mid2 = two.lead + (two.trail - two.lead) * 0.33
    for (const [y1, y2, up] of [
      [top1, top2, true],
      [-bottom1, -bottom2, false]
    ] as const) {
      const front = [
        [x1, 0, one.lead],
        [x1, y1, mid1],
        [x2, y2, mid2],
        [x2, 0, two.lead]
      ]
      const back = [
        [x1, y1, mid1],
        [x1, 0, one.trail],
        [x2, 0, two.trail],
        [x2, y2, mid2]
      ]
      for (const panel of [front, back]) {
        if (up) quad(panel[0], panel[1], panel[2], panel[3])
        else quad(panel[0], panel[3], panel[2], panel[1])
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.computeVertexNormals()
  return geometry
}

/**
 * B-2 Spirit: one flying wing with a sawtooth trailing edge, a cockpit hump, four engines
 * buried in the wing with intakes and exhaust troughs on top, elevons, and split drag
 * rudders at the tips that open together as an airbrake.
 */
function BomberModel({ spec, shape }: { spec: AircraftSpec; shape: BomberShape }) {
  const airframe = useAirframe(spec, shape.paint, shape.accent)
  const { paint } = airframe
  const built = useMemo(() => {
    const surface = (from: number, to: number) => {
      const length = to - from
      return plateGeometry(
        [
          [0, 0],
          [length, 0],
          [length, BOMBER_SURFACE_CHORD * 0.9],
          [0, BOMBER_SURFACE_CHORD]
        ],
        0.12
      )
    }
    return {
      // Both sides of the wing are drawn from either face: mirrored panels flip their winding
      skin: new MeshStandardMaterial({ roughness: 0.75, metalness: 0.05, side: DoubleSide }),
      body: [
        flyingWingGeometry(shape, 0, BOMBER_BODY, -1),
        flyingWingGeometry(shape, 0, BOMBER_BODY, 1)
      ],
      wings: [
        flyingWingGeometry(shape, BOMBER_BODY, 26.2, -1),
        flyingWingGeometry(shape, BOMBER_BODY, 26.2, 1)
      ],
      surfaces: BOMBER_SURFACES.map(([from, to]) => surface(from, to))
    }
  }, [shape])
  useDisposal(built)

  const surfaces = useRef<(Group | null)[]>([])
  const rudders = useRef<(Group | null)[]>([])
  const gear = useRef<(Group | null)[]>([])
  const beacon = useRef<Group>(null)
  const strobes = useRef<(Group | null)[]>([])
  const lamp = useRef<Group>(null)

  useFrame(({ clock }) => {
    const { sim, pilot, wreck } = game
    const c = pilot.controls
    built.skin.color.copy(paint.body.color)
    const blink = clock.elapsedTime % 1.2
    if (beacon.current) beacon.current.visible = !wreck.active && blink < 0.12
    for (const strobe of strobes.current) {
      if (strobe) strobe.visible = !wreck.active && (blink < 0.05 || (blink > 0.15 && blink < 0.2))
    }
    if (lamp.current) lamp.current.visible = pilot.landingLights && !wreck.active
    // The elevons pitch and roll the aircraft together
    surfaces.current.forEach((elevon, i) => {
      if (!elevon) return
      const right = i === 1
      elevon.rotation.x =
        -(c.pitch + c.trim * 0.3) * ELEVATOR_TRAVEL + c.roll * AILERON_TRAVEL * (right ? -1 : 1)
    })
    // Each drag rudder splits open, top up and bottom down, to yaw toward its side.
    // Both open together as the airbrake.
    rudders.current.forEach((half, i) => {
      if (!half) return
      const right = i >= 2
      const yaw = Math.max(0, right ? c.yaw : -c.yaw)
      const open = Math.min(1, yaw + sim.speedBrakePosition) * RUDDER_TRAVEL
      half.rotation.x = i % 2 === 0 ? open : -open
    })
    const retract = (1 - sim.gearPosition) * QUARTER_TURN
    gear.current.forEach((leg, i) => {
      if (!leg) return
      leg.visible = sim.gearPosition > 0.03
      if (i === 0) leg.rotation.x = -retract
      else leg.rotation.z = i === 1 ? -retract : retract
    })
  })

  const [noseWheel, leftMain, rightMain] = spec.contactPoints.map(point => point.position)
  /** A gear leg ending in `axles` pairs of wheels. */
  const leg = (index: number, bottom: Vector3, axles: number, mountY: number, tyre: number) => {
    const drop = bottom.y + tyre - mountY
    return (
      <group
        key={index}
        ref={group => {
          gear.current[index] = group
        }}
        position={[bottom.x, mountY, bottom.z]}
      >
        <Strut from={[0, 0, 0]} to={[0, drop, 0]} radius={0.2} material={paint.dark} />
        {wheelSpots(axles).map(([side, axle]) => (
          <Wheel
            key={`${axle} ${side}`}
            position={[side * tyre * 0.8, drop, (axle - (axles - 1) / 2) * tyre * 2.4]}
            radius={tyre}
            material={paint.dark}
          />
        ))}
      </group>
    )
  }
  const trailing = (x: number) => bomberEdges(shape.outline, x).trail
  const wingPart = (side: 0 | 1) => {
    const sign = side === 1 ? 1 : -1
    const tipX = shape.outline[1][0]
    const tipZ = (shape.outline[1][1] + shape.outline[2][1]) / 2
    return (
      <>
        <mesh castShadow material={built.skin} geometry={built.wings[side]} />
        <group scale={[sign, 1, 1]}>
          {BOMBER_SURFACES.map(([from, to], i) => {
            const hingeZ = trailing(from) - BOMBER_SURFACE_CHORD
            const sweep = -Math.atan2(trailing(to) - trailing(from), to - from)
            const chordY = BOMBER_STATIONS[5][1] * 0.5
            // The inner surface is an elevon; the outer one is a drag rudder in two halves
            return i === 0 ? (
              <group key={from} position={[from, 0, hingeZ]} rotation-y={sweep}>
                <group
                  ref={group => {
                    surfaces.current[side] = group
                  }}
                >
                  <mesh castShadow material={built.skin} geometry={built.surfaces[i]} />
                </group>
              </group>
            ) : (
              <group key={from} position={[from, 0, hingeZ]} rotation-y={sweep}>
                {[0, 1].map(half => (
                  <group
                    key={half}
                    ref={group => {
                      rudders.current[side * 2 + half] = group
                    }}
                    position={[0, half === 0 ? chordY * 0.4 : -chordY * 0.4, 0]}
                    scale={[1, 0.5, 1]}
                  >
                    <mesh castShadow material={built.skin} geometry={built.surfaces[i]} />
                  </group>
                ))}
              </group>
            )
          })}
        </group>
        <mesh material={side === 1 ? paint.green : paint.red} position={[tipX * sign, 0.05, tipZ]}>
          <sphereGeometry args={[0.16, 8, 6]} />
        </mesh>
        <group
          ref={group => {
            strobes.current[side] = group
          }}
          position={[tipX * sign, 0.05, tipZ + 0.6]}
        >
          <mesh>
            <sphereGeometry args={[0.18, 8, 6]} />
            <meshBasicMaterial color="#ffffff" toneMapped={false} />
          </mesh>
        </group>
        {leg(side + 1, side === 1 ? rightMain : leftMain, 2, -0.9, 0.6)}
      </>
    )
  }

  return (
    <group ref={airframe.root}>
      <Part airframe={airframe} name="fuselage">
        <mesh castShadow material={built.skin} geometry={built.body[0]} />
        <mesh castShadow material={built.skin} geometry={built.body[1]} />
        {/* Engine humps on top, with the intakes ahead and exhaust troughs behind */}
        {shape.engines.length > 0 &&
          [-1, 1].map(sign => {
            const x = (shape.engines[0][0] + shape.engines[shape.engines.length - 1][0]) / 2
            return (
              <group key={sign} position={[x * sign, 0, 0]}>
                <mesh
                  castShadow
                  material={built.skin}
                  position={[0, 0.55, -0.8]}
                  scale={[1.7, 0.42, 6]}
                >
                  <sphereGeometry args={[1, 18, 10]} />
                </mesh>
                <mesh material={paint.dark} position={[0, 0.9, -3.1]} rotation-x={-0.35}>
                  <boxGeometry args={[2.4, 0.36, 0.5]} />
                </mesh>
                <mesh material={paint.dark} position={[0, 0.52, 3.6]} rotation-x={-0.12}>
                  <boxGeometry args={[2.6, 0.06, 2.6]} />
                </mesh>
              </group>
            )
          })}
        <group ref={beacon} position={[0, -1.35, 1]}>
          <mesh material={paint.red}>
            <sphereGeometry args={[0.2, 8, 6]} />
          </mesh>
        </group>
      </Part>
      <Part airframe={airframe} name="nose">
        {/* Cockpit hump with its four windscreen panels */}
        <mesh castShadow material={built.skin} position={[0, 0.95, -4.6]} scale={[2.2, 0.85, 5.6]}>
          <sphereGeometry args={[1, 20, 12]} />
        </mesh>
        <mesh material={paint.glass} position={[0, 1.72, -6.6]} rotation-x={-0.42}>
          <boxGeometry args={[2.3, 0.06, 1.1]} />
        </mesh>
        {leg(0, noseWheel, 1, -1.1, 0.5)}
        <group ref={lamp} position={[0, -1.25, -6.6]}>
          <mesh>
            <sphereGeometry args={[0.22, 10, 8]} />
            <meshBasicMaterial color="#fffbe6" toneMapped={false} />
          </mesh>
        </group>
      </Part>
      <Part airframe={airframe} name="leftWing">
        {wingPart(0)}
      </Part>
      <Part airframe={airframe} name="rightWing">
        {wingPart(1)}
      </Part>
      <Part airframe={airframe} name="tail">
        {/* The beaver tail between the exhausts, which also trims the pitch */}
        <mesh material={paint.dark} position={[0, 0.2, trailing(0) - 2.2]}>
          <boxGeometry args={[2.2, 0.1, 2.2]} />
        </mesh>
      </Part>
    </group>
  )
}

/** Cross-section of a lofted body: z, half width, top and bottom heights, and squareness. */
type Section = [z: number, halfWidth: number, top: number, bottom: number, square: number]

/** The section at `z`, interpolated between the two around it. */
function sectionAt(sections: Section[], z: number): Section {
  const i = Math.max(0, sections.findIndex(([next]) => next >= z) - 1)
  const [a, b] = [sections[i], sections[Math.min(i + 1, sections.length - 1)]]
  const t = b[0] === a[0] ? 0 : (z - a[0]) / (b[0] - a[0])
  const mix = (k: 1 | 2 | 3 | 4) => a[k] + (b[k] - a[k]) * t
  return [z, mix(1), mix(2), mix(3), mix(4)]
}

/**
 * Skin of a body through `sections` from `from` to `to` along it. Each section is a
 * superellipse: 2 is an ellipse, higher is squarer. `arc` limits the skin to a band of
 * angles around the body, measured from the belly toward the right side, so stripes and
 * a dark belly can take their own paint.
 */
function loftGeometry(
  sections: Section[],
  from: number,
  to: number,
  arc: [number, number] = [0, Math.PI * 2]
) {
  const around = 32
  const rings = [from, ...sections.map(([z]) => z).filter(z => z > from && z < to), to]
  const positions: number[] = []
  for (const z of rings) {
    const [, halfWidth, top, bottom, square] = sectionAt(sections, z)
    const centre = (top + bottom) / 2
    const half = (top - bottom) / 2
    const power = 2 / square
    for (let j = 0; j <= around; j++) {
      const angle = arc[0] + ((arc[1] - arc[0]) * j) / around
      const sin = Math.sin(angle)
      const cos = Math.cos(angle)
      positions.push(
        halfWidth * Math.sign(sin) * Math.abs(sin) ** power,
        centre - half * Math.sign(cos) * Math.abs(cos) ** power,
        z
      )
    }
  }
  const index: number[] = []
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * (around + 1) + j
      const b = a + around + 1
      index.push(a, a + 1, b, b, a + 1, b + 1)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  return geometry
}

// The P-51D's fuselage from the propeller back, the belly radiator scoop, and the wing
const MUSTANG_BODY: Section[] = [
  [-3.45, 0.3, 0.28, -0.34, 2],
  [-3, 0.4, 0.4, -0.48, 2.2],
  [-2, 0.43, 0.45, -0.56, 2.3],
  [-0.6, 0.43, 0.48, -0.62, 2.3],
  [0.6, 0.42, 0.44, -0.62, 2.3],
  [2.4, 0.34, 0.36, -0.52, 2.2],
  [4.2, 0.22, 0.3, -0.34, 2.1],
  [5.4, 0.12, 0.26, -0.12, 2],
  [5.98, 0.03, 0.22, 0.08, 2]
]
const MUSTANG_SCOOP: Section[] = [
  [0.25, 0.3, -0.6, -0.98, 2.4],
  [1.2, 0.34, -0.55, -1.03, 2.4],
  [2.4, 0.3, -0.48, -0.9, 2.4],
  [3.4, 0.08, -0.4, -0.5, 2]
]
const MUSTANG_WING: WingStation[] = [
  [0.3, -0.78, 1.95, 0.4],
  [1.8, -0.64, 1.68, 0.32],
  [3.6, -0.44, 1.32, 0.22],
  [5.2, -0.25, 0.98, 0.13],
  [5.64, -0.12, 0.75, 0.05]
]
// Flaps inboard and ailerons outboard along the trailing edge: from x, to x, chord
const MUSTANG_SURFACES: [number, number, number][] = [
  [0.45, 2.65, 0.45],
  [2.75, 5.2, 0.38]
]
// Invasion stripes, white and black, five to a band: across each wing and the rear fuselage
const STRIPES = 5
const WING_STRIPES: [number, number] = [2, 4.25]
const BODY_STRIPES: [number, number] = [3, 4.35]
// Angle either side of the top of the nose that the anti-glare panel covers
const ANTI_GLARE = 0.35
// The Merlin turns the propeller through a 0.479 reduction gear
const PROP_GEARING = 0.479

/** Bands from `from` to `to` split into equal stripes, as [start, end, white] triples. */
const stripes = ([from, to]: [number, number]) =>
  Array.from({ length: STRIPES }, (_, i): [number, number, boolean] => [
    from + ((to - from) * i) / STRIPES,
    from + ((to - from) * (i + 1)) / STRIPES,
    i % 2 === 0
  ])

/**
 * P-51D Mustang: natural-metal tail-dragger with a low laminar-flow wing, the radiator
 * scoop under the belly, a bubble canopy, a four-blade propeller, and invasion stripes.
 */
function MustangModel({ spec, shape }: { spec: AircraftSpec; shape: PropellerShape }) {
  const airframe = useAirframe(spec, shape.paint, shape.accent)
  const { paint } = airframe
  const built = useMemo(() => {
    const top = Math.PI
    const stab: Outline = [
      [0.15, 4.55],
      [2.05, 5.15],
      [2.05, 5.45],
      [0.15, 5.45]
    ]
    const elevator: Outline = [
      [0.15, 0],
      [2, 0],
      [2, 0.35],
      [0.15, 0.5]
    ]
    const surface = (length: number, chord: number) =>
      plateGeometry(
        [
          [0, 0],
          [length, 0],
          [length, chord * 0.9],
          [0, chord]
        ],
        0.05
      )
    const wingBands = (side: 1 | -1) => {
      const [from, to] = WING_STRIPES
      const tip = MUSTANG_WING[MUSTANG_WING.length - 1][0]
      return {
        bare: [
          wingGeometry(wingSlice(MUSTANG_WING, MUSTANG_WING[0][0], from), side),
          wingGeometry(wingSlice(MUSTANG_WING, to, tip), side)
        ],
        stripes: stripes(WING_STRIPES).map(([a, b, white]) => ({
          white,
          geometry: wingGeometry(wingSlice(MUSTANG_WING, a, b), side)
        }))
      }
    }
    const [stripeFrom, stripeTo] = BODY_STRIPES
    return {
      white: new MeshStandardMaterial({ color: '#f2f1ec', roughness: 0.5 }),
      black: new MeshStandardMaterial({ color: '#151617', roughness: 0.6 }),
      olive: new MeshStandardMaterial({ color: '#4b4f32', roughness: 0.8 }),
      yellow: new MeshStandardMaterial({ color: '#f2c230', roughness: 0.5 }),
      metal: new MeshStandardMaterial({ color: shape.paint, roughness: 0.4, metalness: 0.35 }),
      disc: new MeshStandardMaterial({
        color: '#cfd4d8',
        transparent: true,
        opacity: 0.12,
        side: DoubleSide,
        depthWrite: false
      }),
      nose: [
        loftGeometry(MUSTANG_BODY, -3.45, -0.6, [0, top - ANTI_GLARE]),
        loftGeometry(MUSTANG_BODY, -3.45, -0.6, [top + ANTI_GLARE, top * 2])
      ],
      antiGlare: loftGeometry(MUSTANG_BODY, -3.45, -0.6, [top - ANTI_GLARE, top + ANTI_GLARE]),
      body: [
        loftGeometry(MUSTANG_BODY, -0.6, stripeFrom),
        loftGeometry(MUSTANG_BODY, stripeTo, 4.6)
      ],
      bodyStripes: stripes(BODY_STRIPES).map(([a, b, white]) => ({
        white,
        geometry: loftGeometry(MUSTANG_BODY, a, b)
      })),
      tailCone: loftGeometry(MUSTANG_BODY, 4.6, 5.98),
      scoop: loftGeometry(MUSTANG_SCOOP, 0.25, 3.4),
      wings: [wingBands(-1), wingBands(1)],
      stabs: [plateGeometry(mirrored(stab), 0.09), plateGeometry(stab, 0.09)],
      elevators: [plateGeometry(mirrored(elevator), 0.05), plateGeometry(elevator, 0.05)],
      fin: plateGeometry(
        [
          [0, 3.3],
          [0.35, 4.55],
          [1.35, 5.1],
          [1.5, 5.3],
          [1.5, 5.45],
          [0, 5.45]
        ],
        0.1
      ).rotateZ(QUARTER_TURN),
      rudder: plateGeometry(
        [
          [0, 0],
          [1.5, 0],
          [1.4, 0.3],
          [0.05, 0.55]
        ],
        0.06
      ).rotateZ(QUARTER_TURN),
      surfaces: MUSTANG_SURFACES.map(([from, to, chord]) => surface(to - from, chord))
    }
  }, [shape.paint])
  useDisposal(built)

  const propeller = useRef<Group>(null)
  const blades = useRef<Group>(null)
  const blur = useRef<Group>(null)
  const lamp = useRef<Group>(null)
  const gear = useRef<(Group | null)[]>([])
  const surfaces = useRef<(Group | null)[]>([])
  const elevators = useRef<(Group | null)[]>([])
  const rudder = useRef<Group>(null)

  useFrame((_, delta) => {
    const { sim, pilot, wreck } = game
    const c = pilot.controls
    if (propeller.current && blades.current && blur.current) {
      const spinning = game.getState().status === 'flying' ? sim.rpm * PROP_GEARING : 0
      propeller.current.rotation.z -= (spinning / 60) * Math.PI * 2 * delta
      blades.current.visible = spinning < 450
      blur.current.visible = spinning > 200
    }
    if (lamp.current) lamp.current.visible = pilot.landingLights && !wreck.active
    // The main legs fold inward into the wing roots, the tail wheel forward into the fuselage
    const retract = (1 - sim.gearPosition) * QUARTER_TURN
    gear.current.forEach((leg, i) => {
      if (!leg) return
      leg.visible = sim.gearPosition > 0.03
      if (i === 0) leg.rotation.x = retract
      else leg.rotation.z = i === 1 ? retract : -retract
    })
    // Index 0 and 1 are the flaps, 2 and 3 the ailerons, left before right
    surfaces.current.forEach((panel, i) => {
      if (!panel) return
      const right = i % 2 === 1
      panel.rotation.x =
        i < 2 ? sim.flapPosition * 0.87 : c.roll * AILERON_TRAVEL * (right ? -1 : 1)
    })
    for (const elevator of elevators.current) {
      if (elevator) elevator.rotation.x = -(c.pitch + c.trim * 0.3) * ELEVATOR_TRAVEL
    }
    if (rudder.current) rudder.current.rotation.y = c.yaw * RUDDER_TRAVEL
  })

  const [tailWheel, leftMain, rightMain] = spec.contactPoints.map(point => point.position)
  const trailing = (x: number) => wingSlice(MUSTANG_WING, x, x)[0][2]
  /** A gear leg from its mount down to the wheel, which it swings around to retract. */
  const leg = (index: number, mount: [number, number, number], bottom: Vector3, tyre: number) => {
    const wheel: [number, number, number] = [
      bottom.x - mount[0],
      bottom.y + tyre - mount[1],
      bottom.z - mount[2]
    ]
    return (
      <group
        ref={group => {
          gear.current[index] = group
        }}
        position={mount}
      >
        <Strut from={[0, 0, 0]} to={wheel} radius={0.05} material={paint.dark} />
        <Wheel position={wheel} radius={tyre} material={paint.dark} />
      </group>
    )
  }
  const wingPart = (side: 0 | 1) => {
    const sign = side === 1 ? 1 : -1
    const wing = built.wings[side]
    const tip = MUSTANG_WING[MUSTANG_WING.length - 1]
    const main = side === 1 ? rightMain : leftMain
    const mountY = shape.wingY + Math.abs(main.x) * Math.sin(shape.dihedral) - 0.12
    return (
      <>
        <group position={[0, shape.wingY, 0]} rotation-z={shape.dihedral * sign}>
          {wing.bare.map(geometry => (
            <mesh key={geometry.uuid} castShadow material={built.metal} geometry={geometry} />
          ))}
          {wing.stripes.map(({ white, geometry }) => (
            <mesh
              key={geometry.uuid}
              castShadow
              material={white ? built.white : built.black}
              geometry={geometry}
            />
          ))}
          <group scale={[sign, 1, 1]}>
            {MUSTANG_SURFACES.map(([from, to], i) => {
              const sweep = -Math.atan2(trailing(to) - trailing(from), to - from)
              const chord = MUSTANG_SURFACES[i][2]
              return (
                <group key={from} position={[from, 0, trailing(from) - chord]} rotation-y={sweep}>
                  <group
                    ref={group => {
                      surfaces.current[i * 2 + side] = group
                    }}
                  >
                    <mesh castShadow material={built.metal} geometry={built.surfaces[i]} />
                  </group>
                </group>
              )
            })}
          </group>
          <mesh
            material={side === 1 ? paint.green : paint.red}
            position={[tip[0] * sign, 0, tip[1] + 0.3]}
          >
            <sphereGeometry args={[0.05, 8, 6]} />
          </mesh>
        </group>
        {leg(side + 1, [main.x, mountY, main.z], main, 0.34)}
        {side === 0 && (
          <group ref={lamp} position={[-3.2, shape.wingY + 0.15, -0.5]}>
            <mesh>
              <sphereGeometry args={[0.08, 8, 6]} />
              <meshBasicMaterial color="#fffbe6" toneMapped={false} />
            </mesh>
          </group>
        )}
      </>
    )
  }

  return (
    <group ref={airframe.root}>
      <Part airframe={airframe} name="fuselage">
        {built.body.map(geometry => (
          <mesh key={geometry.uuid} castShadow material={built.metal} geometry={geometry} />
        ))}
        {built.bodyStripes.map(({ white, geometry }) => (
          <mesh
            key={geometry.uuid}
            castShadow
            material={white ? built.white : built.black}
            geometry={geometry}
          />
        ))}
        <mesh castShadow material={built.metal} geometry={built.scoop} />
        {/* Radiator intake at the front of the scoop, clear of the belly */}
        <mesh
          material={paint.dark}
          position={[0, -0.79, 0.24]}
          rotation-y={Math.PI}
          scale={[0.27, 0.17, 1]}
        >
          <circleGeometry args={[1, 20]} />
        </mesh>
        {/* Bubble canopy, with the windscreen frame ahead of it */}
        <mesh material={paint.glass} position={[0, 0.5, 0.42]} scale={[0.33, 0.43, 0.95]}>
          <sphereGeometry args={[1, 24, 16]} />
        </mesh>
        <mesh material={paint.dark} position={[0, 0.66, -0.42]} rotation-x={-0.6}>
          <boxGeometry args={[0.5, 0.03, 0.42]} />
        </mesh>
      </Part>

      <Part airframe={airframe} name="nose">
        {built.nose.map(geometry => (
          <mesh key={geometry.uuid} castShadow material={built.metal} geometry={geometry} />
        ))}
        <mesh material={built.olive} geometry={built.antiGlare} />
        {/* Six exhaust stacks a side, and the carburettor intake under the spinner */}
        {[-1, 1].map(side =>
          [0, 1, 2, 3, 4, 5].map(i => (
            <mesh
              key={`${side} ${i}`}
              material={paint.dark}
              position={[side * 0.43, 0.16, -2.75 + i * 0.22]}
            >
              <boxGeometry args={[0.08, 0.06, 0.12]} />
            </mesh>
          ))
        )}
        <mesh material={paint.dark} position={[0, -0.52, -2.85]}>
          <boxGeometry args={[0.16, 0.1, 0.4]} />
        </mesh>
        <group ref={propeller} position={[0, 0.02, shape.noseZ + 0.4]}>
          <mesh
            castShadow
            material={paint.accent}
            position={[0, 0, -0.2]}
            rotation-x={-QUARTER_TURN}
          >
            <coneGeometry args={[0.3, 0.45, 20]} />
          </mesh>
          <group ref={blades}>
            {[0, 1, 2, 3].map(i => (
              <group key={i} rotation-z={(i * Math.PI) / 2}>
                <mesh
                  castShadow
                  material={paint.dark}
                  position={[0, shape.propRadius / 2, 0]}
                  rotation-y={0.35}
                  scale={[1, 1, 0.22]}
                >
                  <cylinderGeometry args={[0.1, 0.12, shape.propRadius, 8]} />
                </mesh>
                <mesh
                  material={built.yellow}
                  position={[0, shape.propRadius - 0.08, 0]}
                  rotation-y={0.35}
                  scale={[1, 1, 0.22]}
                >
                  <cylinderGeometry args={[0.1, 0.1, 0.16, 8]} />
                </mesh>
              </group>
            ))}
          </group>
          <group ref={blur}>
            <mesh material={built.disc}>
              <circleGeometry args={[shape.propRadius, 40]} />
            </mesh>
          </group>
        </group>
      </Part>

      <Part airframe={airframe} name="leftWing">
        {wingPart(0)}
      </Part>
      <Part airframe={airframe} name="rightWing">
        {wingPart(1)}
      </Part>

      <Part airframe={airframe} name="tail">
        <mesh castShadow material={built.metal} geometry={built.tailCone} />
        <group position={[0, 0.2, 0]}>
          <mesh castShadow material={built.metal} geometry={built.fin} />
          <group ref={rudder} position={[0, 0, 5.45]}>
            <mesh castShadow material={built.metal} geometry={built.rudder} />
          </group>
        </group>
        {[0, 1].map(side => (
          <group key={side} position={[0, 0.12, 0]}>
            <mesh castShadow material={built.metal} geometry={built.stabs[side]} />
            <group
              ref={group => {
                elevators.current[side] = group
              }}
              position={[0, 0, 5.45]}
            >
              <mesh castShadow material={built.metal} geometry={built.elevators[side]} />
            </group>
          </group>
        ))}
        {leg(0, [0, -0.3, tailWheel.z], tailWheel, 0.15)}
      </Part>
    </group>
  )
}

// The orbiter's fuselage: needle-blunt nose, crew cabin, payload bay, and the wide aft body
const SHUTTLE_BODY: Section[] = [
  [-21.6, 0.05, -0.45, -0.75, 2],
  [-21.1, 0.85, 0, -1.3, 2.2],
  [-19.8, 1.65, 0.85, -1.7, 2.6],
  [-17.8, 2.2, 1.85, -1.9, 3],
  [-15.6, 2.5, 2.7, -1.95, 3.2],
  [-13.6, 2.6, 2.75, -1.95, 3.5],
  [-12.2, 2.6, 2.3, -1.95, 3.6],
  [9.5, 2.6, 2.3, -1.95, 3.6],
  [11, 2.75, 2.7, -1.95, 3.6],
  [15, 2.75, 2.7, -1.75, 3.6]
]
// The double-delta wing: the 81° glove, then the 45° main wing out to the tip
const SHUTTLE_WING: WingStation[] = [
  [2.6, -7.9, 13.4, 1.4],
  [4.5, 4.1, 13.3, 1],
  [8, 7.6, 13, 0.6],
  [11.9, 11.5, 12.5, 0.18]
]
const SHUTTLE_WING_Y = -1.3
const SHUTTLE_DIHEDRAL = 0.061
// Inboard and outboard elevon on each side: from x, to x
const SHUTTLE_ELEVONS: [number, number][] = [
  [3, 7.3],
  [7.4, 11.6]
]
const ELEVON_DEPTH = 1.4
// The split rudder's hinge line runs up the fin's trailing edge from its root
const RUDDER_ROOT: [number, number] = [2.5, 12.9]
const RUDDER_LEAN = Math.atan2(2.1, 8)
const RUDDER_HINGE = Math.hypot(2.1, 8)
// Angle either side of the belly painted with black tiles
const TILE_ARC = 0.42 * Math.PI
// Main engine bells as [x, y]
const MAIN_ENGINES: [number, number][] = [
  [0, 1.75],
  [-1.3, -0.15],
  [1.3, -0.15]
]

/**
 * Space Shuttle orbiter: white tiles above, black below, a double-delta wing with elevons,
 * three main engines and two OMS pods at the back, and a split rudder that opens as the
 * speed brake.
 */
function ShuttleModel({ spec, shape }: { spec: AircraftSpec; shape: ShuttleShape }) {
  const airframe = useAirframe(spec, shape.paint, shape.accent)
  const { paint } = airframe
  const built = useMemo(() => {
    const [nose, tail] = [SHUTTLE_BODY[0][0], SHUTTLE_BODY[SHUTTLE_BODY.length - 1][0]]
    const belly: [number, number] = [-TILE_ARC, TILE_ARC]
    const upper: [number, number] = [TILE_ARC, Math.PI * 2 - TILE_ARC]
    const top = Math.PI
    const cabin = -12.2
    return {
      bell: new MeshStandardMaterial({
        color: '#3a3c3f',
        roughness: 0.35,
        metalness: 0.7,
        side: DoubleSide
      }),
      rcc: new MeshStandardMaterial({ color: '#45474a', roughness: 0.7 }),
      noseCap: loftGeometry(SHUTTLE_BODY, nose, -21),
      nose: {
        belly: loftGeometry(SHUTTLE_BODY, -21, cabin, belly),
        sides: [
          loftGeometry(SHUTTLE_BODY, -21, cabin, [TILE_ARC, top - 0.85]),
          loftGeometry(SHUTTLE_BODY, -21, cabin, [top + 0.85, Math.PI * 2 - TILE_ARC])
        ],
        // The forward windows sit in a black band across the top of the cabin
        top: [
          loftGeometry(SHUTTLE_BODY, -21, -18, [top - 0.85, top + 0.85]),
          loftGeometry(SHUTTLE_BODY, -15.6, cabin, [top - 0.85, top + 0.85])
        ],
        windows: loftGeometry(SHUTTLE_BODY, -18, -15.6, [top - 0.85, top + 0.85])
      },
      body: {
        belly: loftGeometry(SHUTTLE_BODY, cabin, tail, belly),
        upper: loftGeometry(SHUTTLE_BODY, cabin, tail, upper)
      },
      wings: ([-1, 1] as const).map(side => ({
        top: wingGeometry(SHUTTLE_WING, side, 'top'),
        bottom: wingGeometry(SHUTTLE_WING, side, 'bottom')
      })),
      elevons: SHUTTLE_ELEVONS.map(([from, to]) =>
        plateGeometry(
          [
            [0, 0],
            [to - from, 0],
            [to - from, ELEVON_DEPTH],
            [0, ELEVON_DEPTH]
          ],
          0.16
        )
      ),
      fin: plateGeometry(
        [
          [0, 5.8],
          [8, 13.6],
          [8, 15],
          [0, RUDDER_ROOT[1]]
        ],
        0.45
      ).rotateZ(QUARTER_TURN),
      rudder: plateGeometry(
        [
          [0, 0],
          [RUDDER_HINGE, 0],
          [RUDDER_HINGE, 1.2],
          [0, 1.6]
        ],
        0.16
      ).rotateZ(QUARTER_TURN)
    }
  }, [])
  useDisposal(built)

  const elevons = useRef<(Group | null)[]>([])
  const rudders = useRef<(Group | null)[]>([])
  const gear = useRef<(Group | null)[]>([])

  useFrame(() => {
    const { sim, pilot } = game
    const c = pilot.controls
    elevons.current.forEach((elevon, i) => {
      if (!elevon) return
      const right = i >= SHUTTLE_ELEVONS.length
      elevon.rotation.x =
        -(c.pitch + c.trim * 0.3) * ELEVATOR_TRAVEL + c.roll * AILERON_TRAVEL * (right ? -1 : 1)
    })
    // Both rudder halves turn together to yaw, and split apart up to 49° as the speed brake
    const yaw = c.yaw * RUDDER_TRAVEL
    const split = sim.speedBrakePosition * 0.86
    rudders.current.forEach((half, i) => {
      if (half) half.rotation.y = yaw + (i === 0 ? -split : split)
    })
    // All three legs swing forward into their wells
    const retract = (1 - sim.gearPosition) * QUARTER_TURN
    for (const leg of gear.current) {
      if (!leg) continue
      leg.visible = sim.gearPosition > 0.03
      leg.rotation.x = retract
    }
  })

  const [noseWheel, leftMain, rightMain] = spec.contactPoints.map(point => point.position)
  /** A gear leg ending in two wheels side by side. */
  const leg = (index: number, bottom: Vector3, mountY: number, tyre: number) => {
    const drop = bottom.y + tyre - mountY
    return (
      <group
        ref={group => {
          gear.current[index] = group
        }}
        position={[bottom.x, mountY, bottom.z]}
      >
        <Strut from={[0, 0, 0]} to={[0, drop, 0]} radius={0.17} material={paint.dark} />
        {[-1, 1].map(side => (
          <Wheel
            key={side}
            position={[side * tyre * 0.45, drop, 0]}
            radius={tyre}
            material={paint.dark}
          />
        ))}
      </group>
    )
  }
  const wingPart = (side: 0 | 1) => {
    const sign = side === 1 ? 1 : -1
    const trailing = (x: number) => wingSlice(SHUTTLE_WING, x, x)[0][2]
    return (
      <>
        <group position={[0, SHUTTLE_WING_Y, 0]} rotation-z={SHUTTLE_DIHEDRAL * sign}>
          <mesh castShadow material={paint.body} geometry={built.wings[side].top} />
          <mesh castShadow material={paint.accent} geometry={built.wings[side].bottom} />
          <group scale={[sign, 1, 1]}>
            {SHUTTLE_ELEVONS.map(([from, to], i) => (
              <group
                key={from}
                position={[from, 0, trailing(from)]}
                rotation-y={-Math.atan2(trailing(to) - trailing(from), to - from)}
              >
                <group
                  ref={group => {
                    elevons.current[side * SHUTTLE_ELEVONS.length + i] = group
                  }}
                >
                  <mesh castShadow material={paint.body} geometry={built.elevons[i]} />
                </group>
              </group>
            ))}
          </group>
        </group>
        {leg(side + 1, side === 1 ? rightMain : leftMain, -1.6, 0.56)}
      </>
    )
  }

  return (
    <group ref={airframe.root}>
      <Part airframe={airframe} name="fuselage">
        <mesh castShadow material={paint.body} geometry={built.body.upper} />
        <mesh castShadow material={paint.accent} geometry={built.body.belly} />
        {/* Payload bay door seam */}
        <mesh material={built.rcc} position={[0, 2.31, -1.35]}>
          <boxGeometry args={[0.06, 0.02, 21.7]} />
        </mesh>
        {/* OMS pods either side of the fin, each with its engine */}
        {[-1, 1].map(side => (
          <group key={side} position={[side * 1.85, 2.75, 0]}>
            <mesh castShadow material={paint.body} position={[0, 0, 11.6]} scale={[1.05, 0.9, 3.6]}>
              <sphereGeometry args={[1, 20, 12]} />
            </mesh>
            <mesh material={built.bell} position={[0, 0, 15.3]} rotation-x={QUARTER_TURN}>
              <cylinderGeometry args={[0.38, 0.18, 0.9, 14, 1, true]} />
            </mesh>
          </group>
        ))}
        {/* Base, body flap, and the three main engine bells */}
        <mesh material={built.rcc} position={[0, 0.47, 15]}>
          <boxGeometry args={[5.5, 4.4, 0.1]} />
        </mesh>
        <mesh castShadow material={paint.accent} position={[0, -1.6, 15.5]}>
          <boxGeometry args={[5.2, 0.25, 1.9]} />
        </mesh>
      </Part>

      <Part airframe={airframe} name="nose">
        <mesh castShadow material={built.rcc} geometry={built.noseCap} />
        <mesh castShadow material={paint.accent} geometry={built.nose.belly} />
        {built.nose.sides.map(geometry => (
          <mesh key={geometry.uuid} castShadow material={paint.body} geometry={geometry} />
        ))}
        {built.nose.top.map(geometry => (
          <mesh key={geometry.uuid} castShadow material={paint.body} geometry={geometry} />
        ))}
        <mesh material={paint.glass} geometry={built.nose.windows} />
        {leg(0, noseWheel, -1.9, 0.41)}
      </Part>

      <Part airframe={airframe} name="leftWing">
        {wingPart(0)}
      </Part>
      <Part airframe={airframe} name="rightWing">
        {wingPart(1)}
      </Part>

      <Part airframe={airframe} name="tail">
        <group position={[0, RUDDER_ROOT[0], 0]}>
          <mesh castShadow material={paint.body} geometry={built.fin} />
          {/* The two rudder halves hinge on the fin's sloping trailing edge */}
          <group position={[0, 0, RUDDER_ROOT[1]]} rotation-x={RUDDER_LEAN}>
            {[-0.09, 0.09].map((x, i) => (
              <group
                key={x}
                ref={group => {
                  rudders.current[i] = group
                }}
                position={[x, 0, 0]}
              >
                <mesh castShadow material={paint.body} geometry={built.rudder} />
              </group>
            ))}
          </group>
        </group>
        {MAIN_ENGINES.map(([x, y]) => (
          <mesh
            key={x}
            castShadow
            material={built.bell}
            position={[x, y, 16.4]}
            rotation-x={QUARTER_TURN}
          >
            <cylinderGeometry args={[1.15, 0.45, 2.8, 24, 1, true]} />
          </mesh>
        ))}
      </Part>
    </group>
  )
}

// The Black Hawk's fuselage from the nose to the end of the tail boom
const BLACK_HAWK_BODY: Section[] = [
  [-7.55, 0.04, -0.6, -0.68, 2],
  [-7.4, 0.42, -0.36, -0.98, 2.2],
  [-7, 0.8, -0.1, -1.2, 2.6],
  [-6.6, 0.98, 0.12, -1.28, 3],
  [-5.7, 1.1, 0.8, -1.32, 3.6],
  [-4.8, 1.16, 0.86, -1.32, 4],
  [1.8, 1.18, 0.86, -1.3, 4],
  [3.4, 0.96, 0.84, -0.85, 3.4],
  [5.2, 0.52, 0.8, -0.2, 2.6],
  [7, 0.34, 0.74, 0.12, 2.2],
  [9, 0.26, 0.7, 0.32, 2.2],
  [9.9, 0.2, 0.68, 0.42, 2],
  [10.05, 0.03, 0.58, 0.54, 2]
]
// The engine deck on the cabin roof: the transmission fairing, tapering back into the boom
const BLACK_HAWK_DECK: Section[] = [
  [-3, 0.05, 0.86, 0.8, 2],
  [-2.3, 0.66, 1.42, 0.7, 3],
  [0.6, 0.8, 1.6, 0.7, 3.2],
  [2.3, 0.66, 1.42, 0.7, 3],
  [4, 0.26, 0.96, 0.7, 2.5],
  [4.7, 0.04, 0.8, 0.74, 2]
]
// Where the cockpit nose meets the cabin, the cabin meets the tail boom, and the windscreen runs
const COCKPIT_BACK = -4.6
const CABIN_BACK = 3.8
const WINDSCREEN: [number, number] = [-6.6, -5.7]
// The tail rotor shaft tilts 20° up from the body's x axis, so the tail rotor lifts as well
const TAIL_CANT = (20 * Math.PI) / 180
// The tail rotor turns 4.6 times for each turn of the main rotor
const TAIL_GEARING = 4.6
// Rotor speeds, as shares of 100%, over which each rotor's blades fade into a blurred disc
const MAIN_BLUR: [number, number] = [0.3, 0.5]
const TAIL_BLUR: [number, number] = [0.08, 0.2]
const DISC_OPACITY = 0.2
// Droop of the main blades in radians with the rotor stopped
const BLADE_DROOP = 0.045
const MAIN_TYRE = 0.33
const TAIL_TYRE = 0.2

/** Where the Black Hawk's lights sit in body axes: position lights, tail light, and beacon. */
export const BLACK_HAWK_LIGHTS = {
  left: new Vector3(-1, 0.7, 1),
  right: new Vector3(1, 0.7, 1),
  tail: new Vector3(0, 1, 10.2),
  top: new Vector3(0, 2.66, 9.75)
}

/** `sections` grown outward by `by` metres all round, for panels laid over the skin. */
const grown = (sections: Section[], by: number): Section[] =>
  sections.map(([z, halfWidth, top, bottom, square]) => [
    z,
    halfWidth + by,
    top + by,
    bottom - by,
    square
  ])

/** A band of angles around a lofted body on the right side and, mirrored, on the left. */
const bothSides = (from: number, to: number): [number, number][] => [
  [from, to],
  [Math.PI * 2 - to, Math.PI * 2 - from]
]

/** Angles of `count` blades spaced evenly round a hub. */
const spokes = (count: number) => Array.from({ length: count }, (_, i) => (i * Math.PI * 2) / count)

/** Share of a rotor's blur shown at `speed`, from 0 at the start of `range` to 1 at its end. */
const blurAt = (speed: number, [from, to]: [number, number]) =>
  Math.min(1, Math.max(0, (speed - from) / (to - from)))

/**
 * Sikorsky UH-60 Black Hawk: a long low cabin with sliding doors, the engine deck on the
 * roof, a tapering tail boom up to a swept pylon with the canted tail rotor on its right,
 * and the stabilator at its foot. The main rotor turns with the flight model's blade angle
 * and blurs into a disc at speed.
 */
function HelicopterModel(props: { spec: AircraftSpec; shape: HelicopterShape; rotor: RotorSpec }) {
  const { spec, shape, rotor } = props
  const airframe = useAirframe(spec, shape.paint, shape.accent)
  const { paint } = airframe
  const built = useMemo(() => {
    const top = Math.PI
    const screen: [number, number] = [top - 1.05, top + 1.05]
    const [nose, tail] = [BLACK_HAWK_BODY[0][0], BLACK_HAWK_BODY[BLACK_HAWK_BODY.length - 1][0]]
    const [deckFront, deckBack] = [
      BLACK_HAWK_DECK[0][0],
      BLACK_HAWK_DECK[BLACK_HAWK_DECK.length - 1][0]
    ]
    // Door panels sit 2 cm proud of the skin, and the windows proud of the doors
    const panels = grown(BLACK_HAWK_BODY, 0.02)
    const glazing = grown(BLACK_HAWK_BODY, 0.035)
    const band = (sections: Section[], from: number, to: number, arcs: [number, number][]) =>
      arcs.map(arc => loftGeometry(sections, from, to, arc))
    const chord = rotor.chord / 2
    const blade = () =>
      new MeshStandardMaterial({ color: '#26292b', roughness: 0.6, transparent: true })
    const disc = () =>
      new MeshStandardMaterial({
        color: '#2f332f',
        roughness: 1,
        transparent: true,
        opacity: 0,
        side: DoubleSide,
        depthWrite: false
      })
    return {
      mainBlade: blade(),
      tailBlade: blade(),
      mainDisc: disc(),
      tailDisc: disc(),
      nose: [
        loftGeometry(BLACK_HAWK_BODY, nose, COCKPIT_BACK, [0, screen[0]]),
        loftGeometry(BLACK_HAWK_BODY, nose, COCKPIT_BACK, [screen[1], top * 2]),
        loftGeometry(BLACK_HAWK_BODY, nose, WINDSCREEN[0], screen),
        loftGeometry(BLACK_HAWK_BODY, WINDSCREEN[1], COCKPIT_BACK, screen)
      ],
      windscreen: loftGeometry(BLACK_HAWK_BODY, WINDSCREEN[0], WINDSCREEN[1], screen),
      cockpitWindows: band(glazing, -5.5, -4.75, bothSides(1.72, 2.3)),
      cabin: loftGeometry(BLACK_HAWK_BODY, COCKPIT_BACK, CABIN_BACK),
      doors: band(panels, -3.5, -1.5, bothSides(1, 2.2)),
      // The gunner's window ahead of each door, then two windows in the door
      cabinWindows: [
        [-4.3, -3.8],
        [-3.25, -2.6],
        [-2.3, -1.7]
      ].flatMap(([from, to]) => band(glazing, from, to, bothSides(1.65, 2.05))),
      // The doors slide back along this rail
      rails: band(panels, -3.6, 0.6, bothSides(2.22, 2.28)),
      boom: loftGeometry(BLACK_HAWK_BODY, CABIN_BACK, tail),
      deck: loftGeometry(BLACK_HAWK_DECK, deckFront, deckBack),
      // Side view of the pylon as (height, z) pairs, stood upright on the boom
      pylon: plateGeometry(
        [
          [0.3, 7.5],
          [2.2, 9.1],
          [2.5, 9.45],
          [2.6, 9.95],
          [2.45, 10.2],
          [0.3, 10.1]
        ],
        0.3
      ).rotateZ(QUARTER_TURN),
      stabilator: plateGeometry(
        [
          [-2.19, 9.15],
          [-0.2, 8.95],
          [0.2, 8.95],
          [2.19, 9.15],
          [2.19, 9.9],
          [-2.19, 9.9]
        ],
        0.08
      ),
      // One main blade along +x, its leading edge toward -z, with the swept tip
      blade: plateGeometry(
        [
          [0.5, -chord * 0.6],
          [1, -chord],
          [rotor.radius - 0.6, -chord],
          [rotor.radius, -chord * 0.2],
          [rotor.radius, chord],
          [1, chord],
          [0.5, chord * 0.6]
        ],
        0.07
      )
    }
  }, [rotor])
  useDisposal(built)

  const mainRotor = useRef<Group>(null)
  const mainBlades = useRef<Group>(null)
  const mainDisc = useRef<Group>(null)
  const droops = useRef<(Group | null)[]>([])
  const tailRotor = useRef<Group>(null)
  const tailBlades = useRef<Group>(null)
  const tailDisc = useRef<Group>(null)
  const beacons = useRef<(Group | null)[]>([])
  const lamp = useRef<Group>(null)

  useFrame(({ clock }) => {
    const { sim, pilot, wreck } = game
    // The wreck keeps the rotors where they stopped
    const speed = wreck.active ? 0 : sim.rotorSpeed
    if (!wreck.active) {
      if (mainRotor.current) mainRotor.current.rotation.y = sim.rotorAngle
      if (tailRotor.current) tailRotor.current.rotation.x = sim.rotorAngle * TAIL_GEARING
    }
    // Fast blades fade into a faint disc, so they blur instead of strobing
    const blur = (
      share: number,
      blade: Material,
      disc: Material,
      blades: Group,
      blurred: Group
    ) => {
      blade.opacity = 1 - share
      disc.opacity = share * DISC_OPACITY
      blades.visible = share < 1
      blurred.visible = share > 0
    }
    if (mainBlades.current && mainDisc.current) {
      blur(
        blurAt(speed, MAIN_BLUR),
        built.mainBlade,
        built.mainDisc,
        mainBlades.current,
        mainDisc.current
      )
    }
    if (tailBlades.current && tailDisc.current) {
      blur(
        blurAt(speed, TAIL_BLUR),
        built.tailBlade,
        built.tailDisc,
        tailBlades.current,
        tailDisc.current
      )
    }
    // The blades droop at rest and straighten out as the rotor spins up
    const droop = -BLADE_DROOP * Math.max(0, 1 - speed / 0.5)
    for (const blade of droops.current) if (blade) blade.rotation.z = droop
    // The red beacons on the pylon and under the belly flash once a second
    const flash = !wreck.active && clock.elapsedTime % 1 < 0.12
    for (const beacon of beacons.current) if (beacon) beacon.visible = flash
    if (lamp.current) lamp.current.visible = pilot.landingLights && !wreck.active
  })

  const [tailWheel, leftMain, rightMain] = spec.contactPoints.map(point => point.position)
  const roof = (z: number) => sectionAt(BLACK_HAWK_BODY, z)[2]
  /** A main wheel on its shock strut up to the cabin side, braced by a drag beam behind it. */
  const mainLeg = (wheel: Vector3) => {
    const side = Math.sign(wheel.x)
    const axle: [number, number, number] = [wheel.x, wheel.y + MAIN_TYRE, wheel.z]
    const hub: [number, number, number] = [wheel.x - side * 0.12, axle[1], wheel.z]
    return (
      <group key={side}>
        <Strut
          from={[side * 1.12, -0.55, wheel.z - 0.15]}
          to={hub}
          radius={0.07}
          material={paint.dark}
        />
        <Strut
          from={[side * 0.85, -1.2, wheel.z + 1]}
          to={hub}
          radius={0.06}
          material={paint.dark}
        />
        <Wheel position={axle} radius={MAIN_TYRE} material={paint.dark} />
      </group>
    )
  }
  const beacon = (index: number, position: Vector3 | [number, number, number]) => (
    <group
      ref={group => {
        beacons.current[index] = group
      }}
      position={position}
    >
      <mesh material={paint.red}>
        <sphereGeometry args={[0.08, 8, 6]} />
      </mesh>
    </group>
  )
  const tailAxle = tailWheel.y + TAIL_TYRE
  const tailBladeLength = rotor.tailRadius - 0.15

  return (
    <group ref={airframe.root}>
      <Part airframe={airframe} name="fuselage">
        <mesh castShadow material={paint.body} geometry={built.cabin} />
        {built.doors.map(geometry => (
          <mesh key={geometry.uuid} material={paint.accent} geometry={geometry} />
        ))}
        {built.cabinWindows.map(geometry => (
          <mesh key={geometry.uuid} material={paint.glass} geometry={geometry} />
        ))}
        {built.rails.map(geometry => (
          <mesh key={geometry.uuid} material={paint.dark} geometry={geometry} />
        ))}
        {mainLeg(leftMain)}
        {mainLeg(rightMain)}
        {/* Position lights: red on the left, green on the right */}
        <mesh material={paint.red} position={BLACK_HAWK_LIGHTS.left}>
          <sphereGeometry args={[0.06, 8, 6]} />
        </mesh>
        <mesh material={paint.green} position={BLACK_HAWK_LIGHTS.right}>
          <sphereGeometry args={[0.06, 8, 6]} />
        </mesh>
        {beacon(1, [0, -1.36, 0.6])}
      </Part>

      <Part airframe={airframe} name="nose">
        {built.nose.map(geometry => (
          <mesh key={geometry.uuid} castShadow material={paint.body} geometry={geometry} />
        ))}
        <mesh material={paint.glass} geometry={built.windscreen} />
        {built.cockpitWindows.map(geometry => (
          <mesh key={geometry.uuid} material={paint.glass} geometry={geometry} />
        ))}
        {/* Post between the two windscreen panes, and the pitot tubes over the cockpit roof */}
        <Strut
          from={[0, roof(WINDSCREEN[0]) + 0.03, WINDSCREEN[0]]}
          to={[0, roof(WINDSCREEN[1]) + 0.03, WINDSCREEN[1]]}
          radius={0.035}
          material={paint.dark}
        />
        {[-0.35, 0.35].map(x => (
          <Strut
            key={x}
            from={[x, 0.86, -5.2]}
            to={[x, 0.9, -6.1]}
            radius={0.02}
            material={paint.dark}
          />
        ))}
        <group ref={lamp} position={[0, -1.3, -6.3]}>
          <mesh>
            <sphereGeometry args={[0.1, 8, 6]} />
            <meshBasicMaterial color="#fffbe6" toneMapped={false} />
          </mesh>
        </group>
      </Part>

      <Part airframe={airframe} name="leftWing">
        <group position={rotor.hub}>
          {/* Mast up from the transmission */}
          <mesh castShadow material={paint.dark} position={[0, -0.25, 0]}>
            <cylinderGeometry args={[0.16, 0.2, 0.5, 12]} />
          </mesh>
          <group ref={mainRotor}>
            <mesh castShadow material={paint.dark}>
              <cylinderGeometry args={[0.42, 0.42, 0.18, 12]} />
            </mesh>
            {/* The bifilar vibration absorber on top of the hub: four arms with weights */}
            <mesh material={paint.dark} position={[0, 0.2, 0]}>
              <boxGeometry args={[1.1, 0.05, 0.08]} />
            </mesh>
            <mesh material={paint.dark} position={[0, 0.2, 0]}>
              <boxGeometry args={[0.08, 0.05, 1.1]} />
            </mesh>
            {[0, 1, 2, 3].map(i => (
              <mesh
                key={i}
                material={paint.dark}
                position={[
                  Math.cos(i * QUARTER_TURN) * 0.55,
                  0.2,
                  Math.sin(i * QUARTER_TURN) * 0.55
                ]}
              >
                <sphereGeometry args={[0.08, 8, 6]} />
              </mesh>
            ))}
            <group ref={mainBlades}>
              {spokes(rotor.blades).map((angle, i) => (
                <group key={angle} rotation-y={angle}>
                  <group
                    ref={group => {
                      droops.current[i] = group
                    }}
                  >
                    <mesh castShadow material={built.mainBlade} geometry={built.blade} />
                  </group>
                </group>
              ))}
            </group>
          </group>
          <group ref={mainDisc}>
            <mesh material={built.mainDisc} rotation-x={-QUARTER_TURN}>
              <ringGeometry args={[0.45, rotor.radius, 48]} />
            </mesh>
          </group>
        </group>
      </Part>

      <Part airframe={airframe} name="rightWing">
        <mesh castShadow material={paint.body} geometry={built.deck} />
        {/* The two engines either side of the transmission, exhausts turned outward */}
        {[-1, 1].map(side => (
          <group key={side}>
            <mesh
              castShadow
              material={paint.accent}
              position={[side * 0.82, 1.18, -0.3]}
              rotation-x={QUARTER_TURN}
            >
              <cylinderGeometry args={[0.33, 0.38, 3.2, 16]} />
            </mesh>
            <mesh material={paint.dark} position={[side * 0.82, 1.18, -1.91]} rotation-y={Math.PI}>
              <circleGeometry args={[0.31, 16]} />
            </mesh>
            <Strut
              from={[side * 0.82, 1.18, 1.1]}
              to={[side * 1.17, 1.2, 1.75]}
              radius={0.2}
              material={paint.dark}
            />
          </group>
        ))}
      </Part>

      <Part airframe={airframe} name="tail">
        <mesh castShadow material={paint.body} geometry={built.boom} />
        <mesh castShadow material={paint.body} geometry={built.pylon} />
        <mesh
          castShadow
          material={paint.body}
          position={[0, 0.22, 0]}
          geometry={built.stabilator}
        />
        <group position={rotor.tailHub} rotation-z={TAIL_CANT}>
          {/* Gearbox fairing out from the pylon to the hub */}
          <mesh castShadow material={paint.body} position={[-0.2, 0, 0]} rotation-z={QUARTER_TURN}>
            <cylinderGeometry args={[0.15, 0.18, 0.4, 12]} />
          </mesh>
          <group ref={tailRotor}>
            <mesh material={paint.dark} position={[0.05, 0, 0]} rotation-z={QUARTER_TURN}>
              <cylinderGeometry args={[0.12, 0.12, 0.2, 10]} />
            </mesh>
            <group ref={tailBlades}>
              {spokes(rotor.tailBlades).map(angle => (
                <group key={angle} rotation-x={angle}>
                  <mesh
                    castShadow
                    material={built.tailBlade}
                    position={[0.05, 0.15 + tailBladeLength / 2, 0]}
                  >
                    <boxGeometry args={[0.04, tailBladeLength, 0.25]} />
                  </mesh>
                </group>
              ))}
            </group>
          </group>
          <group ref={tailDisc}>
            <mesh material={built.tailDisc} position={[0.05, 0, 0]} rotation-y={QUARTER_TURN}>
              <circleGeometry args={[rotor.tailRadius, 32]} />
            </mesh>
          </group>
        </group>
        {/* Tail wheel on a long strut under the boom, in a fork */}
        <Strut
          from={[0, -0.25, tailWheel.z - 0.55]}
          to={[0, tailAxle + 0.35, tailWheel.z - 0.05]}
          radius={0.07}
          material={paint.dark}
        />
        <mesh material={paint.dark} position={[0, tailAxle + 0.35, tailWheel.z - 0.05]}>
          <boxGeometry args={[0.3, 0.06, 0.14]} />
        </mesh>
        {[-0.12, 0.12].map(x => (
          <Strut
            key={x}
            from={[x, tailAxle + 0.35, tailWheel.z - 0.05]}
            to={[x, tailAxle, tailWheel.z]}
            radius={0.03}
            material={paint.dark}
          />
        ))}
        <Wheel position={[0, tailAxle, tailWheel.z]} radius={TAIL_TYRE} material={paint.dark} />
        {beacon(0, BLACK_HAWK_LIGHTS.top)}
      </Part>
    </group>
  )
}

const TRIM = new MeshStandardMaterial({ color: '#14171a', roughness: 0.9 })

/**
 * What the pilot sees of their own aircraft from the seat: the glareshield and the frame
 * around the windows. Shown only in cockpit view.
 */
function Cockpit({ spec }: { spec: AircraftSpec }) {
  const frame = useRef<Group>(null)
  useFrame(() => {
    if (!frame.current) return
    frame.current.visible = game.getState().camera === 'cockpit' && !game.wreck.active
    frame.current.position.copy(game.sim.position)
    frame.current.quaternion.copy(game.sim.orientation)
  })
  const { eye } = spec.camera
  const { shape } = spec
  const kind = shape.type === 'propeller' && shape.variant === 'mustang' ? 'mustang' : shape.type
  return (
    <group ref={frame}>
      {/* Drawn 2.6 times life size around the eye: it looks the same from the seat,
          and nothing sits closer than the camera can draw */}
      <group position={eye} scale={2.6}>
        {kind === 'helicopter' ? (
          <>
            {/* A low panel with chin windows ahead of it, so you see the pad as you look down */}
            <mesh material={TRIM} position={[-eye.x, -0.66, -0.42]}>
              <boxGeometry args={[2.6, 0.1, 0.5]} />
            </mesh>
            <mesh material={TRIM} position={[-eye.x, -0.4, -0.95]}>
              <boxGeometry args={[2.3, 0.03, 0.03]} />
            </mesh>
            {[-eye.x - 0.6, -eye.x, -eye.x + 0.6].map(x => (
              <mesh key={x} material={TRIM} position={[x, -0.53, -0.8]} rotation-x={-0.6}>
                <boxGeometry args={[0.03, 0.4, 0.03]} />
              </mesh>
            ))}
          </>
        ) : (
          <>
            {/* Glareshield across the bottom of the view */}
            <mesh material={TRIM} position={[-eye.x, -0.4, -0.85]}>
              <boxGeometry args={[2.6, 0.1, 0.9]} />
            </mesh>
            {/* Instrument panel face below it, so the ground never shows under the glareshield */}
            <mesh material={TRIM} position={[-eye.x, -1.15, -0.5]}>
              <boxGeometry args={[2.6, 1.5, 0.1]} />
            </mesh>
          </>
        )}
        {kind === 'fighter' && (
          <>
            {/* Canopy bow, and the frame of the head-up display glass */}
            <mesh material={TRIM} position={[0, -0.32, -0.95]}>
              <torusGeometry args={[0.62, 0.028, 8, 28, Math.PI]} />
            </mesh>
            {[-0.17, 0.17].map(x => (
              <mesh key={x} material={TRIM} position={[x, -0.2, -0.62]}>
                <boxGeometry args={[0.012, 0.32, 0.012]} />
              </mesh>
            ))}
          </>
        )}
        {(kind === 'airliner' || kind === 'bomber' || kind === 'shuttle') && (
          <>
            {/* Centre post between the two windscreens, side post, and the roof */}
            <mesh material={TRIM} position={[-eye.x, 0.12, -1.05]} rotation-x={0.5}>
              <boxGeometry args={[0.08, 1.1, 0.08]} />
            </mesh>
            <mesh material={TRIM} position={[-0.8, 0.12, -0.75]} rotation-x={0.4}>
              <boxGeometry args={[0.1, 1.1, 0.1]} />
            </mesh>
            <mesh material={TRIM} position={[-eye.x, 0.56, -0.6]} rotation-x={-0.5}>
              <boxGeometry args={[2.8, 0.1, 0.9]} />
            </mesh>
          </>
        )}
        {kind === 'propeller' && (
          <>
            {/* Engine cowl ahead, door posts, and the wing overhead */}
            <mesh position={[-eye.x, -0.62, -1.7]}>
              <boxGeometry args={[1.05, 0.3, 1.3]} />
              <meshStandardMaterial color="#f3f2ee" roughness={0.5} />
            </mesh>
            {[-0.45, 0.95].map(x => (
              <mesh key={x} material={TRIM} position={[x, 0.05, -0.7]} rotation-x={0.45}>
                <boxGeometry args={[0.06, 1, 0.06]} />
              </mesh>
            ))}
            <mesh material={TRIM} position={[-eye.x, 0.45, -0.3]}>
              <boxGeometry args={[3.2, 0.08, 1.4]} />
            </mesh>
          </>
        )}
        {kind === 'helicopter' && (
          <>
            {/* Posts at the middle and the sides of the sloping windscreen */}
            {[-eye.x, -eye.x - 1, -eye.x + 1].map(x => (
              <mesh key={x} material={TRIM} position={[x, -0.02, -0.72]} rotation-x={0.95}>
                <boxGeometry args={[x === -eye.x ? 0.022 : 0.03, 1.15, 0.022]} />
              </mesh>
            ))}
            {/* Roof bow above the windscreen, the overhead console, and the door frame beside you */}
            <mesh material={TRIM} position={[-eye.x, 0.36, -0.27]}>
              <boxGeometry args={[2.3, 0.08, 0.08]} />
            </mesh>
            <mesh material={TRIM} position={[-eye.x, 0.42, 0.2]}>
              <boxGeometry args={[0.36, 0.1, 0.9]} />
            </mesh>
            {[-eye.x - 1.12, -eye.x + 1.12].map(x => (
              <mesh key={x} material={TRIM} position={[x, -0.05, -0.12]}>
                <boxGeometry args={[0.08, 1, 0.08]} />
              </mesh>
            ))}
          </>
        )}
        {kind === 'mustang' && (
          <>
            {/* The long nose with its anti-glare panel, and the windscreen frame */}
            <mesh position={[0, -0.55, -2.2]}>
              <boxGeometry args={[0.6, 0.22, 2.6]} />
              <meshStandardMaterial color="#4b4f32" roughness={0.8} />
            </mesh>
            <mesh material={TRIM} position={[0, -0.3, -0.85]}>
              <torusGeometry args={[0.5, 0.025, 8, 28, Math.PI]} />
            </mesh>
            {[-0.3, 0.3].map(x => (
              <mesh key={x} material={TRIM} position={[x, -0.12, -0.78]} rotation-x={0.5}>
                <boxGeometry args={[0.012, 0.4, 0.012]} />
              </mesh>
            ))}
          </>
        )}
      </group>
    </group>
  )
}

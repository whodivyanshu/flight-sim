import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { type PerspectiveCamera, Quaternion, Vector3 } from 'three'
import { game, useGame } from '../game/game'
import { type LookView, runwayFocus } from '../game/look'
import { heightAt } from '../world/island'

const FORWARD = new Vector3(0, 0, -1)
/** Vertical field of view in degrees from the pilot's seat. */
export const COCKPIT_FOV = 68
/** Pixels the view is shifted up so the horizon clears the instrument panel. */
export const horizonShift = (height: number) => Math.min(90, height * 0.11)
const CHASE_FOV = 58
// The chase camera looks this many aircraft-distances past the nose,
// so the runway stays visible on approach
const CHASE_LOOK_AHEAD = 1.9
// Radians per second the camera circles a wreck or a bomb's blast
const ORBIT_RATE = 0.14
// Metres out from a bomb's blast, and up, that the camera circles it
const BLAST_ORBIT = 200
const BLAST_HEIGHT = 80
// The bombsight looks out from under the belly, in body axes, with a narrow view
const SIGHT_EYE = new Vector3(0, -2.5, 0.5)
const SIGHT_FOV = 40
// A helicopter's views turn toward the ground below it as it slows, fully by the lower
// ground speed and not at all from the upper one (m/s)
const HOVER_VIEW_FROM = 8
const HOVER_VIEW_TO = 25
// In a hover the chase camera rises this many metres and pulls in by this share
const HOVER_RISE = 9
const HOVER_PULL = 0.15
// It looks at the ground under the helicopter, but never more than this many metres below it,
// so a high hover keeps the helicopter on screen
const HOVER_LOOK_DROP = 8
// Radians the pilot looks down in a hover, toward the pad past the nose
const HOVER_LOOK_DOWN = 0.38
// The chase camera circles no lower or higher than this, in radians from level, so it never
// turns over the top
const ORBIT_LOWEST = -1.3
const ORBIT_HIGHEST = 1.45
// Pixels per line and per page of wheel scroll, for mice that scroll by lines
const WHEEL_LINE = 33
const WHEEL_PAGE = 800
const forward = new Vector3()
const target = new Vector3()
const goal = new Vector3()
const aim = new Vector3()
const ahead = new Vector3()
const below = new Vector3()
const offset = new Vector3()
const runway = new Vector3()
const subject = new Vector3()
const inverse = new Quaternion()

const viewers = new Set<(camera: PerspectiveCamera) => void>()

/**
 * Calls `listener` every frame once the camera has moved, for overlays pinned to a place in
 * the world. Returns a function that stops the calls.
 */
export function onCameraMoved(listener: (camera: PerspectiveCamera) => void) {
  viewers.add(listener)
  return () => {
    viewers.delete(listener)
  }
}

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * Drives the camera: a smoothed chase view, the pilot's seat, or a slow circle around a wreck.
 * A slow helicopter's views turn down toward the ground below, so you can see where you land.
 */
export function CameraRig() {
  const mode = useGame(state => state.camera)
  const camera = useThree(state => state.camera) as PerspectiveCamera
  const size = useThree(state => state.size)
  const trail = useRef(new Vector3(0, 0, -1))
  const orbit = useRef({ angle: 0, started: false, focus: new Vector3() })
  const bombsight = useGame(state => state.bombsight)
  // Where the bombsight looks, eased so it swings smoothly between the cross and a blast
  const sight = useRef<Vector3 | null>(null)
  // How far a helicopter's view has turned toward the ground below, from 0 to 1, eased
  const hovering = useRef(0)

  // Shifts the view up so the horizon sits in the middle of the area above the instrument panel
  useEffect(() => {
    const shift = horizonShift(size.height)
    camera.setViewOffset(size.width, size.height, 0, shift, size.width, size.height)
    return () => camera.clearViewOffset()
  }, [camera, size])

  useLookControls()

  useFrame((_, delta) => {
    // The free camera of photo mode has the view until it closes
    if (game.getState().photo) return
    const { sim, wreck, effects, bombs, look } = game
    const view = sim.spec.camera
    const circle = orbit.current
    const blast = game.blastReplay
    // The wheel zooms the cockpit view, but not the circle round a wreck or a blast
    const zoom = wreck.active || blast ? 1 : look.fov
    const fov = bombsight ? SIGHT_FOV : mode === 'cockpit' ? COCKPIT_FOV * zoom : CHASE_FOV
    if (camera.fov !== fov) {
      camera.fov = fov
      camera.updateProjectionMatrix()
    }
    const slow = sim.spec.rotor
      ? 1 - smoothstep(HOVER_VIEW_FROM, HOVER_VIEW_TO, sim.groundSpeed)
      : 0
    hovering.current += (slow - hovering.current) * (1 - Math.exp(-delta * 2))
    const hover = hovering.current

    if (wreck.active || blast) {
      sight.current = null
      const focus = blast ?? wreck.pieces[0].position
      if (!circle.started) {
        // Start the circle from wherever the camera was at the moment of the crash or blast
        circle.started = true
        circle.angle = Math.atan2(camera.position.z - focus.z, camera.position.x - focus.x)
        circle.focus.copy(focus)
      }
      circle.angle += ORBIT_RATE * delta
      circle.focus.lerp(focus, 1 - Math.exp(-delta * 3))
      goal
        .set(Math.cos(circle.angle), 0, Math.sin(circle.angle))
        .multiplyScalar(blast ? BLAST_ORBIT : view.distance * 1.9)
      goal
        .add(circle.focus)
        .setY(Math.max(circle.focus.y, 0) + (blast ? BLAST_HEIGHT : view.height * 2.2))
      // A blast far from the aircraft needs a cut, not a long glide across the sky
      if (blast && camera.position.distanceTo(goal) > BLAST_ORBIT * 4) camera.position.copy(goal)
      camera.position.lerp(goal, 1 - Math.exp(-delta * 1.6))
      keepAboveGround(camera.position, 2.5)
      camera.up.set(0, 1, 0)
      camera.lookAt(target.copy(circle.focus).setY(circle.focus.y + 1.5))
    } else if (game.getState().bombsight) {
      circle.started = false
      camera.position.copy(SIGHT_EYE).applyQuaternion(sim.orientation).add(sim.position)
      // Ground track, flat
      ahead.set(sim.velocity.x, 0, sim.velocity.z)
      if (ahead.lengthSq() < 1) ahead.set(0, 0, -1).applyQuaternion(sim.orientation).setY(0)
      ahead.normalize()
      const wanted =
        bombs.sightPoint(sim) ??
        goal
          .copy(sim.position)
          .addScaledVector(ahead, 600)
          .setY(sim.position.y - 800)
      if (!sight.current) sight.current = wanted.clone()
      else sight.current.lerp(wanted, 1 - Math.exp(-delta * 4))
      // Pitch down to the sight point without rolling, so the track stays at the top
      aim.copy(sight.current).sub(camera.position).normalize()
      const down = Math.max(0, -aim.y)
      camera.up
        .set(0, 1, 0)
        .multiplyScalar(Math.sqrt(1 - down * down))
        .addScaledVector(ahead, down)
      camera.lookAt(sight.current)
    } else if (mode === 'cockpit') {
      sight.current = null
      circle.started = false
      camera.position.copy(view.eye).applyQuaternion(sim.orientation).add(sim.position)
      // Watching the runway: turn the head to it, wherever it is around the aircraft
      if (look.focus === 'runway') {
        runwayFocus(sim.position.x, sim.position.z, game.nav.approach, runway)
        aim.copy(runway).sub(camera.position)
        aim.applyQuaternion(inverse.copy(sim.orientation).invert())
        look.update(delta, 'cockpit', {
          yaw: Math.atan2(-aim.x, -aim.z),
          pitch: Math.atan2(aim.y, Math.hypot(aim.x, aim.z)) + hover * HOVER_LOOK_DOWN
        })
      } else look.update(delta, 'cockpit')
      camera.quaternion.copy(sim.orientation)
      camera.rotateY(look.yaw)
      camera.rotateX(look.pitch - hover * HOVER_LOOK_DOWN)
    } else {
      sight.current = null
      circle.started = false
      look.update(delta, 'chase')
      // The camera swings behind the nose with a short lag, or watching the runway, round to
      // the far side of the aircraft from it. It follows only part of the climb or descent,
      // so it stays above the tail in a climb or flare.
      if (look.focus === 'runway') {
        runwayFocus(sim.position.x, sim.position.z, game.nav.approach, forward)
        forward.sub(sim.position)
      } else forward.copy(FORWARD).applyQuaternion(sim.orientation)
      forward.y *= 0.4
      if (forward.lengthSq() < 1e-6) forward.copy(trail.current)
      trail.current.lerp(forward.normalize(), 1 - Math.exp(-delta * 4)).normalize()
      const back = view.distance * (1 - hover * HOVER_PULL) * look.distance
      offset.copy(trail.current).multiplyScalar(-back)
      offset.y += (view.height + hover * HOVER_RISE) * look.distance
      target
        .copy(sim.position)
        .addScaledVector(trail.current, view.distance * look.distance * CHASE_LOOK_AHEAD)
      target.y += 1
      // A slow helicopter's camera looks down at the pad or ground under it instead
      if (hover > 0.001) {
        below.copy(sim.position)
        below.y -= Math.min(Math.max(sim.altitudeAgl, 0), HOVER_LOOK_DROP)
        target.lerp(below, hover)
      }
      subject.copy(sim.position)
      subject.y += 1
      // How far above the aircraft the normal view aims, in radians. The camera, the aircraft
      // and the point it aims at all lie in one upright plane, so this is the whole difference.
      aim.copy(sim.position).add(offset)
      const lift = elevation(aim, target) - elevation(aim, subject)
      // Dragging circles the camera round the aircraft, and up over it or down below it
      if (look.yaw !== 0 || look.pitch !== 0) {
        const reach = offset.length()
        const turn = Math.atan2(offset.x, offset.z) + look.yaw
        const tilt = Math.atan2(offset.y, Math.hypot(offset.x, offset.z)) - look.pitch
        const height = Math.min(Math.max(tilt, ORBIT_LOWEST), ORBIT_HIGHEST)
        offset
          .set(
            Math.sin(turn) * Math.cos(height),
            Math.sin(height),
            Math.cos(turn) * Math.cos(height)
          )
          .multiplyScalar(reach)
      }
      camera.position.copy(sim.position).add(offset)
      keepAboveGround(camera.position, 1.2)
      // As the camera circles, the aircraft holds its place on screen, as in the normal view:
      // aim at it, then tilt up by as much as the normal view aims above it
      camera.up.set(0, 1, 0)
      camera.lookAt(subject)
      camera.rotateX(lift)
    }

    // The blast of a crash shakes the view
    const shake = effects.shake * 0.05
    if (shake > 0.0005) {
      camera.rotateX((Math.random() - 0.5) * shake)
      camera.rotateZ((Math.random() - 0.5) * shake)
    }
    camera.updateMatrixWorld()
    for (const viewer of viewers) viewer(camera)
  })
  return null
}

/**
 * Mouse controls for looking around while flying. Dragging on the view turns it, the wheel
 * zooms, and a double-click looks ahead again. Photo mode and the bombsight keep the mouse.
 */
function useLookControls() {
  const canvas = useThree(state => state.gl.domElement)
  useEffect(() => {
    // A finger dragging on a touch screen looks around too, rather than scrolling the page
    canvas.style.touchAction = 'none'
    // The mouse position while dragging, or null
    let drag: { x: number; y: number } | null = null
    const looking = () => {
      const { photo, bombsight, status } = game.getState()
      return !photo && !bombsight && status !== 'crashed' && !game.wreck.active
    }
    const view = (): LookView => game.getState().camera
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !looking()) return
      drag = { x: event.clientX, y: event.clientY }
      canvas.setPointerCapture(event.pointerId)
      canvas.style.cursor = 'grabbing'
    }
    const pointerMove = (event: PointerEvent) => {
      if (!drag) return
      if (looking()) game.look.drag(event.clientX - drag.x, event.clientY - drag.y, view())
      drag.x = event.clientX
      drag.y = event.clientY
    }
    const pointerUp = () => {
      if (!drag) return
      drag = null
      canvas.style.cursor = ''
    }
    const doubleClick = () => {
      if (looking()) game.look.lookAhead()
    }
    const wheel = (event: WheelEvent) => {
      if (!looking()) return
      event.preventDefault()
      const pixels =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? WHEEL_LINE
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? WHEEL_PAGE
            : 1
      game.look.zoom(event.deltaY * pixels, view())
    }
    canvas.addEventListener('pointerdown', pointerDown)
    canvas.addEventListener('pointermove', pointerMove)
    canvas.addEventListener('pointerup', pointerUp)
    canvas.addEventListener('pointercancel', pointerUp)
    canvas.addEventListener('lostpointercapture', pointerUp)
    canvas.addEventListener('dblclick', doubleClick)
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => {
      canvas.removeEventListener('pointerdown', pointerDown)
      canvas.removeEventListener('pointermove', pointerMove)
      canvas.removeEventListener('pointerup', pointerUp)
      canvas.removeEventListener('pointercancel', pointerUp)
      canvas.removeEventListener('lostpointercapture', pointerUp)
      canvas.removeEventListener('dblclick', doubleClick)
      canvas.removeEventListener('wheel', wheel)
    }
  }, [canvas])
}

/** Radians above level that `to` lies, seen from `from`. */
function elevation(from: Vector3, to: Vector3) {
  return Math.atan2(to.y - from.y, Math.hypot(to.x - from.x, to.z - from.z))
}

function keepAboveGround(position: Vector3, clearance: number) {
  const floor = Math.max(heightAt(position.x, position.z), 0) + clearance
  if (position.y < floor) position.y = floor
}

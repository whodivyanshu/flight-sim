import type { Vector3 } from 'three'
import { type Approach, onCentreline, RUNWAY_ENDS, type RunwayEnd } from '../world/approaches'

/** The two flying views the player can look around in. */
export type LookView = 'chase' | 'cockpit'

/**
 * Where the view points, on top of the normal chase or cockpit view. Free: where the mouse
 * left it. Runway: swinging to keep the runway in sight. Ahead: swinging back to normal.
 */
export type LookFocus = 'free' | 'runway' | 'ahead'

// Radians the view turns for each pixel the mouse drags, as in photo mode
const TURN = 0.004
// Furthest the pilot turns their head from straight ahead, left or right, then up and down
const HEAD_TURN = 2.8
const HEAD_UP = 1.3
const HEAD_DOWN = 1.1
// Furthest the chase camera swings up or down from its normal height, in radians
const ORBIT_TILT = 1.4
// Nearest and farthest chase camera, as a share of the aircraft's normal distance
const NEAREST = 0.4
const FARTHEST = 4
// Narrowest and widest cockpit view, as a share of the normal field of view
const ZOOM_IN = 0.4
const ZOOM_OUT = 1.3
// Zoom per pixel the wheel scrolls
const ZOOM_RATE = 0.001
// How quickly the view swings to the runway or back ahead, per second
const SWING = 5
// Close enough to straight ahead, in radians, and to normal zoom, to stop swinging
const SETTLED = 0.002
// Metres past the threshold the runway view aims at, where the wheels should touch down
const TOUCHDOWN = 300

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
/** The same angle between -π and π. */
const wrap = (angle: number) => angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI))

/**
 * How far the player has turned the view with the mouse. In the chase view the camera
 * circles the aircraft; in the cockpit the pilot turns their head.
 */
export class Look {
  /** Radians the view has turned from straight ahead, positive to the left. */
  yaw = 0
  /** Radians the view has tilted from normal, positive looking up. */
  pitch = 0
  /** Chase camera distance as a share of the aircraft's normal one. */
  distance = 1
  /** Cockpit field of view as a share of the normal one. Smaller zooms in. */
  fov = 1
  focus: LookFocus = 'free'

  /** True while the view differs from the normal one. */
  get moved() {
    return this.yaw !== 0 || this.pitch !== 0 || this.distance !== 1 || this.fov !== 1
  }

  /** Turns the view by a mouse drag of `dx` and `dy` pixels: right looks right, up looks up. */
  drag(dx: number, dy: number, view: LookView) {
    this.focus = 'free'
    this.yaw -= dx * TURN
    this.pitch -= dy * TURN
    this.limit(view)
  }

  /** Zooms by a wheel scroll of `dy` pixels: forward zooms in, back zooms out. */
  zoom(dy: number, view: LookView) {
    const factor = Math.exp(dy * ZOOM_RATE)
    if (view === 'cockpit') this.fov = clamp(this.fov * factor, ZOOM_IN, ZOOM_OUT)
    else this.distance = clamp(this.distance * factor, NEAREST, FARTHEST)
  }

  /** Swings the view back to normal. */
  lookAhead() {
    if (this.moved || this.focus === 'runway') this.focus = 'ahead'
  }

  /** Starts keeping the runway in sight, or swings back ahead if already doing so. */
  toggleRunway() {
    if (this.focus === 'runway') this.lookAhead()
    else this.focus = 'runway'
  }

  /** Snaps straight back to the normal view, for a new flight or a change of view. */
  reset() {
    this.yaw = 0
    this.pitch = 0
    this.distance = 1
    this.fov = 1
    this.focus = 'free'
  }

  /**
   * Swings the view a step toward the runway or back ahead. `toward` is the yaw and pitch
   * that would put the runway in the middle of the view, while it is being watched.
   */
  update(dt: number, view: LookView, toward?: { yaw: number; pitch: number }) {
    if (this.focus === 'free') return
    const share = 1 - Math.exp(-dt * SWING)
    const goal = this.focus === 'runway' && toward ? toward : { yaw: 0, pitch: 0 }
    // The chase camera circles the shortest way round. The pilot's head can't turn through
    // the back of the seat, so it always turns through the front.
    const turn = goal.yaw - this.yaw
    this.yaw += (view === 'chase' ? wrap(turn) : turn) * share
    this.pitch += (goal.pitch - this.pitch) * share
    this.limit(view)
    if (this.focus !== 'ahead') return
    // Ease the zoom back by the same share of the way, evenly in and out
    this.distance *= this.distance ** -share
    this.fov *= this.fov ** -share
    const settled =
      Math.abs(this.yaw) < SETTLED &&
      Math.abs(this.pitch) < SETTLED &&
      Math.abs(Math.log(this.distance)) < SETTLED &&
      Math.abs(Math.log(this.fov)) < SETTLED
    if (settled) this.reset()
  }

  private limit(view: LookView) {
    if (view === 'cockpit') {
      this.yaw = clamp(this.yaw, -HEAD_TURN, HEAD_TURN)
      this.pitch = clamp(this.pitch, -HEAD_DOWN, HEAD_UP)
    } else {
      this.yaw = wrap(this.yaw)
      this.pitch = clamp(this.pitch, -ORBIT_TILT, ORBIT_TILT)
    }
  }
}

/**
 * The runway to watch: the picked approach's, or else the nearest runway end. Puts the point
 * where its wheels should touch down into `out`.
 */
export function runwayFocus(x: number, z: number, approach: Approach | null, out: Vector3) {
  let end: RunwayEnd = approach?.end ?? RUNWAY_ENDS[0]
  if (!approach) {
    let nearest = Number.POSITIVE_INFINITY
    for (const candidate of RUNWAY_ENDS) {
      const distance = (candidate.x - x) ** 2 + (candidate.z - z) ** 2
      if (distance < nearest) {
        nearest = distance
        end = candidate
      }
    }
  }
  const touchdown = onCentreline(end, -TOUCHDOWN)
  out.set(touchdown.x, end.elevation, touchdown.z)
  return end
}

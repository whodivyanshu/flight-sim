import { expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { APPROACHES, onCentreline, RUNWAY_ENDS } from '../world/approaches'
import { Look, runwayFocus } from './look'

/** Steps the view's swing for `seconds`, 60 times a second. */
function swing(
  look: Look,
  view: 'chase' | 'cockpit',
  seconds: number,
  toward?: { yaw: number; pitch: number }
) {
  for (let t = 0; t < seconds; t += 1 / 60) look.update(1 / 60, view, toward)
}

test('dragging right looks right and dragging up looks up', () => {
  const look = new Look()
  look.drag(100, -50, 'chase')
  expect(look.yaw).toBeLessThan(0)
  expect(look.pitch).toBeGreaterThan(0)
  expect(look.moved).toBe(true)
})

test('the chase camera circles all the way round, but stops short of turning over', () => {
  const look = new Look()
  // A long drag right goes past a full turn and comes back round
  look.drag(2000, 0, 'chase')
  expect(Math.abs(look.yaw)).toBeLessThanOrEqual(Math.PI)
  look.drag(0, 5000, 'chase')
  expect(look.pitch).toBeGreaterThan(-Math.PI / 2)
})

test("the pilot's head turns no further than over the shoulder", () => {
  const look = new Look()
  look.drag(5000, 5000, 'cockpit')
  expect(look.yaw).toBeGreaterThan(-Math.PI)
  expect(look.pitch).toBeGreaterThan(-Math.PI / 2)
  look.drag(-10_000, -10_000, 'cockpit')
  expect(look.yaw).toBeLessThan(Math.PI)
  expect(look.pitch).toBeLessThan(Math.PI / 2)
})

test('the wheel zooms the cockpit view and the chase distance within limits', () => {
  const look = new Look()
  look.zoom(-100, 'cockpit')
  expect(look.fov).toBeLessThan(1)
  look.zoom(100_000, 'cockpit')
  expect(look.fov).toBeLessThan(2)
  look.zoom(100, 'chase')
  expect(look.distance).toBeGreaterThan(1)
  look.zoom(-100_000, 'chase')
  expect(look.distance).toBeGreaterThan(0.1)
})

test('a double-click swings the view smoothly back ahead, zoom included', () => {
  const look = new Look()
  look.drag(300, 100, 'chase')
  look.zoom(400, 'chase')
  look.lookAhead()
  look.update(1 / 60, 'chase')
  // Partway there after one frame, not snapped
  expect(look.yaw).not.toBe(0)
  expect(look.focus).toBe('ahead')
  swing(look, 'chase', 3)
  expect(look.moved).toBe(false)
  expect(look.focus).toBe('free')
})

test('watching the runway turns the head toward it, and pressing again looks ahead', () => {
  const look = new Look()
  look.toggleRunway()
  expect(look.focus).toBe('runway')
  swing(look, 'cockpit', 3, { yaw: 1.2, pitch: -0.3 })
  expect(look.yaw).toBeCloseTo(1.2, 2)
  expect(look.pitch).toBeCloseTo(-0.3, 2)
  look.toggleRunway()
  swing(look, 'cockpit', 3)
  expect(look.moved).toBe(false)
})

test('dragging takes the view off the runway', () => {
  const look = new Look()
  look.toggleRunway()
  look.drag(10, 0, 'cockpit')
  expect(look.focus).toBe('free')
})

test('a runway behind the pilot turns the head only as far as it goes', () => {
  const look = new Look()
  look.toggleRunway()
  swing(look, 'cockpit', 5, { yaw: Math.PI, pitch: 0 })
  expect(look.yaw).toBeLessThan(Math.PI)
  expect(look.yaw).toBeGreaterThan(2.5)
})

test('a new flight or view starts looking straight ahead', () => {
  const look = new Look()
  look.drag(200, 200, 'cockpit')
  look.zoom(-300, 'cockpit')
  look.toggleRunway()
  look.reset()
  expect(look.moved).toBe(false)
  expect(look.focus).toBe('free')
})

test("the runway view aims past the threshold of the picked approach's runway", () => {
  const approach = APPROACHES[0]
  const out = new Vector3()
  // Far from that airport, the picked approach still wins over a nearer runway
  const end = runwayFocus(approach.end.x + 30_000, approach.end.z, approach, out)
  expect(end).toBe(approach.end)
  const past = onCentreline(approach.end, -300)
  expect(out.x).toBeCloseTo(past.x)
  expect(out.z).toBeCloseTo(past.z)
  expect(out.y).toBe(approach.end.elevation)
})

test('with no approach picked, the runway view watches the nearest runway end', () => {
  const near = RUNWAY_ENDS[3]
  const out = new Vector3()
  const end = runwayFocus(near.x + 10, near.z - 10, null, out)
  expect(end).toBe(near)
})

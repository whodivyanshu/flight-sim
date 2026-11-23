import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Quaternion, Vector3 } from 'three'
import { game, useGame } from '../game/game'
import { WARNINGS } from '../game/gpws'
import { COCKPIT_FOV, horizonShift, onCameraMoved } from '../scene/CameraRig'
import type { AircraftSpec } from '../sim/aircraft'
import type { Controls, EngineState, FlightSim } from '../sim/flight-sim'
import { AIRPORTS } from '../world/island'
import { flightModes } from './modes'
import {
  DEGREES,
  FEET_PER_METRE,
  FPM_PER_MS,
  KNOTS_PER_MS,
  setText,
  useTelemetry
} from './telemetry'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const SCREEN = 'h-44 shrink-0 rounded-sm bg-[#06080a] ring-2 ring-bezel'
const WHITE = '#e8ecef'
const GREEN = '#4be36f'
const AMBER = '#f2a93b'
const MAGENTA = '#e06bf0'
const RED = '#e5503f'

/** Collects elements rendered in a loop so a frame callback can move them. */
function useElements<T extends Element>() {
  const elements = useRef<(T | null)[]>([])
  const keep = (index: number) => (element: T | null) => {
    elements.current[index] = element
  }
  return [elements, keep] as const
}

const five = [0, 1, 2, 3, 4]

/** Smallest signed difference from one heading to another, in degrees. */
const turnDegrees = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180

/** Highest safe indicated airspeed in knots: the red line or Mach limit, or the flap or gear limit. */
function maximumSpeed(sim: FlightSim) {
  const spec = sim.spec
  let limit = sim.speedLimit * KNOTS_PER_MS
  const notches = spec.flapLabels.length - 1
  const notch = Math.ceil(sim.flapPosition * notches - 0.02)
  if (notch > 0) limit = Math.min(limit, spec.flapSpeeds[notch - 1])
  if (sim.gearPosition > 0.02 && spec.gearSpeed) limit = Math.min(limit, spec.gearSpeed)
  return limit
}
const nine = [0, 1, 2, 3, 4, 5, 6, 7, 8]

/**
 * Primary flight display: attitude in the middle, a speed tape on the left, an altitude
 * tape on the right, climb rate at the edge, and heading along the bottom.
 */
export function PrimaryFlightDisplay({ spec }: { spec: AircraftSpec }) {
  const horizon = useRef<SVGGElement>(null)
  const speedBox = useRef<SVGTextElement>(null)
  const altitudeBox = useRef<SVGTextElement>(null)
  const climb = useRef<SVGLineElement>(null)
  const climbText = useRef<SVGTextElement>(null)
  const stallBand = useRef<SVGRectElement>(null)
  const modes = useRef<SVGTextElement>(null)
  const headingBox = useRef<SVGTextElement>(null)
  const deviation = useRef<SVGGElement>(null)
  const localizer = useRef<SVGPathElement>(null)
  const glideslope = useRef<SVGPathElement>(null)
  const approachName = useRef<SVGTextElement>(null)
  const speedBug = useRef<SVGPathElement>(null)
  const gpwsText = useRef<SVGTextElement>(null)
  const maxBand = useRef<SVGRectElement>(null)
  const altitudeBug = useRef<SVGPathElement>(null)
  const selectedAltitude = useRef<SVGTextElement>(null)
  const headingBug = useRef<SVGPathElement>(null)
  const [speedTicks, speedTick] = useElements<SVGLineElement>()
  const [speedLabels, speedLabel] = useElements<SVGTextElement>()
  const [altitudeTicks, altitudeTick] = useElements<SVGLineElement>()
  const [altitudeLabels, altitudeLabel] = useElements<SVGTextElement>()
  const [headingTicks, headingTick] = useElements<SVGLineElement>()
  const [headingLabels, headingLabel] = useElements<SVGTextElement>()

  useTelemetry(
    useCallback(
      (sim: FlightSim) => {
        const knots = sim.indicatedAirspeed * KNOTS_PER_MS
        const feet = sim.position.y * FEET_PER_METRE
        const heading = sim.heading * DEGREES
        horizon.current?.setAttribute(
          'transform',
          `rotate(${(-sim.bank * DEGREES).toFixed(2)} 139 83) translate(0 ${(sim.pitch * DEGREES * 2.2).toFixed(2)})`
        )
        setText(speedBox.current, String(Math.round(knots)))
        setText(altitudeBox.current, String(Math.round(feet / 10) * 10))
        setText(headingBox.current, String(Math.round(heading) % 360 || 360).padStart(3, '0'))

        // Tapes: only the marks near the current value exist, and they slide past it
        const speedAt = (value: number) => 83 - (value - knots) * 1.6
        const nearestTen = Math.round(knots / 10) * 10
        speedTicks.current.forEach((tick, i) => {
          const value = nearestTen + (i - 4) * 10
          tick?.setAttribute('y1', speedAt(value).toFixed(1))
          tick?.setAttribute('y2', speedAt(value).toFixed(1))
          tick?.setAttribute('visibility', value < 0 ? 'hidden' : 'visible')
        })
        const nearestTwenty = Math.round(knots / 20) * 20
        speedLabels.current.forEach((label, i) => {
          const value = nearestTwenty + (i - 2) * 20
          label?.setAttribute('y', speedAt(value).toFixed(1))
          setText(label, value < 0 ? '' : String(value))
        })
        // Red band from the stall speed down
        const stallTop = clamp(speedAt(spec.stats.stallSpeed), 16, 150)
        stallBand.current?.setAttribute('y', stallTop.toFixed(1))
        stallBand.current?.setAttribute('height', (150 - stallTop).toFixed(1))
        // Striped band from the highest safe speed up: the red line, or the flap or gear limit
        const maxBottom = clamp(speedAt(maximumSpeed(sim)), 16, 150)
        maxBand.current?.setAttribute('height', (maxBottom - 16).toFixed(1))
        // Magenta bugs mark the autopilot knobs on each tape
        const { autopilot: knobs, autothrottle: speedKnob } = game.pilot
        const bugSpeed = clamp(speedAt(speedKnob.speed * KNOTS_PER_MS), 16, 150)
        speedBug.current?.setAttribute('transform', `translate(0 ${bugSpeed.toFixed(1)})`)

        const altitudeAt = (value: number) => 83 - (value - feet) * 0.14
        const knobFeet = Math.round((knobs.altitude * FEET_PER_METRE) / 100) * 100
        const bugAltitude = clamp(altitudeAt(knobFeet), 16, 150)
        altitudeBug.current?.setAttribute('transform', `translate(0 ${bugAltitude.toFixed(1)})`)
        setText(selectedAltitude.current, String(knobFeet))
        const nearestHundred = Math.round(feet / 100) * 100
        altitudeTicks.current.forEach((tick, i) => {
          const y = altitudeAt(nearestHundred + (i - 4) * 100).toFixed(1)
          tick?.setAttribute('y1', y)
          tick?.setAttribute('y2', y)
        })
        const nearestTwoHundred = Math.round(feet / 200) * 200
        altitudeLabels.current.forEach((label, i) => {
          const value = nearestTwoHundred + (i - 2) * 200
          label?.setAttribute('y', altitudeAt(value).toFixed(1))
          setText(label, String(value))
        })

        const rate = sim.verticalSpeed * FPM_PER_MS
        climb.current?.setAttribute('y2', (83 - (clamp(rate, -3000, 3000) / 3000) * 58).toFixed(1))
        setText(climbText.current, Math.abs(rate) > 150 ? String(Math.round(rate / 100)) : '')

        const headingAt = (value: number) => 139 + (value - heading) * 2
        const knobHeading = heading + turnDegrees(heading, knobs.heading * DEGREES)
        headingBug.current?.setAttribute(
          'transform',
          `translate(${clamp(headingAt(knobHeading), 64, 214).toFixed(1)} 0)`
        )
        const nearestTenDegrees = Math.round(heading / 10) * 10
        headingTicks.current.forEach((tick, i) => {
          const x = headingAt(nearestTenDegrees + (i - 4) * 10).toFixed(1)
          tick?.setAttribute('x1', x)
          tick?.setAttribute('x2', x)
        })
        const nearestThirty = Math.round(heading / 30) * 30
        headingLabels.current.forEach((label, i) => {
          const value = nearestThirty + (i - 2) * 30
          label?.setAttribute('x', headingAt(value).toFixed(1))
          setText(label, String((((value % 360) + 360) % 360) / 10))
        })

        const { approach, guidance } = game.nav
        const { thrust, lateral, vertical } = flightModes()
        const active = [thrust, lateral, vertical, game.pilot.autopilot.on && 'AP1']
        setText(modes.current, active.filter(Boolean).join('   ') || 'MANUAL')
        // Deviation diamonds: where the course and the glide path lie from the aircraft
        const showing = approach !== null && guidance.receiving
        deviation.current?.setAttribute('visibility', showing ? 'visible' : 'hidden')
        localizer.current?.setAttribute(
          'transform',
          `translate(${(guidance.lateral * 12).toFixed(1)} 0)`
        )
        glideslope.current?.setAttribute(
          'transform',
          `translate(0 ${(-guidance.vertical * 12).toFixed(1)})`
        )
        setText(approachName.current, approach ? `${approach.kind} ${approach.end.designator}` : '')
        // Ground proximity: PULL UP in red, other alerts in amber, in the attitude window
        const alert = game.gpws.alert
        setText(gpwsText.current, alert ?? '')
        gpwsText.current?.setAttribute('fill', alert && WARNINGS.has(alert) ? '#ff4a3a' : AMBER)
      },
      [spec, speedTicks, speedLabels, altitudeTicks, altitudeLabels, headingTicks, headingLabels]
    )
  )

  return (
    <svg viewBox="0 0 300 180" className={SCREEN} role="img" fontSize="8" fill={WHITE}>
      <title>Primary flight display</title>
      <clipPath id="pfd-attitude">
        <rect x="62" y="16" width="154" height="134" rx="14" />
      </clipPath>
      <clipPath id="pfd-speed">
        <rect x="6" y="16" width="46" height="134" />
      </clipPath>
      <clipPath id="pfd-altitude">
        <rect x="226" y="16" width="50" height="134" />
      </clipPath>
      <clipPath id="pfd-heading">
        <rect x="62" y="156" width="154" height="20" />
      </clipPath>

      <g clipPath="url(#pfd-attitude)">
        <g ref={horizon}>
          <rect x="-200" y="-317" width="680" height="400" fill="#2f7fc4" />
          <rect x="-200" y="83" width="680" height="400" fill="#7a4a24" />
          <line x1="-200" x2="480" y1="83" y2="83" stroke={WHITE} strokeWidth="1" />
          {[-30, -20, -10, 10, 20, 30].map(pitch => (
            <g key={pitch}>
              <line x1="119" x2="159" y1={83 - pitch * 2.2} y2={83 - pitch * 2.2} stroke={WHITE} />
              <text x="163" y={83 - pitch * 2.2} dominantBaseline="central" fontSize="7">
                {Math.abs(pitch)}
              </text>
            </g>
          ))}
          {[-25, -15, -5, 5, 15, 25].map(pitch => (
            <line
              key={pitch}
              x1="129"
              x2="149"
              y1={83 - pitch * 2.2}
              y2={83 - pitch * 2.2}
              stroke={WHITE}
              strokeWidth="0.7"
            />
          ))}
        </g>
      </g>
      {/* Fixed aircraft symbol */}
      <path
        d="M 104 83 H 126 V 88 M 174 83 H 152 V 88"
        fill="none"
        stroke={AMBER}
        strokeWidth="2.4"
      />
      <rect x="137" y="81" width="4" height="4" fill={AMBER} />

      <rect x="6" y="16" width="46" height="134" fill="#3a4046" />
      <g clipPath="url(#pfd-speed)">
        {nine.map(i => (
          <line key={i} ref={speedTick(i)} x1="44" x2="52" stroke={WHITE} />
        ))}
        {five.map(i => (
          <text key={i} ref={speedLabel(i)} x="40" textAnchor="end" dominantBaseline="central" />
        ))}
        <rect ref={stallBand} x="49" width="3" fill="#e5503f" />
        <pattern id="pfd-barber" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="4" fill="#e5503f" />
          <rect width="4" height="2" fill="#000" />
        </pattern>
        <rect ref={maxBand} x="49" y="16" width="3" fill="url(#pfd-barber)" />
        <path ref={speedBug} d="M 52 0 l -5 -3.5 v 7 z" fill={MAGENTA} />
      </g>
      <rect x="6" y="74" width="40" height="18" fill="#06080a" stroke={WHITE} strokeWidth="0.8" />
      <text
        ref={speedBox}
        x="42"
        y="83"
        textAnchor="end"
        dominantBaseline="central"
        fontSize="12"
        fill={GREEN}
      />

      <rect x="226" y="16" width="50" height="134" fill="#3a4046" />
      <text
        ref={selectedAltitude}
        x="251"
        y="12"
        textAnchor="middle"
        fontSize="7.5"
        fill={MAGENTA}
      />
      <g clipPath="url(#pfd-altitude)">
        <path ref={altitudeBug} d="M 226 0 l 5 -3.5 v 7 z" fill={MAGENTA} />
        {nine.map(i => (
          <line key={i} ref={altitudeTick(i)} x1="226" x2="233" stroke={WHITE} />
        ))}
        {five.map(i => (
          <text
            key={i}
            ref={altitudeLabel(i)}
            x="274"
            textAnchor="end"
            dominantBaseline="central"
            fontSize="7"
          />
        ))}
      </g>
      <rect x="232" y="74" width="46" height="18" fill="#06080a" stroke={WHITE} strokeWidth="0.8" />
      <text
        ref={altitudeBox}
        x="275"
        y="83"
        textAnchor="end"
        dominantBaseline="central"
        fontSize="11"
        fill={GREEN}
      />

      {/* Climb rate: the needle tilts up or down from the right edge */}
      <path d="M 282 25 L 296 40 V 126 L 282 141 Z" fill="#3a4046" />
      <line ref={climb} x1="298" y1="83" x2="284" stroke={GREEN} strokeWidth="1.6" />
      <text ref={climbText} x="290" y="20" textAnchor="middle" fontSize="7" fill={GREEN} />

      <rect x="62" y="156" width="154" height="20" fill="#3a4046" />
      <g clipPath="url(#pfd-heading)">
        <path ref={headingBug} d="M 0 156 l -3.5 4 h 7 z" fill={MAGENTA} />
        {nine.map(i => (
          <line key={i} ref={headingTick(i)} y1="156" y2="162" stroke={WHITE} />
        ))}
        {five.map(i => (
          <text key={i} ref={headingLabel(i)} y="170" textAnchor="middle" fontSize="7" />
        ))}
      </g>
      <path d="M 139 156 l -4 -5 h 8 z" fill={AMBER} />
      <text ref={headingBox} x="224" y="169" fontSize="8" fill={GREEN} />
      <text ref={modes} x="139" y="10" textAnchor="middle" fontSize="7.5" fill={GREEN} />
      <text ref={approachName} x="66" y="24" fontSize="7" fill={MAGENTA} />
      <text
        ref={gpwsText}
        x="139"
        y="122"
        textAnchor="middle"
        fontSize="12"
        fontWeight="bold"
        stroke="#000"
        strokeWidth="0.6"
      />
      <g ref={deviation} visibility="hidden">
        {[-2, -1, 1, 2].map(dot => (
          <g key={dot} fill="none" stroke={WHITE} strokeWidth="0.8">
            <circle cx={139 + dot * 12} cy="143" r="1.6" />
            <circle cx="208" cy={83 + dot * 12} r="1.6" />
          </g>
        ))}
        <path ref={localizer} d="M 139 139 l -4 4 l 4 4 l 4 -4 z" fill={MAGENTA} />
        <path ref={glideslope} d="M 208 79 l -4 4 l 4 4 l 4 -4 z" fill={MAGENTA} />
      </g>
    </svg>
  )
}

// Distance in metres from the aircraft to the edge of the navigation display
const MAP_RANGE = 40_000
const MAP_RADIUS = 76
// Most waypoints a route and its approach can show
const ROUTE_SLOTS = Array.from({ length: 16 }, (_, i) => i)

/** Navigation display: a compass rose that turns with the aircraft, with the airports around it. */
export function NavigationDisplay() {
  const rose = useRef<SVGGElement>(null)
  const speed = useRef<SVGTextElement>(null)
  const [marks, mark] = useElements<SVGGElement>()
  const [labels, label] = useElements<SVGTextElement>()
  const route = useRef<SVGPolylineElement>(null)
  const [fixes, fixMark] = useElements<SVGGElement>()
  const [fixNames, fixName] = useElements<SVGTextElement>()
  useTelemetry(
    useCallback(
      (sim: FlightSim) => {
        const heading = sim.heading * DEGREES
        const toMap = (x: number, z: number) =>
          [
            ((x - sim.position.x) / MAP_RANGE) * MAP_RADIUS,
            ((z - sim.position.z) / MAP_RANGE) * MAP_RADIUS
          ] as const
        // The selected approach as a magenta line through its waypoints
        const { waypoints, waypointAhead } = game.nav
        const points = waypoints.map(fix =>
          toMap(fix.x, fix.z)
            .map(n => n.toFixed(1))
            .join(',')
        )
        route.current?.setAttribute('points', points.join(' '))
        fixes.current.forEach((group, i) => {
          const fix = waypoints[i]
          group?.setAttribute('visibility', fix ? 'visible' : 'hidden')
          if (!fix || !group) return
          const [x, y] = toMap(fix.x, fix.z)
          group.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`)
          group.setAttribute('color', i === waypointAhead ? MAGENTA : WHITE)
          fixNames.current[i]?.setAttribute('transform', `rotate(${heading.toFixed(2)})`)
          setText(fixNames.current[i], fix.name)
        })
        rose.current?.setAttribute('transform', `rotate(${(-heading).toFixed(2)})`)
        setText(speed.current, `GS ${Math.round(sim.groundSpeed * KNOTS_PER_MS)}`)
        AIRPORTS.forEach((airport, i) => {
          const x = ((airport.x - sim.position.x) / MAP_RANGE) * MAP_RADIUS
          const y = ((airport.z - sim.position.z) / MAP_RANGE) * MAP_RADIUS
          const inRange = Math.hypot(x, y) < MAP_RADIUS - 4
          marks.current[i]?.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`)
          marks.current[i]?.setAttribute('visibility', inRange ? 'visible' : 'hidden')
          // Names stay upright while the rose turns under them
          labels.current[i]?.setAttribute('transform', `rotate(${heading.toFixed(2)})`)
        })
      },
      [marks, labels, fixes, fixNames]
    )
  )
  return (
    <svg viewBox="-90 -90 180 180" className={SCREEN} role="img" fontSize="7" fill={WHITE}>
      <title>Navigation display</title>
      <clipPath id="nd-range">
        <circle r={MAP_RADIUS - 2} />
      </clipPath>
      <circle r={MAP_RADIUS} fill="none" stroke={WHITE} strokeWidth="0.8" />
      <circle
        r={MAP_RADIUS / 2}
        fill="none"
        stroke={WHITE}
        strokeWidth="0.4"
        strokeDasharray="2 3"
      />
      <g ref={rose}>
        {Array.from({ length: 36 }, (_, i) => i * 10).map(angle => (
          <g key={angle} transform={`rotate(${angle})`}>
            <line
              y1={-MAP_RADIUS}
              y2={-MAP_RADIUS + (angle % 30 ? 4 : 7)}
              stroke={WHITE}
              strokeWidth="0.7"
            />
            {angle % 30 === 0 && (
              <text y={-MAP_RADIUS + 15} textAnchor="middle">
                {angle / 10}
              </text>
            )}
          </g>
        ))}
        <g clipPath="url(#nd-range)">
          <polyline ref={route} fill="none" stroke={MAGENTA} strokeWidth="1.4" />
          {ROUTE_SLOTS.map(i => (
            <g key={i} ref={fixMark(i)} visibility="hidden" color={WHITE}>
              <path
                d="M 0 -3.5 L 1 -1 L 3.5 0 L 1 1 L 0 3.5 L -1 1 L -3.5 0 L -1 -1 Z"
                fill="currentColor"
              />
              <text ref={fixName(i)} x="5" y="-3" fill="currentColor" fontSize="6" />
            </g>
          ))}
        </g>
        {AIRPORTS.map((airport, i) => (
          <g key={airport.code} ref={mark(i)}>
            <circle r="3" fill="none" stroke={MAGENTA} strokeWidth="1" />
            <line
              y1="-5"
              y2="5"
              stroke={MAGENTA}
              strokeWidth="1.4"
              transform={`rotate(${airport.runways[0].heading})`}
            />
            <text ref={label(i)} x="6" y="2.5" fill={MAGENTA} fontSize="6.5">
              {airport.code}
            </text>
          </g>
        ))}
      </g>
      {/* Own aircraft, always pointing up */}
      <path d="M 0 -7 V 7 M -6 0 H 6 M -3 6 H 3" fill="none" stroke={AMBER} strokeWidth="1.5" />
      <path d="M 0 -82 l -3.5 -6 h 7 z" fill={AMBER} />
      <text ref={speed} x="-86" y="-80" fill={GREEN} />
      <text x="86" y="-80" textAnchor="end" fill={WHITE} opacity="0.7">
        22 NM
      </text>
    </svg>
  )
}

/** Label and colour for one engine on the engine display. */
function engineStatus(
  engine: EngineState,
  switchedOn: boolean,
  sim: FlightSim,
  controls: Controls
) {
  if (engine.failed) return ['FAIL', RED] as const
  if (engine.running) return ['RUN', GREEN] as const
  if (engine.starting > 0) return ['START', AMBER] as const
  if (!switchedOn) return ['OFF', '#8b949b'] as const
  // Switched on but not turning: say what is missing, or that it waits for the starter
  if (sim.fuel <= 0 || !controls.fuelPumps) return ['NO FUEL', RED] as const
  if (!sim.powered) return ['NO PWR', AMBER] as const
  return ['WAIT', AMBER] as const
}

/** Engine display: one thrust dial per engine, then fuel, flaps, gear, and reverser status. */
export function EngineDisplay({ spec }: { spec: AircraftSpec }) {
  const [needles, needle] = useElements<SVGLineElement>()
  const [values, value] = useElements<SVGTextElement>()
  const [states, state] = useElements<SVGTextElement>()
  const fuel = useRef<SVGTextElement>(null)
  const flaps = useRef<SVGTextElement>(null)
  const gear = useRef<SVGTextElement>(null)
  const notes = useRef<SVGTextElement>(null)
  const engines = useMemo(() => Array.from({ length: spec.engineCount }, (_, i) => i), [spec])
  const spacing = 196 / spec.engineCount
  useTelemetry(
    useCallback(
      (sim: FlightSim, controls: Controls) => {
        engines.forEach(i => {
          const engine = sim.engines[i]
          if (!engine) return
          needles.current[i]?.setAttribute('transform', `rotate(${-120 + engine.rpm * 2.2})`)
          setText(values.current[i], engine.rpm.toFixed(0))
          // Switched on but not turning: waiting for the starter, or out of fuel
          const [label, color] = engineStatus(engine, controls.engineSwitches[i], sim, controls)
          const text = states.current[i]
          setText(text, `${i + 1} ${label}`)
          text?.setAttribute('fill', color)
        })
        const unit = spec.fuelUnit
        setText(
          fuel.current,
          `FUEL  ${Math.round(sim.fuel * unit.perKg)} ${unit.label.toUpperCase()}`
        )
        const notch = Math.round(sim.flapPosition * (spec.flapLabels.length - 1))
        // An aircraft without flaps has nothing to show
        setText(
          flaps.current,
          spec.flapLabels.length > 1
            ? `${spec.flapName.toUpperCase()}  ${spec.flapLabels[notch].toUpperCase()}`
            : ''
        )
        const down = sim.gearPosition >= 0.99
        setText(
          gear.current,
          down ? 'GEAR  DOWN' : sim.gearPosition <= 0.01 ? 'GEAR  UP' : 'GEAR  MOVING'
        )
        gear.current?.setAttribute('fill', down ? GREEN : sim.gearPosition <= 0.01 ? WHITE : AMBER)
        const status = [
          sim.reversePosition > 0.05 && 'REV',
          sim.speedBrakePosition > 0.05 && 'SPEED BRK',
          sim.afterburner && 'AFTERBURNER',
          controls.parkingBrake && 'PARK BRK'
        ]
        setText(notes.current, status.filter(Boolean).join('   '))
      },
      [spec, engines, needles, values, states]
    )
  )
  return (
    <svg viewBox="0 0 200 180" className={SCREEN} role="img" fontSize="8" fill={WHITE}>
      <title>Engine display</title>
      <text x="100" y="13" textAnchor="middle" opacity="0.7">
        {spec.gauges.power.caption}
      </text>
      {engines.map(i => (
        <g key={i} transform={`translate(${2 + spacing * (i + 0.5)} 52)`}>
          <path d="M -15.6 9 A 18 18 0 1 1 15.6 9" fill="none" stroke={WHITE} strokeWidth="1.4" />
          <path
            d="M 13.8 -11.6 A 18 18 0 0 1 15.6 9"
            fill="none"
            stroke="#e5503f"
            strokeWidth="2"
          />
          <line ref={needle(i)} y2="-17" stroke={GREEN} strokeWidth="1.6" />
          <text ref={value(i)} y="18" textAnchor="middle" fontSize="10" fill={GREEN} />
          <text ref={state(i)} y="30" textAnchor="middle" fontSize="7" />
        </g>
      ))}
      <line x1="10" x2="190" y1="88" y2="88" stroke={WHITE} strokeWidth="0.4" />
      <text ref={fuel} x="14" y="106" />
      <text ref={flaps} x="14" y="124" />
      <text ref={gear} x="14" y="142" />
      <text ref={notes} x="14" y="164" fill={AMBER} />
    </svg>
  )
}

const bodyVelocity = new Vector3()
const inverse = new Quaternion()
const nose = new Vector3()
const viewDirection = new Vector3()
const onScreen = new Vector3()
// The display hides once the nose is this far off to the side of the view, as a cosine
const HUD_HIDES = 0.3
const LADDER = Array.from({ length: 35 }, (_, i) => (i - 17) * 5).filter(pitch => pitch !== 0)

/**
 * Fighter head-up display, drawn over the cockpit view. The pitch ladder lines up with
 * the real horizon, and the circle marks where the aircraft is actually going. The glass
 * stays fixed to the aircraft, so it slides away as the pilot looks around and grows as
 * the view zooms in.
 */
export function HeadUpDisplay({ spec }: { spec: AircraftSpec }) {
  const camera = useGame(state => state.camera)
  const status = useGame(state => state.status)
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const glass = useRef<SVGGElement>(null)
  const ladder = useRef<SVGGElement>(null)
  const path = useRef<SVGGElement>(null)
  const speed = useRef<SVGTextElement>(null)
  const altitude = useRef<SVGTextElement>(null)
  const heading = useRef<SVGTextElement>(null)
  const data = useRef<SVGTextElement>(null)

  // Where the aircraft's nose points on screen, and how many pixels one degree covers there
  const centerX = size.width / 2
  const centerY = size.height / 2 - horizonShift(size.height)
  const perDegree = (size.height / 2 / Math.tan((COCKPIT_FOV * Math.PI) / 360)) * (Math.PI / 180)

  // Moves the whole display to wherever the nose is on screen, scaled with the zoom
  useEffect(
    () =>
      onCameraMoved(view => {
        const element = glass.current
        if (!element) return
        nose.set(0, 0, -1).applyQuaternion(game.sim.orientation)
        if (nose.dot(view.getWorldDirection(viewDirection)) < HUD_HIDES) {
          element.setAttribute('visibility', 'hidden')
          return
        }
        onScreen.copy(view.position).addScaledVector(nose, 1000).project(view)
        const x = ((onScreen.x + 1) / 2) * size.width
        const y = ((1 - onScreen.y) / 2) * size.height
        const scale = Math.tan((COCKPIT_FOV * Math.PI) / 360) / Math.tan((view.fov * Math.PI) / 360)
        element.setAttribute('visibility', 'visible')
        element.setAttribute(
          'transform',
          `translate(${(x - centerX * scale).toFixed(1)} ${(y - centerY * scale).toFixed(1)}) scale(${scale.toFixed(4)})`
        )
      }),
    [size, centerX, centerY]
  )

  useTelemetry(
    useCallback(
      (sim: FlightSim) => {
        ladder.current?.setAttribute(
          'transform',
          `translate(${centerX} ${centerY}) rotate(${(-sim.bank * DEGREES).toFixed(2)}) translate(0 ${(sim.pitch * DEGREES * perDegree).toFixed(1)})`
        )
        // Flight path marker: offset from the nose by the angle of attack and the sideslip
        bodyVelocity.copy(sim.velocity).applyQuaternion(inverse.copy(sim.orientation).invert())
        const forward = Math.max(-bodyVelocity.z, 1)
        const alpha = Math.atan2(-bodyVelocity.y, forward) * DEGREES
        const slip = Math.atan2(bodyVelocity.x, forward) * DEGREES
        path.current?.setAttribute(
          'transform',
          `translate(${(centerX + clamp(slip, -12, 12) * perDegree).toFixed(1)} ${(centerY + clamp(alpha, -15, 15) * perDegree).toFixed(1)})`
        )
        setText(speed.current, String(Math.round(sim.indicatedAirspeed * KNOTS_PER_MS)))
        setText(altitude.current, String(Math.round((sim.position.y * FEET_PER_METRE) / 10) * 10))
        setText(
          heading.current,
          String(Math.round(sim.heading * DEGREES) % 360 || 360).padStart(3, '0')
        )
        setText(
          data.current,
          `G ${sim.gLoad.toFixed(1)}    M ${sim.mach.toFixed(2)}    AOA ${alpha.toFixed(0)}°`
        )
      },
      [centerX, centerY, perDegree]
    )
  )

  if (spec.panel !== 'hud' || camera !== 'cockpit' || status !== 'flying') return null
  const reach = Math.min(230, size.height * 0.28)
  return (
    <svg
      width={size.width}
      height={size.height}
      className="absolute inset-0"
      fill={GREEN}
      stroke={GREEN}
      fontSize="17"
      style={{ filter: 'drop-shadow(0 0 2px rgb(75 227 111 / 0.8))' }}
      role="img"
    >
      <title>Head-up display</title>
      <g ref={glass}>
        <clipPath id="hud-glass">
          <circle cx={centerX} cy={centerY} r={reach} />
        </clipPath>
        <g clipPath="url(#hud-glass)">
          <g ref={ladder} strokeWidth="1.6">
            <line x1={-size.width} x2={size.width} />
            {LADDER.map(pitch => (
              <g key={pitch} transform={`translate(0 ${-pitch * perDegree})`}>
                {/* Solid bars above the horizon, dashed below it */}
                <path
                  d={`M -90 ${pitch > 0 ? 8 : -8} V 0 H -34 M 90 ${pitch > 0 ? 8 : -8} V 0 H 34`}
                  fill="none"
                  strokeDasharray={pitch < 0 ? '9 6' : undefined}
                />
                <text x="98" y="6" stroke="none">
                  {Math.abs(pitch)}
                </text>
              </g>
            ))}
          </g>
          <g ref={path} fill="none" strokeWidth="2">
            <circle r="9" />
            <path d="M -9 0 H -26 M 9 0 H 26 M 0 -9 V -18" />
          </g>
        </g>
        {/* The cross marks the aircraft's nose */}
        <path
          d={`M ${centerX - 10} ${centerY} H ${centerX + 10} M ${centerX} ${centerY - 10} V ${centerY + 10}`}
          strokeWidth="1.6"
        />
        <g stroke="none" fontSize="22">
          <rect
            x={centerX - reach - 78}
            y={centerY - 16}
            width="74"
            height="32"
            fill="none"
            stroke={GREEN}
            strokeWidth="1.6"
          />
          <text ref={speed} x={centerX - reach - 12} y={centerY + 8} textAnchor="end" />
          <rect
            x={centerX + reach + 4}
            y={centerY - 16}
            width="92"
            height="32"
            fill="none"
            stroke={GREEN}
            strokeWidth="1.6"
          />
          <text ref={altitude} x={centerX + reach + 88} y={centerY + 8} textAnchor="end" />
          <text ref={heading} x={centerX} y={centerY - reach - 10} textAnchor="middle" />
        </g>
        <text ref={data} x={centerX - reach - 78} y={centerY + reach * 0.75} stroke="none" />
      </g>
    </svg>
  )
}

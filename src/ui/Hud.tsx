import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Vector3 } from 'three'
import { game, useGame, WIND_FROM, WIND_SPEEDS } from '../game/game'
import { runwayFocus } from '../game/look'
import type { AircraftSpec } from '../sim/aircraft'
import { type Controls, DUMP_FLOOR, type FlightSim } from '../sim/flight-sim'
import { AIRPORTS, outside } from '../world/island'
import { AutopilotPanel } from './AutopilotPanel'
import {
  AirspeedIndicator,
  Altimeter,
  AttitudeIndicator,
  HeadingIndicator,
  Tachometer,
  TurnCoordinator,
  VerticalSpeedIndicator
} from './Gauges'
import { EngineDisplay, HeadUpDisplay, NavigationDisplay, PrimaryFlightDisplay } from './Glass'
import { GoalMarker, HoverDisplay } from './Goal'
import { ApproachCard, BankIndicator, GpwsAlert } from './Guidance'
import { MiniMap } from './MiniMap'
import { BombPanel, CoachCard, MissionCard } from './Missions'
import { flightModes } from './modes'
import { FEET_PER_METRE, FPM_PER_MS, KNOTS_PER_MS, setText, useTelemetry } from './telemetry'

// The instrument panel is laid out for this width and shrinks on narrower windows
const PANEL_WIDTH = 1300

function usePanelScale() {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const update = () => setScale(Math.min(1, window.innerWidth / PANEL_WIDTH))
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return scale
}

function light(element: HTMLElement | null, on: boolean) {
  if (element) element.dataset.on = String(on)
}

const LAMP =
  'whitespace-nowrap rounded-sm border border-panel-edge/60 bg-bezel/80 px-2 py-0.5 text-center text-marking/25 text-xs tracking-wider'
const WARNING = `${LAMP} data-[on=true]:bg-warn data-[on=true]:text-white`
const NOTICE = `${LAMP} data-[on=true]:bg-amber data-[on=true]:text-ink`

/**
 * Warning lamps. Each lights only while its condition holds, and only with power on. Lamps
 * for a mission's failures and for air combat stay out of the row until they apply, so it
 * fits the screen.
 */
function Annunciators({ spec }: { spec: AircraftSpec }) {
  const lamps = useRef<(HTMLSpanElement | null)[]>([])
  const shown = useMemo(
    () =>
      LAMPS.filter(
        lamp =>
          (lamp.label !== 'AFTERBURNER' ||
            (spec.engine.type === 'jet' && spec.engine.afterburnerFrom < 1)) &&
          (lamp.label !== 'GEAR SPEED' || spec.retractableGear) &&
          !(spec.rotor && ROTORLESS_LAMPS.has(lamp.label))
      ),
    [spec]
  )
  useTelemetry(
    useCallback(
      (sim: FlightSim, controls: Controls) => {
        shown.forEach((lamp, i) => {
          const element = lamps.current[i]
          if (element && lamp.present) element.hidden = !lamp.present(sim)
          const on =
            lamp.label === 'NO POWER' ? !sim.powered : sim.powered && lamp.on(sim, controls)
          light(lamps.current[i], on)
        })
      },
      [shown]
    )
  )
  return (
    <div className="flex justify-center gap-1">
      {shown.map((lamp, i) => (
        <span
          key={lamp.label}
          ref={element => {
            lamps.current[i] = element
          }}
          className={lamp.kind === 'warning' ? WARNING : NOTICE}
        >
          {lamp.label === 'STALL' && spec.rotor ? 'LOW ROTOR' : lamp.label}
        </span>
      ))}
    </div>
  )
}

type Lamp = {
  label: string
  kind: 'warning' | 'notice'
  on: (sim: FlightSim, controls: Controls) => boolean
  /** Whether the lamp belongs in the row at all, for failures only a mission brings. */
  present?: (sim: FlightSim) => boolean
}

/** Lamps for parts a helicopter does not have. Its stall lamp reads LOW ROTOR instead. */
const ROTORLESS_LAMPS = new Set(['FLAP SPEED', 'GEAR SPEED', 'AIRBRAKE', 'REVERSE', 'GEAR UP'])

const LAMPS: Lamp[] = [
  { label: 'STALL', kind: 'warning', on: sim => sim.stallWarning },
  { label: 'FIRE', kind: 'warning', on: sim => sim.engines.some(engine => engine.fire) },
  {
    label: 'FUEL LEAK',
    kind: 'warning',
    on: sim => sim.fuelLeak > 0,
    present: sim => sim.fuelLeak > 0
  },
  {
    label: 'HYD FAIL',
    kind: 'warning',
    on: sim => sim.hydraulicsFailed,
    present: sim => sim.hydraulicsFailed
  },
  // The lever is down but the gear stays in its bay
  {
    label: 'GEAR UNSAFE',
    kind: 'warning',
    on: (sim, controls) => sim.gearStuck && controls.gearDown && !sim.onGround,
    present: sim => sim.gearStuck
  },
  // An enemy missile homes on the aircraft
  {
    label: 'MISSILE',
    kind: 'warning',
    on: () => game.combat.warning,
    present: () => game.combat.active
  },
  {
    // Low, slow, throttled back, and the wheels are still up
    label: 'GEAR UP',
    kind: 'warning',
    on: (sim, controls) =>
      sim.gearPosition < 1 &&
      !sim.onGround &&
      sim.altitudeAgl < 150 &&
      controls.throttle < 0.4 &&
      !(sim.gearStuck && controls.gearDown)
  },
  {
    label: 'OVERSPEED',
    kind: 'warning',
    on: sim => sim.indicatedAirspeed > sim.speedLimit
  },
  { label: 'FLAP SPEED', kind: 'warning', on: sim => sim.flapOverspeed },
  { label: 'GEAR SPEED', kind: 'warning', on: sim => sim.gearOverspeed },
  { label: 'DAMAGE', kind: 'warning', on: sim => sim.flapsJammed || sim.gearJammed },
  { label: 'NO POWER', kind: 'notice', on: () => false },
  { label: 'PUMPS OFF', kind: 'notice', on: (_, controls) => !controls.fuelPumps },
  { label: 'ENGINE OFF', kind: 'notice', on: sim => sim.enginesRunning < sim.spec.engineCount },
  { label: 'LOW FUEL', kind: 'notice', on: sim => sim.fuel < sim.spec.fuelCapacity * 0.15 },
  { label: 'FUEL DUMP', kind: 'notice', on: sim => sim.dumping },
  {
    label: 'BRAKE',
    kind: 'notice',
    on: (_, c) => c.parkingBrake || c.brake > 0 || c.brakeLeft > 0 || c.brakeRight > 0
  },
  { label: 'AIRBRAKE', kind: 'notice', on: sim => sim.speedBrakePosition > 0.05 },
  { label: 'REVERSE', kind: 'notice', on: sim => sim.reversePosition > 0.05 },
  { label: 'AFTERBURNER', kind: 'notice', on: sim => sim.afterburner }
]

const TRACK = 'relative h-24 w-2.5 rounded-full bg-bezel ring-1 ring-panel-edge/60'
const LEVER_LABEL = 'text-marking/70 text-xs'
const MARKER = 'absolute -left-1 h-1.5 w-4.5 -translate-y-1/2 rounded-sm bg-amber'

/** Throttle, flap, and trim positions. */
function Levers({ spec }: { spec: AircraftSpec }) {
  const throttle = useRef<HTMLDivElement>(null)
  const throttleText = useRef<HTMLSpanElement>(null)
  const flap = useRef<HTMLDivElement>(null)
  const flapLever = useRef<HTMLDivElement>(null)
  const trim = useRef<HTMLDivElement>(null)
  const trimText = useRef<HTMLSpanElement>(null)
  useTelemetry(
    useCallback(
      (sim: FlightSim, controls: Controls) => {
        if (throttle.current) throttle.current.style.height = `${controls.throttle * 100}%`
        setText(throttleText.current, `${Math.round(controls.throttle * 100)}%`)
        if (flap.current) flap.current.style.top = `${sim.flapPosition * 100}%`
        if (flapLever.current) {
          flapLever.current.style.top = `${(controls.flapNotch / Math.max(1, spec.flapLabels.length - 1)) * 100}%`
        }
        // A helicopter's trim runs from a hover at the top to its fastest held speed
        const trimmed = spec.rotor ? -controls.trim * 100 : 50 - controls.trim * 50
        if (trim.current) trim.current.style.top = `${trimmed}%`
        if (spec.rotor) {
          const knots = Math.round(Math.max(0, -controls.trim) * spec.rotor.trimSpeed)
          setText(trimText.current, knots < 1 ? 'Hover' : `${knots} kt`)
        }
      },
      [spec]
    )
  )
  return (
    <div className="bg-bezel/30 ring-panel-edge/40 flex items-end gap-4 self-stretch rounded-md px-3 pt-2 pb-1.5 ring-1">
      <div className="flex flex-col items-center gap-1">
        <span className={LEVER_LABEL}>{spec.rotor ? 'Collective' : 'Throttle'}</span>
        <div className={`${TRACK} overflow-hidden`}>
          <div ref={throttle} className="bg-marking absolute inset-x-0 bottom-0" />
        </div>
        <span ref={throttleText} className="text-marking text-xs tabular-nums">
          0%
        </span>
      </div>
      {spec.flapLabels.length > 1 && (
        <div className="flex flex-col items-center gap-1">
          <span className={LEVER_LABEL}>{spec.flapName}</span>
          <div className="flex gap-2">
            <div className={TRACK}>
              {/* Hollow marker: where the lever is set. Solid marker: where the flaps are now. */}
              <div
                ref={flapLever}
                className="ring-marking/70 absolute -left-1 h-1.5 w-4.5 -translate-y-1/2 rounded-sm ring-1"
              />
              <div ref={flap} className={MARKER} />
            </div>
            <div className="text-marking/70 flex h-24 flex-col justify-between text-xs leading-none">
              {spec.flapLabels.map(label => (
                <span key={label}>{label}</span>
              ))}
            </div>
          </div>
          <span className="text-xs">&nbsp;</span>
        </div>
      )}
      <div className="flex flex-col items-center gap-1">
        <span className={LEVER_LABEL}>{spec.rotor ? 'Speed Hold' : 'Trim'}</span>
        <div className="flex gap-2">
          <div className={TRACK}>
            {!spec.rotor && <div className="bg-marking/60 absolute inset-x-0 top-1/2 h-px" />}
            <div ref={trim} className={MARKER} />
          </div>
          <div className="text-marking/70 flex h-24 flex-col justify-between text-xs leading-none">
            <span>{spec.rotor ? 'Hover' : 'Nose up'}</span>
            <span>{spec.rotor ? `${spec.rotor.trimSpeed} kt` : 'Nose down'}</span>
          </div>
        </div>
        <span ref={trimText} className="text-marking text-xs tabular-nums">
          &nbsp;
        </span>
      </div>
    </div>
  )
}

const WHEEL =
  'size-3.5 rounded-full bg-bezel ring-1 ring-panel-edge/60 data-[state=down]:bg-go data-[state=moving]:bg-amber'

/** Landing gear lights and the fuel gauge. */
function GearAndFuel({ spec }: { spec: AircraftSpec }) {
  const wheels = useRef<HTMLDivElement>(null)
  const gearText = useRef<HTMLSpanElement>(null)
  const fuel = useRef<HTMLDivElement>(null)
  const fuelText = useRef<HTMLSpanElement>(null)
  const engineText = useRef<HTMLSpanElement>(null)
  const rotorText = useRef<HTMLSpanElement>(null)
  useTelemetry(
    useCallback(
      (sim: FlightSim) => {
        const state = sim.gearPosition >= 0.99 ? 'down' : sim.gearPosition <= 0.01 ? 'up' : 'moving'
        if (wheels.current && wheels.current.dataset.state !== state) {
          wheels.current.dataset.state = state
          for (const wheel of wheels.current.children) (wheel as HTMLElement).dataset.state = state
        }
        const label = !spec.retractableGear
          ? 'Fixed'
          : state === 'down'
            ? 'Down'
            : state === 'up'
              ? 'Up'
              : 'Moving'
        setText(gearText.current, label)
        setText(engineText.current, `${sim.enginesRunning} of ${spec.engineCount}`)
        setText(rotorText.current, `${Math.round(sim.rotorSpeed * 100)}%`)
        if (rotorText.current) rotorText.current.dataset.low = String(sim.stallWarning)
        if (fuel.current) fuel.current.style.width = `${(sim.fuel / spec.fuelCapacity) * 100}%`
        setText(
          fuelText.current,
          `${Math.round(sim.fuel * spec.fuelUnit.perKg)} ${spec.fuelUnit.label}`
        )
      },
      [spec]
    )
  )
  return (
    <div className="bg-bezel/30 ring-panel-edge/40 flex w-36 flex-col justify-end gap-2.5 self-stretch rounded-md px-3 pt-2 pb-1.5 ring-1">
      <div className="flex flex-col items-center gap-1.5">
        <span className={LEVER_LABEL}>Gear</span>
        <div ref={wheels} className="grid grid-cols-3 gap-x-1.5 gap-y-1">
          <span className={`${WHEEL} col-start-2`} />
          <span className={`${WHEEL} col-start-1 row-start-2`} />
          <span className={`${WHEEL} col-start-3 row-start-2`} />
        </div>
        <span ref={gearText} className="text-marking text-xs">
          Down
        </span>
      </div>
      <div className="flex justify-between text-xs">
        <span className={LEVER_LABEL}>Engines</span>
        <span ref={engineText} className="text-marking whitespace-nowrap tabular-nums" />
      </div>
      {spec.rotor && (
        <div className="flex justify-between text-xs">
          <span className={LEVER_LABEL}>Rotor</span>
          <span
            ref={rotorText}
            className="text-marking data-[low=true]:text-warn tabular-nums data-[low=true]:font-bold"
          />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs">
          <span className={LEVER_LABEL}>Fuel</span>
          <span ref={fuelText} className="text-marking tabular-nums">
            0
          </span>
        </div>
        <div className="bg-bezel ring-panel-edge/60 h-2 overflow-hidden rounded-full ring-1">
          <div ref={fuel} className="bg-marking h-full" />
        </div>
        {spec.fuelDump && <DumpButton />}
      </div>
    </div>
  )
}

/** Fuel dump switch beside the fuel gauge, lit while fuel streams overboard. Also the - key. */
function DumpButton() {
  const button = useRef<HTMLButtonElement>(null)
  useTelemetry(
    useCallback((sim: FlightSim, controls: Controls) => {
      if (!button.current) return
      button.current.dataset.on = String(controls.fuelDump)
      button.current.dataset.dumping = String(sim.dumping)
    }, [])
  )
  return (
    <button
      ref={button}
      type="button"
      title="Fuel dump (-)"
      // Keep keyboard focus on the game so Space still brakes
      onMouseDown={event => event.preventDefault()}
      onClick={() => {
        game.pilot.controls.fuelDump = !game.pilot.controls.fuelDump
      }}
      className="border-panel-edge bg-bezel text-marking/70 hover:bg-panel-edge data-[on=true]:border-amber data-[on=true]:text-amber pointer-events-auto rounded-sm border px-1.5 py-0.5 text-[10px] font-bold tracking-wide data-[dumping=true]:animate-pulse"
    >
      Dump Fuel <span className="font-normal opacity-60">-</span>
    </button>
  )
}

/** Big airspeed and altitude figures, with the numbers a pilot would read off a GPS beside them. */
function Readouts() {
  const airspeed = useRef<HTMLSpanElement>(null)
  const altitude = useRef<HTMLSpanElement>(null)
  const climb = useRef<HTMLSpanElement>(null)
  const targets = useRef<HTMLDivElement>(null)
  const groundSpeed = useRef<HTMLSpanElement>(null)
  const mach = useRef<HTMLSpanElement>(null)
  const height = useRef<HTMLSpanElement>(null)
  const load = useRef<HTMLSpanElement>(null)
  const wind = useRef<HTMLSpanElement>(null)
  const frames = useRef<HTMLSpanElement>(null)
  const windLevel = useGame(state => state.wind)
  useTelemetry(
    useCallback((sim: FlightSim) => {
      setText(airspeed.current, String(Math.round(sim.indicatedAirspeed * KNOTS_PER_MS)))
      // Red while the stall warning sounds
      if (airspeed.current) airspeed.current.dataset.on = String(sim.stallWarning)
      setText(altitude.current, String(Math.round((sim.position.y * FEET_PER_METRE) / 10) * 10))
      // Rounded to 50 ft/min so the figure stays readable
      const rate = Math.round((sim.verticalSpeed * FPM_PER_MS) / 50) * 50
      setText(climb.current, `${rate > 0 ? '+' : ''}${rate}`)
      // The modes the autopilot is flying, as on a real flight display
      const { thrust, lateral, vertical } = flightModes()
      const { autopilot, autothrottle } = game.pilot
      const knots = Math.round(autothrottle.speed * KNOTS_PER_MS)
      const modes = [
        autopilot.on && 'Autopilot',
        lateral,
        vertical,
        thrust && `${thrust}${thrust === 'SPEED' ? ` ${knots} kt` : ''}`
      ]
      setText(targets.current, modes.filter(Boolean).join('  ·  '))
      setText(groundSpeed.current, `${Math.round(sim.groundSpeed * KNOTS_PER_MS)} kt`)
      setText(mach.current, sim.mach.toFixed(2))
      const feet = Math.max(0, sim.altitudeAgl - sim.spec.restHeight) * FEET_PER_METRE
      setText(height.current, `${Math.round(feet / 10) * 10} ft`)
      setText(load.current, `${sim.gLoad.toFixed(1)} g`)
      // Rounded to 5 so the figure does not flicker
      setText(frames.current, `${Math.round(game.frameRate / 5) * 5} fps`)
    }, [])
  )
  useEffect(() => {
    const knots = Math.round(WIND_SPEEDS[windLevel] * KNOTS_PER_MS)
    setText(
      wind.current,
      knots === 0 ? 'Calm' : `${String(WIND_FROM).padStart(3, '0')}° at ${knots} kt`
    )
  }, [windLevel])
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="bg-ink/75 text-marking flex items-stretch gap-5 rounded-b-md px-5 py-1.5 backdrop-blur-sm">
        {(
          [
            ['Airspeed', 'kt', airspeed],
            ['Altitude', 'ft', altitude],
            ['Climb', 'ft/min', climb]
          ] as const
        ).map(([label, unit, ref]) => (
          <div key={label} className="flex flex-col leading-none">
            <span className="text-marking/60 text-xs">{label}</span>
            <span className="flex items-baseline gap-1">
              <span
                ref={ref}
                className="data-[on=true]:text-warn min-w-14 text-3xl font-bold tabular-nums"
              />
              <span className="text-marking/60 text-sm">{unit}</span>
            </span>
          </div>
        ))}
        <dl className="border-marking/20 grid grid-cols-[repeat(3,auto)] content-center gap-x-5 gap-y-0.5 border-l pl-5 text-sm">
          {(
            [
              ['Ground speed', groundSpeed],
              ['Above ground', height],
              ['Mach', mach],
              ['Load', load],
              ['Wind', wind],
              ['Frame rate', frames]
            ] as const
          ).map(([label, ref]) => (
            <div key={label} className="flex items-baseline gap-1.5">
              <dt className="text-marking/60 text-xs whitespace-nowrap">{label}</dt>
              <dd ref={ref} className="min-w-10 whitespace-nowrap tabular-nums" />
            </div>
          ))}
        </dl>
      </div>
      <div ref={targets} className="bg-go text-ink rounded-sm px-2 text-sm empty:hidden" />
    </div>
  )
}

const CARD = 'w-68 rounded-md bg-paper/95 px-4 py-3 text-ink text-sm shadow-ink/30 shadow-lg'

type Step = {
  text: ReactNode
  /** True once the pilot has done this step. Steps without a test are never ticked off. */
  done?: (sim: FlightSim, controls: Controls) => boolean
}

/** Takeoff and landing steps for a helicopter: no runway, just up and down from a hover. */
function rotorSteps(spec: AircraftSpec): { takeoff: Step[]; landing: Step[] } {
  const takeoff: Step[] = [
    {
      text: (
        <>
          Press <Key>O</Key> for battery power, then <Key>U</Key> for the fuel pumps.
        </>
      ),
      done: (_, controls) => controls.battery && controls.fuelPumps
    },
    {
      text: (
        <>
          Press <Key>I</Key> to start both engines, and wait for the rotor to reach 100%.
        </>
      ),
      done: sim => sim.rotorSpeed > 0.98
    },
    {
      text: (
        <>
          Press <Key>P</Key> to release the parking brake.
        </>
      ),
      done: (_, controls) => !controls.parkingBrake
    },
    {
      text: (
        <>
          Hold <Key>W</Key> to lift off, then let go: the helicopter holds its hover.
        </>
      ),
      done: sim => sim.altitudeAgl > spec.restHeight + 5
    },
    {
      text: (
        <>
          Tilt with the arrows and turn on the spot with <Key>A</Key> and <Key>D</Key>. <Key>Q</Key>{' '}
          holds a cruise speed hands off.
        </>
      ),
      done: (_, controls) => controls.trim < -0.3
    }
  ]
  const landing: Step[] = [
    {
      text: (
        <>
          Press <Key>E</Key> until the speed hold reads Hover, and let go of the arrows to slow
          down.
        </>
      ),
      done: (sim, controls) => controls.trim > -0.05 && sim.groundSpeed < 3
    },
    {
      text: (
        <>
          Hold <Key>S</Key> to come down. The descent slows by itself near the ground.
        </>
      ),
      done: sim => sim.onGround
    },
    {
      text: (
        <>
          Keep holding <Key>S</Key> to lower the collective fully.
        </>
      ),
      done: (sim, controls) => sim.onGround && controls.throttle < 0.1
    },
    {
      text: (
        <>
          Set the parking brake with <Key>P</Key>, and stop the engines with <Key>I</Key>.
        </>
      )
    }
  ]
  return { takeoff, landing }
}

/** True when the aircraft is on a runway and pointing along it, either way. */
function linedUp(sim: FlightSim) {
  for (const runway of AIRPORTS.flatMap(airport => airport.runways)) {
    if (outside(runway, sim.position.x, sim.position.z) > 0) continue
    const offset = sim.heading - (runway.heading * Math.PI) / 180
    if (Math.abs(Math.sin(offset)) < 0.26) return true
  }
  return false
}

/** Distance in metres to the nearest terminal gate. */
function nearestGate(sim: FlightSim) {
  let nearest = Number.POSITIVE_INFINITY
  for (const gate of AIRPORTS.flatMap(airport => airport.gates)) {
    nearest = Math.min(nearest, Math.hypot(gate.x - sim.position.x, gate.z - sim.position.z))
  }
  return nearest
}

/**
 * Numbered steps that tick themselves off as the pilot does them.
 * The first step still to do is shown in bold.
 */
function Checklist(props: {
  title: string
  steps: Step[]
  shown: (sim: FlightSim, controls: Controls) => boolean
}) {
  const { steps, shown } = props
  const card = useRef<HTMLDivElement>(null)
  const items = useRef<(HTMLLIElement | null)[]>([])
  useTelemetry(
    useCallback(
      (sim: FlightSim, controls: Controls) => {
        if (!card.current) return
        card.current.hidden = !shown(sim, controls)
        if (card.current.hidden) return
        let next = -1
        steps.forEach((step, index) => {
          const item = items.current[index]
          if (!item) return
          const done = step.done?.(sim, controls) ?? false
          item.dataset.done = String(done)
          item.dataset.next = String(next < 0 && !done)
          if (next < 0 && !done) next = index
        })
        // Show the last finished step and the next few, so the card stays short
        const from = next < 0 ? steps.length - 1 : next
        items.current.forEach((item, index) => {
          if (item) item.hidden = index < from - 1 || index > from + 3
        })
      },
      [steps, shown]
    )
  )
  return (
    <div ref={card} className={CARD} hidden>
      <h2 className="text-base font-bold">{props.title}</h2>
      <ol className="mt-1 list-decimal space-y-0.5 pl-5">
        {steps.map((step, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: the steps of a checklist never reorder
            key={index}
            ref={item => {
              items.current[index] = item
            }}
            className="data-[done=true]:line-through data-[done=true]:opacity-45 data-[next=true]:font-bold"
          >
            {step.text}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** What turning the fuel dump switch does on this aircraft, right now. */
function dumpNotice(on: boolean, sim: FlightSim) {
  if (!on) return 'Fuel dump off'
  if (!sim.spec.fuelDump) return 'This aircraft cannot dump fuel'
  if (sim.onGround) return 'Fuel dump armed: it starts once airborne'
  if (!sim.powered) return 'No power for the dump pumps'
  if (sim.fuel <= sim.spec.fuelCapacity * DUMP_FLOOR) return 'Already down to landing fuel'
  return 'Dumping fuel to lighten the aircraft for landing'
}

/** Before the first physics step the aircraft is parked but not yet marked as on the ground. */
const parked = (sim: FlightSim) => sim.onGround || sim.altitudeAgl < 3

/** Every switch and lever position that earns a confirmation when it changes. */
function switches(sim: FlightSim, controls: Controls) {
  const { autopilot, autothrottle, landingLights } = game.pilot
  return {
    gear: controls.gearDown,
    flaps: controls.flapNotch,
    airbrake: controls.speedBrake,
    reverse: controls.reverse,
    parking: controls.parkingBrake,
    // One digit per engine, such as '0110', so a change shows which engine moved
    switched: sim.engines.map((_, i) => (controls.engineSwitches[i] ? 1 : 0)).join(''),
    running: sim.engines.map(engine => (engine.running ? 1 : 0)).join(''),
    lights: landingLights,
    battery: controls.battery,
    pumps: controls.fuelPumps,
    dumpSwitch: controls.fuelDump,
    dumping: sim.dumping,
    flapsJammed: sim.flapsJammed,
    gearJammed: sim.gearJammed,
    flapOverspeed: sim.flapOverspeed,
    gearOverspeed: sim.gearOverspeed,
    overspeed: sim.indicatedAirspeed > sim.speedLimit,
    // One digit per engine, such as '10' while engine 1 burns
    fires: sim.engines.map(engine => (engine.fire ? 1 : 0)).join(''),
    ditched: sim.ditched,
    bellied: sim.bellied,
    leaking: sim.fuelLeak > 0,
    hydraulics: sim.hydraulicsFailed,
    modes: autopilot.on ? `${autopilot.lateral} ${autopilot.vertical}` : '',
    leg: game.nav.leg,
    approach: game.nav.approach?.id ?? '',
    flyingApproach: game.pilot.flyingApproach,
    handedOver: game.pilot.handedOver,
    waypoint: game.nav.active,
    autopilot: autopilot.on,
    autothrottle: autothrottle.on
  }
}

/** Takeoff steps before the first flight, landing steps when low and slowing down or back on the ground. */
function Checklists({ spec }: { spec: AircraftSpec }) {
  const { takeoff, landing } = useMemo(() => {
    if (spec.rotor) return rotorSteps(spec)
    const airliner = spec.shape.type === 'airliner'
    // Concorde's lever droops the nose instead of lowering flaps
    const nose = spec.flapName === 'Nose'
    // Flaps the pilot sets: none on fighters, whose flaps follow the gear
    const flaps = spec.autoFlaps ? 0 : spec.flapLabels.length - 1
    const takeoffSteps: (Step | false)[] = [
      {
        text: (
          <>
            Press <Key>O</Key> for battery power, then <Key>U</Key> for the fuel{' '}
            {spec.panel === 'dials' ? 'valve' : 'pumps'}.
          </>
        ),
        done: (_, controls) => controls.battery && controls.fuelPumps
      },
      {
        text: (
          <>
            Press <Key>I</Key> to start{' '}
            {spec.engineCount > 1 ? (
              <>
                all {spec.engineCount} engines, or <Key>1</Key> to{' '}
                <Key>{String(spec.engineCount)}</Key> one at a time
              </>
            ) : (
              'the engine'
            )}
            .
          </>
        ),
        done: sim => sim.enginesRunning === spec.engineCount
      },
      spec.panel !== 'dials' &&
        flaps > 0 && {
          text: (
            <>
              {nose ? (
                <>
                  Press <Key>F</Key> once to lower the nose to {spec.flapLabels[1]} for takeoff.
                </>
              ) : (
                <>
                  Press <Key>F</Key> twice for takeoff flaps.
                </>
              )}
            </>
          ),
          done: (_, controls) => controls.flapNotch >= (nose ? 1 : 2)
        },
      {
        text: (
          <>
            Press <Key>P</Key> to release the parking brake.
          </>
        ),
        done: (_, controls) => !controls.parkingBrake
      },
      airliner && {
        text: (
          <>
            Press <Key>R</Key> and add a little throttle to push back from the gate. Press{' '}
            <Key>R</Key> again once clear.
          </>
        ),
        done: (sim, controls) => nearestGate(sim) > 35 && !controls.reverse
      },
      {
        text: 'Taxi along the yellow lines to the end of the runway, then line up.',
        done: linedUp
      },
      {
        text: (
          <>
            Hold <Key>W</Key> for full throttle. Steer with <Key>A</Key> and <Key>D</Key>.
          </>
        ),
        done: (sim, controls) => linedUp(sim) && controls.throttle > 0.95
      },
      {
        text: (
          <>
            At {spec.rotateSpeed} knots, hold <Key>↓</Key> until the nose lifts, then let go.
          </>
        )
      },
      {
        text: (
          <>
            Climb at {spec.climbSpeed} knots
            {spec.retractableGear && (
              <>
                {' '}
                and press <Key>G</Key> to raise the gear
              </>
            )}
            .
            {spec.panel !== 'dials' && flaps > 0 && (
              <>
                {' '}
                Press <Key>V</Key> to raise the {nose ? 'nose' : 'flaps'} before{' '}
                {spec.flapSpeeds[nose ? 0 : 1]} knots.
              </>
            )}
          </>
        ),
        done: (sim, controls) =>
          sim.altitudeAgl > 150 &&
          controls.flapNotch === 0 &&
          (!spec.retractableGear || !controls.gearDown)
      },
      {
        text: (
          <>
            With a flight plan, press <Key>J</Key> and <Key>X</Key>: the autopilot flies the route
            and its approach.
          </>
        ),
        done: () => !game.nav.plan || game.pilot.autopilot.lateral === 'NAV'
      }
    ]
    const landingSteps: Step[] = [
      {
        text: (
          <>
            Slow to {spec.approachSpeed} knots: hold <Key>S</Key>
            {spec.speedBrakeDrag > 0 && (
              <>
                , and open the airbrake with <Key>B</Key>
              </>
            )}
            .
          </>
        ),
        done: sim => sim.indicatedAirspeed * KNOTS_PER_MS < spec.approachSpeed + 10
      },
      {
        text: (
          <>
            {spec.retractableGear && (
              <>
                Press <Key>G</Key> for gear down.{' '}
              </>
            )}
            {flaps > 0 && (
              <>
                Press <Key>F</Key> until the {nose ? 'nose is fully down' : 'flaps are full'}.
              </>
            )}
          </>
        ),
        done: (sim, controls) => sim.gearPosition > 0.99 && controls.flapNotch >= flaps
      },
      {
        text: (
          <>
            Press <Key>N</Key> for approach guidance. Two white and two red lights beside the runway
            mean you are on the glide path.
          </>
        ),
        done: sim => sim.onGround || sim.altitudeAgl < spec.wingSpan
      },
      {
        text: 'A few feet above the runway, close the throttle and lift the nose a little.',
        done: sim => sim.onGround
      },
      {
        text: (
          <>
            {spec.autobrake ? (
              'Spoilers and brakes come on by themselves.'
            ) : (
              <>
                Hold <Key>Space</Key> to brake.
              </>
            )}{' '}
            {spec.reverseThrust > 0 && (
              <>
                Press <Key>R</Key> and add throttle for reverse thrust.
              </>
            )}
          </>
        ),
        done: sim => sim.onGround && sim.groundSpeed < 12
      },
      {
        text: (
          <>
            Taxi to a gate or the hangars, set the parking brake with <Key>P</Key>, and stop the
            engines with <Key>I</Key>.
          </>
        )
      }
    ]
    return { takeoff: takeoffSteps.filter(step => step !== false), landing: landingSteps }
  }, [spec])

  const beforeFlight = useCallback((sim: FlightSim) => parked(sim) && !game.hasFlown, [])
  const arriving = useCallback(
    (sim: FlightSim, controls: Controls) => {
      if (parked(sim)) return game.hasFlown
      // A helicopter is landing once it slows low down; its collective says nothing
      if (spec.rotor) return game.hasFlown && sim.altitudeAgl < 60 && sim.groundSpeed < 15
      return sim.altitudeAgl < 500 && controls.throttle < 0.6
    },
    [spec]
  )
  return (
    <>
      <Checklist title="Takeoff Steps" steps={takeoff} shown={beforeFlight} />
      <Checklist title="Landing Steps" steps={landing} shown={arriving} />
    </>
  )
}

/** Says what the autopilot does now that its modes changed. */
function modeNotice() {
  const { autopilot } = game.pilot
  const lateral = {
    HDG: 'flying the heading knob',
    NAV: 'following the flight plan',
    APP: 'flying the approach'
  }[autopilot.lateral]
  const vertical = {
    ALT: 'holding altitude',
    VS: 'at the set climb rate. The bracket keys change it',
    FLCH: 'changing level at the set speed',
    VNAV: 'on the planned climb and descent',
    APP: 'on the glide path'
  }[autopilot.vertical]
  if (autopilot.lateral === 'APP')
    return 'Autopilot flying the approach. Set flaps, gear, and speed'
  return `Autopilot ${lateral}, ${vertical}`
}

/** Names a newly picked approach, such as 'ILS 05 at Northgate International'. */
function approachNotice(id: string) {
  const approach = game.nav.approach
  if (!approach) return id
  return `${approach.kind} ${approach.end.designator} at ${approach.end.airport.name}`
}

/** Confirms engine switches, given before and after as one digit per engine. */
function engineNotice(now: string, was: string) {
  const changed = [...now].flatMap((on, i) => (on !== was[i] ? [i] : []))
  const several = now.length > 1
  if (changed.length === 1) {
    const name = several ? `Engine ${changed[0] + 1}` : 'Engine'
    return now[changed[0]] === '1' ? `${name} starting` : `${name} shut down`
  }
  if (!now.includes('0')) return `Starting ${now.length} engines`
  if (!now.includes('1')) return 'Engines shut down'
  return ''
}

/** Short confirmation that appears for a moment when the pilot flips a switch or moves a lever. */
function Notices({ spec }: { spec: AircraftSpec }) {
  const box = useRef<HTMLDivElement>(null)
  const before = useRef<ReturnType<typeof switches> | null>(null)
  const hideAt = useRef(0)
  useTelemetry(
    useCallback(
      (sim: FlightSim, controls: Controls) => {
        if (!box.current) return
        if (game.getState().status !== 'flying') {
          before.current = null
          box.current.hidden = true
          return
        }
        const now = switches(sim, controls)
        const was = before.current
        before.current = now
        if (!was) return
        const several = spec.engineCount > 1
        let notice = ''
        if (now.gear !== was.gear) {
          if (now.gear && sim.gearStuck) notice = 'Gear lever down, but the gear stays up'
          else notice = now.gear ? 'Landing gear down' : 'Landing gear up'
        } else if (now.flaps !== was.flaps) {
          notice = now.hydraulics
            ? 'No hydraulics: the flaps do not move'
            : `${spec.flapName} ${spec.flapLabels[now.flaps]}`
        } else if (now.airbrake !== was.airbrake) {
          if (spec.speedBrakeDrag === 0) notice = 'This aircraft has no airbrake'
          else if (now.hydraulics) notice = 'No hydraulics: the airbrake does not move'
          else notice = now.airbrake ? 'Airbrake open' : 'Airbrake closed'
        } else if (now.reverse !== was.reverse) {
          if (spec.reverseThrust === 0) notice = 'This aircraft has no thrust reversers'
          else if (!now.reverse) notice = 'Reverse thrust off'
          else
            notice = sim.onGround
              ? 'Reverse thrust on'
              : 'Reverse thrust on in flight: expect to sink fast'
        } else if (now.dumpSwitch !== was.dumpSwitch) {
          notice = dumpNotice(now.dumpSwitch, sim)
        } else if (was.dumping && !now.dumping && now.dumpSwitch) {
          notice = sim.onGround
            ? 'Fuel dump stopped on the ground'
            : 'Fuel dump done: landing fuel left'
        } else if (now.parking !== was.parking) {
          notice = now.parking ? 'Parking brake set' : 'Parking brake released'
        } else if (now.switched !== was.switched) {
          notice = engineNotice(now.switched, was.switched)
          const starting = now.switched.includes('1')
          if (starting && !sim.powered) notice = 'No power to start: press O for the battery'
          else if (starting && !controls.fuelPumps)
            notice = `No fuel to start: press U for the fuel ${spec.panel === 'dials' ? 'valve' : 'pumps'}`
        } else if (now.running !== was.running) {
          const started = [...now.running].findIndex(
            (on, i) => on === '1' && was.running[i] === '0'
          )
          if (started < 0) notice = ''
          else if (!now.running.includes('0'))
            notice = several ? 'All engines running' : 'Engine running'
          else notice = `Engine ${started + 1} running`
        } else if (now.battery !== was.battery) {
          notice = now.battery ? 'Battery on: displays powered' : 'Battery off'
        } else if (now.pumps !== was.pumps) {
          if (now.pumps) notice = 'Fuel pumps on'
          else
            notice = sim.engineRunning
              ? 'Fuel pumps off: engines stop within 20 seconds'
              : 'Fuel pumps off'
        } else if (now.flapsJammed && !was.flapsJammed) {
          notice = 'Flaps jammed: they were out too fast'
        } else if (now.gearJammed && !was.gearJammed) {
          notice = 'Gear damaged: it is stuck down'
        } else if (now.fires !== was.fires) {
          const lit = [...now.fires].flatMap((fire, i) =>
            fire === '1' && was.fires[i] !== '1' ? [i + 1] : []
          )
          const out = [...was.fires].flatMap((fire, i) =>
            fire === '1' && now.fires[i] !== '1' ? [i + 1] : []
          )
          if (lit.length > 1) notice = `Fire in engines ${lit.join(' and ')}`
          else if (lit.length === 1) notice = `Engine ${lit[0]} fire`
          else if (out.length > 0) notice = `Engine ${out.join(' and ')} fire out`
        } else if (now.ditched && !was.ditched) {
          notice = 'Ditched: the aircraft is afloat'
        } else if (now.bellied && !was.bellied) {
          notice = 'Belly landing: sliding to a stop'
        } else if (now.leaking && !was.leaking) {
          notice = 'Fuel leak: the fuel is falling faster than the engines burn it'
        } else if (now.hydraulics && !was.hydraulics) {
          notice = 'Hydraulic failure: no flaps, airbrake, spoilers, or autobrake'
        } else if (now.overspeed && !was.overspeed) {
          // High up the Mach limit comes first. Low down, thick air strains the airframe.
          notice =
            sim.speedLimit < spec.neverExceedSpeed
              ? 'Overspeed: past the Mach limit. Throttle back'
              : 'Overspeed: throttle back or climb. The airframe breaks if you stay this fast'
        } else if (now.flapOverspeed && !was.flapOverspeed) {
          notice = 'Too fast for these flaps: slow down or raise them'
        } else if (now.gearOverspeed && !was.gearOverspeed) {
          notice = `Too fast with the gear down: stay below ${spec.gearSpeed} knots`
        } else if (now.leg > was.leg && game.nav.plan) {
          const fix = game.nav.next
          notice = fix ? `Waypoint passed, next ${fix.name}` : ''
        } else if (now.lights !== was.lights) {
          notice = now.lights ? 'Landing lights on' : 'Landing lights off'
        } else if (now.approach !== was.approach) {
          notice = now.approach ? approachNotice(now.approach) : 'Approach cleared'
        } else if (now.handedOver && !was.handedOver) {
          notice = '50 feet: autopilot off. Flare and land'
        } else if (now.flyingApproach !== was.flyingApproach) {
          notice = now.flyingApproach
            ? 'Autopilot flying the approach. Set flaps, gear, and speed'
            : 'Approach mode off'
        } else if (now.waypoint > was.waypoint && now.approach) {
          const fix = game.nav.next
          if (fix)
            notice =
              fix.role === 'RWY'
                ? 'Final approach: follow the glide path down'
                : `Passing waypoint, next ${fix.name}`
        } else if (now.autopilot !== was.autopilot) {
          notice = now.autopilot
            ? 'Autopilot on: arrow keys turn the heading and altitude knobs'
            : 'Autopilot off'
        } else if (now.modes !== was.modes && now.modes) {
          notice = modeNotice()
        } else if (now.autothrottle !== was.autothrottle) {
          notice = now.autothrottle ? 'Autothrottle on: W and S set the speed' : 'Autothrottle off'
        }
        if (notice) {
          setText(box.current, notice)
          box.current.hidden = false
          hideAt.current = performance.now() + 2600
        } else if (performance.now() > hideAt.current) box.current.hidden = true
      },
      [spec]
    )
  )
  return (
    <div
      ref={box}
      role="status"
      hidden
      className="bg-ink/85 text-marking rounded-md px-4 py-1.5 text-lg shadow-lg"
    />
  )
}

// Milliseconds the look-around help stays up after the view last moved
const LOOK_HINT_TIME = 4000
const touchdown = new Vector3()

/**
 * One line of help about the view: which runway it is watching, or for a while after the
 * mouse turns it, how to look ahead again.
 */
function LookHint() {
  const box = useRef<HTMLParagraphElement>(null)
  const last = useRef('')
  const hideAt = useRef(0)
  useTelemetry(
    useCallback((sim: FlightSim) => {
      if (!box.current) return
      const { look } = game
      let text = ''
      if (game.getState().status === 'flying' && !game.getState().bombsight) {
        const where = `${look.yaw} ${look.pitch} ${look.distance} ${look.fov}`
        if (where !== last.current) {
          last.current = where
          hideAt.current = performance.now() + LOOK_HINT_TIME
        }
        if (look.focus === 'runway') {
          const end = runwayFocus(sim.position.x, sim.position.z, game.nav.approach, touchdown)
          text = `Watching runway ${end.designator} at ${end.airport.code}. Press / to look ahead`
        } else if (look.focus === 'free' && look.moved && performance.now() < hideAt.current)
          text = 'Double-click to look ahead again'
      }
      setText(box.current, text)
      box.current.hidden = text === ''
    }, [])
  )
  return (
    <p
      ref={box}
      role="status"
      hidden
      className="bg-ink/60 text-marking/90 rounded-full px-3 py-0.5 text-sm"
    />
  )
}

/** Holds the glass screens, which go dark while the aircraft has no electrical power. */
function GlassScreens({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  useTelemetry(
    useCallback((sim: FlightSim) => {
      if (box.current) box.current.dataset.dark = String(!sim.powered)
    }, [])
  )
  return (
    <div ref={box} className="contents">
      {children}
    </div>
  )
}

export function Key({ children }: { children: string }) {
  return (
    <kbd className="border-ink/40 inline-block min-w-5 rounded-sm border bg-white/60 px-1 text-center font-sans text-xs leading-5">
      {children}
    </kbd>
  )
}

/** Everything drawn over the 3D view while flying. */
export function Hud() {
  const status = useGame(state => state.status)
  const map = useGame(state => state.map)
  const spec = useGame(state => state.flown)
  const camera = useGame(state => state.camera)
  const mission = useGame(state => state.mission)
  const bombsight = useGame(state => state.bombsight)
  const scale = usePanelScale()
  const panel = useRef<HTMLDivElement>(null)
  return (
    <div
      className="pointer-events-none absolute inset-0 transition-opacity data-[dim=true]:opacity-40"
      data-dim={status !== 'flying'}
    >
      <HeadUpDisplay spec={spec} />
      <GoalMarker panel={panel} />
      {/* Readouts, the bank arc, and notices stack down the middle so none covers another */}
      <div className="absolute top-0 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1">
        <Readouts />
        {camera === 'chase' && !bombsight && <BankIndicator />}
        <GpwsAlert />
        <Notices spec={spec} />
        <LookHint />
      </div>
      {/* Steps and coaching sit to the left, clear of the view ahead */}
      <div className="absolute top-4 left-4 flex flex-col gap-2">
        {mission ? <MissionCard mission={mission} /> : <Checklists spec={spec} />}
        {!mission && spec.bombBay && (
          <div className="bg-paper/95 text-ink w-80 rounded-md px-4 py-3 text-sm shadow-lg">
            <h2 className="text-base font-bold">Bomb Bay</h2>
            <BombPanel total={spec.bombBay} />
          </div>
        )}
        <CoachCard />
      </div>
      {/* The enlarged map drops below the top bar, with the approach card beside it */}
      <div
        className={`absolute right-4 flex gap-3 ${map === 'large' ? 'top-20 flex-row-reverse items-end' : 'top-4 flex-col items-end'}`}
      >
        {map !== 'hidden' && <MiniMap large={map === 'large'} />}
        <ApproachCard />
        <HoverDisplay />
      </div>
      <div
        ref={panel}
        className="absolute bottom-0 left-1/2 origin-bottom"
        style={{ transform: `translateX(-50%) scale(${scale})`, width: PANEL_WIDTH }}
      >
        <div className="mb-1 flex flex-col items-center gap-1">
          <AutopilotPanel />
          <Annunciators spec={spec} />
        </div>
        <div className="border-panel-edge bg-panel flex items-end justify-center gap-2 rounded-t-xl border-t px-5 pt-3 pb-2 shadow-[0_-6px_24px_rgb(0_0_0/0.35)]">
          <Levers spec={spec} />
          {spec.panel === 'dials' ? (
            <>
              <AirspeedIndicator spec={spec} />
              <AttitudeIndicator />
              <Altimeter />
              <TurnCoordinator />
              <HeadingIndicator />
              <VerticalSpeedIndicator spec={spec} />
              <Tachometer spec={spec} />
            </>
          ) : (
            <GlassScreens>
              <PrimaryFlightDisplay spec={spec} />
              <NavigationDisplay />
              <EngineDisplay spec={spec} />
            </GlassScreens>
          )}
          <GearAndFuel spec={spec} />
        </div>
      </div>
    </div>
  )
}

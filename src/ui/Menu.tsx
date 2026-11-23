import { type ReactNode, useState } from 'react'
import { canUse, game, useGame, WIND_SPEEDS, type WindLevel } from '../game/game'
import { type AircraftSpec, HANGAR } from '../sim/aircraft'
import type { CrashReason } from '../sim/flight-sim'
import { AIRPORTS, type Airport } from '../world/island'
import { Key } from './Hud'
import { MissionActions, MissionsPanel } from './Missions'
import { FPM_PER_MS, KNOTS_PER_MS } from './telemetry'

const CRASH_REASONS: Record<CrashReason, string> = {
  terrain: 'The aircraft hit the ground.',
  water: 'The aircraft went into the sea.',
  'hard-landing': 'You touched down too hard. Keep the descent under 700 feet per minute.',
  'gear-up':
    'You touched down too hard with the gear up. Press G to lower it before landing. With the gear stuck, sink under 600 feet per minute with the wings level.',
  'gear-collapse': 'The landing gear collapsed on rough ground.',
  overspeed:
    'The aircraft stayed far past its never-exceed speed and broke up. Throttle back when OVERSPEED shows. Low down the air is thick: climb before going fast.',
  missile:
    'An enemy missile hit the aircraft. When MISSILE flashes, press Space for flares and turn hard across its path.',
  tree: 'The aircraft flew into a tree.',
  building: 'The aircraft flew into a building.',
  balloon: 'The aircraft flew into a hot-air balloon.',
  boat: 'The aircraft flew into a boat.',
  traffic: 'The aircraft collided with another aircraft.'
}

const CONTROLS: { title: string; rows: [keys: string[], action: string][] }[] = [
  {
    title: 'Flying',
    rows: [
      [['↑', '↓'], 'Push the nose down, pull it up. Tap for small moves'],
      [['←', '→'], 'Roll left, roll right'],
      [['A', 'D'], 'Rudder, and steering on the ground'],
      [['Shift'], 'Hold with the above for fine control'],
      [['Q', 'E'], 'Trim nose down, nose up']
    ]
  },
  {
    title: 'Helicopter',
    rows: [
      [['W', 'S'], 'Climb, descend. Let go and it holds the height'],
      [['↑', '↓'], 'Tilt forward to fly ahead, back to slow down'],
      [['←', '→'], 'Slide sideways in a hover, bank to turn at speed'],
      [['A', 'D'], 'Turn on the spot'],
      [['Q', 'E'], 'Speed held hands off: faster, slower, down to a hover']
    ]
  },
  {
    title: 'Autopilot',
    rows: [
      [['Z'], 'Autopilot on: holds heading and altitude'],
      [['X'], 'Autothrottle: holds the speed knob, W and S set it'],
      [['←', '→'], 'With the autopilot on: heading knob'],
      [['↑', '↓'], 'With the autopilot on: descend or climb, and turn the altitude knob'],
      [['H'], 'Heading mode: fly the heading knob'],
      [['J'], 'Nav mode: fly the flight plan'],
      [['Y'], 'Level change: climb or descend to the altitude knob'],
      [['K'], 'Vertical speed mode, [ and ] set the rate']
    ]
  },
  {
    title: 'Approach and Landing',
    rows: [
      [['N'], 'Pick the next approach, nearest airport first'],
      [['Shift', 'N'], 'Clear the approach'],
      [
        ['T'],
        'Let the autopilot fly the approach, picking one if needed. Airliners land themselves'
      ]
    ]
  },
  {
    title: 'Engine and Systems',
    rows: [
      [['O'], 'Battery: electrical power on or off'],
      [['U'], 'Fuel pumps on or off'],
      [['I'], 'Start or stop all engines'],
      [['1–4'], 'Start or stop one engine, numbered from the left wing'],
      [['Shift'], "With 1–4: fire that engine's extinguisher, once it is shut down"],
      [['W', 'S'], 'Throttle up, throttle down'],
      [['F', 'V'], 'Flaps down a notch, up a notch'],
      [['G'], 'Raise or lower the landing gear'],
      [['B'], 'Open or close the airbrake'],
      [['R'], 'Reverse thrust, on the ground or in the air'],
      [['Space'], 'Wheel brakes while held. In the air in a fight, drop flares'],
      [[',', '.'], 'Left or right brake, to turn tightly on the ground'],
      [['P'], 'Parking brake'],
      [['L'], 'Landing lights'],
      [['-'], 'Dump fuel to land lighter: 787, A380, Concorde, and F-35A'],
      [['Tab'], 'B-2: open or close the bombsight'],
      [['Enter'], 'Fire a missile, or in the bombsight drop a bomb. Hold over a city for a string']
    ]
  },
  {
    title: 'View',
    rows: [
      [['C'], 'Switch between chase and cockpit view'],
      [
        ['Drag'],
        'Look around with the mouse: circle the aircraft, or turn your head in the cockpit. Double-click to look ahead again'
      ],
      [['Wheel'], 'Zoom the view in or out'],
      [['/'], 'Keep the view on the runway, for the turn onto final. Press again to look ahead'],
      [['M'], 'Enlarge, then hide the map'],
      [['`'], 'Photo mode: freeze the flight, hide the panels, and move a free camera'],
      [['Esc'], 'Pause']
    ]
  }
]

/** Straight-line distance between two airports in nautical miles. */
const distanceTo = (from: Airport, to: Airport) =>
  Math.round(Math.hypot(to.x - from.x, to.z - from.z) / 1852)

const WIND_LEVELS: WindLevel[] = ['calm', 'light', 'strong']
const windLabel = (level: WindLevel) =>
  level === 'calm' ? 'Calm' : `${Math.round(WIND_SPEEDS[level] * KNOTS_PER_MS)} knots`

const FOCUS =
  'outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 focus-visible:ring-offset-paper'

function Action(props: { onClick: () => void; primary?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`${FOCUS} border-ink rounded-sm border-2 px-4 py-2 text-left text-lg font-bold ${
        props.primary ? 'bg-ink text-paper hover:bg-ink/85' : 'text-ink hover:bg-ink/10'
      }`}
    >
      {props.children}
    </button>
  )
}

/** Row of joined buttons where exactly one is pressed. */
function Choice<T extends string>(props: {
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 font-bold">{props.label}</span>
      <div className="flex">
        {props.options.map(([option, text]) => (
          <button
            key={option}
            type="button"
            aria-pressed={props.value === option}
            onClick={() => props.onChange(option)}
            className={`${FOCUS} border-ink hover:bg-ink/10 aria-pressed:bg-ink aria-pressed:text-paper -ml-px border px-3 py-1 first:ml-0 first:rounded-l-sm last:rounded-r-sm`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

const points = (list: [number, number][]) => list.map(([x, z]) => `${x},${z}`).join(' ')
/** The same outline on both sides of the centreline. */
const pair = (half: [number, number][]) => [half, half.map(([x, z]): [number, number] => [-x, z])]

/** Plan view of an aircraft drawn from its real proportions, nose up. */
function Silhouette({ spec }: { spec: AircraftSpec }) {
  const { shape } = spec
  const half = spec.wingSpan / 2
  let nose = -7.5
  let tail = 7.5
  const parts: [number, number][][] = []
  if (shape.type === 'airliner' && shape.variant === 'concorde') {
    nose = shape.noseZ
    tail = shape.tailZ
    // Needle nose and slim body, then the ogival delta wing and two nacelles
    parts.push(
      [
        [0, nose],
        [0.9, nose + 7],
        [1.45, nose + 12],
        [1.45, tail - 9],
        [0.3, tail],
        [-0.3, tail],
        [-1.45, tail - 9],
        [-1.45, nose + 12],
        [-0.9, nose + 7]
      ],
      ...pair([
        [1.2, -14],
        [2, -8],
        [3, -2.5],
        [4.3, 3],
        [6, 8.5],
        [8, 13],
        [10, 17],
        [11.6, 20.2],
        [12.8, 22.4],
        [12.8, 25.6],
        [1.2, 26.4]
      ]),
      ...pair([
        [1.8, 7],
        [4.9, 7],
        [4.9, 27.5],
        [1.8, 27.5]
      ])
    )
  } else if (shape.type === 'airliner') {
    nose = shape.noseZ
    tail = shape.tailZ
    const { radius, wing } = shape
    const root = radius * 0.85
    const tailChord = shape.tailSpan * 0.36
    const tailZ = tail - tailChord - radius * 0.9
    parts.push(
      [
        [0, nose],
        [radius * 0.8, nose + radius * 1.3],
        [radius, nose + radius * 3],
        [radius, tail - radius * 6],
        [radius * 0.2, tail],
        [-radius * 0.2, tail],
        [-radius, tail - radius * 6],
        [-radius, nose + radius * 3],
        [-radius * 0.8, nose + radius * 1.3]
      ],
      ...pair([
        [root, wing.rootZ],
        [half, wing.tipZ],
        [half, wing.tipZ + wing.tipChord],
        [root + (half - root) * 0.32, wing.rootZ + wing.rootChord * 0.78],
        [root, wing.rootZ + wing.rootChord]
      ]),
      ...pair([
        [radius * 0.25, tailZ],
        [shape.tailSpan / 2, tailZ + shape.tailSpan * 0.3],
        [shape.tailSpan / 2, tailZ + shape.tailSpan * 0.3 + tailChord * 0.4],
        [radius * 0.25, tailZ + tailChord]
      ]),
      ...shape.engines.flatMap(([x, z]) =>
        pair([
          [x - shape.engineRadius, z],
          [x + shape.engineRadius, z],
          [x + shape.engineRadius * 0.8, z + shape.engineLength],
          [x - shape.engineRadius * 0.8, z + shape.engineLength]
        ])
      )
    )
  } else if (shape.type === 'bomber' || shape.type === 'shuttle') {
    // One flying wing: the right half's outline, then the left half's mirrored back to the nose
    nose = shape.outline[0][1]
    tail = Math.max(...shape.outline.map(([, z]) => z))
    parts.push([
      ...shape.outline,
      ...shape.outline
        .slice(1, -1)
        .map(([x, z]): [number, number] => [-x, z])
        .reverse()
    ])
  } else if (shape.type === 'fighter') {
    const wide = shape.variant === 'f35' ? 1.6 : 1.1
    parts.push(
      [
        [0, -7.5],
        [0.6, -4.6],
        [wide, -1],
        [wide, 5.5],
        [0.6, 7.5],
        [-0.6, 7.5],
        [-wide, 5.5],
        [-wide, -1],
        [-0.6, -4.6]
      ],
      ...pair([
        [wide * 0.8, -1],
        [half, 2.4],
        [half, 3.4],
        [wide * 0.8, 3.6]
      ]),
      ...pair([
        [0.7, 5.3],
        [half * 0.62, 6.6],
        [half * 0.62, 7.3],
        [0.7, 7.1]
      ])
    )
  } else if (shape.type === 'helicopter') {
    const { rotor } = spec
    nose = -7.6
    tail = rotor ? rotor.tailHub.z + rotor.tailRadius : 10
    // Cabin and tail boom, the stabilator, then the four main blades crossed over the cabin
    parts.push(
      [
        [0, nose],
        [0.8, -7.1],
        [1.15, -6.2],
        [1.18, 1.8],
        [0.6, 4.5],
        [0.3, 10],
        [-0.3, 10],
        [-0.6, 4.5],
        [-1.18, 1.8],
        [-1.15, -6.2],
        [-0.8, -7.1]
      ],
      [
        [-2.19, 9.1],
        [2.19, 9.1],
        [2.19, 9.9],
        [-2.19, 9.9]
      ]
    )
    if (rotor) {
      const { x, z } = rotor.tailHub
      parts.push([
        [x, z - rotor.tailRadius],
        [x + 0.25, z - rotor.tailRadius],
        [x + 0.25, z + rotor.tailRadius],
        [x, z + rotor.tailRadius]
      ])
      for (let i = 0; i < rotor.blades; i++) {
        const angle = Math.PI / 4 + (i * Math.PI * 2) / rotor.blades
        const [cos, sin] = [Math.cos(angle), Math.sin(angle)]
        // `r` metres out along the blade, `w` metres across it
        const at = (r: number, w: number): [number, number] => [
          rotor.hub.x + cos * r - sin * w,
          rotor.hub.z + sin * r + cos * w
        ]
        parts.push([at(0, -0.35), at(rotor.radius, -0.35), at(rotor.radius, 0.35), at(0, 0.35)])
      }
    }
  } else {
    nose = shape.noseZ
    tail = shape.tailZ
    const radius = shape.cabinRadius
    parts.push(
      [
        [-radius * 0.7, nose],
        [radius * 0.7, nose],
        [radius, nose + 1],
        [radius, 0.6],
        [0.14, tail],
        [-0.14, tail],
        [-radius, 0.6],
        [-radius, nose + 1]
      ],
      [
        [-half, -0.6],
        [half, -0.6],
        [half, spec.chord - 0.6],
        [-half, spec.chord - 0.6]
      ],
      [
        [-shape.tailSpan / 2, tail - 1],
        [shape.tailSpan / 2, tail - 1],
        [shape.tailSpan / 2, tail - 0.1],
        [-shape.tailSpan / 2, tail - 0.1]
      ],
      [
        [-shape.propRadius, nose - 0.25],
        [shape.propRadius, nose - 0.25],
        [shape.propRadius, nose - 0.1],
        [-shape.propRadius, nose - 0.1]
      ]
    )
  }
  const size = Math.max(spec.wingSpan, tail - nose) * 1.06
  return (
    <svg
      viewBox={`${-size / 2} ${(nose + tail) / 2 - size / 2} ${size} ${size}`}
      className="mx-auto size-16"
      fill="currentColor"
      aria-hidden="true"
    >
      {parts.map(part => (
        <polygon key={points(part)} points={points(part)} />
      ))}
    </svg>
  )
}

/** One card per aircraft in the hangar, each with its plan view. */
function AircraftPicker({ selected }: { selected: AircraftSpec }) {
  return (
    <fieldset className="mt-5">
      <legend className="sr-only">Aircraft</legend>
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        {HANGAR.map(spec => (
          <button
            key={spec.id}
            type="button"
            aria-pressed={selected === spec}
            onClick={() => game.selectAircraft(spec.id)}
            className={`${FOCUS} border-ink hover:bg-ink/10 aria-pressed:bg-ink aria-pressed:text-paper rounded-sm border px-1 pt-2 pb-1.5 text-center leading-tight font-bold`}
          >
            <Silhouette spec={spec} />
            <span className="mt-1 block">{spec.label}</span>
          </button>
        ))}
      </div>
    </fieldset>
  )
}

/** Start, pause, crash, and arrival screens, styled as a pilot's kneeboard card. */
export function Menu() {
  const status = useGame(state => state.status)
  const crash = useGame(state => state.crash)
  const crashShown = useGame(state => state.crashShown)
  const selected = useGame(state => state.selected)
  const departure = useGame(state => state.departure)
  const destination = useGame(state => state.destination)
  const arrival = useGame(state => state.arrival)
  const mission = useGame(state => state.mission)
  const result = useGame(state => state.missionResult)
  const [mode, setMode] = useState<'free' | 'missions'>('free')
  // The crash plays out in full view before the card covers it
  if (status === 'flying' || (status === 'crashed' && !crashShown)) return null

  const heading = {
    menu: 'Island Flyer',
    paused: 'Paused',
    crashed: mission ? 'Mission Failed' : 'Flight Ended',
    arrived: 'Flight Complete',
    finished: result?.passed ? 'Mission Complete' : 'Mission Failed',
    flying: ''
  }[status]
  let summary = CRASH_REASONS[crash ?? 'terrain']
  if (status === 'menu') {
    summary =
      'Twelve real aircraft, from a Cessna to the Space Shuttle and a Black Hawk helicopter, nine islands, and twelve airports. Fly free, or take on a mission.'
  } else if (status === 'paused') {
    summary = 'The aircraft holds its position until you resume.'
  } else if (status === 'finished' && result) {
    if (!result.passed) summary = result.reason
    else if (result.touchdown === undefined) summary = 'Every step done. Well flown.'
    else summary = `Every step done, with a touchdown at ${result.touchdown} ft/min. Well flown.`
  } else if (status === 'arrived' && arrival) {
    const minutes = Math.max(1, Math.round(arrival.flightSeconds / 60))
    const rate = Math.round((arrival.touchdownRate * FPM_PER_MS) / 10) * 10
    // A touchdown under 200 ft/min is a smooth one, over 500 a hard one
    const landing = rate < 200 ? 'a smooth' : rate < 500 ? 'a firm' : 'a hard'
    summary = `Parked at ${arrival.airport.name} after ${minutes} min in the air, with ${landing} touchdown at ${rate} ft/min.`
  }
  const choosing = status !== 'paused'

  return (
    <div className="bg-ink/45 absolute inset-0 grid place-items-center overflow-y-auto p-4">
      <section className="bg-paper text-ink shadow-ink/60 relative w-full max-w-5xl rounded-md px-8 pt-9 pb-7 shadow-2xl">
        {/* Kneeboard clip */}
        <div className="bg-panel ring-panel-edge absolute -top-3 left-1/2 h-8 w-40 -translate-x-1/2 rounded-sm shadow-md ring-1" />
        <header className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <h1 className="text-4xl leading-none font-bold tracking-tight">{heading}</h1>
          <p className="max-w-prose flex-1 text-lg leading-snug">{summary}</p>
        </header>
        {mission ? (
          <div className="mt-5 grid gap-8 md:grid-cols-[5fr_6fr]">
            <MissionActions mission={mission} />
            <ReferenceTabs />
          </div>
        ) : (
          <>
            {status !== 'paused' && (
              <div role="tablist" className="mt-5 flex gap-2">
                {(
                  [
                    ['free', 'Free Flight'],
                    ['missions', 'Missions']
                  ] as const
                ).map(([name, label]) => (
                  <button
                    key={name}
                    type="button"
                    role="tab"
                    aria-selected={mode === name}
                    onClick={() => setMode(name)}
                    className={`${FOCUS} border-ink hover:bg-ink/10 aria-selected:bg-ink aria-selected:text-paper rounded-sm border-2 px-5 py-1.5 text-xl font-bold`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {mode === 'missions' && status !== 'paused' ? (
              <MissionsPanel />
            ) : (
              <>
                {choosing && <AircraftPicker selected={selected} />}
                <div className="mt-5 grid gap-8 md:grid-cols-[5fr_6fr]">
                  <div className="flex flex-col gap-4">
                    {choosing && (
                      <div>
                        <h2 className="text-xl leading-tight font-bold">{selected.name}</h2>
                        <p className="mt-1 leading-snug">
                          {selected.role}. {selected.description}
                        </p>
                        <dl className="border-ink/25 mt-3 grid grid-cols-4 gap-2 border-y py-2 text-sm">
                          {(
                            [
                              ['Power', selected.stats.power],
                              ['Top speed', `${selected.stats.topSpeed} kt`],
                              selected.rotor
                                ? ['Climb', `${selected.stats.climb.toLocaleString('en')} ft/min`]
                                : ['Stall', `${selected.stats.stallSpeed} kt`],
                              selected.rotor
                                ? ['Rotor', `${Math.round(selected.rotor.radius * 2)} m`]
                                : ['Wingspan', `${Math.round(selected.wingSpan)} m`]
                            ] as const
                          ).map(([label, value]) => (
                            <div key={label}>
                              <dt className="opacity-65">{label}</dt>
                              <dd className="font-bold tabular-nums">{value}</dd>
                            </div>
                          ))}
                        </dl>
                        <label className="mt-3 flex items-center gap-3">
                          <span className="w-10 font-bold">From</span>
                          <select
                            value={departure.name}
                            onChange={event => game.selectDeparture(event.target.value)}
                            className={`${FOCUS} border-ink bg-paper min-w-0 flex-1 rounded-sm border px-2 py-1.5`}
                          >
                            {AIRPORTS.map(airport => (
                              <option
                                key={airport.name}
                                value={airport.name}
                                disabled={!canUse(selected, airport)}
                              >
                                {airport.name}, {airport.runways[0].length.toLocaleString('en')} m
                                runway
                                {canUse(selected, airport) ? '' : ' (too short)'}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="mt-2 flex items-center gap-3">
                          <span className="w-10 font-bold">To</span>
                          <select
                            value={destination?.name ?? ''}
                            onChange={event => game.selectDestination(event.target.value || null)}
                            className={`${FOCUS} border-ink bg-paper min-w-0 flex-1 rounded-sm border px-2 py-1.5`}
                          >
                            <option value="">No flight plan</option>
                            {AIRPORTS.filter(
                              airport => airport !== departure && canUse(selected, airport)
                            ).map(airport => (
                              <option key={airport.name} value={airport.name}>
                                {airport.name}, {distanceTo(departure, airport)} NM
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      {status === 'paused' && (
                        <Action primary onClick={game.resume}>
                          Resume Flight
                        </Action>
                      )}
                      <Action primary={choosing} onClick={game.startAtStand}>
                        {selected.shape.type === 'airliner'
                          ? 'Start at the Gate'
                          : selected.rotor
                            ? 'Start at the Helipad'
                            : 'Start at the Hangar'}
                      </Action>
                      <div className="grid grid-cols-2 gap-2">
                        <Action onClick={game.startOnRunway}>On the Runway</Action>
                        <Action onClick={game.startInAir}>In the Air</Action>
                      </div>
                      {status === 'paused' && (
                        <Action onClick={game.backToMenu}>Back to the Menu</Action>
                      )}
                    </div>
                  </div>

                  <ReferenceTabs />
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  )
}

/** Keyboard controls and settings, side by side with the flight choices. */
function ReferenceTabs() {
  const wind = useGame(state => state.wind)
  const muted = useGame(state => state.muted)
  const coach = useGame(state => state.coach)
  const graphics = useGame(state => state.graphics)
  const weather = useGame(state => state.weather)
  const time = useGame(state => state.time)
  const [tab, setTab] = useState<'controls' | 'settings'>('controls')
  return (
    <div>
      <div role="tablist" className="border-ink flex gap-1 border-b-2">
        {(['controls', 'settings'] as const).map(name => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={`${FOCUS} hover:bg-ink/10 aria-selected:bg-ink aria-selected:text-paper rounded-t-sm px-4 py-1 text-lg font-bold capitalize`}
          >
            {name}
          </button>
        ))}
      </div>
      {tab === 'controls' ? (
        <div role="tabpanel" className="mt-3 columns-2 gap-6 text-sm">
          {CONTROLS.map(group => (
            <div key={group.title} className="mb-3 break-inside-avoid">
              <h3 className="font-bold">{group.title}</h3>
              <dl className="mt-1 grid grid-cols-[3.4rem_1fr] gap-x-2 gap-y-0.5">
                {group.rows.map(([keys, action]) => (
                  <div key={action} className="col-span-2 grid grid-cols-subgrid items-baseline">
                    <dt className="flex gap-0.5">
                      {keys.map(key => (
                        <Key key={key}>{key}</Key>
                      ))}
                    </dt>
                    <dd className="leading-snug">{action}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      ) : (
        <div role="tabpanel" className="mt-4 flex flex-col gap-3">
          <Choice
            label="Wind"
            value={wind}
            options={WIND_LEVELS.map(level => [level, windLabel(level)] as const)}
            onChange={game.setWind}
          />
          <Choice
            label="Weather"
            value={weather}
            options={[
              ['clear', 'Clear'],
              ['cloudy', 'Low Cloud'],
              ['rain', 'Rain'],
              ['fog', 'Fog'],
              ['storm', 'Storm']
            ]}
            onChange={game.setWeather}
          />
          <Choice
            label="Time"
            value={time}
            options={[
              ['morning', 'Morning'],
              ['noon', 'Midday'],
              ['evening', 'Sunset'],
              ['night', 'Night']
            ]}
            onChange={game.setTime}
          />
          <Choice
            label="Sound"
            value={muted ? 'off' : 'on'}
            options={[
              ['on', 'On'],
              ['off', 'Off']
            ]}
            onChange={value => {
              if ((value === 'off') !== muted) game.toggleMuted()
            }}
          />
          <Choice
            label="Landing Coach"
            value={coach ? 'on' : 'off'}
            options={[
              ['on', 'On'],
              ['off', 'Off']
            ]}
            onChange={value => game.setCoach(value === 'on')}
          />
          <p className="text-sm leading-snug opacity-75">
            The landing coach suggests keys on the final approach. Every setting is kept for your
            next visit.
          </p>
          <h3 className="border-ink/25 mt-1 border-t pt-3 font-bold">Graphics</h3>
          <Choice
            label="Preset"
            value={graphics.preset}
            options={[
              ['low', 'Low'],
              ['medium', 'Medium'],
              ['high', 'High'],
              ['ultra', 'Ultra'],
              ...(graphics.preset === 'custom' ? [['custom', 'Custom'] as const] : [])
            ]}
            onChange={preset => {
              if (preset !== 'custom') game.setGraphicsPreset(preset)
            }}
          />
          <Choice
            label="Shadows"
            value={graphics.shadows}
            options={[
              ['off', 'Off'],
              ['on', 'On'],
              ['sharp', 'Sharp']
            ]}
            onChange={shadows => game.setGraphics({ shadows })}
          />
          <Choice
            label="Trees"
            value={graphics.trees}
            options={[
              ['fewer', 'Fewer'],
              ['normal', 'Normal'],
              ['more', 'Dense']
            ]}
            onChange={trees => game.setGraphics({ trees })}
          />
          <Choice
            label="Ground"
            value={graphics.ground ? 'detailed' : 'plain'}
            options={[
              ['plain', 'Plain'],
              ['detailed', 'Detailed']
            ]}
            onChange={ground => game.setGraphics({ ground: ground === 'detailed' })}
          />
          <Choice
            label="Clouds"
            value={graphics.clouds}
            options={[
              ['simple', 'Simple'],
              ['full', 'Full']
            ]}
            onChange={clouds => game.setGraphics({ clouds })}
          />
          <Choice
            label="Glow"
            value={graphics.glow ? 'on' : 'off'}
            options={[
              ['off', 'Off'],
              ['on', 'On']
            ]}
            onChange={glow => game.setGraphics({ glow: glow === 'on' })}
          />
          <Choice
            label="Resolution"
            value={graphics.sharp ? 'full' : 'standard'}
            options={[
              ['standard', 'Standard'],
              ['full', 'Full']
            ]}
            onChange={sharp => game.setGraphics({ sharp: sharp === 'full' })}
          />
          <p className="text-sm leading-snug opacity-75">
            Lower settings run faster on older computers. The frame rate shows in the top bar while
            you fly.
          </p>
        </div>
      )}
    </div>
  )
}

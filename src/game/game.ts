import { useSyncExternalStore } from 'react'
import { Vector3 } from 'three'
import { type AircraftSpec, DEFAULT_AIRCRAFT, engineArms, HANGAR, KNOT } from '../sim/aircraft'
import { type CrashReason, FlightSim } from '../sim/flight-sim'
import { APPROACHES, onCentreline, pathAltitude } from '../world/approaches'
import {
  AIRPORTS,
  type Airport,
  fromStrip,
  HELIPADS,
  heightAt,
  ISLAND_GROUND,
  outside
} from '../world/island'
import { Sound } from './audio'
import { Bombs, type Impact } from './bombs'
import { findCollision } from './collision'
import { AirCombat, type CombatEvent } from './combat'
import { Effects } from './effects'
import { Gpws } from './gpws'
import { Look } from './look'
import {
  combatSetup,
  type Mission,
  type MissionResult,
  MissionRunner,
  rememberPassed
} from './missions'
import { Navigator, planRoute } from './navigation'
import { Pilot } from './pilot'
import {
  GRAPHICS_PRESETS,
  type Graphics,
  type GraphicsPreset,
  loadSettings,
  saveSettings
} from './settings'
import { Storm } from './storm'
import { Traffic } from './traffic'
import { Wreck } from './wreck'

/** `finished` means a mission ended with a pass or a fail, other than a crash. */
export type Status = 'menu' | 'flying' | 'paused' | 'crashed' | 'arrived' | 'finished'
export type CameraMode = 'chase' | 'cockpit'
export type WindLevel = 'calm' | 'light' | 'strong'
export type MapSize = 'small' | 'large' | 'hidden'
/**
 * Sky and visibility. Cloudy adds a low overcast deck, rain adds showers, fog cuts visibility,
 * and storm adds thunderstorm cells, lightning, downpours, and rough air.
 */
export type Weather = 'clear' | 'cloudy' | 'rain' | 'fog' | 'storm'
export type TimeOfDay = 'morning' | 'noon' | 'evening' | 'night'

/** Summary of a flight that ended parked at an airport. */
export type Arrival = {
  airport: Airport
  /** Seconds from the first liftoff to shutdown. */
  flightSeconds: number
  /** Descent rate at touchdown in m/s. */
  touchdownRate: number
}

export type GameState = {
  status: Status
  camera: CameraMode
  /** Looking down from the bomb bay with the aiming cross. Tab switches it on and off. */
  bombsight: boolean
  /** Photo mode: the flight holds still, the panels hide, and a free camera looks around. */
  photo: boolean
  /** The one line of photo mode help. H hides it for a clean picture. */
  photoHint: boolean
  wind: WindLevel
  muted: boolean
  /** Live landing advice on screen. */
  coach: boolean
  /** The map starts small. M enlarges it, then hides it. */
  map: MapSize
  graphics: Graphics
  weather: Weather
  time: TimeOfDay
  crash: CrashReason | null
  /** True once the crash has played out and the menu may cover it. */
  crashShown: boolean
  arrival: Arrival | null
  /** The mission being flown, or null in free flight, and how it ended. */
  mission: Mission | null
  missionResult: MissionResult | null
  /** Aircraft and airport picked in the menu. They apply on the next start. */
  selected: AircraftSpec
  departure: Airport
  /** Airport the flight plan leads to, or null to fly without one. */
  destination: Airport | null
  /** Aircraft in the world right now. */
  flown: AircraftSpec
}

/** Mean wind speed in m/s for each setting. */
export const WIND_SPEEDS: Record<WindLevel, number> = { calm: 0, light: 4, strong: 9 }
/** Direction the wind blows from, in degrees clockwise from north. */
export const WIND_FROM = 60

// A bomb's blast throws debris straight up and out, carried by nothing
// Holding Enter over a city drops a string of bombs: the first repeat after this many
// seconds, then one every gap
const RIPPLE_START = 0.6
// An explosion that carries no motion of its own
const STILL = new Vector3()
const RIPPLE_GAP = 0.7
// Burning ruins shown at once, newest first, so a flattened city stays within the smoke budget
const BURNING_RUINS = 20
// Seconds the bombsight stays on after the last bomb, to watch its blast
const SIGHT_LINGER = 2.5
const spot = new Vector3()
// Longest physics step in seconds. Longer frames are split into several steps.
const MAX_STEP = 1 / 120
// Seconds between puffs of a rescue boat's distress smoke
const DISTRESS_GAP = 0.25
// Seconds the crash plays before the menu appears
const CRASH_REPLAY = 3
// Seconds a won bombing mission flies on, so the last explosion shows before the menu
const BLAST_REPLAY = 4
// A flight counts once the aircraft has climbed this high, in metres
const AIRBORNE_HEIGHT = 30

/** True when an aircraft can use an airport's main runway. */
export const canUse = (spec: AircraftSpec, airport: Airport) =>
  airport.runways[0].length >= spec.runwayNeeded

const spotsBySpec = new WeakMap<AircraftSpec, Vector3[]>()

/** The back of each engine in body axes, numbered from the left wing, where a fire burns. */
function engineSpots(spec: AircraftSpec) {
  const known = spotsBySpec.get(spec)
  if (known) return known
  const { shape } = spec
  let spots = engineArms(spec).map(x => new Vector3(x, 0, 0))
  if (shape.type === 'airliner') {
    const right = [...shape.engines].sort((a, b) => a[0] - b[0])
    const back = (x: number, z: number) => new Vector3(x, shape.engineY, z + shape.engineLength)
    spots = [...right.map(([x, z]) => back(-x, z)).reverse(), ...right.map(([x, z]) => back(x, z))]
  } else if (shape.type === 'helicopter') {
    // The exhausts behind the two engines on the roof
    spots = [new Vector3(-1.17, 1.2, 1.75), new Vector3(1.17, 1.2, 1.75)]
  }
  spotsBySpec.set(spec, spots)
  return spots
}

/** Owns the simulation, the pilot's controls, and the menu state. */
class Game {
  readonly sim = new FlightSim(ISLAND_GROUND, DEFAULT_AIRCRAFT)
  readonly pilot = new Pilot()
  readonly nav = new Navigator()
  readonly missions = new MissionRunner()
  /** Ground proximity warnings, spoken unless the sound is off. */
  readonly gpws = new Gpws((phrase, urgent) => {
    if (!this.state.muted && this.state.status === 'flying') this.sound.say(phrase, urgent)
  })
  /** Current air mass velocity in m/s, including gusts. */
  readonly wind = new Vector3()
  /** Thunderstorm air, windshear alert, and lightning. */
  readonly storm = new Storm()
  /** Seconds the boats, balloons, birds, and other aircraft have been moving. It stops while paused. */
  sceneryTime = 0
  /** Rendered frames per second, smoothed. */
  frameRate = 60
  readonly effects = new Effects()
  readonly wreck = new Wreck()
  readonly traffic = new Traffic()
  /** The B-2's bomb bay on bombing missions; empty otherwise. */
  readonly bombs = new Bombs()
  readonly combat = new AirCombat()
  /** Where the player has turned the view with the mouse. */
  readonly look = new Look()
  // A won bombing mission waiting for its last explosion to play out
  private won: { result: MissionResult; left: number } | null = null
  private readonly lastBlast = new Vector3()
  // Seconds since a ditching, for the spray it throws up
  private sprayClock = 0
  // Enter held down in the bombsight, and seconds until the next bomb of the string
  private rippleHeld = false
  /** Seconds until the next puff of a rescue boat's distress smoke. */
  private distressTimer = 0
  private rippleClock = 0

  // Settings come back as the player left them
  private state: GameState = {
    status: 'menu',
    bombsight: false,
    photo: false,
    photoHint: true,
    ...savedState(),
    crash: null,
    crashShown: false,
    arrival: null,
    mission: null,
    missionResult: null
  }
  private time = 0
  /** Free flight settings, kept while a mission overrides them. */
  private freeFlight: Pick<
    GameState,
    'selected' | 'departure' | 'destination' | 'weather' | 'time' | 'wind'
  > | null = null
  private liftoffTime: number | null = null
  private sinkRate = 0
  private touchdownRate = 0
  private readonly sound = new Sound()
  private readonly stateListeners = new Set<() => void>()
  private readonly frameListeners = new Set<() => void>()

  constructor() {
    this.placeAtStand()
  }

  getState = () => this.state

  /** True once the aircraft has left the ground on this flight. */
  get hasFlown() {
    return this.liftoffTime !== null
  }

  /** The point the camera and the sun's shadow follow: the aircraft, or its wreckage. */
  get focus() {
    return this.wreck.active ? this.wreck.pieces[0].position : this.sim.position
  }

  subscribe = (listener: () => void) => {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Runs `listener` after every simulation frame. Returns a function that removes it. */
  onFrame(listener: () => void) {
    this.frameListeners.add(listener)
    return () => {
      this.frameListeners.delete(listener)
    }
  }

  /** Picks the aircraft for the next flight. On the start screen it rolls out straight away. */
  selectAircraft = (id: string) => {
    const selected = HANGAR.find(spec => spec.id === id)
    if (!selected) return
    // An airliner cannot leave from a short strip, so fall back to the first airport that fits
    const departure = canUse(selected, this.state.departure)
      ? this.state.departure
      : (AIRPORTS.find(airport => canUse(selected, airport)) ?? AIRPORTS[0])
    // A destination the new aircraft cannot land at is dropped
    const { destination } = this.state
    const keep = destination && destination !== departure && canUse(selected, destination)
    this.change({ selected, departure, destination: keep ? destination : null })
    if (this.state.status === 'menu') this.placeAtStand()
  }

  /** Picks the airport the next flight starts from. */
  selectDeparture = (name: string) => {
    const departure = AIRPORTS.find(airport => airport.name === name)
    if (!departure || !canUse(this.state.selected, departure)) return
    const destination = this.state.destination === departure ? null : this.state.destination
    this.change({ departure, destination })
    if (this.state.status === 'menu') this.placeAtStand()
  }

  /** Picks the airport the flight plan leads to, or none. It applies on the next start. */
  selectDestination = (name: string | null) => {
    const destination = AIRPORTS.find(airport => airport.name === name) ?? null
    this.change({ destination })
  }

  /** Starts cold at the terminal gate for an airliner, or in front of the hangars otherwise. */
  startAtStand = () => {
    this.leaveMission()
    this.beginAtStand()
  }

  /** Starts lined up at the end of the departure airport's main runway, engines off. */
  startOnRunway = () => {
    this.leaveMission()
    this.beginOnRunway()
  }

  /** Starts in level flight, about 100 seconds out on the approach to the main runway. */
  startInAir = () => {
    this.leaveMission()
    this.beginInAir()
  }

  /**
   * Starts a mission: its aircraft, weather, and starting point, keeping the free flight
   * settings to restore afterwards.
   */
  startMission = (mission: Mission) => {
    const spec = HANGAR.find(candidate => candidate.id === mission.aircraft)
    if (!spec) return
    if (!this.state.mission) {
      const { selected, departure, destination, weather, time, wind } = this.state
      this.freeFlight = { selected, departure, destination, weather, time, wind }
    }
    const { start } = mission
    const code = start.kind === 'stand' || start.kind === 'runway' ? start.airport : null
    this.setState({
      mission,
      missionResult: null,
      selected: spec,
      departure: AIRPORTS.find(airport => airport.code === code) ?? this.state.departure,
      destination: AIRPORTS.find(airport => airport.code === mission.destination) ?? null,
      weather: mission.weather ?? 'clear',
      time: mission.time ?? 'noon',
      wind: mission.wind ?? 'calm'
    })
    if (start.kind === 'stand' || start.kind === 'runway') {
      if (start.kind === 'stand') this.beginAtStand()
      else this.beginOnRunway()
    } else if ('speed' in start) {
      this.changeAircraft()
      const knots = start.speed * KNOT
      const fixedGear = !spec.retractableGear
      if (start.kind === 'air') {
        const heading = (start.heading * Math.PI) / 180
        this.sim.placeInAir(start.x, start.altitude, start.z, heading, knots)
        this.pilot.resetForAir(spec, this.sim)
        this.settle(((start.glide ?? 0) * Math.PI) / 180, 0, fixedGear)
        this.pilot.controls.speedBrake = start.speedBrake ?? false
      } else {
        const approach = APPROACHES.find(candidate => candidate.id === start.approach)
        if (!approach) return
        const { x, z } = onCentreline(approach.end, start.distance)
        const altitude = pathAltitude(approach.end, approach.glide, start.distance)
        this.sim.placeInAir(x, altitude, z, (approach.end.heading * Math.PI) / 180, knots)
        this.pilot.resetForAir(spec, this.sim)
        const glide = start.level ? 0 : approach.glide
        this.settle(glide, start.flapNotch ?? 0, start.gearDown ?? fixedGear)
      }
      this.fly()
    }
    const approach = APPROACHES.find(candidate => candidate.id === mission.approach)
    if (approach) this.nav.select(approach, this.sim)
    this.missions.start(mission, this.sim)
    this.won = null
    // Missiles go to air combat when there are enemy aircraft, otherwise to ground targets
    const fight = combatSetup(mission)
    if (fight) this.combat.load(fight)
    else this.combat.clear()
    this.bombs.load(
      mission.bombs ?? 0,
      mission.targets ?? [],
      mission.guided,
      fight ? 0 : (mission.missiles ?? 0)
    )
  }

  /** Flies the current mission again from the start. */
  retryMission = () => {
    if (this.state.mission) this.startMission(this.state.mission)
  }

  /** Ends any mission and puts the free flight settings back. */
  leaveMission = () => {
    if (!this.state.mission) return
    this.missions.stop()
    this.setState({ mission: null, missionResult: null, ...this.freeFlight })
    this.freeFlight = null
    if (this.state.status !== 'flying') this.openMenu()
  }

  private beginAtStand() {
    this.placeAtStand()
    this.fly()
    this.loadPlan()
  }

  private beginOnRunway() {
    this.changeAircraft()
    const runway = this.state.departure.runways[0]
    const start = fromStrip(runway, -runway.length / 2 + 150, 0)
    this.sim.placeOnGround(start.x, start.z, (runway.heading * Math.PI) / 180)
    this.pilot.resetForGround(this.sim, false)
    this.fly()
    this.loadPlan()
  }

  private beginInAir() {
    const spec = this.changeAircraft()
    const airport = this.state.departure
    const runway = airport.runways[0]
    const distance = spec.cruiseSpeed * 100
    const start = fromStrip(runway, -runway.length / 2 - distance, 0)
    // On the glide path when the runway has an approach, its course already tuned in.
    // Otherwise 300 m above the highest ground between the start and the runway.
    const approach = APPROACHES.find(
      candidate => candidate.end.runway === runway && candidate.end.sense === 1
    )
    let altitude = 0
    if (approach) altitude = pathAltitude(approach.end, approach.glide, distance)
    else {
      let ridge = 0
      for (let along = 0; along <= distance; along += 100) {
        const spot = fromStrip(runway, -runway.length / 2 - along, 0)
        ridge = Math.max(ridge, heightAt(spot.x, spot.z))
      }
      altitude = Math.max(airport.elevation + spec.cruiseSpeed * 9, ridge + 300)
    }
    this.sim.placeInAir(
      start.x,
      altitude,
      start.z,
      (runway.heading * Math.PI) / 180,
      spec.cruiseSpeed
    )
    this.pilot.resetForAir(spec, this.sim)
    this.settle(0, 0, !spec.retractableGear)
    this.fly()
    this.nav.select(approach ?? null, this.sim)
    const { destination } = this.state
    if (destination && destination !== airport) {
      const here = this.sim.position
      this.nav.load(
        planRoute(
          { x: here.x, z: here.z, heading: this.sim.heading },
          destination,
          spec,
          WIND_FROM
        ),
        this.sim
      )
    }
  }

  /** Plans the route from the departure's main runway to the destination, if one is picked. */
  private loadPlan() {
    const { departure, destination, selected } = this.state
    if (!destination || destination === departure) return
    const runway = departure.runways[0]
    const liftOff = fromStrip(runway, runway.length / 2, 0)
    const heading = (runway.heading * Math.PI) / 180
    this.nav.load(planRoute({ ...liftOff, heading }, destination, selected, WIND_FROM), this.sim)
  }

  pause = () => {
    // Photo mode already holds the flight still, so leaving the window keeps the shot
    if (this.state.status !== 'flying' || this.state.photo) return
    this.pilot.releaseAll()
    this.setState({ status: 'paused' })
  }

  /** Opens photo mode while flying, or closes it. The flight holds still while it is open. */
  togglePhoto = () => {
    if (this.state.photo) {
      this.setState({ photo: false })
      return
    }
    if (this.state.status !== 'flying') return
    this.pilot.releaseAll()
    this.rippleHeld = false
    this.setState({ photo: true, photoHint: true })
  }

  resume = () => {
    if (this.state.status === 'paused') this.setState({ status: 'flying' })
  }

  /** Ends a paused free flight and opens the main menu, to pick another aircraft or a mission. */
  backToMenu = () => {
    if (this.state.status === 'paused' && !this.state.mission) this.openMenu()
  }

  /** Parks the picked aircraft cold at its stand behind the main menu, with no route or targets. */
  private openMenu() {
    this.placeAtStand()
    this.liftoffTime = null
    this.nav.load(null, this.sim)
    this.combat.clear()
    this.bombs.load(0, [])
    this.setState({ status: 'menu', bombsight: false })
  }

  setWind = (wind: WindLevel) => this.change({ wind })
  setWeather = (weather: Weather) => this.change({ weather })
  setTime = (time: TimeOfDay) => this.change({ time })
  toggleMuted = () => this.change({ muted: !this.state.muted })
  setCoach = (on: boolean) => this.change({ coach: on })
  /** Enters or leaves the bombsight. It only opens with bombs aboard. */
  toggleBombsight = () => {
    const { bombs } = this
    const open = this.state.bombsight
    if (!open && bombs.loaded === 0 && bombs.falling.length === 0) return
    this.rippleHeld = false
    this.setState({ bombsight: !open })
  }

  /** Switches between the chase and cockpit views, each starting out looking ahead. */
  toggleCamera = () => {
    this.look.reset()
    this.change({ camera: this.state.camera === 'chase' ? 'cockpit' : 'chase' })
  }
  toggleMap = () => {
    const next = { small: 'large', large: 'hidden', hidden: 'small' } as const
    this.change({ map: next[this.state.map] })
  }

  /** Picks a graphics preset, which sets every graphics choice at once. */
  setGraphicsPreset = (preset: Exclude<GraphicsPreset, 'custom'>) =>
    this.change({ graphics: GRAPHICS_PRESETS[preset] })

  /** Changes one graphics choice by hand, which leaves the presets for Custom. */
  setGraphics = (choice: Partial<Omit<Graphics, 'preset'>>) =>
    this.change({ graphics: { ...this.state.graphics, ...choice, preset: 'custom' } })

  /** Applies a change the player made, and remembers it for the next visit. */
  private change(patch: Partial<GameState>) {
    this.setState(patch)
    // During a mission, the free flight choices it set aside are the ones to keep
    const free = { ...this.state, ...this.freeFlight }
    saveSettings({
      wind: free.wind,
      weather: free.weather,
      time: free.time,
      muted: this.state.muted,
      coach: this.state.coach,
      map: this.state.map,
      camera: this.state.camera,
      graphics: this.state.graphics,
      aircraft: free.selected.id,
      departure: free.departure.code,
      destination: free.destination?.code ?? null
    })
  }

  /** Advances the game by one rendered frame of `delta` seconds. */
  frame(delta: number) {
    const dt = Math.min(delta, 0.1)
    // Photo mode holds the whole world still, as a pause does
    const status = this.state.photo ? 'paused' : this.state.status
    if (delta > 0) this.frameRate += (1 / delta - this.frameRate) * 0.05
    if (status !== 'paused') {
      this.sceneryTime += dt
      this.traffic.update(this.sceneryTime)
    }
    if (status === 'flying') {
      this.nav.update(this.sim)
      this.pilot.update(dt, this.sim, this.nav)
      const steps = Math.ceil(dt / MAX_STEP)
      const step = dt / steps
      for (let i = 0; i < steps; i++) {
        this.time += step
        this.updateWind(step)
        this.sim.step(step, this.pilot.controls, this.wind)
        // Trees, buildings, balloons, boats, and other aircraft are solid
        this.sim.crash ??= findCollision(this.sim, this.sceneryTime, this.traffic, this.bombs.ruins)
        if (this.sim.crash) break
      }
      if (this.sim.crash) this.breakUp(this.sim.crash)
      else {
        this.gpws.windshear = this.storm.detectShear(dt, this.sim)
        if (this.state.weather === 'storm') {
          this.effects.shake = Math.max(this.effects.shake, this.storm.jolt(dt, this.sim))
        }
        this.gpws.update(dt, this.sim, this.pilot.controls, this.nav)
        if (this.effects.emitFlight(dt, this.sim, ISLAND_GROUND)) this.sound.chirp()
        this.burnEngines(dt)
        this.trackFlight()
        this.dropString(dt)
        for (const impact of this.bombs.update(dt, this.sim, ISLAND_GROUND)) this.blast(impact)
        for (const event of this.combat.update(dt, this.sim, ISLAND_GROUND, this.effects)) {
          this.onCombat(event)
        }
        this.burnTargets(dt)
        this.checkMission(dt)
        this.signalDistress(dt)
      }
    } else if (status === 'crashed') {
      this.wreck.step(dt, ISLAND_GROUND, this.effects)
      if (!this.state.crashShown && this.wreck.time > CRASH_REPLAY) {
        this.setState({ crashShown: true })
      }
    }
    if (status === 'flying' || status === 'crashed') this.effects.update(dt, this.wind)
    const audible = !this.state.muted && (status === 'flying' || status === 'crashed')
    if (status !== 'paused') {
      const strike = this.storm.lightning.update(dt, this.state.weather === 'storm', this.focus)
      if (strike !== null && audible) this.sound.thunder(strike)
    }
    this.sound.update(this.sim, audible ? status : 'silent')
    for (const listener of this.frameListeners) listener()
  }

  /** Starts listening to the keyboard. Returns a function that stops listening. */
  attach() {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const { status } = this.state
      // Photo mode takes the keyboard: the free camera reads its own keys, the pilot gets none
      if (this.state.photo) {
        if (event.code === 'Tab' || event.code === 'Space') event.preventDefault()
        if (event.repeat) return
        if (event.code === 'Backquote' || event.code === 'Escape') this.togglePhoto()
        else if (event.code === 'KeyH') this.setState({ photoHint: !this.state.photoHint })
        return
      }
      if (event.code === 'Backquote' && status === 'flying' && !event.repeat) {
        this.togglePhoto()
        return
      }
      if (event.code === 'Escape') {
        if (status === 'flying') this.pause()
        else this.resume()
        return
      }
      // A focused button or list already reacts to Enter
      const widget =
        event.target instanceof HTMLButtonElement || event.target instanceof HTMLSelectElement
      // Tab opens and closes the bombsight, so the browser must not move the focus
      if (event.code === 'Tab' && status === 'flying') {
        event.preventDefault()
        if (!event.repeat) this.toggleBombsight()
        return
      }
      // Enter releases a bomb in the bombsight, and starts or resumes from the menus
      if (event.code === 'Enter' && status === 'flying') {
        event.preventDefault()
        if (event.repeat) return
        if (this.combat.active) {
          this.combat.fire(this.sim)
          return
        }
        // Missiles fire straight from the normal view, with no sight to open
        if (this.bombs.missiles > 0) {
          this.bombs.fire(this.sim)
          return
        }
        if (!this.state.bombsight) return
        this.bombs.release(this.sim)
        this.rippleHeld = true
        this.rippleClock = RIPPLE_START
        return
      }
      if (event.code === 'Enter' && !widget) {
        if (status === 'paused') this.resume()
        else if (this.state.mission && status !== 'flying') this.retryMission()
        else if (status !== 'flying') this.startAtStand()
        return
      }
      if (status !== 'flying') return
      // In the air in a fight, Space drops flares; on the ground it still works the brakes
      const fighting = this.combat.active && !this.sim.onGround
      if (event.code === 'Space' && fighting && !event.repeat) this.combat.dropFlares(this.sim)
      if (event.code === 'KeyC' && !event.repeat) this.toggleCamera()
      else if (event.code === 'KeyM' && !event.repeat) this.toggleMap()
      else if (event.code === 'Slash') {
        // Firefox opens its quick find on this key unless the page takes it
        event.preventDefault()
        if (!event.repeat) this.look.toggleRunway()
      } else if (event.code === 'KeyN' && !event.repeat) {
        if (event.shiftKey) this.nav.select(null, this.sim)
        else this.nav.cycle(this.sim, WIND_FROM)
        this.pilot.flyApproach(false, this.sim, this.nav)
      } else if (event.code === 'KeyT' && !event.repeat) {
        // With nothing picked yet, take the best approach at the nearest airport
        if (!this.nav.approach) this.nav.cycle(this.sim, WIND_FROM)
        this.pilot.flyApproach(!this.pilot.flyingApproach, this.sim, this.nav)
      } else if (this.pilot.press(event.code, event.repeat, this.sim, this.nav, event.shiftKey)) {
        event.preventDefault()
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Enter') this.rippleHeld = false
      this.pilot.release(event.code)
    }
    const onBlur = () => this.pause()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }

  /** Orange smoke rises from a rescue mission's boat until its last survivor is aboard. */
  private signalDistress(dt: number) {
    const rescue = this.state.mission?.rescue
    if (!rescue || this.missions.aboard >= rescue.survivors) return
    this.distressTimer -= dt
    if (this.distressTimer > 0) return
    this.distressTimer = DISTRESS_GAP
    this.effects.distressSmoke(spot.set(rescue.x, 1.5, rescue.z))
  }

  /** Advances the mission's objectives, and ends the flight once it passes or fails. */
  private checkMission(dt: number) {
    if (this.won) {
      this.won.left -= dt
      if (this.won.left <= 0) this.finishMission(this.won.result)
      return
    }
    const result = this.missions.update(dt, {
      sim: this.sim,
      controls: this.pilot.controls,
      pilot: this.pilot,
      nav: this.nav,
      parkedAt: this.parkedAirport(),
      bombs: this.bombs,
      bombsight: this.state.bombsight,
      combat: this.combat
    })
    if (!result) return
    // A fight won in the air circles the last blast; one that ends with a landing does not
    const fought = this.bombs.targets.length > 0 || this.combat.active
    if (result.passed && fought && !this.sim.onGround) {
      this.won = { result, left: BLAST_REPLAY }
      return
    }
    this.finishMission(result)
  }

  private finishMission(result: MissionResult) {
    this.won = null
    const { mission } = this.state
    if (result.passed && mission) rememberPassed(mission.id)
    this.pilot.releaseAll()
    this.gpws.alert = null
    this.setState({ status: 'finished', missionResult: result })
  }

  /** Where the winning bomb landed, while the view circles its blast before the results. */
  get blastReplay() {
    return this.won ? this.lastBlast : null
  }

  /**
   * Air combat outcomes: an enemy or the escort blown apart in the air, a wreck striking the
   * ground, the escort's bombs going off, a missile hitting the player, which ends the
   * flight, or the ground crew finishing a rearm.
   */
  private onCombat(event: CombatEvent) {
    if (event.kind === 'hit') {
      this.sim.crash ??= 'missile'
      return
    }
    if (event.kind === 'launch') return
    if (event.kind === 'rearmed') {
      if (!this.state.muted) this.sound.chirp()
      return
    }
    if (event.kind === 'escort-bombs') {
      // A string of bombs across the target, along the escort's track
      const track = this.combat.escort?.velocity ?? STILL
      const along = Math.atan2(track.x, -track.z)
      for (let i = -3; i <= 3; i++) {
        const x = event.at.x + Math.sin(along) * i * 90
        const z = event.at.z - Math.cos(along) * i * 90
        const y = Math.max(ISLAND_GROUND.heightAt(x, z), 0)
        this.blast({ at: new Vector3(x, y, z), water: y <= 0, hit: null, miss: 0, fell: 0 })
      }
      this.lastBlast.copy(event.at)
      return
    }
    const distance = event.at.distanceTo(this.sim.position)
    const water = event.kind === 'wreck' && ISLAND_GROUND.heightAt(event.at.x, event.at.z) < 0
    if (water) this.effects.splash(event.at, 2)
    else {
      const power = event.kind === 'escort-hit' ? 1 : event.kind === 'wreck' ? 1.2 : 1.8
      this.effects.explode(event.at, STILL, power, event.kind === 'wreck')
    }
    if (event.kind === 'kill' || event.kind === 'escort-down') this.lastBlast.copy(event.at)
    if (!this.state.muted)
      this.sound.crash(Math.max(0.15, Math.min(1, 1.1 - distance / 5000)), water)
  }

  /**
   * A bomb going off: a fireball and debris on land, spray at sea. The sound and the shake
   * fade with distance, so a blast far below rumbles rather than rattles.
   */
  private blast(impact: Impact) {
    this.lastBlast.copy(impact.at)
    const distance = impact.at.distanceTo(this.sim.position)
    const shake = this.effects.shake
    if (impact.water) this.effects.splash(impact.at, 3)
    else this.effects.bombBlast(impact.at)
    this.effects.shake = Math.max(shake, 0.9 * Math.max(0, 1 - distance / 3000))
    if (!this.state.muted)
      this.sound.crash(Math.max(0.15, Math.min(1, 1.2 - distance / 6000)), impact.water)
  }

  /**
   * Holding Enter in the bombsight over a city drops a string of bombs. Missions with
   * targets keep one bomb per press, so a held key never spoils an armed release.
   */
  private dropString(dt: number) {
    const { bombs } = this
    if (this.state.bombsight && bombs.loaded === 0 && bombs.falling.length === 0) {
      if (bombs.sinceImpact > SIGHT_LINGER) this.setState({ bombsight: false })
    }
    if (!this.rippleHeld || !this.state.bombsight || bombs.targets.length > 0) return
    this.rippleClock -= dt
    if (this.rippleClock > 0) return
    bombs.drop(this.sim)
    this.rippleClock = RIPPLE_GAP
  }

  /**
   * Flames and smoke from each burning engine, sparks under a belly landing, and spray while
   * a ditched aircraft slides to a stop on the sea.
   */
  private burnEngines(dt: number) {
    const { sim } = this
    const spots = engineSpots(sim.spec)
    for (const missile of this.bombs.flying) this.effects.missileTrail(missile.position, dt)
    sim.engines.forEach((engine, i) => {
      if (!engine.fire) return
      spot
        .copy(spots[i] ?? spots[0])
        .applyQuaternion(sim.orientation)
        .add(sim.position)
      this.effects.engineFire(spot, dt)
    })
    // Sparks and dust from a belly sliding along the ground
    if (sim.bellied && sim.groundSpeed > 1) {
      const { x, z } = sim.position
      spot.set(x, ISLAND_GROUND.heightAt(x, z), z)
      this.effects.scrape(spot, sim.velocity, dt)
      this.effects.shake = Math.max(this.effects.shake, Math.min(0.25, sim.groundSpeed / 250))
    }
    if (!sim.ditched) {
      this.sprayClock = 0
      return
    }
    // The first touch throws up a big sheet of spray, then less as the aircraft slows
    if (this.sprayClock === 0) this.effects.splash(sim.position, 2.5)
    this.sprayClock += dt
    if (sim.groundSpeed > 4 && this.sprayClock % 0.2 < dt) {
      this.effects.splash(sim.position, Math.min(0.6, sim.groundSpeed / 80))
    }
  }

  /** Destroyed targets and the newest ruins burn, then smoulder, for the rest of the flight. */
  private burnTargets(dt: number) {
    const { bombs } = this
    bombs.targets.forEach((target, i) => {
      if (!bombs.destroyed[i]) return
      spot.set(target.x, ISLAND_GROUND.heightAt(target.x, target.z), target.z)
      this.effects.burn(spot, 1, dt)
    })
    const { craters } = bombs.ruins
    for (let i = craters.length - 1, shown = 0; i >= 0 && shown < BURNING_RUINS; i--) {
      const crater = craters[i]
      if (crater.fell === 0) continue
      shown++
      spot.set(crater.x, ISLAND_GROUND.heightAt(crater.x, crater.z), crater.z)
      this.effects.burn(spot, 1.4, dt)
    }
  }

  /** The airport whose apron the aircraft is parked on, brake set and engines off. */
  private parkedAirport() {
    const { sim } = this
    if (!sim.onGround || sim.groundSpeed > 0.3) return null
    if (!this.pilot.controls.parkingBrake || sim.enginesRunning > 0) return null
    const { x, z } = sim.position
    return (
      AIRPORTS.find(candidate => candidate.aprons.some(apron => outside(apron, x, z) === 0)) ?? null
    )
  }

  /**
   * Notes the liftoff and the touchdown, and ends the flight once the aircraft is
   * parked on an apron with the parking brake set and the engines stopped.
   */
  private trackFlight() {
    const { sim } = this
    if (!sim.onGround) {
      this.sinkRate = -sim.verticalSpeed
      if (this.liftoffTime === null && sim.altitudeAgl > AIRBORNE_HEIGHT)
        this.liftoffTime = this.time
      return
    }
    if (this.sinkRate > 0) {
      this.touchdownRate = this.sinkRate
      this.sinkRate = 0
    }
    // Missions decide for themselves when parking ends the flight
    if (this.liftoffTime === null || this.state.mission) return
    const airport = this.parkedAirport()
    if (!airport) return
    this.setState({
      status: 'arrived',
      arrival: {
        airport,
        flightSeconds: this.time - this.liftoffTime,
        touchdownRate: this.touchdownRate
      }
    })
  }

  /** Swaps the world's aircraft for the selected one and clears any wreckage. */
  private changeAircraft() {
    const spec = this.state.selected
    this.wreck.reset()
    this.effects.clear()
    this.sim.setAircraft(spec)
    if (this.state.flown !== spec) this.setState({ flown: spec })
    return spec
  }

  private placeAtStand() {
    const spec = this.changeAircraft()
    const airport = this.state.departure
    // Airliners park at the terminal, helicopters on the helipad, and everything else in
    // front of the hangars
    const stands = spec.shape.type === 'airliner' ? airport.gates : airport.ramps
    const pad = HELIPADS.find(candidate => candidate.airport === airport.code)
    const stand =
      spec.rotor && pad
        ? { x: pad.x, z: pad.z, heading: (pad.heading * Math.PI) / 180 }
        : stands[Math.floor(stands.length / 2)]
    this.sim.placeOnGround(stand.x, stand.z, stand.heading)
    // At the stand everything starts cold and dark
    this.pilot.resetForGround(this.sim, true)
  }

  private fly() {
    // Bombers carry a load in free flight too. A mission loads its own after this.
    this.bombs.load(this.sim.spec.bombBay ?? 0, [])
    this.combat.clear()
    this.rippleHeld = false
    this.pilot.releaseAll()
    this.look.reset()
    this.gpws.reset(this.sim)
    this.storm.reset()
    this.nav.load(null, this.sim)
    this.sound.start()
    this.liftoffTime = null
    this.sinkRate = 0
    this.touchdownRate = 0
    this.setState({
      status: 'flying',
      bombsight: false,
      crash: null,
      crashShown: false,
      arrival: null
    })
  }

  /** Ends the flight: the aircraft breaks apart with a blast on land or a splash at sea. */
  private breakUp(reason: CrashReason) {
    this.pilot.releaseAll()
    this.gpws.alert = null
    this.wreck.start(this.sim, reason, ISLAND_GROUND, this.effects)
    this.sound.crash(Math.min(1, Math.max(0.5, this.effects.shake)), reason === 'water')
    this.setState({ status: 'crashed', crash: reason, crashShown: false })
  }

  /**
   * Trims an aircraft just placed in the air for a steady descent `glide` radians down, or
   * level flight at 0, so it flies on by itself until the pilot takes over.
   */
  private settle(glide: number, flapNotch: number, gearDown: boolean) {
    this.updateWind()
    const hold = this.sim.settleOnPath(glide, flapNotch, gearDown, this.wind)
    Object.assign(this.pilot.controls, { flapNotch, gearDown, ...hold })
  }

  /**
   * Steady wind with gusts and small, slow direction swings. Storm weather and a mission's
   * microburst add their own air, with random gusts advanced by `dt` seconds.
   */
  private updateWind(dt = 0) {
    const speed = WIND_SPEEDS[this.state.wind]
    const t = this.time
    // Gusts come every few seconds, well away from the slow 15 to 35 second swing in speed
    // and height that a disturbed aircraft settles with, so they never build it up
    const gust = 1 + 0.2 * Math.sin(t * 0.83) + 0.12 * Math.sin(t * 1.9 + 1.7)
    const toward =
      ((WIND_FROM + 180) * Math.PI) / 180 +
      0.15 * Math.sin(t * 0.23 + 0.5) +
      0.08 * Math.sin(t * 0.9)
    this.wind.set(
      Math.sin(toward) * speed * gust,
      speed * 0.06 * Math.sin(t * 1.9 + 0.3),
      -Math.cos(toward) * speed * gust
    )
    // Outside a storm with no microburst this adds nothing, and clears the windshear input
    const { weather, mission } = this.state
    this.storm.addWind(dt, this.sim, weather === 'storm', mission?.microburst ?? null, this.wind)
  }

  private setState(patch: Partial<GameState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.stateListeners) listener()
  }
}

/** The settings saved on the last visit, with the aircraft and airports looked up. */
function savedState() {
  const saved = loadSettings()
  const selected = HANGAR.find(spec => spec.id === saved.aircraft) ?? DEFAULT_AIRCRAFT
  const byCode = (code: string | null) => AIRPORTS.find(airport => airport.code === code)
  const stored = byCode(saved.departure)
  const departure =
    stored && canUse(selected, stored)
      ? stored
      : (AIRPORTS.find(airport => canUse(selected, airport)) ?? AIRPORTS[0])
  const target = byCode(saved.destination)
  const destination = target && target !== departure && canUse(selected, target) ? target : null
  return {
    camera: saved.camera,
    wind: saved.wind,
    muted: saved.muted,
    coach: saved.coach,
    map: saved.map,
    graphics: saved.graphics,
    weather: saved.weather,
    time: saved.time,
    selected,
    departure,
    destination,
    flown: selected
  }
}

export const game = new Game()

/** Subscribes a component to one piece of menu state. */
export function useGame<T>(select: (state: GameState) => T) {
  return useSyncExternalStore(game.subscribe, () => select(game.getState()))
}

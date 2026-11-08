/**
 * The workbench's pipeline chart: one station for each stage of the workflow, with the work in it and the light that
 * says how it reads, and the flow between the stations.
 */
import { Fragment, type ReactNode } from 'react'

/** How a station reads: work in motion, work waiting for a person, work that ended, or nothing there. */
export type StationTone = 'active' | 'waiting' | 'done' | 'idle'
/** One station of the pipeline: a stage of the workflow, the number of items in it, and what that number measures. */
export interface PipelineStation {
  /** The stage, which names the station. */
  id: string
  /** The stage's name, in the language of the panel. */
  label: string
  /** The number of items in the stage. */
  count: number
  /** What the count measures: the kind of item, so two stations are never read as the same thing. */
  unit: string
  /** The window the count covers. */
  window: string
  /** How the station reads. */
  tone: StationTone
  /** Opens the list of the stage; a station without one is static. */
  onOpen?: () => void
}

/** The body of one station: its light and name, its count, what the count measures, and the window it covers. */
function StationBody({ station }: { station: PipelineStation }) {
  return <>
    <span className="dt-station-head">
      <span className="dt-station-light" data-tone={station.tone} aria-hidden="true" />
      <span className="dt-station-label">{station.label}</span>
    </span>
    <span className="dt-station-count">{station.count}</span>
    <span className="dt-station-unit">{station.unit}</span>
    <span className="dt-station-window">{station.window}</span>
  </>
}

/**
 * Draws the pipeline in the order work passes it. The dots between the stations travel only while processing runs and
 * the station before them holds work, so a paused pipeline stands still.
 */
export function PipelineChart({ stations, flowing }: { stations: PipelineStation[]; flowing: boolean }) {
  return <div className="dt-pipe" data-flow={flowing || undefined}>
    {stations.map((station, index) => {
      const body: ReactNode = <StationBody station={station} />
      return <Fragment key={station.id}>
        {index > 0 && <span className="dt-pipe-link" aria-hidden="true" data-live={flowing && stations[index - 1]!.count > 0
          || undefined}><i className="dt-pipe-dot" /></span>}
        {station.onOpen
          ? <button type="button" className="dt-station dt-station-open" data-tone={station.tone} onClick={station.onOpen}>{body}</button>
          : <div className="dt-station" data-tone={station.tone}>{body}</div>}
      </Fragment>
    })}
  </div>
}

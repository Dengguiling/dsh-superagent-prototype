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
  /** The one line under the count that says what the count measures. */
  note: string
  /** How the station reads. */
  tone: StationTone
  /** Opens the list of the stage; a station without one is static. */
  onOpen?: () => void
}

/** Percent width of a station's bar: its count against the largest count of the pipeline, so that the stations compare. */
function share(stations: PipelineStation[]): (station: PipelineStation) => string {
  const most = Math.max(1, ...stations.map(station => station.count))
  return station => `${Math.round(station.count / most * 100)}%`
}
/** The body of one station: its light and name, its count, what the count measures, and its bar. */
function StationBody({ station, width }: { station: PipelineStation; width: string }) {
  return <>
    <span className="dt-station-head">
      <span className="dt-station-light" data-tone={station.tone} aria-hidden="true" />
      <span className="dt-station-label">{station.label}</span>
    </span>
    <span className="dt-station-count">{station.count}</span>
    <span className="dt-station-note">{station.note}</span>
    <span className="dt-station-bar" aria-hidden="true"><span className="dt-station-fill" data-tone={station.tone}
      style={{ width }} /></span>
  </>
}

/**
 * Draws the pipeline in the order work passes it. The dots between the stations travel only while processing runs and
 * the station before them holds work, so a paused pipeline stands still.
 */
export function PipelineChart({ stations, flowing }: { stations: PipelineStation[]; flowing: boolean }) {
  const width = share(stations)
  return <div className="dt-pipe" data-flow={flowing || undefined}>
    {stations.map((station, index) => {
      const body: ReactNode = <StationBody station={station} width={width(station)} />
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

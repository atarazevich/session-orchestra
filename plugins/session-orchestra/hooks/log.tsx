import type { ClientModule, JsonValue } from 'claude-code'

// The message list, drawn on the surface itself so a click anywhere on a row
// picks it and the hover tints the whole row, the names keeping their colours.
export type LogCell = { text: string; color: string | null }
export type LogRow = { id: string | null; cells: LogCell[]; isPicked: boolean }
export type LogProps = { rows: LogRow[] }

const ROW_PICKED = '#2E3440'
const ROW_HOVER = '#262A33'

// The latest props, for the pointer listener set once on the first call.
let latest: LogProps = { rows: [] }

const Log: ClientModule<LogProps & { [key: string]: JsonValue }, { hover: number }> = (props, surface) => {
  const { Box, Text } = surface.elements
  latest = props
  if (surface.state === undefined) {
    surface.setState({ hover: -1 })
    surface.onPointer(e => {
      if (e.type === 'leave') return surface.setState({ hover: -1 })
      if (e.type === 'move' || e.type === 'enter') {
        if (surface.state?.hover !== e.y) surface.setState({ hover: e.y })
        return
      }
      const row = latest.rows[e.y]
      if (e.type === 'up' && e.button !== 'right' && row?.id) surface.post({ pick: row.id })
    })
  }
  const hover = surface.state?.hover ?? -1

  return (
    <Box flexDirection="column">
      {props.rows.map((row, i) => {
        const bg = row.isPicked ? ROW_PICKED : row.id && i === hover ? ROW_HOVER : undefined
        return (
          <Box key={row.id ?? `day${i}`} flexDirection="row" height={1} overflow="hidden">
            {row.cells.map((cell, j) => (
              <Text key={`c${j}`} color={cell.color ?? undefined} dimColor={!row.id} backgroundColor={bg}>
                {cell.text}
              </Text>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

export default Log

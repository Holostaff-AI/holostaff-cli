import React from 'react'
import { Box, Text } from 'ink'
import type { RepoDetection } from '../detect/repo.js'
import { describeRepo } from '../detect/describe.js'

/**
 * The first thing the user sees. Context-rich, not generic — we know
 * what their repo looks like before saying hello, and that should show.
 */
export function Welcome({
  detection,
  version,
  latestVersion,
}: {
  detection: RepoDetection
  version: string
  /** When set and newer than `version`, a one-line update nudge renders. */
  latestVersion?: string
}) {
  const description = describeRepo(detection)
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Box>
        <Text bold color="cyan">  Holostaff CLI</Text>
        <Text color="gray"> · v{version}</Text>
      </Box>
      {latestVersion && (
        <Box marginLeft={2}>
          <Text color="yellow">
            Update available: v{latestVersion}. Run `npm i -g @holostaff/cli` to upgrade.
          </Text>
        </Box>
      )}
      <Box marginTop={1} marginLeft={2}>
        <Text wrap="wrap">{description}</Text>
      </Box>
    </Box>
  )
}

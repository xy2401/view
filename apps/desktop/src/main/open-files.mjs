import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The default Electron launcher has an app entry before the user's files.
// Packaged View starts with the executable immediately followed by launch arguments.
export function filesFromArgv(argv, cwd, defaultApp) {
  const files = []
  let skipApp = Boolean(defaultApp)
  let options = true
  let skipValue = false
  for (const arg of argv.slice(1)) {
    if (skipValue) {
      skipValue = false
      continue
    }
    if (options && arg === '--') {
      options = false
      continue
    }
    if (options && arg.startsWith('-')) {
      skipValue = ['--user-data-dir', '--remote-debugging-port', '--lang', '--log-file'].includes(arg)
      continue
    }
    if (skipApp) {
      skipApp = false
      continue
    }
    if (!arg || arg.includes('\0')) continue
    try {
      if (/^file:/i.test(arg)) files.push(fileURLToPath(arg))
      else if (!/^\w+:\/\//.test(arg)) files.push(path.resolve(cwd, arg))
    } catch {
      // An invalid file URI should not hide other valid files in this launch.
    }
  }
  return [...new Set(files)]
}

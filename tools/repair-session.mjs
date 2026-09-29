// Repair sessions that dsh-rerun-turn corrupted before 0.1.1.
//
// The 0.1.0 shadow carrier was an empty `developer/message` wrapped in its own
// synthetic turn. That shape is accepted by the append path but the agent loop
// never counts an externally opened turn: its own next turn reuses the number,
// and every reader refuses the log ("turn/start does not open the expected
// turn"). 0.1.1 removed the turn entirely (the carrier is a turn-less
// `user/message` replacement).
//
// This tool scans a sessions directory (or one project directory), validates
// every log through the same strict cold-read path DSH uses, and for a corrupt
// log that carries this plugin's marker: keeps a byte-for-byte backup next to
// it and truncates the log at the first row the loader refuses. Everything
// before that point survives. When the truncation leaves this plugin's pending
// regeneration prompt in the durable inbox, the next time the session wakes
// the loop answers it - the rerun completes itself. Logs that are broken but
// carry no dsh-rerun-turn marker are reported, never touched.
//
// The storage layout has two rules a re-written file must respect, or the
// session will not even be listed:
//   - the header line lives in a zstd frame of its own, and
//   - sequence numbers stay contiguous from the first event's seq.
//
//   node tools/repair-session.mjs ~/.dsh/sessions --dry-run
//   node tools/repair-session.mjs ~/.dsh/sessions
//   node tools/repair-session.mjs ~/.dsh/sessions/<project-dir>
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'

const target = process.argv[2]
const dryRun = process.argv.includes('--dry-run')
// Without --force only logs carrying this plugin's marker are repaired; other
// broken logs (e.g. dsh-delete-turn's system/message reply carriers, which the
// format refuses at read time) are reported and left alone.
const force = process.argv.includes('--force')
const HEADER_TYPE = 'session'
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const MARKER = 'plugin:dsh-rerun-turn'

if (!target) {
  console.error('usage: node tools/repair-session.mjs <sessions-dir|project-dir> [--dry-run] [--force]')
  process.exit(2)
}

/** Decode the concatenated zstd frames of a session log into frames of lines. */
function decode(path) {
  const raw = readFileSync(path)
  const offsets = []
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (ZSTD_MAGIC.every((byte, index) => raw[i + index] === byte)) offsets.push(i)
  }
  const frames = []
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : raw.length
    try {
      frames.push(zstdDecompressSync(raw.subarray(offsets[i], end)).toString('utf8').trim().split('\n').filter(Boolean))
    } catch {
      /* a torn trailing frame is dropped, the way the writer treats one */
    }
  }
  return frames
}

/** The writer's layout: the header alone in frame zero, events eight to a frame. */
function writeLog(path, header, rows) {
  const frames = [zstdCompressSync(Buffer.from(`${header}\n`))]
  for (let i = 0; i < rows.length; i += 8) {
    frames.push(zstdCompressSync(Buffer.from(`${rows.slice(i, i + 8).join('\n')}\n`)))
  }
  writeFileSync(path, Buffer.concat(frames))
}

/**
 * Validate the stored header plus rows through the strict cold-read path that
 * the persistence reader uses (`restoreCurrent` runs the v4 vocabulary,
 * relationship/lifecycle and installed-Session validators).
 * @returns null when valid, else the failure message.
 */
function failureOf(headerValue, rows) {
  try {
    const restore = sessionFormatCatalog.createRestore(headerValue, { recovery: 'strict', validation: 'current' })
    for (const row of rows) restore.decodeRow(row)
    restore.finish()
    return null
  } catch (error) {
    return String((error && error.message) || error)
  }
}

/** The first row index the loader refuses, or -1 when every row decodes. */
function firstBadRow(headerValue, rows) {
  // Row decoding is stateful, so every probe validates the FULL prefix from
  // row 0; the binary search finds the shortest prefix that fails.
  const prefixOk = (keep) => failureOf(headerValue, rows.slice(0, keep)) === null
  if (prefixOk(rows.length)) return -1
  let low = 0
  let high = rows.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (prefixOk(mid + 1)) low = mid + 1
    else high = mid
  }
  return low
}

function sessionDirs(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const path = join(dir, name)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    if (name.startsWith('session-')) out.push(path)
    else for (const nested of sessionDirs(path)) out.push(nested)
  }
  return out
}

let scanned = 0
let broken = 0
let repaired = 0
for (const dir of sessionDirs(target)) {
  const path = join(dir, 'session.v4.jsonl.zstd')
  let frames
  try {
    frames = decode(path)
  } catch {
    continue
  }
  const lines = frames.flat()
  if (lines.length === 0) continue
  const header = lines[0]
  let headerValue
  try {
    headerValue = JSON.parse(header)
  } catch {
    continue
  }
  if (headerValue.type !== HEADER_TYPE) continue
  scanned += 1
  const rawText = lines.join('\n')
  const touched = rawText.includes(MARKER)
  const rows = []
  let parseFailed = false
  for (const line of lines.slice(1)) {
    try {
      rows.push(JSON.parse(line))
    } catch {
      parseFailed = true
      break
    }
  }
  if (parseFailed) {
    broken += 1
    console.log(`\n${headerValue.id}: unreadable row JSON (touched=${touched})`)
    continue
  }
  const failure = failureOf(headerValue, rows)
  if (failure === null) {
    if (touched) console.log(`${headerValue.id}: valid (touched by dsh-rerun-turn, ${rows.length} events)`)
    continue
  }
  broken += 1
  console.log(`\n${headerValue.id}: BROKEN - ${failure.slice(0, 140)}`)
  console.log(`  touched by dsh-rerun-turn: ${touched ? 'yes' : 'NO'}`)
  if (!touched && !force) {
    console.log('  not repaired automatically; pass --force to truncate it anyway')
    continue
  }
  // Truncate at the first refused row, then keep truncating if the surviving
  // prefix still fails (e.g. a carrier row whose bracket rows must go with it).
  let keep = rows.length
  let dropped = 0
  let verified = failure
  for (let guard = 0; guard < 50 && verified !== null; guard += 1) {
    const badIndex = firstBadRow(headerValue, rows.slice(0, keep))
    if (badIndex === -1) break
    dropped += keep - badIndex
    keep = badIndex
    verified = failureOf(headerValue, rows.slice(0, keep))
  }
  console.log(`  first refused row: ${keep} -> would drop ${dropped} event(s), keep ${keep}`)
  if (verified !== null) {
    console.log(`  STILL CORRUPT after truncation: ${verified}`)
    continue
  }
  if (dryRun) {
    console.log('  dry run: no changes written')
    continue
  }
  const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
  writeFileSync(backup, readFileSync(path))
  writeLog(path, header, lines.slice(1, 1 + keep))
  repaired += 1
  console.log(`  repaired: dropped ${dropped} event(s), kept ${keep}, backup ${backup.split('/').pop()}`)
  console.log(`  dropped types: ${rows.slice(keep).map((row) => row.type).join(', ')}`)
}
console.log(`\nscanned ${scanned} session log(s); ${broken} broken; ${repaired} repaired${dryRun ? ' (dry run)' : ''}`)

// Read-only probe: is this plugin's host half loaded in the running DSH?
//
// The two routes this plugin registers answer with status codes no other
// route uses: /state answers 400 to a missing session id and /apply answers
// 405 to a GET. A 404 on both means the plugin is not loaded at all.
//
//   node tools/probe-loaded.mjs [port]
import { request } from 'node:http'

const port = Number(process.argv[2] || 3080)

function probe(path, method) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method, timeout: 5000 }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', (error) => resolve(`error: ${error.message}`))
    req.on('timeout', () => {
      req.destroy()
      resolve('timeout')
    })
    req.end()
  })
}

const stateStatus = await probe('/dsh-rerun-turn/state?sessionId=', 'GET')
const applyStatus = await probe('/dsh-rerun-turn/apply', 'GET')
console.log(`port ${port}: GET /state -> ${stateStatus}, GET /apply -> ${applyStatus}`)
if (stateStatus === 400 && applyStatus === 405) {
  console.log('dsh-rerun-turn is loaded.')
} else if (stateStatus === 404 && applyStatus === 404) {
  console.log('dsh-rerun-turn is NOT loaded (both routes 404).')
} else {
  console.log('unexpected statuses; inspect the host output.')
  process.exitCode = 1
}

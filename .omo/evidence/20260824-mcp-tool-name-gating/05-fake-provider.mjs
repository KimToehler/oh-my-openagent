import http from 'node:http'
import { sendSse, textEvents, toolCallEvents } from '/Users/tim/git/oh-my-openagent/.agents/skills/opencode-qa/scripts/lib/fake-openai-events.mjs'
let count = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    count += 1
    process.stderr.write(`request=${count} method=${req.method} path=${req.url} bytes=${body.length}\n`)
    if (count === 1) {
      sendSse(res, toolCallEvents(count, 'write', 'call_write_existing', { filePath: 'existing.txt', content: 'must-not-overwrite' }))
      return
    }
    sendSse(res, textEvents(count, 'fake provider completed after write guard'))
  })
})
server.listen(0, '127.0.0.1', () => console.log(`PORT=${server.address().port}`))
process.on('SIGTERM', () => server.close(() => process.exit(0)))

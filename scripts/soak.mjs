#!/usr/bin/env node
// Manual soak test — NOT run in CI. Drives a running MCP server's /mcp tools/list
// (a benign authenticated read) and reports p50/p99 latency + RSS delta.
//
// Usage: node scripts/soak.mjs --url http://localhost:3000 --token <bearer> --duration 60 --connections 20
import autocannon from 'autocannon';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const url = arg('url', 'http://localhost:3000');
const token = arg('token', process.env.DEV_BEARER_TOKEN ?? '');
const duration = Number(arg('duration', '60'));
const connections = Number(arg('connections', '20'));
if (!token) {
  console.error('Provide --token <bearer> or set DEV_BEARER_TOKEN');
  process.exit(1);
}

const rssStart = process.memoryUsage().rss;
const instance = autocannon({
  url: `${url}/mcp`,
  connections,
  duration,
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
autocannon.track(instance, { renderProgressBar: true });
instance.on('done', (result) => {
  const rssEnd = process.memoryUsage().rss;
  console.log('\n--- soak summary ---');
  console.log(`requests: ${result.requests.total}, non-2xx: ${result.non2xx}`);
  console.log(`latency p50=${result.latency.p50}ms p99=${result.latency.p99}ms max=${result.latency.max}ms`);
  console.log(`driver RSS delta: ${((rssEnd - rssStart) / 1e6).toFixed(1)} MB`);
});

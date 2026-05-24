// PM2 ecosystem config — production droplet only.
//
// Single fork over 1 GB Lightsail/Droplet. `--max-old-space-size=768`
// caps V8 heap below `max_memory_restart` so PM2 catches a runaway
// before the kernel OOM-killer does. `MALLOC_ARENA_MAX=2` reins in
// glibc's per-thread arena allocator — without it, Node + libuv +
// UV_THREADPOOL_SIZE=8 workers can double the RSS over the V8 heap
// (the classic "Node uses 600 MiB heap but 1.4 GiB RSS" pattern)
// and trip max_memory_restart prematurely.
//
// `wait_ready` is intentionally OFF: Next.js 15 standalone server.js
// does not emit `process.send('ready')`, so PM2 would wait the full
// listen_timeout on every reload for a signal that never comes. The
// deploy script's /healthz poll is the real readiness gate.
//
// `HOSTNAME=127.0.0.1` (NOT `HOST=`) — Next standalone reads
// `process.env.HOSTNAME` and defaults to `0.0.0.0` otherwise. Binding
// to loopback only is defence-in-depth alongside UFW deny 3040; on a
// multi-NIC droplet (DO private networking, VPC peering) `0.0.0.0`
// would expose the upstream to internal interfaces.
//
// CWD points at the standalone output that Next 15 produces under
// `.next/standalone`. The release symlink at /opt/bwc/current is
// flipped by scripts/deploy.sh — PM2 picks up the new binary on
// `pm2 startOrReload` because the cwd resolves through the symlink.

module.exports = {
  apps: [{
    name: 'bwc',
    script: 'server.js',
    cwd: '/opt/bwc/current/.next/standalone',
    instances: 1,
    exec_mode: 'fork',
    node_args: '--max-old-space-size=768',
    env: {
      NODE_ENV: 'production',
      PORT: '3040',
      HOSTNAME: '127.0.0.1',
      UV_THREADPOOL_SIZE: '8',
      MALLOC_ARENA_MAX: '2',
    },
    // 1280M leaves headroom over V8's 768M heap cap for sharp
    // (libvips can hold 200-500M during large-image re-encode),
    // libuv threadpool stacks, and the glibc arena cap (2 arenas
    // × ~128M each). At 1024M, legitimate image-variant work would
    // OOM-kill the process mid-upload. 1280M still fits the 1GB
    // droplet + 1GB swap envelope before the kernel OOM-killer
    // triggers around ~1500M RSS.
    max_memory_restart: '1280M',
    kill_timeout: 8000,
    listen_timeout: 8000,
    wait_ready: false,
    max_restarts: 10,
    min_uptime: 60000,
    out_file: '/var/log/bwc/out.log',
    error_file: '/var/log/bwc/err.log',
    merge_logs: true,
    time: true,
  }],
}

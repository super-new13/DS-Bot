import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

function config(project, fixture) {
  const args = ['compose', '--env-file', '/dev/null', '-f', 'compose.enterprise.yml']
  if (project) args.push('-p', project)
  if (fixture) args.push('--profile', 'employee-pilot')
  return JSON.parse(execFileSync('docker', [...args, 'config', '--format', 'json'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, COMPOSE_PROJECT_NAME: '', COMPOSE_PROFILES: '', DSBOT_ENTERPRISE_CONFIG_DIR: fixture ?? '', DATA_DIR: './docker/data', WORKSPACE_DIR: './docker/workspace' },
    encoding: 'utf8',
  }))
}

test('standalone enterprise config keeps DSH private and needs no credentials or Relay', () => {
  const model = config()
  assert.equal(model.name, 'ds-bot-enterprise')
  assert.deepEqual(Object.keys(model.services), ['dsh'])
  const { dsh } = model.services
  assert.deepEqual(dsh.ports ?? [], [])
  assert.equal(dsh.network_mode, undefined)
  assert.deepEqual(Object.keys(dsh.networks), ['enterprise-backend'])
  assert.equal(model.networks['enterprise-backend'].internal, true)
  assert.deepEqual(dsh.environment, {
    DSH_HOST: '127.0.0.1',
    DSH_LISTEN_PORT: '3080',
    DSH_TELEMETRY_DISABLED: '1',
  })
  assert.equal(dsh.env_file, undefined)
  assert.equal(dsh.depends_on, undefined)
  assert.deepEqual(model.secrets ?? {}, {})
  assert.deepEqual(dsh.secrets ?? [], [])
})

test('smoke projects resolve to separate DSH volumes without host mounts', () => {
  for (const project of ['ds-bot-enterprise-smoke-a', 'ds-bot-enterprise-smoke-b']) {
    const model = config(project)
    assert.deepEqual(model.services.dsh.volumes.map(({ type, source, target }) => [type, source, target]), [
      ['volume', 'enterprise-dsh-data', '/data'],
      ['volume', 'enterprise-dsh-workspace', '/workspace'],
    ])
    for (const [key, volume] of Object.entries(model.volumes)) {
      assert.equal(volume.name, project + '_' + key)
      assert.equal(volume.external, undefined)
      assert.equal(volume.driver_opts, undefined)
    }
  }
})

test('explicit pilot publishes only loopback HTTPS with isolated data and read-only operator files', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'dsbot-compose-pilot-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const project = 'ds-bot-pilot-test'
  const { services, volumes, networks, secrets } = config(project, fixture)
  const pilot = services['employee-pilot']
  assert.deepEqual(pilot.entrypoint, ['node', '/opt/dsh-template/profiles/web/node_modules/ds-bot/bin/ds-bot-enterprise.mjs',
    '--config', '/run/dsbot-enterprise/config.json'])
  assert.deepEqual(pilot.profiles, ['employee-pilot'])
  assert.deepEqual(pilot.ports.map(({ host_ip, target, published, protocol }) => [host_ip, target, published, protocol]),
    [['127.0.0.1', 8443, '18443', 'tcp']])
  assert.equal(pilot.user, '1000:1000')
  assert.equal(pilot.read_only, true)
  assert.deepEqual(Object.keys(pilot.networks), ['employee-edge'])
  assert.deepEqual(Object.keys(services.dsh.networks), ['enterprise-backend'])
  assert.equal(networks['enterprise-backend'].internal, true)
  assert.deepEqual(services.dsh.ports ?? [], [])
  assert.equal(pilot.depends_on, undefined)
  assert.equal(pilot.environment, undefined)
  assert.equal(pilot.env_file, undefined)
  assert.deepEqual(secrets ?? {}, {})
  assert.deepEqual(pilot.volumes.map(({ type, source, target }) => [type, source, target]), [
    ['bind', fixture, '/run/dsbot-enterprise'], ['volume', 'enterprise-employee-data', '/home/node'],
  ])
  assert.equal(pilot.volumes[0].read_only, true)
  assert.equal(pilot.volumes[0].bind.create_host_path, false)
  assert.equal(volumes['enterprise-employee-data'].name, project + '_enterprise-employee-data')
  assert.equal(volumes['enterprise-employee-data'].external, undefined)
})

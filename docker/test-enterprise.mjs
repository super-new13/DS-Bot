import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

function config(project) {
  const args = ['compose', '--env-file', '/dev/null', '-f', 'compose.enterprise.yml']
  if (project) args.push('-p', project)
  return JSON.parse(execFileSync('docker', [...args, 'config', '--format', 'json'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, COMPOSE_PROJECT_NAME: '', DATA_DIR: './docker/data', WORKSPACE_DIR: './docker/workspace' },
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

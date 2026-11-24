# Dedicated DSH worker plugin lifecycle

DSH 0.2.2-rc.1 can boot a headless, application-owned profile through the
published packages. The fixture boots in a separate Node process with a new
DSH_HOME, a temporary working directory and a minimal launch environment. Its
empty bundle list keeps DSH's Web server and browser connection services out
of the profile. The mock worker reads and writes only temporary fixture data
and binds a port on 127.0.0.1.

## API sequence

1. Use initProfile(directory, []) and loadProfileDirectory('dsh', directory,
   INSTALL_ANCHOR) from @deepseek-ai/dsh-app-boot. INSTALL_ANCHOR comes from
   @deepseek-ai/dsh/profile-boot. Check the loaded profile before starting it.
2. Call runProfile from @deepseek-ai/dsh/profile-boot with the profile name,
   resolvedProfile containing the profile and install anchor, an environment
   snapshot, explicit patchFiles and args. Use createLaunchEnvironmentSnapshot
   from @deepseek-ai/dsh-launch-environment to construct the fixture snapshot.
   The patch inserts the fixture module as a Cordis entry.
3. Export async apply from the worker plugin. Resolve activation only after its
   listener is ready. Return an async disposer that closes the listener. The
   fixture found that ctx.on('dispose', async callback) did not provide the
   awaited cleanup this worker needs on DSH 0.2.2-rc.1.
4. Await shutdown.shutdown(0) on the returned runtime. The test joins two
   shutdown calls, verifies the cleanup marker, and confirms a new loopback
   connection fails with ECONNREFUSED.

## Verification

From the repository root with Node.js 24:

    npm --prefix ds-bot run harness
    node --test ds-bot/test/enterprise-plugin-lifecycle.test.js

To use a disposable npm installation, set DSH_HARNESS to a directory containing
node_modules with @deepseek-ai/dsh@0.2.2-rc.1. The probe passed using that setup
on macOS arm64. The worker transport in this fixture is a mock HTTP response.
Earlier tests exercised the worker AgentLoop and mTLS separately. Production
still needs a dedicated profile composition with AgentLoop services, a safe
workspace and preset, the existing mTLS worker runtime, and deployment tests
for startup failure and shutdown during active work.

# Depot-free a3p integration test for the fork (garden#29)

**Why this exists.** The upstream `.github/workflows/integration.yml` runs its
SDK-image build (`build-sdk-ci-image`) and the a3p "docker" integration test
(`test-docker-build`) on **Depot** runners (`depot-ubuntu-22.04*`) and
builds/pulls the shared SDK CI image through Depot's remote builder + registry
(`depot/setup-action`, `depot/build-push-action`, `depot/pull-action`,
`DOCKER_BUILD='depot build ...'`). The fork has **no Depot access**, so those
jobs never run here — which is why the critical-vat a3p proposal test can't
execute on the fork (no deterministic vatID, no test outcome). Note: syncing the
fork's `master` won't help — **upstream `master` also uses Depot** in
`integration.yml`; the depot-free path has to be re-authored regardless.

**The depot-free path is small.** a3p-integration already builds the SDK image
with plain Docker: `yarn build` -> `build:sdk` ->
`make -C ../packages/deployment docker-build-sdk`, whose Makefile default is
`DOCKER_BUILD ?= docker build` (no Depot). Stock GitHub-hosted `ubuntu-latest`
runners have Docker/buildx, so `yarn build` builds
`ghcr.io/agoric/agoric-sdk:unreleased` locally with no Depot at all — the way
this ran before the Depot migration. The only reason the workflow overrode
`DOCKER_BUILD` to `depot build` was Depot's remote builder + layer cache.

**Blocker on pushing this as an actual workflow.** The garden automation's
GitHub token has `repo` scope but **not `workflow` scope**, so it cannot create
or modify files under `.github/workflows/`. A maintainer (or a token with
`workflow` scope) must commit the YAML below as
`.github/workflows/fork-a3p-no-depot.yml`. This doc carries the ready-to-apply
content so no retyping is needed.

**Caveats to expect on the first real run** (the parts I cannot validate from an
unprivileged, Docker-less container):
- **Disk.** Stock runners start with ~14 GB free; the SDK image plus
  synthetic-chain images are large. The `free up disk space` step reclaims the
  usual ~10-20 GB; if it's still tight, prune more aggressively.
- **Time.** Plain `docker build` has no Depot remote cache, so the SDK image is
  built from scratch each run (tens of minutes). `timeout-minutes: 120` leaves
  headroom. To speed repeat runs, add `docker/setup-buildx-action` and override
  `DOCKER_BUILD='docker buildx build --load'` with `type=gha` cache flags.

## Ready-to-commit workflow

Save as `.github/workflows/fork-a3p-no-depot.yml`:

```yaml
# Depot-free a3p (synthetic-chain) integration test for the fork.
#
# Context: garden#29 / kriscendobot/agoric-sdk#9. The upstream `integration.yml`
# `build-sdk-ci-image` + `test-docker-build` jobs run on Depot runners
# (`depot-ubuntu-22.04-*`) and build/pull the SDK CI image through Depot's remote
# builder + registry. The fork has no Depot access, so those jobs never run here
# and the critical-vat a3p proposal test can't execute (no vatID, no outcome).
#
# This workflow reproduces just the a3p "docker" integration test on a stock
# GitHub-hosted `ubuntu-latest` runner using plain `docker build` — the way it
# ran before the Depot migration. It relies on a3p-integration's own
# `yarn build` (build:sdk -> `make -C ../packages/deployment docker-build-sdk`,
# whose `DOCKER_BUILD ?= docker build` needs no Depot) to produce
# `ghcr.io/agoric/agoric-sdk:unreleased` locally, then runs the proposal tests.
#
# Scope: intentionally narrow (the SDK image build + the a3p proposal test only).
# The Depot-bound deployment-test, multichain-e2e, and ymax-planner jobs in
# integration.yml are out of scope here.
name: a3p integration (fork, no Depot)

on:
  workflow_dispatch:
  push:
    branches:
      - garden29-a3p-ci-no-depot
      - garden29-promote-ymax-critical

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  GOLANG_VERSION: '1.24'

jobs:
  a3p:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4
        with:
          path: ./agoric-sdk

      - name: free up disk space
        # The SDK image + synthetic-chain images are large; stock runners start
        # with ~14 GB free. Reclaim space the same way integration.yml does.
        run: |
          df -h
          sudo rm -rf /usr/share/dotnet
          sudo rm -rf /opt/ghc
          sudo rm -rf /usr/local/share/boost
          sudo rm -rf "$AGENT_TOOLSDIRECTORY"
          sudo rm -rf /usr/local/lib/android
          sudo docker image prune --all --force || true
          echo "=== After cleanup:"
          df -h

      - id: restore-golang
        uses: ./agoric-sdk/.github/actions/restore-golang
        with:
          go-version: '${{ env.GOLANG_VERSION }}'
          path: ./agoric-sdk

      - id: restore-node
        uses: ./agoric-sdk/.github/actions/restore-node
        with:
          # Rebuilding the SDK image with resolved endo packages is not supported,
          # so ignore any endo branch integration (matches integration.yml).
          ignore-endo-branch: 'true'
          node-version: 'node-new'
          path: ./agoric-sdk
          # Force xsnap to initialize memory to random data, increasing the chance
          # snapshot content deviates between validators (matches integration.yml).
          xsnap-random-init: '1'

      - name: setup a3p-integration
        run: yarn install
        working-directory: agoric-sdk/a3p-integration

      - name: build a3p (SDK image + submissions + synthetic-chain) with plain docker
        # `yarn build` == build:sdk (`make -C ../packages/deployment docker-build-sdk`,
        # DOCKER_BUILD defaults to `docker build` — no Depot) && build:submissions
        # && build:synthetic-chain. This is the step that replaces the Depot image
        # build/pull.
        run: yarn build
        working-directory: agoric-sdk/a3p-integration

      - name: run proposal tests
        run: yarn test
        working-directory: agoric-sdk/a3p-integration

      - name: archive a3p-integration exports
        if: always()
        run: |
          dir='/tmp/export/a3p-integration'
          rm -rf "$dir"
          scripts/ci/export-a3p.sh a3p-integration "$dir" || true
        working-directory: agoric-sdk

      - name: upload a3p artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: a3p-integration
          path: |
            /tmp/export/a3p-integration
          if-no-files-found: ignore
```

## Minimal alternative: edit `integration.yml` in place

If you'd rather not add a separate workflow, the equivalent minimal edit to the
existing `test-docker-build` job is:
- `runs-on: ubuntu-latest` (was `depot-ubuntu-22.04-16`);
- drop the `depot/setup-action` step, the `build-sdk-ci-image` entry in `needs`,
  and the `depot/pull-action` "Pull shared SDK CI image" step;
- replace the guarded `docker build (sdk)` step with an unconditional
  `run: make docker-build-sdk` (default `DOCKER_BUILD=docker build`) — or let
  a3p's own `yarn build` build it;
- remove the now-unused `build-sdk-ci-image` job (Depot-only).

The Depot-bound `deployment-test`, `test-multichain-e2e`, and
`test-ymax-planner-build` jobs are out of scope for the a3p test and can stay as
they are (they simply won't run on the fork).

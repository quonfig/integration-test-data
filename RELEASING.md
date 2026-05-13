# Releasing integration-test-data

Consuming SDKs (sdk-go, sdk-node, sdk-python, sdk-ruby, sdk-java) generate
their integration tests from the YAML in `tests/eval/` and the JSON fixtures
in `data/integration-tests/`. Until 2026-05-13 each SDK's CI checked out this
repo at `ref: main`, which meant any breaking edit here landed in every SDK's
next CI run with zero staging. We now cut versioned tags so SDKs can pin and
upgrade deliberately.

## Scheme

- **Format**: `vYYYY.MM.DD` (annotated tag), e.g. `v2026.05.13`.
- **Cadence**: cut a new tag whenever a meaningful change lands — a new YAML
  case, an edit to existing expectations, a new generator target, a fixture
  update. Cosmetic/doc-only commits don't require a new tag.
- **No latest channel**: SDKs pin to an explicit tag in their workflow. There
  is no `latest` symlink and `main` should not be used by CI.
- **Tags are immutable**: never re-tag the same name at a different commit.
  If a bad tag is published, cut a new tag (`v2026.05.14`, `v2026.05.13.1`,
  whatever) and have SDKs bump.

## Cutting a tag

From a clean main:

```bash
git -C integration-test-data fetch origin
git -C integration-test-data checkout main
git -C integration-test-data pull --ff-only
TAG=v$(date +%Y.%m.%d)
git -C integration-test-data tag -a "$TAG" -m "Describe what changed since the last tag."
git -C integration-test-data push origin "$TAG"
```

If you cut a second tag on the same day, append a counter: `v2026.05.13.1`.

Check existing tags with `git -C integration-test-data tag --list` before
running. Do not force-push or move a tag.

## How downstream SDKs upgrade

Each SDK's workflow that consumes this repo (typically
`.github/workflows/test.yaml`) pins `ref:` on the
`actions/checkout` of `quonfig/integration-test-data`. To upgrade:

1. Bump `ref: v2026.MM.DD` to the new tag in the workflow file.
2. Open a PR. CI runs against the new tag.
3. If green, merge. If red, the failure is contained to that one PR — main
   stays on the previous tag.

Pinned SDKs as of v2026.05.13: sdk-go, sdk-node, sdk-python, sdk-ruby,
sdk-java. The chaos harness (`chaos/`) is also consumed by the per-SDK
chaos workflow and inherits the same pin.

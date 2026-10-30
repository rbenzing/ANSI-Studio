# Contributing

Thanks for helping with ANSI Studio. Bug reports, fixes and ideas are all welcome.

## Set up

You need Node.js 22.18 or later.

```sh
npm install
npm start            # http://localhost:3000; prompts need a model key, see the README
npm run check        # lint, type check and tests; CI runs the same
```

## Making a change

- Keep it small. The project aims for the least code that does the job well, so prefer fixing or reusing what exists over adding new layers or dependencies.
- Add or update tests in `test/` for behavior that changes, including failure paths. `public/ansi.js` and `public/tdf.js` are DOM-free, so most logic can be tested directly with the Node test runner.
- Make sure `npm run check` passes.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- Do not change the version in `package.json`. It changes only in release commits.

## Versioning and releases

ANSI Studio follows [Semantic Versioning](https://semver.org/). The version lives in `package.json`, and a test fails unless `package.json`, `package-lock.json` and `CHANGELOG.md` agree on it. While the version is 0.x, a minor release may change behavior or configuration.

To cut a release (maintainers):

1. Choose the version from the changes under `[Unreleased]`: patch for fixes, minor for features or breaking changes while on 0.x.
2. Run `npm version <x.y.z> --no-git-tag-version`. This updates `package.json` and `package-lock.json`.
3. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD`, add a new empty `## [Unreleased]` above it, and update the compare links at the bottom.
4. Run `npm run check`.
5. Commit, then tag and push:

   ```sh
   git commit -am "Release vx.y.z"
   git tag -a vx.y.z -m "vx.y.z"
   git push origin main vx.y.z
   ```

The release workflow checks that the tag matches `package.json`, runs the checks again and publishes a GitHub release with that version's changelog notes.

## Reporting security issues

Please do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).

# Release checklist

1. Merge the code changes into `main`.
2. Add semver markers to commit messages when appropriate: `#major`, `#minor`, `#patch`, `#premajor`, `#preminor`, `#prepatch`, or `#prerelease`.
3. Open GitHub Actions → **Create release** → **Run workflow**.
4. Choose the default release increment and whether to increment per commit.
5. The workflow uses `MCKanpolat/auto-semver-action@v2`, updates `package.json` and `package-lock.json`, commits the version, pushes a `vX.Y.Z` tag, and creates the GitHub Release.
6. The same workflow publishes the package to npm using Trusted Publishing, then creates the GitHub Release.

## npm Trusted Publishing

Configure the npm package Trusted Publisher with:

- Provider: GitHub Actions
- Organization/user: `MCKanpolat`
- Repository: `matterbridge-printprogress`
- Workflow filename: `release.yml`
- Environment: empty
- Allowed action: `npm publish`

The release workflow publishes to npm with Trusted Publishing. Configure the npm publisher before the first automated release; no npm token is stored in GitHub Actions.

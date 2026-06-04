# Contributing

## Git workflow

1. Create a feature branch from `main`.
2. Keep `main` in sync with `origin/main` using `git fetch` and `git pull --ff-only`.
3. Merge the updated `main` into your feature branch before opening a PR.
4. Commit your changes on the feature branch.
5. Open a pull request targeting `main`.
6. Merge to `main` only through an approved pull request after CI passes.

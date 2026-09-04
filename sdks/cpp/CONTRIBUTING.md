# Contributing to the Tesseron C++ SDK

Thanks for the help.

## Build and test

Use CMake from the repository root. Keep the build directory out of your shell
path.

```bash
cmake -S . -B build -G Ninja -DTESSERON_BUILD_TESTS=ON -DTESSERON_BUILD_CONFORMANCE_HOST=ON -DTESSERON_BUILD_EXAMPLES=ON
cmake --build build
ctest --test-dir build --output-on-failure
```

Use clang and Ninja locally. CI also builds with MSVC on Windows.

## House rules

- Spell names out. Do not abbreviate locals, parameters, lambdas, or tests.
- Nothing throws across a handler boundary. Use `Result<T>` in every handler signature.
- Fetch dependencies only through `FetchContent`, pinned to a version and hash.
  Do not add vcpkg, Conan, or system package dependencies.
- Comments explain why a choice exists. Let code explain what it does.

## Docs and releases

The protocol, SDK docs, and issue tracker live in the
[Tesseron hub](https://github.com/Eigenwise/tesseron). C++ SDK docs live there
under `docs/src/content/docs/sdk/cpp`.

An SDK release PR is complete only after its required hub docs PR has merged.

## DCO

Sign off every commit with `git commit -s`. The sign-off says you wrote the
change or have the right to contribute it under the project license.

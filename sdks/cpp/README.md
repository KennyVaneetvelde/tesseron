# Tesseron C++ SDK

C++ half of the [Tesseron](https://eigenwise.github.io/tesseron/) protocol: your
application binds a loopback WebSocket, writes an instance manifest, and the MCP
gateway dials *in*. There is no port to configure and no gateway address to
point at.

Two targets live here:

| Target | Where | What it is |
|---|---|---|
| `tesseron::tesseron` | `sdks/cpp/` | the library you link against |
| `tesseron-conformance-host` | `sdks/cpp/conformance-host/` | test binary the `@tesseron/conformance` runner drives; never installed or exported |

## Status

Work in progress, tracking protocol 1.2.0. The whole host half of the protocol
is here: the handshake, claiming, session resume with token rotation, action
invocation with input validation and cancellation, streaming progress, resource
reads and subscriptions, and the `ActionContext` round trips back into the agent
for sampling, confirmation, elicitation, and logging. All four `Capabilities`
flags are declared.

Host-minted claim codes are the one thing left out. The gateway mints the code,
and a restarted process is a new session.

Three details worth knowing before you write a handler:

- Boost.Asio is a **public** dependency. A handler is a coroutine returning
  `boost::asio::awaitable<tesseron::Result<tesseron::Json>>`, so anything that
  links this library sees Asio's headers. Boost.Beast is private.
- `progress` clamps percent into 0 to 100 and never lets it fall below a value
  already sent for this invocation. An agent drawing a progress bar reads a
  backwards jump as a restart, and the message and data are worth keeping.
- `elicit` checks the JSON Schema against what MCP elicitation can render before
  anything reaches the wire. A schema with a top-level `oneOf`, or a property
  typed `object` or `array`, fails with `-32602` and the agent is never asked.

The host binds loopback only. `HostOptions::bind_address` set to anything
outside `127.0.0.0/8` or `::1` is a `HostError` before a socket opens.

## Using it

```cpp
#include <tesseron/tesseron.hpp>

using tesseron::ActionContext;
using tesseron::Json;
using tesseron::Result;

boost::asio::awaitable<Result<Json>> add_todo(Json input, ActionContext context) {
  const auto id = store_todo(input.at("title").get<std::string>());
  context.progress(tesseron::ProgressUpdate().percent(100));

  Json added = Json::object();
  added["id"] = id;
  co_return added;
}

int main() {
  auto builder = tesseron::Host::builder();
  builder.application("todo", "Todo");
  builder.on_event([](const tesseron::HostEvent& event) {
    if (event.kind == tesseron::HostEvent::Kind::Welcome && event.welcome->claim_code) {
      std::cout << "Claim this session with " << *event.welcome->claim_code << "\n";
    }
  });
  builder.action("add_todo")
      .description("Adds one todo")
      .input(tesseron::schema::object({
          tesseron::schema::required("title", tesseron::schema::string()),
      }))
      .handler(add_todo);

  auto listening = builder.listen();
  if (!listening.ok()) return 1;
  auto host = std::move(listening).value();
  wait_until_the_application_quits();
  host.shutdown();
}
```

Register the event listener *before* `listen()`. The gateway can dial and finish
the handshake before `listen()` returns, and a listener installed afterwards
misses the welcome that carries the claim code.

The `Schema` builder publishes the manifest schema and enforces it at dispatch,
so the contract the agent reads is the one the handler is protected by. For a
shape it cannot express there is `input_schema(Json, InputValidator)`, which
takes the raw document *and* the check: an unenforced schema is a promise to
the agent that the handler does not keep.

## Building it

CMake 3.24 or newer, and a compiler with C++20 coroutines. Every dependency
arrives through `FetchContent` at a pinned version and hash, so a clean checkout
needs nothing but a compiler, CMake, and a network connection. No vcpkg, no
Conan, no system packages.

```bash
cmake -S sdks/cpp -B sdks/cpp/build -G Ninja -DTESSERON_BUILD_TESTS=ON
cmake --build sdks/cpp/build
ctest --test-dir sdks/cpp/build --output-on-failure
```

Run those from the repository root. `-S` and `-B` are what make that work; there
is no reason to change directory first.

## Examples

Build the headless todo app and prompt library with:

```bash
cmake -S sdks/cpp -B sdks/cpp/build -G Ninja -DTESSERON_BUILD_EXAMPLES=ON
cmake --build sdks/cpp/build --target tesseron-example-todo tesseron-example-prompts
```

`tesseron-example-todo` and `tesseron-example-prompts` print a claim code after
the gateway connects. Claim it in Claude Code, then call the actions. After the
gateway is built, `pnpm example:cpp:e2e` drives both executables and checks the
canonical action contracts through the real gateway.

Consuming it from another project:

```cmake
include(FetchContent)
FetchContent_Declare(tesseron GIT_REPOSITORY https://github.com/Eigenwise/tesseron.git
                     GIT_TAG main SOURCE_SUBDIR sdks/cpp)
FetchContent_MakeAvailable(tesseron)
target_link_libraries(your_app PRIVATE tesseron::tesseron)
```

The first configure builds Boost.Context, Boost.Container and Boost.Date_Time
from source, which takes a couple of minutes. Everything after that is
incremental. `BOOST_INCLUDE_LIBRARIES` is limited to `asio` and `beast`, so this
is not a full Boost build.

### Toolchains

The local development pass for this SDK ran on Windows 11 with **clang 22.1.0**
(`x86_64-pc-windows-msvc`), CMake 4.2.1 and Ninja 1.13.2. MSVC `cl` was not
installed on that machine, so the MSVC half of the matrix is covered by CI only.
CI builds ubuntu-latest with clang and windows-latest with MSVC.

Two CMake details exist for MSVC and are set on the library target, so they
reach consumers too: `/bigobj`, because Beast's templates blow past the default
section limit, and `/Zc:__cplusplus`, without which MSVC reports C++98 and
header feature checks fall back to pre-C++20 paths. On Windows the library also
defines `_WIN32_WINNT=0x0A00` publicly, because Asio reads it to pick its I/O
completion API and it has to be set before any Asio header is included.

## Conformance

From the repository root, against the language-neutral corpus in `conformance/`:

```bash
cmake -S sdks/cpp -B sdks/cpp/build -G Ninja -DTESSERON_BUILD_CONFORMANCE_HOST=ON
cmake --build sdks/cpp/build
pnpm -r --filter @tesseron/conformance build
pnpm conformance:run:cpp
```

Every fixture passes except the ten that need something this host does not
have: the nine `bind/*` fixtures, which need a host-minted claim, plus
`uds/file-mode`. At the corpus this was last run against that is 29 passed, 10
skipped, 0 failed. `conformance/run-reference.mjs` owns both skip lists and CI
runs the same script.

## House rules

- No abbreviations in names. Not in locals, parameters, lambdas, or tests.
- A comment carries the why. If it narrates what the line does, the line needs a
  better name instead.
- Nothing throws across a handler boundary: the error type is part of every
  signature. `Result<T>` or `Result<T, HostError>`, never an exception.
- Nothing under `sdks/cpp/` refers to a path above `sdks/cpp/`. The directory
  moves to its own repository unchanged.

## License

Tesseron is licensed under the [Business Source License 1.1](./LICENSE). Each
release auto-converts to Apache-2.0, the Change License, four years after
publication.

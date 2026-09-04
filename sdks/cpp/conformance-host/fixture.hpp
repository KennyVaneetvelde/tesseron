#pragma once

#include <optional>
#include <string>

#include <tesseron/host.hpp>
#include <tesseron/json.hpp>

namespace conformance {

/// Reads a fixture document and registers everything it declares on `builder`.
///
/// The grammar is the one `conformance/README.md` documents under "Fixture
/// adapter grammar". Anything in that grammar this release cannot serve is
/// refused here rather than ignored, so a capability the host does not have
/// shows up as a failed launch instead of a fixture that quietly passed.
///
/// Answers a message naming the capability when the fixture needs behaviour
/// this release does not implement, or when its `inputSchema` uses a keyword
/// the adapter cannot enforce.
[[nodiscard]] std::optional<std::string> register_fixture(tesseron::HostBuilder& builder,
                                                          const tesseron::Json& document);

}  // namespace conformance

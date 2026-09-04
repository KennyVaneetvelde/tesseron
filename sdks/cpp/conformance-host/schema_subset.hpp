#pragma once

#include <optional>
#include <string>
#include <vector>

#include <tesseron/json.hpp>
#include <tesseron/schema.hpp>

namespace conformance {

/// Names the first JSON Schema keyword in `schema` this module cannot enforce,
/// or nothing when the whole document is enforceable.
///
/// Fixture `inputSchema` documents are raw JSON, so something has to check
/// invocation input against them. Rather than pull a full JSON Schema
/// implementation into a test binary, this module covers the keywords the
/// corpus actually uses and refuses, at registration time, any schema that
/// needs more. A fixture that would otherwise pass because a keyword was
/// silently ignored fails the run instead.
[[nodiscard]] std::optional<std::string> unenforceable_keyword(const tesseron::Json& schema);

/// Every way `value` fails `schema`.
[[nodiscard]] std::vector<tesseron::ValidationIssue> check(const tesseron::Json& schema,
                                                           const tesseron::Json& value);

}  // namespace conformance

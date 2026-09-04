#pragma once

#include <nlohmann/json.hpp>

namespace tesseron {

/// Every JSON value that crosses the Tesseron wire, and the escape hatch an
/// application reaches for when the `Schema` builder cannot express a shape.
using Json = nlohmann::json;

}  // namespace tesseron

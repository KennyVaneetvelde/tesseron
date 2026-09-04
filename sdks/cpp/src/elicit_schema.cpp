#include "elicit_schema.hpp"

#include <algorithm>
#include <array>
#include <string>
#include <string_view>

namespace tesseron::detail {
namespace {

/// The types an elicited property may declare.
constexpr std::array<std::string_view, 4> kPrimitiveTypes{"string", "number", "integer", "boolean"};

/// Keywords that would ask the agent to render more than one shape.
constexpr std::array<const char*, 4> kCompositionKeywords{"oneOf", "anyOf", "allOf", "not"};

/// JavaScript truthiness, because the rule is written against what the
/// TypeScript validator accepts and an empty array or object is truthy there.
bool is_truthy(const Json& value) {
  if (value.is_null()) return false;
  if (value.is_boolean()) return value.get<bool>();
  if (value.is_number()) return value.get<double>() != 0.0;
  if (value.is_string()) return !value.get<std::string>().empty();
  return true;
}

ActionError rejection(std::string message) {
  return ActionError::protocol(TesseronErrorCode::InvalidParams, std::move(message));
}

std::optional<ActionError> validate_properties(const Json& properties) {
  for (const auto& [name, property] : properties.items()) {
    if (!property.is_object()) continue;

    const auto type = property.find("type");
    if (type == property.end()) continue;
    // A `type` array declares alternatives the client may pick between, and
    // 1.2.0 checks only the first entry. Tightening that would reject schemas
    // that pass today, so it waits for a future minor.
    Json declared = *type;
    if (type->is_array()) declared = type->empty() ? Json() : type->front();

    // A property with no usable type is accepted unchanged: the validator does
    // not infer one from the property's other keywords.
    if (!is_truthy(declared)) continue;
    if (declared.is_string()) {
      const auto name_of_type = declared.get<std::string>();
      if (std::find(kPrimitiveTypes.begin(), kPrimitiveTypes.end(), name_of_type) !=
          kPrimitiveTypes.end()) {
        continue;
      }
    }
    return rejection("elicit jsonSchema property \"" + name + "\" has unsupported type " +
                     declared.dump() +
                     ". MCP elicitation requires primitive-typed leaves (string, number, integer, "
                     "boolean).");
  }
  return std::nullopt;
}

}  // namespace

Json confirmation_schema() {
  return Json{{"type", "object"}, {"properties", Json::object()}, {"required", Json::array()}};
}

Json permissive_schema() {
  Json response = Json::object();
  response["type"] = "string";
  response["description"] = "Your response";

  Json properties = Json::object();
  properties["response"] = std::move(response);

  Json schema = Json::object();
  schema["type"] = "object";
  schema["properties"] = std::move(properties);
  schema["required"] = Json::array({"response"});
  return schema;
}

std::optional<ActionError> validate_elicitation_schema(const Json& schema) {
  if (!schema.is_object()) {
    return rejection("elicit jsonSchema must be a JSON Schema object.");
  }

  const auto type = schema.find("type");
  if (type == schema.end() || !type->is_string() || type->get<std::string>() != "object") {
    return rejection("elicit jsonSchema must be { type: \"object\" } at the top level; got type=" +
                     (type == schema.end() ? std::string("null") : type->dump()) +
                     ". Compose a flat object of primitives.");
  }

  for (const char* keyword : kCompositionKeywords) {
    const auto composition = schema.find(keyword);
    if (composition != schema.end() && is_truthy(*composition)) {
      return rejection(
          "elicit jsonSchema must not use top-level oneOf/anyOf/allOf/not: MCP elicit clients "
          "require a single flat object shape.");
    }
  }

  const auto properties = schema.find("properties");
  if (properties != schema.end() && properties->is_object()) {
    return validate_properties(*properties);
  }
  return std::nullopt;
}

}  // namespace tesseron::detail

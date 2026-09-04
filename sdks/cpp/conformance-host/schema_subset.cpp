#include "schema_subset.hpp"

#include <algorithm>
#include <array>
#include <string_view>

namespace conformance {
namespace {

using tesseron::Json;
using tesseron::ValidationIssue;

constexpr std::array<std::string_view, 10> kSupportedKeywords = {
    "$schema", "additionalProperties", "const",    "default",  "description",
    "enum",    "items",                "properties", "required", "type"};

const char* type_name(const Json& value) {
  if (value.is_null()) return "null";
  if (value.is_boolean()) return "boolean";
  if (value.is_number()) return "number";
  if (value.is_string()) return "string";
  if (value.is_array()) return "array";
  if (value.is_object()) return "object";
  return "unknown";
}

bool matches_type_name(const std::string& name, const Json& value) {
  if (name == "object") return value.is_object();
  if (name == "array") return value.is_array();
  if (name == "string") return value.is_string();
  if (name == "number") return value.is_number();
  if (name == "integer") return value.is_number_integer();
  if (name == "boolean") return value.is_boolean();
  if (name == "null") return value.is_null();
  return true;
}

bool matches_type(const Json& expected, const Json& value) {
  if (expected.is_string()) return matches_type_name(expected.get<std::string>(), value);
  if (expected.is_array()) {
    return std::any_of(expected.begin(), expected.end(),
                       [&value](const Json& name) { return matches_type(name, value); });
  }
  return true;
}

const Json* member(const Json& object, const char* key) {
  const auto found = object.find(key);
  return found == object.end() ? nullptr : &*found;
}

void collect(const Json& schema, const Json& value, std::vector<std::string>& path,
             std::vector<ValidationIssue>& issues) {
  if (!schema.is_object()) return;

  if (const Json* const expected = member(schema, "type")) {
    if (!matches_type(*expected, value)) {
      issues.push_back(
          ValidationIssue{"expected type " + expected->dump() + ", got " + type_name(value), path});
      return;
    }
  }
  if (const Json* const allowed = member(schema, "enum");
      allowed != nullptr && allowed->is_array()) {
    if (std::find(allowed->begin(), allowed->end(), value) == allowed->end()) {
      issues.push_back(ValidationIssue{"expected one of " + allowed->dump(), path});
    }
  }
  if (const Json* const expected = member(schema, "const")) {
    if (*expected != value) issues.push_back(ValidationIssue{"expected " + expected->dump(), path});
  }

  if (value.is_object()) {
    if (const Json* const required = member(schema, "required");
        required != nullptr && required->is_array()) {
      for (const Json& name : *required) {
        if (!name.is_string()) continue;
        const auto& key = name.get_ref<const std::string&>();
        if (value.contains(key)) continue;
        path.push_back(key);
        issues.push_back(ValidationIssue{"required property is missing", path});
        path.pop_back();
      }
    }
    if (const Json* const properties = member(schema, "properties");
        properties != nullptr && properties->is_object()) {
      const Json* const additional = member(schema, "additionalProperties");
      if (additional != nullptr && additional->is_boolean() && !additional->get<bool>()) {
        for (const auto& field : value.items()) {
          if (properties->contains(field.key())) continue;
          path.push_back(field.key());
          issues.push_back(ValidationIssue{"unexpected property", path});
          path.pop_back();
        }
      }
      for (const auto& declared : properties->items()) {
        const auto field = value.find(declared.key());
        if (field == value.end()) continue;
        path.push_back(declared.key());
        collect(declared.value(), *field, path, issues);
        path.pop_back();
      }
    }
  }

  if (const Json* const items = member(schema, "items"); items != nullptr && value.is_array()) {
    for (std::size_t index = 0; index < value.size(); ++index) {
      path.push_back(std::to_string(index));
      collect(*items, value[index], path, issues);
      path.pop_back();
    }
  }
}

}  // namespace

std::optional<std::string> unenforceable_keyword(const Json& schema) {
  if (!schema.is_object()) return "a schema must be a JSON object, got " + schema.dump();
  for (const auto& entry : schema.items()) {
    const bool supported = std::find(kSupportedKeywords.begin(), kSupportedKeywords.end(),
                                     std::string_view(entry.key())) != kSupportedKeywords.end();
    if (!supported) {
      return "this adapter cannot enforce the JSON Schema keyword \"" + entry.key() + "\"";
    }
  }
  if (const Json* const properties = member(schema, "properties");
      properties != nullptr && properties->is_object()) {
    for (const auto& property : properties->items()) {
      if (auto refusal = unenforceable_keyword(property.value())) return refusal;
    }
  }
  if (const Json* const items = member(schema, "items")) {
    if (auto refusal = unenforceable_keyword(*items)) return refusal;
  }
  return std::nullopt;
}

std::vector<ValidationIssue> check(const Json& schema, const Json& value) {
  std::vector<ValidationIssue> issues;
  std::vector<std::string> path;
  collect(schema, value, path, issues);
  return issues;
}

}  // namespace conformance

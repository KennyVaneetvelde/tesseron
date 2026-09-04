#include <tesseron/schema.hpp>

#include <string_view>
#include <utility>

namespace tesseron {
namespace {

/// Counts UTF-8 code points, because `minLength` in JSON Schema counts
/// characters and `std::string::size` counts bytes.
std::size_t character_count(std::string_view text) {
  std::size_t characters = 0;
  for (const char byte : text) {
    if ((static_cast<unsigned char>(byte) & 0xC0U) != 0x80U) characters += 1;
  }
  return characters;
}

std::string_view type_name(const Json& value) {
  if (value.is_null()) return "null";
  if (value.is_boolean()) return "boolean";
  if (value.is_number()) return "number";
  if (value.is_string()) return "string";
  if (value.is_array()) return "array";
  return "object";
}

std::string_view name_of_kind(Schema::Kind kind) {
  switch (kind) {
    case Schema::Kind::String:
      return "string";
    case Schema::Kind::Number:
      return "number";
    case Schema::Kind::Integer:
      return "integer";
    case Schema::Kind::Boolean:
      return "boolean";
    case Schema::Kind::Object:
      return "object";
    case Schema::Kind::Array:
      return "array";
    case Schema::Kind::Any:
      break;
  }
  return "any";
}

bool matches_kind(Schema::Kind kind, const Json& value) {
  switch (kind) {
    case Schema::Kind::Any:
      return true;
    case Schema::Kind::String:
      return value.is_string();
    case Schema::Kind::Number:
      return value.is_number();
    case Schema::Kind::Integer:
      return value.is_number_integer();
    case Schema::Kind::Boolean:
      return value.is_boolean();
    case Schema::Kind::Object:
      return value.is_object();
    case Schema::Kind::Array:
      return value.is_array();
  }
  return true;
}

}  // namespace

/// The only thing allowed to build a `Schema` with a kind already chosen. The
/// public vocabulary is the free functions in `tesseron::schema`, so that an
/// application cannot end up with a schema whose kind and constraints disagree.
class SchemaFactory {
 public:
  static Schema make(Schema::Kind kind) {
    Schema schema;
    schema.kind_ = kind;
    return schema;
  }

  static Schema make_array(Schema items) {
    Schema schema = make(Schema::Kind::Array);
    schema.items_ = std::make_shared<const Schema>(std::move(items));
    return schema;
  }

  static Schema make_object(std::vector<SchemaProperty> properties) {
    Schema schema = make(Schema::Kind::Object);
    schema.properties_.reserve(properties.size());
    for (auto& property : properties) {
      schema.properties_.push_back(Schema::Property{
          std::move(property.name), std::make_shared<const Schema>(std::move(property.schema)),
          property.required});
    }
    return schema;
  }
};

Json ValidationIssue::to_json() const { return Json{{"message", message}, {"path", path}}; }

Json validation_issues_to_json(const std::vector<ValidationIssue>& issues) {
  Json payload = Json::array();
  for (const auto& issue : issues) payload.push_back(issue.to_json());
  return payload;
}

Schema& Schema::description(std::string description) {
  description_ = std::move(description);
  return *this;
}

Schema& Schema::min_length(std::size_t characters) {
  min_length_ = characters;
  return *this;
}

Schema& Schema::max_length(std::size_t characters) {
  max_length_ = characters;
  return *this;
}

Schema& Schema::minimum(double bound) {
  minimum_ = bound;
  return *this;
}

Schema& Schema::maximum(double bound) {
  maximum_ = bound;
  return *this;
}

Schema& Schema::min_items(std::size_t items) {
  min_items_ = items;
  return *this;
}

Schema& Schema::max_items(std::size_t items) {
  max_items_ = items;
  return *this;
}

Schema& Schema::allowed_values(std::vector<Json> values) {
  allowed_values_ = std::move(values);
  return *this;
}

Schema& Schema::default_value(Json value) {
  default_value_ = std::move(value);
  return *this;
}

Json Schema::to_json() const {
  Json document = Json::object();
  if (kind_ != Kind::Any) document["type"] = std::string(name_of_kind(kind_));
  if (description_.has_value()) document["description"] = *description_;
  if (min_length_.has_value()) document["minLength"] = *min_length_;
  if (max_length_.has_value()) document["maxLength"] = *max_length_;
  if (minimum_.has_value()) document["minimum"] = *minimum_;
  if (maximum_.has_value()) document["maximum"] = *maximum_;
  if (min_items_.has_value()) document["minItems"] = *min_items_;
  if (max_items_.has_value()) document["maxItems"] = *max_items_;
  if (default_value_.has_value()) document["default"] = *default_value_;
  if (allowed_values_.has_value()) {
    Json allowed = Json::array();
    for (const auto& value : *allowed_values_) allowed.push_back(value);
    document["enum"] = std::move(allowed);
  }
  if (kind_ == Kind::Object) {
    Json properties = Json::object();
    Json required = Json::array();
    for (const auto& property : properties_) {
      properties[property.name] = property.schema->to_json();
      if (property.required) required.push_back(property.name);
    }
    document["properties"] = std::move(properties);
    if (!required.empty()) document["required"] = std::move(required);
  }
  if (kind_ == Kind::Array && items_) document["items"] = items_->to_json();
  return document;
}

std::vector<ValidationIssue> Schema::validate(const Json& input) const {
  std::vector<ValidationIssue> issues;
  std::vector<std::string> path;
  collect(input, path, issues);
  return issues;
}

void Schema::collect(const Json& input, std::vector<std::string>& path,
                     std::vector<ValidationIssue>& issues) const {
  if (!matches_kind(kind_, input)) {
    issues.push_back(ValidationIssue{
        "expected " + std::string(name_of_kind(kind_)) + ", got " + std::string(type_name(input)),
        path});
    return;
  }

  if (allowed_values_.has_value()) {
    bool allowed = false;
    for (const auto& value : *allowed_values_) {
      if (value == input) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      Json expected = Json::array();
      for (const auto& value : *allowed_values_) expected.push_back(value);
      issues.push_back(ValidationIssue{"expected one of " + expected.dump(), path});
    }
  }

  if (input.is_string()) {
    const auto characters = character_count(input.get<std::string>());
    if (min_length_.has_value() && characters < *min_length_) {
      issues.push_back(
          ValidationIssue{"expected at least " + std::to_string(*min_length_) + " characters",
                          path});
    }
    if (max_length_.has_value() && characters > *max_length_) {
      issues.push_back(ValidationIssue{
          "expected at most " + std::to_string(*max_length_) + " characters", path});
    }
  }

  if (input.is_number()) {
    const auto number = input.get<double>();
    if (minimum_.has_value() && number < *minimum_) {
      issues.push_back(ValidationIssue{"expected at least " + std::to_string(*minimum_), path});
    }
    if (maximum_.has_value() && number > *maximum_) {
      issues.push_back(ValidationIssue{"expected at most " + std::to_string(*maximum_), path});
    }
  }

  if (input.is_object()) {
    for (const auto& property : properties_) {
      const auto found = input.find(property.name);
      if (found == input.end()) {
        if (property.required) {
          path.push_back(property.name);
          issues.push_back(ValidationIssue{"required property is missing", path});
          path.pop_back();
        }
        continue;
      }
      path.push_back(property.name);
      property.schema->collect(*found, path, issues);
      path.pop_back();
    }
  }

  if (input.is_array()) {
    if (min_items_.has_value() && input.size() < *min_items_) {
      issues.push_back(
          ValidationIssue{"expected at least " + std::to_string(*min_items_) + " items", path});
    }
    if (max_items_.has_value() && input.size() > *max_items_) {
      issues.push_back(
          ValidationIssue{"expected at most " + std::to_string(*max_items_) + " items", path});
    }
    if (items_) {
      for (std::size_t index = 0; index < input.size(); index += 1) {
        path.push_back(std::to_string(index));
        items_->collect(input[index], path, issues);
        path.pop_back();
      }
    }
  }
}

namespace schema {

Schema any() { return SchemaFactory::make(Schema::Kind::Any); }
Schema string() { return SchemaFactory::make(Schema::Kind::String); }
Schema number() { return SchemaFactory::make(Schema::Kind::Number); }
Schema integer() { return SchemaFactory::make(Schema::Kind::Integer); }
Schema boolean() { return SchemaFactory::make(Schema::Kind::Boolean); }
Schema array(Schema items) { return SchemaFactory::make_array(std::move(items)); }
Schema object(std::vector<SchemaProperty> properties) {
  return SchemaFactory::make_object(std::move(properties));
}

SchemaProperty required(std::string name, Schema schema) {
  return SchemaProperty{std::move(name), std::move(schema), true};
}

SchemaProperty optional(std::string name, Schema schema) {
  return SchemaProperty{std::move(name), std::move(schema), false};
}

}  // namespace schema

}  // namespace tesseron
